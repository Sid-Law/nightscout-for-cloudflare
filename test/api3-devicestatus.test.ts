import { env } from "cloudflare:workers";
import { SELF, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { migrateDocumentsV4 } from "../src/document-repository";
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
  return String((await authorization.json<JsonObject>()).token);
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

function deviceStatus(
  identifier: string,
  createdAt: string,
  extra: JsonObject = {},
): JsonObject {
  return {
    identifier,
    date: Date.parse(createdAt),
    app: "api3-devicestatus-test",
    device: "loop://simulator",
    uploaderBattery: 80,
    ...extra,
  };
}

async function result<T = unknown>(response: Response): Promise<T> {
  const body = await response.json<{ status: number; result: T }>();
  expect(body.status).toBe(200);
  return body.result;
}

async function storedDeviceStatusId(tenantName: string, identifier: string): Promise<string> {
  const stub = env.ENTRY_STORE.getByName(tenantName);
  return runInDurableObject(stub, async (_instance: EntryStore, state) => {
    const row = state.storage.sql.exec<{ id: string }>(
      `SELECT id FROM documents
       WHERE collection = 'devicestatus' AND identifier = ?
       ORDER BY updated_at DESC, id ASC LIMIT 1`,
      identifier,
    ).toArray()[0];
    if (row === undefined) throw new Error(`missing devicestatus ${identifier}`);
    return row.id;
  });
}

describe("API v3 devicestatus vertical slice", () => {
  it("requires JWT Bearer auth and enforces collection-specific mutation permissions", async () => {
    const name = tenant("api3-ds-auth");
    const document = deviceStatus("auth-device-status", "2026-07-01T00:00:00.000Z");
    const reader = await issueSubject(name, "Reader", []);
    const creator = await issueSubject(name, "Creator", ["api:devicestatus:create"]);
    const updater = await issueSubject(name, "Updater", ["api:devicestatus:update"]);

    const missing = await api3Fetch(name, null, "/api/v3/devicestatus");
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({
      status: 401,
      message: "Missing or bad access token or JWT",
    });
    expect((await SELF.fetch(withTenant("/api/v3/devicestatus", name), {
      headers: { "api-secret": await secretDigest() },
    })).status).toBe(401);

    const deniedCreate = await api3Fetch(
      name,
      reader,
      "/api/v3/devicestatus",
      jsonMutation("POST", document),
    );
    expect(deniedCreate.status).toBe(403);
    expect(await deniedCreate.json()).toEqual({
      status: 403,
      message: "Missing permission api:devicestatus:create",
    });

    expect((await api3Fetch(
      name,
      creator,
      "/api/v3/devicestatus",
      jsonMutation("POST", document),
    )).status).toBe(201);
    const deniedUpdate = await api3Fetch(
      name,
      creator,
      "/api/v3/devicestatus/auth-device-status",
      jsonMutation("PATCH", { uploaderBattery: 79 }),
    );
    expect(deniedUpdate.status).toBe(403);
    expect(await deniedUpdate.json()).toEqual({
      status: 403,
      message: "Missing permission api:devicestatus:update",
    });

    const deniedUpsert = await api3Fetch(
      name,
      updater,
      "/api/v3/devicestatus/missing-device-status",
      jsonMutation("PUT", {
        ...document,
        identifier: "missing-device-status",
        date: Date.parse("2026-07-01T00:01:00.000Z"),
      }),
    );
    expect(deniedUpsert.status).toBe(403);
    expect(await deniedUpsert.json()).toEqual({
      status: 403,
      message: "Missing permission api:devicestatus:create",
    });
    expect((await api3Fetch(
      name,
      reader,
      "/api/v3/devicestatus/auth-device-status",
    )).status).toBe(200);
  });

  it("runs all eight generic routes through create, search, read, update, patch, history, and delete", async () => {
    const name = tenant("api3-ds-workflow");
    const permissions = [
      "api:devicestatus:create",
      "api:devicestatus:read",
      "api:devicestatus:update",
      "api:devicestatus:delete",
    ];
    const alice = await issueSubject(name, "Alice", permissions);
    const bob = await issueSubject(name, "Bob", permissions);
    const document = deviceStatus(
      "workflow-device-status",
      "2026-07-02T00:00:00.000Z",
      { loop: { name: "Loop", version: "simulated" } },
    );

    const created = await api3Fetch(
      name,
      alice,
      "/api/v3/devicestatus",
      jsonMutation("POST", document),
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      status: 201,
      identifier: "workflow-device-status",
      lastModified: expect.any(Number),
    });
    expect(created.headers.get("Location")).toBe(
      "/api/v3/devicestatus/workflow-device-status",
    );
    expect(created.headers.get("Last-Modified")).not.toBeNull();

    const searched = await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      "/api/v3/devicestatus?device%24eq=loop%3A%2F%2Fsimulator",
    ));
    expect(searched).toEqual([
      expect.objectContaining({ identifier: "workflow-device-status" }),
    ]);

    const readCreated = await api3Fetch(
      name,
      alice,
      "/api/v3/devicestatus/workflow-device-status",
    );
    expect(await result<JsonObject>(readCreated)).toMatchObject({
      identifier: "workflow-device-status",
      date: Date.parse("2026-07-02T00:00:00.000Z"),
      utcOffset: 0,
      created_at: "2026-07-02T00:00:00.000Z",
      subject: "Alice",
      srvCreated: expect.any(Number),
      srvModified: expect.any(Number),
    });
    const readLastModified = readCreated.headers.get("Last-Modified");
    expect(readLastModified).not.toBeNull();
    expect((await api3Fetch(
      name,
      alice,
      "/api/v3/devicestatus/workflow-device-status",
      { headers: { "If-Modified-Since": String(readLastModified) } },
    )).status).toBe(304);

    const replaced = await api3Fetch(
      name,
      bob,
      "/api/v3/devicestatus/workflow-device-status",
      jsonMutation("PUT", { ...document, uploaderBattery: 75 }),
    );
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toEqual({
      status: 200,
      lastModified: expect.any(Number),
    });
    const stale = await api3Fetch(
      name,
      alice,
      "/api/v3/devicestatus/workflow-device-status",
      jsonMutation("PUT", document, {
        "If-Unmodified-Since": "Sat, 01 Jan 2000 00:00:00 GMT",
      }),
    );
    expect(stale.status).toBe(412);

    const patched = await api3Fetch(
      name,
      alice,
      "/api/v3/devicestatus/workflow-device-status",
      jsonMutation("PATCH", { uploaderBattery: 70 }),
    );
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({ status: 200 });
    expect(await result<JsonObject>(await api3Fetch(
      name,
      alice,
      "/api/v3/devicestatus/workflow-device-status",
    ))).toMatchObject({
      uploaderBattery: 70,
      subject: "Bob",
      modifiedBy: "Alice",
    });

    expect(await result<JsonObject>(await api3Fetch(
      name,
      alice,
      "/api/v3/lastModified",
    ))).toMatchObject({
      srvDate: expect.any(Number),
      collections: { devicestatus: expect.any(Number) },
    });
    const history = await api3Fetch(
      name,
      alice,
      "/api/v3/devicestatus/history/946684800001",
    );
    expect(await result<JsonObject[]>(history)).toEqual([
      expect.objectContaining({
        identifier: "workflow-device-status",
        uploaderBattery: 70,
      }),
    ]);
    expect(history.headers.get("ETag")).toMatch(/^W\/"\d+"$/);
    expect((await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      "/api/v3/devicestatus/history",
      { headers: { "Last-Modified": "Sat, 01 Jan 2000 00:00:01 GMT" } },
    ))).length).toBe(1);

    const searchCsv = await api3Fetch(
      name,
      alice,
      "/api/v3/devicestatus.csv?fields=identifier%2CuploaderBattery",
    );
    expect(searchCsv.status).toBe(200);
    expect(searchCsv.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(searchCsv.headers.get("Vary")).toBe("Accept");
    expect(await searchCsv.text()).toBe(
      "identifier,uploaderBattery\nworkflow-device-status,70\n",
    );

    const readXml = await api3Fetch(
      name,
      alice,
      "/api/v3/devicestatus/workflow-device-status?fields=identifier%2CuploaderBattery",
      { headers: { Accept: "application/xml" } },
    );
    expect(readXml.status).toBe(200);
    expect(readXml.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    expect(readXml.headers.get("Vary")).toBe("Accept");
    expect(await readXml.text()).toContain(
      "<item>\n  <identifier>workflow-device-status</identifier>\n"
      + "  <uploaderBattery>70</uploaderBattery>\n</item>",
    );

    expect((await api3Fetch(
      name,
      bob,
      "/api/v3/devicestatus/workflow-device-status",
      { method: "DELETE" },
    )).status).toBe(200);
    expect((await api3Fetch(
      name,
      alice,
      "/api/v3/devicestatus/workflow-device-status",
    )).status).toBe(410);
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      "/api/v3/devicestatus",
    ))).toEqual([]);
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      "/api/v3/devicestatus/history/946684800001",
    ))).toEqual([
      expect.objectContaining({
        identifier: "workflow-device-status",
        isValid: false,
        modifiedBy: "Bob",
      }),
    ]);

    expect((await api3Fetch(
      name,
      bob,
      "/api/v3/devicestatus/workflow-device-status?permanent=true",
      { method: "DELETE" },
    )).status).toBe(200);
    expect((await api3Fetch(
      name,
      alice,
      "/api/v3/devicestatus/workflow-device-status",
    )).status).toBe(404);
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      "/api/v3/devicestatus/history/946684800001",
    ))).toEqual([]);

    expect((await api3Fetch(
      name,
      alice,
      "/api/v3/devicestatus/not/a/route",
    )).status).toBe(404);
  });

  it("reads and fallback-deduplicates v1 devicestatus while preserving v1 shape", async () => {
    const name = tenant("api3-ds-legacy");
    const jwt = await issueSubject(name, "Legacy bridge", [
      "api:devicestatus:create",
      "api:devicestatus:read",
      "api:devicestatus:update",
      "api:devicestatus:delete",
    ]);
    const createdAt = "2026-07-03T01:02:03.000Z";
    const createdAtMillis = Date.parse(createdAt);
    const legacyResponse = await adminWrite(name, "/api/v1/devicestatus", {
      date: createdAtMillis,
      utcOffset: 0,
      app: "legacy-devicestatus-app",
      device: "loop://legacy-simulator",
      created_at: createdAt,
      uploaderBattery: 60,
    });
    expect(legacyResponse.status).toBe(200);
    const [legacy] = await legacyResponse.json<JsonObject[]>();
    const legacyId = String(legacy?._id);

    expect(await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      `/api/v3/devicestatus/${legacyId}`,
    ))).toMatchObject({
      identifier: legacyId,
      srvCreated: createdAtMillis,
      srvModified: createdAtMillis,
      uploaderBattery: 60,
    });
    expect(await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      "/api/v3/lastModified",
    ))).toMatchObject({ collections: { devicestatus: createdAtMillis } });

    const deduplicated = await api3Fetch(
      name,
      jwt,
      "/api/v3/devicestatus",
      jsonMutation("POST", {
        identifier: "modern-device-status",
        date: createdAtMillis,
        utcOffset: 0,
        app: "legacy-devicestatus-app",
        device: "loop://legacy-simulator",
        created_at: createdAt,
        uploaderBattery: 55,
      }),
    );
    expect(deduplicated.status).toBe(200);
    expect(await deduplicated.json()).toMatchObject({
      status: 200,
      identifier: "modern-device-status",
      deduplicatedIdentifier: legacyId,
      isDeduplication: true,
    });

    const legacyList = await SELF.fetch(
      withTenant(`/api/v1/devicestatus.json?find[_id]=${legacyId}`, name),
    );
    expect(legacyList.status).toBe(200);
    expect(await legacyList.json<JsonObject[]>()).toEqual([
      expect.objectContaining({
        _id: legacyId,
        identifier: "modern-device-status",
        uploaderBattery: 55,
      }),
    ]);
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/devicestatus/modern-device-status?permanent=true",
      { method: "DELETE" },
    )).status).toBe(200);
  });

  it("does not PUT or PATCH a modern API3 row through its storage ObjectId", async () => {
    const name = tenant("api3-ds-objectid");
    const jwt = await issueSubject(name, "ObjectId contract", [
      "api:devicestatus:create",
      "api:devicestatus:read",
      "api:devicestatus:update",
      "api:devicestatus:delete",
    ]);
    const original = deviceStatus(
      "public-device-status-id",
      "2026-07-04T00:00:00.000Z",
      { uploaderBattery: 50 },
    );
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/devicestatus",
      jsonMutation("POST", original),
    )).status).toBe(201);
    const storageId = await storedDeviceStatusId(name, "public-device-status-id");
    expect(storageId).toMatch(/^[0-9a-f]{24}$/);

    const patchByStorageId = await api3Fetch(
      name,
      jwt,
      `/api/v3/devicestatus/${storageId}`,
      jsonMutation("PATCH", { uploaderBattery: 49 }),
    );
    expect(patchByStorageId.status).toBe(404);

    const putByStorageId = await api3Fetch(
      name,
      jwt,
      `/api/v3/devicestatus/${storageId}`,
      jsonMutation("PUT", deviceStatus(
        storageId,
        "2026-07-04T00:01:00.000Z",
        { uploaderBattery: 48 },
      )),
    );
    expect(putByStorageId.status).toBe(201);
    expect(await putByStorageId.json()).toMatchObject({
      status: 201,
      identifier: storageId,
    });

    expect(await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      "/api/v3/devicestatus/public-device-status-id",
    ))).toMatchObject({ uploaderBattery: 50 });
    expect(await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      `/api/v3/devicestatus/${storageId}`,
    ))).toMatchObject({ identifier: storageId, uploaderBattery: 48 });
  });

  it("backfills fallback keys for complete pre-slice SQLite rows", async () => {
    const name = tenant("api3-ds-migration");
    const jwt = await issueSubject(name, "Migration bridge", [
      "api:devicestatus:create",
      "api:devicestatus:read",
      "api:devicestatus:update",
    ]);
    const id = "dddddddddddddddddddddddd";
    const createdAt = "2026-07-04T00:00:00.000Z";
    const date = Date.parse(createdAt);
    const body = JSON.stringify({
      _id: id,
      date,
      utcOffset: 0,
      app: "pre-slice-app",
      device: "loop://pre-slice",
      created_at: createdAt,
      uploaderBattery: 50,
    });
    const stub = env.ENTRY_STORE.getByName(name);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      state.storage.sql.exec(
        `INSERT INTO documents
          (collection, id, body, sort_time, created_at, updated_at, identifier,
           identifier_present, srv_created, srv_modified, is_valid, fallback_key,
           revision, srv_metadata_version)
         VALUES ('devicestatus', ?, ?, ?, ?, ?, NULL, 0, NULL, NULL, 1, NULL, 1, 1)`,
        id,
        body,
        date,
        date,
        date,
      );
      state.storage.sql.exec(
        `INSERT INTO document_changes
          (collection, id, identifier, identifier_present, body, srv_created,
           srv_modified, is_valid, revision, operation, srv_metadata_version)
         VALUES ('devicestatus', ?, NULL, 0, ?, NULL, NULL, 1, 1, 'migrate', 1)`,
        id,
        body,
      );
      migrateDocumentsV4(state.storage.sql);
      expect(state.storage.sql.exec<{ fallback_key: string | null }>(
        "SELECT fallback_key FROM documents WHERE collection = 'devicestatus' AND id = ?",
        id,
      ).one().fallback_key).toBe(JSON.stringify([createdAt, "loop://pre-slice"]));
    });

    const deduplicated = await api3Fetch(
      name,
      jwt,
      "/api/v3/devicestatus",
      jsonMutation("POST", {
        identifier: "post-migration-device-status",
        date,
        utcOffset: 0,
        app: "pre-slice-app",
        device: "loop://pre-slice",
        created_at: createdAt,
        uploaderBattery: 45,
      }),
    );
    expect(deduplicated.status).toBe(200);
    expect(await deduplicated.json()).toMatchObject({
      identifier: "post-migration-device-status",
      deduplicatedIdentifier: id,
      isDeduplication: true,
    });
  });
});
