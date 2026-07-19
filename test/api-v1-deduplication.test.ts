import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const TEST_API_SECRET = "nscf-test-secret-20260717";

type JsonObject = Record<string, unknown>;

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
  collection: "entries" | "treatments",
  payload: unknown,
): Promise<JsonObject[]> {
  const response = await SELF.fetch(endpoint(`/api/v1/${collection}/`, tenantName), {
    method: "POST",
    headers: {
      "api-secret": await secretDigest(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(200);
  return response.json<JsonObject[]>();
}

async function list(
  tenantName: string,
  collection: "entries" | "treatments",
): Promise<JsonObject[]> {
  const response = await SELF.fetch(
    endpoint(`/api/v1/${collection}.json?count=100`, tenantName),
  );
  expect(response.status).toBe(200);
  return response.json<JsonObject[]>();
}

async function crossGeneratedTimestampBoundary(): Promise<void> {
  const started = Date.now();
  while (Date.now() === started) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("locked v1 API deduplication behavior", () => {
  it("deduplicates the AAPS pump fixture by its locked time/type upsert selector", async () => {
    const name = tenant("dedupe-aaps-treatment");
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const fixture = {
      eventType: "Correction Bolus",
      insulin: 0.25,
      created_at: createdAt,
      date: Date.parse(createdAt),
      type: "SMB",
      isValid: true,
      isSMB: true,
      pumpId: 4148,
      pumpType: "ACCU_CHEK_INSIGHT_BLUETOOTH",
      pumpSerial: "33013206",
      app: "AAPS",
    };

    const first = await post(name, "treatments", [fixture]);
    const replay = await post(name, "treatments", [{ ...fixture }]);
    expect(first).toHaveLength(1);
    expect(replay).toHaveLength(1);
    expect(replay[0]?._id).toBe(first[0]?._id);
    expect(await list(name, "treatments")).toHaveLength(1);
  });

  it("deduplicates an AAPS entry with the same normalized sysTime and type", async () => {
    const name = tenant("dedupe-aaps-entry");
    const date = Date.now() - 60_000;
    const fixture = {
      type: "sgv",
      sgv: 120,
      date,
      dateString: new Date(date).toISOString(),
      device: "AndroidAPS-DexcomG6",
      direction: "Flat",
      app: "AAPS",
    };

    await post(name, "entries", [fixture]);
    const [original] = await list(name, "entries");
    await post(name, "entries", [{ ...fixture }]);
    const rows = await list(name, "entries");
    expect(rows).toHaveLength(1);
    expect(rows[0]?._id).toBe(original?._id);
  });

  it("deduplicates the locked Loop carb syncIdentifier fixture", async () => {
    const name = tenant("dedupe-loop-carb");
    const fixture = {
      eventType: "Carb Correction",
      carbs: 15,
      syncIdentifier: "loop-sync-abc123",
      created_at: new Date(Date.now() - 60_000).toISOString(),
      enteredBy: "loop://iPhone",
    };

    const first = await post(name, "treatments", [fixture]);
    const replay = await post(name, "treatments", [{ ...fixture }]);
    expect(replay[0]?._id).toBe(first[0]?._id);
    expect(await list(name, "treatments")).toEqual([
      expect.objectContaining({ syncIdentifier: fixture.syncIdentifier }),
    ]);
  });

  it("deduplicates the locked Loop dose syncIdentifier fixture", async () => {
    const name = tenant("dedupe-loop-dose");
    const fixture = {
      eventType: "Temp Basal",
      duration: 30,
      rate: 1.5,
      absolute: 1.5,
      syncIdentifier: "loop-dose-xyz789",
      created_at: new Date(Date.now() - 60_000).toISOString(),
      enteredBy: "loop://iPhone",
    };

    const first = await post(name, "treatments", [fixture]);
    const replay = await post(name, "treatments", [{ ...fixture }]);
    expect(replay[0]?._id).toBe(first[0]?._id);
    expect(await list(name, "treatments")).toHaveLength(1);
  });

  it("deduplicates the locked Trio id fixture", async () => {
    const name = tenant("dedupe-trio-meal");
    const fixture = {
      eventType: "Meal Bolus",
      id: "trio-uuid-abc123",
      insulin: 5,
      carbs: 45,
      created_at: new Date(Date.now() - 60_000).toISOString(),
      enteredBy: "Trio",
    };

    const first = await post(name, "treatments", [fixture]);
    const replay = await post(name, "treatments", [{ ...fixture }]);
    expect(replay[0]?._id).toBe(first[0]?._id);
    expect(await list(name, "treatments")).toEqual([
      expect.objectContaining({ id: fixture.id }),
    ]);
  });

  it("deduplicates the locked Trio temporary-target fixture", async () => {
    const name = tenant("dedupe-trio-target");
    const fixture = {
      eventType: "Temporary Target",
      id: "trio-tt-def456",
      duration: 60,
      targetTop: 110,
      targetBottom: 110,
      reason: "Eating Soon",
      created_at: new Date(Date.now() - 60_000).toISOString(),
      enteredBy: "Trio",
    };

    const first = await post(name, "treatments", [fixture]);
    const replay = await post(name, "treatments", [{ ...fixture }]);
    expect(replay[0]?._id).toBe(first[0]?._id);
    expect(await list(name, "treatments")).toHaveLength(1);
  });

  it("keeps the locked three unique id values in a four-item mixed batch", async () => {
    const name = tenant("dedupe-mixed-batch");
    const started = Date.now() - 60_000;
    const batch = [
      {
        eventType: "Note",
        created_at: new Date(started).toISOString(),
        notes: "First note",
        id: "note-1",
      },
      {
        eventType: "Note",
        created_at: new Date(started + 60_000).toISOString(),
        notes: "Second note",
        id: "note-2",
      },
      {
        eventType: "Note",
        created_at: new Date(started).toISOString(),
        notes: "First note",
        id: "note-1",
      },
      {
        eventType: "Note",
        created_at: new Date(started + 120_000).toISOString(),
        notes: "Third note",
        id: "note-3",
      },
    ];

    const response = await post(name, "treatments", batch);
    expect(response).toHaveLength(4);
    const rows = await list(name, "treatments");
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.id))).toEqual(
      new Set(["note-1", "note-2", "note-3"]),
    );
  });

  it("does not merge the separate generated-time AAPS and Trio fixtures", async () => {
    const name = tenant("dedupe-cross-client");
    const aaps = {
      eventType: "Correction Bolus",
      insulin: 0.25,
      pumpId: 4148,
      pumpType: "OMNIPOD_DASH",
      pumpSerial: "PDM-12345",
      app: "AAPS",
    };
    const trio = {
      eventType: "Correction Bolus",
      insulin: 0.25,
      id: "trio-smb-4148",
      enteredBy: "Trio",
    };

    const [first] = await post(name, "treatments", [aaps]);
    await crossGeneratedTimestampBoundary();
    const [second] = await post(name, "treatments", [trio]);
    expect(second?._id).not.toBe(first?._id);
    expect(await list(name, "treatments")).toHaveLength(2);
  });

  it("returns the original _id for a deduplicated item", async () => {
    const name = tenant("dedupe-response-id");
    const fixture = {
      eventType: "Carb Correction",
      carbs: 15,
      syncIdentifier: "loop-sync-response-id",
      created_at: new Date(Date.now() - 60_000).toISOString(),
      enteredBy: "loop://iPhone",
    };

    const [first] = await post(name, "treatments", [fixture]);
    const [replay] = await post(name, "treatments", [{ ...fixture }]);
    expect(replay?._id).toBe(first?._id);
  });
});
