import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  LEGACY_DEFAULT_PREDICTIONS_MAX_SIZE,
  normalizeLegacyDeviceStatusDocument,
  parseLegacyPredictionsMaxSize,
} from "../src/documents";

const TEST_API_SECRET = "nscf-test-secret-20260717";

type JsonObject = Record<string, unknown>;
type LegacyCollection = "devicestatus" | "entries" | "treatments";

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function endpoint(path: string, tenantName: string): string {
  return `https://example.test${path}${path.includes("?") ? "&" : "?"}tenant=${tenantName}`;
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
  collection: LegacyCollection,
  payload: unknown,
): Promise<{ response: Response; body: JsonObject[] }> {
  const response = await SELF.fetch(endpoint(`/api/v1/${collection}/`, tenantName), {
    method: "POST",
    headers: {
      "api-secret": await secretDigest(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json<JsonObject[]>();
  return { response, body };
}

async function list(
  tenantName: string,
  collection: LegacyCollection,
): Promise<JsonObject[]> {
  const response = await SELF.fetch(
    endpoint(`/api/v1/${collection}.json?count=100`, tenantName),
  );
  expect(response.status).toBe(200);
  return response.json<JsonObject[]>();
}

function predictionDocument(length: number, branch: "suggested" | "enacted" = "suggested") {
  return {
    device: "prediction-test",
    created_at: new Date(Date.now() - 60_000).toISOString(),
    openaps: {
      [branch]: {
        predBGs: {
          IOB: Array.from({ length }, (_, index) => 120 - index * 0.1),
          COB: Array.from({ length }, (_, index) => 120 - index * 0.05),
          UAM: Array.from({ length }, (_, index) => 120 + index * 0.02),
          ZT: Array.from({ length }, (_, index) => 120 - index * 0.08),
        },
      },
    },
  };
}

function predictionLengths(document: JsonObject, branch: "suggested" | "enacted") {
  const openaps = document.openaps as JsonObject;
  const selected = openaps[branch] as JsonObject;
  const predBGs = selected.predBGs as JsonObject;
  return Object.fromEntries(
    ["IOB", "COB", "UAM", "ZT"].map((type) => [
      type,
      (predBGs[type] as unknown[]).length,
    ]),
  );
}

describe("locked v1 partial-failure and uploader edge cases", () => {
  it("inserts every batch document when only the non-unique id field repeats", async () => {
    const name = tenant("partial-id-field");
    const started = Date.now() - 60_000;
    const batch = [
      { eventType: "Note", created_at: new Date(started).toISOString(), notes: "First note", id: "note-unique-1" },
      { eventType: "Note", created_at: new Date(started + 60_000).toISOString(), notes: "Second note", id: "note-duplicate" },
      { eventType: "Note", created_at: new Date(started + 120_000).toISOString(), notes: "Third note", id: "note-duplicate" },
      { eventType: "Note", created_at: new Date(started + 180_000).toISOString(), notes: "Fourth note", id: "note-unique-2" },
    ];

    const { response } = await post(name, "treatments", batch);
    expect(response.status).toBe(200);
    const rows = await list(name, "treatments");
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.id === "note-duplicate")).toHaveLength(2);
  });

  it("keeps response order for the locked duplicate-id batch fixture", async () => {
    const name = tenant("partial-order");
    const started = Date.now() - 60_000;
    const batch = ["First", "Second", "Third", "Fourth"].map((label, index) => ({
      eventType: "Note",
      created_at: new Date(started + index * 60_000).toISOString(),
      notes: `${label} note`,
      id: index === 1 || index === 2 ? "note-duplicate" : `note-${index}`,
    }));
    const { response, body } = await post(name, "treatments", batch);
    expect(response.status).toBe(200);
    expect(body.map((row) => row.notes)).toEqual(batch.map((row) => row.notes));
  });

  it("preserves Loop syncIdentifier-to-response-ID order", async () => {
    const name = tenant("partial-loop-order");
    const started = Date.now() - 60_000;
    const batch = [15, 20, 25].map((carbs, index) => ({
      eventType: "Carb Correction",
      carbs,
      syncIdentifier: `loop-sync-${index + 1}`,
      created_at: new Date(started + index * 60_000).toISOString(),
    }));
    const { response, body } = await post(name, "treatments", batch);
    expect(response.status).toBe(200);
    expect(body).toHaveLength(batch.length);
    const rows = await list(name, "treatments");
    batch.forEach((request, index) => {
      expect(body[index]?._id).toBe(
        rows.find((row) => row.syncIdentifier === request.syncIdentifier)?._id,
      );
    });
  });

  it("returns every response position when a treatment batch contains a replay", async () => {
    const name = tenant("partial-replay-order");
    const started = Date.now() - 60_000;
    const replay = {
      eventType: "Carb Correction",
      carbs: 20,
      syncIdentifier: "loop-sync-exists",
      created_at: new Date(started + 60_000).toISOString(),
    };
    const { body: existing } = await post(name, "treatments", [replay]);
    const batch = [
      { eventType: "Carb Correction", carbs: 15, syncIdentifier: "loop-sync-new", created_at: new Date(started).toISOString() },
      replay,
      { eventType: "Carb Correction", carbs: 25, syncIdentifier: "loop-sync-new2", created_at: new Date(started + 120_000).toISOString() },
    ];
    const { response, body } = await post(name, "treatments", batch);
    expect(response.status).toBe(200);
    expect(body).toHaveLength(3);
    expect(body[1]?._id).toBe(existing[0]?._id);
  });

  it("uses a valid client-provided ObjectId", async () => {
    const name = tenant("partial-client-id");
    const id = "507f1f77bcf86cd799439011";
    const { response, body } = await post(name, "treatments", [{
      eventType: "Carb Correction",
      _id: id,
      carbs: 15,
      created_at: new Date(Date.now() - 60_000).toISOString(),
    }]);
    expect(response.status).toBe(200);
    expect(body[0]?._id).toBe(id);
    expect((await list(name, "treatments"))[0]?._id).toBe(id);
  });

  it("keeps Trio id separate from the server _id", async () => {
    const name = tenant("partial-trio-id");
    const id = "trio-uuid-abc";
    const { response } = await post(name, "treatments", [{
      eventType: "Meal Bolus",
      id,
      insulin: 5,
      created_at: new Date(Date.now() - 60_000).toISOString(),
    }]);
    expect(response.status).toBe(200);
    expect(await list(name, "treatments")).toEqual([
      expect.objectContaining({ id, _id: expect.not.stringMatching(/^trio-/) }),
    ]);
  });

  it("keeps the AAPS identifier separate from the server _id", async () => {
    const name = tenant("partial-aaps-identifier");
    const identifier = "server-assigned-identifier";
    const { response } = await post(name, "treatments", [{
      eventType: "Correction Bolus",
      identifier,
      pumpId: 4148,
      pumpType: "DANA_R",
      pumpSerial: "12345",
    }]);
    expect(response.status).toBe(200);
    const [row] = await list(name, "treatments");
    expect(row).toMatchObject({ identifier });
    expect(row?._id).not.toBe(identifier);
  });

  it("returns a string _id for every created treatment response", async () => {
    const name = tenant("partial-response-ids");
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const { response, body } = await post(name, "treatments", [
      { eventType: "Note", created_at: createdAt, notes: "Test 1" },
      { eventType: "Announcement", created_at: createdAt, notes: "Test 2" },
    ]);
    expect(response.status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body.every((row) => typeof row._id === "string")).toBe(true);
  });

  it("accepts a device status with large prediction arrays", async () => {
    const name = tenant("partial-large-predictions");
    const { response, body } = await post(name, "devicestatus", [predictionDocument(350)]);
    expect(response.status).toBe(200);
    expect(body[0]?._id).toMatch(/^[0-9a-f]{24}$/);
    const [stored] = await list(name, "devicestatus");
    expect(predictionLengths(stored!, "suggested")).toEqual({
      IOB: 288,
      COB: 288,
      UAM: 288,
      ZT: 288,
    });
  });

  it("truncates suggested and enacted prediction arrays to configured 288", () => {
    const configured = parseLegacyPredictionsMaxSize("288");
    const suggested = normalizeLegacyDeviceStatusDocument(
      predictionDocument(350),
      Date.now(),
      configured,
    );
    const enacted = normalizeLegacyDeviceStatusDocument(
      predictionDocument(350, "enacted"),
      Date.now(),
      configured,
    );
    expect(predictionLengths(suggested, "suggested")).toEqual({
      IOB: 288,
      COB: 288,
      UAM: 288,
      ZT: 288,
    });
    expect(predictionLengths(enacted, "enacted")).toEqual({
      IOB: 288,
      COB: 288,
      UAM: 288,
      ZT: 288,
    });
  });

  it("uses the default 288 limit without truncating shorter arrays", () => {
    expect(parseLegacyPredictionsMaxSize(undefined)).toBe(
      LEGACY_DEFAULT_PREDICTIONS_MAX_SIZE,
    );
    expect(parseLegacyPredictionsMaxSize("invalid")).toBe(
      LEGACY_DEFAULT_PREDICTIONS_MAX_SIZE,
    );
    const normalized = normalizeLegacyDeviceStatusDocument(predictionDocument(100));
    expect(predictionLengths(normalized, "suggested")).toEqual({
      IOB: 100,
      COB: 100,
      UAM: 100,
      ZT: 100,
    });
  });

  it("preserves full prediction arrays when configured with zero", () => {
    const disabled = parseLegacyPredictionsMaxSize("0");
    expect(disabled).toBeNull();
    const normalized = normalizeLegacyDeviceStatusDocument(
      predictionDocument(400),
      Date.now(),
      disabled,
    );
    expect(predictionLengths(normalized, "suggested")).toEqual({
      IOB: 400,
      COB: 400,
      UAM: 400,
      ZT: 400,
    });
  });

  it("preserves the locked validation fixture's committed valid entries", async () => {
    const name = tenant("partial-validation-fixture");
    const started = Date.now() - 60_000;
    const { response } = await post(name, "entries", [
      { type: "sgv", sgv: 120, date: started, direction: "Flat" },
      { type: "sgv", sgv: "invalid", date: started + 300_000, direction: "Flat" },
      { type: "sgv", sgv: 125, date: started + 600_000, direction: "FortyFiveUp" },
    ]);
    // Locked v15.0.7 does not type-validate sgv here, so this fixture is not an
    // actual Mongo failure even though the upstream test title calls it one.
    expect(response.status).toBe(200);
    const rows = await list(name, "entries");
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => typeof row.sgv === "number")).toHaveLength(2);
  });

  it("processes the locked 50-entry recovery batch in order", async () => {
    const name = tenant("partial-large-batch");
    const started = Date.now() - 60_000;
    const batch = Array.from({ length: 50 }, (_, index) => ({
      type: "sgv",
      sgv: 100 + index,
      date: started + index * 300_000,
    }));
    const { response, body } = await post(name, "entries", batch);
    expect(response.status).toBe(200);
    expect(body).toHaveLength(50);
    expect(await list(name, "entries")).toHaveLength(50);
  });
});
