import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EntryStore } from "../src/entry-store";
import {
  decodeEngineIoV4Handshake,
  decodeEngineIoV4PollingPayload,
  encodeEngineIoV4PollingPayload,
  wrapSocketIoV5Packet,
  unwrapSocketIoV5Packet,
  type SocketIoV5Packet,
} from "../src/protocol";
import {
  migrateRealtimeSessions,
  SqliteRealtimeSessionRepository,
} from "../src/realtime/session-repository";
import {
  RealtimeSessionError,
  RealtimeSessionService,
  type RealtimeSnapshot,
} from "../src/realtime/session-service";

function store(prefix: string): DurableObjectStub<EntryStore> {
  return env.ENTRY_STORE.getByName(`${prefix}-${crypto.randomUUID()}`);
}

function clientPayload(packet: SocketIoV5Packet): string {
  return encodeEngineIoV4PollingPayload([wrapSocketIoV5Packet(packet)]);
}

function snapshot(now: number): RealtimeSnapshot {
  return {
    lastUpdated: now,
    sgvs: [{ _id: "mock-entry", mgdl: 123, mills: now - 60_000, direction: "Flat" }],
    mbgs: [],
    cals: [],
    treatments: [],
    food: [],
    profiles: [],
    devicestatus: [{ created_at: "2026-07-18T00:00:00.000Z" }],
    dbstats: {},
  };
}

async function post(
  service: RealtimeSessionService,
  sid: string,
  payload: string,
): Promise<void> {
  const token = service.beginPost(sid);
  await service.submitPost(sid, token, payload);
}

describe("tenant Durable Object EIO4 polling state machine", () => {
  it("installs the realtime schema through the EntryStore migration marker", async () => {
    const stub = store("realtime-schema");
    await runInDurableObject(stub, async (_instance, state) => {
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      const session = repository.createSession(900_000);
      expect(repository.requireSession(session.sid).sid).toBe(session.sid);
      expect(
        state.storage.sql
          .exec<{ id: number }>(
            "SELECT id FROM _sql_schema_migrations WHERE id = 5",
          )
          .one().id,
      ).toBe(5);
    });
  });

  it("persists the official open handshake fields and session authority across eviction", async () => {
    const stub = store("realtime-handshake");
    const handshake = await runInDurableObject(stub, async (_instance, state) => {
      migrateRealtimeSessions(state.storage);
      const service = new RealtimeSessionService(state.storage, { now: () => 1_000_000 });
      return service.createHandshake();
    });

    expect(handshake.sid).toMatch(/^[A-Za-z0-9_-]{20}$/);
    expect(handshake.payload).toBe(
      `0{"sid":"${handshake.sid}","upgrades":[],"pingInterval":25000,` +
        `"pingTimeout":20000,"maxPayload":1000000}`,
    );
    const [open] = decodeEngineIoV4PollingPayload(handshake.payload);
    expect(decodeEngineIoV4Handshake(open!)).toEqual({
      sid: handshake.sid,
      upgrades: [],
      pingInterval: 25_000,
      pingTimeout: 20_000,
      maxPayload: 1_000_000,
    });

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      migrateRealtimeSessions(state.storage);
      const persisted = new SqliteRealtimeSessionRepository(state.storage)
        .getSession(handshake.sid);
      expect(persisted).toMatchObject({
        sid: handshake.sid,
        socketConnected: false,
        authorized: false,
        readAllowed: false,
        nextPingAt: 1_025_000,
        expiresAt: 1_045_000,
      });
    });
  });

  it("orders root CONNECT, authorize data, and ACK exactly as locked upstream", async () => {
    const stub = store("realtime-authorize");
    await runInDurableObject(stub, async (_instance, state) => {
      migrateRealtimeSessions(state.storage);
      const service = new RealtimeSessionService(state.storage, {
        now: () => 2_000_000,
        snapshot,
      });
      const { sid } = service.createHandshake();

      await post(service, sid, clientPayload({ type: "connect", namespace: "/" }));
      const connectPackets = decodeEngineIoV4PollingPayload(await service.poll(sid));
      expect(connectPackets).toHaveLength(1);
      expect(unwrapSocketIoV5Packet(connectPackets[0]!)).toMatchObject({
        type: "connect",
        namespace: "/",
        data: { sid: expect.stringMatching(/^[A-Za-z0-9_-]{20}$/) },
      });

      await post(service, sid, clientPayload({
        type: "event",
        namespace: "/",
        id: 7,
        data: ["authorize", { client: "web", history: 48 }],
      }));
      const authorized = decodeEngineIoV4PollingPayload(await service.poll(sid))
        .map((packet) => unwrapSocketIoV5Packet(packet));
      expect(authorized).toEqual([
        { type: "event", namespace: "/", data: ["connected"] },
        {
          type: "event",
          namespace: "/",
          data: ["dataUpdate", snapshot(2_000_000)],
        },
        {
          type: "ack",
          namespace: "/",
          id: 7,
          data: [{ read: true, write: false, write_treatment: false }],
        },
      ]);

      const persisted = new SqliteRealtimeSessionRepository(state.storage).requireSession(sid);
      expect(persisted).toMatchObject({
        socketConnected: true,
        authorized: true,
        readAllowed: true,
        outboundPackets: 0,
      });
    });
  });

  it("ACKs loadRetro before retroUpdate and leaves root subscribe unhandled", async () => {
    const stub = store("realtime-read-events");
    await runInDurableObject(stub, async (_instance, state) => {
      migrateRealtimeSessions(state.storage);
      const service = new RealtimeSessionService(state.storage, {
        now: () => 3_000_000,
        snapshot,
      });
      const { sid } = service.createHandshake();
      await post(service, sid, clientPayload({ type: "connect", namespace: "/" }));
      await service.poll(sid);

      await post(service, sid, clientPayload({
        type: "event",
        namespace: "/",
        id: 8,
        data: ["loadRetro", { loadedMills: 0 }],
      }));
      const retro = decodeEngineIoV4PollingPayload(await service.poll(sid))
        .map((packet) => unwrapSocketIoV5Packet(packet));
      expect(retro).toEqual([
        {
          type: "ack",
          namespace: "/",
          id: 8,
          data: [{ result: "success" }],
        },
        {
          type: "event",
          namespace: "/",
          data: ["retroUpdate", { devicestatus: snapshot(3_000_000).devicestatus }],
        },
      ]);

      await post(service, sid, clientPayload({
        type: "event",
        namespace: "/",
        id: 9,
        data: ["subscribe", { collections: ["entries"] }],
      }));
      const persisted = new SqliteRealtimeSessionRepository(state.storage).requireSession(sid);
      expect(persisted.outboundPackets).toBe(0);
    });
  });

  it("sends the EIO4 server ping, accepts only the client pong, and expires it opportunistically", async () => {
    const stub = store("realtime-heartbeat");
    let now = 4_000_000;
    await runInDurableObject(stub, async (_instance, state) => {
      migrateRealtimeSessions(state.storage);
      const service = new RealtimeSessionService(state.storage, { now: () => now });
      const { sid } = service.createHandshake();

      now += 25_000;
      expect(await service.poll(sid)).toBe("2");
      expect(new SqliteRealtimeSessionRepository(state.storage).requireSession(sid))
        .toMatchObject({ pongDeadline: now + 20_000, expiresAt: now + 20_000 });

      await post(service, sid, encodeEngineIoV4PollingPayload([{ type: "pong" }]));
      expect(new SqliteRealtimeSessionRepository(state.storage).requireSession(sid))
        .toMatchObject({
          pongDeadline: null,
          nextPingAt: now + 25_000,
          expiresAt: now + 45_000,
        });

      now += 45_000;
      expect(() => service.beginPost(sid)).toThrowError(RealtimeSessionError);
      expect(new SqliteRealtimeSessionRepository(state.storage).getSession(sid)).toBeNull();
    });
  });

  it("closes the session on concurrent GET or POST leases", async () => {
    const pollStub = store("realtime-poll-overlap");
    await runInDurableObject(pollStub, async (_instance, state) => {
      migrateRealtimeSessions(state.storage);
      const service = new RealtimeSessionService(state.storage, { pollWaitMs: 100 });
      const { sid } = service.createHandshake();
      const first = service.poll(sid);
      await expect(service.poll(sid)).rejects.toMatchObject({ code: "overlap" });
      await expect(first).rejects.toMatchObject({ code: "unknown_sid" });
      expect(new SqliteRealtimeSessionRepository(state.storage).getSession(sid)).toBeNull();
    });

    const postStub = store("realtime-post-overlap");
    await runInDurableObject(postStub, async (_instance, state) => {
      migrateRealtimeSessions(state.storage);
      const service = new RealtimeSessionService(state.storage);
      const { sid } = service.createHandshake();
      service.beginPost(sid);
      expect(() => service.beginPost(sid)).toThrowError(
        expect.objectContaining({ code: "overlap" }),
      );
      expect(new SqliteRealtimeSessionRepository(state.storage).getSession(sid)).toBeNull();
    });
  });

  it("closes malformed sessions and keeps tenant repositories isolated", async () => {
    const alpha = store("realtime-alpha");
    const beta = store("realtime-beta");
    const sid = await runInDurableObject(alpha, async (_instance, state) => {
      migrateRealtimeSessions(state.storage);
      const service = new RealtimeSessionService(state.storage);
      const created = service.createHandshake();
      const token = service.beginPost(created.sid);
      await expect(service.submitPost(created.sid, token, "4not-socket-io"))
        .rejects.toMatchObject({ code: "bad_packet" });
      expect(new SqliteRealtimeSessionRepository(state.storage).getSession(created.sid)).toBeNull();
      return created.sid;
    });

    await runInDurableObject(beta, async (_instance, state) => {
      migrateRealtimeSessions(state.storage);
      expect(new SqliteRealtimeSessionRepository(state.storage).getSession(sid)).toBeNull();
    });
  });
});
