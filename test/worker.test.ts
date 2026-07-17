import { env } from "cloudflare:workers";
import { SELF, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { EntryStore } from "../src/entry-store";
import type { PublicEntry } from "../src/model";

const TEST_API_SECRET = "nscf-test-secret-20260717";

async function secretDigest(algorithm: "SHA-1" | "SHA-512" = "SHA-1"): Promise<string> {
  const digest = await crypto.subtle.digest(algorithm, new TextEncoder().encode(TEST_API_SECRET));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function entry(sgv: number, date: number, direction = "Flat"): Record<string, unknown> {
  return { sgv, date, direction, device: "nscf-simulator", type: "sgv" };
}

async function post(tenantName: string, payload: unknown, path = "/api/v1/entries"): Promise<Response> {
  return SELF.fetch(`https://example.test${path}?tenant=${tenantName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-secret": await secretDigest() },
    body: JSON.stringify(payload),
  });
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
    expect(html).toContain('src="socket.io/socket.io.js"');

    const bundle = await SELF.fetch("https://example.test/bundle/js/bundle.app.js");
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("Content-Type")).toMatch(/charset=utf-8/i);

    const provenanceResponse = await SELF.fetch("https://example.test/nscf-upstream.json");
    const provenance = await provenanceResponse.json<Record<string, string>>();
    expect(provenance.upstream_release).toBe("v15.0.7");
    expect(provenance.ui_source).toBe("Official Nightscout assets; no NSCF UI implementation");
  });
});

describe("Nightscout phase-one API", () => {
  it("returns the official client startup contract", async () => {
    const response = await SELF.fetch("https://example.test/api/v1/status.json");
    expect(response.status).toBe(200);
    const status = await response.json<Record<string, unknown>>();
    expect(status).toMatchObject({
      name: "Nightscout",
      version: "15.0.7-nscf.1",
      runtimeState: "loaded",
      apiEnabled: true,
      careportalEnabled: false,
    });

    const auth = await SELF.fetch("https://example.test/api/v1/verifyauth");
    expect(await auth.json()).toMatchObject({
      message: {
        canRead: true,
        canWrite: false,
        isAdmin: false,
        permissions: "DEFAULT",
        message: "UNAUTHORIZED",
      },
    });

    const writableAuth = await SELF.fetch("https://example.test/api/v1/verifyauth", {
      headers: { "api-secret": await secretDigest("SHA-512") },
    });
    expect(await writableAuth.json()).toMatchObject({
      message: {
        canRead: true,
        canWrite: true,
        isAdmin: true,
        permissions: "ROLE",
        message: "OK",
      },
    });

    const notifies = await SELF.fetch("https://example.test/api/v1/adminnotifies");
    expect(await notifies.json()).toEqual({ message: { notifies: [], notifyCount: 0 } });
  });

  it("writes an object or array and preserves upstream empty-rejection success", async () => {
    const name = tenant("write");
    const base = Date.now() - 10 * 60_000;
    const first = await post(name, entry(111, base));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual([]);
    expect(first.headers.get("X-NSCF-Inserted")).toBe("1");

    const batch = await post(name, [entry(122, base + 300_000), entry(133, base + 600_000)], "/api/v1/entries.json");
    expect(batch.status).toBe(200);
    expect(batch.headers.get("X-NSCF-Inserted")).toBe("2");

    const history = await SELF.fetch(`https://example.test/api/v1/entries.json?tenant=${name}&count=10`);
    const rows = await history.json<PublicEntry[]>();
    expect(rows.map((row) => row.sgv)).toEqual([133, 122, 111]);
    expect(rows[0]).toMatchObject({ direction: "Flat", device: "nscf-simulator", type: "sgv" });
  });

  it("is idempotent by normalized timestamp and type", async () => {
    const name = tenant("dedupe");
    const date = Date.now() - 60_000;
    const first = await post(name, entry(140, date));
    const retry = await post(name, entry(140, date));
    expect(first.headers.get("X-NSCF-Inserted")).toBe("1");
    expect(retry.headers.get("X-NSCF-Inserted")).toBe("0");
    expect(retry.headers.get("X-NSCF-Duplicates")).toBe("1");

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

    const badCount = await SELF.fetch(`https://example.test/api/v1/entries.json?tenant=${name}&count=1001`);
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
