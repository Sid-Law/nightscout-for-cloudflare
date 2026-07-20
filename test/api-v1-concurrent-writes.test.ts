import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const TEST_API_SECRET = "nscf-test-secret-20260717";

type JsonObject = Record<string, unknown>;
type LegacyCollection = "devicestatus" | "entries" | "treatments";

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function endpoint(path: string, tenantName: string): string {
  return `https://example.test${path}${path.includes("?") ? "&" : "?"}tenant=${tenantName}`;
}

let digestPromise: Promise<string> | undefined;
function secretDigest(): Promise<string> {
  digestPromise ??= crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(TEST_API_SECRET),
  ).then((digest) => Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join(""));
  return digestPromise;
}

async function post(
  tenantName: string,
  collection: LegacyCollection,
  payload: unknown,
): Promise<JsonObject[]> {
  const response = await SELF.fetch(endpoint(`/api/v1/${collection}/`, tenantName), {
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

async function list(
  tenantName: string,
  collection: LegacyCollection,
  count = 200,
): Promise<JsonObject[]> {
  const response = await SELF.fetch(endpoint(
    `/api/v1/${collection}.json?count=${count}`,
    tenantName,
  ));
  expect(response.status).toBe(200);
  return response.json<JsonObject[]>();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("locked Nightscout v15.0.7 concurrent-writes.test.js contract", () => {
  it("handles 5 simultaneous single object POSTs to treatments", async () => {
    const name = tenant("concurrent-treatment-single");
    const baseTime = Date.now() - 60_000;
    const results = await Promise.all(Array.from({ length: 5 }, (_, index) =>
      post(name, "treatments", {
        eventType: "Note",
        created_at: new Date(baseTime + index * 1_000).toISOString(),
        notes: `concurrent single ${index}`,
      })));

    expect(results).toHaveLength(5);
    results.forEach((result) => expect(result.length).toBeGreaterThanOrEqual(1));
    expect((await list(name, "treatments")).length).toBeGreaterThanOrEqual(5);
  });

  it("handles 5 simultaneous array POSTs to treatments", async () => {
    const name = tenant("concurrent-treatment-array");
    const baseTime = Date.now() - 60_000;
    const results = await Promise.all(Array.from({ length: 5 }, (_, index) =>
      post(name, "treatments", [
        {
          eventType: "Note",
          created_at: new Date(baseTime + index * 10_000).toISOString(),
          notes: `concurrent array batch ${index} item 1`,
        },
        {
          eventType: "Note",
          created_at: new Date(baseTime + index * 10_000 + 1_000).toISOString(),
          notes: `concurrent array batch ${index} item 2`,
        },
      ])));

    expect(results).toHaveLength(5);
    expect(results.reduce((total, result) => total + result.length, 0)).toBe(10);
    expect((await list(name, "treatments")).length).toBeGreaterThanOrEqual(10);
  });

  it("handles rapid sequential treatment POSTs (10 in 100ms)", async () => {
    const name = tenant("concurrent-treatment-rapid");
    const baseTime = Date.now() - 60_000;
    const results = await Promise.all(Array.from({ length: 10 }, async (_, index) => {
      await delay(index * 10);
      return post(name, "treatments", {
        eventType: "Note",
        created_at: new Date(baseTime + index * 100).toISOString(),
        notes: `rapid sequential ${index}`,
      });
    }));

    expect(results).toHaveLength(10);
    results.forEach((result) => expect(Array.isArray(result)).toBe(true));
    expect((await list(name, "treatments")).length).toBeGreaterThanOrEqual(10);
  });

  it("handles 5 simultaneous single object POSTs to devicestatus", async () => {
    const name = tenant("concurrent-device-single");
    const baseTime = Date.now() - 60_000;
    const results = await Promise.all(Array.from({ length: 5 }, (_, index) =>
      post(name, "devicestatus", {
        device: `concurrent-device-${index}`,
        created_at: new Date(baseTime + index * 1_000).toISOString(),
        uploaderBattery: 80 + index,
      })));

    expect(results).toHaveLength(5);
    results.forEach((result) => expect(result).toHaveLength(1));
    expect((await list(name, "devicestatus")).length).toBeGreaterThanOrEqual(5);
  });

  it("handles 5 simultaneous array POSTs to devicestatus", async () => {
    const name = tenant("concurrent-device-array");
    const baseTime = Date.now() - 60_000;
    const results = await Promise.all(Array.from({ length: 5 }, (_, index) =>
      post(name, "devicestatus", [
        {
          device: `concurrent-batch-${index}-a`,
          created_at: new Date(baseTime + index * 10_000).toISOString(),
          uploaderBattery: 70 + index,
        },
        {
          device: `concurrent-batch-${index}-b`,
          created_at: new Date(baseTime + index * 10_000 + 1_000).toISOString(),
          uploaderBattery: 75 + index,
        },
      ])));

    expect(results).toHaveLength(5);
    expect(results.reduce((total, result) => total + result.length, 0)).toBe(10);
    expect((await list(name, "devicestatus")).length).toBeGreaterThanOrEqual(10);
  });

  it("handles 5 simultaneous single entry POSTs", async () => {
    const name = tenant("concurrent-entry-single");
    const baseTime = Date.now() - 60_000;
    const results = await Promise.all(Array.from({ length: 5 }, (_, index) => {
      const date = baseTime + index * 300_000;
      return post(name, "entries", {
        type: "sgv",
        sgv: 100 + index * 5,
        date,
        dateString: new Date(date).toISOString(),
      });
    }));

    expect(results).toHaveLength(5);
    results.forEach((result) => expect(Array.isArray(result)).toBe(true));
    expect((await list(name, "entries")).length).toBeGreaterThanOrEqual(5);
  });

  it("handles 5 simultaneous array entry POSTs", async () => {
    const name = tenant("concurrent-entry-array");
    const baseTime = Date.now() - 60_000;
    const results = await Promise.all(Array.from({ length: 5 }, (_, index) => {
      const firstDate = baseTime + index * 1_000_000;
      const secondDate = firstDate + 300_000;
      return post(name, "entries", [
        {
          type: "sgv",
          sgv: 100 + index * 10,
          date: firstDate,
          dateString: new Date(firstDate).toISOString(),
        },
        {
          type: "sgv",
          sgv: 105 + index * 10,
          date: secondDate,
          dateString: new Date(secondDate).toISOString(),
        },
      ]);
    }));

    expect(results).toHaveLength(5);
    expect(results.reduce((total, result) => total + result.length, 0)).toBe(10);
    expect((await list(name, "entries")).length).toBeGreaterThanOrEqual(10);
  });

  it("handles simultaneous writes to treatments, devicestatus, and entries", async () => {
    const name = tenant("concurrent-cross-collection");
    const baseTime = Date.now() - 60_000;
    const [treatments, statuses, entries] = await Promise.all([
      post(name, "treatments", [
        { eventType: "Note", created_at: new Date(baseTime).toISOString(), notes: "cross-collection 1" },
        { eventType: "Note", created_at: new Date(baseTime + 1_000).toISOString(), notes: "cross-collection 2" },
      ]),
      post(name, "devicestatus", [
        { device: "cross-device-1", created_at: new Date(baseTime).toISOString(), uploaderBattery: 80 },
        { device: "cross-device-2", created_at: new Date(baseTime + 1_000).toISOString(), uploaderBattery: 75 },
      ]),
      post(name, "entries", [
        { type: "sgv", sgv: 120, date: baseTime, dateString: new Date(baseTime).toISOString() },
        { type: "sgv", sgv: 125, date: baseTime + 300_000, dateString: new Date(baseTime + 300_000).toISOString() },
      ]),
    ]);

    expect([treatments, statuses, entries]).toHaveLength(3);
    expect(treatments).toHaveLength(2);
    expect(statuses).toHaveLength(2);
    expect(entries).toHaveLength(2);
  });

  it("all documents have unique _id after concurrent inserts", async () => {
    const name = tenant("concurrent-unique-id");
    const baseTime = Date.now() - 60_000;
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      post(name, "treatments", {
        eventType: "Note",
        created_at: new Date(baseTime + index).toISOString(),
        notes: `unique id test ${index}`,
      })));
    const ids = results.map((result) => result[0]?._id);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
  });

  it("response count matches request count under concurrent load", async () => {
    const name = tenant("concurrent-response-count");
    const baseTime = Date.now() - 60_000;
    const results = await Promise.all(Array.from({ length: 5 }, (_, batchIndex) => {
      const batch = Array.from({ length: 3 }, (_, itemIndex) => ({
        eventType: "Note",
        created_at: new Date(baseTime + batchIndex * 100_000 + itemIndex * 1_000).toISOString(),
        notes: `batch ${batchIndex} item ${itemIndex}`,
      }));
      return post(name, "treatments", batch).then((received) => ({
        sent: batch.length,
        received: received.length,
      }));
    }));

    results.forEach((result) => expect(result.received).toBe(result.sent));
  });

  it("handles 50 rapid sequential SMB-style POSTs (AAPS offline recovery simulation)", async () => {
    const name = tenant("concurrent-aaps-smb");
    const baseTime = Date.now() - 60_000;
    const results = await Promise.all(Array.from({ length: 50 }, async (_, index) => {
      await delay(index * 5);
      return post(name, "treatments", {
        eventType: "Correction Bolus",
        insulin: 0.1 + index / 1_000,
        isSMB: true,
        pumpId: 10_000 + index,
        pumpType: "ACCU_CHEK_INSIGHT_BLUETOOTH",
        pumpSerial: "33013206",
        created_at: new Date(baseTime + index * 300_000).toISOString(),
        notes: `AAPS sync catch-up ${index}`,
      });
    }));

    expect(results).toHaveLength(50);
    expect((await list(name, "treatments")).filter(
      (row) => row.eventType === "Correction Bolus",
    ).length).toBeGreaterThanOrEqual(50);
  });

  it("handles 100 rapid sequential SGV-style POSTs to entries", async () => {
    const name = tenant("concurrent-aaps-sgv");
    const baseTime = Date.now() - 60_000;
    const directions = ["Flat", "FortyFiveUp", "SingleUp", "FortyFiveDown"];
    const results = await Promise.all(Array.from({ length: 100 }, async (_, index) => {
      await delay(index * 3);
      const date = baseTime + index * 300_000;
      return post(name, "entries", {
        type: "sgv",
        sgv: 80 + index % 100,
        date,
        dateString: new Date(date).toISOString(),
        device: "AndroidAPS-DexcomG6",
        direction: directions[index % directions.length],
      });
    }));

    expect(results).toHaveLength(100);
    expect((await list(name, "entries")).filter(
      (row) => row.device === "AndroidAPS-DexcomG6",
    ).length).toBeGreaterThanOrEqual(100);
  });

  it("handles concurrent cross-collection sync (treatments + entries + devicestatus)", async () => {
    const name = tenant("concurrent-aaps-cross");
    const baseTime = Date.now() - 60_000;
    const requests: Promise<JsonObject[]>[] = [];
    for (let index = 0; index < 10; index += 1) {
      const createdAt = new Date(baseTime + index * 60_000).toISOString();
      requests.push(
        post(name, "treatments", {
          eventType: "Correction Bolus",
          insulin: 0.2,
          created_at: createdAt,
          notes: `cross-collection treatment ${index}`,
        }),
        post(name, "entries", {
          type: "sgv",
          sgv: 100 + index * 5,
          date: baseTime + index * 60_000,
          device: "cross-collection-test",
        }),
        post(name, "devicestatus", {
          device: `cross-collection-device-${index}`,
          created_at: createdAt,
          uploaderBattery: 90,
        }),
      );
    }

    const results = await Promise.all(requests);
    expect(results).toHaveLength(30);
    results.forEach((result) => expect(result).toHaveLength(1));
  });
});
