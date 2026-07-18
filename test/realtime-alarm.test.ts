import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EntryStore } from "../src/entry-store";
import {
  decodeEngineIoV4PollingPayload,
  encodeEngineIoV4PollingPayload,
  unwrapSocketIoV5Packet,
  wrapSocketIoV5Packet,
  type SocketIoV5Packet,
} from "../src/protocol";
import { SqliteRealtimeSessionRepository } from "../src/realtime/session-repository";

function store(prefix: string): DurableObjectStub<EntryStore> {
  return env.ENTRY_STORE.getByName(`${prefix}-${crypto.randomUUID()}`);
}

function clientPayload(packet: SocketIoV5Packet): string {
  return encodeEngineIoV4PollingPayload([wrapSocketIoV5Packet(packet)]);
}

async function open(stub: DurableObjectStub<EntryStore>): Promise<string> {
  const opened = await stub.realtimeHandshake();
  if (!opened.ok) throw new Error(opened.error.message);
  return opened.value.sid;
}

async function post(
  stub: DurableObjectStub<EntryStore>,
  sid: string,
  payload: string,
): Promise<void> {
  const lease = await stub.realtimeBeginPost(sid);
  if (!lease.ok) throw new Error(lease.error.message);
  const submitted = await stub.realtimeSubmitPost(sid, lease.value, payload);
  if (!submitted.ok) throw new Error(submitted.error.message);
}

async function connect(stub: DurableObjectStub<EntryStore>, sid: string): Promise<void> {
  await post(stub, sid, clientPayload({ type: "connect", namespace: "/" }));
  const response = await stub.realtimePoll(sid);
  if (!response.ok) throw new Error(response.error.message);
}

describe("persistent realtime Durable Object alarm", () => {
  it("persists a due ping across eviction and handles repeated alarm delivery idempotently", async () => {
    const stub = store("realtime-alarm-eviction");
    const sid = await open(stub);
    const due = Date.now() - 1;

    await runInDurableObject(stub, async (_instance, state) => {
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      const session = repository.requireSession(sid);
      expect(await state.storage.getAlarm()).toBe(session.nextPingAt);
      state.storage.sql.exec(
        `UPDATE realtime_sessions
         SET next_ping_at = ?, expires_at = ?
         WHERE sid = ?`,
        due,
        due + 20_000,
        sid,
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const firstAlarm = await runInDurableObject(stub, async (_instance, state) => {
      const session = new SqliteRealtimeSessionRepository(state.storage).requireSession(sid);
      return {
        alarm: await state.storage.getAlarm(),
        outboundPackets: session.outboundPackets,
        pongDeadline: session.pongDeadline,
      };
    });
    expect(firstAlarm.outboundPackets).toBe(1);
    expect(firstAlarm.pongDeadline).not.toBeNull();
    expect(firstAlarm.alarm).toBe(firstAlarm.pongDeadline);

    // Alarms are at-least-once. Forcing the newly scheduled timeout to run
    // early must not enqueue a second ping or mutate its stored timeout.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      const session = new SqliteRealtimeSessionRepository(state.storage).requireSession(sid);
      expect(session.outboundPackets).toBe(1);
      expect(session.pongDeadline).toBe(firstAlarm.pongDeadline);
      expect(await state.storage.getAlarm()).toBe(firstAlarm.pongDeadline);
    });

    const polled = await stub.realtimePoll(sid);
    expect(polled).toEqual({ ok: true, value: "2" });
  });

  it("reschedules from pong to the next server ping and clears the alarm on close", async () => {
    const stub = store("realtime-alarm-pong");
    const sid = await open(stub);
    const due = Date.now() - 1;

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE realtime_sessions
         SET next_ping_at = ?, expires_at = ?
         WHERE sid = ?`,
        due,
        due + 20_000,
        sid,
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.realtimePoll(sid)).toEqual({ ok: true, value: "2" });

    const beforePong = Date.now();
    await post(stub, sid, encodeEngineIoV4PollingPayload([{ type: "pong" }]));
    await runInDurableObject(stub, async (_instance, state) => {
      const session = new SqliteRealtimeSessionRepository(state.storage).requireSession(sid);
      expect(session.pongDeadline).toBeNull();
      expect(session.nextPingAt).toBeGreaterThanOrEqual(beforePong + 25_000);
      expect(await state.storage.getAlarm()).toBe(session.nextPingAt);
    });

    await post(stub, sid, encodeEngineIoV4PollingPayload([{ type: "close" }]));
    await runInDurableObject(stub, async (_instance, state) => {
      expect(new SqliteRealtimeSessionRepository(state.storage).getSession(sid)).toBeNull();
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it("removes a pong timeout, broadcasts the surviving client count, and leaves no final alarm", async () => {
    const stub = store("realtime-alarm-timeout");
    const firstSid = await open(stub);
    const secondSid = await open(stub);
    await connect(stub, firstSid);
    await connect(stub, secondSid);

    // The second connection broadcasts its count to the first. Drain it so the
    // timeout alarm's count update is the only remaining packet there.
    const initialCount = await stub.realtimePoll(firstSid);
    if (!initialCount.ok) throw new Error(initialCount.error.message);

    const due = Date.now() - 1;
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE realtime_sessions
         SET pong_deadline = ?, expires_at = ?
         WHERE sid = ?`,
        due,
        due,
        secondSid,
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, async (_instance, state) => {
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      expect(repository.getSession(secondSid)).toBeNull();
      expect(repository.requireSession(firstSid).socketConnected).toBe(true);
    });
    const survivorPoll = await stub.realtimePoll(firstSid);
    if (!survivorPoll.ok) throw new Error(survivorPoll.error.message);
    const survivorPackets = decodeEngineIoV4PollingPayload(survivorPoll.value)
      .map((packet) => unwrapSocketIoV5Packet(packet));
    expect(survivorPackets).toContainEqual({
      type: "event",
      namespace: "/",
      data: ["clients", 1],
    });

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE realtime_sessions
         SET pong_deadline = ?, expires_at = ?
         WHERE sid = ?`,
        due,
        due,
        firstSid,
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      expect(repository.getSession(firstSid)).toBeNull();
      expect(repository.nextDeadline()).toBeNull();
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });
});
