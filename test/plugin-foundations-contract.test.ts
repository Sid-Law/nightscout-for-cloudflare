import { describe, expect, it } from "vitest";
import {
  INFO,
  LOW,
  LOWEST,
  NONE,
  levelToDisplay,
  levelToLowerCase,
  URGENT,
  WARN,
} from "../src/runtime/levels";
import { nightscoutTimes } from "../src/runtime/times";
import { mgdlToMMOL, mmolToMgdl } from "../src/runtime/units";
import {
  calculateRawBg,
  calculateRawBgProperty,
  RAW_BG_INTENTS,
  rawBgAssistantResponse,
  rawBgNoiseLabel,
} from "../src/plugins/rawbg";
import {
  calculateUploaderBatteryProperty,
  UPLOADER_BATTERY_INTENTS,
  uploaderBatteryAssistantResponse,
  uploaderBatteryVisualization,
} from "../src/plugins/upbat";
import {
  calculatePluginProperties,
  loadPluginPropertyContext,
} from "../src/plugins/properties";
import { tenantStatusSettings } from "../src/status";

describe("locked Nightscout times.test.js", () => {
  it("converts hours to minutes, seconds, and milliseconds", () => {
    expect(nightscoutTimes.hour()).toMatchObject({ mins: 60, secs: 3_600, msecs: 3_600_000 });
    expect(nightscoutTimes.hours(3)).toMatchObject({
      mins: 180,
      secs: 10_800,
      msecs: 10_800_000,
    });
  });

  it("converts minutes to seconds and milliseconds", () => {
    expect(nightscoutTimes.min()).toMatchObject({ secs: 60, msecs: 60_000 });
    expect(nightscoutTimes.mins(2)).toMatchObject({ secs: 120, msecs: 120_000 });
  });

  it("converts seconds to milliseconds", () => {
    expect(nightscoutTimes.sec().msecs).toBe(1_000);
    expect(nightscoutTimes.secs(15).msecs).toBe(15_000);
  });
});

describe("locked Nightscout units.test.js", () => {
  it("preserves every named mg/dl and mmol conversion assertion", () => {
    expect(mgdlToMMOL(99)).toBe("5.5");
    expect(mgdlToMMOL(180)).toBe("10.0");
    expect(mmolToMgdl(5.5)).toBe(99);
    expect(mmolToMgdl(10)).toBe(180);
    expect(mgdlToMMOL(mmolToMgdl(5.5))).toBe("5.5");
    expect(mmolToMgdl(mgdlToMMOL(99))).toBe(99);
  });
});

describe("locked Nightscout levels.test.js", () => {
  it("preserves constants, display labels, lowercase labels, and unknowns", () => {
    expect([URGENT, WARN, INFO, LOW, LOWEST, NONE]).toEqual([2, 1, 0, -1, -2, -3]);
    expect([URGENT, WARN, INFO, LOW, LOWEST, NONE, 42, 99].map(levelToDisplay)).toEqual([
      "Urgent",
      "Warning",
      "Info",
      "Low",
      "Lowest",
      "None",
      "Unknown",
      "Unknown",
    ]);
    expect([URGENT, WARN, INFO, LOW, LOWEST, NONE, 42, 99].map(levelToLowerCase)).toEqual([
      "urgent",
      "warning",
      "info",
      "low",
      "lowest",
      "none",
      "unknown",
      "unknown",
    ]);
  });
});

describe("locked Nightscout rawbg.test.js", () => {
  const now = Date.parse("2026-07-20T12:00:00.000Z");
  const sgv = { unfiltered: 113_680, filtered: 111_232, mgdl: 110, noise: 1, mills: now };
  const cal = {
    scale: 1,
    intercept: 25_717.82377004309,
    slope: 766.895601715918,
    mills: now,
  };

  it("offers the exact raw BG and English noise property", () => {
    const property = calculateRawBgProperty([sgv], [cal], now, "mg/dl");
    expect(property).toMatchObject({
      mgdl: 113,
      noiseLabel: "Clean",
      displayLine: "Raw BG: 113 mg/dl Clean",
      sgv,
      cal,
    });
    expect(calculateRawBg(sgv, cal)).toBe(113);
    expect(rawBgNoiseLabel(110, 1)).toBe("Clean");
  });

  it("preserves the one MetricNow handler and exact assistant response", () => {
    expect(RAW_BG_INTENTS).toHaveLength(1);
    expect(RAW_BG_INTENTS[0]).toEqual({
      intent: "MetricNow",
      metrics: ["raw bg", "raw blood glucose"],
    });
    expect(rawBgAssistantResponse({ mgdl: 113 })).toEqual({
      title: "Current Raw BG",
      response: "Your raw bg is 113",
    });
  });
});

describe("locked Nightscout upbat.test.js", () => {
  const now = Date.parse("2026-07-20T12:00:00.000Z");

  it("offers and visualizes the urgent 20% uploader battery property", () => {
    const property = calculateUploaderBatteryProperty([
      { mills: now, uploader: { battery: 20 } },
    ], now);
    expect(property).toMatchObject({
      display: "20%",
      status: "urgent",
      min: { value: 20, level: 25 },
    });
    expect(uploaderBatteryVisualization(property)).toMatchObject({
      value: "20%",
      labelClass: "icon-battery-25",
      pillClass: "urgent",
      hide: false,
    });
  });

  it("hides missing and negative-one uploader battery values", () => {
    const missing = calculateUploaderBatteryProperty([], now);
    expect(uploaderBatteryVisualization(missing).hide).toBe(true);
    const unavailable = calculateUploaderBatteryProperty([
      { mills: now, uploader: { battery: -1 } },
    ], now);
    expect(uploaderBatteryVisualization(unavailable).hide).toBe(true);
  });

  it("preserves both assistant intents and their exact response", () => {
    expect(UPLOADER_BATTERY_INTENTS).toHaveLength(2);
    expect(UPLOADER_BATTERY_INTENTS.map((handler) => handler.intent)).toEqual([
      "UploaderBattery",
      "MetricNow",
    ]);
    const response = uploaderBatteryAssistantResponse({ display: "20%" });
    expect(response).toEqual({
      title: "Uploader Battery",
      response: "Your uploader battery is at 20%",
    });
    expect(uploaderBatteryAssistantResponse({ display: "20%" })).toEqual(response);
  });
});

describe("enabled plugin property adapter", () => {
  it("runs rawbg/upbat in official order and keeps rawbg disabled by default", () => {
    const now = Date.parse("2026-07-20T12:00:00.000Z");
    const context = {
      sgvs: [{
        mills: now,
        mgdl: 110,
        direction: "Flat",
        unfiltered: 113_680,
        filtered: 111_232,
        noise: 1,
      }],
      cals: [{
        mills: now,
        scale: 1,
        intercept: 25_717.82377004309,
        slope: 766.895601715918,
      }],
      devicestatus: [{ mills: now, uploader: { battery: 20 } }],
    };
    const enabled = calculatePluginProperties(
      context,
      "mg/dl",
      now,
      new Set(["bgnow", "rawbg", "direction", "upbat"]),
    );
    expect(Object.keys(enabled)).toEqual([
      "bgnow",
      "delta",
      "buckets",
      "rawbg",
      "direction",
      "upbat",
    ]);
    expect(enabled).toMatchObject({
      rawbg: { mgdl: 113 },
      direction: { value: "Flat" },
      upbat: { display: "20%" },
    });

    const defaultFeatures = tenantStatusSettings({});
    expect(defaultFeatures.enable).toBeUndefined();
    const configured = tenantStatusSettings({ ENABLE: "rawbg", DISABLE: "dbsize" });
    expect(configured.enable).toContain("rawbg");
    expect(configured.enable).not.toContain("dbsize");
  });

  it("survives a rolling deploy by falling back only from a missing new DO RPC", async () => {
    let legacyCalls = 0;
    const source = {
      getPluginPropertyContextJson: async (): Promise<string> => {
        throw new Error(
          'The RPC receiver does not implement the method "getPluginPropertyContextJson".',
        );
      },
      getDdataSnapshotJson: async (): Promise<string> => {
        legacyCalls += 1;
        return JSON.stringify({
          sgvs: [{ mills: 1, mgdl: 100 }],
          cals: [{ mills: 1, slope: 1 }],
          devicestatus: [{ mills: 1, uploader: { battery: 20 } }],
          treatments: [{ shouldNotLeak: true }],
        });
      },
    };
    expect(await loadPluginPropertyContext(source, 1)).toEqual({
      sgvs: [{ mills: 1, mgdl: 100 }],
      cals: [{ mills: 1, slope: 1 }],
      devicestatus: [{ mills: 1, uploader: { battery: 20 } }],
      treatments: [],
      dbstats: {},
    });
    expect(legacyCalls).toBe(1);

    await expect(loadPluginPropertyContext({
      ...source,
      getPluginPropertyContextJson: async (): Promise<string> => {
        throw new Error("sqlite property query failed");
      },
    }, 1)).rejects.toThrow("sqlite property query failed");
    expect(legacyCalls).toBe(1);
  });
});
