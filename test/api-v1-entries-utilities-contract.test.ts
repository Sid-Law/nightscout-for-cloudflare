import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const TEST_API_SECRET = "nscf-test-secret-20260717";

type JsonObject = Record<string, unknown>;

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function withTenant(path: string, tenantName: string): string {
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

async function postEntries(tenantName: string, payload: unknown): Promise<Response> {
  return SELF.fetch(withTenant("/api/v1/entries/", tenantName), {
    method: "POST",
    headers: {
      "api-secret": await secretDigest(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

async function postDocuments(
  tenantName: string,
  path: "/api/v1/treatments/" | "/api/v1/devicestatus/",
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

function encodedSegment(value: string): string {
  return encodeURIComponent(value);
}

describe("locked v1 Entries times and slice utilities", () => {
  it("expands the locked numeric-brace slice/times patterns and preserves count/order", async () => {
    const name = tenant("v1-times-slice");
    const timestamps = [
      ...Array.from({ length: 10 }, (_, index) => `2014-07-19T09:${String(index * 5).padStart(2, "0")}:15.000Z`),
      ...Array.from({ length: 10 }, (_, index) => `2014-07-19T10:${String(index * 5).padStart(2, "0")}:15.000Z`),
      ...Array.from({ length: 10 }, (_, index) => `2014-07-19T17:${String(index * 5).padStart(2, "0")}:15.000Z`),
    ];
    const fixtures = timestamps.map((dateString, index) => ({
      type: "sgv",
      sgv: index < 10 ? 165 : 100 + index,
      dateString,
      date: Date.parse(dateString),
      device: "dexcom",
      direction: "NOT COMPUTABLE",
    }));
    const created = await postEntries(name, fixtures);
    expect(created.status).toBe(200);
    expect(await created.json<JsonObject[]>()).toHaveLength(30);

    const slice = await SELF.fetch(withTenant(
      "/api/v1/slice/entries/dateString/sgv/2014-07.json?count=20",
      name,
    ));
    expect(slice.status).toBe(200);
    const sliceRows = await slice.json<JsonObject[]>();
    expect(sliceRows).toHaveLength(20);
    expect(Number(sliceRows[0]?.date)).toBeGreaterThan(Number(sliceRows[1]?.date));

    const multiPrefix = encodedSegment("2014-07-{17..20}");
    const multiSlice = await SELF.fetch(withTenant(
      `/api/v1/slice/entries/dateString/sgv/${multiPrefix}.json?count=20`,
      name,
    ));
    expect(multiSlice.status).toBe(200);
    expect(await multiSlice.json<JsonObject[]>()).toHaveLength(20);

    const emptySlice = await SELF.fetch(withTenant(
      "/api/v1/slice/entries/dateString/sgv/1999-07.json?count=20&find[sgv][$lte]=401",
      name,
    ));
    expect(emptySlice.status).toBe(200);
    expect(await emptySlice.json()).toEqual([]);

    const echoRegex = encodedSegment(".*T{00..05}:.");
    const echo = await SELF.fetch(withTenant(
      `/api/v1/times/echo/2014-07/${echoRegex}.json?count=20&find[sgv][$gte]=160`,
      name,
    ));
    expect(echo.status).toBe(200);
    const echoBody = await echo.json<{ req: { query: unknown }; pattern: string[] }>();
    expect(echoBody.req).toHaveProperty("query");
    expect(echoBody.pattern).toHaveLength(6);

    const modalDays = await SELF.fetch(withTenant(
      `/api/v1/times/2014-07-/${encodedSegment("{0..30}T")}.json`,
      name,
    ));
    expect(modalDays.status).toBe(200);
    expect(await modalDays.json<JsonObject[]>()).toHaveLength(10);

    const modalHours = await SELF.fetch(withTenant(
      `/api/v1/times/${encodedSegment("20{14..15}-07")}/${encodedSegment("T{09..10}")}.json`,
      name,
    ));
    expect(modalHours.status).toBe(200);
    expect(await modalHours.json<JsonObject[]>()).toHaveLength(10);

    const modalMinutes = await SELF.fetch(withTenant(
      `/api/v1/times/${encodedSegment("20{14..15}")}/${encodedSegment("T.*:{00..60}")}.json`,
      name,
    ));
    expect(modalMinutes.status).toBe(200);
    expect(await modalMinutes.json<JsonObject[]>()).toHaveLength(10);
  });

  it("selects the locked treatments/devicestatus stores, arbitrary fields and Entries fallback", async () => {
    const name = tenant("v1-slice-storages");
    const now = Math.floor(Date.now() / 1_000) * 1_000;
    const treatments = await postDocuments(name, "/api/v1/treatments/", [
      {
        created_at: new Date(now - 3_000).toISOString(),
        eventType: "Note",
        type: "note",
        enteredBy: "loop-alpha",
        carbs: "12.7",
      },
      {
        created_at: new Date(now - 2_000).toISOString(),
        eventType: "Note",
        type: "note",
        enteredBy: "loop-beta",
        carbs: "15",
      },
      {
        created_at: new Date(now - 1_000).toISOString(),
        eventType: "Note",
        type: "note",
        enteredBy: "manual",
        carbs: "20",
      },
    ]);
    expect(treatments.status).toBe(200);

    const treatmentSlice = await SELF.fetch(withTenant(
      `/api/v1/slice/treatments/enteredBy/note/${encodedSegment("loop-")}.json?count=2`,
      name,
    ));
    expect(treatmentSlice.status).toBe(200);
    expect(await treatmentSlice.json<JsonObject[]>()).toMatchObject([
      { enteredBy: "loop-beta", type: "note", carbs: 15 },
      { enteredBy: "loop-alpha", type: "note", carbs: 12.7 },
    ]);

    const statuses = await postDocuments(name, "/api/v1/devicestatus/", [
      {
        created_at: new Date(now - 3_000).toISOString(),
        type: "status",
        device: "openaps://alpha",
        uploaderBattery: 80,
      },
      {
        created_at: new Date(now - 2_000).toISOString(),
        type: "status",
        device: "openaps://beta",
        uploaderBattery: 81,
      },
      {
        created_at: new Date(now - 1_000).toISOString(),
        type: "status",
        device: "loop://phone",
        uploaderBattery: 82,
      },
    ]);
    expect(statuses.status).toBe(200);

    const statusSlice = await SELF.fetch(withTenant(
      `/api/v2/slice/devicestatus/device/status/${encodedSegment("openaps://")}.json?count=5`,
      name,
    ));
    expect(statusSlice.status).toBe(200);
    expect(await statusSlice.json<JsonObject[]>()).toMatchObject([
      { device: "openaps://beta", type: "status", uploaderBattery: 81 },
      { device: "openaps://alpha", type: "status", uploaderBattery: 80 },
    ]);

    expect((await postEntries(name, {
      type: "sgv",
      sgv: 123,
      date: now,
      dateString: new Date(now).toISOString(),
      device: "fallback-device",
      direction: "Flat",
    })).status).toBe(200);
    const fallback = await SELF.fetch(withTenant(
      "/api/v1/slice/unknown/device/sgv/fallback-.json?count=5",
      name,
    ));
    expect(fallback.status).toBe(200);
    expect(await fallback.json<JsonObject[]>()).toMatchObject([
      { device: "fallback-device", type: "sgv", sgv: 123 },
    ]);
  });

  it("supports the locked exact-date and open dateString-range delete selectors", async () => {
    const exactName = tenant("v1-entry-delete-date");
    const exactDate = Math.floor(Date.now() / 1000) * 1000;
    expect((await postEntries(exactName, {
      type: "sgv",
      sgv: 142,
      date: exactDate,
      dateString: new Date(exactDate).toISOString(),
      device: "test-device",
      direction: "Flat",
    })).status).toBe(200);
    const exactDelete = await SELF.fetch(withTenant(
      `/api/v1/entries.json?find[date]=${exactDate}`,
      exactName,
    ), {
      method: "DELETE",
      headers: { "api-secret": await secretDigest() },
    });
    expect(exactDelete.status).toBe(200);
    expect(await exactDelete.json()).toEqual({ acknowledged: true, deletedCount: 1 });

    const rangeName = tenant("v1-entry-delete-date-string");
    const oldRows = [
      {
        type: "sgv",
        sgv: "199",
        dateString: "2014-07-20T00:44:15.000-07:00",
        date: 1405791855000,
        device: "dexcom",
        direction: "NOT COMPUTABLE",
      },
      {
        type: "sgv",
        sgv: "200",
        dateString: "2014-07-20T00:44:15.001-07:00",
        date: 1405791855001,
        device: "dexcom",
        direction: "NOT COMPUTABLE",
      },
    ];
    expect((await postEntries(rangeName, oldRows)).status).toBe(200);
    const queried = await SELF.fetch(withTenant(
      "/api/v1/entries.json?find[dateString][$gte]=2014-07-20&count=100",
      rangeName,
    ));
    const queriedRows = await queried.json<JsonObject[]>();
    expect(queriedRows).toHaveLength(2);
    expect(queriedRows[0]).toMatchObject({ sgv: "200", utcOffset: -420 });

    const rangedDelete = await SELF.fetch(withTenant(
      "/api/v1/entries.json?find[dateString][$gte]=2014-07-20&count=100",
      rangeName,
    ), {
      method: "DELETE",
      headers: { "api-secret": await secretDigest() },
    });
    expect(rangedDelete.status).toBe(200);
    expect(await rangedDelete.json()).toEqual({ acknowledged: true, deletedCount: 2 });
    expect(await (await SELF.fetch(withTenant(
      "/api/v1/entries.json?find[dateString][$gte]=2014-07-20&count=100",
      rangeName,
    ))).json()).toEqual([]);
  });
});
