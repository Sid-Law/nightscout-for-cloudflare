import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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
  path: string,
  payload: unknown,
  method: "POST" | "PUT" = "POST",
): Promise<Response> {
  return SELF.fetch(endpoint(path, tenantName), {
    method,
    headers: {
      "api-secret": await secretDigest(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

async function listed(tenantName: string): Promise<JsonObject[]> {
  const response = await SELF.fetch(endpoint("/api/v1/treatments.json?count=100", tenantName));
  expect(response.status).toBe(200);
  return response.json<JsonObject[]>();
}

describe("locked v1/v2 Treatments preBolus contract", () => {
  it("atomically splits preBolus carbs into the shifted treatment and deduplicates both", async () => {
    const name = tenant("treatments-prebolus");
    const createdAt = new Date(Date.now() - 30 * 60_000).toISOString();
    const input = {
      eventType: "Meal Bolus",
      created_at: createdAt,
      carbs: "30",
      insulin: "2.00",
      preBolus: "15",
      glucose: 100,
      glucoseType: "Finger",
      units: "mg/dl",
      notes: "meal split",
    };

    const createdResponse = await write(name, "/api/v1/treatments/", input);
    expect(createdResponse.status).toBe(200);
    const created = await createdResponse.json<JsonObject[]>();
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      eventType: "Meal Bolus",
      created_at: createdAt,
      insulin: 2,
      preBolus: 15,
      glucose: 100,
      notes: "meal split",
    });
    expect(created[0]).not.toHaveProperty("carbs");

    const shiftedAt = new Date(Date.parse(createdAt) + 15 * 60_000).toISOString();
    expect(created[1]).toMatchObject({
      eventType: "Meal Bolus",
      created_at: shiftedAt,
      carbs: 30,
      notes: "meal split",
    });
    for (const field of ["insulin", "preBolus", "glucose", "glucoseType", "units", "utcOffset"]) {
      expect(created[1]).not.toHaveProperty(field);
    }
    expect(created[0]?._id).toMatch(/^[0-9a-f]{24}$/);
    expect(created[1]?._id).toMatch(/^[0-9a-f]{24}$/);

    const replayResponse = await write(name, "/api/v2/treatments/", input);
    expect(replayResponse.status).toBe(200);
    const replay = await replayResponse.json<JsonObject[]>();
    expect(replay.map((document) => document._id)).toEqual(
      created.map((document) => document._id),
    );
    expect(await listed(name)).toHaveLength(2);

    const ddata = await (
      await SELF.fetch(endpoint("/api/v2/ddata/at", name))
    ).json<{ treatments: JsonObject[] }>();
    expect(ddata.treatments).toEqual(expect.arrayContaining([
      expect.objectContaining({ _id: created[0]?._id, preBolus: 15 }),
      expect.objectContaining({ _id: created[1]?._id, carbs: 30 }),
    ]));
  });

  it("keeps ordered batch dedupe while returning every upstream create result", async () => {
    const name = tenant("treatments-prebolus-batch");
    const createdAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const repeated = {
      eventType: "BG Check",
      created_at: createdAt,
      glucose: 110,
      glucoseType: "Finger",
      units: "mg/dl",
    };
    const response = await write(name, "/api/v1/treatments/", [
      repeated,
      repeated,
      repeated,
      {
        eventType: "Meal Bolus",
        created_at: createdAt,
        carbs: "25",
        insulin: "1.5",
        preBolus: "10",
      },
    ]);
    expect(response.status).toBe(200);
    expect(await response.json<JsonObject[]>()).toHaveLength(5);
    expect(await listed(name)).toHaveLength(3);
  });

  it("creates the locked empty-carb child when preBolus is present without carbs", async () => {
    const name = tenant("treatments-prebolus-empty-carbs");
    const createdAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const input = {
      eventType: "Meal Bolus",
      created_at: createdAt,
      insulin: 1,
      preBolus: "5",
    };

    const createdResponse = await write(name, "/api/v1/treatments/", input);
    expect(createdResponse.status).toBe(200);
    const created = await createdResponse.json<JsonObject[]>();
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      eventType: "Meal Bolus",
      created_at: createdAt,
      insulin: 1,
      preBolus: 5,
    });
    expect(created[0]).not.toHaveProperty("carbs");
    expect(created[1]).toMatchObject({
      eventType: "Meal Bolus",
      created_at: new Date(Date.parse(createdAt) + 5 * 60_000).toISOString(),
      carbs: "",
    });

    const replayResponse = await write(name, "/api/v2/treatments/", input);
    expect(replayResponse.status).toBe(200);
    const replay = await replayResponse.json<JsonObject[]>();
    expect(replay.map((document) => document._id)).toEqual(
      created.map((document) => document._id),
    );
    expect(await listed(name)).toHaveLength(2);
  });

  it("rolls back the primary record when the shifted timestamp cannot be represented", async () => {
    const name = tenant("treatments-prebolus-atomic");
    const response = await write(name, "/api/v1/treatments/", {
      eventType: "Meal Bolus",
      created_at: new Date().toISOString(),
      carbs: 20,
      insulin: 1,
      preBolus: "1e308",
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "mongo_error", message: "Mongo Error" },
    });
    expect(await listed(name)).toEqual([]);
  });
});
