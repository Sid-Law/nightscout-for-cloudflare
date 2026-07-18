import { env } from "cloudflare:workers";
import { SELF, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EntryStore } from "../src/entry-store";

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
  const subject = await subjectResponse.json<JsonObject>();
  const authorization = await SELF.fetch(
    `https://example.test/api/v2/authorization/request/${encodeURIComponent(String(subject.accessToken))}?tenant=${tenantName}`,
  );
  expect(authorization.status).toBe(200);
  const body = await authorization.json<JsonObject>();
  return String(body.token);
}

function withTenant(path: string, tenantName: string): string {
  return `https://example.test${path}${path.includes("?") ? "&" : "?"}tenant=${tenantName}`;
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

function treatment(
  identifier: string,
  createdAt: string,
  extra: JsonObject = {},
): JsonObject {
  return {
    identifier,
    date: Date.parse(createdAt),
    utcOffset: 0,
    app: "api3-http-test",
    device: "test-device",
    eventType: "Note",
    created_at: createdAt,
    notes: identifier,
    ...extra,
  };
}

async function result<T = unknown>(response: Response): Promise<T> {
  const body = await response.json<{ status: number; result: T }>();
  expect(body.status).toBe(200);
  return body.result;
}

describe("API v3 treatments vertical slice", () => {
  it("uses JWT Bearer only and enforces mutation-sensitive permissions", async () => {
    const name = tenant("api3-auth");
    const createdAt = "2026-06-01T00:00:00.000Z";
    const document = treatment("auth-treatment", createdAt);
    const readable = await issueSubject(name, "Reader", []);
    const createOnly = await issueSubject(name, "Creator", ["api:treatments:create"]);
    const updateOnly = await issueSubject(name, "Updater", ["api:treatments:update"]);

    const missing = await api3Fetch(name, null, "/api/v3/treatments");
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({
      status: 401,
      message: "Missing or bad access token or JWT",
    });
    const queryToken = await api3Fetch(
      name,
      null,
      `/api/v3/treatments?token=${encodeURIComponent(readable)}`,
    );
    expect(queryToken.status).toBe(401);
    const apiSecret = await SELF.fetch(withTenant("/api/v3/treatments", name), {
      headers: { "api-secret": await secretDigest() },
    });
    expect(apiSecret.status).toBe(401);

    const denied = await api3Fetch(
      name,
      readable,
      "/api/v3/treatments",
      jsonMutation("POST", document),
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      status: 403,
      message: "Missing permission api:treatments:create",
    });

    const created = await api3Fetch(
      name,
      createOnly,
      "/api/v3/treatments/auth-treatment",
      jsonMutation("PUT", document),
    );
    expect(created.status).toBe(201);
    const createOnlyUpdate = await api3Fetch(
      name,
      createOnly,
      "/api/v3/treatments/auth-treatment",
      jsonMutation("PUT", { ...document, notes: "must not update" }),
    );
    expect(createOnlyUpdate.status).toBe(403);
    expect(await createOnlyUpdate.json()).toEqual({
      status: 403,
      message: "Missing permission api:treatments:update",
    });

    const missingUpdate = await api3Fetch(
      name,
      updateOnly,
      "/api/v3/treatments/missing-treatment",
      jsonMutation("PUT", { ...document, identifier: "missing-treatment" }),
    );
    expect(missingUpdate.status).toBe(403);
    expect(await missingUpdate.json()).toEqual({
      status: 403,
      message: "Missing permission api:treatments:create",
    });
    expect((await api3Fetch(
      name,
      updateOnly,
      "/api/v3/treatments/missing-treatment",
    )).status).toBe(404);
  });

  it("matches only the eight official routes and preserves extension middleware precedence", async () => {
    const name = tenant("api3-route-extension");
    const jwt = await issueSubject(name, "Extension writer", [
      "api:treatments:create",
      "api:treatments:read",
      "api:treatments:update",
      "api:treatments:delete",
    ]);
    const document = treatment("known-mime-write", "2026-06-01T01:00:00.000Z");

    const malformedUnknown = await api3Fetch(
      name,
      null,
      "/api/v3/treatments.definitely-not-a-mime",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      },
    );
    expect(malformedUnknown.status).toBe(500);
    expect(await malformedUnknown.json()).toEqual({
      status: 500,
      message: "Internal Server Error",
    });

    const unknown = await api3Fetch(
      name,
      null,
      "/api/v3/treatments.definitely-not-a-mime",
      jsonMutation("POST", treatment("unknown-mime-must-not-write", "2026-06-01T02:00:00.000Z")),
    );
    expect(unknown.status).toBe(406);
    expect(unknown.headers.get("Vary")).toBe("Accept");
    expect(await unknown.json()).toEqual({
      status: 406,
      message: "Unsupported output format requested",
    });
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/unknown-mime-must-not-write",
    )).status).toBe(404);

    const knownMimeWrite = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments.ttf",
      jsonMutation("POST", document),
    );
    expect(knownMimeWrite.status).toBe(201);
    expect(knownMimeWrite.headers.get("Content-Type")).toMatch(/application\/json/);
    expect(await knownMimeWrite.json()).toMatchObject({
      status: 201,
      identifier: "known-mime-write",
    });
    const jsonAliasWrite = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments.map",
      jsonMutation(
        "POST",
        treatment("json-alias-write", "2026-06-01T01:30:00.000Z"),
      ),
    );
    expect(jsonAliasWrite.status).toBe(201);
    expect(jsonAliasWrite.headers.get("Content-Type")).toMatch(/application\/json/);
    for (const alias of ["map", "JSON"]) {
      const jsonAliasRead = await api3Fetch(
        name,
        jwt,
        `/api/v3/treatments/json-alias-write.${alias}`,
      );
      expect(jsonAliasRead.status, alias).toBe(200);
      expect(await result<JsonObject>(jsonAliasRead)).toMatchObject({
        identifier: "json-alias-write",
      });
    }
    expect((await api3Fetch(
      name,
      null,
      "/api/v3/treatments/known-mime-write.ttf",
    )).status).toBe(401);
    const knownUnsupported = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/known-mime-write.ttf",
    );
    expect(knownUnsupported.status).toBe(406);
    expect(knownUnsupported.headers.get("Vary")).toBe("Accept");
    const csvSupported = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/known-mime-write.csv",
    );
    expect(csvSupported.status).toBe(200);
    expect(csvSupported.headers.get("Content-Type")).toMatch(/text\/csv/);
    expect(csvSupported.headers.get("Vary")).toBe("Accept");
    expect(await csvSupported.text()).toContain("known-mime-write");
    const acceptXml = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/known-mime-write",
      { headers: { Accept: "application/xml" } },
    );
    expect(acceptXml.status).toBe(200);
    expect(acceptXml.headers.get("Content-Type")).toMatch(/application\/xml/);
    expect(acceptXml.headers.get("Vary")).toBe("Accept");
    expect(await acceptXml.text()).toContain("<identifier>known-mime-write</identifier>");
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/known-mime-write",
      { headers: { Accept: "Application/JSON" } },
    )).status).toBe(200);
    const zeroQuality = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/known-mime-write",
      { headers: { Accept: "application/json;q=0" } },
    );
    expect(zeroQuality.status).toBe(406);
    expect(zeroQuality.headers.get("Vary")).toBe("Accept");

    for (const [path, method] of [
      ["/api/v3/treatments", "PATCH"],
      ["/api/v3/treatments/not-a-post-route", "POST"],
    ] as const) {
      const unmatched = await api3Fetch(
        name,
        null,
        path,
        jsonMutation(method, { notes: "route must not authenticate" }),
      );
      expect(unmatched.status).toBe(404);
      expect(await unmatched.json()).toEqual({
        status: 404,
        message: "Bad operation or collection",
      });
    }
    const genericMissing = await api3Fetch(name, null, "/api/v3/not-implemented");
    expect(await genericMissing.json()).toEqual({
      status: 404,
      message: "Bad operation or collection",
    });
    const primitive = await api3Fetch(name, jwt, "/api/v3/treatments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "42",
    });
    expect(await primitive.json()).toEqual({
      status: 400,
      message: "Bad or missing request body",
    });
  });

  it("orders dynamic permission, existence, precondition, and validation like the locked handlers", async () => {
    const name = tenant("api3-validation-order");
    const reader = await issueSubject(name, "Validation reader", []);
    const creator = await issueSubject(name, "Validation creator", ["api:treatments:create"]);
    const updater = await issueSubject(name, "Validation updater", ["api:treatments:update"]);
    const full = await issueSubject(name, "Validation owner", [
      "api:treatments:create",
      "api:treatments:read",
      "api:treatments:update",
      "api:treatments:delete",
    ]);
    const createdAt = "2026-06-01T03:00:00.000Z";
    const base = treatment("validation-order", createdAt);
    expect((await api3Fetch(
      name,
      full,
      "/api/v3/treatments",
      jsonMutation("POST", base),
    )).status).toBe(201);

    const invalidNew = { identifier: "invalid-new", date: null, utcOffset: 0, app: "test" };
    const deniedBeforeValidation = await api3Fetch(
      name,
      reader,
      "/api/v3/treatments",
      jsonMutation("POST", invalidNew),
    );
    expect(await deniedBeforeValidation.json()).toEqual({
      status: 403,
      message: "Missing permission api:treatments:create",
    });
    const duplicateDeniedBeforeValidation = await api3Fetch(
      name,
      creator,
      "/api/v3/treatments",
      jsonMutation("POST", { identifier: "validation-order", date: null, utcOffset: 0, app: "test" }),
    );
    expect(await duplicateDeniedBeforeValidation.json()).toEqual({
      status: 403,
      message: "Missing permission api:treatments:update",
    });
    const duplicateValidated = await api3Fetch(
      name,
      updater,
      "/api/v3/treatments",
      jsonMutation("POST", { identifier: "validation-order", date: null, utcOffset: 0, app: "test" }),
    );
    expect(duplicateValidated.status).toBe(400);

    const missingPut = await api3Fetch(
      name,
      updater,
      "/api/v3/treatments/missing-validation-put",
      jsonMutation("PUT", invalidNew),
    );
    expect(await missingPut.json()).toEqual({
      status: 403,
      message: "Missing permission api:treatments:create",
    });
    const missingPatch = await api3Fetch(
      name,
      updater,
      "/api/v3/treatments/missing-validation-patch",
      jsonMutation("PATCH", { date: null }),
    );
    expect(await missingPatch.json()).toEqual({ status: 404 });
    const deniedPatch = await api3Fetch(
      name,
      reader,
      "/api/v3/treatments/missing-validation-patch",
      jsonMutation("PATCH", { date: null }),
    );
    expect(await deniedPatch.json()).toEqual({
      status: 403,
      message: "Missing permission api:treatments:update",
    });

    const stalePatch = await api3Fetch(
      name,
      updater,
      "/api/v3/treatments/validation-order",
      jsonMutation("PATCH", { utcOffset: "invalid" }, {
        "If-Unmodified-Since": "Sat, 01 Jan 2000 00:00:00 GMT",
      }),
    );
    expect(await stalePatch.json()).toEqual({ status: 412 });

    expect((await api3Fetch(
      name,
      full,
      "/api/v3/treatments",
      jsonMutation("POST", treatment("readonly-treatment", "2026-06-01T04:00:00.000Z", {
        isReadOnly: true,
      })),
    )).status).toBe(201);
    const readonlyPatch = await api3Fetch(
      name,
      updater,
      "/api/v3/treatments/readonly-treatment",
      jsonMutation("PATCH", { notes: "forbidden by read-only flag" }),
    );
    expect(await readonlyPatch.json()).toEqual({
      status: 422,
      message: "Trying to modify read-only document",
    });

    expect((await api3Fetch(
      name,
      full,
      "/api/v3/treatments/validation-order",
      { method: "DELETE" },
    )).status).toBe(200);
    const gonePatch = await api3Fetch(
      name,
      updater,
      "/api/v3/treatments/validation-order",
      jsonMutation("PATCH", { date: null }),
    );
    expect(await gonePatch.json()).toEqual({ status: 410 });
  });

  it("runs the create, dedupe, read, replace, patch, history, and delete workflow", async () => {
    const name = tenant("api3-workflow");
    const permissions = [
      "api:treatments:create",
      "api:treatments:read",
      "api:treatments:update",
      "api:treatments:delete",
    ];
    const alice = await issueSubject(name, "Alice", permissions);
    const bob = await issueSubject(name, "Bob", permissions);
    const createdAt = "2026-06-02T00:00:00.000Z";
    const document = treatment("workflow-treatment", createdAt, { notes: "created" });

    const created = await api3Fetch(
      name,
      alice,
      "/api/v3/treatments",
      jsonMutation("POST", document),
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json<JsonObject>();
    expect(createdBody).toMatchObject({
      status: 201,
      identifier: "workflow-treatment",
      lastModified: expect.any(Number),
    });
    expect(created.headers.get("Location")).toBe("/api/v3/treatments/workflow-treatment");
    expect(created.headers.get("Last-Modified")).not.toBeNull();
    expect(created.headers.get("Content-Type")).toMatch(/application\/json/);

    const deduplicated = await api3Fetch(
      name,
      alice,
      "/api/v3/treatments",
      jsonMutation("POST", { ...document, notes: "deduplicated" }),
    );
    expect(deduplicated.status).toBe(200);
    expect(await deduplicated.json()).toMatchObject({
      status: 200,
      identifier: "workflow-treatment",
      isDeduplication: true,
    });

    const readCreated = await api3Fetch(
      name,
      alice,
      "/api/v3/treatments/workflow-treatment",
    );
    expect(await result<JsonObject>(readCreated)).toMatchObject({
      identifier: "workflow-treatment",
      notes: "deduplicated",
      subject: "Alice",
      srvCreated: expect.any(Number),
      srvModified: expect.any(Number),
    });
    const readLastModified = readCreated.headers.get("Last-Modified");
    expect(readLastModified).not.toBeNull();
    expect((await api3Fetch(
      name,
      alice,
      "/api/v3/treatments/workflow-treatment",
      { headers: { "If-Modified-Since": String(readLastModified) } },
    )).status).toBe(304);

    const replaced = await api3Fetch(
      name,
      bob,
      "/api/v3/treatments/workflow-treatment",
      jsonMutation("PUT", { ...document, notes: "replaced" }),
    );
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toEqual({
      status: 200,
      lastModified: expect.any(Number),
    });

    const stale = await api3Fetch(
      name,
      alice,
      "/api/v3/treatments/workflow-treatment",
      jsonMutation("PUT", { ...document, notes: "stale overwrite" }, {
        "If-Unmodified-Since": "Sat, 01 Jan 2000 00:00:00 GMT",
      }),
    );
    expect(stale.status).toBe(412);
    expect(await stale.json()).toEqual({ status: 412 });

    const patched = await api3Fetch(
      name,
      alice,
      "/api/v3/treatments/workflow-treatment",
      jsonMutation("PATCH", { notes: "patched" }),
    );
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({ status: 200 });
    expect(await result<JsonObject>(await api3Fetch(
      name,
      alice,
      "/api/v3/treatments/workflow-treatment",
    ))).toMatchObject({
      subject: "Bob",
      modifiedBy: "Alice",
      notes: "patched",
    });

    const lastModified = await result<JsonObject>(await api3Fetch(
      name,
      alice,
      "/api/v3/lastModified",
    ));
    expect(lastModified).toMatchObject({
      srvDate: expect.any(Number),
      collections: { treatments: expect.any(Number) },
    });

    const history = await api3Fetch(
      name,
      alice,
      "/api/v3/treatments/history/946684800001",
    );
    expect((await result<JsonObject[]>(history))).toEqual([
      expect.objectContaining({ identifier: "workflow-treatment", notes: "patched" }),
    ]);
    expect(history.headers.get("ETag")).toMatch(/^W\/"\d+"$/);
    const headerHistory = await api3Fetch(
      name,
      alice,
      "/api/v3/treatments/history",
      { headers: { "Last-Modified": "Sat, 01 Jan 2000 00:00:01 GMT" } },
    );
    expect((await result<JsonObject[]>(headerHistory))).toEqual([
      expect.objectContaining({ identifier: "workflow-treatment", notes: "patched" }),
    ]);

    const softDeleted = await api3Fetch(
      name,
      bob,
      "/api/v3/treatments/workflow-treatment",
      { method: "DELETE" },
    );
    expect(await softDeleted.json()).toEqual({ status: 200 });
    expect((await api3Fetch(
      name,
      alice,
      "/api/v3/treatments/workflow-treatment",
    )).status).toBe(410);
    const search = await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      "/api/v3/treatments",
    ));
    expect(search).toEqual([]);
    const tombstoneHistory = await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      "/api/v3/treatments/history/946684800001",
    ));
    expect(tombstoneHistory).toEqual([
      expect.objectContaining({
        identifier: "workflow-treatment",
        isValid: false,
        modifiedBy: "Bob",
      }),
    ]);

    // Express' repeated scalar becomes an array, so strict === "true" is false.
    const repeatedPermanent = await api3Fetch(
      name,
      bob,
      "/api/v3/treatments/workflow-treatment?permanent=true&permanent=false",
      { method: "DELETE" },
    );
    expect(repeatedPermanent.status).toBe(200);
    expect((await api3Fetch(
      name,
      alice,
      "/api/v3/treatments/workflow-treatment",
    )).status).toBe(410);

    expect((await api3Fetch(
      name,
      bob,
      "/api/v3/treatments/workflow-treatment?permanent=true",
      { method: "DELETE" },
    )).status).toBe(200);
    expect((await api3Fetch(
      name,
      alice,
      "/api/v3/treatments/workflow-treatment",
    )).status).toBe(404);
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      "/api/v3/treatments/history/946684800001",
    ))).toEqual([]);
  });

  it("renders READ, SEARCH, and HISTORY through the locked CSV/XML libraries", async () => {
    const name = tenant("api3-renderers");
    const jwt = await issueSubject(name, "Renderer user", [
      "api:treatments:create",
      "api:treatments:read",
      "api:treatments:delete",
    ]);
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments",
      jsonMutation("POST", treatment(
        "format-treatment",
        "2026-06-02T01:00:00.000Z",
        { notes: "a,b" },
      )),
    )).status).toBe(201);

    const readCsv = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/format-treatment.csv?fields=identifier%2Cnotes",
    );
    expect(readCsv.status).toBe(200);
    expect(readCsv.headers.get("Content-Type")).toMatch(/text\/csv/);
    expect(await readCsv.text()).toBe('identifier,notes\nformat-treatment,"a,b"\n');

    const readXml = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/format-treatment?fields=identifier%2Cnotes",
      { headers: { Accept: "application/xml" } },
    );
    expect(readXml.status).toBe(200);
    expect(await readXml.text()).toContain(
      "<item>\n  <identifier>format-treatment</identifier>\n  <notes>a,b</notes>\n</item>",
    );

    const searchXml = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments.xml?identifier=format-treatment&fields=identifier%2Cnotes",
    );
    expect(searchXml.status).toBe(200);
    expect(await searchXml.text()).toContain(
      "<items>\n  <item>\n    <identifier>format-treatment</identifier>",
    );

    const historyCsv = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/history/946684800001.csv?fields=identifier%2Cnotes",
    );
    expect(historyCsv.status).toBe(200);
    expect(await historyCsv.text()).toBe('identifier,notes\nformat-treatment,"a,b"\n');

    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/format-treatment?permanent=true",
      { method: "DELETE" },
    )).status).toBe(200);
  });

  it("uses the locked single public sort and complete ordered tie-break chain", async () => {
    const name = tenant("api3-sort");
    const jwt = await issueSubject(name, "Sorter", [
      "api:treatments:create",
      "api:treatments:read",
      "api:treatments:update",
    ]);
    const fixtures = [
      ["a-sort", 1, 2, 2],
      ["b-sort", 1, 1, 1],
      ["c-sort", 1, 3, 3],
      ["d-sort", 0, 0, 0],
    ] as const;
    for (const [identifier, rank, commaRank, nestedRank] of fixtures) {
      const response = await api3Fetch(
        name,
        jwt,
        "/api/v3/treatments",
        jsonMutation("POST", treatment(identifier, "2026-06-03T00:00:00.000Z", {
          rank,
          secondary: 9 - rank,
          "rank,secondary": commaRank,
          metrics: { rank: nestedRank },
        })),
      );
      expect(response.status).toBe(201);
    }

    const identifiers = (documents: JsonObject[]): unknown[] =>
      documents.map((document) => document.identifier);
    expect(identifiers(await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments?sort=rank",
    )))).toEqual(["d-sort", "a-sort", "b-sort", "c-sort"]);
    expect(identifiers(await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments?sort%24desc=rank",
    )))).toEqual(["c-sort", "b-sort", "a-sort", "d-sort"]);
    expect(identifiers(await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments?sort=rank&limit=2&skip=1",
    )))).toEqual(["a-sort", "b-sort"]);
    expect(identifiers(await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments?sort=rank&sort=secondary",
    )))).toEqual(["d-sort", "b-sort", "a-sort", "c-sort"]);
    expect(identifiers(await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments?sort=rank%2Csecondary",
    )))).toEqual(["d-sort", "b-sort", "a-sort", "c-sort"]);
    expect(identifiers(await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments?sort=metrics.rank",
    )))).toEqual(["d-sort", "b-sort", "a-sort", "c-sort"]);
    expect(identifiers(await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments?sort=unknownField",
    )))).toEqual(["a-sort", "b-sort", "c-sort", "d-sort"]);

    const combined = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments?sort=rank&sort%24desc=rank",
    );
    expect(combined.status).toBe(400);
    expect(await combined.json()).toEqual({
      status: 400,
      message: "Parameters sort and sort_desc cannot be combined",
    });
  });

  it("preserves legacy materialization, raw srv filters, fallback dedupe, and v1 shape", async () => {
    const name = tenant("api3-legacy");
    const jwt = await issueSubject(name, "Legacy bridge", [
      "api:treatments:create",
      "api:treatments:read",
      "api:treatments:update",
    ]);
    const createdAt = "2026-06-04T00:00:00.000Z";
    const createdAtMillis = Date.parse(createdAt);
    const legacyResponse = await adminWrite(name, "/api/v1/treatments", {
      date: createdAtMillis,
      utcOffset: 0,
      app: "legacy-app",
      device: "legacy-device",
      eventType: "Note",
      created_at: createdAt,
      notes: "legacy row",
    });
    expect(legacyResponse.status).toBe(200);
    const [legacy] = await legacyResponse.json<JsonObject[]>();
    const legacyId = String(legacy?._id);

    const api3Legacy = await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      `/api/v3/treatments/${legacyId}`,
    ));
    expect(api3Legacy).toMatchObject({
      identifier: legacyId,
      srvCreated: createdAtMillis,
      srvModified: createdAtMillis,
    });
    expect(api3Legacy).not.toHaveProperty("_id");
    const params = new URLSearchParams({
      "srvModified$gte": String(createdAtMillis - 1),
    });
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      `/api/v3/treatments?${params.toString()}`,
    ))).toEqual([]);
    expect(await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      "/api/v3/lastModified",
    ))).toMatchObject({ collections: { treatments: createdAtMillis } });

    const deduplicated = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments",
      jsonMutation("POST", {
        identifier: "modern-legacy-bridge",
        date: createdAtMillis,
        utcOffset: 0,
        app: "legacy-app",
        device: "legacy-device",
        eventType: "Note",
        created_at: createdAt,
        notes: "deduplicated through fallback",
      }),
    );
    expect(deduplicated.status).toBe(200);
    expect(await deduplicated.json()).toMatchObject({
      status: 200,
      identifier: "modern-legacy-bridge",
      deduplicatedIdentifier: legacyId,
      isDeduplication: true,
    });

    const legacyList = await SELF.fetch(
      withTenant(`/api/v1/treatments.json?find[_id]=${legacyId}`, name),
    );
    expect(legacyList.status).toBe(200);
    const [legacyShape] = await legacyList.json<JsonObject[]>();
    expect(legacyShape).toMatchObject({
      _id: legacyId,
      identifier: "modern-legacy-bridge",
      notes: "deduplicated through fallback",
    });

    const clientIdCollision = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments",
      jsonMutation("POST", {
        ...treatment("unrelated-client-id", "2026-06-04T01:00:00.000Z"),
        _id: legacyId,
      }),
    );
    expect(clientIdCollision.status).toBe(500);
    expect(await clientIdCollision.json()).toEqual({
      status: 500,
      message: "Database error",
    });
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/unrelated-client-id",
    )).status).toBe(404);
    const unchangedLegacy = await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      `/api/v3/treatments/${legacyId}`,
    ));
    expect(unchangedLegacy).toMatchObject({
      identifier: "modern-legacy-bridge",
      notes: "deduplicated through fallback",
    });
  });

  it("copies the locked history projection header fallback", async () => {
    const name = tenant("api3-history-fields");
    const jwt = await issueSubject(name, "Historian", [
      "api:treatments:create",
      "api:treatments:read",
    ]);
    const createdAt = "2026-06-05T01:02:03.000Z";
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments",
      jsonMutation("POST", treatment("history-fields", createdAt)),
    )).status).toBe(201);

    const fullRead = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/history-fields",
    );
    expect(fullRead.status).toBe(200);
    const fullLastModified = fullRead.headers.get("Last-Modified");
    expect(fullLastModified).not.toBe(new Date(createdAt).toUTCString());
    const projectedRead = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/history-fields?fields=identifier",
    );
    expect(await result<JsonObject>(projectedRead)).toEqual({ identifier: "history-fields" });
    expect(projectedRead.headers.get("Last-Modified")).toBe(new Date(createdAt).toUTCString());
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/history-fields?fields=identifier",
      { headers: { "If-Modified-Since": new Date(createdAt).toUTCString() } },
    )).status).toBe(304);
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/history-fields",
      { headers: { "If-Modified-Since": new Date(createdAt).toUTCString() } },
    )).status).toBe(200);

    const projected = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/history/946684800001?fields=identifier",
    );
    expect(await result<JsonObject[]>(projected)).toEqual([{ identifier: "history-fields" }]);
    expect(projected.headers.get("Last-Modified")).toBe(new Date(createdAt).toUTCString());
    expect(projected.headers.get("ETag")).toBe(`W/"${Date.parse(createdAt)}"`);
  });

  it("returns controlled SQLite query differences without broadening the public API", async () => {
    const name = tenant("api3-query-differences");
    const jwt = await issueSubject(name, "Query user", [
      "api:treatments:create",
      "api:treatments:read",
    ]);
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments",
      jsonMutation("POST", treatment("regex-source", "2026-06-06T00:00:00.000Z", {
        notes: "Meal Bolus",
        rank: 0,
      })),
    )).status).toBe(201);

    const regexParams = new URLSearchParams({ "notes$re": "^Meal" });
    const regex = await api3Fetch(
      name,
      jwt,
      `/api/v3/treatments?${regexParams.toString()}`,
    );
    expect(regex.status).toBe(400);
    expect(await regex.json()).toEqual({
      status: 400,
      message: "Filter operator re is not supported by the SQLite adapter",
    });

    for (const paging of ["limit=.5", "limit=0x10", "skip=.5"]) {
      const response = await api3Fetch(
        name,
        jwt,
        `/api/v3/treatments?${paging}`,
      );
      expect(response.status, paging).toBe(200);
      expect(await result<JsonObject[]>(response)).toEqual([
        expect.objectContaining({ identifier: "regex-source" }),
      ]);
    }
    for (const skip of [1_000_001, Number.MAX_SAFE_INTEGER]) {
      const response = await api3Fetch(
        name,
        jwt,
        `/api/v3/treatments?skip=${skip}`,
      );
      expect(response.status, String(skip)).toBe(200);
      expect(await result<JsonObject[]>(response)).toEqual([]);
    }
    const unsafeSkip = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments?skip=9007199254740992",
    );
    expect(unsafeSkip.status).toBe(400);
    expect(await unsafeSkip.json()).toEqual({
      status: 400,
      message: "Parameter skip out of tolerance",
    });
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments?rank%24gt=1&rank%24lt=1",
    ))).toEqual([
      expect.objectContaining({ identifier: "regex-source", rank: 0 }),
    ]);
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments?isValid=false",
    ))).toEqual([
      expect.objectContaining({ identifier: "regex-source" }),
    ]);

    const unsafe = await api3Fetch(
      name,
      jwt,
      `/api/v3/treatments?sort=${encodeURIComponent('bad"field')}`,
    );
    expect(unsafe.status).toBe(400);
    expect(await unsafe.json()).toEqual({
      status: 400,
      message: 'Invalid sort field bad"field',
    });

    const excessive = new URLSearchParams();
    for (let index = 0; index < 50; index += 1) excessive.set(`field${index}`, String(index));
    const bounded = await api3Fetch(
      name,
      jwt,
      `/api/v3/treatments?${excessive.toString()}`,
    );
    expect(bounded.status).toBe(400);
    expect(await bounded.json()).toMatchObject({
      status: 400,
      message: expect.stringContaining("bound-parameter limit"),
    });

    const format = await api3Fetch(name, jwt, "/api/v3/treatments.ttf");
    expect(format.status).toBe(406);
    expect(await format.json()).toEqual({
      status: 406,
      message: "Unsupported output format requested",
    });
  });

  it("rolls back document, history, and monotonic clock when an HTTP mutation fails", async () => {
    const name = tenant("api3-http-rollback");
    const jwt = await issueSubject(name, "Atomic writer", [
      "api:treatments:create",
      "api:treatments:read",
      "api:treatments:update",
    ]);
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments",
      jsonMutation("POST", treatment("atomic-http", "2026-06-07T00:00:00.000Z", {
        notes: "before failure",
      })),
    )).status).toBe(201);
    const before = await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/atomic-http",
    ));
    const beforeLastModified = await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      "/api/v3/lastModified",
    ));
    const stub = env.ENTRY_STORE.getByName(name);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER fail_api3_http_change
        BEFORE INSERT ON document_changes
        WHEN NEW.collection = 'treatments'
        BEGIN
          SELECT RAISE(ABORT, 'forced API3 HTTP change failure');
        END;
      `);
    });

    const failed = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/atomic-http",
      jsonMutation("PATCH", { notes: "must roll back" }),
    );
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ status: 500, message: "Database error" });
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      state.storage.sql.exec("DROP TRIGGER fail_api3_http_change");
    });

    expect(await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/atomic-http",
    ))).toEqual(before);
    expect((await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      "/api/v3/lastModified",
    ))).collections).toEqual(beforeLastModified.collections);
  });
});
