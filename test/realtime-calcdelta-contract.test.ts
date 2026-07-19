import { describe, expect, it } from "vitest";
import {
  calculateRealtimeDelta,
  type RealtimeDeltaState,
} from "../src/realtime/calcdelta";

function ddata(): RealtimeDeltaState {
  return {
    sgvs: [],
    treatments: [],
    mbgs: [],
    cals: [],
    profiles: [],
    devicestatus: [],
    food: [],
    activity: [],
    dbstats: {},
    lastUpdated: 0,
  };
}

describe("locked Nightscout data.calcdelta.test.js", () => {
  const now = 2_000_000;
  const before = now - 5 * 60 * 1_000;

  it("should return original data if there are no changes", () => {
    const current = ddata();
    current.sgvs = [{ mgdl: 100, mills: before }, { mgdl: 100, mills: now }];
    expect(calculateRealtimeDelta(current, current)).toBe(current);
  });

  it("adding one sgv record should return delta with one sgv", () => {
    const current = ddata();
    current.sgvs = [{ mgdl: 100, mills: before }, { mgdl: 100, mills: now }];
    const next = structuredClone(current);
    next.sgvs = [
      { mgdl: 100, mills: 101 },
      { mgdl: 100, mills: before },
      { mgdl: 100, mills: now },
    ];
    const delta = calculateRealtimeDelta(current, next);
    expect(delta.delta).toBe(true);
    expect(delta.sgvs).toHaveLength(1);
  });

  it("should update sgv if changed", () => {
    const current = ddata();
    current.sgvs = [{ mgdl: 100, mills: before }, { mgdl: 100, mills: now }];
    const next = structuredClone(current);
    next.sgvs = [{ mgdl: 110, mills: before }, { mgdl: 100, mills: now }];
    const delta = calculateRealtimeDelta(current, next);
    expect(delta.delta).toBe(true);
    expect(delta.sgvs).toHaveLength(1);
  });

  it("adding one treatment record should return delta with one treatment", () => {
    const current = ddata();
    current.treatments = [
      { _id: "someid_1", mgdl: 100, mills: before },
      { _id: "someid_2", mgdl: 100, mills: now },
    ];
    const next = structuredClone(current);
    next.treatments = [
      ...next.treatments!,
      { _id: "someid_3", mgdl: 100, mills: 98 },
    ];
    const delta = calculateRealtimeDelta(current, next);
    expect(delta.delta).toBe(true);
    expect(delta.treatments).toHaveLength(1);
  });

  it("changes to treatments, mbgs and cals should be calculated even if sgvs is not changed", () => {
    const current = ddata();
    current.sgvs = [{ mgdl: 100, mills: before }, { mgdl: 100, mills: now }];
    current.treatments = [
      { _id: "someid_1", mgdl: 100, mills: before },
      { _id: "someid_2", mgdl: 100, mills: now },
    ];
    current.mbgs = [{ mgdl: 100, mills: before }, { mgdl: 100, mills: now }];
    current.cals = [{ mgdl: 100, mills: before }, { mgdl: 100, mills: now }];
    const next = structuredClone(current);
    next.treatments = [
      { _id: "someid_3", mgdl: 100, mills: 101 },
      ...next.treatments!,
    ];
    next.mbgs = [{ mgdl: 100, mills: 101 }, ...next.mbgs!];
    next.cals = [{ mgdl: 100, mills: 101 }, ...next.cals!];
    const delta = calculateRealtimeDelta(current, next);
    expect(delta.delta).toBe(true);
    expect(delta.treatments).toHaveLength(1);
    expect(delta.mbgs).toHaveLength(1);
    expect(delta.cals).toHaveLength(1);
  });

  it("delta should include profile", () => {
    const current = ddata();
    current.sgvs = [{ mgdl: 100, mills: before }, { mgdl: 100, mills: now }];
    current.profiles = { foo: true };
    const next = structuredClone(current);
    next.sgvs = [
      { mgdl: 100, mills: 101 },
      { mgdl: 100, mills: before },
      { mgdl: 100, mills: now },
    ];
    next.profiles = { bar: true };
    const delta = calculateRealtimeDelta(current, next);
    expect(delta.profiles).toEqual({ bar: true });
  });
});

describe("calcdelta adapter edge contracts", () => {
  it("emits treatment updates/removals and ignores the derived mgdl field", () => {
    const current = ddata();
    current.treatments = [
      { _id: "same", mills: 100, mgdl: 90, notes: "before" },
      { _id: "removed", mills: 50 },
    ];
    const next = structuredClone(current);
    next.treatments = [{ _id: "same", mills: 100, mgdl: 110, notes: "after" }];
    const delta = calculateRealtimeDelta(current, next);
    expect(delta.treatments).toEqual([
      { _id: "removed", mills: 50, action: "remove" },
      { _id: "same", mills: 100, mgdl: 110, notes: "after", action: "update" },
    ]);

    const derivedOnly = structuredClone(next);
    derivedOnly.treatments![0]!.mgdl = 120;
    expect(calculateRealtimeDelta(next, derivedOnly)).toBe(derivedOnly);
  });
});
