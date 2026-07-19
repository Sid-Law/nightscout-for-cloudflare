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
  const roleName = `shape-role-${crypto.randomUUID().slice(0, 8)}`;
  const permissions = ["treatments", "entries", "devicestatus"].flatMap(
    (collection) => ["create", "read", "update", "delete"].map(
      (action) => `api:${collection}:${action}`,
    ),
  );
  expect((await adminWrite(tenantName, "/api/v2/authorization/roles", {
    name: roleName,
    permissions,
  })).status).toBe(200);
  const subjectResponse = await adminWrite(
    tenantName,
    "/api/v2/authorization/subjects",
    { name: "Shape owner", roles: [roleName] },
  );
  expect(subjectResponse.status).toBe(200);
  const created = await subjectResponse.json<JsonObject>();
  const subjectsResponse = await SELF.fetch(
    `https://example.test/api/v2/authorization/subjects?tenant=${tenantName}`,
    { headers: { "api-secret": await secretDigest() } },
  );
  const subject = (await subjectsResponse.json<JsonObject[]>()).find(
    (candidate) => candidate._id === created._id,
  );
  if (subject === undefined) throw new Error("created shape subject was not listed");
  const authorization = await SELF.fetch(
    `https://example.test/api/v2/authorization/request/${encodeURIComponent(String(subject.accessToken))}?tenant=${tenantName}`,
  );
  expect(authorization.status).toBe(200);
  return String((await authorization.json<JsonObject>()).token);
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

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function readResult(response: Response): Promise<JsonObject> {
  expect(response.status).toBe(200);
  const body = await response.json<{ status: number; result: JsonObject }>();
  expect(body.status).toBe(200);
  return body.result;
}

describe("locked API3 request-shape compatibility", () => {
  it("represents every locked api3.shape-handling contract on the Workers runtime", async () => {
    const name = tenant("api3-shape-file");
    const jwt = await issueSubject(name);
    const now = Date.now() - 60_000;
    const fixtures: Array<{ collection: string; document: JsonObject }> = [
      {
        collection: "treatments",
        document: {
          date: now,
          utcOffset: 0,
          app: "api3-shape-test",
          device: "shape-treatment",
          eventType: "Note",
          notes: "single object test",
        },
      },
      {
        collection: "entries",
        document: {
          date: now + 1_000,
          utcOffset: 0,
          app: "api3-shape-test",
          device: "shape-entry",
          type: "sgv",
          sgv: 120,
          direction: "Flat",
        },
      },
      {
        collection: "devicestatus",
        document: {
          date: now + 2_000,
          utcOffset: 0,
          app: "api3-shape-test",
          device: "shape-status",
          uploaderBattery: 85,
        },
      },
    ];

    for (const { collection, document } of fixtures) {
      const arrayResponse = await api3Fetch(
        name,
        jwt,
        `/api/v3/${collection}`,
        post([document, { ...document, date: Number(document.date) + 10_000 }]),
      );
      expect(arrayResponse.status, collection).toBe(400);
      expect(await arrayResponse.json(), collection).toEqual({
        status: 400,
        message: "Bad or missing request body",
      });

      const created = await api3Fetch(name, jwt, `/api/v3/${collection}`, post(document));
      expect(created.status, collection).toBe(201);
      const createdBody = await created.json<JsonObject>();
      expect(Array.isArray(createdBody), collection).toBe(false);
      expect(createdBody).toMatchObject({
        status: 201,
        identifier: expect.any(String),
      });
      const identifier = String(createdBody.identifier);
      const actual = await readResult(await api3Fetch(
        name,
        jwt,
        `/api/v3/${collection}/${encodeURIComponent(identifier)}`,
      ));
      expect(actual).toMatchObject({ ...document, identifier });

      expect((await api3Fetch(
        name,
        jwt,
        `/api/v3/${collection}/${encodeURIComponent(identifier)}?permanent=true`,
        { method: "DELETE" },
      )).status).toBe(200);
    }

    for (const body of [[], {}]) {
      const rejected = await api3Fetch(name, jwt, "/api/v3/treatments", post(body));
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({
        status: 400,
        message: "Bad or missing request body",
      });
    }

    const dedupDocument = {
      date: now + 20_000,
      utcOffset: 0,
      app: "api3-shape-test",
      device: "shape-dedup",
      eventType: "Note",
      notes: "original note",
    };
    const first = await api3Fetch(name, jwt, "/api/v3/treatments", post(dedupDocument));
    expect(first.status).toBe(201);
    const firstBody = await first.json<JsonObject>();
    const identifier = String(firstBody.identifier);
    const second = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments",
      post({ ...dedupDocument, notes: "updated note" }),
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      status: 200,
      identifier,
      isDeduplication: true,
    });
    expect(await readResult(await api3Fetch(
      name,
      jwt,
      `/api/v3/treatments/${encodeURIComponent(identifier)}`,
    ))).toMatchObject({ identifier, notes: "updated note" });
  });
});
