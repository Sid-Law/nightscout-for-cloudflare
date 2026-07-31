import { describe, expect, it } from "vitest";
import { calculateSimpleAlarmRequest } from "../src/plugins/simplealarms";
import { URGENT, WARN } from "../src/runtime/levels";
import { nightscoutStatus, tenantStatusSettings } from "../src/status";

const now = Date.parse("2026-07-20T09:00:00.000Z");
const before = now - 5 * 60_000;
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

describe("locked Nightscout v15.0.7 simplealarms.test.js", () => {
  it("Not trigger an alarm when in range", () => {
    expect(calculateSimpleAlarmRequest([{ mills: now, mgdl: 100 }], now, settings))
      .toBeNull();
  });

  it("should trigger a warning when above target", () => {
    expect(calculateSimpleAlarmRequest([
      { mills: before, mgdl: 171 },
      { mills: now, mgdl: 181 },
    ], now, settings)).toMatchObject({
      level: WARN,
      title: "Warning HIGH",
      message: "BG Now: 181 +10 mg/dl",
      eventName: "high",
      pushoverSound: "climb",
      group: "default",
      plugin: { name: "simplealarms", pluginType: "notification" },
    });
  });

  it("should trigger a urgent alarm when really high", () => {
    expect(calculateSimpleAlarmRequest([{ mills: now, mgdl: 400 }], now, settings))
      .toMatchObject({ level: URGENT, title: "Urgent HIGH", eventName: "high" });
  });

  it("should trigger a warning when below target", () => {
    expect(calculateSimpleAlarmRequest([{ mills: now, mgdl: 70 }], now, settings))
      .toMatchObject({ level: WARN, title: "Warning LOW", eventName: "low" });
  });

  it("should trigger a urgent alarm when really low", () => {
    expect(calculateSimpleAlarmRequest([{ mills: now, mgdl: 40 }], now, settings))
      .toMatchObject({ level: URGENT, title: "Urgent LOW", eventName: "low" });
  });
});

describe("Workers simple-alarm platform context", () => {
  it("suppresses future, stale and invalid sensor rows at the locked boundary", () => {
    expect(calculateSimpleAlarmRequest([{ mills: now + 1, mgdl: 400 }], now, settings))
      .toBeNull();
    expect(calculateSimpleAlarmRequest([{ mills: now - 10 * 60_000, mgdl: 400 }], now, settings))
      .toBeNull();
    expect(calculateSimpleAlarmRequest([{ mills: now, mgdl: 39 }], now, settings))
      .toBeNull();
  });

  it("uses configured thresholds to select the official simple alarm plugin", () => {
    const configured = tenantStatusSettings({
      DISPLAY_UNITS: "mg/dl",
      BG_HIGH: "300",
      BG_TARGET_TOP: "170",
      BG_TARGET_BOTTOM: "75",
      BG_LOW: "50",
    });
    const statusSettings = nightscoutStatus(new Date(now), "readable", configured).settings as {
      enable: string[];
      thresholds: typeof settings.thresholds;
    };
    expect(statusSettings.enable).toContain("simplealarms");
    expect(statusSettings.enable).not.toContain("ar2");
    expect(calculateSimpleAlarmRequest(
      [{ mills: now, mgdl: 180 }],
      now,
      { ...settings, thresholds: statusSettings.thresholds },
    )).toMatchObject({ level: WARN, title: "Warning HIGH" });
  });
});
