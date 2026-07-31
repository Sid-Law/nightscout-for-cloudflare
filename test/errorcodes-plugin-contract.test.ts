import { describe, expect, it } from "vitest";
import {
  buildErrorCodeLevelMapping,
  calculateErrorCodeNotification,
  errorCodeDisplay,
} from "../src/plugins/errorcodes";
import { INFO, URGENT, WARN } from "../src/runtime/levels";
import { CLOUDFLARE_FREE_SQLITE_DO_MAX_MIB, tenantStatusSettings } from "../src/status";

const now = Date.parse("2026-07-22T06:00:00.000Z");

function sgv(mgdl: number, mills = now): Record<string, unknown> {
  return { _id: `code-${mgdl}`, mgdl, mills, type: "sgv" };
}

describe("locked Dexcom errorcodes plugin contract", () => {
  it("Not trigger an alarm when in range", () => {
    expect(calculateErrorCodeNotification([sgv(100)], now)).toBeNull();
  });

  it("should trigger a urgent alarm when ???", () => {
    expect(calculateErrorCodeNotification([sgv(10)], now)).toEqual({
      level: URGENT,
      title: "CGM Error Code",
      message: "???",
      plugin: {
        name: "errorcodes",
        label: "Dexcom Error Codes",
        pluginType: "notification",
      },
      pushoverSound: "alien",
      group: "CGM Error Code",
      debug: { lastSGV: sgv(10) },
    });
  });

  it("should trigger a urgent alarm when hourglass", () => {
    expect(calculateErrorCodeNotification([sgv(9)], now)).toMatchObject({
      level: URGENT,
      message: "?AD",
      pushoverSound: "alien",
    });
  });

  it("should trigger a low notification when needing calibration", () => {
    expect(calculateErrorCodeNotification([sgv(5)], now)).toMatchObject({
      level: INFO,
      message: "?NC",
      pushoverSound: "intermission",
    });
  });

  it("should trigger a low notification when code < 9", () => {
    for (let code = 1; code < 9; code += 1) {
      expect(calculateErrorCodeNotification([sgv(code)], now)?.level).toBe(INFO);
    }
  });

  it("convert a code to display", () => {
    expect(errorCodeDisplay(5)).toBe("?NC");
    expect(errorCodeDisplay(9)).toBe("?AD");
    expect(errorCodeDisplay(10)).toBe("???");
    expect(errorCodeDisplay(11)).toBe("11??");
    expect(errorCodeDisplay(12)).toBe("?RF");
  });

  it("have default code to level mappings", () => {
    expect(buildErrorCodeLevelMapping()).toEqual({
      1: INFO,
      2: INFO,
      3: INFO,
      4: INFO,
      5: INFO,
      6: INFO,
      7: INFO,
      8: INFO,
      9: URGENT,
      10: URGENT,
    });
  });

  it("allow config of custom code to level mappings", () => {
    expect(buildErrorCodeLevelMapping({
      info: "off",
      warn: "9 10",
      urgent: "off",
    })).toEqual({ 9: WARN, 10: WARN });
  });

  it("uses the latest nonfuture SGV and the strict ten-minute freshness boundary", () => {
    expect(calculateErrorCodeNotification([
      sgv(10, now - 1),
      sgv(9, now + 1),
    ], now)?.message).toBe("???");
    expect(calculateErrorCodeNotification([sgv(10, now - 10 * 60_000 + 1)], now))
      .not.toBeNull();
    expect(calculateErrorCodeNotification([sgv(10, now - 10 * 60_000)], now)).toBeNull();
    expect(calculateErrorCodeNotification([sgv(10, now + 1)], now)).toBeNull();
  });

  it("preserves literal ERRORCODES strings, including off, in status settings", () => {
    expect(tenantStatusSettings({
      ERRORCODES_INFO: "off",
      ERRORCODES_WARN: "9 10",
      ERRORCODES_URGENT: "off",
    }).extendedSettings).toEqual({
      dbsize: { max: CLOUDFLARE_FREE_SQLITE_DO_MAX_MIB },
      devicestatus: { advanced: true, days: 1 },
      errorcodes: { info: "off", warn: "9 10", urgent: "off" },
    });
    expect(tenantStatusSettings({
      DISABLE: "errorcodes",
      ERRORCODES_WARN: "9 10",
    }).extendedSettings).toEqual({
      dbsize: { max: CLOUDFLARE_FREE_SQLITE_DO_MAX_MIB },
      devicestatus: { advanced: true, days: 1 },
    });
  });
});
