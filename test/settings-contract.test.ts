import { describe, expect, it } from "vitest";
import { URGENT } from "../src/runtime/levels";
import { createNightscoutSettings } from "../src/settings";

/** Complete named-case mapping of locked v15.0.7 tests/settings.test.js. */
describe("locked Nightscout settings module", () => {
  it("have defaults ready", () => {
    const settings = createNightscoutSettings();
    expect(settings.timeFormat).toBe(12);
    expect(settings.nightMode).toBe(false);
    expect(settings.showRawbg).toBe("never");
    expect(settings.customTitle).toBe("Nightscout");
    expect(settings.theme).toBe("default");
    expect(settings.alarmUrgentHigh).toBe(true);
    expect(settings.alarmUrgentHighMins).toEqual([30, 60, 90, 120]);
    expect(settings.alarmHigh).toBe(true);
    expect(settings.alarmHighMins).toEqual([30, 60, 90, 120]);
    expect(settings.alarmLow).toBe(true);
    expect(settings.alarmLowMins).toEqual([15, 30, 45, 60]);
    expect(settings.alarmUrgentLow).toBe(true);
    expect(settings.alarmUrgentLowMins).toEqual([15, 30, 45]);
    expect(settings.alarmUrgentMins).toEqual([30, 60, 90, 120]);
    expect(settings.alarmWarnMins).toEqual([30, 60, 90, 120]);
    expect(settings.alarmTimeagoWarn).toBe(true);
    expect(settings.alarmTimeagoWarnMins).toBe(15);
    expect(settings.alarmTimeagoUrgent).toBe(true);
    expect(settings.alarmTimeagoUrgentMins).toBe(30);
    expect(settings.language).toBe("en");
    expect(settings.showPlugins).toBe("dbsize");
    expect(settings.insecureUseHttp).toBe(false);
    expect(settings.secureHstsHeader).toBe(true);
    expect(settings.secureCsp).toBe(false);
  });

  it("support setting from env vars", () => {
    const expected = [
      "ENABLE",
      "DISABLE",
      "UNITS",
      "TIME_FORMAT",
      "NIGHT_MODE",
      "SHOW_RAWBG",
      "CUSTOM_TITLE",
      "THEME",
      "ALARM_TYPES",
      "ALARM_URGENT_HIGH",
      "ALARM_HIGH",
      "ALARM_LOW",
      "ALARM_URGENT_LOW",
      "ALARM_TIMEAGO_WARN",
      "ALARM_TIMEAGO_WARN_MINS",
      "ALARM_TIMEAGO_URGENT",
      "ALARM_TIMEAGO_URGENT_MINS",
      "LANGUAGE",
      "SHOW_PLUGINS",
      "BG_HIGH",
      "BG_TARGET_TOP",
      "BG_TARGET_BOTTOM",
      "BG_LOW",
      "SCALE_Y",
    ];
    expect(expected).toHaveLength(24);
    const seen = new Set<string>();
    createNightscoutSettings().eachSettingAsEnv((name) => {
      seen.add(name);
      return undefined;
    });
    expect(expected.filter((name) => seen.has(name))).toHaveLength(expected.length);
  });

  it("support setting each", () => {
    const expected = [
      "enable",
      "disable",
      "units",
      "timeFormat",
      "nightMode",
      "showRawbg",
      "customTitle",
      "theme",
      "alarmTypes",
      "alarmUrgentHigh",
      "alarmHigh",
      "alarmLow",
      "alarmUrgentLow",
      "alarmTimeagoWarn",
      "alarmTimeagoWarnMins",
      "alarmTimeagoUrgent",
      "alarmTimeagoUrgentMins",
      "language",
      "showPlugins",
    ];
    expect(expected).toHaveLength(19);
    const seen = new Set<string>();
    createNightscoutSettings().eachSetting((name) => {
      seen.add(name);
      return undefined;
    });
    expect(expected.filter((name) => seen.has(name))).toHaveLength(expected.length);
  });

  it("have default features", () => {
    const settings = createNightscoutSettings();
    settings.eachSettingAsEnv(() => undefined);
    for (const feature of settings.DEFAULT_FEATURES) expect(settings.enable).toContain(feature);
  });

  it("support disabling default features", () => {
    const settings = createNightscoutSettings();
    settings.eachSettingAsEnv((name) => name === "DISABLE"
      ? `${settings.DEFAULT_FEATURES.join(" ")} ar2`
      : undefined);
    expect(settings.enable).toHaveLength(0);
  });

  it("parse custom snooze mins", () => {
    const settings = createNightscoutSettings();
    settings.eachSettingAsEnv((name) => name === "ALARM_URGENT_LOW_MINS" ? "5 10 15" : undefined);
    expect(settings.alarmUrgentLowMins).toEqual([5, 10, 15]);
    const notification = { eventName: "low", level: URGENT };
    expect(settings.snoozeMinsForAlarmEvent(notification)).toEqual([5, 10, 15]);
    expect(settings.snoozeFirstMinsForAlarmEvent(notification)).toBe(5);
  });

  it("set thresholds", () => {
    const values: Readonly<Record<string, string>> = {
      BG_HIGH: "200",
      BG_TARGET_TOP: "170",
      BG_TARGET_BOTTOM: "70",
      BG_LOW: "60",
    };
    const settings = createNightscoutSettings();
    settings.eachSettingAsEnv((name) => values[name]);
    expect(settings.thresholds).toEqual({
      bgHigh: 200,
      bgTargetTop: 170,
      bgTargetBottom: 70,
      bgLow: 60,
    });
    expect(settings.alarmTypes).toEqual(["simple"]);
  });

  it("default to predict if no thresholds are set", () => {
    const settings = createNightscoutSettings();
    settings.eachSettingAsEnv(() => undefined);
    expect(settings.alarmTypes).toEqual(["predict"]);
  });

  it("ignore junk alarm types", () => {
    const settings = createNightscoutSettings();
    settings.eachSettingAsEnv((name) => name === "ALARM_TYPES" ? "beep bop" : undefined);
    expect(settings.alarmTypes).toEqual(["predict"]);
  });

  it("allow multiple alarm types to be set", () => {
    const settings = createNightscoutSettings();
    settings.eachSettingAsEnv((name) => name === "ALARM_TYPES" ? "predict simple" : undefined);
    expect(settings.alarmTypes).toEqual(["predict", "simple"]);
  });

  it("handle screwed up thresholds in a way that will display something that looks wrong", () => {
    const values: Readonly<Record<string, string>> = {
      BG_HIGH: "89",
      BG_TARGET_TOP: "90",
      BG_TARGET_BOTTOM: "95",
      BG_LOW: "96",
    };
    const settings = createNightscoutSettings();
    settings.eachSettingAsEnv((name) => values[name]);
    expect(settings.thresholds).toEqual({
      bgHigh: 91,
      bgTargetTop: 90,
      bgTargetBottom: 89,
      bgLow: 88,
    });
    expect(settings.alarmTypes).toEqual(["simple"]);
  });

  it("check if a feature isEnabled", () => {
    const settings = createNightscoutSettings();
    settings.enable = ["feature1"];
    expect(settings.isEnabled("feature1")).toBe(true);
    expect(settings.isEnabled("feature2")).toBe(false);
  });

  it("check if any listed feature isEnabled", () => {
    const settings = createNightscoutSettings();
    settings.enable = ["feature1"];
    expect(settings.isEnabled(["unknown", "feature1"])).toBe(true);
    expect(settings.isEnabled(["unknown", "feature2"])).toBe(false);
  });

  it("keeps secure settings out of filtered request snapshots without cross-request state", () => {
    const first = createNightscoutSettings();
    first.enable = ["rawbg", "loop"];
    first.obscured = ["rawbg"];
    first.password = "must-not-leak";
    first.nested = { userName: "must-not-leak", visible: true };
    expect(first.filteredSettings(first)).toMatchObject({
      enable: ["loop"],
      nested: { visible: true },
    });
    expect(JSON.stringify(first.filteredSettings(first))).not.toContain("must-not-leak");
    expect(createNightscoutSettings().enable).toBeUndefined();
  });
});
