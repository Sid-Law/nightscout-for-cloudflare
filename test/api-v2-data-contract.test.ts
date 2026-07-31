import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseEntryPayload } from "../src/model";
import { buildNightscoutSummary } from "../src/api2/summary";
import type { RealtimeSnapshot } from "../src/realtime/session-service";
import {
  buildRealtimeTreatmentBuckets,
  cloneLegacyRealtimeDdataState,
  createLegacyRealtimeDdataState,
  mergeRealtimeDocumentsPreferNew,
  normalizeRealtimeDdataDocument,
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

  it("ports the enumerable treatment buckets added by processTreatments(true)", () => {
    const treatments = [
      { _id: "a", eventType: "Profile Switch", mills: 1_000, duration: 30, profile: "A" },
      { _id: "b", eventType: "Profile Switch", mills: 2_000, duration: 0, profile: "B" },
      { _id: "c", eventType: "Temp Basal", mills: 3_000, duration: 30 },
      { _id: "d", eventType: "Temp Basal", mills: 4_000, duration: 0 },
      {
        _id: "e",
        eventType: "Temporary Target",
        mills: 5_000,
        duration: 30,
        targetTop: 6,
        targetBottom: 5,
        units: "mmol",
      },
      { _id: "f", eventType: "Combo Bolus", mills: 6_000 },
      { _id: "g", eventType: "Site Change", mills: 7_000 },
      { _id: "h", eventType: "Sensor Start", mills: 8_000 },
      { _id: "i", eventType: "Insulin Change", mills: 9_000 },
      { _id: "j", eventType: "Pump Battery Change", mills: 10_000 },
    ];
    expect(buildRealtimeTreatmentBuckets(treatments)).toEqual({
      sitechangeTreatments: [{ _id: "g", eventType: "Site Change", mills: 7_000 }],
      insulinchangeTreatments: [{
        _id: "i",
        eventType: "Insulin Change",
        mills: 9_000,
      }],
      batteryTreatments: [{
        _id: "j",
        eventType: "Pump Battery Change",
        mills: 10_000,
      }],
      sensorTreatments: [{ _id: "h", eventType: "Sensor Start", mills: 8_000 }],
      profileTreatments: [
        {
          _id: "a",
          eventType: "Profile Switch",
          mills: 1_000,
          duration: 1 / 60,
          profile: "A",
          cuttedby: "B",
        },
        {
          _id: "b",
          eventType: "Profile Switch",
          mills: 2_000,
          duration: 0,
          profile: "B",
          cutting: "A",
        },
      ],
      combobolusTreatments: [{ _id: "f", eventType: "Combo Bolus", mills: 6_000 }],
      tempbasalTreatments: [{
        _id: "c",
        eventType: "Temp Basal",
        mills: 3_000,
        duration: 1 / 60,
      }],
      tempTargetTreatments: [{
        _id: "e",
        eventType: "Temporary Target",
        mills: 5_000,
        duration: 30,
        targetTop: 108.09353999999999,
        targetBottom: 90.07795,
        units: "mg/dl",
      }],
    });

    const food = normalizeRealtimeDdataDocument({
      _id: 123,
      created_at: "2026-07-22T00:00:00.000Z",
      nested: { _id: 456, amount: "0.75" },
    }, false);
    expect(food).toEqual({
      _id: "123",
      created_at: "2026-07-22T00:00:00.000Z",
      nested: { _id: "456", amount: "0.75", absolute: 0.75 },
    });
    expect(food).not.toHaveProperty("mills");
  });

  it("projects the locked two-day Activity bucket into current v2 ddata only", async () => {
    const name = tenant("v2-ddata-activity");
    const now = Date.now();
    const recentAt = new Date(now - 5 * 60_000).toISOString();
    const futureAt = new Date(now + 60 * 60_000).toISOString();
    const stub = env.ENTRY_STORE.getByName(name);
    await stub.createDocuments("activity", JSON.stringify([
      {
        _id: "111111111111111111111111",
        created_at: new Date(now - 3 * 24 * 60 * 60_000).toISOString(),
        heartrate: 80,
      },
      {
        _id: "222222222222222222222222",
        created_at: recentAt,
        heartrate: 101,
        steps: 22,
        activitylevel: 3,
      },
      {
        _id: "333333333333333333333333",
        created_at: recentAt,
        heartrate: 999,
        steps: 999,
        activitylevel: 999,
      },
      {
        _id: "444444444444444444444444",
        created_at: futureAt,
        steps: 44,
      },
    ]));

    const response = await SELF.fetch(endpoint("/api/v2/ddata/at", name));
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.activity).toEqual([
      { mills: recentAt, heartrate: 101, steps: 22, activitylevel: 3 },
      { mills: futureAt, steps: 44 },
    ]);
    // dataWithRecentStatuses(), used for root Socket.IO authorization, does
    // not expose Activity; this bucket belongs to ddata.clone() only.
    expect(body).not.toHaveProperty("page");
  });

  it("caps Activity at explicit historical ddata frames and exposes frame metadata", async () => {
    const name = tenant("v2-ddata-activity-frame");
    const now = Date.now();
    const frameAt = now - 10 * 60_000;
    const beforeAt = new Date(frameAt - 60_000).toISOString();
    const afterAt = new Date(frameAt + 60_000).toISOString();
    const stub = env.ENTRY_STORE.getByName(name);
    await stub.createDocuments("activity", JSON.stringify([
      {
        _id: "555555555555555555555555",
        created_at: new Date(frameAt - 3 * 24 * 60 * 60_000).toISOString(),
        heartrate: 70,
      },
      {
        _id: "666666666666666666666666",
        created_at: beforeAt,
        heartrate: 96,
      },
      {
        _id: "777777777777777777777777",
        created_at: afterAt,
        heartrate: 120,
      },
    ]));

    const response = await SELF.fetch(endpoint(`/api/v2/ddata/at/${frameAt}`, name));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      lastUpdated: frameAt,
      page: { frame: true, after: frameAt },
      activity: [{ mills: beforeAt, heartrate: 96 }],
    });
  });

  it("serves full ddata.clone Profile, DeviceStatus, Food, and Treatment buckets", async () => {
    const name = tenant("v2-full-ddata");
    const now = Date.now();
    const stub = env.ENTRY_STORE.getByName(name);
    await stub.createDocuments("profile", JSON.stringify([{
      _id: "888888888888888888888888",
      defaultProfile: "Child",
      store: { Child: {}, "Child@@@@@historical": {} },
    }]));
    await stub.createDocuments("food", JSON.stringify([{
      _id: "999999999999999999999999",
      created_at: new Date(now - 60_000).toISOString(),
      name: "ordinary meal",
      nested: { amount: "0.5" },
    }]));
    await stub.createDocuments("devicestatus", JSON.stringify([
      ...Array.from({ length: 12 }, (_unused, index) => ({
        _id: (100 + index).toString().repeat(24).slice(0, 24),
        device: "loop-device",
        created_at: new Date(now - (12 - index) * 60_000).toISOString(),
        loop: { iob: { iob: index } },
      })),
      {
        _id: "121212121212121212121212",
        device: "future-loop-device",
        created_at: new Date(now + 60 * 60_000).toISOString(),
        loop: { iob: { iob: 99 } },
      },
    ]));
    await stub.createDocuments("treatments", JSON.stringify([
      {
        _id: "131313131313131313131313",
        eventType: "Note",
        created_at: new Date(now - 10 * 24 * 60 * 60_000).toISOString(),
        notes: "outside ordinary window",
      },
      {
        _id: "141414141414141414141414",
        eventType: "Profile Switch",
        created_at: new Date(now - 30 * 24 * 60 * 60_000).toISOString(),
        duration: 0,
        profile: "Child",
      },
      {
        _id: "151515151515151515151515",
        eventType: "Site Change",
        created_at: new Date(now - 30 * 24 * 60 * 60_000 + 1_000).toISOString(),
      },
      {
        _id: "161616161616161616161616",
        eventType: "Temp Basal",
        created_at: new Date(now - 2 * 60_000).toISOString(),
        duration: 30,
        amount: "0.7",
      },
      {
        _id: "171717171717171717171717",
        eventType: "Temporary Target",
        created_at: new Date(now - 90_000).toISOString(),
        duration: 30,
        targetTop: 6,
        targetBottom: 5,
        units: "mmol",
      },
      {
        _id: "181818181818181818181818",
        eventType: "Temp Basal",
        created_at: new Date(now - 60_000).toISOString(),
        duration: 0,
      },
    ]));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE documents
         SET updated_at = ?
         WHERE collection = 'treatments' AND id = ?`,
        now - 10 * 24 * 60 * 60_000,
        "131313131313131313131313",
      );
    });

    const response = await SELF.fetch(endpoint("/api/v2/ddata/at", name));
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;
    expect(body.profiles[0].store).toHaveProperty("Child@@@@@historical");
    expect(body.devicestatus).toHaveLength(13);
    expect(body.devicestatus[0].mills).toBeLessThan(body.devicestatus[11].mills);
    expect(body.devicestatus[12]).toMatchObject({ device: "future-loop-device" });
    expect(body.food).toEqual([expect.objectContaining({
      name: "ordinary meal",
      nested: { amount: "0.5", absolute: 0.5 },
    })]);
    expect(body.food[0]).not.toHaveProperty("mills");
    expect(body.treatments).toHaveLength(5);
    expect(body.treatments).not.toContainEqual(
      expect.objectContaining({ notes: "outside ordinary window" }),
    );
    expect(body.treatments.map((treatment: Record<string, unknown>) => treatment._id))
      .toEqual([
        "141414141414141414141414",
        "151515151515151515151515",
        "161616161616161616161616",
        "171717171717171717171717",
        "181818181818181818181818",
      ]);
    expect(body.treatments[2]).toMatchObject({ amount: "0.7", absolute: 0.7 });
    expect(body.lastProfileFromSwitch).toBe("Child");
    expect(body.sitechangeTreatments).toEqual([
      expect.objectContaining({ _id: "151515151515151515151515" }),
    ]);
    expect(body.tempbasalTreatments).toEqual([
      expect.objectContaining({ _id: "161616161616161616161616", duration: 1 }),
    ]);
    expect(body.tempTargetTreatments).toEqual([
      expect.objectContaining({
        _id: "171717171717171717171717",
        targetTop: 108.09353999999999,
        targetBottom: 90.07795,
        units: "mg/dl",
      }),
    ]);
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

  it("serves the enabled uploader-battery property from bounded device status", async () => {
    const name = tenant("v2-upbat");
    const now = Date.now();
    await env.ENTRY_STORE.getByName(name).createDocuments(
      "devicestatus",
      JSON.stringify([{
        device: "simulator://uploader",
        created_at: new Date(now).toISOString(),
        uploader: { battery: 20 },
      }]),
    );

    const response = await SELF.fetch(endpoint("/api/v2/properties/upbat,rawbg", name));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      upbat: expect.objectContaining({
        display: "20%",
        status: "urgent",
        min: expect.objectContaining({ value: 20, level: 25 }),
      }),
    });
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
