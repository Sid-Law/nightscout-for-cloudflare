import { env } from "cloudflare:workers";
import { SELF, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EntryStore } from "../src/entry-store";
import type {
  RealtimeRootWriteRequest,
  RealtimeRootWriteResult,
} from "../src/realtime/session-service";

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

async function post(tenantName: string, payload: unknown): Promise<JsonObject[]> {
  const response = await SELF.fetch(endpoint("/api/v1/entries/", tenantName), {
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

async function list(tenantName: string): Promise<JsonObject[]> {
  const response = await SELF.fetch(
    endpoint("/api/v1/entries.json?count=100", tenantName),
  );
  expect(response.status).toBe(200);
  return response.json<JsonObject[]>();
}

function entry(
  date: number,
  overrides: JsonObject = {},
): JsonObject {
  return {
    type: "sgv",
    sgv: 120,
    direction: "Flat",
    date,
    dateString: new Date(date).toISOString(),
    device: "TestDevice",
    ...overrides,
  };
}

async function insertLegacyCustomId(
  tenantName: string,
  document: JsonObject,
): Promise<void> {
  const stub = env.ENTRY_STORE.getByName(tenantName) as DurableObjectStub<EntryStore>;
  await runInDurableObject(stub, async (instance) => {
    const write = instance as unknown as {
      realtimeRootWrite(request: RealtimeRootWriteRequest): RealtimeRootWriteResult;
    };
    const result = write.realtimeRootWrite({
      event: "dbAdd",
      collection: "entries",
      data: document,
      receivedAt: Date.now(),
    });
    expect(result.changed).toBe(true);
  });
}

describe("locked Entry sysTime/type deduplication baseline", () => {
  it("TEST-ENTRY-DEDUP-001 updates a replay with the same sysTime and type", async () => {
    const name = tenant("entry-dedup-same");
    const date = Date.now() - 60_000;
    await post(name, entry(date));
    await post(name, entry(date, { sgv: 125, direction: "FortyFiveUp" }));

    expect(await list(name)).toEqual([
      expect.objectContaining({ sgv: 125, direction: "FortyFiveUp" }),
    ]);
  });

  it("TEST-ENTRY-DEDUP-002 preserves different types at the same sysTime", async () => {
    const name = tenant("entry-dedup-types");
    const date = Date.now() - 60_000;
    await post(name, entry(date, { device: "CGM" }));
    await post(name, entry(date, {
      type: "mbg",
      sgv: undefined,
      mbg: 115,
      device: "Meter",
    }));

    const rows = await list(name);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.type).sort()).toEqual(["mbg", "sgv"]);
  });

  it("TEST-ENTRY-DEDUP-003 preserves the same type at different sysTimes", async () => {
    const name = tenant("entry-dedup-times");
    const first = Date.now() - 10 * 60_000;
    await post(name, entry(first));
    await post(name, entry(first + 300_000, { sgv: 130, direction: "FortyFiveUp" }));
    expect(await list(name)).toHaveLength(2);
  });
});

describe("locked Entry UUID _id handling", () => {
  it("TEST-ENTRY-UUID-001 accepts UUID _id on POST", async () => {
    const name = tenant("entry-uuid-create");
    const date = Date.now() - 60_000;
    await post(name, entry(date, {
      _id: "550e8400-e29b-41d4-a716-446655440000",
      device: "Trio",
    }));

    expect(await list(name)).toEqual([
      expect.objectContaining({ sgv: 120, date }),
    ]);
  });

  it("TEST-ENTRY-UUID-002 replays the same UUID through sysTime/type", async () => {
    const name = tenant("entry-uuid-replay");
    const date = Date.now() - 60_000;
    const uuid = "550e8400-e29b-41d4-a716-446655440001";
    await post(name, entry(date, { _id: uuid, device: "Trio" }));
    await post(name, entry(date, {
      _id: uuid,
      sgv: 125,
      direction: "FortyFiveUp",
      device: "Trio",
    }));

    expect(await list(name)).toEqual([
      expect.objectContaining({ sgv: 125, direction: "FortyFiveUp" }),
    ]);
  });

  it("TEST-ENTRY-UUID-003 deduplicates different UUIDs at the same sysTime", async () => {
    const name = tenant("entry-uuid-changed");
    const date = Date.now() - 60_000;
    await post(name, entry(date, {
      _id: "550e8400-e29b-41d4-a716-446655440002",
      device: "Trio",
    }));
    await post(name, entry(date, {
      _id: "550e8400-e29b-41d4-a716-446655440003",
      sgv: 125,
      direction: "FortyFiveUp",
      device: "Trio",
    }));

    expect(await list(name)).toEqual([
      expect.objectContaining({ sgv: 125, direction: "FortyFiveUp" }),
    ]);
  });

  it("TEST-ENTRY-UUID-004 accepts ObjectId, UUID and missing IDs in one batch", async () => {
    const name = tenant("entry-uuid-batch");
    const started = Date.now() - 15 * 60_000;
    await post(name, [
      entry(started, { _id: "507f1f77bcf86cd799439011", sgv: 120, device: "Test" }),
      entry(started + 300_000, {
        _id: "550e8400-e29b-41d4-a716-446655440004",
        sgv: 125,
        device: "Trio",
      }),
      entry(started + 600_000, { sgv: 130, device: "xDrip+" }),
    ]);

    const rows = await list(name);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.sgv).sort()).toEqual([120, 125, 130]);
  });

  it("TEST-ENTRY-UUID-005 updates a pre-fix UUID _id row without duplication", async () => {
    const name = tenant("entry-uuid-prefixed");
    const uuid = "550e8400-e29b-41d4-a716-446655440005";
    const date = Date.now() - 60_000;
    const sysTime = new Date(date).toISOString();
    await insertLegacyCustomId(name, {
      _id: uuid,
      type: "sgv",
      sgv: 120,
      date,
      dateString: sysTime,
      sysTime,
      device: "Trio",
    });

    await post(name, entry(date, {
      _id: uuid,
      sgv: 125,
      direction: "FortyFiveUp",
      device: "Trio",
    }));
    expect(await list(name)).toEqual([
      expect.objectContaining({ _id: uuid, sgv: 125, direction: "FortyFiveUp" }),
    ]);
  });

  it("TEST-ENTRY-UUID-006 preserves UUID as identifier under a server ObjectId", async () => {
    const name = tenant("entry-uuid-identifier");
    const uuid = "550e8400-e29b-41d4-a716-446655440006";
    const date = Date.now() - 60_000;
    await post(name, entry(date, { _id: uuid, device: "Trio" }));

    expect(await list(name)).toEqual([
      expect.objectContaining({
        _id: expect.stringMatching(/^[0-9a-f]{24}$/),
        identifier: uuid,
      }),
    ]);
  });
});
