import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  DATABASE_SIZE_INTENTS,
  calculateDatabaseSizeProperty,
  databaseSizeAssistantResponse,
  databaseSizeNotification,
  databaseSizeVisualization,
} from "../src/plugins/dbsize";
import { URGENT, WARN } from "../src/runtime/levels";
import { CLOUDFLARE_FREE_SQLITE_DO_MAX_MIB } from "../src/status";

const MIB = 1024 * 1024;
const dataInRange = { dataSize: MIB * 137, indexSize: MIB * 48, fileSize: MIB * 256 };
const dataWarn = { dataSize: MIB * 250, indexSize: MIB * 100, fileSize: MIB * 360 };
const dataUrgent = { dataSize: MIB * 300, indexSize: MIB * 150, fileSize: MIB * 496 };

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

describe("locked Nightscout dbsize.test.js", () => {
  it("display database size in range", () => {
    expect(calculateDatabaseSizeProperty(dataInRange)).toMatchObject({
      display: "37%",
      status: "current",
    });
  });

  it("display database size warning", () => {
    expect(calculateDatabaseSizeProperty(dataWarn)).toMatchObject({
      display: "70%",
      status: "warn",
    });
  });

  it("display database size urgent", () => {
    expect(calculateDatabaseSizeProperty(dataUrgent)).toMatchObject({
      display: "90%",
      status: "urgent",
    });
  });

  it("display database size warning notiffication", () => {
    const notification = databaseSizeNotification(
      calculateDatabaseSizeProperty(dataWarn),
      { enableAlerts: "TRUE" },
    );
    expect(notification).toMatchObject({
      level: WARN,
      title: "Warning Database Size near its limits!",
      message: "Database size is 350 MiB out of 496 MiB. Please backup and clean up database!",
    });
  });

  it("display database size urgent notiffication", () => {
    const notification = databaseSizeNotification(
      calculateDatabaseSizeProperty(dataUrgent),
      { enableAlerts: "TRUE" },
    );
    expect(notification).toMatchObject({
      level: URGENT,
      title: "Urgent Database Size near its limits!",
      message: "Database size is 450 MiB out of 496 MiB. Please backup and clean up database!",
    });
  });

  it("set a pill to the database size in percent", () => {
    expect(databaseSizeVisualization(calculateDatabaseSizeProperty(dataUrgent)))
      .toMatchObject({
        value: "90%",
        labelClass: "plugicon-database",
        pillClass: "urgent",
      });
  });

  it("set a pill to the database size in MiB", () => {
    expect(databaseSizeVisualization(calculateDatabaseSizeProperty(
      dataUrgent,
      { inMib: true },
    ))).toMatchObject({
      value: "450MiB",
      labelClass: "plugicon-database",
      pillClass: "urgent",
    });
  });

  it("configure warn level percentage", () => {
    expect(databaseSizeVisualization(calculateDatabaseSizeProperty(
      dataInRange,
      { warnPercentage: 30 },
    ))).toMatchObject({ value: "37%", pillClass: "warn" });
  });

  it("configure urgent level percentage", () => {
    expect(databaseSizeVisualization(calculateDatabaseSizeProperty(
      dataInRange,
      { warnPercentage: 30, urgentPercentage: 36 },
    ))).toMatchObject({ value: "37%", pillClass: "urgent" });
  });

  it("hide the pill if there is no info regarding database size", () => {
    expect(databaseSizeVisualization(calculateDatabaseSizeProperty(undefined)))
      .toMatchObject({ hide: true });
  });

  it("should handle virtAsst requests", () => {
    expect(DATABASE_SIZE_INTENTS).toHaveLength(1);
    expect(databaseSizeAssistantResponse(calculateDatabaseSizeProperty(dataUrgent)))
      .toEqual({
        title: "Database file size",
        response: "450 MiB. That is 90% of available database space.",
      });
  });
});

describe("live SQLite Durable Object dbsize property", () => {
  it("routes the actual SQLite byte count through the default-enabled plugin", async () => {
    const name = tenant("dbsize-property");
    const ddataResponse = await SELF.fetch(
      `https://example.test/api/v2/ddata/at?tenant=${encodeURIComponent(name)}`,
    );
    const ddata = await ddataResponse.json() as {
      dbstats: { dataSize: number; indexSize: number };
    };
    const response = await SELF.fetch(
      `https://example.test/api/v2/properties/dbsize?tenant=${encodeURIComponent(name)}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      dbsize: calculateDatabaseSizeProperty(ddata.dbstats, {
        max: CLOUDFLARE_FREE_SQLITE_DO_MAX_MIB,
      }),
    });
  });
});
