import { env } from "cloudflare:workers";
import { runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  migrateBackgroundTasksV14,
  PLUGIN_NOTIFICATIONS_TASK,
  type BackgroundTaskRow,
} from "../src/background-tasks";
import type { EntryStore } from "../src/entry-store";
import { parseEntryPayload } from "../src/model";
import {
  decodeEngineIoV4Handshake,
  decodeEngineIoV4PollingPayload,
  encodeEngineIoV4PollingPayload,
  unwrapSocketIoV5Packet,
  wrapSocketIoV5Packet,
  type SocketIoV5Packet,
} from "../src/protocol";
import type { NightscoutStatusEnvironment } from "../src/status";
import { URGENT } from "../src/runtime/levels";

interface MutableEntryStoreSurface {
  env: NightscoutStatusEnvironment;
  processPluginNotificationTask: (task: BackgroundTaskRow, now: number) => void;
}

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function store(name: string): DurableObjectStub<EntryStore> {
  return env.ENTRY_STORE.getByName(name);
}

function endpoint(name: string, sid?: string): string {
  const suffix = sid === undefined ? "" : `&sid=${encodeURIComponent(sid)}`;
  return `https://example.test/socket.io/?EIO=4&transport=polling&tenant=${name}${suffix}`;
}

function packets(payload: string): SocketIoV5Packet[] {
  return decodeEngineIoV4PollingPayload(payload)
    .filter((packet) => packet.type === "message")
    .map((packet) => unwrapSocketIoV5Packet(packet));
}

async function openAlarm(name: string): Promise<{
  sid: string;
  poll: () => Promise<SocketIoV5Packet[]>;
}> {
  const response = await SELF.fetch(endpoint(name));
  const [open] = decodeEngineIoV4PollingPayload(await response.text());
  const sid = decodeEngineIoV4Handshake(open!).sid;
  const connected = await SELF.fetch(endpoint(name, sid), {
    method: "POST",
    body: encodeEngineIoV4PollingPayload([
      wrapSocketIoV5Packet({ type: "connect", namespace: "/alarm" }),
    ]),
  });
  expect(connected.status).toBe(200);
  const poll = async (): Promise<SocketIoV5Packet[]> =>
    packets(await (await SELF.fetch(endpoint(name, sid))).text());
  expect(await poll()).toEqual([expect.objectContaining({
    type: "connect",
    namespace: "/alarm",
  })]);
  return { sid, poll };
}

function enableSimpleAlarms(instance: EntryStore): void {
  Object.assign((instance as unknown as MutableEntryStoreSurface).env, {
    BG_HIGH: "200",
    BG_TARGET_TOP: "180",
    BG_TARGET_BOTTOM: "80",
    BG_LOW: "55",
    HEARTBEAT: "60",
  });
}

describe("SQLite Durable Object background notification scheduler", () => {
  it("automatically emits, multiplexes, avoids early replay, and auto-clears Simple Alarms", async () => {
    const name = tenant("background-simple-alarm");
    const stub = store(name);
    const socket = await openAlarm(name);
    const highAt = Date.now() - 1_000;

    const first = await runInDurableObject(stub, async (instance, state) => {
      enableSimpleAlarms(instance);
      await instance.putEntries(parseEntryPayload([{
        sgv: 250,
        date: highAt,
        dateString: new Date(highAt).toISOString(),
        direction: "Flat",
        device: "simulator://scheduler",
        type: "sgv",
      }]));
      const taskBefore = state.storage.sql.exec<BackgroundTaskRow>(
        "SELECT kind, due_at, attempt_count, updated_at FROM background_tasks",
      ).one();
      const emitted = state.storage.sql.exec<{ last_emit_at: number | null }>(
        `SELECT last_emit_at FROM realtime_alarm_silences
         WHERE level = 2 AND alarm_group = 'default'`,
      ).one().last_emit_at;
      const realtimeDeadline = state.storage.sql.exec<{ next_ping_at: number }>(
        "SELECT next_ping_at FROM realtime_sessions WHERE sid = ?",
        socket.sid,
      ).one().next_ping_at;
      expect(await state.storage.getAlarm()).toBe(
        Math.min(taskBefore.due_at, realtimeDeadline),
      );
      return { task: taskBefore, emitted };
    });

    expect(first.task).toMatchObject({
      kind: PLUGIN_NOTIFICATIONS_TASK,
      attempt_count: 0,
    });
    expect(first.task.due_at).toBeGreaterThan(Date.now());
    expect(first.emitted).not.toBeNull();
    expect(await socket.poll()).toEqual([{
      type: "event",
      namespace: "/alarm",
      data: ["urgent_alarm", expect.objectContaining({
        level: URGENT,
        title: "Urgent HIGH",
        eventName: "high",
        group: "default",
      })],
    }]);

    await runInDurableObject(stub, async (instance, state) => {
      enableSimpleAlarms(instance);
      const before = state.storage.sql.exec<BackgroundTaskRow>(
        "SELECT kind, due_at, attempt_count, updated_at FROM background_tasks",
      ).one();
      const emitBefore = state.storage.sql.exec<{ last_emit_at: number | null }>(
        `SELECT last_emit_at FROM realtime_alarm_silences
         WHERE level = 2 AND alarm_group = 'default'`,
      ).one().last_emit_at;
      await instance.alarm();
      expect(state.storage.sql.exec<BackgroundTaskRow>(
        "SELECT kind, due_at, attempt_count, updated_at FROM background_tasks",
      ).one()).toEqual(before);
      expect(state.storage.sql.exec<{ last_emit_at: number | null }>(
        `SELECT last_emit_at FROM realtime_alarm_silences
         WHERE level = 2 AND alarm_group = 'default'`,
      ).one().last_emit_at).toBe(emitBefore);

      const normalAt = Date.now();
      await instance.putEntries(parseEntryPayload([{
        sgv: 120,
        date: normalAt,
        dateString: new Date(normalAt).toISOString(),
        direction: "Flat",
        device: "simulator://scheduler",
        type: "sgv",
      }]));
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM background_tasks",
      ).one().count).toBe(0);
      expect(state.storage.sql.exec<{ last_emit_at: number | null }>(
        `SELECT last_emit_at FROM realtime_alarm_silences
         WHERE level = 2 AND alarm_group = 'default'`,
      ).one().last_emit_at).toBeNull();
    });
    expect(await socket.poll()).toEqual([{
      type: "event",
      namespace: "/alarm",
      data: ["clear_alarm", {
        clear: true,
        title: "All Clear",
        message: "Auto ack'd alarm(s)",
        group: "default",
      }],
    }]);
  });

  it("repairs a partial v14 table without losing its scheduled work", async () => {
    const stub = store(tenant("background-v14-repair"));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(`
        DROP TABLE background_tasks;
        CREATE TABLE background_tasks (
          kind TEXT PRIMARY KEY,
          due_at INTEGER NOT NULL
        );
        INSERT INTO background_tasks (kind, due_at)
        VALUES ('plugin-notifications', 1234);
      `);
      migrateBackgroundTasksV14(state.storage);
      expect(state.storage.sql.exec<BackgroundTaskRow>(
        "SELECT kind, due_at, attempt_count, updated_at FROM background_tasks",
      ).one()).toEqual({
        kind: PLUGIN_NOTIFICATIONS_TASK,
        due_at: 1234,
        attempt_count: 0,
        updated_at: 0,
      });
      expect(() => migrateBackgroundTasksV14(state.storage)).not.toThrow();
      expect(state.storage.sql.exec<{ id: number }>(
        "SELECT id FROM _sql_schema_migrations WHERE id = 14",
      ).one().id).toBe(14);
    });
  });

  it("persists exponential retry and does not retry a future task early", async () => {
    const stub = store(tenant("background-task-retry"));
    await runInDurableObject(stub, async (instance, state) => {
      enableSimpleAlarms(instance);
      const mutable = instance as unknown as MutableEntryStoreSurface;
      const original = mutable.processPluginNotificationTask.bind(instance);
      state.storage.sql.exec(
        `INSERT INTO background_tasks (kind, due_at, attempt_count, updated_at)
         VALUES (?, ?, 0, ?)`,
        PLUGIN_NOTIFICATIONS_TASK,
        Date.now() - 1,
        Date.now(),
      );
      mutable.processPluginNotificationTask = (): void => {
        throw new Error("forced scheduler failure");
      };
      const failedAt = Date.now();
      await instance.alarm();
      const failed = state.storage.sql.exec<BackgroundTaskRow>(
        "SELECT kind, due_at, attempt_count, updated_at FROM background_tasks",
      ).one();
      expect(failed.attempt_count).toBe(1);
      expect(failed.due_at).toBeGreaterThanOrEqual(failedAt + 2_000);
      expect(await state.storage.getAlarm()).toBe(failed.due_at);

      await instance.alarm();
      expect(state.storage.sql.exec<BackgroundTaskRow>(
        "SELECT kind, due_at, attempt_count, updated_at FROM background_tasks",
      ).one()).toEqual(failed);

      mutable.processPluginNotificationTask = original;
      state.storage.sql.exec(
        "UPDATE background_tasks SET due_at = ? WHERE kind = ?",
        Date.now() - 1,
        PLUGIN_NOTIFICATIONS_TASK,
      );
      await state.storage.setAlarm(Date.now() - 1);
      await instance.alarm();
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM background_tasks",
      ).one().count).toBe(0);
    });
  });
});
