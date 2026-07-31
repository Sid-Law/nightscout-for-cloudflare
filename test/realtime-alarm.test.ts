import { env } from "cloudflare:workers";
import {
  evictDurableObject,
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

describe("persistent realtime Durable Object alarm", () => {
  it("does not schedule an alarm for a polling session or pong heartbeat", async () => {
    const stub = store("realtime-polling-no-alarm");
    const sid = await open(stub);
    await post(stub, sid, encodeEngineIoV4PollingPayload([{ type: "pong" }]));

    await runInDurableObject(stub, async (_instance, state) => {
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      expect(repository.requireSession(sid)).toMatchObject({
        outboundPackets: 0,
        pollToken: null,
        postToken: null,
      });
      expect(repository.nextDeadline()).toBeNull();
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("keeps application packets durable across polling-session eviction without an alarm", async () => {
    const stub = store("realtime-polling-durable-packet");
    const sid = await open(stub);
    await post(stub, sid, clientPayload({ type: "connect", namespace: "/" }));

    await runInDurableObject(stub, async (_instance, state) => {
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      expect(repository.requireSession(sid).outboundPackets).toBeGreaterThan(0);
      expect(repository.nextDeadline()).toBeNull();
      expect(await state.storage.getAlarm()).toBeNull();
    });

    await evictDurableObject(stub);
    const polled = await stub.realtimePoll(sid);
    if (!polled.ok) throw new Error(polled.error.message);
    const packets = decodeEngineIoV4PollingPayload(polled.value)
      .map((packet) => unwrapSocketIoV5Packet(packet));
    expect(packets[0]).toMatchObject({ type: "connect", namespace: "/" });
  });

  it("removes an abandoned durable polling row opportunistically", async () => {
    const stub = store("realtime-polling-stale-cleanup");
    const staleSid = await open(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE realtime_sessions SET last_seen_at = ? WHERE sid = ?",
        Date.now() - 10 * 60_000,
        staleSid,
      );
    });

    await evictDurableObject(stub);
    const replacementSid = await open(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      expect(repository.getSession(staleSid)).toBeNull();
      expect(repository.requireSession(replacementSid).transport).toBe("polling");
      expect(repository.nextDeadline()).toBeNull();
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });
});
