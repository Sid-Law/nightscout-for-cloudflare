import { env } from "cloudflare:workers";
import { SELF, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EntryStore } from "../src/entry-store";
import {
  MemoryNotificationAlarmStore,
  NightscoutNotificationEngine,
} from "../src/notifications";
import {
  decodeEngineIoV4Handshake,
  decodeEngineIoV4PollingPayload,
  encodeEngineIoV4PollingPayload,
  unwrapSocketIoV5Packet,
  wrapSocketIoV5Packet,
  type SocketIoV5Packet,
} from "../src/protocol";
import { migrateRealtimeNotificationStateV13 } from "../src/realtime/session-repository";
import { INFO, URGENT, WARN } from "../src/runtime/levels";

const NOW = 10_000_000;
const LAST_UPDATED = 9_000_000;
const PLUGIN = { name: "example", label: "Example", pluginType: "notification" };

function notification(level: number): Record<string, unknown> {
  return { title: "test", message: "testing", level, plugin: PLUGIN };
}

function snooze(level: number, lengthMills: number): Record<string, unknown> {
  return {
    level,
    title: "exampleSnooze",
    message: "exampleSnooze message",
    lengthMills,
  };
}

function fixture(): {
  emitted: Record<string, unknown>[];
  store: MemoryNotificationAlarmStore;
  engine: NightscoutNotificationEngine;
} {
  const emitted: Record<string, unknown>[] = [];
  const store = new MemoryNotificationAlarmStore();
  const engine = new NightscoutNotificationEngine(
    store,
    (value) => emitted.push(value),
    () => NOW,
  );
  return { emitted, store, engine };
}

describe("locked Nightscout v15.0.7 notifications.test.js", () => {
  it("initAndReInit", () => {
    const { engine } = fixture();
    const warning = notification(WARN);
    engine.initRequests();
    expect(engine.requestNotify(warning)).toBe(true);
    expect(engine.findHighestAlarm()).toBe(warning);
    engine.initRequests();
    expect(engine.findHighestAlarm()).toBeUndefined();
  });

  it("emitAWarning", () => {
    const { emitted, engine } = fixture();
    const warning = notification(WARN);
    engine.requestNotify(warning);
    expect(engine.findHighestAlarm()).toBe(warning);
    engine.process(LAST_UPDATED);
    expect(emitted).toEqual([expect.objectContaining({ level: WARN, group: "default" })]);
  });

  it("emitAnInfo", () => {
    const { emitted, engine } = fixture();
    engine.requestNotify(notification(INFO));
    expect(engine.findHighestAlarm()).toBeUndefined();
    engine.process(LAST_UPDATED);
    expect(emitted).toEqual([expect.objectContaining({ level: INFO, group: "default" })]);
  });

  it("emitAllClear 1 time after alarm is auto acked", () => {
    const { emitted, store, engine } = fixture();
    engine.requestNotify(notification(WARN));
    engine.process(LAST_UPDATED);
    engine.initRequests();
    engine.process(LAST_UPDATED + 1);
    expect(emitted.filter((item) => item.clear)).toEqual([{
      clear: true,
      title: "All Clear",
      message: "Auto ack'd alarm(s)",
      group: "default",
    }]);
    expect(store.alarmState(WARN, "default")).toMatchObject({
      level: WARN,
      silenceTime: 1,
      lastAckAt: NOW,
      lastEmitAt: null,
    });
    engine.initRequests();
    engine.process(LAST_UPDATED + 2);
    expect(emitted.filter((item) => item.clear)).toHaveLength(1);
  });

  it("Can be snoozed", () => {
    const { emitted, engine } = fixture();
    const warning = notification(WARN);
    const requestedSnooze = snooze(WARN, 10_000);
    engine.requestNotify(warning);
    engine.requestSnooze(requestedSnooze);
    expect(engine.snoozedBy(warning)).toBe(requestedSnooze);
    engine.process(LAST_UPDATED);
    expect(emitted).toEqual([expect.objectContaining({ clear: true })]);
    expect(emitted).not.toContainEqual(expect.objectContaining({ level: WARN }));
  });

  it("Can be snoozed by last snooze", () => {
    const { engine } = fixture();
    const warning = notification(WARN);
    const short = snooze(WARN, 1);
    const long = snooze(WARN, 10_000);
    engine.requestNotify(warning);
    engine.requestSnooze(short);
    engine.requestSnooze(long);
    expect(engine.snoozedBy(warning)).toBe(long);
  });

  it("Urgent alarms can't be snoozed by warn", () => {
    const { emitted, engine } = fixture();
    const urgent = notification(URGENT);
    engine.requestNotify(urgent);
    engine.requestSnooze(snooze(WARN, 10_000));
    expect(engine.snoozedBy(urgent)).toBeUndefined();
    engine.process(LAST_UPDATED);
    expect(emitted).toEqual([expect.objectContaining({ level: URGENT })]);
  });

  it("Warnings can be snoozed by urgent", () => {
    const { emitted, engine } = fixture();
    const warning = notification(WARN);
    const urgentSnooze = snooze(URGENT, 10_000);
    engine.requestNotify(warning);
    engine.requestSnooze(urgentSnooze);
    expect(engine.snoozedBy(warning)).toBe(urgentSnooze);
    engine.process(LAST_UPDATED);
    expect(emitted).toEqual([expect.objectContaining({
      clear: true,
      message: "default - Urgent was ack'd",
    })]);
  });
});

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

async function openAlarm(name: string): Promise<{ sid: string; poll: () => Promise<SocketIoV5Packet[]> }> {
  const handshake = await SELF.fetch(endpoint(name));
  const [open] = decodeEngineIoV4PollingPayload(await handshake.text());
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

describe("SQLite Durable Object notification engine adapter", () => {
  it("persists last-emission state across eviction and auto-clears exactly once", async () => {
    const name = tenant("notification-state");
    const stub = store(name);
    const lastUpdated = Date.now();
    const first = JSON.parse(await stub.processAlarmNotificationRequests(JSON.stringify({
      notifications: [notification(WARN)],
      snoozes: [],
    }), lastUpdated)) as Record<string, unknown>;
    expect(first).toMatchObject({ ok: true, acceptedNotifications: 1, delivered: 0 });
    expect(first.emitted).toEqual([expect.objectContaining({ level: WARN })]);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec<{ id: number }>(
        "SELECT id FROM _sql_schema_migrations WHERE id = 13",
      ).one().id).toBe(13);
      expect(state.storage.sql.exec<{ last_emit_at: number }>(
        `SELECT last_emit_at FROM realtime_alarm_silences
         WHERE level = 1 AND alarm_group = 'default'`,
      ).one().last_emit_at).toBe(lastUpdated);
    });
    await evictDurableObject(stub);
    const clear = JSON.parse(await stub.processAlarmNotificationRequests(
      JSON.stringify({ notifications: [], snoozes: [] }),
      lastUpdated + 1,
    )) as Record<string, unknown>;
    expect(clear.emitted).toEqual([{
      clear: true,
      title: "All Clear",
      message: "Auto ack'd alarm(s)",
      group: "default",
    }]);
    const repeated = JSON.parse(await stub.processAlarmNotificationRequests(
      JSON.stringify({ notifications: [], snoozes: [] }),
      lastUpdated + 2,
    )) as Record<string, unknown>;
    expect(repeated.emitted).toEqual([]);
  });

  it("publishes selected requests through the live `/alarm` namespace", async () => {
    const name = tenant("notification-outlet");
    const socket = await openAlarm(name);
    const lastUpdated = Date.now();
    const result = JSON.parse(await store(name).processAlarmNotificationRequests(
      JSON.stringify({ notifications: [notification(URGENT)], snoozes: [] }),
      lastUpdated,
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, delivered: 1 });
    expect(await socket.poll()).toEqual([{
      type: "event",
      namespace: "/alarm",
      data: ["urgent_alarm", expect.objectContaining({ level: URGENT, group: "default" })],
    }]);
  });

  it("repairs a deployed v12 silence row without losing it", async () => {
    const stub = store(tenant("notification-v13-repair"));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(`
        DROP TABLE realtime_alarm_silences;
        CREATE TABLE realtime_alarm_silences (
          level INTEGER NOT NULL,
          alarm_group TEXT NOT NULL,
          last_ack_at INTEGER NOT NULL,
          silence_time INTEGER NOT NULL,
          PRIMARY KEY (level, alarm_group)
        );
        INSERT INTO realtime_alarm_silences
          (level, alarm_group, last_ack_at, silence_time)
        VALUES (1, 'preserved', 1234, 5678);
      `);
      migrateRealtimeNotificationStateV13(state.storage);
      expect(state.storage.sql.exec<{
        last_ack_at: number;
        silence_time: number;
        last_emit_at: number | null;
      }>(
        `SELECT last_ack_at, silence_time, last_emit_at
         FROM realtime_alarm_silences WHERE alarm_group = 'preserved'`,
      ).one()).toEqual({ last_ack_at: 1234, silence_time: 5678, last_emit_at: null });
      expect(() => migrateRealtimeNotificationStateV13(state.storage)).not.toThrow();
    });
  });
});
