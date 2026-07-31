import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { RealtimeDocument } from "../src/realtime/ddata-snapshot";
import { INFO, NONE, WARN } from "../src/runtime/levels";
import { calculatePluginProperties, loadPluginPropertyContext } from "../src/plugins/properties";
import {
  XDRIPJS_PLUGIN,
  calculateXdripJsEvaluation,
  calculateXdripJsProperty,
  xdripJsVisualization,
} from "../src/plugins/xdripjs";
import { nightscoutStatus, tenantStatusSettings } from "../src/status";

const now = Date.parse("2026-07-22T08:00:00.000Z");

function status(
  at: number,
  timestamp: number,
  state: unknown = 6,
  overrides: RealtimeDocument = {},
  device = "xdripjs://family-rig/collector",
): RealtimeDocument {
  return {
    mills: at,
    created_at: new Date(at).toISOString(),
    device,
    xdripjs: {
      timestamp: new Date(timestamp).toISOString(),
      state,
      stateString: state === 6 ? "OK" : "Needs Attention",
      stateStringShort: state === 6 ? "OK" : "WAIT",
      sessionStart: now - 2 * 24 * 60 * 60_000,
      txId: "ABCDEF",
      txStatus: 0,
      txStatusString: "OK",
      txStatusStringShort: "OK",
      txActivation: now - 10 * 24 * 60 * 60_000,
      mode: "G6",
      rssi: -55,
      unfiltered: 120_000,
      filtered: 119_000,
      noise: 1,
      noiseString: "Clean",
      slope: 1.234,
      intercept: 45.678,
      calType: "SinglePoint",
      lastCalibrationDate: now - 6 * 60 * 60_000,
      batteryTimestamp: now - 10 * 60_000,
      voltagea: 310,
      voltageb: 300,
      temperature: 32,
      resistance: 900,
      ...overrides,
    },
  };
}

describe("locked Nightscout xdripjs server plugin", () => {
  it("returns the exact empty property shape and metadata", () => {
    const property = calculateXdripJsProperty([], now);
    expect(XDRIPJS_PLUGIN).toEqual({
      name: "xdripjs",
      label: "CGM Status",
      pluginType: "pill-status",
    });
    expect(property).toMatchObject({
      seenDevices: {},
      latest: null,
      lastState: null,
      lastStateString: null,
      lastVoltageA: null,
      lastVoltageB: null,
      level: NONE,
    });
  });

  it("uses the newest nested timestamp, filters future/old rows and records seen devices", () => {
    const property = calculateXdripJsProperty([
      status(now - 25 * 60 * 60_000, now + 5_000, 2, {}, "xdripjs://old-rig/path"),
      status(now - 30_000, now - 10_000, 2, {}, "xdripjs://newer-outer/path"),
      status(now - 60_000, now - 5_000, 6, {}, "xdripjs://newer-state/path"),
      status(now + 1, now + 1, 2, {}, "xdripjs://future-rig/path"),
    ], now);
    expect(property.lastState).toBe(6);
    expect(property.lastStateTime).toBe("2026-07-22T07:59:55.000Z");
    expect(property.seenDevices).toEqual({
      "xdripjs://newer-outer/path": {
        name: "newer-outer",
        uri: "xdripjs://newer-outer/path",
      },
      "xdripjs://newer-state/path": {
        name: "newer-state",
        uri: "xdripjs://newer-state/path",
      },
    });
  });

  it("projects all current transmitter fields and rounds slope/intercept", () => {
    const property = calculateXdripJsProperty([status(now - 1_000, now - 1_000)], now);
    expect(property).toMatchObject({
      level: NONE,
      lastState: 6,
      lastStateString: "OK",
      lastStateStringShort: "OK",
      lastTxId: "ABCDEF",
      lastTxStatus: 0,
      lastTxStatusString: "OK",
      lastMode: "G6",
      lastRssi: -55,
      lastUnfiltered: 120_000,
      lastFiltered: 119_000,
      lastNoise: 1,
      lastNoiseString: "Clean",
      lastSlope: 1.23,
      lastIntercept: 45.68,
      lastCalType: "SinglePoint",
      lastVoltageA: 310,
      lastVoltageB: 300,
      lastTemperature: 32,
      lastResistance: 900,
    });
    expect(property).not.toHaveProperty("notification");
  });

  it("emits a warning for a non-OK state and records its durable throttle marker", () => {
    const evaluation = calculateXdripJsEvaluation(
      [status(now - 1_000, now - 1_000, 2)],
      now,
      { enableAlerts: true },
    );
    expect(evaluation.notification).toEqual({
      title: "CGM Transmitter state: Needs Attention",
      message: "CGM Transmitter state: Needs Attention",
      pushoverSound: "incoming",
      level: WARN,
      group: "xDrip-js",
      plugin: XDRIPJS_PLUGIN,
      debug: { stateString: "Needs Attention" },
    });
    expect(evaluation.stateNotification).toEqual({ state: 2, timestamp: now });
    expect(evaluation.stateNotificationChanged).toBe(true);
    expect(evaluation.nextStateDueAt).toBe(now + 31 * 60_000);
  });

  it("uses information level for calibration requests", () => {
    const evaluation = calculateXdripJsEvaluation(
      [status(now - 1_000, now - 1_000, "7")],
      now,
      { enableAlerts: true },
    );
    expect(evaluation.notification).toMatchObject({ level: INFO, group: "xDrip-js" });
    expect(evaluation.property.level).toBe(INFO);
  });

  it("lets battery B override battery A and state messages with the exact thresholds", () => {
    const evaluation = calculateXdripJsEvaluation([
      status(now - 1_000, now - 1_000, 2, { voltagea: 299, voltageb: 289 }),
    ], now, { enableAlerts: true, warnBatV: 300 });
    expect(evaluation.notification).toMatchObject({
      level: WARN,
      title: "CGM Transmitter Battery Low",
      message: "CGM Transmitter Battery B Low Voltage: 289",
    });

    const strict = calculateXdripJsEvaluation([
      status(now - 1_000, now - 1_000, 6, { voltagea: 300, voltageb: 290 }),
    ], now, { enableAlerts: true, warnBatV: 300 });
    expect(strict.notification).toBeNull();
  });

  it("suppresses the same state through minute 30 and repeats at minute 31", () => {
    const previous = { state: "2", timestamp: now - 30 * 60_000 };
    const suppressed = calculateXdripJsEvaluation(
      [status(now - 1_000, now - 1_000, 2)],
      now,
      { enableAlerts: true, stateNotifyIntrvl: 0.5 },
      previous,
    );
    expect(suppressed.notification).toBeNull();
    expect(suppressed.stateNotificationChanged).toBe(false);
    expect(suppressed.nextStateDueAt).toBe(now + 60_000);

    const repeated = calculateXdripJsEvaluation(
      [status(now - 1_000, now - 1_000, 2)],
      now + 60_000,
      { enableAlerts: true, stateNotifyIntrvl: 0.5 },
      previous,
    );
    expect(repeated.notification).toMatchObject({ level: WARN });
    expect(repeated.stateNotification).toEqual({ state: 2, timestamp: now + 60_000 });
  });

  it("notifies a changed state immediately and updates throttle state even when alerts are off", () => {
    const previous = { state: 2, timestamp: now - 60_000 };
    const changed = calculateXdripJsEvaluation(
      [status(now - 1_000, now - 1_000, 3)],
      now,
      { enableAlerts: false },
      previous,
    );
    expect(changed.notification).toBeNull();
    expect(changed.stateNotification).toEqual({ state: 3, timestamp: now });
    expect(changed.stateNotificationChanged).toBe(true);
  });

  it("builds the official CGM pill class and core information", () => {
    const property = calculateXdripJsProperty(
      [status(now - 1_000, now - 60_000, 7)],
      now,
      { enableAlerts: true },
    );
    const visual = xdripJsVisualization(property, now);
    expect(visual).toMatchObject({
      value: "WAIT",
      label: "CGM",
      pillClass: "warn",
    });
    expect(visual.info.slice(0, 4)).toEqual([
      { label: "Seen: ", value: "family-rig" },
      { label: "State Time: ", value: "1 minutes ago" },
      { label: "Mode: ", value: "G6" },
      { label: "Status: ", value: "Needs Attention" },
    ]);
    expect(visual.info).toContainEqual({ label: "Session Age: ", value: "2 days 0 hours" });
    expect(visual.info).toContainEqual({ label: "Tx Age: ", value: "10 days" });
  });
});

describe("Workers xDrip-js platform adapter", () => {
  it("maps official environment values only when xdripjs is enabled", () => {
    const configured = tenantStatusSettings({
      ENABLE: "xdripjs",
      XDRIPJS_ENABLE_ALERTS: "true",
      XDRIPJS_WARN_BAT_V: "305",
      XDRIPJS_STATE_NOTIFY_INTRVL: "0.75",
    });
    expect(configured.extendedSettings).toMatchObject({
      xdripjs: { enableAlerts: true, warnBatV: 305, stateNotifyIntrvl: 0.75 },
    });
    expect(tenantStatusSettings({ XDRIPJS_ENABLE_ALERTS: "true" }).extendedSettings)
      .not.toHaveProperty("xdripjs");
  });

  it("runs sensorState in server order and serves the selected v2 property", async () => {
    const tenant = `xdrip-property-${crypto.randomUUID()}`;
    const stub = env.ENTRY_STORE.getByName(tenant);
    const liveNow = Date.now();
    await stub.createDocuments("devicestatus", JSON.stringify([{
      created_at: new Date(liveNow - 30_000).toISOString(),
      device: "xdripjs://family-phone",
      xdripjs: {
        timestamp: new Date(liveNow - 45_000).toISOString(),
        state: 6,
        stateString: "OK",
        stateStringShort: "OK",
        voltagea: 310,
        voltageb: 300,
        slope: 1.234,
        intercept: 45.678,
      },
    }]));
    const context = await loadPluginPropertyContext(stub, liveNow);
    const properties = calculatePluginProperties(
      context,
      "mg/dl",
      liveNow,
      new Set(["xdripjs"]),
    );
    expect(Object.keys(properties)).toEqual(["sensorState"]);
    expect(properties.sensorState).toMatchObject({
      lastState: 6,
      lastStateString: "OK",
      lastSlope: 1.23,
      lastIntercept: 45.68,
    });

    const enabledStatus = nightscoutStatus(
      new Date(liveNow),
      "readable",
      tenantStatusSettings({ ENABLE: "xdripjs" }),
    );
    const fakeStub = {
      authorizationDelay: (...args: Parameters<typeof stub.authorizationDelay>) =>
        stub.authorizationDelay(...args),
      listDocuments: (...args: Parameters<typeof stub.listDocuments>) => stub.listDocuments(...args),
      getPluginPropertyContextJson: (...args: Parameters<typeof stub.getPluginPropertyContextJson>) =>
        stub.getPluginPropertyContextJson(...args),
      getDdataSnapshotJson: (...args: Parameters<typeof stub.getDdataSnapshotJson>) =>
        stub.getDdataSnapshotJson(...args),
      nightscoutHttpStatus: async () => JSON.stringify(enabledStatus),
    };
    const response = await worker.fetch(
      new Request(`https://example.test/api/v2/properties/sensorState?tenant=${tenant}`),
      {
        ASSETS: env.ASSETS,
        ENTRY_STORE: { getByName: () => fakeStub },
        AUTH_DEFAULT_ROLES: "readable",
        AUTH_FAIL_DELAY: "0",
      } as unknown as Parameters<typeof worker.fetch>[1],
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sensorState: { lastState: 6, lastStateString: "OK" },
    });
  });
});
