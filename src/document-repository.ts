import type { JsonDocument, JsonValue } from "./entry-store";

const TREATMENTS = "treatments";
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const FIELD_NAME = /^[A-Za-z0-9_.-]+$/;
const MAX_LIMIT = 10_000;

type FilterOperator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "nin" | "re";

export interface DocumentFilter {
  field: string;
  operator: FilterOperator;
  value: JsonValue;
}

export interface DocumentQuery {
  filters?: DocumentFilter[];
  sort?: { field: string; direction: "asc" | "desc" };
  limit?: number;
  skip?: number;
  fields?: string[];
  includeDeleted?: boolean;
}

export interface DocumentHistoryQuery {
  since: number;
  inclusive?: boolean;
  limit?: number;
  fields?: string[];
}

export interface DocumentMutationResult {
  document: JsonDocument;
  created: boolean;
  deduplicated: boolean;
  revision: number;
  srvModified: number;
  deduplicatedIdentifier?: string;
}

export interface DocumentDeleteResult {
  deleted: boolean;
  permanent: boolean;
  revision?: number;
  srvModified?: number;
}

interface DbDocumentV4 {
  [key: string]: SqlStorageValue;
  id: string;
  body: string;
  sort_time: number;
  created_at: number;
  updated_at: number;
  identifier: string | null;
  srv_created: number | null;
  srv_modified: number | null;
  is_valid: number | null;
  fallback_key: string | null;
  revision: number | null;
}

interface DbChange {
  [key: string]: SqlStorageValue;
  change_id: number;
  id: string;
  identifier: string | null;
  body: string;
  srv_created: number;
  srv_modified: number;
  is_valid: number;
  revision: number;
}

interface ClockRow {
  [key: string]: SqlStorageValue;
  last_srv_modified: number;
}

interface CountRow {
  [key: string]: SqlStorageValue;
  count: number;
}

function randomObjectId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseBody(body: string): JsonDocument {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("stored document body is not an object");
  }
  return parsed as JsonDocument;
}

function finiteInteger(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function timestamp(value: JsonValue | undefined): number | null {
  const numeric = finiteInteger(value);
  if (numeric !== null) return numeric;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function sortTime(document: JsonDocument, fallback: number): number {
  for (const field of ["date", "mills", "created_at", "timestamp", "startDate"]) {
    const parsed = timestamp(document[field]);
    if (parsed !== null) return parsed;
  }
  return fallback;
}

function fallbackKey(document: JsonDocument): string | null {
  const createdAt = document.created_at;
  const eventType = document.eventType;
  if (
    (typeof createdAt !== "string" && typeof createdAt !== "number") ||
    (typeof eventType !== "string" && typeof eventType !== "number")
  ) {
    return null;
  }
  return JSON.stringify([createdAt, eventType]);
}

function requestedIdentifier(document: JsonDocument): string | null {
  return typeof document.identifier === "string" && document.identifier.length > 0
    ? document.identifier
    : null;
}

function requestedId(document: JsonDocument): string | null {
  return typeof document._id === "string" && OBJECT_ID.test(document._id)
    ? document._id.toLowerCase()
    : null;
}

function normalizeTreatmentIdentity(document: JsonDocument): JsonDocument {
  const normalized = { ...document };
  if (typeof normalized._id === "string" && !OBJECT_ID.test(normalized._id)) {
    if (requestedIdentifier(normalized) === null) normalized.identifier = normalized._id;
    delete normalized._id;
  } else if (typeof normalized._id === "string") {
    normalized._id = normalized._id.toLowerCase();
  }
  return normalized;
}

function materialize(row: Pick<DbDocumentV4, "id" | "body" | "identifier" | "srv_created" | "srv_modified" | "is_valid">): JsonDocument {
  if (row.srv_created === null || row.srv_modified === null || row.is_valid === null) {
    throw new Error("document metadata is incomplete");
  }
  const document = parseBody(row.body);
  document._id = row.id;
  if (row.identifier === null) delete document.identifier;
  else document.identifier = row.identifier;
  document.srvCreated = row.srv_created;
  document.srvModified = row.srv_modified;
  if (row.is_valid === 0) document.isValid = false;
  return document;
}

function materializeChange(row: DbChange): JsonDocument {
  return materialize({
    id: row.id,
    body: row.body,
    identifier: row.identifier,
    srv_created: row.srv_created,
    srv_modified: row.srv_modified,
    is_valid: row.is_valid,
  });
}

function project(document: JsonDocument, fields: string[] | undefined): JsonDocument {
  if (fields === undefined || fields.includes("_all")) return document;
  const projected: JsonDocument = {};
  for (const field of fields) {
    if (!FIELD_NAME.test(field)) throw new Error(`invalid projection field ${field}`);
    const value = document[field];
    if (value !== undefined) projected[field] = value;
  }
  return projected;
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return 1_000;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return limit;
}

function boundedSkip(skip: number | undefined): number {
  if (skip === undefined) return 0;
  if (!Number.isInteger(skip) || skip < 0 || skip > 1_000_000) {
    throw new Error("skip must be a non-negative integer");
  }
  return skip;
}

function sqlValue(value: JsonValue): SqlStorageValue {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return JSON.stringify(value);
}

function fieldExpression(field: string): { sql: string; bindings: SqlStorageValue[] } {
  if (!FIELD_NAME.test(field)) throw new Error(`invalid query field ${field}`);
  switch (field) {
    case "_id":
      return { sql: "id", bindings: [] };
    case "identifier":
      return { sql: "identifier", bindings: [] };
    case "srvCreated":
      return { sql: "srv_created", bindings: [] };
    case "srvModified":
      return { sql: "srv_modified", bindings: [] };
    case "isValid":
      return { sql: "is_valid", bindings: [] };
    default:
      return { sql: "json_extract(body, ?)", bindings: [`$.${field}`] };
  }
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function appendFilter(
  clauses: string[],
  bindings: SqlStorageValue[],
  filter: DocumentFilter,
): void {
  const expression = fieldExpression(filter.field);
  const addExpression = (): void => {
    bindings.push(...expression.bindings);
  };
  switch (filter.operator) {
    case "eq":
      addExpression();
      if (filter.value === null) clauses.push(`${expression.sql} IS NULL`);
      else {
        clauses.push(`${expression.sql} = ?`);
        bindings.push(sqlValue(filter.value));
      }
      return;
    case "ne":
      addExpression();
      if (filter.value === null) clauses.push(`${expression.sql} IS NOT NULL`);
      else {
        clauses.push(`(${expression.sql} IS NULL OR ${expression.sql} != ?)`);
        bindings.push(...expression.bindings, sqlValue(filter.value));
      }
      return;
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const operators = { gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;
      addExpression();
      clauses.push(`${expression.sql} ${operators[filter.operator]} ?`);
      bindings.push(sqlValue(filter.value));
      return;
    }
    case "in":
    case "nin": {
      const values = Array.isArray(filter.value) ? filter.value : String(filter.value).split("|");
      if (values.length === 0) {
        clauses.push(filter.operator === "in" ? "0" : "1");
        return;
      }
      addExpression();
      const placeholders = values.map(() => "?").join(", ");
      clauses.push(`${expression.sql} ${filter.operator === "in" ? "IN" : "NOT IN"} (${placeholders})`);
      bindings.push(...values.map(sqlValue));
      return;
    }
    case "re":
      addExpression();
      clauses.push(`CAST(${expression.sql} AS TEXT) LIKE ? ESCAPE '\\'`);
      bindings.push(`%${escapeLike(String(filter.value))}%`);
  }
}

function columnNames(sql: SqlStorage): Set<string> {
  return new Set(
    sql.exec<{ name: string }>("PRAGMA table_info(documents)").toArray().map((column) => column.name),
  );
}

function addColumn(sql: SqlStorage, columns: Set<string>, name: string, definition: string): void {
  if (columns.has(name)) return;
  sql.exec(`ALTER TABLE documents ADD COLUMN ${name} ${definition}`);
  columns.add(name);
}

function migrationCandidate(row: DbDocumentV4, document: JsonDocument): number {
  return timestamp(document.srvModified)
    ?? timestamp(document.created_at)
    ?? timestamp(document.date)
    ?? row.updated_at
    ?? row.sort_time
    ?? row.created_at;
}

export function migrateDocumentsV4(sql: SqlStorage): void {
  const columns = columnNames(sql);
  addColumn(sql, columns, "identifier", "TEXT");
  addColumn(sql, columns, "srv_created", "INTEGER");
  addColumn(sql, columns, "srv_modified", "INTEGER");
  addColumn(sql, columns, "is_valid", "INTEGER");
  addColumn(sql, columns, "fallback_key", "TEXT");
  addColumn(sql, columns, "revision", "INTEGER");

  sql.exec(`
    CREATE TABLE IF NOT EXISTS collection_clocks (
      collection TEXT PRIMARY KEY,
      last_srv_modified INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS document_changes (
      change_id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      identifier TEXT,
      body TEXT NOT NULL,
      srv_created INTEGER NOT NULL,
      srv_modified INTEGER NOT NULL,
      is_valid INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      operation TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS documents_collection_identifier
      ON documents(collection, identifier);
    CREATE INDEX IF NOT EXISTS documents_collection_fallback
      ON documents(collection, fallback_key);
    CREATE INDEX IF NOT EXISTS documents_collection_valid_sort
      ON documents(collection, is_valid, sort_time DESC, srv_modified DESC);
    CREATE INDEX IF NOT EXISTS documents_collection_modified
      ON documents(collection, srv_modified DESC);
    CREATE INDEX IF NOT EXISTS document_changes_collection_history
      ON document_changes(collection, srv_modified ASC, change_id ASC);
    CREATE INDEX IF NOT EXISTS document_changes_document
      ON document_changes(collection, id, revision);
  `);

  const rows = sql.exec<DbDocumentV4>(`
    SELECT collection, id, body, sort_time, created_at, updated_at,
           identifier, srv_created, srv_modified, is_valid, fallback_key, revision
    FROM documents
    ORDER BY collection ASC, updated_at ASC, id ASC
  `).toArray();
  const clocks = new Map<string, number>();

  for (const row of rows) {
    const collection = String(row.collection);
    const document = parseBody(row.body);
    const priorClock = clocks.get(collection)
      ?? sql.exec<ClockRow>(
        "SELECT last_srv_modified FROM collection_clocks WHERE collection = ? LIMIT 1",
        collection,
      ).toArray()[0]?.last_srv_modified
      ?? 0;
    const candidate = migrationCandidate(row, document);
    const srvModified = row.srv_modified ?? Math.max(candidate, priorClock + 1);
    const srvCreated = row.srv_created
      ?? timestamp(document.srvCreated)
      ?? Math.min(candidate, srvModified);
    const isValid = row.is_valid ?? (document.isValid === false ? 0 : 1);
    const identifier = row.identifier ?? requestedIdentifier(document);
    const documentFallback = row.fallback_key
      ?? (collection === TREATMENTS ? fallbackKey(document) : null);
    const revision = row.revision ?? 1;

    sql.exec(
      `UPDATE documents
       SET identifier = ?, srv_created = ?, srv_modified = ?, is_valid = ?,
           fallback_key = ?, revision = ?
       WHERE collection = ? AND id = ?`,
      identifier,
      srvCreated,
      srvModified,
      isValid,
      documentFallback,
      revision,
      collection,
      row.id,
    );

    const changeCount = sql.exec<CountRow>(
      `SELECT COUNT(*) AS count FROM document_changes
       WHERE collection = ? AND id = ? AND revision = ?`,
      collection,
      row.id,
      revision,
    ).one().count;
    if (changeCount === 0) {
      sql.exec(
        `INSERT INTO document_changes
          (collection, id, identifier, body, srv_created, srv_modified, is_valid, revision, operation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'migrate')`,
        collection,
        row.id,
        identifier,
        row.body,
        srvCreated,
        srvModified,
        isValid,
        revision,
      );
    }
    clocks.set(collection, Math.max(priorClock, srvModified));
  }

  for (const [collection, lastModified] of clocks) {
    sql.exec(
      `INSERT INTO collection_clocks (collection, last_srv_modified)
       VALUES (?, ?)
       ON CONFLICT(collection) DO UPDATE SET
         last_srv_modified = MAX(collection_clocks.last_srv_modified, excluded.last_srv_modified)`,
      collection,
      lastModified,
    );
  }
}

export class SqliteDocumentRepository {
  constructor(private readonly storage: DurableObjectStorage) {}

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  private findByIdRow(id: string): DbDocumentV4 | undefined {
    return this.sql.exec<DbDocumentV4>(
      `SELECT * FROM documents WHERE collection = ? AND id = ? LIMIT 1`,
      TREATMENTS,
      id,
    ).toArray()[0];
  }

  private findByIdentifierRow(identifier: string): DbDocumentV4 | undefined {
    return this.sql.exec<DbDocumentV4>(
      `SELECT * FROM documents
       WHERE collection = ? AND identifier = ?
       ORDER BY srv_modified DESC, updated_at DESC, id ASC
       LIMIT 1`,
      TREATMENTS,
      identifier,
    ).toArray()[0];
  }

  private findByFallbackRow(key: string, legacyOnly: boolean): DbDocumentV4 | undefined {
    return this.sql.exec<DbDocumentV4>(
      `SELECT * FROM documents
       WHERE collection = ? AND fallback_key = ? ${legacyOnly ? "AND identifier IS NULL" : ""}
       ORDER BY srv_modified DESC, updated_at DESC, id ASC
       LIMIT 1`,
      TREATMENTS,
      key,
    ).toArray()[0];
  }

  private findByIdentity(identity: string): DbDocumentV4 | undefined {
    return this.findByIdentifierRow(identity) ?? this.findByIdRow(identity);
  }

  private findApi3CreateCandidate(document: JsonDocument): DbDocumentV4 | undefined {
    const identifier = requestedIdentifier(document);
    if (identifier !== null) {
      const identified = this.findByIdentifierRow(identifier) ?? this.findByIdRow(identifier);
      if (identified !== undefined) return identified;
    }
    const id = requestedId(document);
    if (id !== null) {
      const identified = this.findByIdRow(id);
      if (identified !== undefined) return identified;
    }
    const key = fallbackKey(document);
    return key === null ? undefined : this.findByFallbackRow(key, true);
  }

  private findTreatmentUpsertCandidate(document: JsonDocument): DbDocumentV4 | undefined {
    const identifier = requestedIdentifier(document);
    if (identifier !== null) {
      return this.findByIdentifierRow(identifier) ?? this.findByIdRow(identifier);
    }
    const id = requestedId(document);
    if (id !== null) return this.findByIdRow(id);
    const key = fallbackKey(document);
    return key === null ? undefined : this.findByFallbackRow(key, false);
  }

  private nextSrvModified(now: number): number {
    const last = this.sql.exec<ClockRow>(
      "SELECT last_srv_modified FROM collection_clocks WHERE collection = ? LIMIT 1",
      TREATMENTS,
    ).toArray()[0]?.last_srv_modified ?? 0;
    const next = Math.max(Math.trunc(now), last + 1);
    this.sql.exec(
      `INSERT INTO collection_clocks (collection, last_srv_modified)
       VALUES (?, ?)
       ON CONFLICT(collection) DO UPDATE SET last_srv_modified = excluded.last_srv_modified`,
      TREATMENTS,
      next,
    );
    return next;
  }

  private assertWritable(row: DbDocumentV4): void {
    const document = materialize(row);
    if (document.isReadOnly === true || document.readOnly === true || document.readonly === true) {
      throw new Error("Trying to modify read-only document");
    }
  }

  private writeSnapshot(
    id: string,
    document: JsonDocument,
    existing: DbDocumentV4 | undefined,
    operation: "create" | "replace" | "patch" | "delete",
  ): DocumentMutationResult {
    const srvModified = this.nextSrvModified(Date.now());
    const srvCreated = existing?.srv_created ?? srvModified;
    if (srvCreated === null) throw new Error("existing document has no srvCreated metadata");
    const revision = (existing?.revision ?? 0) + 1;
    const identifier = requestedIdentifier(document);
    const isValid = document.isValid === false ? 0 : 1;
    const stored = { ...document };
    stored._id = id;
    if (identifier === null) delete stored.identifier;
    else stored.identifier = identifier;
    stored.srvCreated = srvCreated;
    stored.srvModified = srvModified;
    if (isValid === 0) stored.isValid = false;
    const body = JSON.stringify(stored);
    const now = Date.now();

    this.sql.exec(
      `INSERT INTO documents
        (collection, id, body, sort_time, created_at, updated_at, identifier,
         srv_created, srv_modified, is_valid, fallback_key, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(collection, id) DO UPDATE SET
         body = excluded.body,
         sort_time = excluded.sort_time,
         updated_at = excluded.updated_at,
         identifier = excluded.identifier,
         srv_created = excluded.srv_created,
         srv_modified = excluded.srv_modified,
         is_valid = excluded.is_valid,
         fallback_key = excluded.fallback_key,
         revision = excluded.revision`,
      TREATMENTS,
      id,
      body,
      sortTime(stored, srvModified),
      existing?.created_at ?? now,
      now,
      identifier,
      srvCreated,
      srvModified,
      isValid,
      fallbackKey(stored),
      revision,
    );
    this.sql.exec(
      `INSERT INTO document_changes
        (collection, id, identifier, body, srv_created, srv_modified, is_valid, revision, operation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      TREATMENTS,
      id,
      identifier,
      body,
      srvCreated,
      srvModified,
      isValid,
      revision,
      operation,
    );

    const result: DocumentMutationResult = {
      document: stored,
      created: existing === undefined,
      deduplicated: existing !== undefined,
      revision,
      srvModified,
    };
    const oldIdentifier = existing?.identifier ?? (existing === undefined ? null : existing.id);
    if (existing !== undefined && oldIdentifier !== identifier && oldIdentifier !== null) {
      result.deduplicatedIdentifier = oldIdentifier;
    }
    return result;
  }

  findTreatmentById(id: string, includeDeleted = false): JsonDocument | null {
    const row = this.findByIdRow(id);
    if (row === undefined || (!includeDeleted && row.is_valid === 0)) return null;
    return materialize(row);
  }

  findTreatmentByIdentifier(identifier: string, includeDeleted = false): JsonDocument | null {
    const row = this.findByIdentifierRow(identifier) ?? this.findByIdRow(identifier);
    if (row === undefined || (!includeDeleted && row.is_valid === 0)) return null;
    return materialize(row);
  }

  findTreatmentByFallback(createdAt: JsonValue, eventType: JsonValue, includeDeleted = false): JsonDocument | null {
    const key = fallbackKey({ created_at: createdAt, eventType });
    const row = key === null ? undefined : this.findByFallbackRow(key, false);
    if (row === undefined || (!includeDeleted && row.is_valid === 0)) return null;
    return materialize(row);
  }

  queryTreatments(query: DocumentQuery = {}): JsonDocument[] {
    const clauses = ["collection = ?"];
    const bindings: SqlStorageValue[] = [TREATMENTS];
    if (query.includeDeleted !== true) clauses.push("is_valid != 0");
    for (const filter of query.filters ?? []) appendFilter(clauses, bindings, filter);

    let order = "sort_time DESC, srv_modified DESC, id ASC";
    if (query.sort !== undefined) {
      const expression = fieldExpression(query.sort.field);
      order = `${expression.sql} ${query.sort.direction === "asc" ? "ASC" : "DESC"}, id ASC`;
      bindings.push(...expression.bindings);
    }
    bindings.push(boundedLimit(query.limit), boundedSkip(query.skip));
    const rows = this.sql.exec<DbDocumentV4>(
      `SELECT * FROM documents
       WHERE ${clauses.join(" AND ")}
       ORDER BY ${order}
       LIMIT ? OFFSET ?`,
      ...bindings,
    ).toArray();
    return rows.map(materialize).map((document) => project(document, query.fields));
  }

  upsertTreatment(input: JsonDocument): DocumentMutationResult {
    return this.storage.transactionSync(() => {
      const document = normalizeTreatmentIdentity(input);
      const existing = this.findTreatmentUpsertCandidate(document);
      if (existing !== undefined) this.assertWritable(existing);
      const id = existing?.id ?? requestedId(document) ?? randomObjectId();
      if (existing !== undefined && existing.is_valid === 0 && document.isValid === undefined) {
        delete document.isValid;
      }
      return this.writeSnapshot(id, document, existing, existing === undefined ? "create" : "replace");
    });
  }

  createTreatment(input: JsonDocument): DocumentMutationResult {
    return this.storage.transactionSync(() => {
      const document = normalizeTreatmentIdentity(input);
      const existing = this.findApi3CreateCandidate(document);
      if (existing !== undefined) this.assertWritable(existing);
      const id = existing?.id ?? requestedId(document) ?? randomObjectId();
      if (existing !== undefined && existing.is_valid === 0 && document.isValid === undefined) {
        delete document.isValid;
      }
      return this.writeSnapshot(id, document, existing, existing === undefined ? "create" : "replace");
    });
  }

  replaceTreatment(identity: string, input: JsonDocument): DocumentMutationResult {
    return this.storage.transactionSync(() => {
      const existing = this.findByIdentity(identity);
      if (existing === undefined) {
        const document = normalizeTreatmentIdentity({ ...input, identifier: identity });
        return this.writeSnapshot(requestedId(document) ?? randomObjectId(), document, undefined, "create");
      }
      this.assertWritable(existing);
      if (existing.is_valid === 0) throw new Error("document is deleted");
      const document = normalizeTreatmentIdentity({ ...input });
      document._id = existing.id;
      document.identifier = existing.identifier ?? identity;
      delete document.isValid;
      return this.writeSnapshot(existing.id, document, existing, "replace");
    });
  }

  patchTreatment(identity: string, patch: JsonDocument): DocumentMutationResult | null {
    return this.storage.transactionSync(() => {
      const existing = this.findByIdentity(identity);
      if (existing === undefined) return null;
      this.assertWritable(existing);
      if (existing.is_valid === 0) throw new Error("document is deleted");
      const original = materialize(existing);
      for (const field of ["_id", "identifier", "srvCreated", "srvModified", "isValid"]) {
        if (patch[field] !== undefined && patch[field] !== original[field]) {
          throw new Error(`Field ${field} cannot be modified by the client`);
        }
      }
      const document = { ...original, ...patch };
      delete document.isValid;
      return this.writeSnapshot(existing.id, document, existing, "patch");
    });
  }

  deleteTreatment(identity: string, permanent = false): DocumentDeleteResult {
    return this.storage.transactionSync(() => {
      const existing = this.findByIdentity(identity);
      if (existing === undefined) return { deleted: false, permanent };
      this.assertWritable(existing);
      if (permanent) {
        this.sql.exec(
          "DELETE FROM document_changes WHERE collection = ? AND id = ?",
          TREATMENTS,
          existing.id,
        );
        this.sql.exec(
          "DELETE FROM documents WHERE collection = ? AND id = ?",
          TREATMENTS,
          existing.id,
        );
        return { deleted: true, permanent: true };
      }
      const document = materialize(existing);
      document.isValid = false;
      const mutation = this.writeSnapshot(existing.id, document, existing, "delete");
      return {
        deleted: true,
        permanent: false,
        revision: mutation.revision,
        srvModified: mutation.srvModified,
      };
    });
  }

  deleteTreatmentById(id: string): boolean {
    return this.storage.transactionSync(() => {
      const existing = this.findByIdRow(id);
      if (existing === undefined) return false;
      this.assertWritable(existing);
      this.sql.exec("DELETE FROM document_changes WHERE collection = ? AND id = ?", TREATMENTS, id);
      this.sql.exec("DELETE FROM documents WHERE collection = ? AND id = ?", TREATMENTS, id);
      return true;
    });
  }

  treatmentsLastModified(): number | null {
    return this.sql.exec<ClockRow>(
      "SELECT last_srv_modified FROM collection_clocks WHERE collection = ? LIMIT 1",
      TREATMENTS,
    ).toArray()[0]?.last_srv_modified ?? null;
  }

  treatmentHistory(query: DocumentHistoryQuery): JsonDocument[] {
    if (!Number.isFinite(query.since)) throw new Error("history timestamp must be finite");
    const comparison = query.inclusive === true ? ">=" : ">";
    const rows = this.sql.exec<DbChange>(
      `WITH ranked AS (
         SELECT change_id, id, identifier, body, srv_created, srv_modified, is_valid, revision,
                ROW_NUMBER() OVER (
                  PARTITION BY id ORDER BY srv_modified DESC, change_id DESC
                ) AS latest_rank
         FROM document_changes
         WHERE collection = ? AND srv_modified ${comparison} ?
       )
       SELECT change_id, id, identifier, body, srv_created, srv_modified, is_valid, revision
       FROM ranked
       WHERE latest_rank = 1
       ORDER BY srv_modified ASC, change_id ASC
       LIMIT ?`,
      TREATMENTS,
      Math.trunc(query.since),
      boundedLimit(query.limit),
    ).toArray();
    return rows.map(materializeChange).map((document) => project(document, query.fields));
  }
}
