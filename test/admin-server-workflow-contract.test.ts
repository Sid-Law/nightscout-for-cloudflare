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

async function create(
  tenantName: string,
  path: "/api/v1/entries/" | "/api/v1/treatments/",
  documents: JsonObject[],
): Promise<void> {
  const response = await SELF.fetch(endpoint(path, tenantName), {
    method: "POST",
    headers: {
      "api-secret": await secretDigest(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(documents),
  });
  expect(response.status).toBe(200);
}

async function remove(
  tenantName: string,
  path: string,
  referer?: string,
): Promise<Response> {
  const headers = new Headers({ "api-secret": await secretDigest() });
  if (referer !== undefined) headers.set("Referer", referer);
  return SELF.fetch(endpoint(path, tenantName), { method: "DELETE", headers });
}

describe("official Admin Tools server workflows", () => {
  it("adds the legacy n alias for the official old-Entries cleanup without changing direct API shape", async () => {
    const name = tenant("admin-clean-entries");
    await create(name, "/api/v1/entries/", [
      {
        type: "sgv",
        sgv: 101,
        direction: "Flat",
        device: "admin-contract",
        date: Date.parse("2020-01-01T00:00:00.000Z"),
        dateString: "2020-01-01T00:00:00.000Z",
      },
      {
        type: "sgv",
        sgv: 102,
        direction: "Flat",
        device: "admin-contract",
        date: Date.parse("2030-01-01T00:00:00.000Z"),
        dateString: "2030-01-01T00:00:00.000Z",
      },
    ]);

    const admin = await remove(
      name,
      `/api/v1/entries/?find[date][$lte]=${Date.parse("2020-01-02T00:00:00.000Z")}`,
      "https://example.test/admin/",
    );
    expect(admin.status).toBe(200);
    expect(await admin.json()).toEqual({
      acknowledged: true,
      deletedCount: 1,
      n: 1,
      ok: 1,
    });

    const direct = await remove(
      name,
      `/api/v1/entries/?find[date][$gte]=${Date.parse("2029-12-31T00:00:00.000Z")}`,
    );
    expect(await direct.json()).toEqual({ acknowledged: true, deletedCount: 1 });
  });

  it("adds the legacy n alias for the official old-Treatments cleanup only", async () => {
    const name = tenant("admin-clean-treatments");
    await create(name, "/api/v1/treatments/", [
      { eventType: "Note", notes: "old", created_at: "2020-01-01T00:00:00.000Z" },
      { eventType: "Note", notes: "new", created_at: "2030-01-01T00:00:00.000Z" },
    ]);

    const admin = await remove(
      name,
      "/api/v1/treatments/?find[created_at][$lte]=2020-01-02",
      "https://example.test/admin/",
    );
    expect(admin.status).toBe(200);
    expect(await admin.json()).toEqual({
      acknowledged: true,
      deletedCount: 1,
      n: 1,
      ok: 1,
    });

    const nonAdmin = await remove(
      name,
      "/api/v1/treatments/?find[created_at][$gte]=2029-12-31",
      "https://example.test/profile/",
    );
    expect(await nonAdmin.json()).toEqual({ acknowledged: true, deletedCount: 1 });
  });
});
