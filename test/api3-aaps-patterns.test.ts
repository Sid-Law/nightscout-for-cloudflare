import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import aapsPatterns from "../vendor/nightscout/tests/fixtures/aaps-patterns.json";
import { calculateApi3Identifier } from "../src/api3/input";
import type { JsonDocument } from "../src/entry-store";

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

async function adminWrite(
  tenantName: string,
  path: string,
  payload: unknown,
): Promise<Response> {
  return SELF.fetch(`https://example.test${path}?tenant=${tenantName}`, {
    method: "POST",
    headers: {
      "api-secret": await secretDigest(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

async function issueSubject(tenantName: string): Promise<string> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const roleName = `aaps-role-${suffix}`;
  const permissions = ["treatments", "entries", "profile"].flatMap(
    (collection) => ["create", "read", "update", "delete"].map(
      (action) => `api:${collection}:${action}`,
    ),
  );
  expect((await adminWrite(tenantName, "/api/v2/authorization/roles", {
    name: roleName,
    permissions,
  })).status).toBe(200);
  const createdResponse = await adminWrite(
    tenantName,
    "/api/v2/authorization/subjects",
    { name: `AAPS ${suffix}`, roles: [roleName] },
  );
  expect(createdResponse.status).toBe(200);
  const created = await createdResponse.json<JsonObject>();
  const subjectsResponse = await SELF.fetch(
    `https://example.test/api/v2/authorization/subjects?tenant=${tenantName}`,
    { headers: { "api-secret": await secretDigest() } },
  );
  expect(subjectsResponse.status).toBe(200);
  const subject = (await subjectsResponse.json<JsonObject[]>()).find(
    (candidate) => candidate._id === created._id,
  );
  if (subject === undefined) throw new Error("created AAPS subject was not listed");
  const jwtResponse = await SELF.fetch(
    `https://example.test/api/v2/authorization/request/${encodeURIComponent(String(subject.accessToken))}?tenant=${tenantName}`,
  );
  expect(jwtResponse.status).toBe(200);
  return String((await jwtResponse.json<JsonObject>()).token);
}

function api3Fetch(
  tenantName: string,
  jwt: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${jwt}`);
  const separator = path.includes("?") ? "&" : "?";
  return SELF.fetch(`https://example.test${path}${separator}tenant=${tenantName}`, {
    ...init,
    headers,
  });
}

function post(document: JsonObject): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(document),
  };
}

async function identified(document: JsonObject): Promise<JsonObject> {
  return {
    ...document,
    identifier: await calculateApi3Identifier(document as JsonDocument),
  };
}

async function readResult(
  tenantName: string,
  jwt: string,
  collection: string,
  identifier: string,
): Promise<JsonObject> {
  const response = await api3Fetch(
    tenantName,
    jwt,
    `/api/v3/${collection}/${encodeURIComponent(identifier)}`,
  );
  expect(response.status).toBe(200);
  const body = await response.json<{ status: number; result: JsonObject }>();
  expect(body.status).toBe(200);
  return body.result;
}

async function searchResult(
  tenantName: string,
  jwt: string,
  collection: string,
  query: string,
): Promise<JsonObject[]> {
  const response = await api3Fetch(tenantName, jwt, `/api/v3/${collection}?${query}`);
  expect(response.status).toBe(200);
  const body = await response.json<{ status: number; result: JsonObject[] }>();
  expect(body.status).toBe(200);
  return body.result;
}

describe("locked AndroidAPS API3 request patterns", () => {
  it("preserves treatment identity, pump fields, and rapid deduplication", async () => {
    const name = tenant("api3-aaps-dedup");
    const jwt = await issueSubject(name);
    const base = Date.now() - 30 * 60_000;
    const originalFixture = aapsPatterns.DEDUPLICATION_TESTS.ORIGINAL;

    const unique = await identified({
      device: `AndroidAPS-unique-${base}`,
      date: base,
      app: "AAPS",
      eventType: originalFixture.eventType,
      insulin: originalFixture.insulin,
      pumpId: originalFixture.pumpId,
      pumpType: originalFixture.pumpType,
      pumpSerial: originalFixture.pumpSerial,
      isValid: originalFixture.isValid,
    });
    const uniqueResponse = await api3Fetch(name, jwt, "/api/v3/treatments", post(unique));
    expect(uniqueResponse.status).toBe(201);
    const uniqueIdentifier = String((await uniqueResponse.json<JsonObject>()).identifier);
    expect(await readResult(name, jwt, "treatments", uniqueIdentifier)).toMatchObject({
      identifier: uniqueIdentifier,
      pumpId: originalFixture.pumpId,
      pumpType: originalFixture.pumpType,
      pumpSerial: originalFixture.pumpSerial,
      insulin: originalFixture.insulin,
    });

    const dedupBase = {
      device: `AndroidAPS-dedup-${base}`,
      date: base + 1_000,
      app: "AAPS",
      eventType: "Correction Bolus",
      insulin: 0.5,
      isValid: true,
    };
    const first = await identified({ ...dedupBase, pumpId: 9_998 });
    const second = await identified({ ...dedupBase, pumpId: 9_999 });
    expect(first.identifier).toBe(second.identifier);
    const firstResponse = await api3Fetch(name, jwt, "/api/v3/treatments", post(first));
    expect(firstResponse.status).toBe(201);
    const firstModified = Number((await firstResponse.json<JsonObject>()).lastModified);
    const secondResponse = await api3Fetch(name, jwt, "/api/v3/treatments", post(second));
    expect(secondResponse.status).toBe(200);
    const secondBody = await secondResponse.json<JsonObject>();
    expect(secondBody).toMatchObject({
      identifier: first.identifier,
      isDeduplication: true,
    });
    const secondModified = Number(secondBody.lastModified);
    expect(secondModified).toBeGreaterThan(firstModified);
    const thirdResponse = await api3Fetch(name, jwt, "/api/v3/treatments", post(second));
    expect(thirdResponse.status).toBe(200);
    const thirdModified = Number((await thirdResponse.json<JsonObject>()).lastModified);
    expect(thirdModified).toBeGreaterThan(secondModified);
    const persistedDedup = await readResult(
      name,
      jwt,
      "treatments",
      String(first.identifier),
    );
    expect(persistedDedup).toMatchObject({
      identifier: first.identifier,
      pumpId: 9_999,
      srvModified: thirdModified,
      srvCreated: expect.any(Number),
    });
    expect(Number(persistedDedup.srvModified)).toBeGreaterThan(
      Number(persistedDedup.srvCreated),
    );
    expect(await searchResult(
      name,
      jwt,
      "treatments",
      `identifier=${encodeURIComponent(String(first.identifier))}`,
    )).toHaveLength(1);
    expect(await searchResult(
      name,
      jwt,
      "treatments",
      `device=${encodeURIComponent(String(dedupBase.device))}&date%24eq=${dedupBase.date}`,
    )).toHaveLength(1);

    const differentDate = await identified({ ...dedupBase, date: base + 301_000 });
    const differentDateResponse = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments",
      post(differentDate),
    );
    expect(differentDateResponse.status).toBe(201);
    expect((await differentDateResponse.json<JsonObject>()).identifier).not.toBe(first.identifier);

    const differentEvent = await identified({ ...dedupBase, eventType: "Meal Bolus" });
    const differentEventResponse = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments",
      post(differentEvent),
    );
    expect(differentEventResponse.status).toBe(201);
    expect((await differentEventResponse.json<JsonObject>()).identifier).not.toBe(first.identifier);

    const fullDate = base + 2_000;
    const full = await identified({
      device: `AndroidAPS-full-${base}`,
      date: fullDate,
      created_at: new Date(fullDate).toISOString(),
      dateString: new Date(fullDate).toISOString(),
      app: "AAPS",
      eventType: originalFixture.eventType,
      insulin: originalFixture.insulin,
      pumpId: originalFixture.pumpId,
      pumpType: originalFixture.pumpType,
      pumpSerial: originalFixture.pumpSerial,
      isValid: originalFixture.isValid,
      isSMB: false,
      type: "NORMAL",
    });
    expect((await api3Fetch(name, jwt, "/api/v3/treatments", post(full))).status).toBe(201);
    expect(await readResult(name, jwt, "treatments", String(full.identifier))).toMatchObject({
      ...full,
      srvCreated: expect.any(Number),
      srvModified: expect.any(Number),
    });
  });

  it("persists sequential SMB and meal treatment payloads without changing fields", async () => {
    const name = tenant("api3-aaps-treatments");
    const jwt = await issueSubject(name);
    const base = Date.now() - 20 * 60_000;
    const device = `AndroidAPS-treatment-${base}`;
    const identifiers = new Set<string>();

    for (const [index, fixture] of aapsPatterns.SMB_BURSTS.CORRECTION_SEQUENCE.entries()) {
      const date = base + index * 300_000;
      const document = await identified({
        ...fixture,
        device,
        date,
        created_at: new Date(date).toISOString(),
        app: "AAPS",
      });
      const response = await api3Fetch(name, jwt, "/api/v3/treatments", post(document));
      expect(response.status, `SMB ${index}`).toBe(201);
      const identifier = String((await response.json<JsonObject>()).identifier);
      identifiers.add(identifier);
      expect(await readResult(name, jwt, "treatments", identifier)).toMatchObject({
        pumpId: fixture.pumpId,
        pumpType: fixture.pumpType,
        pumpSerial: fixture.pumpSerial,
        isSMB: true,
        insulin: fixture.insulin,
        srvCreated: expect.any(Number),
      });
    }
    expect(identifiers).toHaveLength(3);

    const mealDocuments = [
      {
        ...aapsPatterns.MEAL_SCENARIO.CARB_ENTRY,
        date: base + 1,
        created_at: new Date(base + 1).toISOString(),
      },
      {
        ...aapsPatterns.MEAL_SCENARIO.BOLUS_WIZARD,
        date: base + 2,
        created_at: new Date(base + 2).toISOString(),
      },
      {
        ...aapsPatterns.MEAL_SCENARIO.MEAL_BOLUS,
        date: base + 3,
        created_at: new Date(base + 3).toISOString(),
      },
    ];
    const mealIdentifiers = new Set<string>();
    for (const [index, fixture] of mealDocuments.entries()) {
      const document = await identified({ ...fixture, device, app: "AAPS" });
      const response = await api3Fetch(name, jwt, "/api/v3/treatments", post(document));
      expect(response.status, `meal ${index}`).toBe(201);
      const identifier = String((await response.json<JsonObject>()).identifier);
      mealIdentifiers.add(identifier);
      expect(await readResult(name, jwt, "treatments", identifier)).toMatchObject({
        ...fixture,
        srvCreated: expect.any(Number),
      });
    }
    expect(mealIdentifiers).toHaveLength(3);
  });

  it("persists rapid AAPS SGV readings with their direction and server metadata", async () => {
    const name = tenant("api3-aaps-sgv");
    const jwt = await issueSubject(name);
    const base = Date.now() - 15 * 60_000;
    const device = `AndroidAPS-DexcomG6-${base}`;
    const identifiers = new Set<string>();

    for (const [index, fixture] of aapsPatterns.SGV_ENTRIES.HIGH_FREQUENCY_BATCH
      .slice(0, 3).entries()) {
      const date = base + index * 300_000;
      const document = await identified({
        ...fixture,
        device,
        date,
        dateString: new Date(date).toISOString(),
        app: "AAPS",
      });
      const response = await api3Fetch(name, jwt, "/api/v3/entries", post(document));
      expect(response.status, `SGV ${index}`).toBe(201);
      const identifier = String((await response.json<JsonObject>()).identifier);
      identifiers.add(identifier);
      expect(await readResult(name, jwt, "entries", identifier)).toMatchObject({
        identifier,
        sgv: fixture.sgv,
        direction: fixture.direction,
        utcOffset: fixture.utcOffset,
        srvCreated: expect.any(Number),
        srvModified: expect.any(Number),
      });
    }
    expect(identifiers).toHaveLength(3);
  });

  it("matches AAPS v3 profile retry and LocalProfileLastChange behavior", async () => {
    const name = tenant("api3-aaps-profile");
    const jwt = await issueSubject(name);
    const profile = (date: number, ratio: number): JsonObject => {
      const iso = new Date(date).toISOString();
      return {
        app: "AAPS",
        date,
        created_at: iso,
        startDate: iso,
        defaultProfile: "aaps-v3-test",
        units: "mg/dl",
        store: {
          "aaps-v3-test": {
            dia: 5,
            carbratio: [{ time: "00:00", value: ratio }],
            sens: [{ time: "00:00", value: 50 }],
            basal: [{ time: "00:00", value: 0.5 }],
            target_low: [{ time: "00:00", value: 100 }],
            target_high: [{ time: "00:00", value: 120 }],
            timezone: "UTC",
          },
        },
      };
    };
    const firstDate = Date.now() - 60_000;
    const first = await identified(profile(firstDate, 8));
    const firstResponse = await api3Fetch(name, jwt, "/api/v3/profile", post(first));
    expect(firstResponse.status).toBe(201);
    const firstIdentifier = String((await firstResponse.json<JsonObject>()).identifier);
    expect(await searchResult(
      name,
      jwt,
      "profile",
      "defaultProfile=aaps-v3-test",
    )).toHaveLength(1);

    const retryResponse = await api3Fetch(name, jwt, "/api/v3/profile", post(first));
    expect(retryResponse.status).toBe(200);
    expect(await retryResponse.json()).toMatchObject({
      identifier: firstIdentifier,
      isDeduplication: true,
    });
    expect(await searchResult(
      name,
      jwt,
      "profile",
      "defaultProfile=aaps-v3-test",
    )).toHaveLength(1);

    const second = await identified(profile(firstDate + 60_000, 14));
    const secondResponse = await api3Fetch(name, jwt, "/api/v3/profile", post(second));
    expect(secondResponse.status).toBe(201);
    const secondIdentifier = String((await secondResponse.json<JsonObject>()).identifier);
    expect(secondIdentifier).not.toBe(firstIdentifier);
    expect(await searchResult(
      name,
      jwt,
      "profile",
      "defaultProfile=aaps-v3-test",
    )).toHaveLength(2);

    const currentResponse = await SELF.fetch(
      `https://example.test/api/v1/profile/current?tenant=${name}`,
    );
    expect(currentResponse.status).toBe(200);
    const current = await currentResponse.json<JsonObject>();
    const currentStore = current.store as JsonObject;
    const currentProfile = currentStore["aaps-v3-test"] as JsonObject;
    expect((currentProfile.carbratio as JsonObject[])[0]).toMatchObject({ value: 14 });
  });
});
