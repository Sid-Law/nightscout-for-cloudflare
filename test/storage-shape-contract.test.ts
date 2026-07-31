import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const TEST_API_SECRET = "nscf-test-secret-20260717";
const OBJECT_ID = /^[0-9a-f]{24}$/;

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

async function post(
  tenantName: string,
  path: string,
  body: unknown,
): Promise<JsonObject[]> {
  const response = await SELF.fetch(`https://example.test${path}?tenant=${tenantName}`, {
    method: "POST",
    headers: {
      "api-secret": await secretDigest(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200);
  return response.json<JsonObject[]>();
}

function profile(marker: string, createdAt?: string): JsonObject {
  const startDate = "2024-10-19T23:00:00.000Z";
  return {
    defaultProfile: `Default-${marker}`,
    store: {
      [`Default-${marker}`]: {
        dia: 3,
        carbratio: [{ time: "00:00", value: 30 }],
        sens: [{ time: "00:00", value: 100 }],
        basal: [{ time: "00:00", value: 0.5 }],
        target_low: [{ time: "00:00", value: 80 }],
        target_high: [{ time: "00:00", value: 120 }],
        units: "mg/dl",
      },
    },
    startDate,
    units: "mg/dl",
    ...(createdAt === undefined ? {} : { created_at: createdAt }),
  };
}

function parseDocuments(value: string): JsonObject[] {
  return JSON.parse(value) as JsonObject[];
}

describe("locked storage.shape-handling adapter contract", () => {
  it("preserves scalar, one-element, multi-element and 20-document create shapes", async () => {
    const name = tenant("storage-shape-create");
    const base = Date.now() - 60_000;

    const treatment = (index: number): JsonObject => ({
      eventType: "Note",
      created_at: new Date(base + index * 1_000).toISOString(),
      notes: `storage treatment ${index}`,
      syncIdentifier: `storage-shape-treatment-${index}`,
    });
    expect(await post(name, "/api/v1/treatments/", treatment(0))).toHaveLength(1);
    expect(await post(name, "/api/v1/treatments/", [treatment(1)])).toHaveLength(1);
    expect(await post(name, "/api/v1/treatments/", [
      treatment(2),
      treatment(3),
      treatment(4),
    ])).toHaveLength(3);
    expect(await post(
      name,
      "/api/v1/treatments/",
      Array.from({ length: 20 }, (_, index) => treatment(index + 10)),
    )).toHaveLength(20);

    const deviceStatus = (index: number): JsonObject => ({
      device: `storage-device-${index}`,
      created_at: new Date(base + index * 1_000).toISOString(),
      uploaderBattery: 50 + index,
    });
    expect(await post(name, "/api/v1/devicestatus/", deviceStatus(0))).toHaveLength(1);
    expect(await post(name, "/api/v1/devicestatus/", [deviceStatus(1)])).toHaveLength(1);
    expect(await post(name, "/api/v1/devicestatus/", [
      deviceStatus(2),
      deviceStatus(3),
      deviceStatus(4),
    ])).toHaveLength(3);
    expect(await post(
      name,
      "/api/v1/devicestatus/",
      Array.from({ length: 20 }, (_, index) => deviceStatus(index + 10)),
    )).toHaveLength(20);

    const entry = (index: number): JsonObject => ({
      type: "sgv",
      sgv: 100 + index,
      date: base + index * 300_000,
      dateString: new Date(base + index * 300_000).toISOString(),
      device: "storage-shape-uploader",
    });
    expect(await post(name, "/api/v1/entries/", [entry(0)])).toHaveLength(1);
    expect(await post(name, "/api/v1/entries/", [entry(1), entry(2), entry(3)]))
      .toHaveLength(3);
  });

  it("preserves Profile create/save identity, replacement and created_at semantics", async () => {
    const stub = env.ENTRY_STORE.getByName(tenant("storage-shape-profile"));
    const created = parseDocuments(await stub.createDocuments(
      "profile",
      JSON.stringify([profile("single")]),
    ));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      _id: expect.stringMatching(OBJECT_ID),
      defaultProfile: "Default-single",
      created_at: expect.any(String),
    });

    const batch = parseDocuments(await stub.createDocuments(
      "profile",
      JSON.stringify([profile("batch-1"), profile("batch-2")]),
    ));
    expect(batch.map((document) => document.defaultProfile)).toEqual([
      "Default-batch-1",
      "Default-batch-2",
    ]);
    expect(parseDocuments(await stub.createDocuments("profile", "[]"))).toEqual([]);

    const originalCreatedAt = "2024-10-26T20:32:49.173Z";
    const [saved] = parseDocuments(await stub.saveDocuments(
      "profile",
      JSON.stringify([profile("saved", originalCreatedAt)]),
    ));
    if (saved === undefined) throw new Error("Profile save returned no document");
    expect(saved).toMatchObject({
      _id: expect.stringMatching(OBJECT_ID),
      created_at: originalCreatedAt,
    });

    const replacementCreatedAt = "2024-10-26T21:32:49.173Z";
    const replacement = {
      ...profile("saved", replacementCreatedAt),
      _id: saved._id,
      units: "mmol/L",
    };
    const [updated] = parseDocuments(await stub.saveDocuments(
      "profile",
      JSON.stringify([replacement]),
    ));
    expect(updated).toMatchObject({
      _id: saved._id,
      units: "mmol/L",
      created_at: replacementCreatedAt,
    });
    const stored = parseDocuments(await stub.listDocuments("profile"));
    expect(stored.filter((document) => document._id === saved._id)).toEqual([
      expect.objectContaining({ units: "mmol/L", created_at: replacementCreatedAt }),
    ]);

    const [missingId] = parseDocuments(await stub.saveDocuments(
      "profile",
      JSON.stringify([profile("missing-id")]),
    ));
    const [invalidId] = parseDocuments(await stub.saveDocuments(
      "profile",
      JSON.stringify([{ ...profile("invalid-id"), _id: "not-a-valid-objectid" }]),
    ));
    expect(missingId?._id).toMatch(OBJECT_ID);
    expect(invalidId?._id).toMatch(OBJECT_ID);
    expect(invalidId?._id).not.toBe("not-a-valid-objectid");
  });

  it("preserves Food and Activity direct-storage create/save shapes", async () => {
    const stub = env.ENTRY_STORE.getByName(tenant("storage-shape-food-activity"));
    const [food] = parseDocuments(await stub.createDocuments("food", JSON.stringify([{
      name: "Test Food",
      category: "Test",
      carbs: 20,
      protein: 10,
      fat: 5,
    }])));
    if (food === undefined) throw new Error("Food create returned no document");
    expect(food).toMatchObject({ _id: expect.stringMatching(OBJECT_ID), name: "Test Food" });
    const foodCreatedAt = "2024-10-26T21:32:49.173Z";
    const [updatedFood] = parseDocuments(await stub.saveDocuments("food", JSON.stringify([{
      ...food,
      name: "Updated Food",
      carbs: 25,
      created_at: foodCreatedAt,
    }])));
    expect(updatedFood).toMatchObject({
      _id: food._id,
      name: "Updated Food",
      carbs: 25,
      created_at: foodCreatedAt,
    });
    expect(parseDocuments(await stub.listDocuments("food")).filter(
      (document) => document._id === food._id,
    )).toHaveLength(1);

    const [activity] = parseDocuments(await stub.createDocuments("activity", JSON.stringify([{
      created_at: "2024-10-26T20:32:49.173Z",
      heartrate: 80,
      steps: 100,
      activitylevel: "walking",
    }])));
    if (activity === undefined) throw new Error("Activity create returned no document");
    const [updatedActivity] = parseDocuments(await stub.saveDocuments(
      "activity",
      JSON.stringify([{
        ...activity,
        created_at: "2024-10-26T21:32:49.173Z",
        heartrate: 95,
        steps: 250,
        activitylevel: "running",
      }]),
    ));
    expect(updatedActivity).toMatchObject({
      _id: activity._id,
      created_at: "2024-10-26T21:32:49.173Z",
      heartrate: 95,
      steps: 250,
      activitylevel: "running",
    });

    const [generatedActivity] = parseDocuments(await stub.saveDocuments(
      "activity",
      JSON.stringify([{ heartrate: 70, steps: 10 }]),
    ));
    expect(generatedActivity).toMatchObject({
      _id: expect.stringMatching(OBJECT_ID),
      created_at: expect.any(String),
    });
  });

  it("updates roles and subjects in place without duplicating storage rows", async () => {
    const stub = env.ENTRY_STORE.getByName(tenant("storage-shape-authorization"));
    const [role] = parseDocuments(await stub.createDocuments("roles", JSON.stringify([{
      name: "mongo-save-role",
      permissions: ["api:entries:read"],
      notes: "original",
      created_at: "2024-10-26T20:32:49.173Z",
    }])));
    const [subject] = parseDocuments(await stub.createDocuments("subjects", JSON.stringify([{
      name: "mongo-save-subject",
      roles: ["readable"],
      notes: "original",
      created_at: "2024-10-26T20:32:49.173Z",
    }])));
    if (role === undefined || subject === undefined) {
      throw new Error("Authorization create returned no document");
    }

    await stub.saveDocuments("roles", JSON.stringify([{
      _id: role._id,
      name: "mongo-save-role",
      permissions: ["api:entries:update"],
      notes: "updated",
      created_at: "2024-10-26T21:32:49.173Z",
    }]));
    await stub.saveDocuments("subjects", JSON.stringify([{
      _id: subject._id,
      name: "mongo-save-subject",
      roles: ["admin"],
      notes: "updated",
      created_at: "2024-10-26T21:32:49.173Z",
    }]));

    expect(parseDocuments(await stub.listDocuments("roles")).filter(
      (document) => document.name === "mongo-save-role",
    )).toEqual([expect.objectContaining({
      permissions: ["api:entries:update"],
      notes: "updated",
      created_at: "2024-10-26T21:32:49.173Z",
    })]);
    expect(parseDocuments(await stub.listDocuments("subjects")).filter(
      (document) => document.name === "mongo-save-subject",
    )).toHaveLength(1);
    const rawSubject = await stub.findDocumentByField(
      "subjects",
      "name",
      "mongo-save-subject",
    );
    expect(rawSubject).not.toBeNull();
    expect(JSON.parse(rawSubject!) as JsonObject).toMatchObject({
      roles: ["admin"],
      notes: "updated",
      created_at: "2024-10-26T21:32:49.173Z",
    });
  });

  it("maps Mongo insertOne/insertMany intent to explicit SQLite document batches", async () => {
    const stub = env.ENTRY_STORE.getByName(tenant("storage-shape-insert"));
    expect(parseDocuments(await stub.createDocuments("activity", JSON.stringify([{
      type: "test",
      value: 42,
    }])))).toHaveLength(1);
    expect(parseDocuments(await stub.createDocuments("activity", JSON.stringify([
      { type: "test", value: 1 },
      { type: "test", value: 2 },
      { type: "test", value: 3 },
    ])))).toHaveLength(3);
    expect(parseDocuments(await stub.listDocuments("activity"))).toHaveLength(4);
  });
});
