import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EntryStore, JsonDocument } from "../src/entry-store";
import type {
  DocumentDeleteResult,
  DocumentHistoryQuery,
  DocumentMutationResult,
  DocumentQuery,
} from "../src/document-repository";

interface TreatmentRpc {
  createTreatment(documentJson: string): Promise<string>;
  upsertTreatment(documentJson: string): Promise<string>;
  replaceTreatment(identity: string, documentJson: string): Promise<string>;
  patchTreatment(identity: string, patchJson: string): Promise<string | null>;
  findTreatmentById(id: string, includeDeleted?: boolean): Promise<string | null>;
  findTreatmentByIdentifier(identifier: string, includeDeleted?: boolean): Promise<string | null>;
  findTreatmentByFallback(
    createdAt: string | number,
    eventType: string | number,
    includeDeleted?: boolean,
  ): Promise<string | null>;
  queryTreatments(queryJson?: string): Promise<string>;
  treatmentHistory(queryJson: string): Promise<string>;
  deleteTreatment(identity: string, permanent?: boolean): Promise<DocumentDeleteResult>;
}

function store(prefix: string) {
  return env.ENTRY_STORE.getByName(`${prefix}-${crypto.randomUUID()}`);
}

function treatment(identifier: string, createdAt: string, extra = {}) {
  return {
    identifier,
    eventType: "Correction Bolus",
    created_at: createdAt,
    insulin: 1,
    ...extra,
  };
}

function decode<T>(json: string): T {
  return JSON.parse(json) as T;
}

async function createTreatment(stub: TreatmentRpc, document: JsonDocument): Promise<DocumentMutationResult> {
  return decode<DocumentMutationResult>(await stub.createTreatment(JSON.stringify(document)));
}

async function upsertTreatment(stub: TreatmentRpc, document: JsonDocument): Promise<DocumentMutationResult> {
  return decode<DocumentMutationResult>(await stub.upsertTreatment(JSON.stringify(document)));
}

async function patchTreatment(
  stub: TreatmentRpc,
  identity: string,
  patch: JsonDocument,
): Promise<DocumentMutationResult | null> {
  const result = await stub.patchTreatment(identity, JSON.stringify(patch));
  return result === null ? null : decode<DocumentMutationResult>(result);
}

async function findById(
  stub: TreatmentRpc,
  id: string,
  includeDeleted = false,
): Promise<JsonDocument | null> {
  const result = await stub.findTreatmentById(id, includeDeleted);
  return result === null ? null : decode<JsonDocument>(result);
}

async function findByIdentifier(
  stub: TreatmentRpc,
  identifier: string,
  includeDeleted = false,
): Promise<JsonDocument | null> {
  const result = await stub.findTreatmentByIdentifier(identifier, includeDeleted);
  return result === null ? null : decode<JsonDocument>(result);
}

async function queryTreatments(stub: TreatmentRpc, query: DocumentQuery): Promise<JsonDocument[]> {
  return decode<JsonDocument[]>(await stub.queryTreatments(JSON.stringify(query)));
}

async function treatmentHistory(
  stub: TreatmentRpc,
  query: DocumentHistoryQuery,
): Promise<JsonDocument[]> {
  return decode<JsonDocument[]>(await stub.treatmentHistory(JSON.stringify(query)));
}

describe("SQLite collection contract v4", () => {
  it("migrates v3 documents safely and remains idempotent across activation", async () => {
    const stub = store("migration");
    const id = "0123456789abcdef01234567";
    const legacyDocument: JsonDocument = {
      _id: id,
      identifier: "legacy-treatment",
      eventType: "Meal Bolus",
      created_at: "2026-01-01T00:00:00.000Z",
      carbs: 20,
    };
    const legacyBody = JSON.stringify(legacyDocument);

    await createTreatment(stub, legacyDocument);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      state.storage.sql.exec("DELETE FROM document_changes");
      state.storage.sql.exec("DELETE FROM collection_clocks");
      state.storage.sql.exec(
        `UPDATE documents
         SET body = ?, identifier = NULL, srv_created = NULL, srv_modified = NULL,
             is_valid = NULL, fallback_key = NULL, revision = NULL
         WHERE collection = 'treatments'`,
        legacyBody,
      );
      state.storage.sql.exec("DELETE FROM _sql_schema_migrations WHERE id = 4");
    });

    await evictDurableObject(stub);
    const migrated = await findById(stub, id);
    expect(migrated).toMatchObject({
      _id: id,
      identifier: "legacy-treatment",
      eventType: "Meal Bolus",
      carbs: 20,
    });
    expect(migrated?.srvCreated).toEqual(expect.any(Number));
    expect(migrated?.srvModified).toEqual(expect.any(Number));

    await evictDurableObject(stub);
    expect(await findById(stub, id)).toMatchObject({ _id: id, carbs: 20 });
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      const storedBody = state.storage.sql.exec<{ body: string }>(
        "SELECT body FROM documents WHERE collection = 'treatments' AND id = ?",
        id,
      ).one().body;
      expect(storedBody).toBe(legacyBody);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM _sql_schema_migrations WHERE id = 4",
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM document_changes WHERE collection = 'treatments' AND id = ?",
        id,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM collection_clocks WHERE collection = 'treatments'",
      ).one().count).toBe(1);
    });
  });

  it("keeps identifier and fallback indexes non-unique", async () => {
    const stub = store("indexes");
    await stub.treatmentsLastModified();
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      const indexes = state.storage.sql.exec<{ name: string; unique: number }>(
        "PRAGMA index_list(documents)",
      ).toArray();
      expect(indexes.find((index) => index.name === "documents_collection_identifier")?.unique).toBe(0);
      expect(indexes.find((index) => index.name === "documents_collection_fallback")?.unique).toBe(0);
    });
  });

  it("persists a strictly monotonic collection clock across DO eviction", async () => {
    const stub = store("clock");
    const createdAt = "2026-02-01T00:00:00.000Z";
    const first = await createTreatment(stub, treatment("clock-id", createdAt));
    const second = await createTreatment(stub, treatment("clock-id", createdAt, { insulin: 1.1 }));
    expect(second.srvModified).toBeGreaterThan(first.srvModified);

    await evictDurableObject(stub);
    const third = await patchTreatment(stub, "clock-id", { insulin: 1.2 });
    expect(third?.srvModified).toBeGreaterThan(second.srvModified);
    expect(await stub.treatmentsLastModified()).toBe(third?.srvModified);
  });

  it("uses official identifier, id, then legacy fallback priority and preserves the server id", async () => {
    const stub = store("identity");
    const createdAt = "2026-03-01T00:00:00.000Z";
    const primary = await createTreatment(stub, treatment("priority-id", createdAt));
    const conflictingId = "aaaaaaaaaaaaaaaaaaaaaaaa";
    await createTreatment(stub, {
      _id: conflictingId,
      eventType: "Note",
      created_at: "2026-03-01T00:01:00.000Z",
      notes: "other document",
    });

    const retransmitted = await createTreatment(stub, {
      _id: conflictingId,
      identifier: "priority-id",
      eventType: "Correction Bolus",
      created_at: createdAt,
      insulin: 2,
    });
    expect(retransmitted.document._id).toBe(primary.document._id);
    expect(retransmitted.document._id).not.toBe(conflictingId);
    expect((await findById(stub, conflictingId))?.notes).toBe("other document");

    const replaced = decode<DocumentMutationResult>(await stub.replaceTreatment(
      "priority-id",
      JSON.stringify({
        eventType: "Correction Bolus",
        created_at: createdAt,
        insulin: 2.5,
        notes: "replacement",
      }),
    ));
    expect(replaced.document).toMatchObject({
      _id: primary.document._id,
      identifier: "priority-id",
      insulin: 2.5,
      notes: "replacement",
    });
    expect(replaced.document.srvCreated).toBe(primary.document.srvCreated);

    const legacy = await createTreatment(stub, {
      eventType: "Meal Bolus",
      created_at: "2026-03-02T00:00:00.000Z",
      carbs: 15,
    });
    const deduplicated = await createTreatment(stub, {
      identifier: "modern-identifier",
      eventType: "Meal Bolus",
      created_at: "2026-03-02T00:00:00.000Z",
      carbs: 20,
    });
    expect(deduplicated.document._id).toBe(legacy.document._id);
    expect(deduplicated.deduplicatedIdentifier).toBe(legacy.document._id);
    expect((await findByIdentifier(stub, "modern-identifier"))?._id).toBe(legacy.document._id);
    const fallback = await stub.findTreatmentByFallback(
      "2026-03-02T00:00:00.000Z",
      "Meal Bolus",
    );
    expect(fallback === null ? null : decode<JsonDocument>(fallback)._id).toBe(legacy.document._id);

    const v1Modern = await createTreatment(stub, {
      identifier: "v1-existing-identifier",
      eventType: "Carb Correction",
      created_at: "2026-03-03T00:00:00.000Z",
      carbs: 10,
    });
    const fallbackUpsert = await upsertTreatment(stub, {
      eventType: "Carb Correction",
      created_at: "2026-03-03T00:00:00.000Z",
      carbs: 11,
    });
    expect(fallbackUpsert.document._id).toBe(v1Modern.document._id);
    const identifierFirst = await upsertTreatment(stub, {
      identifier: "v1-new-identifier",
      eventType: "Carb Correction",
      created_at: "2026-03-03T00:00:00.000Z",
      carbs: 12,
    });
    expect(identifierFirst.document._id).not.toBe(v1Modern.document._id);
  });

  it("filters in SQLite before applying limit", async () => {
    const stub = store("filter-before-limit");
    await createTreatment(stub, treatment("matching", "2026-04-01T00:00:00.000Z", { notes: "needle" }));
    await createTreatment(stub, treatment("newer-non-match", "2026-04-02T00:00:00.000Z", { notes: "haystack" }));

    const matches = await queryTreatments(stub, {
      filters: [{ field: "notes", operator: "eq", value: "needle" }],
      sort: { field: "created_at", direction: "desc" },
      limit: 1,
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ identifier: "matching", notes: "needle" });
  });

  it("returns ascending projected history with visible tombstones and erases permanent deletes", async () => {
    const stub = store("history");
    const first = await createTreatment(stub, treatment("history-a", "2026-05-01T00:00:00.000Z"));
    const second = await createTreatment(stub, treatment("history-b", "2026-05-01T00:01:00.000Z"));
    await patchTreatment(stub, "history-a", { insulin: 1.5 });
    const deleted = await stub.deleteTreatment("history-a");

    const history = await treatmentHistory(stub, {
      since: 0,
      fields: ["identifier", "srvModified", "isValid"],
    });
    expect(history.map((document) => document.identifier)).toEqual(["history-b", "history-a"]);
    expect(history[0]?.srvModified).toBe(second.srvModified);
    expect(history[1]).toEqual({
      identifier: "history-a",
      srvModified: deleted.srvModified,
      isValid: false,
    });
    expect(await findByIdentifier(stub, "history-a")).toBeNull();
    expect(await findByIdentifier(stub, "history-a", true)).toMatchObject({ isValid: false });

    expect((await stub.deleteTreatment("history-a", true)).deleted).toBe(true);
    expect(await findById(stub, String(first.document._id), true)).toBeNull();
    expect((await treatmentHistory(stub, { since: 0 })).some(
      (document) => document.identifier === "history-a",
    )).toBe(false);
  });

  it("rolls back document, clock, and change rows when the change insert fails", async () => {
    const stub = store("atomic-failure");
    await stub.treatmentsLastModified();
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER fail_treatment_change
        BEFORE INSERT ON document_changes
        WHEN NEW.collection = 'treatments'
        BEGIN
          SELECT RAISE(ABORT, 'forced document_changes failure');
        END;
      `);
      await expect(instance.createTreatment(JSON.stringify(treatment(
        "atomic-id",
        "2026-06-01T00:00:00.000Z",
      )))).rejects.toThrow("forced document_changes failure");
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM documents WHERE collection = 'treatments'",
      ).one().count).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM document_changes WHERE collection = 'treatments'",
      ).one().count).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM collection_clocks WHERE collection = 'treatments'",
      ).one().count).toBe(0);
    });
  });
});
