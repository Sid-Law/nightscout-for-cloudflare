import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const TEST_API_SECRET = "nscf-test-secret-20260717";
const OBJECT_ID = /^[0-9a-f]{24}$/;

type Collection = "devicestatus" | "entries" | "treatments";
type JsonObject = Record<string, unknown>;

function tenant(prefix: string): string {
  return prefix + "-" + crypto.randomUUID().slice(0, 8);
}

function endpoint(path: string, tenantName: string): string {
  return "https://example.test" + path + (path.includes("?") ? "&" : "?")
    + "tenant=" + tenantName;
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

async function authorized(
  tenantName: string,
  path: string,
  method: "DELETE" | "POST" | "PUT",
  payload?: unknown,
): Promise<Response> {
  const headers = new Headers({
    "api-secret": await secretDigest(),
    Accept: "application/json",
  });
  const init: RequestInit = { method, headers };
  if (payload !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(payload);
  }
  return SELF.fetch(endpoint(path, tenantName), init);
}

async function post(
  tenantName: string,
  collection: Collection,
  payload: unknown,
): Promise<JsonObject[]> {
  const response = await authorized(
    tenantName,
    "/api/v1/" + collection + "/",
    "POST",
    payload,
  );
  expect(response.status).toBe(200);
  return response.json<JsonObject[]>();
}

async function putTreatment(
  tenantName: string,
  payload: JsonObject,
): Promise<JsonObject> {
  const response = await authorized(
    tenantName,
    "/api/v1/treatments/",
    "PUT",
    payload,
  );
  expect(response.status).toBe(200);
  return response.json<JsonObject>();
}

async function deleteTreatment(
  tenantName: string,
  id: string,
): Promise<JsonObject> {
  const response = await authorized(
    tenantName,
    "/api/v1/treatments/" + encodeURIComponent(id),
    "DELETE",
  );
  expect(response.status).toBe(200);
  return response.json<JsonObject>();
}

async function list(
  tenantName: string,
  collection: Collection,
): Promise<JsonObject[]> {
  const response = await SELF.fetch(endpoint(
    "/api/v1/" + collection + ".json?count=100",
    tenantName,
  ));
  expect(response.status).toBe(200);
  return response.json<JsonObject[]>();
}

function iso(offsetMs = 0): string {
  return new Date(Date.now() - 60_000 + offsetMs).toISOString();
}

function matching(
  documents: JsonObject[],
  field: string,
  value: unknown,
): JsonObject[] {
  return documents.filter((document) => document[field] === value);
}

function override(
  id: string,
  reason: string,
  extra: JsonObject = {},
): JsonObject {
  return {
    _id: id,
    eventType: "Temporary Override",
    created_at: iso(),
    enteredBy: "Loop",
    duration: 60,
    correctionRange: [90, 110],
    insulinNeedsScaleFactor: 1.2,
    reason,
    ...extra,
  };
}

function loopTreatment(
  eventType: string,
  syncIdentifier: string,
  extra: JsonObject = {},
): JsonObject {
  return {
    eventType,
    created_at: iso(),
    enteredBy: "loop://iPhone",
    syncIdentifier,
    ...extra,
  };
}

function sgv(
  date: number,
  value: number,
  extra: JsonObject = {},
): JsonObject {
  return {
    type: "sgv",
    sgv: value,
    date,
    dateString: new Date(date).toISOString(),
    direction: "Flat",
    ...extra,
  };
}

function deviceStatus(extra: JsonObject): JsonObject {
  return {
    device: "loop://iPhone",
    created_at: iso(),
    ...extra,
  };
}

describe("locked GAP-TREAT-012 Loop override UUID contract", () => {
  it("accepts UUID _id and promotes to identifier field", async () => {
    const name = tenant("gap-uuid-promote");
    const id = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";
    const [created] = await post(name, "treatments", [
      override(id, "Custom Override"),
    ]);
    expect(created).toMatchObject({
      identifier: id,
      eventType: "Temporary Override",
      reason: "Custom Override",
    });
    expect(created?._id).toMatch(OBJECT_ID);
    expect(created?._id).not.toBe(id);
  });

  it("indefinite override UUID is preserved in identifier", async () => {
    const name = tenant("gap-indefinite");
    const id = "B2C3D4E5-F6A7-8901-BCDE-F23456789012";
    const [created] = await post(name, "treatments", [
      override(id, "Running Low", { durationType: "indefinite" }),
    ]);
    expect(created).toMatchObject({ identifier: id, durationType: "indefinite" });
    expect(created?._id).toMatch(OBJECT_ID);
  });

  it("remote command override UUID is preserved in identifier", async () => {
    const name = tenant("gap-remote");
    const id = "C3D4E5F6-A7B8-9012-CDEF-345678901234";
    const [created] = await post(name, "treatments", [
      override(id, "Workout", { enteredBy: "Loop (via remote command)" }),
    ]);
    expect(created).toMatchObject({
      identifier: id,
      enteredBy: "Loop (via remote command)",
    });
  });

  it("can delete override using identifier query", async () => {
    const name = tenant("gap-delete");
    const id = "F6A7B8C9-D0E1-2345-FABC-678901234567";
    const [created] = await post(name, "treatments", [
      override(id, "To Be Deleted"),
    ]);
    const result = await deleteTreatment(name, String(created?._id));
    expect(result).toEqual({ acknowledged: true, deletedCount: 1 });
    expect(matching(await list(name, "treatments"), "identifier", id)).toEqual([]);
  });

  it("can find override by identifier after creation", async () => {
    const name = tenant("gap-find");
    const id = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";
    await post(name, "treatments", [override(id, "Find Me")]);
    expect(matching(await list(name, "treatments"), "identifier", id)).toMatchObject([
      { identifier: id, reason: "Find Me" },
    ]);
  });

  it("PUT with UUID _id updates existing override", async () => {
    const name = tenant("gap-put");
    const id = "E5F6A7B8-C9D0-1234-EFAB-567890123456";
    const [original] = await post(name, "treatments", [
      override(id, "Original Override", { created_at: iso(-3_000) }),
    ]);
    const updated = await putTreatment(name, override(id, "Updated Override", {
      created_at: iso(3_000),
      duration: 120,
      correctionRange: [110, 130],
      insulinNeedsScaleFactor: 0.8,
    }));
    expect(updated).toMatchObject({
      _id: original?._id,
      identifier: id,
      duration: 120,
      reason: "Updated Override",
    });
    expect(matching(await list(name, "treatments"), "identifier", id)).toHaveLength(1);
  });

  it("re-POST same UUID updates instead of creating duplicate", async () => {
    const name = tenant("gap-repost");
    const id = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
    const [first] = await post(name, "treatments", [
      override(id, "Original Post", { created_at: iso(-2_000) }),
    ]);
    const [repost] = await post(name, "treatments", [
      override(id, "Reposted Override", { created_at: iso(2_000), duration: 90 }),
    ]);
    expect(repost?._id).toBe(first?._id);
    expect(matching(await list(name, "treatments"), "identifier", id)).toMatchObject([
      { _id: first?._id, duration: 90, reason: "Reposted Override" },
    ]);
  });

  it("batch of overrides with UUIDs all get identifier fields", async () => {
    const name = tenant("gap-batch");
    const ids = [
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
      "33333333-3333-3333-3333-333333333333",
    ];
    const created = await post(
      name,
      "treatments",
      ids.map((id, index) => override(id, "Override " + index, {
        created_at: iso(index * 1_000),
      })),
    );
    expect(created.map((document) => document.identifier)).toEqual(ids);
    expect(created.every((document) => OBJECT_ID.test(String(document._id)))).toBe(true);
    expect(await list(name, "treatments")).toHaveLength(3);
  });

  it("mixed batch with UUID and non-UUID treatments", async () => {
    const name = tenant("gap-mixed");
    const id = "UUID1234-5678-90AB-CDEF-111111111111";
    const created = await post(name, "treatments", [
      override(id, "Override With UUID", { created_at: iso(0) }),
      loopTreatment("Carb Correction", "mixed-carb", {
        carbs: 15,
        absorptionTime: 180,
        created_at: iso(1_000),
      }),
      loopTreatment("Bolus", "mixed-bolus", {
        insulin: 2.5,
        created_at: iso(2_000),
      }),
    ]);
    expect(created).toHaveLength(3);
    expect(created[0]).toMatchObject({ identifier: id, eventType: "Temporary Override" });
    expect(created.map((document) => document.eventType)).toEqual([
      "Temporary Override",
      "Carb Correction",
      "Bolus",
    ]);
    expect(created.every((document) => OBJECT_ID.test(String(document._id)))).toBe(true);
  });

  it("handles uppercase UUID", async () => {
    const name = tenant("gap-upper");
    const id = "ABCDEF01-2345-6789-ABCD-EF0123456789";
    const [created] = await post(name, "treatments", [
      override(id, "Uppercase UUID Test"),
    ]);
    expect(created?.identifier).toBe(id);
  });

  it("handles lowercase UUID", async () => {
    const name = tenant("gap-lower");
    const id = "abcdef01-2345-6789-abcd-ef0123456789";
    const [created] = await post(name, "treatments", [
      override(id, "Lowercase UUID Test"),
    ]);
    expect(created?.identifier).toBe(id);
  });

  it("valid ObjectId string is NOT promoted to identifier", async () => {
    const name = tenant("gap-objectid");
    const id = "507f1f77bcf86cd799439011";
    const [created] = await post(name, "treatments", [{
      _id: id,
      eventType: "Note",
      created_at: iso(),
      enteredBy: "Test",
      notes: "ObjectId format test",
    }]);
    expect(created?._id).toBe(id);
    expect(created).not.toHaveProperty("identifier");
  });
});

describe("locked Loop carb and dose upload contract", () => {
  it("creates carb with syncIdentifier, absorptionTime preserved", async () => {
    const name = tenant("loop-carb");
    const syncIdentifier = "loop-carb-" + crypto.randomUUID();
    const [created] = await post(name, "treatments", [
      loopTreatment("Carb Correction", syncIdentifier, {
        carbs: 25,
        absorptionTime: 180,
      }),
    ]);
    expect(created).toMatchObject({ syncIdentifier, carbs: 25, absorptionTime: 180 });
    expect(created?._id).toMatch(OBJECT_ID);
  });

  it("creates carb with fat and protein (Warsaw method)", async () => {
    const name = tenant("loop-fpu");
    const [created] = await post(name, "treatments", [
      loopTreatment("Carb Correction", "loop-fpu-" + crypto.randomUUID(), {
        carbs: 30,
        fat: 15,
        protein: 20,
        absorptionTime: 240,
      }),
    ]);
    expect(created).toMatchObject({ carbs: 30, fat: 15, protein: 20 });
  });

  it("POST with both id and syncIdentifier (cache rebuild scenario)", async () => {
    const name = tenant("loop-cache-rebuild");
    const syncIdentifier = "loop-carb-cached-" + crypto.randomUUID();
    const id = "507f1f77bcf86cd799439020";
    const [created] = await post(name, "treatments", [{
      ...loopTreatment("Carb Correction", syncIdentifier, {
        carbs: 20,
        absorptionTime: 180,
      }),
      _id: id,
    }]);
    expect(created).toMatchObject({ _id: id, syncIdentifier });
    expect(created?._id).toMatch(OBJECT_ID);
  });

  it("PUT with cached _id updates carb values", async () => {
    const name = tenant("loop-carb-put");
    const syncIdentifier = "loop-carb-update-" + crypto.randomUUID();
    const [created] = await post(name, "treatments", [
      loopTreatment("Carb Correction", syncIdentifier, {
        carbs: 25,
        absorptionTime: 180,
      }),
    ]);
    await putTreatment(name, {
      ...loopTreatment("Carb Correction", syncIdentifier, {
        carbs: 35,
        absorptionTime: 240,
        created_at: iso(2_000),
      }),
      _id: created?._id,
    });
    expect(matching(await list(name, "treatments"), "syncIdentifier", syncIdentifier))
      .toMatchObject([{ _id: created?._id, carbs: 35, absorptionTime: 240 }]);
  });

  it("DELETE with cached _id removes carb", async () => {
    const name = tenant("loop-carb-delete");
    const syncIdentifier = "loop-carb-delete-" + crypto.randomUUID();
    const [created] = await post(name, "treatments", [
      loopTreatment("Carb Correction", syncIdentifier, { carbs: 15 }),
    ]);
    expect(await deleteTreatment(name, String(created?._id)))
      .toEqual({ acknowledged: true, deletedCount: 1 });
    expect(matching(await list(name, "treatments"), "syncIdentifier", syncIdentifier))
      .toEqual([]);
  });

  it("creates bolus with syncIdentifier and insulin", async () => {
    const name = tenant("loop-bolus");
    const syncIdentifier = "loop-bolus-" + crypto.randomUUID();
    const [created] = await post(name, "treatments", [
      loopTreatment("Bolus", syncIdentifier, { insulin: 2.5 }),
    ]);
    expect(created).toMatchObject({
      eventType: "Bolus",
      syncIdentifier,
      insulin: 2.5,
    });
    expect(created?._id).toMatch(OBJECT_ID);
  });

  it("creates meal bolus with carbs and insulin", async () => {
    const name = tenant("loop-meal-bolus");
    const [created] = await post(name, "treatments", [
      loopTreatment("Meal Bolus", "loop-meal-" + crypto.randomUUID(), {
        insulin: 5,
        carbs: 45,
      }),
    ]);
    expect(created).toMatchObject({ eventType: "Meal Bolus", insulin: 5, carbs: 45 });
  });

  it("creates temp basal with rate and duration", async () => {
    const name = tenant("loop-temp-basal");
    const syncIdentifier = "loop-temp-" + crypto.randomUUID();
    const [created] = await post(name, "treatments", [
      loopTreatment("Temp Basal", syncIdentifier, {
        rate: 1.5,
        absolute: 1.5,
        duration: 30,
      }),
    ]);
    expect(created).toMatchObject({ syncIdentifier, rate: 1.5, duration: 30 });
    expect(created?._id).toMatch(OBJECT_ID);
  });

  it("creates suspend (zero rate temp basal)", async () => {
    const name = tenant("loop-suspend");
    const [created] = await post(name, "treatments", [
      loopTreatment("Temp Basal", "loop-suspend-" + crypto.randomUUID(), {
        rate: 0,
        absolute: 0,
        duration: 30,
      }),
    ]);
    expect(created?.rate).toBe(0);
  });

  it("PUT bolus with cached _id updates insulin", async () => {
    const name = tenant("loop-bolus-put");
    const syncIdentifier = "loop-bolus-update-" + crypto.randomUUID();
    const [created] = await post(name, "treatments", [
      loopTreatment("Bolus", syncIdentifier, { insulin: 2 }),
    ]);
    const updated = await putTreatment(name, {
      ...loopTreatment("Bolus", syncIdentifier, {
        insulin: 2.5,
        created_at: iso(2_000),
      }),
      _id: created?._id,
    });
    expect(updated).toMatchObject({ _id: created?._id, insulin: 2.5 });
    expect(matching(await list(name, "treatments"), "syncIdentifier", syncIdentifier))
      .toHaveLength(1);
  });

  it("hex-encoded pump event ID preserved as syncIdentifier", async () => {
    const name = tenant("loop-hex");
    const syncIdentifier = "deadbeef0123456789abcdef01234567";
    const [created] = await post(name, "treatments", [
      loopTreatment("Bolus", syncIdentifier, { insulin: 1 }),
    ]);
    expect(created?.syncIdentifier).toBe(syncIdentifier);
    expect(created?._id).toMatch(OBJECT_ID);
    expect(created?._id).not.toBe(syncIdentifier);
  });

  it("short hex string also preserved", async () => {
    const name = tenant("loop-short-hex");
    const syncIdentifier = "aabbccdd";
    const [created] = await post(name, "treatments", [
      loopTreatment("Temp Basal", syncIdentifier, { rate: 0.5, duration: 30 }),
    ]);
    expect(created?.syncIdentifier).toBe(syncIdentifier);
  });

  it("batch with bolus and temp basals maintains order", async () => {
    const name = tenant("loop-dose-batch");
    const syncIdentifiers = ["batch-bolus", "batch-tb1", "batch-tb2"]
      .map((prefix) => prefix + "-" + crypto.randomUUID());
    const created = await post(name, "treatments", [
      loopTreatment("Bolus", syncIdentifiers[0]!, {
        insulin: 2,
        created_at: iso(0),
      }),
      loopTreatment("Temp Basal", syncIdentifiers[1]!, {
        rate: 1.2,
        duration: 30,
        created_at: iso(1_000),
      }),
      loopTreatment("Temp Basal", syncIdentifiers[2]!, {
        rate: 0.8,
        duration: 30,
        created_at: iso(2_000),
      }),
    ]);
    expect(created.map((document) => document.syncIdentifier)).toEqual(syncIdentifiers);
    expect(created.map((document) => document.eventType)).toEqual([
      "Bolus",
      "Temp Basal",
      "Temp Basal",
    ]);
  });
});

describe("locked Loop ObjectIdCache workflow contract", () => {
  it("simulates full Loop carb workflow: POST, cache, PUT", async () => {
    const name = tenant("cache-carb");
    const syncIdentifier = "loop-carb-sync-" + crypto.randomUUID();
    const [created] = await post(name, "treatments", [
      loopTreatment("Carb Correction", syncIdentifier, {
        carbs: 25,
        absorptionTime: 180,
      }),
    ]);
    const serverId = String(created?._id);
    expect(serverId).toMatch(OBJECT_ID);
    expect(created?.syncIdentifier).toBe(syncIdentifier);
    await putTreatment(name, {
      ...loopTreatment("Carb Correction", syncIdentifier, {
        carbs: 30,
        absorptionTime: 240,
        created_at: iso(2_000),
      }),
      _id: serverId,
    });
    expect(matching(await list(name, "treatments"), "syncIdentifier", syncIdentifier))
      .toMatchObject([{ _id: serverId, carbs: 30, absorptionTime: 240 }]);
  });

  it("simulates Loop dose workflow: POST, cache, DELETE", async () => {
    const name = tenant("cache-dose");
    const syncIdentifier = "loop-dose-sync-" + crypto.randomUUID();
    const [created] = await post(name, "treatments", [
      loopTreatment("Bolus", syncIdentifier, { insulin: 2.5 }),
    ]);
    expect(await deleteTreatment(name, String(created?._id)))
      .toEqual({ acknowledged: true, deletedCount: 1 });
    expect(matching(await list(name, "treatments"), "syncIdentifier", syncIdentifier))
      .toEqual([]);
  });

  it("re-POST same syncIdentifier after cache miss CREATES duplicate (no server-side dedup)", async () => {
    const name = tenant("cache-miss");
    const syncIdentifier = "loop-cache-miss-" + crypto.randomUUID();
    const [first] = await post(name, "treatments", [
      loopTreatment("Carb Correction", syncIdentifier, {
        carbs: 20,
        absorptionTime: 180,
        created_at: iso(0),
      }),
    ]);
    const [repost] = await post(name, "treatments", [
      loopTreatment("Carb Correction", syncIdentifier, {
        carbs: 20,
        absorptionTime: 180,
        created_at: iso(2_000),
      }),
    ]);
    expect(repost?._id).not.toBe(first?._id);
    expect(matching(await list(name, "treatments"), "syncIdentifier", syncIdentifier))
      .toHaveLength(2);
  });

  it("simulates app restart: re-POST same syncIdentifiers creates duplicates (no server dedup)", async () => {
    const name = tenant("cache-restart");
    const syncIdentifiers = [0, 1, 2]
      .map((index) => "loop-restart-" + index + "-" + crypto.randomUUID());
    const batch = (offsetMs: number) => syncIdentifiers.map((syncIdentifier, index) =>
      loopTreatment("Carb Correction", syncIdentifier, {
        carbs: 10 + index * 5,
        absorptionTime: 180,
        created_at: iso(index * 2_000 + offsetMs),
      }));
    const first = await post(name, "treatments", batch(0));
    const repost = await post(name, "treatments", batch(1_000));
    expect(new Set([...first, ...repost].map((document) => document._id)).size).toBe(6);
    const stored = await list(name, "treatments");
    expect(stored).toHaveLength(6);
    for (const syncIdentifier of syncIdentifiers) {
      expect(matching(stored, "syncIdentifier", syncIdentifier)).toHaveLength(2);
    }
  });

  it("batch response maintains order for correct syncIdentifier -> _id mapping", async () => {
    const name = tenant("cache-order");
    const syncIdentifiers = ["carb", "bolus", "basal"]
      .map((kind) => "loop-order-" + kind + "-" + crypto.randomUUID());
    const created = await post(name, "treatments", [
      loopTreatment("Carb Correction", syncIdentifiers[0]!, {
        carbs: 15,
        created_at: iso(0),
      }),
      loopTreatment("Bolus", syncIdentifiers[1]!, {
        insulin: 1.5,
        created_at: iso(1_000),
      }),
      loopTreatment("Temp Basal", syncIdentifiers[2]!, {
        rate: 0.8,
        duration: 30,
        created_at: iso(2_000),
      }),
    ]);
    expect(created.map((document) => document.syncIdentifier)).toEqual(syncIdentifiers);
    expect(created.every((document) => OBJECT_ID.test(String(document._id)))).toBe(true);
    expect(new Set(created.map((document) => document._id)).size).toBe(3);
  });

  it("temp basal with syncIdentifier follows cache workflow", async () => {
    const name = tenant("cache-temp-basal");
    const syncIdentifier = "loop-temp-cache-" + crypto.randomUUID();
    const [created] = await post(name, "treatments", [
      loopTreatment("Temp Basal", syncIdentifier, {
        duration: 30,
        rate: 1.5,
        absolute: 1.5,
      }),
    ]);
    const updated = await putTreatment(name, {
      ...loopTreatment("Temp Basal", syncIdentifier, {
        duration: 30,
        rate: 0.5,
        absolute: 0.5,
        created_at: iso(2_000),
      }),
      _id: created?._id,
    });
    expect(updated).toMatchObject({ _id: created?._id, rate: 0.5 });
    expect(matching(await list(name, "treatments"), "syncIdentifier", syncIdentifier))
      .toHaveLength(1);
  });

  it("hex string syncIdentifier (from pump events) is preserved", async () => {
    const name = tenant("cache-pump-hex");
    const syncIdentifier = "deadbeef0123456789abcdef";
    const [created] = await post(name, "treatments", [
      loopTreatment("Bolus", syncIdentifier, { insulin: 1 }),
    ]);
    expect(created?.syncIdentifier).toBe(syncIdentifier);
    expect(created?._id).toMatch(OBJECT_ID);
    expect(created?._id).not.toBe(syncIdentifier);
  });
});

describe("locked Loop SGV and deviceStatus upload contract", () => {
  it("creates SGV with required fields", async () => {
    const name = tenant("loop-sgv");
    const at = Date.now() - 60_000;
    const [created] = await post(name, "entries", [sgv(at, 120)]);
    expect(created).toMatchObject({ sgv: 120, direction: "Flat" });
    expect(created?._id).toMatch(OBJECT_ID);
  });

  it("handles all direction values", async () => {
    const name = tenant("loop-directions");
    const directions = [
      "DoubleUp",
      "SingleUp",
      "FortyFiveUp",
      "Flat",
      "FortyFiveDown",
      "SingleDown",
      "DoubleDown",
      "NOT COMPUTABLE",
    ];
    const at = Date.now() - directions.length * 300_000;
    const created = await post(
      name,
      "entries",
      directions.map((direction, index) =>
        sgv(at + index * 300_000, 100 + index * 10, { direction })),
    );
    expect(created.map((document) => document.direction)).toEqual(directions);
  });

  it("preserves Loop device identifier", async () => {
    const name = tenant("loop-sgv-device");
    const [created] = await post(name, "entries", [
      sgv(Date.now() - 60_000, 115, {
        direction: "FortyFiveUp",
        device: "loop://iPhone",
      }),
    ]);
    expect(created?.device).toBe("loop://iPhone");
  });

  it("preserves Dexcom device identifier", async () => {
    const name = tenant("dexcom-sgv-device");
    const [created] = await post(name, "entries", [
      sgv(Date.now() - 60_000, 125, {
        device: "share2",
        filtered: 150_000,
        unfiltered: 155_000,
        noise: 1,
      }),
    ]);
    expect(created).toMatchObject({
      device: "share2",
      filtered: 150_000,
      unfiltered: 155_000,
      noise: 1,
    });
  });

  it("duplicate date+device does not create second entry", async () => {
    const name = tenant("loop-sgv-dedupe");
    const at = Date.now() - 60_000;
    const [first] = await post(name, "entries", [
      sgv(at, 120, { device: "loop://iPhone" }),
    ]);
    await post(name, "entries", [
      sgv(at, 125, {
        direction: "FortyFiveUp",
        device: "loop://iPhone",
      }),
    ]);
    expect(await list(name, "entries")).toMatchObject([
      { _id: first?._id, sgv: 125, direction: "FortyFiveUp" },
    ]);
  });

  it("different devices create separate entries", async () => {
    const name = tenant("loop-sgv-distinct");
    const at = Date.now() - 60_000;
    await post(name, "entries", [
      sgv(at, 120, { device: "loop://iPhone" }),
    ]);
    const [second] = await post(name, "entries", [
      sgv(at + 1, 122, { device: "xDrip+" }),
    ]);
    expect(second?.device).toBe("xDrip+");
    expect(await list(name, "entries")).toHaveLength(2);
  });

  it("creates manual BG check entry", async () => {
    const name = tenant("loop-mbg");
    const at = Date.now() - 60_000;
    const [created] = await post(name, "entries", [{
      type: "mbg",
      mbg: 110,
      date: at,
      dateString: new Date(at).toISOString(),
      device: "loop://iPhone",
    }]);
    expect(created).toMatchObject({ type: "mbg", mbg: 110 });
  });

  it("creates deviceStatus with loop IOB and COB", async () => {
    const name = tenant("loop-ds-iob-cob");
    const timestamp = iso();
    const [created] = await post(name, "devicestatus", [
      deviceStatus({
        loop: {
          version: "3.0.0",
          timestamp,
          iob: { iob: 2.5, timestamp },
          cob: { cob: 15, timestamp },
        },
      }),
    ]);
    expect(created).toMatchObject({
      loop: { iob: { iob: 2.5 }, cob: { cob: 15 } },
    });
  });

  it("creates deviceStatus with prediction values array", async () => {
    const name = tenant("loop-ds-predicted");
    const predictions = [120, 118, 115, 112, 110, 108, 105, 102, 100];
    const [created] = await post(name, "devicestatus", [
      deviceStatus({
        loop: {
          version: "3.0.0",
          timestamp: iso(),
          predicted: { startDate: iso(), values: predictions },
        },
      }),
    ]);
    expect((created?.loop as JsonObject).predicted).toMatchObject({
      values: predictions,
    });
  });

  it("creates deviceStatus with enacted temp basal", async () => {
    const name = tenant("loop-ds-enacted");
    const [created] = await post(name, "devicestatus", [
      deviceStatus({
        loop: {
          version: "3.0.0",
          timestamp: iso(),
          enacted: {
            timestamp: iso(),
            rate: 1.5,
            duration: 30,
            received: true,
          },
        },
      }),
    ]);
    expect((created?.loop as JsonObject).enacted).toMatchObject({
      rate: 1.5,
      duration: 30,
      received: true,
    });
  });

  it("creates deviceStatus with pump reservoir and battery", async () => {
    const name = tenant("loop-ds-pump");
    const [created] = await post(name, "devicestatus", [
      deviceStatus({
        pump: {
          clock: iso(),
          reservoir: 150.5,
          battery: { percent: 75 },
          status: { status: "normal", timestamp: iso() },
        },
      }),
    ]);
    expect(created?.pump).toMatchObject({
      reservoir: 150.5,
      battery: { percent: 75 },
    });
  });

  it("handles Omnipod specific fields", async () => {
    const name = tenant("loop-ds-omnipod");
    const [created] = await post(name, "devicestatus", [
      deviceStatus({
        pump: {
          clock: iso(),
          reservoir: 50,
          reservoir_display_override: "50+ U",
          pumpID: "pod-12345",
          manufacturer: "Insulet",
          model: "Eros",
        },
      }),
    ]);
    expect(created?.pump).toMatchObject({
      reservoir_display_override: "50+ U",
      pumpID: "pod-12345",
      manufacturer: "Insulet",
      model: "Eros",
    });
  });

  it("creates deviceStatus with active override", async () => {
    const name = tenant("loop-ds-override");
    const [created] = await post(name, "devicestatus", [
      deviceStatus({
        loop: {
          version: "3.0.0",
          timestamp: iso(),
          override: {
            active: true,
            timestamp: iso(),
            name: "Pre-Meal",
            currentCorrectionRange: { minValue: 80, maxValue: 80 },
            multiplier: 1,
          },
        },
      }),
    ]);
    expect((created?.loop as JsonObject).override).toMatchObject({
      active: true,
      name: "Pre-Meal",
      currentCorrectionRange: { minValue: 80, maxValue: 80 },
    });
  });

  it("handles override with insulinNeedsScaleFactor", async () => {
    const name = tenant("loop-ds-override-factor");
    const [created] = await post(name, "devicestatus", [
      deviceStatus({
        loop: {
          version: "3.0.0",
          timestamp: iso(),
          override: {
            active: true,
            timestamp: iso(),
            name: "Workout",
            currentCorrectionRange: { minValue: 140, maxValue: 160 },
            multiplier: 0.5,
          },
        },
      }),
    ]);
    expect((created?.loop as JsonObject).override).toMatchObject({
      multiplier: 0.5,
    });
  });

  it("creates complete Loop deviceStatus with all fields", async () => {
    const name = tenant("loop-ds-complete");
    const timestamp = iso();
    const [created] = await post(name, "devicestatus", [
      deviceStatus({
        uploaderBattery: 85,
        loop: {
          version: "3.0.0",
          timestamp,
          name: "Loop",
          iob: { iob: 2.5, timestamp },
          cob: { cob: 15, timestamp },
          predicted: { startDate: timestamp, values: [120, 118, 115, 112, 110] },
          enacted: { timestamp, rate: 1.2, duration: 30, received: true },
          recommendedBolus: 0,
          failureReason: null,
        },
        pump: {
          clock: timestamp,
          reservoir: 150,
          battery: { percent: 75 },
        },
        uploader: { battery: 85 },
      }),
    ]);
    expect(created).toMatchObject({
      uploaderBattery: 85,
      loop: {
        iob: { iob: 2.5 },
        cob: { cob: 15 },
        predicted: { values: [120, 118, 115, 112, 110] },
        enacted: { rate: 1.2, duration: 30, received: true },
      },
      pump: { reservoir: 150, battery: { percent: 75 } },
      uploader: { battery: 85 },
    });
  });
});
