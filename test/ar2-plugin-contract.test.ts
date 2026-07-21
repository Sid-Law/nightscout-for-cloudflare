import { describe, expect, it } from "vitest";
import {
  calculateAr2ForecastCone,
  calculateAr2NotificationRequest,
  calculateAr2Property,
  calculateAr2VirtualAssistant,
} from "../src/plugins/ar2";
import { calculatePluginProperties } from "../src/plugins/properties";
import { URGENT, WARN } from "../src/runtime/levels";
import { nightscoutStatus, tenantStatusSettings } from "../src/status";

const now = Date.parse("2026-07-22T08:00:00.000Z");
const before = now - 5 * 60_000;
const sixMinutes = 6 * 60_000;
const settings = {
  units: "mg/dl",
  thresholds: {
    bgHigh: 260,
    bgTargetTop: 180,
    bgTargetBottom: 80,
    bgLow: 55,
  },
  alarmUrgentHigh: true,
  alarmHigh: true,
  alarmUrgentLow: true,
  alarmLow: true,
};

describe("locked Nightscout v15.0.7 ar2.test.js", () => {
  it("should plot a cone", () => {
    expect(calculateAr2ForecastCone([
      { mgdl: 100, mills: before },
      { mgdl: 105, mills: now },
    ], now, settings)).toHaveLength(26);
  });

  it("should plot a line if coneFactor is 0", () => {
    expect(calculateAr2ForecastCone([
      { mgdl: 100, mills: before },
      { mgdl: 105, mills: now },
    ], now, settings, { coneFactor: 0 })).toHaveLength(13);
  });

  it("Not trigger an alarm when in range", () => {
    expect(calculateAr2NotificationRequest([
      { mgdl: 100, mills: before },
      { mgdl: 105, mills: now },
    ], now, settings)).toBeNull();
  });

  it("should trigger a warning when going above target", () => {
    expect(calculateAr2NotificationRequest([
      { mgdl: 150, mills: before },
      { mgdl: 170, mills: now },
    ], now, settings, {
      direction: { value: "FortyFiveUp", label: "↗", entity: "&#8599;" },
      propertyLines: { iob: "IOB: 1.25U" },
    })).toMatchObject({
      level: WARN,
      title: "Warning, HIGH predicted",
      message: "BG Now: 170 +20 ↗ mg/dl\nBG 15m: 206 mg/dl\nIOB: 1.25U",
      eventName: "high",
      pushoverSound: "climb",
      plugin: { name: "ar2", label: "AR2", pluginType: "forecast" },
      group: "default",
    });
  });

  it("should trigger a urgent alarm when going high fast", () => {
    expect(calculateAr2NotificationRequest([
      { mgdl: 140, mills: before },
      { mgdl: 200, mills: now },
    ], now, settings)).toMatchObject({
      level: URGENT,
      title: "Urgent, HIGH",
    });
  });

  it("should trigger a warning when below target", () => {
    expect(calculateAr2NotificationRequest([
      { mgdl: 90, mills: before },
      { mgdl: 80, mills: now },
    ], now, settings)).toMatchObject({
      level: WARN,
      title: "Warning, LOW",
    });
  });

  it("should trigger a warning when almost below target", () => {
    expect(calculateAr2NotificationRequest([
      { mgdl: 90, mills: before },
      { mgdl: 83, mills: now },
    ], now, settings)).toMatchObject({
      level: WARN,
      title: "Warning, LOW predicted",
    });
  });

  it("should trigger a urgent alarm when falling fast", () => {
    expect(calculateAr2NotificationRequest([
      { mgdl: 120, mills: before },
      { mgdl: 85, mills: now },
    ], now, settings)).toMatchObject({
      level: URGENT,
      title: "Urgent, LOW predicted",
    });
  });

  it("should trigger a warning alarm by interpolating when more than 5mins apart", () => {
    expect(calculateAr2NotificationRequest([
      { mgdl: 120, mills: before - sixMinutes },
      { mgdl: 85, mills: now },
    ], now, settings)).toMatchObject({
      level: WARN,
      title: "Warning, LOW predicted",
    });
  });

  it("should handle virtAsst requests", () => {
    expect(calculateAr2VirtualAssistant([
      { mgdl: 100, mills: before },
      { mgdl: 105, mills: now },
    ], now, settings)).toEqual({
      title: "AR2 Forecast",
      response: "According to the AR2 forecast you are expected to be between 109 and 120 over the next in 30 minutes",
    });
  });
});

describe("Workers AR2 platform adaptation", () => {
  it("runs AR2 in locked server property order", () => {
    const properties = calculatePluginProperties({
      sgvs: [
        { mgdl: 100, mills: before },
        { mgdl: 105, mills: now },
      ],
      cals: [],
      devicestatus: [],
    }, "mg/dl", now, new Set(["bgnow", "ar2"]), {}, settings);
    expect(properties.ar2).toEqual(calculateAr2Property([
      { mgdl: 100, mills: before },
      { mgdl: 105, mills: now },
    ], now, settings));
  });

  it("maps official ALARM_TYPES and AR2_CONE_FACTOR settings", () => {
    const overrides = tenantStatusSettings({
      ALARM_TYPES: "predict simple",
      AR2_CONE_FACTOR: "0",
    });
    const status = nightscoutStatus(new Date(now), "readable", overrides);
    const resolved = status.settings as Record<string, unknown>;
    expect(resolved.alarmTypes).toEqual(["predict", "simple"]);
    expect(resolved.enable).toEqual(expect.arrayContaining(["ar2", "simplealarms"]));
    expect(status.extendedSettings).toMatchObject({ ar2: { coneFactor: 0 } });
  });

  it("keeps the locked mmol scaling and stale-data boundary", () => {
    const mmolSettings = { ...settings, units: "mmol" };
    expect(calculateAr2NotificationRequest([
      { mgdl: 150, mills: before },
      { mgdl: 170, mills: now },
    ], now, mmolSettings)).toMatchObject({
      level: WARN,
      title: "Warning, HIGH predicted",
      message: "BG Now: 9.4 +1.1 mmol/L\nBG 15m: 11.4 mmol/L",
    });
    expect(calculateAr2NotificationRequest([
      { mgdl: 150, mills: before - 10 * 60_000 - 1 },
      { mgdl: 170, mills: now - 10 * 60_000 - 1 },
    ], now, mmolSettings)).toBeNull();
  });
});
