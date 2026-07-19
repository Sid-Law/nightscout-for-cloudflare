import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseEntryPayload } from "../src/model";
import { buildNightscoutSummary } from "../src/api2/summary";
import type { RealtimeSnapshot } from "../src/realtime/session-service";
import {
  cloneLegacyRealtimeDdataState,
  createLegacyRealtimeDdataState,
  mergeRealtimeDocumentsPreferNew,
  processRealtimeRawDataForRuntime,
} from "../src/realtime/ddata-snapshot";

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function endpoint(path: string, name: string): string {
  return `https://example.test${path}${path.includes("?") ? "&" : "?"}tenant=${name}`;
}

describe("locked Nightscout v15.0.7 v2 data contracts", () => {
  it("adapts every named ddata.test.js module, clone, normalization, and merge assertion", () => {
    const state = createLegacyRealtimeDdataState();
    expect(state).toEqual({
      sgvs: [],
      treatments: [],
      mbgs: [],
      cals: [],
      profiles: [],
      devicestatus: [],
      food: [],
      activity: [],
      dbstats: {},
      lastUpdated: 0,
    });
    const cloned = cloneLegacyRealtimeDdataState(state);
    expect(cloned).toEqual(state);
    expect(cloned).not.toBe(state);

    const createdAt = "2026-03-06T10:00:00.000Z";
    const source = [{
      _id: "507f1f77bcf86cd799439011",
      created_at: createdAt,
      durationInMilliseconds: 26_584,
    }];
    const [normalized] = processRealtimeRawDataForRuntime(source);
    expect(normalized).toMatchObject({
      mills: Date.parse(createdAt),
      duration: 0,
      endmills: Date.parse(createdAt) + 26_584,
    });
    expect(source[0]).not.toHaveProperty("mills");

    expect(mergeRealtimeDocumentsPreferNew(
      [{ _id: "mongo-id", identifier: "loop-id", carbs: 15 }],
      [{ identifier: "loop-id", carbs: 0 }],
    )).toEqual([{ identifier: "loop-id", carbs: 0 }]);
  });

  it("supports the locked properties wildcard selection and truthy pretty query", async () => {
    const name = tenant("v2-properties-selection");
    const now = Date.now();
    await env.ENTRY_STORE.getByName(name).putEntries(parseEntryPayload([
      {
        type: "sgv",
        sgv: 110,
        date: now - 300_000,
        dateString: new Date(now - 300_000).toISOString(),
        device: "simulator://cgm",
      },
      {
        type: "sgv",
        sgv: 123,
        date: now,
        dateString: new Date(now).toISOString(),
        direction: "SingleUp",
        device: "simulator://cgm",
      },
    ]));

    const selected = await SELF.fetch(endpoint("/api/v2/properties/bgnow,missing", name));
    expect(selected.status).toBe(200);
    const selectedBody = await selected.json() as Record<string, unknown>;
    expect(Object.keys(selectedBody)).toEqual(["bgnow"]);
    expect(selectedBody).toMatchObject({
      bgnow: {
        mean: 123,
        last: 123,
        mills: now,
        sgvs: [expect.objectContaining({ mgdl: 123, direction: "SingleUp" })],
      },
    });

    const pretty = await SELF.fetch(endpoint("/api/v2/properties/delta?pretty=1", name));
    expect(pretty.status).toBe(200);
    const body = await pretty.text();
    expect(body).toContain("\n  \"delta\": {");
    expect(JSON.parse(body)).toEqual({
      delta: expect.objectContaining({ mgdl: 13, display: "+13" }),
    });

    const emptyPretty = await SELF.fetch(endpoint("/api/v2/properties/delta?pretty", name));
    expect(await emptyPretty.text()).not.toContain("\n  \"delta\": {");
  });

  it("ports the locked summary SGV, treatment, profile, and empty-plugin-state mapping", () => {
    const now = Date.parse("2026-07-20T12:00:00.000Z");
    const snapshot: RealtimeSnapshot = {
      devicestatus: [],
      sgvs: [
        { mgdl: 90, mills: now - 7 * 60 * 60_000, noise: 2 },
        { mgdl: 110, mills: now - 10 * 60_000, noise: 1 },
        { mgdl: 123, mills: now - 5 * 60_000, noise: 2 },
      ],
      cals: [],
      profiles: [{
        defaultProfile: "Child",
        startDate: "2026-07-01T00:00:00.000Z",
        store: {
          Child: {
            timezone: "Asia/Shanghai",
            basal: [{ time: "00:00", value: "0.5", timeAsSeconds: 0 }],
          },
        },
      }],
      mbgs: [],
      food: [],
      treatments: [
        { eventType: "Carb Correction", carbs: 15, insulin: 0, mills: now - 60_000 },
        {
          eventType: "Temporary Target",
          targetTop: 119.6,
          targetBottom: 89.5,
          duration: 30,
          mills: now - 8 * 60 * 60_000,
        },
      ],
      dbstats: {},
    };
    const summary = buildNightscoutSummary(snapshot, 6, now);
    expect(summary.sgvs).toEqual([
      { sgv: 110, mills: now - 10 * 60_000 },
      { sgv: 123, mills: now - 5 * 60_000, noise: 2 },
    ]);
    expect(summary.treatments).toEqual({
      tempBasals: [],
      treatments: [{ mills: now - 60_000, carbs: 15, insulin: 0 }],
      targets: [{
        targetTop: 120,
        targetBottom: 90,
        duration: 1_800,
        mills: now - 8 * 60 * 60_000,
      }],
    });
    expect(summary.profile).toEqual({
      timezone: "Asia/Shanghai",
      basal: [{ time: "00:00", value: "0.5" }],
    });
    expect(JSON.parse(JSON.stringify(summary.state))).toEqual({
      iob: null,
      cob: null,
      bwp: null,
    });
  });

  it("serves summary over the tenant Durable Object without inventing plugin calculations", async () => {
    const name = tenant("v2-summary");
    const now = Date.now();
    const stub = env.ENTRY_STORE.getByName(name);
    await stub.putEntries(parseEntryPayload([{
      type: "sgv",
      sgv: 137,
      date: now - 60_000,
      dateString: new Date(now - 60_000).toISOString(),
      device: "simulator://cgm",
      noise: 1,
    }]));
    await stub.createDocuments("treatments", JSON.stringify([{
      eventType: "Carb Correction",
      carbs: 12,
      created_at: new Date(now - 30_000).toISOString(),
    }]));
    await stub.createDocuments("profile", JSON.stringify([{
      defaultProfile: "Child",
      startDate: "2026-07-01T00:00:00.000Z",
      store: { Child: { timezone: "Asia/Shanghai", basal: [] } },
    }]));

    const response = await SELF.fetch(endpoint("/api/v2/summary/?hours=6", name));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sgvs: [{ sgv: 137 }],
      treatments: { treatments: [{ carbs: 12 }] },
      profile: { timezone: "Asia/Shanghai", basal: [] },
      state: { iob: null, cob: null, bwp: null },
    });
  });
});
