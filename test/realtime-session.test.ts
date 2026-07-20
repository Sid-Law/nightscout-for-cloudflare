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
  migrateRealtimeWriteAuthorityV12,
  SqliteRealtimeSessionRepository,
} from "../src/realtime/session-repository";
import {
  RealtimeSessionError,
  RealtimeSessionService,
  type RealtimeAuthorization,
  type RealtimeSnapshot,
} from "../src/realtime/session-service";
import {
  buildRealtimeDdataSnapshot,
  buildRealtimeRetroDeviceStatus,
} from "../src/realtime/ddata-snapshot";
import {
  REALTIME_MAX_PAYLOAD_BYTES,
  REALTIME_MAX_QUEUE_PACKETS,
  REALTIME_MAX_SESSIONS_PER_TENANT,
} from "../src/realtime/constants";
import { nightscoutWebsocketStatus } from "../src/status";

function store(prefix: string): DurableObjectStub<EntryStore> {
  return env.ENTRY_STORE.getByName(`${prefix}-${crypto.randomUUID()}`);
}

function clientPayload(packet: SocketIoV5Packet): string {
  return encodeEngineIoV4PollingPayload([wrapSocketIoV5Packet(packet)]);
}

function snapshot(now: number): RealtimeSnapshot {
  return {
    devicestatus: [{ created_at: "2026-07-18T00:00:00.000Z" }],
    sgvs: [{ _id: "mock-entry", mgdl: 123, mills: now - 60_000, direction: "Flat" }],
    cals: [],
    profiles: [],
    mbgs: [],
    food: [],
    treatments: [],
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

async function rpcPost(
  stub: DurableObjectStub<EntryStore>,
  sid: string,
  payload: string,
): Promise<void> {
  const lease = await stub.realtimeBeginPost(sid);
  if (!lease.ok) throw new Error(lease.error.message);
  const submitted = await stub.realtimeSubmitPost(sid, lease.value, payload);
  if (!submitted.ok) throw new Error(submitted.error.message);
}

describe("tenant Durable Object EIO4 polling state machine", () => {
  it("matches dataWithRecentStatuses fields, device windows, and public profiles", () => {
    const now = Date.parse("2026-07-18T00:00:00.000Z");
    const statuses = Array.from({ length: 12 }, (_unused, index) => ({
      _id: `status-${index}`,
      device: "uploader-a",
      created_at: new Date(now - (12 - index) * 60_000).toISOString(),
      uploader: { battery: 80 + index },
    }));
    statuses.push({
      _id: "future",
      device: "uploader-a",
      created_at: new Date(now + 60_000).toISOString(),
      uploader: { battery: 100 },
    });
    const realtime = buildRealtimeDdataSnapshot({
      sgvs: [{ _id: "sgv" }],
      profiles: [{ store: { "Default": {}, "Hidden@@@@@copy": {}, "@@@@@prefix": {} } }],
      food: [{ _id: "food", created_at: "2026-07-17T20:00:00.000Z" }],
      treatments: [{ _id: "treatment", created_at: "2026-07-17T21:00:00.000Z" }],
      devicestatus: statuses,
    }, now);

    expect(Object.keys(realtime)).toEqual([
      "devicestatus",
      "sgvs",
      "cals",
      "profiles",
      "mbgs",
      "food",
      "treatments",
      "dbstats",
    ]);
    expect(realtime).not.toHaveProperty("lastUpdated");
    expect(realtime.devicestatus).toHaveLength(10);
    expect(realtime.devicestatus).not.toContainEqual(expect.objectContaining({ _id: "future" }));
    const profileStore = (realtime.profiles[0] as { store: Record<string, unknown> }).store;
    expect(profileStore).toHaveProperty("Default");
    expect(profileStore).toHaveProperty("@@@@@prefix");
    expect(profileStore).not.toHaveProperty("Hidden@@@@@copy");
  });

  it("exposes a recoverable EntryStore RPC slice across Durable Object eviction", async () => {
    const stub = store("realtime-rpc");
    const opened = await stub.realtimeHandshake();
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.error.message);

    await evictDurableObject(stub);
    const resumed = env.ENTRY_STORE.getByName(stub.name!);
    const lease = await resumed.realtimeBeginPost(opened.value.sid);
    expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error(lease.error.message);
    expect(
      await resumed.realtimeSubmitPost(
        opened.value.sid,
        lease.value,
        clientPayload({ type: "connect", namespace: "/" }),
      ),
    ).toEqual({ ok: true, value: null });
    const polled = await resumed.realtimePoll(opened.value.sid);
    expect(polled.ok).toBe(true);
    if (!polled.ok) throw new Error(polled.error.message);
    expect(unwrapSocketIoV5Packet(decodeEngineIoV4PollingPayload(polled.value)[0]!))
      .toMatchObject({ type: "connect", namespace: "/" });
  });

  it("accepts only tenant-valid explicit realtime credentials and ACKs resolved permissions", async () => {
    const stub = store("realtime-explicit-auth");
    const createdJson = await stub.createDocuments(
      "subjects",
      JSON.stringify([{ name: "viewer", roles: [] }]),
    );
    const [created] = JSON.parse(createdJson) as Array<{ _id: string }>;
    const listedJson = await stub.listAuthorizationSubjects();
    if (listedJson === null) throw new Error("authorization subject limit exceeded");
    const [listed] = JSON.parse(listedJson) as Array<{ accessToken: string }>;
    if (created === undefined || listed === undefined) throw new Error("viewer subject was not created");
    const accessToken = listed.accessToken;
    const issued = JSON.parse(await stub.issueAccessJwt(accessToken)) as { token: string };
    const digest = async (algorithm: "SHA-1" | "SHA-512") => Array.from(
      new Uint8Array(await crypto.subtle.digest(
        algorithm,
        new TextEncoder().encode("nscf-test-secret-20260717"),
      )),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const apiSecretDigest = await digest("SHA-1");
    const apiSecretDigest512 = await digest("SHA-512");
    const cosmeticAlias = `cosmetic-viewer-${accessToken.split("-").at(-1)!}`;

    const credentials: Array<Record<string, unknown>> = [
      { secret: apiSecretDigest.toUpperCase() },
      { secret: apiSecretDigest512 },
      { secret: cosmeticAlias },
      { token: issued.token },
    ];
    for (const [index, credential] of credentials.entries()) {
      const opened = await stub.realtimeHandshake();
      if (!opened.ok) throw new Error(opened.error.message);
      await rpcPost(stub, opened.value.sid, clientPayload({ type: "connect", namespace: "/" }));
      await stub.realtimePoll(opened.value.sid);
      await rpcPost(stub, opened.value.sid, clientPayload({
        type: "event",
        namespace: "/",
        id: 20 + index,
        data: ["authorize", { client: "web", ...credential }],
      }));
      const polled = await stub.realtimePoll(opened.value.sid);
      if (!polled.ok) throw new Error(polled.error.message);
      const packets = decodeEngineIoV4PollingPayload(polled.value)
        .map((packet) => unwrapSocketIoV5Packet(packet));
      const adminCredential = index < 2;
      expect(packets.at(-1)).toEqual({
        type: "ack",
        namespace: "/",
        id: 20 + index,
        data: [{
          read: true,
          write: adminCredential,
          write_treatment: adminCredential,
        }],
      });
    }

    for (const [index, secret] of [
      "invalid-explicit-value",
      apiSecretDigest512.toUpperCase(),
    ].entries()) {
      const invalid = await stub.realtimeHandshake();
      if (!invalid.ok) throw new Error(invalid.error.message);
      await rpcPost(stub, invalid.value.sid, clientPayload({ type: "connect", namespace: "/" }));
      await stub.realtimePoll(invalid.value.sid);
      await rpcPost(stub, invalid.value.sid, clientPayload({
        type: "event",
        namespace: "/",
        id: 30 + index,
        data: ["authorize", { client: "web", secret }],
      }));
      const rejected = await stub.realtimePoll(invalid.value.sid);
      if (!rejected.ok) throw new Error(rejected.error.message);
      expect(
        decodeEngineIoV4PollingPayload(rejected.value)
          .map((packet) => unwrapSocketIoV5Packet(packet)),
      ).toEqual([{ type: "disconnect", namespace: "/" }]);
    }

    await stub.deleteDocuments("subjects", [created._id]);
    const revoked = await stub.realtimeHandshake();
    if (!revoked.ok) throw new Error(revoked.error.message);
    await rpcPost(stub, revoked.value.sid, clientPayload({ type: "connect", namespace: "/" }));
    await stub.realtimePoll(revoked.value.sid);
    await rpcPost(stub, revoked.value.sid, clientPayload({
      type: "event",
      namespace: "/",
      id: 40,
      data: ["authorize", { client: "web", token: issued.token }],
    }));
    const revokedResult = await stub.realtimePoll(revoked.value.sid);
    if (!revokedResult.ok) throw new Error(revokedResult.error.message);
    expect(
      decodeEngineIoV4PollingPayload(revokedResult.value)
        .map((packet) => unwrapSocketIoV5Packet(packet)),
    ).toEqual([{ type: "disconnect", namespace: "/" }]);
  });

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
      expect(
        state.storage.sql
          .exec<{ id: number }>(
            "SELECT id FROM _sql_schema_migrations WHERE id = 13",
          )
          .one().id,
      ).toBe(13);
      const columns = state.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(realtime_sessions)")
        .toArray()
        .map((row) => row.name);
      expect(columns).toEqual(expect.arrayContaining([
        "write_allowed",
        "treatment_write_allowed",
      ]));
      // The repair is idempotent on every Durable Object activation.
      expect(() => migrateRealtimeWriteAuthorityV12(state.storage)).not.toThrow();
    });
  });

  it("repairs a deployed v11 session table without losing live session rows", async () => {
    const stub = store("realtime-v12-repair");
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(`
        DROP TABLE realtime_sessions;
        CREATE TABLE realtime_sessions (
          sid TEXT PRIMARY KEY,
          socket_sid TEXT NOT NULL UNIQUE,
          engine_protocol INTEGER NOT NULL CHECK (engine_protocol = 4),
          transport TEXT NOT NULL CHECK (transport IN ('polling', 'websocket')),
          socket_connected INTEGER NOT NULL DEFAULT 0 CHECK (socket_connected IN (0, 1)),
          authorized INTEGER NOT NULL DEFAULT 0 CHECK (authorized IN (0, 1)),
          read_allowed INTEGER NOT NULL DEFAULT 0 CHECK (read_allowed IN (0, 1)),
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          next_ping_at INTEGER NOT NULL,
          pong_deadline INTEGER,
          expires_at INTEGER NOT NULL,
          next_sequence INTEGER NOT NULL DEFAULT 1,
          outbound_packets INTEGER NOT NULL DEFAULT 0,
          outbound_bytes INTEGER NOT NULL DEFAULT 0,
          poll_token TEXT,
          poll_deadline INTEGER,
          post_token TEXT,
          post_deadline INTEGER
        );
        INSERT INTO realtime_sessions (
          sid, socket_sid, engine_protocol, transport, socket_connected,
          authorized, read_allowed, created_at, last_seen_at, next_ping_at,
          expires_at
        ) VALUES (
          'v11-session', 'v11-socket', 4, 'websocket', 1,
          1, 1, 1000, 1000, 26000, 46000
        );
      `);

      migrateRealtimeWriteAuthorityV12(state.storage);
      const repaired = new SqliteRealtimeSessionRepository(state.storage)
        .requireSession("v11-session");
      expect(repaired).toMatchObject({
        sid: "v11-session",
        socketConnected: true,
        authorized: true,
        readAllowed: true,
        writeAllowed: false,
        treatmentWriteAllowed: false,
      });
      expect(() => migrateRealtimeWriteAuthorityV12(state.storage)).not.toThrow();
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
        writeAllowed: false,
        treatmentWriteAllowed: false,
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
      expect(connectPackets).toHaveLength(2);
      expect(unwrapSocketIoV5Packet(connectPackets[0]!)).toMatchObject({
        type: "connect",
        namespace: "/",
        data: { sid: expect.stringMatching(/^[A-Za-z0-9_-]{20}$/) },
      });
      expect(unwrapSocketIoV5Packet(connectPackets[1]!)).toEqual({
        type: "event",
        namespace: "/",
        data: ["clients", 1],
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
        writeAllowed: false,
        treatmentWriteAllowed: false,
        outboundPackets: 0,
      });
    });
  });

  it("persists root calcdelta state and queues updates only for authorized readers", async () => {
    const stub = store("realtime-root-delta");
    await runInDurableObject(stub, async (_instance, state) => {
      migrateRealtimeSessions(state.storage);
      let now = 2_500_000;
      let current = snapshot(now);
      const service = new RealtimeSessionService(state.storage, {
        now: () => now,
        snapshot: () => current,
      });
      // runInDurableObject has already constructed the real EntryStore, whose
      // empty database seeded its own baseline. Replace that fixture baseline
      // with this test's injected snapshot before exercising the service.
      state.storage.sql.exec("DELETE FROM realtime_root_state");
      service.synchronizeRootDataSnapshot();

      const authorizedSid = service.createHandshake().sid;
      await post(service, authorizedSid, clientPayload({ type: "connect", namespace: "/" }));
      await service.poll(authorizedSid);
      await post(service, authorizedSid, clientPayload({
        type: "event",
        namespace: "/",
        data: ["authorize", { client: "web" }],
      }));
      await service.poll(authorizedSid);

      const connectedOnlySid = service.createHandshake().sid;
      await post(service, connectedOnlySid, clientPayload({ type: "connect", namespace: "/" }));
      await service.poll(connectedOnlySid);
      // The new root connection broadcast a clients count to the authorized
      // receiver; clear it before asserting the application delta queue.
      await service.poll(authorizedSid);

      now += 1_000;
      current = {
        ...current,
        treatments: [{ _id: "live-treatment", mills: now, notes: "created" }],
      };
      state.storage.transactionSync(() => service.recordRootDataUpdateInTransaction());

      const repository = new SqliteRealtimeSessionRepository(state.storage);
      expect(repository.requireSession(authorizedSid).outboundPackets).toBe(1);
      expect(repository.requireSession(connectedOnlySid).outboundPackets).toBe(0);
      const [createdFrame] = decodeEngineIoV4PollingPayload(await service.poll(authorizedSid));
      expect(unwrapSocketIoV5Packet(createdFrame!)).toEqual({
        type: "event",
        namespace: "/",
        data: ["dataUpdate", {
          delta: true,
          lastUpdated: now,
          treatments: [{ _id: "live-treatment", mills: now, notes: "created" }],
        }],
      });

      // A new service instance has no in-memory lastData but must continue from
      // the SQLite baseline written by the previous instance.
      const resumed = new RealtimeSessionService(state.storage, {
        now: () => now,
        snapshot: () => current,
      });
      now += 1_000;
      current = {
        ...current,
        treatments: [{ _id: "live-treatment", mills: now - 1_000, notes: "updated" }],
      };
      state.storage.transactionSync(() => resumed.recordRootDataUpdateInTransaction());
      const [updatedFrame] = decodeEngineIoV4PollingPayload(await resumed.poll(authorizedSid));
      expect(unwrapSocketIoV5Packet(updatedFrame!)).toEqual({
        type: "event",
        namespace: "/",
        data: ["dataUpdate", {
          delta: true,
          lastUpdated: now,
          treatments: [{
            _id: "live-treatment",
            mills: now - 1_000,
            notes: "updated",
            action: "update",
          }],
        }],
      });
    });
  });

  it("ACKs loadRetro before retroUpdate and leaves root subscribe unhandled", async () => {
    const stub = store("realtime-read-events");
    await runInDurableObject(stub, async (_instance, state) => {
      migrateRealtimeSessions(state.storage);
      const now = 3_000_000;
      const statuses: Array<Record<string, unknown>> = Array.from(
        { length: 12 },
        (_unused, index) => ({
        _id: `retro-${index}`,
        device: "uploader-a",
        mills: now - (12 - index) * 1_000,
        uploader: { battery: index },
        }),
      );
      statuses.push({
        _id: "retro-future",
        device: "uploader-a",
        mills: now + 1_000,
        uploader: { battery: 100 },
      });
      statuses.push({
        _id: "retro-pump",
        device: "pump-a",
        mills: now - 500,
        pump: { battery: 50 },
      });
      const initialSnapshot = buildRealtimeDdataSnapshot({
        sgvs: [],
        profiles: [],
        food: [],
        treatments: [],
        devicestatus: statuses,
      }, now);
      const rawDeviceStatus = buildRealtimeRetroDeviceStatus(statuses);
      const service = new RealtimeSessionService(state.storage, {
        now: () => now,
        snapshot: () => initialSnapshot,
        retroDeviceStatus: () => rawDeviceStatus,
      });
      const { sid } = service.createHandshake();
      await post(service, sid, clientPayload({ type: "connect", namespace: "/" }));
      await service.poll(sid);

      await post(service, sid, clientPayload({
        type: "event",
        namespace: "/",
        id: 7,
        data: ["authorize", { client: "web" }],
      }));
      const initial = decodeEngineIoV4PollingPayload(await service.poll(sid))
        .map((packet) => unwrapSocketIoV5Packet(packet));
      const initialStatuses = (
        (initial[1] as unknown as { data: [string, RealtimeSnapshot] }).data[1].devicestatus
      );
      expect(initialStatuses).toHaveLength(11);
      expect(initialStatuses).not.toContainEqual(expect.objectContaining({ _id: "retro-future" }));

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
          data: ["retroUpdate", { devicestatus: rawDeviceStatus }],
        },
      ]);
      expect(rawDeviceStatus).toHaveLength(14);
      expect(rawDeviceStatus).toContainEqual(expect.objectContaining({ _id: "retro-future" }));

      await post(service, sid, clientPayload({
        type: "event",
        namespace: "/",
        id: 9,
        data: ["subscribe", { collections: ["entries"] }],
      }));
      const persisted = new SqliteRealtimeSessionRepository(state.storage).requireSession(sid);
      expect(persisted.outboundPackets).toBe(0);

      await post(service, sid, clientPayload({
        type: "event",
        namespace: "/",
        data: ["loadRetro", { loadedMills: 0 }],
      }));
      const withoutAck = decodeEngineIoV4PollingPayload(await service.poll(sid))
        .map((packet) => unwrapSocketIoV5Packet(packet));
      expect(withoutAck).toEqual([{
        type: "event",
        namespace: "/",
        data: ["retroUpdate", { devicestatus: rawDeviceStatus }],
      }]);
    });
  });

  it("adds status only when requested and skips initial data when the loader is unavailable", async () => {
    const stub = store("realtime-status");
    await runInDurableObject(stub, async (_instance, state) => {
      migrateRealtimeSessions(state.storage);
      const status = nightscoutWebsocketStatus(new Date(3_500_000));
      const reusedSnapshot = snapshot(3_500_000);
      const service = new RealtimeSessionService(state.storage, {
        now: () => 3_500_000,
        snapshot: () => reusedSnapshot,
        status: () => status,
        authorize: () => ({
          read: true,
          write: false,
          write_treatment: false,
          ignored: "must-not-leak",
        } as unknown as RealtimeAuthorization),
      });
      const { sid } = service.createHandshake();
      await post(service, sid, clientPayload({ type: "connect", namespace: "/" }));
      await service.poll(sid);

      await post(service, sid, clientPayload({
        type: "event",
        namespace: "/",
        id: 10,
        data: ["authorize", { client: "web", status: true }],
      }));
      const withStatus = decodeEngineIoV4PollingPayload(await service.poll(sid))
        .map((packet) => unwrapSocketIoV5Packet(packet));
      const data = (withStatus[1] as { data: unknown[] }).data[1] as Record<string, unknown>;
      expect(data.status).toEqual(status);
      expect(Object.keys(data).at(-1)).toBe("status");
      expect(Object.keys(status)).toEqual([
        "status",
        "name",
        "version",
        "versionNum",
        "serverTime",
        "apiEnabled",
        "careportalEnabled",
        "boluscalcEnabled",
        "settings",
        "extendedSettings",
      ]);
      expect(status).not.toHaveProperty("serverTimeEpoch");
      expect(status).not.toHaveProperty("runtimeState");
      expect(withStatus.at(-1)).toEqual({
        type: "ack",
        namespace: "/",
        id: 10,
        data: [{ read: true, write: false, write_treatment: false }],
      });

      await post(service, sid, clientPayload({
        type: "event",
        namespace: "/",
        id: 11,
        data: ["authorize", { client: "web", status: false }],
      }));
      const withoutStatus = decodeEngineIoV4PollingPayload(await service.poll(sid))
        .map((packet) => unwrapSocketIoV5Packet(packet));
      expect((withoutStatus[1] as { data: unknown[] }).data[1]).not.toHaveProperty("status");
      expect(reusedSnapshot).not.toHaveProperty("status");

      const unavailable = new RealtimeSessionService(state.storage, {
        now: () => 3_500_000,
        snapshot: () => null,
      });
      const unavailableSid = unavailable.createHandshake().sid;
      await post(unavailable, unavailableSid, clientPayload({ type: "connect", namespace: "/" }));
      await unavailable.poll(unavailableSid);
      await post(unavailable, unavailableSid, clientPayload({
        type: "event",
        namespace: "/",
        id: 12,
        data: ["authorize", { client: "web", status: true }],
      }));
      const packets = decodeEngineIoV4PollingPayload(await unavailable.poll(unavailableSid))
        .map((packet) => unwrapSocketIoV5Packet(packet));
      expect(packets).toEqual([
        { type: "event", namespace: "/", data: ["connected"] },
        {
          type: "ack",
          namespace: "/",
          id: 12,
          data: [{ read: true, write: false, write_treatment: false }],
        },
      ]);
    });
  });

  it("disconnects only root with no ACK after invalid authorization and issues a new sid on reconnect", async () => {
    const stub = store("realtime-invalid-auth");
    await runInDurableObject(stub, async (_instance, state) => {
      migrateRealtimeSessions(state.storage);
      const service = new RealtimeSessionService(state.storage, { snapshot });
      const { sid } = service.createHandshake();
      await post(service, sid, clientPayload({ type: "connect", namespace: "/" }));
      const firstConnect = decodeEngineIoV4PollingPayload(await service.poll(sid))
        .map((packet) => unwrapSocketIoV5Packet(packet));
      const firstSocketSid = (
        firstConnect[0] as unknown as { data: { sid: string } }
      ).data.sid;

      await post(service, sid, clientPayload({
        type: "event",
        namespace: "/",
        id: 13,
        data: ["authorize", { client: "web", secret: "invalid-explicit-credential" }],
      }));
      expect(
        decodeEngineIoV4PollingPayload(await service.poll(sid))
          .map((packet) => unwrapSocketIoV5Packet(packet)),
      ).toEqual([{ type: "disconnect", namespace: "/" }]);
      expect(new SqliteRealtimeSessionRepository(state.storage).requireSession(sid))
        .toMatchObject({ socketConnected: false, authorized: false });

      await post(service, sid, clientPayload({ type: "connect", namespace: "/" }));
      const reconnected = decodeEngineIoV4PollingPayload(await service.poll(sid))
        .map((packet) => unwrapSocketIoV5Packet(packet));
      const nextSocketSid = (
        reconnected[0] as unknown as { data: { sid: string } }
      ).data.sid;
      expect(nextSocketSid).not.toBe(firstSocketSid);
    });
  });

  it("returns CONNECT_ERROR for an unknown namespace without killing the connected root", async () => {
    const stub = store("realtime-unknown-namespace");
    await runInDurableObject(stub, async (_instance, state) => {
      migrateRealtimeSessions(state.storage);
      const service = new RealtimeSessionService(state.storage);
      const { sid } = service.createHandshake();
      await post(service, sid, clientPayload({ type: "connect", namespace: "/" }));
      await service.poll(sid);
      await post(service, sid, clientPayload({ type: "connect", namespace: "/admin" }));
      expect(
        decodeEngineIoV4PollingPayload(await service.poll(sid))
          .map((packet) => unwrapSocketIoV5Packet(packet)),
      ).toEqual([{
        type: "error",
        namespace: "/admin",
        data: { message: "Invalid namespace" },
      }]);
      expect(new SqliteRealtimeSessionRepository(state.storage).requireSession(sid).socketConnected)
        .toBe(true);
    });
  });

  it("preserves a concurrent due ping while tenant authorization is awaiting", async () => {
    const stub = store("realtime-auth-race");
    await runInDurableObject(stub, async (_instance, state) => {
      migrateRealtimeSessions(state.storage);
      let resolveAuthorization: ((value: RealtimeAuthorization) => void) | undefined;
      const authorization = new Promise<RealtimeAuthorization>((resolve) => {
        resolveAuthorization = resolve;
      });
      const now = 3_750_000;
      const service = new RealtimeSessionService(state.storage, {
        now: () => now,
        authorize: () => authorization,
        snapshot,
      });
      const { sid } = service.createHandshake();
      await post(service, sid, clientPayload({ type: "connect", namespace: "/" }));
      await service.poll(sid);

      const lease = service.beginPost(sid);
      const pendingAuthorization = service.submitPost(sid, lease, clientPayload({
        type: "event",
        namespace: "/",
        id: 14,
        data: ["authorize", { client: "web" }],
      }));
      await Promise.resolve();
      state.storage.sql.exec(
        "UPDATE realtime_sessions SET next_ping_at = ? WHERE sid = ?",
        now,
        sid,
      );
      expect(await service.poll(sid)).toBe("2");
      resolveAuthorization?.({ read: true, write: false, write_treatment: false });
      await pendingAuthorization;

      expect(new SqliteRealtimeSessionRepository(state.storage).requireSession(sid))
        .toMatchObject({ pongDeadline: now + 20_000, expiresAt: now + 20_000 });
      const authorized = decodeEngineIoV4PollingPayload(await service.poll(sid))
        .map((packet) => unwrapSocketIoV5Packet(packet));
      expect(authorized.at(-1)).toEqual({
        type: "ack",
        namespace: "/",
        id: 14,
        data: [{ read: true, write: false, write_treatment: false }],
      });
    });
  });

  it("does not revive a session that expires while authorization is awaiting", async () => {
    const stub = store("realtime-auth-expiry");
    await runInDurableObject(stub, async (_instance, state) => {
      migrateRealtimeSessions(state.storage);
      let now = 3_800_000;
      let resolveAuthorization: ((value: RealtimeAuthorization) => void) | undefined;
      const authorization = new Promise<RealtimeAuthorization>((resolve) => {
        resolveAuthorization = resolve;
      });
      const service = new RealtimeSessionService(state.storage, {
        now: () => now,
        authorize: () => authorization,
        snapshot,
      });
      const { sid } = service.createHandshake();
      await post(service, sid, clientPayload({ type: "connect", namespace: "/" }));
      await service.poll(sid);

      const lease = service.beginPost(sid);
      const pendingAuthorization = service.submitPost(sid, lease, clientPayload({
        type: "event",
        namespace: "/",
        id: 15,
        data: ["authorize", { client: "web" }],
      }));
      await Promise.resolve();
      now += 45_001;
      resolveAuthorization?.({ read: true, write: false, write_treatment: false });

      await expect(pendingAuthorization).rejects.toMatchObject({ code: "unknown_sid" });
      expect(new SqliteRealtimeSessionRepository(state.storage).getSession(sid)).toBeNull();
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

  it("wakes a poll for queued data, then waits only until the original ping deadline", async () => {
    const stub = store("realtime-poll-remaining");
    await runInDurableObject(stub, async (_instance, state) => {
      migrateRealtimeSessions(state.storage);
      const service = new RealtimeSessionService(state.storage, { pollWaitMs: 500 });
      const { sid } = service.createHandshake();
      const pingAt = Date.now() + 150;
      state.storage.sql.exec(
        "UPDATE realtime_sessions SET next_ping_at = ?, expires_at = ? WHERE sid = ?",
        pingAt,
        pingAt + 300,
        sid,
      );

      const firstPoll = service.poll(sid);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      await post(service, sid, clientPayload({ type: "connect", namespace: "/" }));
      const firstPackets = decodeEngineIoV4PollingPayload(await firstPoll)
        .map((packet) => unwrapSocketIoV5Packet(packet));
      expect(firstPackets[0]).toMatchObject({ type: "connect", namespace: "/" });

      // The POST refreshed the general liveness deadline. Put a nearer expiry
      // back so a reopened GET that waits the full 500 ms would lose the SID.
      state.storage.sql.exec(
        "UPDATE realtime_sessions SET expires_at = ? WHERE sid = ?",
        pingAt + 300,
        sid,
      );
      const secondStartedAt = Date.now();
      expect(await service.poll(sid)).toBe("2");
      expect(Date.now() - secondStartedAt).toBeLessThan(350);
      expect(new SqliteRealtimeSessionRepository(state.storage).requireSession(sid))
        .toMatchObject({
          pongDeadline: expect.any(Number),
          pollToken: null,
        });
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

  it("enforces per-tenant session and FIFO polling queue caps", async () => {
    const stub = store("realtime-capacity");
    await runInDurableObject(stub, async (_instance, state) => {
      migrateRealtimeSessions(state.storage);
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      for (let index = 0; index < REALTIME_MAX_SESSIONS_PER_TENANT; index += 1) {
        repository.createSession(5_000_000);
      }
      expect(() => repository.createSession(5_000_000)).toThrowError(
        expect.objectContaining({ code: "capacity" }),
      );
    });

    const queueStub = store("realtime-queue-capacity");
    await runInDurableObject(queueStub, async (_instance, state) => {
      migrateRealtimeSessions(state.storage);
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      const session = repository.createSession(5_100_000);
      const frames = Array.from({ length: REALTIME_MAX_QUEUE_PACKETS }, () => "2");
      repository.enqueueFrames(session.sid, frames, 5_100_001);
      expect(repository.requireSession(session.sid)).toMatchObject({
        outboundPackets: REALTIME_MAX_QUEUE_PACKETS,
        outboundBytes: REALTIME_MAX_QUEUE_PACKETS,
      });
      expect(() => repository.enqueueFrames(session.sid, ["2"], 5_100_002)).toThrowError(
        expect.objectContaining({ code: "queue_overflow" }),
      );
      expect(repository.dequeuePayload(session.sid)).toBe(frames.join("\x1e"));

      const exactLimit = `4${"a".repeat(REALTIME_MAX_PAYLOAD_BYTES - 1)}`;
      repository.enqueueFrames(session.sid, [exactLimit], 5_100_003);
      expect(repository.dequeuePayload(session.sid)).toBe(exactLimit);

      const separatorOverflow = `4${"a".repeat(REALTIME_MAX_PAYLOAD_BYTES - 2)}`;
      expect(() => repository.enqueueFrames(
        session.sid,
        [separatorOverflow, "2"],
        5_100_004,
      )).toThrowError(expect.objectContaining({ code: "queue_overflow" }));
      expect(repository.requireSession(session.sid)).toMatchObject({
        outboundPackets: 0,
        outboundBytes: 0,
      });
    });
  });

  it("rolls back queued-packet deletion if the session delete step fails", async () => {
    const stub = store("realtime-delete-atomic");
    await runInDurableObject(stub, async (_instance, state) => {
      migrateRealtimeSessions(state.storage);
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      const session = repository.createSession(5_000_000);
      repository.enqueueFrames(session.sid, ["2"], 5_000_001);
      state.storage.sql.exec(`
        CREATE TRIGGER realtime_test_delete_failure
        BEFORE DELETE ON realtime_sessions
        BEGIN
          SELECT RAISE(ABORT, 'forced session delete failure');
        END;
      `);
      expect(() => repository.deleteSession(session.sid)).toThrow();
      state.storage.sql.exec("DROP TRIGGER realtime_test_delete_failure");

      expect(repository.requireSession(session.sid)).toMatchObject({
        outboundPackets: 1,
        outboundBytes: 1,
      });
      expect(
        state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM realtime_outbound_packets WHERE sid = ?",
          session.sid,
        ).one().count,
      ).toBe(1);
    });
  });
});
