import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  findInvalidLegacyObjectId,
  isValidLegacyObjectId,
} from "../src/documents";

const TEST_API_SECRET = "nscf-test-secret-20260717";

type JsonObject = Record<string, unknown>;

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

async function secretDigest(): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(TEST_API_SECRET),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function endpoint(path: string, tenantName: string): string {
  return `https://example.test${path}${path.includes("?") ? "&" : "?"}tenant=${tenantName}`;
}

async function write(
  tenantName: string,
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  contentType = "application/json",
): Promise<Response> {
  const headers = new Headers({ "api-secret": await secretDigest() });
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers.set("Content-Type", contentType);
    init.body = contentType === "application/json" ? JSON.stringify(body) : String(body);
  }
  return SELF.fetch(endpoint(path, tenantName), init);
}

function profile(marker: string, startDate: string): JsonObject {
  return {
    defaultProfile: `Default-${marker}`,
    startDate,
    mills: Date.parse(startDate),
    units: "mg/dl",
    enteredBy: "Loop",
    loopSettings: {
      dosingEnabled: true,
      overridePresets: [{ name: "Exercise", duration: 3600 }],
    },
    store: {
      Default: {
        dia: 6,
        timezone: "UTC",
        basal: [{ time: "00:00", timeAsSeconds: 0, value: 0.8 }],
        sens: [{ time: "00:00", timeAsSeconds: 0, value: 45 }],
        carbratio: [{ time: "00:00", timeAsSeconds: 0, value: 10 }],
        target_low: [{ time: "00:00", timeAsSeconds: 0, value: 90 }],
        target_high: [{ time: "00:00", timeAsSeconds: 0, value: 110 }],
        units: "mg/dl",
      },
    },
  };
}

async function expectLegacyIdError(response: Response, id: string): Promise<void> {
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    status: 400,
    message: "Invalid _id format",
    description: expect.stringContaining(id),
  });
}

describe("locked legacy ObjectId validation", () => {
  it("matches the complete upstream objectid-validation helper contract", () => {
    expect(isValidLegacyObjectId(undefined)).toBe(true);
    expect(isValidLegacyObjectId(null)).toBe(true);
    expect(isValidLegacyObjectId("507f1f77bcf86cd799439011")).toBe(true);
    expect(isValidLegacyObjectId("550e8400-e29b-41d4-a716-446655440000")).toBe(false);
    expect(isValidLegacyObjectId("abc")).toBe(false);
    expect(isValidLegacyObjectId(123)).toBe(false);

    expect(findInvalidLegacyObjectId([
      {},
      { _id: "0123456789abcdefabcdef01" },
      { _id: "bad-uuid" },
      { _id: "also-bad" },
    ])).toEqual({ index: 2, id: "bad-uuid" });
    expect(findInvalidLegacyObjectId([
      {},
      { _id: null },
      { _id: "0123456789abcdefabcdef01" },
    ])).toBeNull();
  });
});

describe("locked v1/v2 collection upload contracts", () => {
  it("adapts every upstream Activity object, array, empty, query, PUT and DELETE workflow", async () => {
    const name = tenant("v1-activity-file");
    const base = Date.now() - 10 * 60_000;
    const firstResponse = await write(name, "POST", "/api/v1/activity/", {
      created_at: new Date(base).toISOString(),
      heartrate: 85,
      steps: 1500,
      activitylevel: "moderate",
    });
    expect(firstResponse.status).toBe(200);
    const [first] = await firstResponse.json<JsonObject[]>();
    if (first === undefined) throw new Error("Activity create returned no document");
    expect(first).toMatchObject({ heartrate: 85, steps: 1500, activitylevel: "moderate" });
    expect(first?._id).toMatch(/^[0-9a-f]{24}$/);

    const batchResponse = await write(name, "POST", "/api/v1/activity/", [
      { created_at: new Date(base + 1_000).toISOString(), heartrate: 70, steps: 500 },
      { created_at: new Date(base + 2_000).toISOString(), heartrate: 150, steps: 3000 },
    ]);
    expect(batchResponse.status).toBe(200);
    const batch = await batchResponse.json<JsonObject[]>();
    expect(batch).toHaveLength(2);
    expect(batch.map((item) => item.heartrate)).toEqual([70, 150]);

    const putResponse = await write(name, "PUT", "/api/v1/activity/", {
      created_at: new Date(base + 3_000).toISOString(),
      heartrate: 78,
      steps: 750,
    });
    expect(putResponse.status).toBe(200);
    const putCreated = await putResponse.json<JsonObject>();
    expect(putCreated).toMatchObject({ heartrate: 78, steps: 750 });
    expect(putCreated._id).toMatch(/^[0-9a-f]{24}$/);

    const updateResponse = await write(name, "PUT", "/api/v1/activity/", {
      ...first,
      created_at: new Date(base + 4_000).toISOString(),
      heartrate: 92,
    });
    expect(await updateResponse.json()).toMatchObject({ _id: first?._id, heartrate: 92 });

    await expectLegacyIdError(await write(name, "POST", "/api/v1/activity/", {
      _id: "my-uuid-12345",
      created_at: new Date(base + 5_000).toISOString(),
      steps: 1000,
    }), "my-uuid-12345");
    await expectLegacyIdError(await write(name, "PUT", "/api/v1/activity/", {
      _id: "not-valid",
      created_at: new Date(base + 6_000).toISOString(),
      steps: 1000,
    }), "not-valid");
    await expectLegacyIdError(await write(name, "DELETE", "/api/v1/activity/invalid-id"), "invalid-id");

    const listed = await SELF.fetch(endpoint(
      `/api/v1/activity?find[created_at][$gte]=${encodeURIComponent(new Date(base).toISOString())}`,
      name,
    ));
    expect(listed.status).toBe(200);
    expect(listed.headers.get("Last-Modified")).not.toBeNull();
    expect(await listed.json<JsonObject[]>()).toHaveLength(4);

    expect(await (await write(name, "POST", "/api/v1/activity/", [])).json()).toEqual([]);
    for (const document of [...batch, first, putCreated]) {
      expect(await (await write(
        name,
        "DELETE",
        `/api/v1/activity/${String(document._id)}`,
      )).json()).toEqual({});
    }
    expect(await (await SELF.fetch(endpoint("/api/v1/activity", name))).json()).toEqual([]);
  });

  it("adapts every upstream DeviceStatus date, identity, batch and wildcard-delete workflow", async () => {
    const name = tenant("v1-devicestatus-file");
    const created = await write(name, "POST", "/api/v1/devicestatus/", {
      device: "loop://offset-device",
      created_at: "2024-01-02T03:04:05+02:30",
      loop: { iob: { iob: 2.5 }, cob: { cob: 25 } },
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject([{
      _id: expect.stringMatching(/^[0-9a-f]{24}$/),
      device: "loop://offset-device",
      created_at: "2024-01-02T00:34:05.000Z",
      utcOffset: 150,
      loop: { iob: { iob: 2.5 }, cob: { cob: 25 } },
    }]);

    const largeBatch = await write(
      name,
      "POST",
      "/api/v1/devicestatus/",
      Array.from({ length: 10 }, (_, index) => ({
        device: `batch-device-${index}`,
        created_at: new Date(Date.now() + index * 1_000).toISOString(),
        uploaderBattery: 50 + index,
      })),
    );
    expect(largeBatch.status).toBe(200);
    expect(await largeBatch.json<JsonObject[]>()).toHaveLength(10);

    const explicitId = "bbbbbbbbbbbbbbbbbbbbbbbb";
    expect((await write(name, "POST", "/api/v1/devicestatus/", {
      _id: explicitId,
      device: "explicit-id",
      created_at: "2024-01-03T00:00:00Z",
    })).status).toBe(200);
    await expectLegacyIdError(await write(name, "POST", "/api/v1/devicestatus/", {
      _id: "my-uuid-12345",
      device: "invalid-single",
    }), "my-uuid-12345");
    await expectLegacyIdError(await write(name, "POST", "/api/v1/devicestatus/", {
      _id: "abc",
      device: "invalid-short",
    }), "abc");
    await expectLegacyIdError(await write(name, "DELETE", "/api/v1/devicestatus/invalid-uuid-here"), "invalid-uuid-here");

    const invalidBatch = await write(name, "POST", "/api/v1/devicestatus/", [
      { device: "must-not-partially-write", created_at: "2024-01-04T00:00:00Z" },
      { _id: "bad-uuid", device: "invalid-batch", created_at: "2024-01-05T00:00:00Z" },
    ]);
    await expectLegacyIdError(invalidBatch, "bad-uuid");
    expect(await (await SELF.fetch(endpoint(
      "/api/v1/devicestatus?find[device]=must-not-partially-write",
      name,
    ))).json()).toEqual([]);

    expect(await (await write(name, "POST", "/api/v1/devicestatus/", [])).json()).toEqual([]);
    const emptyObject = await write(name, "POST", "/api/v1/devicestatus/", {});
    expect(emptyObject.status).toBe(200);
    expect(await emptyObject.json()).toMatchObject([{
      _id: expect.stringMatching(/^[0-9a-f]{24}$/),
      created_at: expect.any(String),
      utcOffset: 0,
    }]);

    await write(name, "POST", "/api/v1/devicestatus/", [
      { device: "delete-old", created_at: "2020-01-01T00:00:00Z" },
      { device: "keep-new", created_at: "2030-01-01T00:00:00Z" },
    ]);
    const removed = await write(
      name,
      "DELETE",
      "/api/v1/devicestatus/*?find[created_at][$lte]=2020-01-02T00:00:00Z",
    );
    expect(removed.status).toBe(200);
    expect(await (await SELF.fetch(endpoint(
      "/api/v1/devicestatus?find[device]=delete-old",
      name,
    ))).json()).toEqual([]);
    expect(await (await SELF.fetch(endpoint(
      "/api/v1/devicestatus?find[device]=keep-new",
      name,
    ))).json()).toMatchObject([{ device: "keep-new" }]);
  });

  it("adapts every upstream Food form, object/array, empty, PUT, identity and DELETE workflow", async () => {
    const name = tenant("v1-food-file");
    const form = "type=food&category=snack&subcategory=fast&name=a+food&portion=0&carbs=10&fat=0&protein=0&energy=0&gi=2&unit=g";
    const formResponse = await write(
      name,
      "POST",
      "/api/v1/food/",
      form,
      "application/x-www-form-urlencoded",
    );
    expect(formResponse.status).toBe(200);
    const [formFood] = await formResponse.json<JsonObject[]>();
    expect(formFood).toMatchObject({ name: "a food", carbs: "10" });

    const now = new Date().toISOString();
    const putFormResponse = await write(
      name,
      "PUT",
      "/api/v1/food/",
      form,
      "application/x-www-form-urlencoded",
    );
    expect(putFormResponse.status).toBe(200);
    expect(await putFormResponse.json()).toMatchObject([{
      _id: expect.stringMatching(/^[0-9a-f]{24}$/),
      name: "a food",
    }]);

    const batch = await (await write(name, "POST", "/api/v1/food/", [
      { type: "food", name: "Test Chips", carbs: 15, created_at: now },
      { type: "food", name: "Test Apple", carbs: 20, created_at: now },
    ])).json<JsonObject[]>();
    expect(batch.map((food) => food.name)).toEqual(["Test Chips", "Test Apple"]);
    expect(batch.every((food) => /^[0-9a-f]{24}$/.test(String(food._id)))).toBe(true);

    const putBatchResponse = await write(name, "PUT", "/api/v1/food/", [
      { type: "food", name: "Test Pasta", carbs: 60, created_at: now },
      { type: "food", name: "Test Rice", carbs: 55, created_at: now },
    ]);
    expect(putBatchResponse.status).toBe(200);
    expect((await putBatchResponse.json<JsonObject[]>()).map((food) => food.name)).toEqual([
      "Test Pasta",
      "Test Rice",
    ]);

    const updatedAt = "2024-10-26T21:32:49.173Z";
    const updateResponse = await write(name, "PUT", "/api/v1/food/", {
      ...formFood,
      created_at: updatedAt,
      carbs: 25,
    });
    expect(updateResponse.status).toBe(200);
    expect(await updateResponse.json()).toMatchObject([{
      _id: formFood?._id,
      created_at: updatedAt,
      carbs: 25,
    }]);

    expect(await (await write(name, "POST", "/api/v1/food/", [])).json()).toEqual([]);
    await expectLegacyIdError(await write(name, "POST", "/api/v1/food/", {
      _id: "bad-food-id",
      name: "invalid",
    }), "bad-food-id");
    await expectLegacyIdError(await write(name, "PUT", "/api/v1/food/", {
      _id: "bad-food-put",
      name: "invalid",
    }), "bad-food-put");
    await expectLegacyIdError(await write(name, "DELETE", "/api/v1/food/bad-food-delete"), "bad-food-delete");

    expect(await (await write(name, "DELETE", `/api/v1/food/${String(formFood?._id)}`)).json()).toEqual({});
    const remaining = await (await SELF.fetch(endpoint(
      `/api/v1/food?find[_id]=${String(formFood?._id)}`,
      name,
    ))).json<JsonObject[]>();
    // Locked Food.list() ignores query parameters; verify deletion by ID
    // without accidentally turning this endpoint into the generic query API.
    expect(remaining.some((document) => document._id === formFood?._id)).toBe(false);
    expect(remaining).toHaveLength(5);
  });

  it("preserves raw non-Treatment documents and the locked Food helper queries", async () => {
    const name = tenant("v1-food-helpers");
    const created = await write(name, "POST", "/api/v1/food/", [
      { type: "quickpick", name: "Numeric Ten", hidden: "false", position: 10 },
      { type: "quickpick", name: "Numeric Two", hidden: "false", position: 2 },
      { type: "quickpick", name: "String Ten", hidden: "false", position: "10" },
      { type: "quickpick", name: "String Two", hidden: "false", position: "2" },
      { type: "quickpick", name: "Boolean False", hidden: false, position: 0 },
      { type: "quickpick", name: "Hidden", hidden: "true", position: 1 },
      { type: "food", name: "Rice", carbs: "28" },
      { type: "food", name: "Apple", carbs: 15 },
    ]);
    expect(created.status).toBe(200);

    const quickpicks = await (
      await SELF.fetch(endpoint(
        "/api/v1/food/quickpicks.json?count=1&find[name]=Hidden&sort[position]=-1",
        name,
      ))
    ).json<JsonObject[]>();
    expect(quickpicks.map((document) => document.name)).toEqual([
      "Numeric Two",
      "Numeric Ten",
      "String Ten",
      "String Two",
    ]);
    expect(quickpicks.every((document) => document.hidden === "false")).toBe(true);
    expect(quickpicks.every((document) => !("insulin" in document))).toBe(true);

    const inherited = await (
      await SELF.fetch(endpoint("/api/v2/food/quickpicks.json?count=1", name))
    ).json<JsonObject[]>();
    expect(inherited.map((document) => document.name)).toEqual(
      quickpicks.map((document) => document.name),
    );

    const regular = await (
      await SELF.fetch(endpoint("/api/v1/food/regular.json?count=1", name))
    ).json<JsonObject[]>();
    expect(regular).toHaveLength(2);
    expect(regular).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Rice", carbs: "28" }),
      expect.objectContaining({ name: "Apple", carbs: 15 }),
    ]));
    expect(regular.every((document) => !("insulin" in document))).toBe(true);

    const profileResponse = await write(
      name,
      "POST",
      "/api/v1/profile/",
      profile("raw-fields", new Date().toISOString()),
    );
    expect(profileResponse.status).toBe(200);
    const listedProfiles = await (
      await SELF.fetch(endpoint("/api/v1/profile/?count=10", name))
    ).json<JsonObject[]>();
    expect(listedProfiles).toHaveLength(1);
    expect(listedProfiles[0]).not.toHaveProperty("carbs");
    expect(listedProfiles[0]).not.toHaveProperty("insulin");

    const singularIgnoresFind = await (
      await SELF.fetch(endpoint(
        "/api/v1/profile/?count=10&find[defaultProfile]=does-not-exist",
        name,
      ))
    ).json<JsonObject[]>();
    expect(singularIgnoresFind).toHaveLength(1);
    expect(await (
      await SELF.fetch(endpoint(
        "/api/v1/profiles/?count=10&find[defaultProfile]=does-not-exist",
        name,
      ))
    ).json()).toEqual([]);

    for (const path of [
      "/api/v1/food/not-a-route",
      "/api/v2/profile/not-a-route",
      "/api/v1/profiles/current",
    ]) {
      const response = await SELF.fetch(endpoint(path, name));
      expect(response.status, path).toBe(404);
    }
    const pluralMutation = await write(
      name,
      "POST",
      "/api/v1/profiles/",
      profile("plural-mutation", new Date().toISOString()),
    );
    expect(pluralMutation.status).toBe(404);
  });

  it("adapts every upstream Profile object/array, Loop shape, identity, PUT and DELETE workflow", async () => {
    const name = tenant("v1-profile-file");
    const start = Date.now() - 60_000;
    const singleResponse = await write(
      name,
      "POST",
      "/api/v1/profile/",
      profile("single", new Date(start).toISOString()),
    );
    expect(singleResponse.status).toBe(200);
    const [single] = await singleResponse.json<JsonObject[]>();
    expect(single).toMatchObject({
      _id: expect.stringMatching(/^[0-9a-f]{24}$/),
      loopSettings: { dosingEnabled: true },
    });

    const batchResponse = await write(name, "POST", "/api/v1/profile/", [
      profile("batch-1", new Date(start + 1_000).toISOString()),
      profile("batch-2", new Date(start + 2_000).toISOString()),
      profile("batch-3", new Date(start + 3_000).toISOString()),
    ]);
    expect(batchResponse.status).toBe(200);
    expect(await batchResponse.json<JsonObject[]>()).toHaveLength(3);
    expect(await (await write(name, "POST", "/api/v1/profile/", [])).json()).toEqual([]);

    const explicitId = "aaaaaaaaaaaaaaaaaaaaaaaa";
    const explicit = await write(name, "POST", "/api/v1/profile/", {
      ...profile("explicit", new Date(start + 3_500).toISOString()),
      _id: explicitId,
    });
    expect(explicit.status).toBe(200);
    expect(await explicit.json()).toMatchObject([{ _id: explicitId }]);

    const putFresh = await write(
      name,
      "PUT",
      "/api/v1/profile/",
      profile("put-fresh", new Date(start + 4_000).toISOString()),
    );
    expect(putFresh.status).toBe(200);
    expect(await putFresh.json()).toMatchObject({ _id: expect.stringMatching(/^[0-9a-f]{24}$/) });

    const changedStart = new Date(start + 5_000).toISOString();
    const update = await write(name, "PUT", "/api/v1/profile/", {
      ...single,
      startDate: changedStart,
      created_at: changedStart,
      units: "mmol/L",
    });
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({
      _id: single?._id,
      startDate: changedStart,
      units: "mmol/L",
    });

    for (const invalid of ["my-uuid-12345", "abc"] as const) {
      await expectLegacyIdError(await write(name, "POST", "/api/v1/profile/", {
        ...profile("invalid", new Date(start + 6_000).toISOString()),
        _id: invalid,
      }), invalid);
    }
    await expectLegacyIdError(await write(name, "PUT", "/api/v1/profile/", {
      ...profile("invalid-put", new Date(start + 7_000).toISOString()),
      _id: "not-a-valid-object-id",
    }), "not-a-valid-object-id");
    await expectLegacyIdError(await write(name, "DELETE", "/api/v1/profile/invalid-uuid-here"), "invalid-uuid-here");

    const mixed = await write(name, "POST", "/api/v1/profile/", [
      profile("must-not-partially-write", new Date(start + 8_000).toISOString()),
      {
        ...profile("invalid-batch", new Date(start + 9_000).toISOString()),
        _id: "bad-uuid",
      },
    ]);
    await expectLegacyIdError(mixed, "bad-uuid");
    const profilesAfterRejectedBatch = await (await SELF.fetch(endpoint(
      "/api/v1/profile?find[defaultProfile]=Default-must-not-partially-write",
      name,
    ))).json<JsonObject[]>();
    expect(profilesAfterRejectedBatch.some((document) =>
      document.defaultProfile === "Default-must-not-partially-write"
    )).toBe(false);

    expect(await (await write(name, "DELETE", `/api/v1/profile/${String(single?._id)}`)).json()).toEqual({});
  });

  it("preserves the upstream cross-collection single, batch and empty response shapes", async () => {
    const name = tenant("v1-shape-file");
    const now = Date.now() - 60_000;
    const treatments = Array.from({ length: 10 }, (_, index) => ({
      eventType: index % 2 === 0 ? "Correction Bolus" : "Temp Basal",
      created_at: new Date(now + index * 1_000).toISOString(),
      insulin: index % 2 === 0 ? 1.5 : undefined,
      rate: index % 2 === 0 ? undefined : 1.2,
      duration: index % 2 === 0 ? 0 : 30,
      syncIdentifier: `shape-treatment-${index}`,
    }));
    const treatmentResponse = await write(name, "POST", "/api/v1/treatments/", treatments);
    expect(treatmentResponse.status).toBe(200);
    const treatmentDocuments = await treatmentResponse.json<JsonObject[]>();
    expect(treatmentDocuments).toHaveLength(10);
    expect(treatmentDocuments[0]).toMatchObject({
      eventType: "Correction Bolus",
      insulin: 1.5,
      syncIdentifier: "shape-treatment-0",
    });
    expect(treatmentDocuments[1]).toMatchObject({
      eventType: "Temp Basal",
      rate: 1.2,
      duration: 30,
      syncIdentifier: "shape-treatment-1",
    });
    expect(await (await write(name, "POST", "/api/v1/treatments/", {})).json()).toEqual([
      expect.objectContaining({ _id: expect.stringMatching(/^[0-9a-f]{24}$/) }),
    ]);
    expect(await (await write(name, "POST", "/api/v1/treatments/", [])).json()).toEqual([]);

    const entries = Array.from({ length: 10 }, (_, index) => ({
      type: index === 9 ? "mbg" : "sgv",
      ...(index === 9 ? { mbg: 95 } : { sgv: 100 + index }),
      date: now + index * 300_000,
      dateString: new Date(now + index * 300_000).toISOString(),
      device: "shape-uploader",
    }));
    const entryResponse = await write(name, "POST", "/api/v1/entries/", entries);
    expect(entryResponse.status).toBe(200);
    const entryDocuments = await entryResponse.json<JsonObject[]>();
    expect(entryDocuments).toHaveLength(10);
    expect(entryDocuments[0]).toMatchObject({ type: "sgv", sgv: 100 });
    expect(entryDocuments[9]).toMatchObject({ type: "mbg", mbg: 95 });
    expect(await (await write(name, "POST", "/api/v1/entries/", [])).json()).toEqual([]);
  });
});
