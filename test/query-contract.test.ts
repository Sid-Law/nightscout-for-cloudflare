import { describe, expect, it } from "vitest";
import {
  createLegacyMongoQuery,
  LegacyObjectId,
  normalizeLegacyIdValue,
} from "../src/server-query";

/** Complete named-case mapping of locked v15.0.7 tests/query.test.js. */
describe("locked Nightscout server query module", () => {
  it("should provide default options", () => {
    const before = Date.now() - 4 * 24 * 60 * 60 * 1_000;
    const query = createLegacyMongoQuery();
    const after = Date.now() - 4 * 24 * 60 * 60 * 1_000;
    const minimum = Date.parse((query.date as Record<string, string>).$gte!);
    expect(minimum).toBeGreaterThanOrEqual(before);
    expect(minimum).toBeLessThanOrEqual(after);
  });

  it("should not override non default options", () => {
    const twoDays = 2 * 24 * 60 * 60 * 1_000;
    const before = Date.now() - twoDays;
    const query = createLegacyMongoQuery({}, {
      deltaAgo: twoDays,
      dateField: "created_at",
    });
    const after = Date.now() - twoDays;
    const minimum = Date.parse((query.created_at as Record<string, string>).$gte!);
    expect(minimum).toBeGreaterThanOrEqual(before);
    expect(minimum).toBeLessThanOrEqual(after);
    expect(query.date).toBeUndefined();
  });

  it("should not enforce date filter if query includes id", () => {
    const query = createLegacyMongoQuery({ find: { _id: 1234 } });
    expect(query.date).toBeUndefined();
    expect(query._id).toBe(1234);
  });

  it("should keep non-ObjectId _id queries as strings", () => {
    const uuid = "69F15FD2-8075-4DEB-AEA3-4352F455840D";
    expect(createLegacyMongoQuery({ find: { _id: uuid } })._id).toBe(uuid);
  });

  it("should convert ObjectId-shaped _id queries", () => {
    const objectId = "55cbd4e47e726599048a3f91";
    const normalized = createLegacyMongoQuery({ find: { _id: objectId } })._id;
    expect(normalized).toBeInstanceOf(LegacyObjectId);
    expect(String(normalized)).toBe(objectId);
  });

  it("preserves newer UUID and nested ObjectId normalization used by uploaders", () => {
    const uuid = "69F15FD2-8075-4DEB-AEA3-4352F455840D";
    expect(createLegacyMongoQuery(
      { find: { _id: uuid } },
      { uuidHandling: true },
    )).toEqual({
      $or: [{ identifier: uuid }, { _id: uuid }],
    });
    expect(String(normalizeLegacyIdValue("ABCBD4E47E726599048A3F91").value))
      .toBe("abcbd4e47e726599048a3f91");
  });
});
