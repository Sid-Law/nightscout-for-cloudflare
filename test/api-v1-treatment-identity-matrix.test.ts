import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { EntryStore } from "../src/entry-store";
import { parseLegacyUuidHandling } from "../src/documents";
import type {
  RealtimeRootWriteRequest,
  RealtimeRootWriteResult,
} from "../src/realtime/session-service";

const TEST_API_SECRET = "nscf-test-secret-20260717";
const TEST_UUID = "550e8400-e29b-41d4-a716-446655440000";
const TEST_UUID_2 = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

type JsonObject = Record<string, unknown>;

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function endpoint(path: string, tenantName: string): string {
  return `https://example.test${path}${path.includes("?") ? "&" : "?"}tenant=${tenantName}`;
}

function configuredEnv(uuidHandling: boolean): Parameters<typeof worker.fetch>[1] {
  return {
    ASSETS: env.ASSETS,
    ENTRY_STORE: env.ENTRY_STORE,
    API_SECRET: TEST_API_SECRET,
    AUTH_DEFAULT_ROLES: "readable",
    AUTH_FAIL_DELAY: "0",
    UUID_HANDLING: uuidHandling ? "true" : "false",
  } as unknown as Parameters<typeof worker.fetch>[1];
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

function configuredFetch(
  tenantName: string,
  path: string,
  uuidHandling: boolean,
  init: RequestInit = {},
): Promise<Response> {
  return worker.fetch(
    new Request(endpoint(path, tenantName), init),
    configuredEnv(uuidHandling),
  );
}

async function writeTreatment(
  tenantName: string,
  payload: unknown,
  uuidHandling = true,
  method: "POST" | "PUT" = "POST",
): Promise<Response> {
  return configuredFetch(tenantName, "/api/v1/treatments/", uuidHandling, {
    method,
    headers: {
      "api-secret": await secretDigest(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
}

async function readTreatments(
  tenantName: string,
  path = "/api/v1/treatments.json?count=100",
  uuidHandling = true,
): Promise<JsonObject[]> {
  const response = await configuredFetch(tenantName, path, uuidHandling);
  expect(response.status).toBe(200);
  return response.json<JsonObject[]>();
}

async function deleteTreatment(
  tenantName: string,
  id: string,
  uuidHandling = true,
): Promise<Response> {
  return configuredFetch(
    tenantName,
    `/api/v1/treatments/${encodeURIComponent(id)}`,
    uuidHandling,
    { method: "DELETE", headers: { "api-secret": await secretDigest() } },
  );
}

function currentCreatedAt(offsetMs = 0): string {
  return new Date(Date.now() - 60_000 + offsetMs).toISOString();
}

async function insertRawTreatment(
  tenantName: string,
  document: JsonObject,
): Promise<void> {
  const stub = env.ENTRY_STORE.getByName(tenantName) as DurableObjectStub<EntryStore>;
  await runInDurableObject(stub, async (instance) => {
    const writer = instance as unknown as {
      realtimeRootWrite(request: RealtimeRootWriteRequest): RealtimeRootWriteResult;
    };
    const result = writer.realtimeRootWrite({
      event: "dbAdd",
      collection: "treatments",
      data: document,
      receivedAt: Date.now(),
    });
    expect(result.changed).toBe(true);
  });
}

describe("complete locked UUID_HANDLING=false treatment contract", () => {
  it("UUID-OFF-001 leaves identifier-only UUID documents out of _id GET", async () => {
    expect(parseLegacyUuidHandling("false")).toBe(false);
    expect(parseLegacyUuidHandling("off")).toBe(false);
    const name = tenant("uuid-off-get");
    expect((await writeTreatment(name, {
      eventType: "Note",
      notes: "Test note",
      identifier: TEST_UUID,
      created_at: currentCreatedAt(),
    }, false)).status).toBe(200);

    expect(await readTreatments(
      name,
      `/api/v1/treatments?find[_id]=${TEST_UUID}`,
      false,
    )).toEqual([]);
  });

  it("UUID-OFF-002 deletes nothing for an identifier-only UUID", async () => {
    const name = tenant("uuid-off-delete");
    await writeTreatment(name, {
      eventType: "Note",
      notes: "Test for delete",
      identifier: TEST_UUID,
      created_at: currentCreatedAt(),
    }, false);

    const deleted = await deleteTreatment(name, TEST_UUID, false);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ acknowledged: true, deletedCount: 0 });
    expect(await readTreatments(name, undefined, false)).toHaveLength(1);
  });

  it("UUID-OFF-003 strips a UUID _id without copying it to identifier", async () => {
    expect(parseLegacyUuidHandling("not-a-boolean")).toBe(true);
    expect(parseLegacyUuidHandling(" false ")).toBe(true);
    const name = tenant("uuid-off-post");
    const response = await writeTreatment(name, {
      _id: TEST_UUID,
      eventType: "Note",
      notes: "UUID stripped write test",
      created_at: currentCreatedAt(),
    }, false);
    expect(response.status).toBe(200);
    const [created] = await response.json<JsonObject[]>();
    expect(created?._id).toMatch(/^[0-9a-f]{24}$/);
    expect(created).not.toHaveProperty("identifier");
  });
});

describe("complete locked UUID_HANDLING=true treatment contract", () => {
  it("UUID-ON-001 finds an identifier document through find[_id]", async () => {
    expect(parseLegacyUuidHandling(undefined)).toBe(true);
    expect(parseLegacyUuidHandling("on")).toBe(true);
    const name = tenant("uuid-on-get");
    await writeTreatment(name, {
      eventType: "Note",
      notes: "Found by UUID",
      identifier: TEST_UUID,
      created_at: currentCreatedAt(),
    });

    expect(await readTreatments(
      name,
      `/api/v1/treatments?find[_id]=${TEST_UUID}`,
    )).toEqual([
      expect.objectContaining({ notes: "Found by UUID", identifier: TEST_UUID }),
    ]);
  });

  it("UUID-ON-002 deletes an identifier document through its UUID", async () => {
    const name = tenant("uuid-on-delete");
    await writeTreatment(name, {
      eventType: "Note",
      notes: "Will be deleted",
      identifier: TEST_UUID,
      created_at: currentCreatedAt(),
    });

    const deleted = await deleteTreatment(name, TEST_UUID);
    expect(await deleted.json()).toEqual({ acknowledged: true, deletedCount: 1 });
    expect(await readTreatments(name)).toEqual([]);
  });

  it("UUID-ON-003 keeps valid ObjectId lookup unchanged", async () => {
    const name = tenant("uuid-on-objectid");
    const objectId = "507f1f77bcf86cd799439011";
    await writeTreatment(name, {
      _id: objectId,
      eventType: "Note",
      notes: "ObjectId test",
      created_at: currentCreatedAt(),
    });

    expect(await readTreatments(
      name,
      `/api/v1/treatments?find[_id]=${objectId}`,
    )).toEqual([expect.objectContaining({ _id: objectId, notes: "ObjectId test" })]);
  });

  it("UUID-ON-004 returns an empty array for a nonmatching UUID", async () => {
    const name = tenant("uuid-on-missing");
    await writeTreatment(name, {
      eventType: "Note",
      notes: "Different UUID",
      identifier: TEST_UUID_2,
      created_at: currentCreatedAt(),
    });
    expect(await readTreatments(
      name,
      `/api/v1/treatments?find[_id]=${TEST_UUID}`,
    )).toEqual([]);
  });

  it("UUID-ON-005 extracts UUID _id into identifier", async () => {
    const name = tenant("uuid-on-post");
    const response = await writeTreatment(name, {
      _id: TEST_UUID,
      eventType: "Note",
      notes: "UUID write test",
      created_at: currentCreatedAt(),
    });
    const [created] = await response.json<JsonObject[]>();
    expect(created).toMatchObject({ identifier: TEST_UUID });
    expect(created?._id).toMatch(/^[0-9a-f]{24}$/);
  });
});

describe("complete locked UUID edge-case contract", () => {
  it("UUID-EDGE-001 returns empty for a 23-character hex id", async () => {
    expect(await readTreatments(
      tenant("uuid-edge-23"),
      "/api/v1/treatments?find[_id]=507f1f77bcf86cd79943901",
    )).toEqual([]);
  });

  it("UUID-EDGE-002 returns empty for a 25-character hex id", async () => {
    expect(await readTreatments(
      tenant("uuid-edge-25"),
      "/api/v1/treatments?find[_id]=507f1f77bcf86cd7994390112",
    )).toEqual([]);
  });

  it("UUID-EDGE-003 does not treat 32 hex characters as a UUID", async () => {
    const name = tenant("uuid-edge-no-hyphens");
    await writeTreatment(name, {
      eventType: "Note",
      notes: "Hyphenated UUID",
      identifier: TEST_UUID,
      created_at: currentCreatedAt(),
    });
    expect(await readTreatments(
      name,
      "/api/v1/treatments?find[_id]=550e8400e29b41d4a716446655440000",
    )).toEqual([]);
  });

  it("UUID-EDGE-004 handles an empty _id query without crashing", async () => {
    const name = tenant("uuid-edge-empty");
    await writeTreatment(name, {
      eventType: "Note",
      notes: "Test note",
      created_at: currentCreatedAt(),
    });
    const result = await readTreatments(name, "/api/v1/treatments?find[_id]=");
    expect(Array.isArray(result)).toBe(true);
  });

  it("UUID-EDGE-005 upserts repeated identifiers into one document", async () => {
    const name = tenant("uuid-edge-upsert");
    await writeTreatment(name, {
      eventType: "Note",
      notes: "First",
      identifier: TEST_UUID,
      created_at: currentCreatedAt(),
    });
    await writeTreatment(name, {
      eventType: "Note",
      notes: "Second",
      identifier: TEST_UUID,
      created_at: currentCreatedAt(1_000),
    });
    expect(await readTreatments(
      name,
      `/api/v1/treatments?find[_id]=${TEST_UUID}`,
    )).toEqual([expect.objectContaining({ notes: "Second" })]);
  });

  it("UUID-EDGE-006 keeps identifier matching case-sensitive", async () => {
    const name = tenant("uuid-edge-case");
    await writeTreatment(name, {
      eventType: "Note",
      notes: "Lowercase UUID",
      identifier: TEST_UUID.toLowerCase(),
      created_at: currentCreatedAt(),
    });
    expect(await readTreatments(
      name,
      `/api/v1/treatments?find[_id]=${TEST_UUID.toUpperCase()}`,
    )).toEqual([]);
  });

  it("UUID-EDGE-007 still resolves a valid ObjectId", async () => {
    const name = tenant("uuid-edge-objectid");
    const objectId = "507f1f77bcf86cd799439012";
    await writeTreatment(name, {
      _id: objectId,
      eventType: "Note",
      notes: "ObjectId test",
      created_at: currentCreatedAt(),
    });
    expect(await readTreatments(
      name,
      `/api/v1/treatments?find[_id]=${objectId}`,
    )).toEqual([expect.objectContaining({ notes: "ObjectId test" })]);
  });
});

const LEGACY_UUID = "69F15FD2-8075-4DEB-AEA3-4352F455840D";
const LEGACY_OVERRIDE: JsonObject = {
  _id: LEGACY_UUID,
  eventType: "Temporary Override",
  created_at: "2026-02-17T02:00:16.000Z",
  timestamp: "2026-02-17T02:00:16Z",
  durationType: "indefinite",
  correctionRange: [90, 110],
  insulinNeedsScaleFactor: 1.2,
  reason: "Legacy Override",
  enteredBy: "Loop",
  utcOffset: 0,
};

describe("complete issue #6923 legacy UUID regression contract", () => {
  it("deletes a legacy document whose UUID is stored directly in _id", async () => {
    const name = tenant("legacy-uuid-delete");
    await insertRawTreatment(name, LEGACY_OVERRIDE);
    const deleted = await deleteTreatment(name, LEGACY_UUID);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ acknowledged: true, deletedCount: 1 });
    expect(await readTreatments(
      name,
      `/api/v1/treatments?find[_id]=${LEGACY_UUID}`,
    )).toEqual([]);
  });

  it("updates a legacy UUID document in place without creating a duplicate", async () => {
    const name = tenant("legacy-uuid-put");
    await insertRawTreatment(name, LEGACY_OVERRIDE);
    const updated = await writeTreatment(name, {
      ...LEGACY_OVERRIDE,
      reason: "Edited Override",
      insulinNeedsScaleFactor: 1.5,
    }, true, "PUT");
    expect(updated.status).toBe(200);

    const rows = await readTreatments(
      name,
      `/api/v1/treatments?find[_id]=${LEGACY_UUID}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      _id: LEGACY_UUID,
      identifier: LEGACY_UUID,
      reason: "Edited Override",
      insulinNeedsScaleFactor: 1.5,
    });
  });

  it("finds a legacy UUID document through find[_id]", async () => {
    const name = tenant("legacy-uuid-get");
    await insertRawTreatment(name, LEGACY_OVERRIDE);
    expect(await readTreatments(
      name,
      `/api/v1/treatments/?find[_id]=${LEGACY_UUID}`,
    )).toEqual([expect.objectContaining({ _id: LEGACY_UUID, reason: "Legacy Override" })]);
  });
});

describe("complete locked client identity matrix", () => {
  it("TEST-ID-001 promotes a Loop Override UUID _id to identifier", async () => {
    const name = tenant("identity-loop-id");
    const uuid = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";
    const response = await writeTreatment(name, [{
      _id: uuid,
      eventType: "Temporary Override",
      created_at: currentCreatedAt(),
      enteredBy: "Loop",
      duration: 60,
      correctionRange: [90, 110],
      reason: "Test Override",
    }]);
    const [created] = await response.json<JsonObject[]>();
    expect(created).toMatchObject({ identifier: uuid });
    expect(created?._id).toMatch(/^[0-9a-f]{24}$/);
    expect(created?._id).not.toBe(uuid);
  });

  it("TEST-ID-002 preserves an explicit Loop identifier", async () => {
    const name = tenant("identity-loop-identifier");
    const uuid = "B2C3D4E5-F6A7-8901-BCDE-F23456789012";
    const response = await writeTreatment(name, [{
      identifier: uuid,
      eventType: "Temporary Override",
      created_at: currentCreatedAt(),
      enteredBy: "Loop",
      duration: 60,
      correctionRange: [100, 120],
    }]);
    const [created] = await response.json<JsonObject[]>();
    expect(created).toMatchObject({ identifier: uuid });
    expect(created?._id).toMatch(/^[0-9a-f]{24}$/);
  });

  it("TEST-ID-003 preserves Loop syncIdentifier without copying it", async () => {
    const name = tenant("identity-sync");
    const syncIdentifier = `loop-carb-${crypto.randomUUID()}`;
    const response = await writeTreatment(name, [{
      eventType: "Carb Correction",
      carbs: 25,
      created_at: currentCreatedAt(),
      enteredBy: "loop://iPhone",
      syncIdentifier,
      absorptionTime: 180,
    }]);
    const [created] = await response.json<JsonObject[]>();
    expect(created).toMatchObject({ syncIdentifier });
    expect(created).not.toHaveProperty("identifier");
    expect(created?._id).toMatch(/^[0-9a-f]{24}$/);
  });

  it("TEST-ID-004 accepts the AAPS identifier:null pattern", async () => {
    const name = tenant("identity-aaps-null");
    const response = await writeTreatment(name, [{
      identifier: null,
      eventType: "Bolus",
      insulin: 2.5,
      created_at: currentCreatedAt(),
      enteredBy: "AAPS",
      pumpId: 12345,
      pumpType: "OMNIPOD_DASH",
      pumpSerial: "ABC123",
    }]);
    const [created] = await response.json<JsonObject[]>();
    expect(created).toMatchObject({ identifier: null, pumpId: 12345 });
    expect(created?._id).toMatch(/^[0-9a-f]{24}$/);
  });

  it("TEST-ID-005 preserves an AAPS ObjectId-shaped identifier", async () => {
    const name = tenant("identity-aaps-objectid");
    const identifier = "507f1f77bcf86cd799439011";
    const response = await writeTreatment(name, [{
      identifier,
      eventType: "Bolus",
      insulin: 3,
      created_at: currentCreatedAt(),
      enteredBy: "AAPS",
      pumpId: 12345,
      pumpType: "OMNIPOD_DASH",
      pumpSerial: "ABC123",
    }]);
    const [created] = await response.json<JsonObject[]>();
    expect(created).toMatchObject({ identifier });
    expect(created?._id).toMatch(/^[0-9a-f]{24}$/);
  });

  it("TEST-ID-006 preserves xDrip+ uuid beside a valid _id", async () => {
    const name = tenant("identity-xdrip");
    const uuid = `xdrip-${crypto.randomUUID()}`;
    const objectId = "507f1f77bcf86cd799439012";
    const response = await writeTreatment(name, [{
      _id: objectId,
      uuid,
      eventType: "BG Check",
      glucose: 120,
      glucoseType: "Finger",
      created_at: currentCreatedAt(),
      enteredBy: "xDrip+",
    }]);
    const [created] = await response.json<JsonObject[]>();
    expect(created).toMatchObject({ _id: objectId, uuid });
  });

  it("TEST-V1-ID-001 generates an ObjectId when no id is supplied", async () => {
    const response = await writeTreatment(tenant("identity-no-id"), [{
      eventType: "Note",
      notes: "Test note without id",
      created_at: currentCreatedAt(),
      enteredBy: "Test",
    }]);
    const [created] = await response.json<JsonObject[]>();
    expect(created?._id).toMatch(/^[0-9a-f]{24}$/);
  });

  it("TEST-V1-ID-002 uses a valid ObjectId _id as-is", async () => {
    const objectId = "507f1f77bcf86cd799439013";
    const response = await writeTreatment(tenant("identity-valid-id"), [{
      _id: objectId,
      eventType: "Note",
      notes: "Test with valid ObjectId",
      created_at: currentCreatedAt(),
      enteredBy: "Test",
    }]);
    const [created] = await response.json<JsonObject[]>();
    expect(created?._id).toBe(objectId);
  });

  it("TEST-V1-ID-003 promotes a UUID _id to identifier", async () => {
    const uuid = "C3D4E5F6-A7B8-9012-CDEF-345678901234";
    const response = await writeTreatment(tenant("identity-v1-uuid"), [{
      _id: uuid,
      eventType: "Temporary Override",
      created_at: currentCreatedAt(),
      enteredBy: "Loop",
      duration: 60,
    }]);
    const [created] = await response.json<JsonObject[]>();
    expect(created).toMatchObject({ identifier: uuid });
    expect(created?._id).toMatch(/^[0-9a-f]{24}$/);
    expect(created?._id).not.toBe(uuid);
  });

  it("TEST-V1-ID-004 does not copy syncIdentifier into identifier", async () => {
    const syncIdentifier = `sync-${crypto.randomUUID()}`;
    const response = await writeTreatment(tenant("identity-v1-sync"), [{
      eventType: "Carb Correction",
      carbs: 20,
      created_at: currentCreatedAt(),
      enteredBy: "loop://iPhone",
      syncIdentifier,
    }]);
    const [created] = await response.json<JsonObject[]>();
    expect(created).toMatchObject({ syncIdentifier });
    expect(created).not.toHaveProperty("identifier");
    expect(created?._id).toMatch(/^[0-9a-f]{24}$/);
  });

  it("deduplicates repeated explicit identifiers", async () => {
    const name = tenant("identity-dedup");
    const identifier = `dedup-${crypto.randomUUID()}`;
    await writeTreatment(name, [{
      identifier,
      eventType: "Note",
      notes: "First",
      created_at: currentCreatedAt(),
      enteredBy: "Test",
    }]);
    await writeTreatment(name, [{
      identifier,
      eventType: "Note",
      notes: "Second",
      created_at: currentCreatedAt(1_000),
      enteredBy: "Test",
    }]);
    expect(await readTreatments(
      name,
      `/api/v1/treatments?find[identifier]=${identifier}`,
    )).toEqual([expect.objectContaining({ notes: "Second" })]);
  });

  it("keeps different explicit identifiers as separate documents", async () => {
    const name = tenant("identity-distinct");
    const identifiers = [`one-${crypto.randomUUID()}`, `two-${crypto.randomUUID()}`];
    const response = await writeTreatment(name, identifiers.map((identifier, index) => ({
      identifier,
      eventType: "Note",
      notes: `Note ${index + 1}`,
      created_at: currentCreatedAt(index),
      enteredBy: "Test",
    })));
    expect((await response.json<JsonObject[]>())).toHaveLength(2);
    expect(await readTreatments(name)).toHaveLength(2);
  });
});
