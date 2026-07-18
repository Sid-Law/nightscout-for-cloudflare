import { env } from "cloudflare:workers";
import {
  SELF,
  evictDurableObject,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EntryStore } from "../src/entry-store";
import { parseEntryPayload } from "../src/model";

/**
 * Differential contract sources, locked to Nightscout v15.0.7 commit
 * 7e0e77f88fc113a76fe363504125f5b36b8a3fe3:
 * - lib/api3/generic/{create,read,search,update,patch,delete,history}
 * - lib/api3/generic/setup.js (entries date+type legacy fallback)
 * - lib/api3/storage/mongoCollection/{index,find,modify,utils}.js
 * - lib/api3/specific/lastModified.js and lib/api3/security.js
 * - lib/server/entries.js (v1 sysTime+type upsert and UUID handling)
 * - tests/api3.*.test.js, tests/api.entries*.test.js, and storage tests.
 */

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

function withTenant(path: string, tenantName: string): string {
  return `https://example.test${path}${path.includes("?") ? "&" : "?"}tenant=${tenantName}`;
}

async function adminWrite(
  tenantName: string,
  path: string,
  payload: unknown,
): Promise<Response> {
  return SELF.fetch(withTenant(path, tenantName), {
    method: "POST",
    headers: {
      "api-secret": await secretDigest(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

async function issueSubject(
  tenantName: string,
  subjectName: string,
  permissions: string[],
): Promise<string> {
  const roleName = `role-${crypto.randomUUID().slice(0, 8)}`;
  expect((await adminWrite(tenantName, "/api/v2/authorization/roles", {
    name: roleName,
    permissions,
  })).status).toBe(200);
  const subjectResponse = await adminWrite(
    tenantName,
    "/api/v2/authorization/subjects",
    { name: subjectName, roles: [roleName] },
  );
  expect(subjectResponse.status).toBe(200);
  const created = await subjectResponse.json<JsonObject>();
  // Locked Nightscout returns the stored subject on mutation and derives the
  // access token while reloading/listing authorization state. The integrated
  // adapter therefore never leaks derived credential fields from POST.
  const subjectsResponse = await SELF.fetch(withTenant(
    "/api/v2/authorization/subjects",
    tenantName,
  ), {
    headers: { "api-secret": await secretDigest() },
  });
  expect(subjectsResponse.status).toBe(200);
  const subject = (await subjectsResponse.json<JsonObject[]>()).find(
    (candidate) => candidate._id === created._id,
  );
  expect(subject?.accessToken).toEqual(expect.any(String));
  const authorization = await SELF.fetch(
    withTenant(
      `/api/v2/authorization/request/${encodeURIComponent(String(subject?.accessToken))}`,
      tenantName,
    ),
  );
  expect(authorization.status).toBe(200);
  return String((await authorization.json<JsonObject>()).token);
}

function api3Fetch(
  tenantName: string,
  jwt: string | null,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (jwt !== null) headers.set("Authorization", `Bearer ${jwt}`);
  return SELF.fetch(withTenant(path, tenantName), { ...init, headers });
}

function jsonMutation(
  method: "POST" | "PUT" | "PATCH",
  body: unknown,
  headers: HeadersInit = {},
): RequestInit {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Content-Type", "application/json");
  return { method, headers: requestHeaders, body: JSON.stringify(body) };
}

async function v1Post(tenantName: string, body: unknown): Promise<Response> {
  return SELF.fetch(withTenant("/api/v1/entries", tenantName), {
    method: "POST",
    headers: {
      "api-secret": await secretDigest(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function v1Entries(tenantName: string, count = 100): Promise<JsonObject[]> {
  const response = await SELF.fetch(
    withTenant(`/api/v1/entries.json?count=${count}`, tenantName),
  );
  expect(response.status).toBe(200);
  return response.json<JsonObject[]>();
}

function entry(
  identifier: string,
  date: number,
  extra: JsonObject = {},
): JsonObject {
  return {
    identifier,
    date,
    dateString: new Date(date).toISOString(),
    app: "api3-entries-test",
    device: "simulator://cgm",
    type: "sgv",
    sgv: 120,
    direction: "Flat",
    ...extra,
  };
}

async function result<T = unknown>(response: Response): Promise<T> {
  const body = await response.json<{ status: number; result: T }>();
  expect(body.status).toBe(200);
  return body.result;
}

describe("API v3 Entries vertical slice", () => {
  it("requires JWT Bearer auth and collection-specific permissions", async () => {
    const name = tenant("api3-entry-auth");
    const date = Date.now() - 60_000;
    const document = entry("entry-auth", date);
    const reader = await issueSubject(name, "Reader", ["api:entries:read"]);
    const creator = await issueSubject(name, "Creator", ["api:entries:create"]);
    const updater = await issueSubject(name, "Updater", ["api:entries:update"]);

    const missing = await api3Fetch(name, null, "/api/v3/entries");
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({
      status: 401,
      message: "Missing or bad access token or JWT",
    });
    expect((await SELF.fetch(withTenant("/api/v3/entries", name), {
      headers: { "api-secret": await secretDigest() },
    })).status).toBe(401);

    const deniedCreate = await api3Fetch(
      name,
      reader,
      "/api/v3/entries",
      jsonMutation("POST", document),
    );
    expect(deniedCreate.status).toBe(403);
    expect(await deniedCreate.json()).toEqual({
      status: 403,
      message: "Missing permission api:entries:create",
    });

    expect((await api3Fetch(
      name,
      creator,
      "/api/v3/entries",
      jsonMutation("POST", document),
    )).status).toBe(201);
    const deniedPatch = await api3Fetch(
      name,
      creator,
      "/api/v3/entries/entry-auth",
      jsonMutation("PATCH", { sgv: 121 }),
    );
    expect(deniedPatch.status).toBe(403);
    expect(await deniedPatch.json()).toEqual({
      status: 403,
      message: "Missing permission api:entries:update",
    });

    const deniedUpsert = await api3Fetch(
      name,
      updater,
      "/api/v3/entries/missing-entry",
      jsonMutation("PUT", entry("ignored", date + 300_000)),
    );
    expect(deniedUpsert.status).toBe(403);
    expect(await deniedUpsert.json()).toEqual({
      status: 403,
      message: "Missing permission api:entries:create",
    });
    expect((await api3Fetch(name, reader, "/api/v3/entries/entry-auth")).status).toBe(200);
  });

  it("runs search, create, read, PUT, PATCH, history, lastModified, formats, and deletes", async () => {
    const name = tenant("api3-entry-workflow");
    const permissions = [
      "api:entries:create",
      "api:entries:read",
      "api:entries:update",
      "api:entries:delete",
    ];
    const alice = await issueSubject(name, "Alice", permissions);
    const bob = await issueSubject(name, "Bob", permissions);
    const date = Date.now() - 10 * 60_000;
    const document = entry("workflow-entry", date, {
      noise: 1,
      filtered: 120_000,
      unfiltered: 121_000,
    });

    const created = await api3Fetch(
      name,
      alice,
      "/api/v3/entries",
      jsonMutation("POST", document),
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json<JsonObject>();
    expect(createdBody).toMatchObject({
      status: 201,
      identifier: "workflow-entry",
      lastModified: expect.any(Number),
    });
    const createdModified = Number(createdBody.lastModified);
    expect(created.headers.get("Location")).toBe("/api/v3/entries/workflow-entry");
    expect(created.headers.get("Last-Modified")).not.toBeNull();

    const searched = await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      "/api/v3/entries?type%24eq=sgv&fields=identifier%2Csgv%2Cdate",
    ));
    expect(searched).toEqual([{
      identifier: "workflow-entry",
      sgv: 120,
      date,
    }]);

    const readCreated = await api3Fetch(
      name,
      alice,
      "/api/v3/entries/workflow-entry",
    );
    expect(await result<JsonObject>(readCreated)).toMatchObject({
      identifier: "workflow-entry",
      date,
      utcOffset: 0,
      created_at: new Date(date).toISOString(),
      subject: "Alice",
      srvCreated: expect.any(Number),
      srvModified: createdModified,
    });
    const readLastModified = readCreated.headers.get("Last-Modified");
    expect(readLastModified).not.toBeNull();
    expect((await api3Fetch(
      name,
      alice,
      "/api/v3/entries/workflow-entry",
      { headers: { "If-Modified-Since": String(readLastModified) } },
    )).status).toBe(304);

    const replaced = await api3Fetch(
      name,
      bob,
      "/api/v3/entries/workflow-entry",
      jsonMutation("PUT", { ...document, sgv: 125 }),
    );
    expect(replaced.status).toBe(200);
    const replacedBody = await replaced.json<JsonObject>();
    expect(replacedBody).toMatchObject({ status: 200, lastModified: expect.any(Number) });
    expect(Number(replacedBody.lastModified)).toBeGreaterThan(createdModified);
    expect((await api3Fetch(
      name,
      alice,
      "/api/v3/entries/workflow-entry",
      jsonMutation("PUT", document, {
        "If-Unmodified-Since": "Sat, 01 Jan 2000 00:00:00 GMT",
      }),
    )).status).toBe(412);

    const patched = await api3Fetch(
      name,
      alice,
      "/api/v3/entries/workflow-entry",
      jsonMutation("PATCH", { sgv: 130, direction: "FortyFiveUp" }),
    );
    expect(patched.status).toBe(200);
    const finalDocument = await result<JsonObject>(await api3Fetch(
      name,
      alice,
      "/api/v3/entries/workflow-entry",
    ));
    expect(finalDocument).toMatchObject({
      sgv: 130,
      direction: "FortyFiveUp",
      subject: "Bob",
      modifiedBy: "Alice",
    });
    const finalModified = Number(finalDocument.srvModified);
    expect(finalModified).toBeGreaterThan(Number(replacedBody.lastModified));

    expect(await result<JsonObject>(await api3Fetch(
      name,
      alice,
      "/api/v3/lastModified",
    ))).toMatchObject({
      srvDate: expect.any(Number),
      collections: { entries: finalModified },
    });
    const history = await api3Fetch(
      name,
      alice,
      `/api/v3/entries/history/${createdModified}`,
    );
    expect(await result<JsonObject[]>(history)).toEqual([
      expect.objectContaining({ identifier: "workflow-entry", sgv: 130 }),
    ]);
    expect(history.headers.get("ETag")).toBe(`W/"${finalModified}"`);
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      "/api/v3/entries/history?limit=1",
      { headers: { "Last-Modified": "Sat, 01 Jan 2000 00:00:01 GMT" } },
    ))).toHaveLength(1);

    const searchCsv = await api3Fetch(
      name,
      alice,
      "/api/v3/entries.csv?fields=identifier%2Csgv",
    );
    expect(searchCsv.status).toBe(200);
    expect(searchCsv.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(searchCsv.headers.get("Vary")).toBe("Accept");
    expect(await searchCsv.text()).toBe("identifier,sgv\nworkflow-entry,130\n");

    const readXml = await api3Fetch(
      name,
      alice,
      "/api/v3/entries/workflow-entry?fields=identifier%2Csgv",
      { headers: { Accept: "application/xml" } },
    );
    expect(readXml.status).toBe(200);
    expect(readXml.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    expect(await readXml.text()).toContain(
      "<item>\n  <identifier>workflow-entry</identifier>\n  <sgv>130</sgv>\n</item>",
    );

    expect((await api3Fetch(
      name,
      bob,
      "/api/v3/entries/workflow-entry",
      { method: "DELETE" },
    )).status).toBe(200);
    expect((await api3Fetch(name, alice, "/api/v3/entries/workflow-entry")).status).toBe(410);
    expect(await result<JsonObject[]>(await api3Fetch(name, alice, "/api/v3/entries"))).toEqual([]);
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      `/api/v3/entries/history/${finalModified - 1}`,
    ))).toEqual([
      expect.objectContaining({
        identifier: "workflow-entry",
        isValid: false,
        modifiedBy: "Bob",
      }),
    ]);

    expect((await api3Fetch(
      name,
      bob,
      "/api/v3/entries/workflow-entry?permanent=true",
      { method: "DELETE" },
    )).status).toBe(200);
    expect((await api3Fetch(name, alice, "/api/v3/entries/workflow-entry")).status).toBe(404);
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      "/api/v3/entries/history/946684800001",
    ))).toEqual([]);
  });

  it("keeps identifier non-unique and applies deterministic search order, limit, and skip", async () => {
    const name = tenant("api3-entry-index");
    const jwt = await issueSubject(name, "Index reader", [
      "api:entries:create",
      "api:entries:read",
    ]);
    const firstDate = Date.now() - 20 * 60_000;
    const secondDate = firstDate + 300_000;
    const sharedIdentifier = "shared-v1-entry";
    expect((await v1Post(name, [
      entry(sharedIdentifier, firstDate, { sgv: 101 }),
      entry(sharedIdentifier, secondDate, { sgv: 102 }),
    ])).status).toBe(200);

    const ascending = await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      `/api/v3/entries?identifier%24eq=${sharedIdentifier}&sort=date`,
    ));
    expect(ascending.map((document) => document.date)).toEqual([firstDate, secondDate]);
    const descending = await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      `/api/v3/entries?identifier%24eq=${sharedIdentifier}&sort%24desc=date&limit=1&skip=1`,
    ));
    expect(descending.map((document) => document.date)).toEqual([firstDate]);

    const sameDate = secondDate + 300_000;
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/entries",
      jsonMutation("POST", entry("same-time-a", sameDate, { sgv: 103 })),
    )).status).toBe(201);
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/entries",
      jsonMutation("POST", entry("same-time-b", sameDate, { sgv: 104 })),
    )).status).toBe(201);
    const sameTimeDocuments = await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      `/api/v3/entries?date%24eq=${sameDate}&fields=identifier`,
    ));
    expect(sameTimeDocuments.map((document) => document.identifier).sort())
      .toEqual(["same-time-a", "same-time-b"]);

    const stub = env.ENTRY_STORE.getByName(name);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM entries WHERE identifier = ?",
        sharedIdentifier,
      ).one().count).toBe(2);
      const uniqueIdentifierIndexes = state.storage.sql.exec<{
        name: string;
        unique: number;
      }>("PRAGMA index_list(entries)").toArray().filter((index) => {
        if (index.unique === 0) return false;
        const columns = state.storage.sql.exec<{ name: string }>(
          `PRAGMA index_info("${index.name}")`,
        ).toArray();
        return columns.length === 1 && columns[0]?.name === "identifier";
      });
      expect(uniqueIdentifierIndexes).toEqual([]);
    });
  });

  it("matches v1 sysTime+type upserts independently of UUID, device, and measurement type", async () => {
    const name = tenant("api3-entry-v1-dedup");
    const date = Date.now() - 15 * 60_000;
    const firstUuid = "550e8400-e29b-41d4-a716-446655440011";
    const secondUuid = "550e8400-e29b-41d4-a716-446655440012";
    expect((await v1Post(name, {
      _id: firstUuid,
      ...entry("discarded-first", date, { identifier: undefined, sgv: 111, device: "Trio" }),
    })).status).toBe(200);
    expect((await v1Post(name, {
      _id: secondUuid,
      ...entry("discarded-second", date, {
        identifier: undefined,
        sgv: 123,
        direction: "FortyFiveUp",
        device: "xDrip",
      }),
    })).status).toBe(200);
    expect((await v1Post(name, {
      type: "mbg",
      mbg: 118,
      date,
      dateString: new Date(date).toISOString(),
      device: "Meter",
    })).status).toBe(200);
    expect((await v1Post(name, entry(
      "third-time",
      date + 300_000,
      { sgv: 130 },
    ))).status).toBe(200);

    const rows = await v1Entries(name);
    expect(rows).toHaveLength(3);
    expect(rows.filter((document) => document.type === "sgv" && document.date === date)).toEqual([
      expect.objectContaining({
        identifier: secondUuid,
        sgv: 123,
        direction: "FortyFiveUp",
        device: "xDrip",
      }),
    ]);
    expect(rows.filter((document) => document.date === date).map((document) => document.type).sort())
      .toEqual(["mbg", "sgv"]);
    const stub = env.ENTRY_STORE.getByName(name);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      const plan = state.storage.sql.exec<{ detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT * FROM documents
         WHERE collection = 'entries'
           AND json_extract(body, '$.sysTime') = ?
           AND json_extract(body, '$.type') = ?
         ORDER BY updated_at ASC, id ASC
         LIMIT 1`,
        new Date(date).toISOString(),
        "sgv",
      ).toArray().map((row) => row.detail).join("\n");
      expect(plan).toContain("documents_entries_sys_time_type");
    });
  });

  it("matches locked v1 parseZone offsets and leaves date-only dateString absent", async () => {
    const name = tenant("api3-entry-v1-zones");
    const plusEight = "2025-07-18T08:00:00.000+08:00";
    const minusFive = "2025-07-18T20:00:00.000-05:00";
    const plusDate = Date.parse(plusEight);
    const minusDate = Date.parse(minusFive);
    const dateOnly = Date.parse("2025-07-19T02:00:00.000Z");
    expect((await v1Post(name, [
      entry("zone-plus-eight", plusDate, { dateString: plusEight, sgv: 111 }),
      entry("zone-minus-five", minusDate, { dateString: minusFive, sgv: 112 }),
      {
        identifier: "date-only",
        date: dateOnly,
        app: "api3-entries-test",
        device: "simulator://date-only",
        type: "sgv",
        sgv: 113,
        direction: "Flat",
      },
    ])).status).toBe(200);

    const byIdentifier = new Map(
      (await v1Entries(name)).map((document) => [document.identifier, document]),
    );
    expect(byIdentifier.get("zone-plus-eight")).toMatchObject({
      dateString: "2025-07-18T00:00:00.000Z",
      sysTime: "2025-07-18T00:00:00.000Z",
      utcOffset: 480,
    });
    expect(byIdentifier.get("zone-minus-five")).toMatchObject({
      dateString: "2025-07-19T01:00:00.000Z",
      sysTime: "2025-07-19T01:00:00.000Z",
      utcOffset: -300,
    });
    const withoutDateString = byIdentifier.get("date-only");
    expect(withoutDateString).toMatchObject({
      sysTime: "2025-07-19T02:00:00.000Z",
      utcOffset: 0,
    });
    expect(Object.prototype.hasOwnProperty.call(withoutDateString, "dateString")).toBe(false);
  });

  it("invalidates a v1 shadow after API3 type changes and soft deletion", async () => {
    const name = tenant("api3-entry-shadow-invalidation");
    const jwt = await issueSubject(name, "Shadow updater", [
      "api:entries:read",
      "api:entries:update",
      "api:entries:delete",
    ]);
    const originalId = "999999999999999999999991";
    const replacementId = "999999999999999999999992";
    const date = Date.now() - 25 * 60_000;
    expect((await v1Post(name, {
      _id: originalId,
      ...entry("removed", date, { identifier: undefined, sgv: 119 }),
    })).status).toBe(200);
    expect((await api3Fetch(
      name,
      jwt,
      `/api/v3/entries/${originalId}`,
      jsonMutation("PATCH", { type: "mbg", mbg: 118 }),
    )).status).toBe(200);

    const stub = env.ENTRY_STORE.getByName(name);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM entries WHERE id = ?",
        originalId,
      ).one().count).toBe(0);
    });
    expect((await v1Post(name, {
      _id: replacementId,
      ...entry("removed", date, { identifier: undefined, sgv: 121 }),
    })).status).toBe(200);
    const rows = await v1Entries(name);
    expect(rows).toHaveLength(2);
    expect(rows.map((document) => [document._id, document.type]).sort()).toEqual([
      [originalId, "mbg"],
      [replacementId, "sgv"],
    ]);

    expect((await api3Fetch(
      name,
      jwt,
      `/api/v3/entries/${replacementId}`,
      { method: "DELETE" },
    )).status).toBe(200);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM entries WHERE id = ?",
        replacementId,
      ).one().count).toBe(0);
    });
  });

  it("bridges v1 entries into API3 and API3 mutations back into v1 reads", async () => {
    const name = tenant("api3-entry-interop");
    const permissions = [
      "api:entries:create",
      "api:entries:read",
      "api:entries:update",
      "api:entries:delete",
    ];
    const jwt = await issueSubject(name, "Interop", permissions);
    const legacyId = "aaaaaaaaaaaaaaaaaaaaaaaa";
    const legacyDate = Date.now() - 30 * 60_000;
    expect((await v1Post(name, {
      _id: legacyId,
      date: legacyDate,
      dateString: new Date(legacyDate).toISOString(),
      app: "api3-entries-test",
      device: "simulator://legacy",
      type: "sgv",
      sgv: 115,
      direction: "Flat",
    })).status).toBe(200);

    expect(await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      `/api/v3/entries/${legacyId}`,
    ))).toMatchObject({
      identifier: legacyId,
      sgv: 115,
      srvCreated: legacyDate,
      srvModified: legacyDate,
    });
    expect(await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      "/api/v3/lastModified",
    ))).toMatchObject({ collections: { entries: legacyDate } });

    expect((await api3Fetch(
      name,
      jwt,
      `/api/v3/entries/${legacyId}`,
      jsonMutation("PATCH", { sgv: 116 }),
    )).status).toBe(200);
    expect(await v1Entries(name)).toEqual([
      expect.objectContaining({ _id: legacyId, sgv: 116 }),
    ]);

    const modernDate = legacyDate + 300_000;
    const modern = entry("modern-entry", modernDate, {
      sysTime: new Date(modernDate).toISOString(),
      sgv: 125,
    });
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/entries",
      jsonMutation("POST", modern),
    )).status).toBe(201);
    expect((await v1Entries(name)).map((document) => document.identifier)).toContain("modern-entry");

    expect((await v1Post(name, {
      date: modernDate,
      dateString: new Date(modernDate).toISOString(),
      device: "simulator://retry",
      type: "sgv",
      sgv: 126,
      direction: "SingleUp",
    })).status).toBe(200);
    expect(await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      "/api/v3/entries/modern-entry",
    ))).toMatchObject({ sgv: 126, direction: "SingleUp" });

    const fallback = await api3Fetch(
      name,
      jwt,
      "/api/v3/entries",
      jsonMutation("POST", {
        ...entry("legacy-now-modern", legacyDate, {
          device: "simulator://legacy",
          sgv: 117,
        }),
      }),
    );
    expect(fallback.status).toBe(200);
    expect(await fallback.json()).toMatchObject({
      identifier: "legacy-now-modern",
      deduplicatedIdentifier: legacyId,
      isDeduplication: true,
    });
  });

  it("distinguishes missing and null identifiers for ObjectId mutation fallback", async () => {
    const name = tenant("api3-entry-null-id");
    const jwt = await issueSubject(name, "Identity", [
      "api:entries:create",
      "api:entries:read",
      "api:entries:update",
      "api:entries:delete",
    ]);
    const base = Date.now() - 45 * 60_000;
    const missingId = "bbbbbbbbbbbbbbbbbbbbbbbb";
    const nullId = "cccccccccccccccccccccccc";
    const putNullId = "dddddddddddddddddddddddd";
    expect((await v1Post(name, {
      _id: missingId,
      ...entry("removed", base, { identifier: undefined }),
    })).status).toBe(200);
    expect((await v1Post(name, {
      _id: nullId,
      ...entry("removed", base + 300_000, { identifier: null }),
    })).status).toBe(200);
    expect((await v1Post(name, {
      _id: putNullId,
      ...entry("removed", base + 600_000, { identifier: null }),
    })).status).toBe(200);

    expect((await api3Fetch(name, jwt, `/api/v3/entries/${missingId}`)).status).toBe(200);
    expect((await api3Fetch(name, jwt, `/api/v3/entries/${nullId}`)).status).toBe(200);
    expect((await api3Fetch(
      name,
      jwt,
      `/api/v3/entries/${missingId}`,
      jsonMutation("PATCH", { sgv: 121 }),
    )).status).toBe(200);
    expect((await api3Fetch(
      name,
      jwt,
      `/api/v3/entries/${nullId}`,
      jsonMutation("PATCH", { sgv: 122 }),
    )).status).toBe(404);

    expect((await api3Fetch(
      name,
      jwt,
      `/api/v3/entries/${nullId}?permanent=true`,
      { method: "DELETE" },
    )).status).toBe(200);
    expect((await api3Fetch(name, jwt, `/api/v3/entries/${nullId}`)).status).toBe(404);

    const putByObjectId = await api3Fetch(
      name,
      jwt,
      `/api/v3/entries/${putNullId}`,
      jsonMutation("PUT", entry("ignored", base + 900_000)),
    );
    expect(putByObjectId.status).toBe(201);
    expect(await putByObjectId.json()).toMatchObject({
      status: 201,
      identifier: putNullId,
    });
    const stub = env.ENTRY_STORE.getByName(name);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM documents
         WHERE collection = 'entries' AND (id = ? OR identifier = ?)`,
        putNullId,
        putNullId,
      ).one().count).toBe(2);
    });
  });

  it("rolls back the full v1 SQLite batch when a later entry conflicts", async () => {
    const name = tenant("api3-entry-rollback");
    const id = "eeeeeeeeeeeeeeeeeeeeeeee";
    const base = Date.now() - 60 * 60_000;
    const validated = parseEntryPayload([
      { _id: id, ...entry("removed", base, { identifier: undefined }) },
      { _id: id, ...entry("removed", base + 300_000, { identifier: undefined }) },
    ]);
    const stub = env.ENTRY_STORE.getByName(name);
    let failure = "";
    await runInDurableObject(stub, async (instance: EntryStore) => {
      try {
        await instance.putEntries(validated);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
    });
    expect(failure).toContain("UNIQUE constraint failed");
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM documents WHERE collection = 'entries'",
      ).one().count).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM document_changes WHERE collection = 'entries'",
      ).one().count).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM entries",
      ).one().count).toBe(0);
    });
  });

  it("imports a 10k shadow set without JS materialization and performs no repeat writes", async () => {
    const name = tenant("api3-entry-bulk-migrate");
    const stub = env.ENTRY_STORE.getByName(name);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      state.storage.sql.exec(`
        WITH digits(value) AS (
          VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
        ), numbers(value) AS (
          SELECT ((thousands.value * 10 + hundreds.value) * 10 + tens.value) * 10
                 + ones.value
          FROM digits AS thousands
          CROSS JOIN digits AS hundreds
          CROSS JOIN digits AS tens
          CROSS JOIN digits AS ones
        )
        INSERT INTO entries
          (id, identifier, dedupe_key, sgv, mbg, date, date_string,
           direction, device, type, created_at)
        SELECT printf('%024x', value + 1), 'bulk-entry-' || value,
               json_array(CAST(1700000000000 + value AS TEXT), 'sgv'),
               80 + (value % 200), NULL, 1700000000000 + value,
               CAST(1700000000000 + value AS TEXT), 'Flat', 'bulk-migration',
               'sgv', 1700000000000 + value
        FROM numbers
      `);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM entries",
      ).one().count).toBe(10_000);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM documents WHERE collection = 'entries'",
      ).one().count).toBe(0);
      // This is an upgrade snapshot: a newer worker has not yet recorded the
      // Entries bridge even though the shadow can already be large.
      state.storage.sql.exec("DELETE FROM _sql_schema_migrations WHERE id = 6");
    });

    await evictDurableObject(stub);
    expect(await stub.getEntries({
      count: 1,
      gt: null,
      gte: null,
      lt: null,
      lte: null,
    })).toHaveLength(1);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM documents WHERE collection = 'entries'",
      ).one().count).toBe(10_000);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM document_changes WHERE collection = 'entries'",
      ).one().count).toBe(10_000);
      // A BEFORE INSERT trigger turns even an ON CONFLICT losing insert into
      // an activation failure. Together with marker 6, the second eviction
      // verifies the normal activation bypasses the backfill statements
      // entirely rather than scanning/walking all 10k rows again.
      state.storage.sql.exec(`
        CREATE TRIGGER reject_repeat_entry_migration
        BEFORE INSERT ON documents
        WHEN NEW.collection = 'entries' AND EXISTS (
          SELECT 1 FROM documents
          WHERE collection = 'entries' AND id = NEW.id
        )
        BEGIN
          SELECT RAISE(ABORT, 'repeat entry migration write');
        END
      `);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM _sql_schema_migrations WHERE id = 6",
      ).one().count).toBe(1);
    });

    await evictDurableObject(stub);
    expect(await stub.getEntries({
      count: 1,
      gt: null,
      gte: null,
      lt: null,
      lte: null,
    })).toHaveLength(1);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM documents WHERE collection = 'entries'",
      ).one().count).toBe(10_000);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM document_changes WHERE collection = 'entries'",
      ).one().count).toBe(10_000);
    });
  });

  it("repairs and imports an old UNIQUE schema after eviction even with a higher marker", async () => {
    const name = tenant("api3-entry-migrate");
    const stub = env.ENTRY_STORE.getByName(name);
    const id = "ffffffffffffffffffffffff";
    const date = Date.now() - 2 * 60 * 60_000;
    const dateString = new Date(date).toISOString();
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      state.storage.sql.exec("DELETE FROM document_changes WHERE collection = 'entries'");
      state.storage.sql.exec("DELETE FROM documents WHERE collection = 'entries'");
      state.storage.sql.exec("DROP TABLE entries");
      state.storage.sql.exec(`
        CREATE TABLE entries (
          id TEXT PRIMARY KEY,
          identifier TEXT UNIQUE,
          dedupe_key TEXT NOT NULL UNIQUE,
          sgv INTEGER NOT NULL CHECK (sgv >= 20 AND sgv <= 600),
          date INTEGER NOT NULL,
          date_string TEXT NOT NULL,
          direction TEXT NOT NULL,
          device TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type = 'sgv'),
          created_at INTEGER NOT NULL
        )
      `);
      state.storage.sql.exec(
        `INSERT INTO entries
          (id, identifier, dedupe_key, sgv, date, date_string,
           direction, device, type, created_at)
         VALUES (?, 'migration-shared-id', ?, 144, ?, ?, 'Flat',
                 'old-sqlite', 'sgv', ?)`,
        id,
        `${date}:sgv`,
        date,
        dateString,
        date,
      );
      state.storage.sql.exec("DELETE FROM _sql_schema_migrations WHERE id = 6");
      state.storage.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (99)",
      );
    });

    await evictDurableObject(stub);
    expect(await stub.getEntries({
      count: 10,
      gt: null,
      gte: null,
      lt: null,
      lte: null,
    })).toEqual([
      expect.objectContaining({
        _id: id,
        identifier: "migration-shared-id",
        sgv: 144,
      }),
    ]);

    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM documents WHERE collection = 'entries'",
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM _sql_schema_migrations WHERE id IN (6, 99)",
      ).one().count).toBe(2);
      const uniqueIdentifierIndexes = state.storage.sql.exec<{
        name: string;
        unique: number;
      }>("PRAGMA index_list(entries)").toArray().filter((index) => {
        if (index.unique === 0) return false;
        const columns = state.storage.sql.exec<{ name: string }>(
          `PRAGMA index_info("${index.name}")`,
        ).toArray();
        return columns.length === 1 && columns[0]?.name === "identifier";
      });
      expect(uniqueIdentifierIndexes).toEqual([]);
    });

    expect((await v1Post(name, entry(
      "migration-shared-id",
      date + 300_000,
      { sgv: 145 },
    ))).status).toBe(200);
    await evictDurableObject(stub);
    expect(await stub.getEntries({
      count: 10,
      gt: null,
      gte: null,
      lt: null,
      lte: null,
    })).toHaveLength(2);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM documents WHERE collection = 'entries'",
      ).one().count).toBe(2);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM entries WHERE identifier = 'migration-shared-id'",
      ).one().count).toBe(2);
    });
  });
});
