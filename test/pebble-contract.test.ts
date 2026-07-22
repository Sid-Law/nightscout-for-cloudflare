import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildNightscoutPebbleResponse } from "../src/pebble";
import { calculatePluginProperties } from "../src/plugins/properties";
import type { PluginPropertyContext } from "../src/plugins/properties";

const FIVE_MINUTES = 5 * 60_000;
const TEST_API_SECRET = "nscf-test-secret-20260717";

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

function context(now: number): PluginPropertyContext {
  return {
    sgvs: [
      { device: "dexcom", mgdl: 91, direction: "Flat", filtered: 124048, unfiltered: 118880, rssi: 174, noise: 1, mills: now - 4 * FIVE_MINUTES },
      { device: "dexcom", mgdl: 88, direction: "Flat", filtered: 120464, unfiltered: 116608, rssi: 175, noise: 1, mills: now - 3 * FIVE_MINUTES },
      { device: "dexcom", mgdl: 86, direction: "Flat", filtered: 117808, unfiltered: 114640, rssi: 169, noise: 1, mills: now - 2 * FIVE_MINUTES },
      { device: "dexcom", mgdl: 92, direction: "Flat", filtered: 115680, unfiltered: 113552, rssi: 179, noise: 1, mills: now - FIVE_MINUTES },
      { device: "dexcom", mgdl: 90, direction: "Flat", filtered: 113984, unfiltered: 111920, rssi: 179, noise: 1, mills: now },
    ],
    cals: [{ device: "dexcom", slope: 895.8571693029189, intercept: 34281.06876195567, scale: 1, type: "cal", mills: now }],
    profiles: [{ dia: 4, sens: 70, carbratio: 15, carbs_hr: 30 }],
    // The locked fixture captures `now` before the HTTP request and the plugin
    // evaluates with a later Date.now(), so the just-entered carbs are already
    // one tick in the past when COB is calculated.
    treatments: [{ eventType: "Snack Bolus", insulin: "1.50", carbs: "22", mills: now - 1 }],
    devicestatus: [{ uploader: { battery: 100 }, mills: now }],
  };
}

function build(
  data: PluginPropertyContext,
  now: number,
  overrides: Partial<Parameters<typeof buildNightscoutPebbleResponse>[1]> = {},
) {
  return buildNightscoutPebbleResponse(data, {
    now,
    count: 1,
    mmol: false,
    rawbg: false,
    iob: false,
    cob: false,
    properties: calculatePluginProperties(data, "mg/dl", now, new Set(["bgnow"])),
    ...overrides,
  });
}

describe("locked Nightscout v15.0.7 Pebble endpoint", () => {
  const now = Date.parse("2026-07-22T02:10:00.000Z");

  it("matches default, mmol, and count-two SGV response shapes", () => {
    const data = context(now);
    const ordinary = build(data, now);
    expect(ordinary.status).toEqual([{ now }]);
    expect(ordinary.bgs).toHaveLength(1);
    expect(ordinary.bgs[0]).toEqual({
      sgv: "90",
      bgdelta: -2,
      trend: 4,
      direction: "Flat",
      datetime: now,
      battery: "100",
    });
    expect(ordinary.cals).toEqual([]);

    expect(build(data, now, {
      mmol: true,
      properties: calculatePluginProperties(data, "mmol", now, new Set(["bgnow"])),
    }).bgs[0]).toMatchObject({
      sgv: "5.0",
      bgdelta: "-0.1",
      trend: 4,
      direction: "Flat",
      datetime: now,
      battery: "100",
    });
    expect(build(data, now, { count: 2 }).bgs).toHaveLength(2);
  });

  it("omits missing, negative, false, and zero uploader batteries", () => {
    for (const battery of [undefined, -1, false, 0]) {
      const data = context(now);
      data.devicestatus = battery === undefined ? [] : [{ uploader: { battery }, mills: now }];
      expect(build(data, now).bgs[0]).not.toHaveProperty("battery");
    }
  });

  it("maps raw calibration fields and official IOB/COB displays", () => {
    const data = context(now);
    const properties = calculatePluginProperties(
      data,
      "mg/dl",
      now,
      new Set(["bgnow", "rawbg", "iob", "cob"]),
    );
    const response = build(data, now, {
      count: 2,
      rawbg: true,
      iob: true,
      cob: true,
      properties,
    });
    expect(response.bgs[0]).toMatchObject({
      sgv: "90",
      bgdelta: -2,
      filtered: 113984,
      unfiltered: 111920,
      noise: 1,
      iob: "1.50",
      cob: 22,
    });
    expect(response.bgs[0]).not.toHaveProperty("rssi");
    expect(response.cals).toEqual([{
      slope: 895.8571693029189,
      intercept: 34281.06876195567,
      scale: 1,
    }]);
  });

  it("returns zero IOB/COB fallbacks and device-status IOB", () => {
    const data = context(now);
    data.treatments = [];
    let properties = calculatePluginProperties(
      data,
      "mg/dl",
      now,
      new Set(["bgnow", "iob", "cob"]),
    );
    expect(build(data, now, { iob: true, cob: true, properties }).bgs[0])
      .toMatchObject({ iob: 0, cob: 0 });

    data.devicestatus = [{ pump: { iob: { bolusiob: 2.3 } }, mills: now }];
    properties = calculatePluginProperties(
      data,
      "mg/dl",
      now,
      new Set(["bgnow", "iob", "cob"]),
    );
    expect(build(data, now, { iob: true, cob: true, properties }).bgs[0])
      .toMatchObject({ iob: "2.30", cob: 0 });
  });

  it("serves the public readable route with bounded count and HEAD parity", async () => {
    const tenant = `pebble-${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const created = await SELF.fetch(`https://example.test/api/v1/entries?tenant=${tenant}`, {
      method: "POST",
      headers: {
        "api-secret": await secretDigest(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        { type: "sgv", sgv: 100, direction: "Flat", date: now - FIVE_MINUTES },
        { type: "sgv", sgv: 105, direction: "FortyFiveUp", date: now },
      ]),
    });
    expect(created.status).toBe(200);

    const response = await SELF.fetch(`https://example.test/pebble?tenant=${tenant}&count=2`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toMatchObject({
      status: [expect.objectContaining({ now: expect.any(Number) })],
      bgs: [
        expect.objectContaining({ sgv: "105", trend: 3, direction: "FortyFiveUp" }),
        expect.objectContaining({ sgv: "100", trend: 4, direction: "Flat" }),
      ],
      cals: [],
    });

    const mmol = await SELF.fetch(`https://example.test/pebble?tenant=${tenant}&units=mmol`);
    expect(await mmol.json()).toMatchObject({
      bgs: [expect.objectContaining({ sgv: "5.8", bgdelta: "0.2" })],
    });

    const head = await SELF.fetch(`https://example.test/pebble?tenant=${tenant}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
});
