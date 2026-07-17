import { env } from "cloudflare:workers";
import { SELF, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { EntryStore } from "../src/entry-store";
import { createJwtSecret, issueJwt, verifyJwt } from "../src/jwt";
import type { PublicEntry } from "../src/model";
import { permissionGroupsAllow } from "../src/permissions";

const TEST_API_SECRET = "nscf-test-secret-20260717";

async function secretDigest(algorithm: "SHA-1" | "SHA-512" = "SHA-1"): Promise<string> {
  const digest = await crypto.subtle.digest(algorithm, new TextEncoder().encode(TEST_API_SECRET));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function entry(sgv: number, date: number, direction = "Flat"): Record<string, unknown> {
  return { sgv, date, direction, device: "simulator", type: "sgv" };
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const encoded = token.split(".")[1];
  if (encoded === undefined) throw new Error("JWT payload is missing");
  const padded = encoded.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    encoded.length + ((4 - (encoded.length % 4)) % 4),
    "=",
  );
  return JSON.parse(atob(padded)) as Record<string, unknown>;
}

async function post(tenantName: string, payload: unknown, path = "/api/v1/entries"): Promise<Response> {
  return SELF.fetch(`https://example.test${path}?tenant=${tenantName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-secret": await secretDigest() },
    body: JSON.stringify(payload),
  });
}

async function writeApi(
  tenantName: string,
  method: "POST" | "PUT" | "DELETE",
  path: string,
  payload?: unknown,
  contentType = "application/json",
): Promise<Response> {
  const separator = path.includes("?") ? "&" : "?";
  const headers: Record<string, string> = { "api-secret": await secretDigest() };
  if (payload !== undefined) headers["Content-Type"] = contentType;
  const init: RequestInit = { method, headers };
  if (payload !== undefined) {
    init.body = contentType === "application/json" ? JSON.stringify(payload) : String(payload);
  }
  return SELF.fetch(`https://example.test${path}${separator}tenant=${tenantName}`, init);
}

describe("official Nightscout UI assets", () => {
  it("serves the upstream homepage and provenance instead of an NSCF UI", async () => {
    const page = await SELF.fetch("https://example.test/");
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Type")).toMatch(/charset=utf-8/i);
    const html = await page.text();
    expect(html).toContain("<title>Nightscout</title>");
    expect(html).toContain('id="chartContainer"');
    expect(html).toContain('/bundle/js/bundle.app.js');
    const bundle = await SELF.fetch("https://example.test/bundle/js/bundle.app.js");
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("Content-Type")).toMatch(/charset=utf-8/i);

    const socketAdapter = await SELF.fetch("https://example.test/socket.io/socket.io.js");
    expect(socketAdapter.status).toBe(200);
    const socketAdapterSource = await socketAdapter.text();
    expect(socketAdapterSource).toContain("/api/v2/ddata/at?");
    expect(socketAdapterSource).toContain("this.poll(true, function afterInitialData()");

    const adapterDigest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(socketAdapterSource),
    );
    const adapterCachebuster = Array.from(
      new Uint8Array(adapterDigest),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("").slice(0, 12);
    expect(html).toContain(`src="/socket.io/socket.io.js?${adapterCachebuster}"`);
    expect(html).toContain(
      `navigator.serviceWorker.register('/sw.js?v15.0.7-7e0e77f88fc1-${adapterCachebuster}'`,
    );

    const serviceWorker = await SELF.fetch("https://example.test/sw.js");
    expect(serviceWorker.status).toBe(200);
    const serviceWorkerSource = await serviceWorker.text();
    expect(serviceWorkerSource).toContain(
      `var CACHE = 'v15.0.7-7e0e77f88fc1-${adapterCachebuster}'`,
    );
    expect(serviceWorkerSource).not.toContain("'/socket.io/socket.io.js'");

    const downstreamArtifact = await SELF.fetch("https://example.test/nscf-upstream.json");
    expect(downstreamArtifact.status).toBe(404);
  });

  it("serves the official upstream secondary pages and clock views", async () => {
    const pages = [
      ["/admin/", "Admin tools: Nightscout"],
      ["/profile/", "Profile Editor: Nightscout"],
      ["/food/", "<title>Food Editor</title>"],
      ["/report/", "<title>Nightscout Reporting</title>"],
      ["/split/", "Nightscout multiframe view"],
      ["/split", "Nightscout multiframe view"],
      ["/clock/clock-color/", 'data-face="clock-color"'],
      ["/clock/cy10-sg35/", 'data-face="cy10-sg35"'],
      ["/api-docs/", 'id="swagger-ui"'],
      ["/api3-docs/", 'url: "/api3-swagger.json"'],
    ] as const;

    for (const [path, marker] of pages) {
      const response = await SELF.fetch(`https://example.test${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("Content-Type"), path).toMatch(/charset=utf-8/i);
      expect(await response.text(), path).toContain(marker);
    }
  });
});

describe("Nightscout compatibility API", () => {
  it("returns the official client startup contract", async () => {
    const response = await SELF.fetch("https://example.test/api/v1/status.json");
    expect(response.status).toBe(200);
    const status = await response.json<Record<string, unknown>>();
    expect(status).toMatchObject({
      name: "Nightscout",
      version: "15.0.7",
      runtimeState: "loaded",
      apiEnabled: true,
      careportalEnabled: true,
    });
    expect(status).not.toHaveProperty("nscf");
    expect(status.version).toBe("15.0.7");

    const auth = await SELF.fetch("https://example.test/api/v1/verifyauth");
    expect(await auth.json()).toEqual({
      status: 200,
      message: {
        canRead: true,
        canWrite: false,
        isAdmin: false,
        permissions: "DEFAULT",
        rolefound: "NOTFOUND",
        message: "UNAUTHORIZED",
      },
    });

    const writableAuth = await SELF.fetch("https://example.test/api/v1/verifyauth", {
      headers: { "api-secret": await secretDigest("SHA-512") },
    });
    expect(await writableAuth.json()).toEqual({
      status: 200,
      message: {
        canRead: true,
        canWrite: true,
        isAdmin: true,
        permissions: "ROLE",
        rolefound: "NOTFOUND",
        message: "OK",
      },
    });

    const rejectedAuth = await SELF.fetch("https://example.test/api/v1/verifyauth", {
      headers: { "api-secret": "not-a-valid-credential" },
    });
    expect(await rejectedAuth.json()).toEqual({
      status: 200,
      message: {
        canRead: false,
        canWrite: false,
        isAdmin: false,
        permissions: "ROLE",
        rolefound: "NOTFOUND",
        message: "UNAUTHORIZED",
      },
    });

    const notifies = await SELF.fetch("https://example.test/api/v1/adminnotifies");
    expect(await notifies.json()).toEqual({ message: { notifies: [], notifyCount: 0 } });
  });

  it("provides the official clock startup scripts and properties shape", async () => {
    const name = tenant("clock");
    const base = Date.now() - 10 * 60_000;
    await post(name, [entry(110, base), entry(123, base + 300_000, "SingleUp")]);

    const statusScript = await SELF.fetch("https://example.test/api/v1/status.js");
    expect(statusScript.status).toBe(200);
    expect(statusScript.headers.get("Content-Type")).toMatch(/application\/javascript/);
    expect(await statusScript.text()).toContain('"version":"15.0.7"');

    const properties = await (
      await SELF.fetch(`https://example.test/api/v2/properties?tenant=${name}`)
    ).json<Record<string, any>>();
    expect(properties).toMatchObject({
      bgnow: {
        sgvs: [{ mgdl: 123, scaled: 123, direction: "SingleUp" }],
      },
      delta: { mgdl: 13, scaled: 13, display: "+13" },
    });
  });

  it("persists food editor records through create, update, filtering and delete", async () => {
    const name = tenant("food");
    const createdResponse = await writeApi(
      name,
      "POST",
      "/api/v1/food/",
      "type=food&name=Rice&category=Meal&portion=100&carbs=28",
      "application/x-www-form-urlencoded",
    );
    expect(createdResponse.status).toBe(200);
    const [created] = await createdResponse.json<Array<Record<string, unknown>>>();
    expect(created?._id).toMatch(/^[0-9a-f]{24}$/);

    const updated = { ...created, name: "Brown Rice", carbs: 24 };
    expect((await writeApi(name, "PUT", "/api/v1/food/", updated)).status).toBe(200);

    const regular = await (
      await SELF.fetch(`https://example.test/api/v1/food/regular.json?tenant=${name}`)
    ).json<Array<Record<string, unknown>>>();
    expect(regular).toMatchObject([{ name: "Brown Rice", carbs: 24 }]);

    expect((await writeApi(name, "DELETE", `/api/v1/food/${created?._id}`)).status).toBe(200);
    expect(
      await (
        await SELF.fetch(`https://example.test/api/v1/food.json?tenant=${name}`)
      ).json(),
    ).toEqual([]);
  });

  it("persists profile editor records and isolates them by tenant", async () => {
    const name = tenant("profile");
    const other = tenant("profile-other");
    const profile = {
      defaultProfile: "Default",
      startDate: new Date().toISOString(),
      units: "mg/dL",
      store: {
        Default: {
          dia: 3,
          timezone: "UTC",
          basal: [{ time: "00:00", value: 0.5 }],
          sens: [{ time: "00:00", value: 50 }],
          carbratio: [{ time: "00:00", value: 10 }],
          target_low: [{ time: "00:00", value: 80 }],
          target_high: [{ time: "00:00", value: 120 }],
        },
      },
    };
    const save = await writeApi(name, "PUT", "/api/v1/profile/", profile);
    expect(save.status).toBe(200);
    const saved = await save.json<Record<string, unknown>>();
    expect(saved._id).toMatch(/^[0-9a-f]{24}$/);

    const current = await (
      await SELF.fetch(`https://example.test/api/v1/profile/current?tenant=${name}`)
    ).json<Record<string, unknown>>();
    expect(current).toMatchObject({ _id: saved._id, defaultProfile: "Default" });
    expect(
      await (
        await SELF.fetch(`https://example.test/api/v1/profile.json?tenant=${other}`)
      ).json(),
    ).toEqual([]);

    await evictDurableObject(env.ENTRY_STORE.getByName(name));
    expect(
      await (
        await SELF.fetch(`https://example.test/api/v1/profile.json?tenant=${name}`)
      ).json(),
    ).toMatchObject([{ _id: saved._id }]);
  });

  it("persists treatments and device status for reports, cleanup tools and live data", async () => {
    const name = tenant("report-data");
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const treatmentResponse = await writeApi(name, "POST", "/api/v1/treatments/", {
      eventType: "Carb Correction",
      carbs: 15,
      created_at: createdAt,
    });
    const [treatment] = await treatmentResponse.json<Array<Record<string, unknown>>>();
    expect(treatment?._id).toMatch(/^[0-9a-f]{24}$/);

    const statusResponse = await writeApi(name, "POST", "/api/v1/devicestatus/", {
      device: "simulator",
      created_at: createdAt,
      uploader: { battery: 80 },
    });
    expect(statusResponse.status).toBe(200);

    const range = encodeURIComponent(new Date(Date.now() - 120_000).toISOString());
    const treatments = await (
      await SELF.fetch(
        `https://example.test/api/v1/treatments.json?tenant=${name}&find[created_at][$gte]=${range}`,
      )
    ).json<Array<Record<string, unknown>>>();
    expect(treatments).toMatchObject([{ eventType: "Carb Correction", carbs: 15 }]);

    const live = await (
      await SELF.fetch(`https://example.test/api/v2/ddata/at?tenant=${name}`)
    ).json<Record<string, any>>();
    expect(live.treatments).toMatchObject([{ _id: treatment?._id }]);
    expect(live.devicestatus).toMatchObject([{ device: "simulator" }]);

    const removed = await writeApi(name, "DELETE", `/api/v1/treatments/${treatment?._id}`);
    expect(await removed.json()).toMatchObject({ n: 1, ok: 1 });
  });

  it("matches the upstream activity create, query, conditional GET, update and delete contract", async () => {
    const name = tenant("activity");
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const createdResponse = await writeApi(name, "POST", "/api/v1/activity/", {
      created_at: createdAt,
      heartrate: 85,
      steps: 1500,
      activitylevel: "moderate",
    });
    expect(createdResponse.status).toBe(200);
    const created = await createdResponse.json<Array<Record<string, unknown>>>();
    expect(created).toMatchObject([
      {
        created_at: createdAt,
        heartrate: 85,
        steps: 1500,
        activitylevel: "moderate",
      },
    ]);
    expect(created[0]?._id).toMatch(/^[0-9a-f]{24}$/);

    const listed = await SELF.fetch(
      `https://example.test/api/v1/activity?tenant=${name}&find[created_at][$gte]=${encodeURIComponent(
        new Date(Date.now() - 120_000).toISOString(),
      )}`,
    );
    expect(listed.status).toBe(200);
    expect(listed.headers.get("Last-Modified")).not.toBeNull();
    expect(await listed.json()).toMatchObject([{ _id: created[0]?._id }]);

    const conditional = await SELF.fetch(
      `https://example.test/api/v1/activity?tenant=${name}`,
      { headers: { "If-Modified-Since": new Date().toUTCString() } },
    );
    expect(conditional.status).toBe(304);

    const updated = { ...created[0], heartrate: 92 };
    const updateResponse = await writeApi(name, "PUT", "/api/v1/activity/", updated);
    expect(await updateResponse.json()).toMatchObject({ _id: created[0]?._id, heartrate: 92 });

    const putCreatedResponse = await writeApi(name, "PUT", "/api/v1/activity/", {
      created_at: new Date(Date.now() - 30_000).toISOString(),
      heartrate: 78,
      steps: 750,
    });
    expect(putCreatedResponse.status).toBe(200);
    const putCreated = await putCreatedResponse.json<Record<string, unknown>>();
    expect(putCreated).toMatchObject({ heartrate: 78, steps: 750 });
    expect(putCreated._id).toMatch(/^[0-9a-f]{24}$/);

    const removed = await writeApi(name, "DELETE", `/api/v1/activity/${created[0]?._id}`);
    expect(await removed.json()).toEqual({});
    const removedPut = await writeApi(name, "DELETE", `/api/v1/activity/${putCreated._id}`);
    expect(await removedPut.json()).toEqual({});
    expect(
      await (
        await SELF.fetch(`https://example.test/api/v1/activity?tenant=${name}`)
      ).json(),
    ).toEqual([]);

    const empty = await writeApi(name, "POST", "/api/v1/activity/", []);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);
  });

  it("serves the public upstream API v3 version envelope with SQLite storage metadata", async () => {
    const response = await SELF.fetch("https://example.test/api/v3/version");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 200,
      result: {
        version: "15.0.7",
        apiVersion: "3.0.3-alpha",
        srvDate: expect.any(Number),
        storage: {
          storage: "sqlite-durable-object",
          version: expect.any(String),
        },
      },
    });
  });

  it("persists admin roles and subjects and authorizes their access tokens", async () => {
    const name = tenant("admin");
    const roleResponse = await writeApi(name, "POST", "/api/v2/authorization/roles", {
      name: "uploader",
      permissions: ["api:entries:create"],
    });
    expect(roleResponse.status).toBe(200);

    const subjectResponse = await writeApi(name, "POST", "/api/v2/authorization/subjects", {
      name: "Phone",
      roles: ["uploader"],
    });
    const subject = await subjectResponse.json<Record<string, unknown>>();
    expect(subject.accessToken).toEqual(expect.any(String));

    const authorized = await SELF.fetch(
      `https://example.test/api/v2/authorization/request/${subject.accessToken}?tenant=${name}`,
    );
    const authorization = await authorized.json<Record<string, unknown>>();
    expect(authorization).toMatchObject({
      token: expect.stringMatching(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
      sub: "Phone",
      permissionGroups: [["api:entries:create"], ["*:*:read"]],
      iat: expect.any(Number),
      exp: expect.any(Number),
    });
    const jwt = String(authorization.token);
    expect(decodeJwtPayload(jwt)).toMatchObject({
      accessToken: subject.accessToken,
      iat: authorization.iat,
      exp: authorization.exp,
    });
    expect(Number(authorization.exp) - Number(authorization.iat)).toBe(8 * 60 * 60);

    const refreshed = await SELF.fetch(
      `https://example.test/api/v2/authorization/request/${encodeURIComponent(jwt)}?tenant=${name}`,
    );
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({
      token: expect.stringMatching(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
      sub: "Phone",
      permissionGroups: [["api:entries:create"], ["*:*:read"]],
    });

    const rejectedIssuance = await SELF.fetch(
      `https://example.test/api/v2/authorization/request/not-a-subject?tenant=${name}`,
    );
    expect(rejectedIssuance.status).toBe(401);
    expect(await rejectedIssuance.json()).toEqual({
      status: 401,
      message: "Unauthorized",
      description: "Invalid/Missing",
    });

    const tokenAuth = await SELF.fetch(
      `https://example.test/api/v1/verifyauth?tenant=${name}&token=${subject.accessToken}`,
    );
    expect(await tokenAuth.json()).toEqual({
      status: 200,
      message: {
        canRead: true,
        canWrite: false,
        isAdmin: false,
        permissions: "ROLE",
        rolefound: "FOUND",
        message: "OK",
      },
    });

    const bearerAuth = await SELF.fetch(
      `https://example.test/api/v1/verifyauth?tenant=${name}`,
      { headers: { Authorization: `Bearer ${jwt}` } },
    );
    expect(await bearerAuth.json()).toEqual({
      status: 200,
      message: {
        canRead: true,
        canWrite: false,
        isAdmin: false,
        permissions: "ROLE",
        rolefound: "FOUND",
        message: "OK",
      },
    });

    const rawBearer = await SELF.fetch(
      `https://example.test/api/v3/status?tenant=${name}`,
      { headers: { Authorization: `Bearer ${subject.accessToken}` } },
    );
    expect(rawBearer.status).toBe(401);

    const missingV3Token = await SELF.fetch(
      `https://example.test/api/v3/status?tenant=${name}`,
    );
    expect(missingV3Token.status).toBe(401);
    expect(await missingV3Token.json()).toEqual({
      status: 401,
      message: "Missing or bad access token or JWT",
    });

    const invalidV3Token = await SELF.fetch(
      `https://example.test/api/v3/status?tenant=${name}`,
      { headers: { Authorization: "Bearer invalid-token" } },
    );
    expect(invalidV3Token.status).toBe(401);
    expect(await invalidV3Token.json()).toEqual({
      status: 401,
      message: "Bad access token or JWT",
    });

    const malformedV3Header = await SELF.fetch(
      `https://example.test/api/v3/status?tenant=${name}`,
      { headers: { Authorization: "Bearer  invalid-token" } },
    );
    expect(await malformedV3Header.json()).toEqual({
      status: 401,
      message: "Missing or bad access token or JWT",
    });

    const status = await SELF.fetch(
      `https://example.test/api/v3/status?tenant=${name}`,
      { headers: { Authorization: `bearer ${jwt}` } },
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      status: 200,
      result: {
        version: "15.0.7",
        apiVersion: "3.0.3-alpha",
        srvDate: expect.any(Number),
        apiPermissions: {
          devicestatus: "r",
          entries: "r",
          food: "r",
          profile: "r",
          settings: "r",
          treatments: "r",
        },
      },
    });

    await evictDurableObject(env.ENTRY_STORE.getByName(name));
    expect(
      (
        await SELF.fetch(`https://example.test/api/v3/status?tenant=${name}`, {
          headers: { Authorization: `Bearer ${jwt}` },
        })
      ).status,
    ).toBe(200);

    const otherTenant = tenant("admin-other");
    expect(
      (
        await SELF.fetch(`https://example.test/api/v3/status?tenant=${otherTenant}`, {
          headers: { Authorization: `Bearer ${jwt}` },
        })
      ).status,
    ).toBe(401);

    const jwtWrite = await SELF.fetch(
      `https://example.test/api/v1/entries?tenant=${name}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(entry(144, Date.now() - 120_000)),
      },
    );
    expect(jwtWrite.status).toBe(200);

    const opaqueTokenWrite = await SELF.fetch(
      `https://example.test/api/v1/entries?tenant=${name}`,
      {
        method: "POST",
        headers: {
          "api-secret": String(subject.accessToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(entry(145, Date.now() - 60_000)),
      },
    );
    expect(opaqueTokenWrite.status).toBe(200);

    const deleted = await writeApi(
      name,
      "DELETE",
      `/api/v2/authorization/subjects/${String(subject._id)}`,
    );
    expect(deleted.status).toBe(200);
    expect(
      (
        await SELF.fetch(`https://example.test/api/v3/status?tenant=${name}`, {
          headers: { Authorization: `Bearer ${jwt}` },
        })
      ).status,
    ).toBe(401);
  });

  it("writes an object or array and preserves upstream empty-rejection success", async () => {
    const name = tenant("write");
    const base = Date.now() - 10 * 60_000;
    const first = await post(name, entry(111, base));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual([]);

    const batch = await post(name, [entry(122, base + 300_000), entry(133, base + 600_000)], "/api/v1/entries.json");
    expect(batch.status).toBe(200);

    const history = await SELF.fetch(`https://example.test/api/v1/entries.json?tenant=${name}&count=10`);
    const rows = await history.json<PublicEntry[]>();
    expect(rows.map((row) => row.sgv)).toEqual([133, 122, 111]);
    expect(rows[0]).toMatchObject({ direction: "Flat", device: "simulator", type: "sgv" });
  });

  it("is idempotent by normalized timestamp and type", async () => {
    const name = tenant("dedupe");
    const date = Date.now() - 60_000;
    const first = await post(name, entry(140, date));
    const retry = await post(name, entry(140, date));
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);

    const rows = await (
      await SELF.fetch(`https://example.test/api/v1/entries.json?tenant=${name}&count=10`)
    ).json<PublicEntry[]>();
    expect(rows).toHaveLength(1);
  });

  it("supports current plus count and Nightscout date-range operators", async () => {
    const name = tenant("range");
    const base = Date.now() - 30 * 60_000;
    await post(name, [entry(100, base), entry(110, base + 300_000), entry(120, base + 600_000)]);

    const current = await (
      await SELF.fetch(`https://example.test/api/v1/entries/current.json?tenant=${name}`)
    ).json<PublicEntry[]>();
    expect(current.map((row) => row.sgv)).toEqual([120]);

    const query = new URLSearchParams({
      tenant: name,
      count: "1",
      "find[date][$gte]": String(base + 300_000),
      "find[date][$lte]": String(base + 600_000),
    });
    const filtered = await (
      await SELF.fetch(`https://example.test/api/v1/entries.json?${query.toString()}`)
    ).json<PublicEntry[]>();
    expect(filtered.map((row) => row.sgv)).toEqual([120]);
  });

  it("isolates tenants into separate Durable Object SQLite databases", async () => {
    const alpha = tenant("alpha");
    const beta = tenant("beta");
    const date = Date.now() - 60_000;
    await post(alpha, entry(101, date));
    await post(beta, entry(202, date));

    const alphaRows = await (
      await SELF.fetch(`https://example.test/api/v1/entries.json?tenant=${alpha}`)
    ).json<PublicEntry[]>();
    const betaRows = await (
      await SELF.fetch(`https://example.test/api/v1/entries.json?tenant=${beta}`)
    ).json<PublicEntry[]>();
    expect(alphaRows.map((row) => row.sgv)).toEqual([101]);
    expect(betaRows.map((row) => row.sgv)).toEqual([202]);
  });

  it("persists SQLite rows across Durable Object eviction", async () => {
    const name = tenant("persist");
    await post(name, entry(155, Date.now() - 60_000));
    const stub = env.ENTRY_STORE.getByName(name);

    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      const count = state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM entries").one().count;
      expect(count).toBe(1);
      expect(state.storage.sql.databaseSize).toBeGreaterThan(0);
    });

    await evictDurableObject(stub);
    const rows = await (
      await SELF.fetch(`https://example.test/api/v1/entries.json?tenant=${name}`)
    ).json<PublicEntry[]>();
    expect(rows.map((row) => row.sgv)).toEqual([155]);
  });

  it("rejects invalid SGV, JSON, query and tenant input", async () => {
    const name = tenant("invalid");
    expect((await post(name, entry(10, Date.now()))).status).toBe(400);
    expect((await post(name, { sgv: 100 })).status).toBe(400);

    const malformed = await SELF.fetch(`https://example.test/api/v1/entries?tenant=${name}`, {
      method: "POST",
      headers: { "api-secret": await secretDigest() },
      body: "{",
    });
    expect(malformed.status).toBe(400);

    const badCount = await SELF.fetch(`https://example.test/api/v1/entries.json?tenant=${name}&count=10001`);
    expect(badCount.status).toBe(400);

    const badTenant = await SELF.fetch("https://example.test/api/v1/entries.json?tenant=Not%20Safe");
    expect(badTenant.status).toBe(400);
  });

  it("requires a hashed Nightscout API_SECRET and fails closed when it is absent", async () => {
    const name = tenant("auth");
    const target = `https://example.test/api/v1/entries?tenant=${name}`;
    const body = JSON.stringify(entry(123, Date.now() - 60_000));

    expect((await SELF.fetch(target, { method: "POST", body })).status).toBe(401);
    expect(
      (await SELF.fetch(target, { method: "POST", headers: { "api-secret": TEST_API_SECRET }, body })).status,
    ).toBe(401);
    expect(
      (await SELF.fetch(target, { method: "POST", headers: { "api-secret": "0".repeat(40) }, body })).status,
    ).toBe(401);
    expect(
      (await SELF.fetch(`${target}&secret=${await secretDigest("SHA-512")}`, { method: "POST", body })).status,
    ).toBe(200);

    const missingBinding = await worker.fetch(
      new Request(target, { method: "POST", body }),
      {} as Env,
    );
    expect(missingBinding.status).toBe(503);
    expect(await missingBinding.json()).toMatchObject({ error: { code: "api_secret_not_configured" } });
  });
});

describe("upstream Shiro permission adapter", () => {
  it("preserves implicit suffixes, wildcard segments, and comma branches", () => {
    expect(permissionGroupsAllow([["api:entries"]], "api:entries:create")).toBe(true);
    expect(
      permissionGroupsAllow(
        [["api:food,treatments:create"]],
        "api:treatments:create",
      ),
    ).toBe(true);
    expect(
      permissionGroupsAllow(
        [["api:*:create,update,delete"]],
        "api:entries:update",
      ),
    ).toBe(true);
    expect(
      permissionGroupsAllow(
        [["api:*:create,update,delete"]],
        "api:entries:read",
      ),
    ).toBe(false);
    expect(
      permissionGroupsAllow(
        [["newsletter:view,create,edit,delete"]],
        "newsletter:view,create,any,edit,delete",
      ),
    ).toBe(false);
  });
});

describe("tenant JWT adapter", () => {
  it("signs HS256 claims and rejects tampering and expiration", async () => {
    const secret = createJwtSecret();
    const issued = await issueJwt(secret, "subject-access-token", 1_000_000);
    expect(await verifyJwt(secret, issued.token, 1_000_001)).toEqual({
      accessToken: "subject-access-token",
      iat: 1_000_000,
      exp: 1_000_000 + 8 * 60 * 60,
    });

    const [header, payload, signature] = issued.token.split(".");
    expect(header).toBeDefined();
    expect(payload).toBeDefined();
    expect(signature).toBeDefined();
    const tamperedSignature = `${signature![0] === "A" ? "B" : "A"}${signature!.slice(1)}`;
    expect(
      await verifyJwt(secret, `${header}.${payload}.${tamperedSignature}`, 1_000_001),
    ).toBeNull();
    expect(await verifyJwt(secret, issued.token, issued.exp)).toBeNull();
    expect(await verifyJwt(createJwtSecret(), issued.token, 1_000_001)).toBeNull();
  });
});
