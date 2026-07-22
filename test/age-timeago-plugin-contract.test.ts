import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import {
  calculateCannulaAgeProperty,
  calculateAgeNotificationEvaluation,
  calculateInsulinAgeProperty,
  calculateSensorAgeProperty,
  cannulaAgeNotification,
  cannulaAgeVisualization,
  insulinAgeNotification,
  insulinAgeVisualization,
  sensorAgeNotification,
  sensorAgeVisualization,
} from "../src/plugins/age";
import {
  calculateTimeAgoDisplay,
  calculateTimeAgoStatus,
  timeAgoNotification,
} from "../src/plugins/timeago";
import {
  calculatePluginProperties,
  loadPluginPropertyContext,
} from "../src/plugins/properties";
import { URGENT, WARN } from "../src/runtime/levels";
import { nightscoutTimes } from "../src/runtime/times";
import { nightscoutStatus, tenantStatusSettings } from "../src/status";

const now = Date.parse("2026-07-20T12:00:00.000Z");
const hours = (value: number): number => now - nightscoutTimes.hours(value).msecs;
const days = (value: number): number => now - nightscoutTimes.days(value).msecs;

describe("locked Nightscout cannulaage.test.js", () => {
  it("sets the pill to the latest current cannula age and notes", () => {
    const property = calculateCannulaAgeProperty([
      { eventType: "Site Change", notes: "Foo", mills: hours(48) },
      { eventType: "Site Change", notes: "Bar", mills: hours(24) },
    ], now);
    const pill = cannulaAgeVisualization(property);
    expect(pill.value).toBe("24h");
    expect(pill.info[1]?.value).toBe("Bar");
  });

  it("rounds 59 minutes to zero hours and omits empty notes", () => {
    const property = calculateCannulaAgeProperty([
      { eventType: "Site Change", notes: "Foo", mills: hours(48) },
      { eventType: "Site Change", notes: "", mills: now - 59 * 60_000 },
    ], now);
    const pill = cannulaAgeVisualization(property);
    expect(pill.value).toBe("0h");
    expect(pill.info).toHaveLength(1);
  });

  it("requests the locked warning at exactly 48 hours", () => {
    const request = cannulaAgeNotification(calculateCannulaAgeProperty([
      { eventType: "Site Change", mills: hours(48) },
    ], now, { enableAlerts: "TRUE" }));
    expect(request).toMatchObject({
      level: WARN,
      title: "Cannula age 48 hours",
      group: "CAGE",
      plugin: { name: "cage" },
    });
  });
});

describe("locked Nightscout insulinage.test.js", () => {
  it("sets the pill to the latest current reservoir age and notes", () => {
    const property = calculateInsulinAgeProperty([
      { eventType: "Insulin Change", notes: "Foo", mills: hours(48) },
      { eventType: "Insulin Change", notes: "Bar", mills: hours(24) },
    ], now);
    const pill = insulinAgeVisualization(property);
    expect(pill.value).toBe("1d0h");
    expect(pill.info[1]?.value).toBe("Bar");
  });

  it("rounds 59 minutes to zero hours and omits empty notes", () => {
    const property = calculateInsulinAgeProperty([
      { eventType: "Insulin Change", notes: "Foo", mills: hours(48) },
      { eventType: "Insulin Change", notes: "", mills: now - 59 * 60_000 },
    ], now);
    const pill = insulinAgeVisualization(property);
    expect(pill.value).toBe("0h");
    expect(pill.info).toHaveLength(1);
  });

  it("requests the locked warning at exactly 48 hours", () => {
    const request = insulinAgeNotification(calculateInsulinAgeProperty([
      { eventType: "Insulin Change", mills: hours(48) },
    ], now, { enableAlerts: "TRUE" }));
    expect(request).toMatchObject({
      level: WARN,
      title: "Insulin reservoir age 48 hours",
      group: "IAGE",
      plugin: { name: "iage" },
    });
  });
});

describe("locked Nightscout sensorage.test.js", () => {
  it("shows both insertion and later start details", () => {
    const property = calculateSensorAgeProperty([
      { eventType: "Sensor Change", notes: "Foo", mills: days(2) },
      { eventType: "Sensor Start", notes: "Bar", mills: days(1) },
    ], now);
    const pill = sensorAgeVisualization(property);
    expect(pill.value).toBe("1d0h");
    expect(pill.info[0]?.label).toBe("Sensor Insert");
    expect(pill.info[1]).toMatchObject({ label: "Duration", value: "2 days 0 hours" });
    expect(pill.info[2]).toMatchObject({ label: "Notes", value: "Foo" });
    expect(pill.info[3]?.label).toBe("Sensor Start");
    expect(pill.info[4]).toMatchObject({ label: "Duration", value: "1 days 0 hours" });
    expect(pill.info[5]).toMatchObject({ label: "Notes", value: "Bar" });
  });

  it("uses a Sensor Start when there is no insertion event", () => {
    const pill = sensorAgeVisualization(calculateSensorAgeProperty([
      { eventType: "Sensor Start", notes: "Bar", mills: days(3) },
    ], now));
    expect(pill.value).toBe("3d0h");
    expect(pill.info).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Sensor Start" }),
      { label: "Duration", value: "3 days 0 hours" },
      { label: "Notes", value: "Bar" },
    ]));
  });

  it("uses an insertion when there is no Sensor Start", () => {
    const pill = sensorAgeVisualization(calculateSensorAgeProperty([
      { eventType: "Sensor Change", notes: "Foo", mills: days(3) },
    ], now));
    expect(pill.value).toBe("3d0h");
    expect(pill.info).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Sensor Insert" }),
      { label: "Duration", value: "3 days 0 hours" },
      { label: "Notes", value: "Foo" },
    ]));
  });

  it("drops an older start after a newer insertion", () => {
    const pill = sensorAgeVisualization(calculateSensorAgeProperty([
      { eventType: "Sensor Start", notes: "Bar", mills: days(10) },
      { eventType: "Sensor Change", notes: "Foo", mills: days(3) },
    ], now));
    expect(pill.value).toBe("3d0h");
    expect(pill.info).toHaveLength(3);
    expect(pill.info[0]?.label).toBe("Sensor Insert");
  });

  it("requests the urgent alarm at exactly six days and 22 hours", () => {
    const request = sensorAgeNotification(calculateSensorAgeProperty([
      { eventType: "Sensor Start", mills: now - nightscoutTimes.days(6).msecs -
          nightscoutTimes.hours(22).msecs },
    ], now, { enableAlerts: true }));
    expect(request).toMatchObject({
      level: URGENT,
      title: "Sensor age 6 days 22 hours",
      group: "SAGE",
      plugin: { name: "sage" },
    });
  });

  it("does not repeat the alarm one hour after the exact threshold", () => {
    const request = sensorAgeNotification(calculateSensorAgeProperty([
      { eventType: "Sensor Start", mills: now - nightscoutTimes.days(6).msecs -
          nightscoutTimes.hours(23).msecs },
    ], now, { enableAlerts: true }));
    expect(request).toBeNull();
  });
});

describe("Durable Object age-notification deadlines", () => {
  it("preserves server order and the exact threshold/21-minute window", () => {
    const changedAt = now - nightscoutTimes.hour().msecs;
    const evaluation = calculateAgeNotificationEvaluation([
      { eventType: "Site Change", mills: changedAt },
      { eventType: "Sensor Start", mills: changedAt },
      { eventType: "Insulin Change", mills: changedAt },
    ], now, 60_000, {
      cage: { info: 1, warn: 1, urgent: 1, enableAlerts: true },
      sage: { info: 1, warn: 1, urgent: 1, enableAlerts: true },
      iage: { info: 1, warn: 1, urgent: 1, enableAlerts: true },
    });

    expect(evaluation.notifications.map((request) => request.group)).toEqual([
      "CAGE",
      "SAGE",
      "IAGE",
    ]);
    expect(evaluation.notifications.map((request) => request.level)).toEqual([
      URGENT,
      URGENT,
      WARN,
    ]);
    expect(evaluation.nextDueAt).toBe(now + 60_000);
  });

  it("schedules the next whole-hour threshold without periodic polling", () => {
    const changedAt = now - 30 * 60_000;
    expect(calculateAgeNotificationEvaluation([
      { eventType: "Site Change", mills: changedAt },
    ], now, 60_000, {
      cage: { info: 1, warn: 2, urgent: 3, enableAlerts: true },
    })).toEqual({
      notifications: [],
      nextDueAt: changedAt + nightscoutTimes.hour().msecs,
    });
  });

  it("wakes at minute 21 so the persisted alarm can clear", () => {
    const changedAt = now - nightscoutTimes.hour().msecs - 20 * 60_000;
    const evaluation = calculateAgeNotificationEvaluation([
      { eventType: "Site Change", mills: changedAt },
    ], now, 30 * 60_000, {
      cage: { info: 1, warn: 1, urgent: 1, enableAlerts: true },
    });
    expect(evaluation.notifications).toHaveLength(1);
    expect(evaluation.nextDueAt).toBe(changedAt + nightscoutTimes.hour().msecs + 21 * 60_000);
  });
});

describe("locked Nightscout timeago.test.js", () => {
  const settings = {
    units: "mg/dl",
    alarmTimeagoWarn: true,
    alarmTimeagoWarnMins: 15,
    alarmTimeagoUrgent: true,
    alarmTimeagoUrgentMins: 30,
  };

  it("does not notify for current data", () => {
    expect(timeAgoNotification(
      [{ mills: now, mgdl: 100, type: "sgv" }],
      now,
      settings,
      { enableAlerts: true },
    )).toBeNull();
  });

  it("does not notify for future data", () => {
    expect(timeAgoNotification(
      [{ mills: now + nightscoutTimes.mins(15).msecs, mgdl: 100, type: "sgv" }],
      now,
      settings,
      { enableAlerts: true },
    )).toBeNull();
  });

  it("requests the exact 16-minute warning", () => {
    expect(timeAgoNotification(
      [{ mills: now - nightscoutTimes.mins(16).msecs, mgdl: 100, type: "sgv" }],
      now,
      settings,
      { enableAlerts: true },
    )).toMatchObject({
      level: WARN,
      message: "Last received: 16 mins ago\nBG Now: 100 mg/dl",
      group: "Time Ago",
    });
  });

  it("requests the exact 31-minute urgent alarm", () => {
    expect(timeAgoNotification(
      [{ mills: now - nightscoutTimes.mins(31).msecs, mgdl: 100, type: "sgv" }],
      now,
      settings,
      { enableAlerts: true },
    )).toMatchObject({
      level: URGENT,
      message: "Last received: 31 mins ago\nBG Now: 100 mg/dl",
      group: "Time Ago",
    });
  });

  it("matches every asserted time-ago display boundary", () => {
    expect(calculateTimeAgoDisplay({ mills: now + nightscoutTimes.mins(15).msecs }, now))
      .toEqual({ label: "in the future", shortLabel: "future" });
    expect(calculateTimeAgoDisplay({ mills: now + nightscoutTimes.mins(4).msecs }, now))
      .toEqual({ value: 1, label: "min ago", shortLabel: "m" });
    expect(calculateTimeAgoDisplay(null, now))
      .toEqual({ label: "time ago", shortLabel: "ago" });
    expect(calculateTimeAgoDisplay({ mills: now }, now))
      .toEqual({ value: 1, label: "min ago", shortLabel: "m" });
    expect(calculateTimeAgoDisplay({ mills: now - 1 }, now))
      .toEqual({ value: 1, label: "min ago", shortLabel: "m" });
    expect(calculateTimeAgoDisplay({ mills: now - nightscoutTimes.secs(30).msecs }, now))
      .toEqual({ value: 1, label: "min ago", shortLabel: "m" });
    expect(calculateTimeAgoDisplay({ mills: now - nightscoutTimes.mins(30).msecs }, now))
      .toEqual({ value: 30, label: "mins ago", shortLabel: "m" });
    expect(calculateTimeAgoDisplay({ mills: now - nightscoutTimes.hours(5).msecs }, now))
      .toEqual({ value: 5, label: "hours ago", shortLabel: "h" });
    expect(calculateTimeAgoDisplay({ mills: now - nightscoutTimes.days(5).msecs }, now))
      .toEqual({ value: 5, label: "days ago", shortLabel: "d" });
    expect(calculateTimeAgoDisplay({ mills: now - nightscoutTimes.days(10).msecs }, now))
      .toEqual({ label: "long ago", shortLabel: "ago" });
    expect(calculateTimeAgoStatus([], now, settings)).toBe("current");
  });
});

describe("Workers age-plugin platform adapter", () => {
  it("normalizes official settings only for enabled plugins", () => {
    const configured = tenantStatusSettings({
      ENABLE: "cage sage iage",
      TIMEAGO_ENABLE_ALERTS: "true",
      ALARM_TIMEAGO_WARN: "off",
      ALARM_TIMEAGO_WARN_MINS: "20",
      ALARM_TIMEAGO_URGENT: "on",
      ALARM_TIMEAGO_URGENT_MINS: "40",
      CAGE_INFO: "40",
      CAGE_WARN: "48",
      CAGE_URGENT: "72",
      CAGE_DISPLAY: "days",
      CAGE_ENABLE_ALERTS: "true",
      SAGE_INFO: "144",
      SAGE_WARN: "164",
      SAGE_URGENT: "166",
      SAGE_ENABLE_ALERTS: "on",
      IAGE_INFO: "44",
      IAGE_WARN: "48",
      IAGE_URGENT: "72",
      IAGE_ENABLE_ALERTS: "false",
    });
    expect(configured.extendedSettings).toMatchObject({
      timeago: { enableAlerts: true },
      cage: { info: 40, warn: 48, urgent: 72, display: "days", enableAlerts: true },
      sage: { info: 144, warn: 164, urgent: 166, enableAlerts: true },
      iage: { info: 44, warn: 48, urgent: 72, enableAlerts: false },
    });
    const settings = (nightscoutStatus(new Date(now), "readable", configured).settings ?? {}) as
      Record<string, unknown>;
    expect(settings).toMatchObject({
      alarmTimeagoWarn: false,
      alarmTimeagoWarnMins: "20",
      alarmTimeagoUrgent: true,
      alarmTimeagoUrgentMins: "40",
    });

    expect(tenantStatusSettings({ CAGE_WARN: "48" }).extendedSettings)
      .not.toHaveProperty("cage");
  });

  it("loads one bounded latest event per type and serves enabled v2 properties", async () => {
    const tenant = `age-property-${crypto.randomUUID()}`;
    const stub = env.ENTRY_STORE.getByName(tenant);
    const liveNow = Date.now();
    await stub.createDocuments("treatments", JSON.stringify([
      { eventType: "Site Change", notes: "old", created_at: new Date(liveNow - nightscoutTimes.days(70).msecs).toISOString() },
      { eventType: "Site Change", notes: "site", created_at: new Date(liveNow - nightscoutTimes.hours(24).msecs).toISOString() },
      { eventType: "Insulin Change", notes: "reservoir", created_at: new Date(liveNow - nightscoutTimes.hours(48).msecs).toISOString() },
      { eventType: "Sensor Change", notes: "insert", created_at: new Date(liveNow - nightscoutTimes.days(2).msecs).toISOString() },
      { eventType: "Sensor Start", notes: "start", created_at: new Date(liveNow - nightscoutTimes.days(1).msecs).toISOString() },
    ]));

    const context = await loadPluginPropertyContext(stub, liveNow);
    expect(context.treatments).toHaveLength(4);
    expect(context.treatments).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ notes: "old" }),
    ]));
    const properties = calculatePluginProperties(
      context,
      "mg/dl",
      liveNow,
      new Set(["cage", "sage", "iage"]),
      { cage: { display: "days" } },
    );
    expect(properties).toMatchObject({
      cage: { display: "1d0h", notes: "site" },
      iage: { display: "2d0h", notes: "reservoir", level: WARN },
      sage: { min: "Sensor Start", "Sensor Start": { display: "1d0h", notes: "start" } },
    });

    const status = nightscoutStatus(
      new Date(now),
      "readable",
      tenantStatusSettings({ ENABLE: "cage sage iage", CAGE_DISPLAY: "days" }),
    );
    const fakeStub = {
      authorizationDelay: (...args: Parameters<typeof stub.authorizationDelay>) =>
        stub.authorizationDelay(...args),
      listDocuments: (...args: Parameters<typeof stub.listDocuments>) =>
        stub.listDocuments(...args),
      getPluginPropertyContextJson: (...args: Parameters<typeof stub.getPluginPropertyContextJson>) =>
        stub.getPluginPropertyContextJson(...args),
      getDdataSnapshotJson: (...args: Parameters<typeof stub.getDdataSnapshotJson>) =>
        stub.getDdataSnapshotJson(...args),
      nightscoutHttpStatus: async () => JSON.stringify(status),
    };
    const response = await worker.fetch(
      new Request(`https://example.test/api/v2/properties/cage,sage,iage?tenant=${tenant}`),
      {
        ASSETS: env.ASSETS,
        ENTRY_STORE: { getByName: () => fakeStub },
        AUTH_DEFAULT_ROLES: "readable",
        AUTH_FAIL_DELAY: "0",
      } as unknown as Parameters<typeof worker.fetch>[1],
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      cage: { display: "1d0h" },
      iage: { display: "2d0h" },
      sage: { min: "Sensor Start" },
    });
  });
});
