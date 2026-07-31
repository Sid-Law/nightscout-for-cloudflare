import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseApi3Search } from "../src/api3/input";
import type { EntryStore } from "../src/entry-store";

type JsonObject = Record<string, unknown>;

type MutationDecision =
  | { ok: true; mutation: JsonObject & { document: JsonObject } }
  | { ok: false; reason: string; message?: string };

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function store(name: string): DurableObjectStub<EntryStore> {
  return env.ENTRY_STORE.getByName(name);
}

function options(): string {
  return JSON.stringify({
    canCreate: true,
    canUpdate: true,
    actor: "Storage adapter",
    ifUnmodifiedSince: null,
    validate: true,
    emitRealtime: false,
  });
}

function document(identifier: string, date: number, extra: JsonObject = {}): JsonObject {
  return {
    identifier,
    date,
    utcOffset: 0,
    app: "api3-storage-adapter-test",
    device: "simulated-storage-adapter",
    eventType: "Note",
    created_at: new Date(date).toISOString(),
    ...extra,
  };
}

function mutation(raw: string): MutationDecision {
  return JSON.parse(raw) as MutationDecision;
}

describe("locked API3 storage contracts on SQLite Durable Objects", () => {
  it("represents every locked api3.storage.find contract through the adapter boundary", async () => {
    const name = tenant("api3-storage-find-file");
    const stub = store(name);
    const base = Date.now() - 60 * 60_000;

    for (let index = 0; index < 8; index += 1) {
      const decision = mutation(await stub.api3CreateDocument(
        "treatments",
        JSON.stringify(document(`storage-find-${index}`, base + index * 1_000)),
        options(),
      ));
      expect(decision.ok, String(index)).toBe(true);
    }

    const stringPaging = parseApi3Search(new URL(
      "https://example.test/api/v3/treatments?limit=5&skip=2&sort=date",
    ));
    expect(stringPaging).toMatchObject({ limit: 5, skip: 2 });
    const stringPage = JSON.parse(await stub.api3QueryCollection(
      "treatments",
      JSON.stringify(stringPaging),
    )) as { ok: boolean; result: JsonObject[] };
    expect(stringPage.ok).toBe(true);
    expect(stringPage.result).toHaveLength(5);
    expect(stringPage.result.map((item) => item.identifier)).toEqual([
      "storage-find-2",
      "storage-find-3",
      "storage-find-4",
      "storage-find-5",
      "storage-find-6",
    ]);

    const floatPaging = parseApi3Search(new URL(
      "https://example.test/api/v3/treatments?limit=5.9&skip=2.4&sort=date",
    ));
    expect(floatPaging).toMatchObject({ limit: 5, skip: 2 });
    const floatPage = JSON.parse(await stub.api3QueryCollection(
      "treatments",
      JSON.stringify(floatPaging),
    )) as { ok: boolean; result: JsonObject[] };
    expect(floatPage.result.map((item) => item.identifier)).toEqual(
      stringPage.result.map((item) => item.identifier),
    );

    const legacyId = "507f1f77bcf86cd799439011";
    expect(JSON.parse(await stub.createDocuments("devicestatus", JSON.stringify([{
      _id: legacyId,
      date: base + 20_000,
      app: "api3-storage-adapter-test",
      device: "legacy-device-status",
      created_at: new Date(base + 20_000).toISOString(),
      uploaderBattery: 82,
    }])))).toHaveLength(1);
    const normalized = JSON.parse(String(await stub.findApi3Document(
      "devicestatus",
      legacyId,
      "null",
    ))) as JsonObject;
    expect(normalized).toMatchObject({
      identifier: legacyId,
      device: "legacy-device-status",
      uploaderBattery: 82,
    });
    expect(normalized).not.toHaveProperty("_id");

    const fallbackId = "507f1f77bcf86cd799439012";
    const fallbackDate = base + 30_000;
    const fallbackCreatedAt = new Date(fallbackDate).toISOString();
    expect((await stub.createLegacyTreatments(JSON.stringify([{
      _id: fallbackId,
      date: fallbackDate,
      utcOffset: 0,
      app: "api3-storage-adapter-test",
      device: "legacy-fallback",
      eventType: "Correction Bolus",
      created_at: fallbackCreatedAt,
      insulin: 0.3,
    }]))).ok).toBe(true);
    const deduplicated = mutation(await stub.api3CreateDocument(
      "treatments",
      JSON.stringify({
        ...document("modern-fallback-identifier", fallbackDate, {
          device: "legacy-fallback",
          eventType: "Correction Bolus",
          insulin: 0.4,
        }),
        created_at: fallbackCreatedAt,
      }),
      options(),
    ));
    expect(deduplicated).toMatchObject({
      ok: true,
      mutation: {
        created: false,
        deduplicatedIdentifier: fallbackId,
        document: {
          identifier: "modern-fallback-identifier",
          insulin: 0.4,
        },
      },
    });
  });

  it("represents every locked api3.storage.modify contract with synchronous SQLite semantics", async () => {
    const name = tenant("api3-storage-modify-file");
    const stub = store(name);
    const base = Date.now() - 30 * 60_000;
    const storageId = "507f1f77bcf86cd799439021";
    const identifier = "storage-modify-record";
    const original = { ...document(identifier, base), _id: storageId, value: 21 };

    const inserted = mutation(await stub.api3CreateDocument(
      "treatments",
      JSON.stringify(original),
      options(),
    ));
    expect(inserted).toMatchObject({
      ok: true,
      mutation: {
        created: true,
        document: { identifier, value: 21 },
      },
    });
    expect((inserted as { ok: true; mutation: { document: JsonObject } })
      .mutation.document).not.toHaveProperty("_id");
    const insertedModified = Number(
      (inserted as { ok: true; mutation: JsonObject }).mutation.srvModified,
    );

    const replaced = mutation(await stub.api3ReplaceDocument(
      "treatments",
      identifier,
      JSON.stringify({ ...document(identifier, base), value: 42 }),
      options(),
    ));
    expect(replaced).toMatchObject({
      ok: true,
      mutation: { created: false, document: { identifier, value: 42 } },
    });
    const replacedModified = Number(
      (replaced as { ok: true; mutation: JsonObject }).mutation.srvModified,
    );
    expect(replacedModified).toBeGreaterThan(insertedModified);

    const patched = mutation(await stub.api3PatchDocument(
      "treatments",
      identifier,
      JSON.stringify({ value: 84 }),
      options(),
    ));
    expect(patched).toMatchObject({
      ok: true,
      mutation: { created: false, document: { identifier, value: 84 } },
    });
    const patchedModified = Number(
      (patched as { ok: true; mutation: JsonObject }).mutation.srvModified,
    );
    expect(patchedModified).toBeGreaterThan(replacedModified);
    expect(await stub.api3CollectionLastModified("treatments")).toBe(patchedModified);

    const upsertIdentifier = "storage-modify-upsert";
    const upserted = mutation(await stub.api3ReplaceDocument(
      "treatments",
      upsertIdentifier,
      JSON.stringify(document(upsertIdentifier, base + 1_000, { value: 7 })),
      options(),
    ));
    expect(upserted).toMatchObject({
      ok: true,
      mutation: { created: true, document: { identifier: upsertIdentifier, value: 7 } },
    });

    expect(await stub.api3DeleteDocument("treatments", identifier, false, "Storage adapter"))
      .toMatchObject({ deleted: true, permanent: false });
    expect(await stub.api3DeleteDocument("treatments", identifier, true, "Storage adapter"))
      .toMatchObject({ deleted: true, permanent: true });
    expect(await stub.api3DeleteDocument("treatments", upsertIdentifier, true, "Storage adapter"))
      .toMatchObject({ deleted: true, permanent: true });

    const versionResponse = await SELF.fetch("https://example.test/api/v3/version");
    expect(versionResponse.status).toBe(200);
    expect(await versionResponse.json()).toMatchObject({
      status: 200,
      result: {
        storage: {
          storage: "sqlite-durable-object",
          version: expect.any(String),
        },
      },
    });
  });
});
