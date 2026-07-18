import type { JsonDocument, JsonValue } from "./entry-store";

const TREATMENTS = "treatments";
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELD_NAME = /^[A-Za-z0-9_.-]+$/;
const MAX_LIMIT = 10_000;
const MAX_SQL_BINDINGS = 100;
const MAX_SQL_STATEMENT_BYTES = 100_000;
const MAX_LIKE_PATTERN_BYTES = 50;

type FilterOperator =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "nin"
  | "re"
  | "exists";

type MaterializationPolicy = "api3" | "legacy";
type MutationPolicy = "api3" | "legacy";

const API3_IMMUTABLE_FIELDS = [
  "identifier",
  "date",
  "utcOffset",
  "eventType",
  "device",
  "app",
  "srvCreated",
  "subject",
  "srvModified",
  "modifiedBy",
  "isValid",
] as const;

export class DocumentQueryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DocumentQueryError";
  }
}

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
  srvModified: number | null;
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
  identifier_present: number | null;
  srv_created: number | null;
  srv_modified: number | null;
  is_valid: number | null;
  fallback_key: string | null;
  revision: number | null;
  srv_metadata_version: number | null;
}

interface ClockRow {
  [key: string]: SqlStorageValue;
  last_srv_modified: number;
}

interface MaxModifiedRow {
  [key: string]: SqlStorageValue;
  srv_modified: number | null;
  created_at_number: number | null;
}

interface TextModifiedRow {
  [key: string]: SqlStorageValue;
  created_at_text: string;
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

function canonicalCreatedAt(value: JsonValue | undefined): JsonValue | undefined {
  if (typeof value !== "string") return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
}

function fallbackKey(document: JsonDocument): string | null {
  const createdAt = canonicalCreatedAt(document.created_at);
  const eventType = document.eventType;
  if (
    (typeof createdAt !== "string" && typeof createdAt !== "number") ||
    (typeof eventType !== "string" && typeof eventType !== "number")
  ) {
    return null;
  }
  return JSON.stringify([createdAt, eventType]);
}

function hasOwn(document: JsonDocument, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(document, field);
}

function identifierMetadata(document: JsonDocument): {
  identifier: string | null;
  present: 0 | 1;
} {
  if (!hasOwn(document, "identifier")) return { identifier: null, present: 0 };
  return {
    identifier: typeof document.identifier === "string" ? document.identifier : null,
    present: 1,
  };
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

function utcOffsetMinutes(value: JsonValue | undefined): number {
  if (typeof value !== "string") return 0;
  if (/[zZ]$/.test(value)) return 0;
  const match = /([+-])(\d{2}):?(\d{2})$/.exec(value);
  if (match === null) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

/**
 * The single-document part of locked v15.0.7 treatments.prepareData(). It
 * intentionally runs before the v1 upsert selector: created_at is UTC,
 * eventTime overrides it, numeric fields are normalized, and utcOffset still
 * comes from the original created_at value. The preBolus fan-out is documented
 * separately below.
 */
function normalizeLegacyTreatment(document: JsonDocument): JsonDocument {
  const normalized = { ...document };
  const originalCreatedAt = normalized.created_at;
  const parsed = typeof originalCreatedAt === "number"
    ? originalCreatedAt
    : typeof originalCreatedAt === "string"
      ? Date.parse(originalCreatedAt)
      : Number.NaN;
  const createdAt = Number.isFinite(parsed) ? new Date(parsed) : new Date();
  normalized.created_at = createdAt.toISOString();
  normalized.utcOffset = utcOffsetMinutes(originalCreatedAt);

  if (normalized.eventTime) {
    const eventTime = new Date(normalized.eventTime as string | number);
    normalized.created_at = eventTime.toISOString();
  }

  // Keep the query-relevant body representation aligned with the locked
  // treatments.prepareData implementation. It eagerly coerces all numeric
  // fields before applying its historical empty/NaN cleanup rules.
  const numericFields = [
    "glucose",
    "targetTop",
    "targetBottom",
    "carbs",
    "insulin",
    "duration",
    "percent",
    "absolute",
    "relative",
    "preBolus",
  ] as const;
  for (const field of numericFields) normalized[field] = Number(normalized[field]);

  // The locked implementation moves carbs to a second, shifted treatment for
  // preBolus. That fan-out is outside this vertical slice, so keep carbs on the
  // original record rather than silently losing them.
  if (normalized.eventType === "Announcement") normalized.isAnnouncement = true;
  delete normalized.eventTime;

  for (const field of [
    "targetTop",
    "targetBottom",
    "carbs",
    "insulin",
    "percent",
    "relative",
    "notes",
    "preBolus",
  ] as const) {
    if (!normalized[field] || normalized[field] === 0) delete normalized[field];
  }
  for (const field of ["absolute", "duration"] as const) {
    if (Number.isNaN(normalized[field])) delete normalized[field];
  }
  if (normalized.glucose === 0 || Number.isNaN(normalized.glucose)) {
    delete normalized.glucose;
    delete normalized.glucoseType;
    delete normalized.units;
  }
  return normalized;
}

function materializeApi3(row: Pick<DbDocumentV4, "id" | "body">): JsonDocument {
  const document = parseBody(row.body);
  if (!document.identifier) document.identifier = row.id;
  delete document._id;

  // Locked API3 resolves fallback dates only after the storage query. This is
  // deliberately virtual: created_at can appear as srv* in a response without
  // making a legacy document match srv* search or history predicates.
  if (!document.srvModified) {
    const fallback = timestamp(document.created_at);
    if (fallback !== null) document.srvModified = fallback;
  }
  if (document.srvModified && !document.srvCreated) {
    const modified = timestamp(document.srvModified);
    if (modified !== null) document.srvCreated = modified;
  }
  return document;
}

function materializeLegacy(row: Pick<DbDocumentV4, "id" | "body">): JsonDocument {
  const document = parseBody(row.body);
  document._id = row.id;
  return document;
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

interface FieldExpression {
  sql: string;
  bindings: SqlStorageValue[];
  existsSql: string;
  existsBindings: SqlStorageValue[];
}

function fieldExpression(field: string, policy: MaterializationPolicy): FieldExpression {
  if (!FIELD_NAME.test(field)) {
    throw new DocumentQueryError("QUERY_FIELD_INVALID", `invalid query field ${field}`);
  }
  switch (field) {
    case "_id":
      return { sql: "id", bindings: [], existsSql: "1", existsBindings: [] };
    case "identifier":
      return {
        sql: "identifier",
        bindings: [],
        existsSql: "identifier_present != 0",
        existsBindings: [],
      };
    case "srvCreated":
    case "srvModified":
      // API3 filters the raw Mongo document before resolveDates() adds any
      // created_at fallback. Query the preserved body to keep that ordering.
      break;
    case "isValid":
      if (policy === "api3") {
        return { sql: "is_valid", bindings: [], existsSql: "1", existsBindings: [] };
      }
      break;
  }
  return {
    sql: "json_extract(body, ?)",
    bindings: [`$.${field}`],
    existsSql: "json_type(body, ?) IS NOT NULL",
    existsBindings: [`$.${field}`],
  };
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function appendFilter(
  clauses: string[],
  bindings: SqlStorageValue[],
  filter: DocumentFilter,
  policy: MaterializationPolicy,
): void {
  if (
    policy === "legacy"
    && filter.field === "_id"
    && filter.operator === "eq"
    && typeof filter.value === "string"
    && UUID.test(filter.value)
  ) {
    clauses.push("(identifier = ? OR id = ?)");
    bindings.push(filter.value, filter.value);
    return;
  }
  const expression = fieldExpression(filter.field, policy);
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
      if (values.length > MAX_SQL_BINDINGS) {
        throw new DocumentQueryError(
          "QUERY_BINDING_LIMIT",
          `document query exceeds SQLite's ${MAX_SQL_BINDINGS} bound-parameter limit`,
        );
      }
      const hasNull = values.some((value) => value === null);
      const nonNullValues = values.filter((value) => value !== null);
      const placeholders = nonNullValues.map(() => "?").join(", ");
      if (filter.operator === "in") {
        if (hasNull) {
          clauses.push(nonNullValues.length === 0
            ? `(NOT (${expression.existsSql}) OR ${expression.sql} IS NULL)`
            : `(NOT (${expression.existsSql}) OR ${expression.sql} IS NULL OR ${expression.sql} IN (${placeholders}))`);
          bindings.push(
            ...expression.existsBindings,
            ...expression.bindings,
            ...(nonNullValues.length === 0 ? [] : expression.bindings),
            ...nonNullValues.map(sqlValue),
          );
        } else {
          addExpression();
          clauses.push(`${expression.sql} IN (${placeholders})`);
          bindings.push(...nonNullValues.map(sqlValue));
        }
      } else if (hasNull) {
        clauses.push(nonNullValues.length === 0
          ? `(NOT (${expression.existsSql}) OR ${expression.sql} IS NOT NULL)`
          : `(NOT (${expression.existsSql}) OR (${expression.sql} IS NOT NULL AND ${expression.sql} NOT IN (${placeholders})))`);
        bindings.push(
          ...expression.existsBindings,
          ...expression.bindings,
          ...(nonNullValues.length === 0 ? [] : expression.bindings),
          ...nonNullValues.map(sqlValue),
        );
      } else {
        addExpression();
        clauses.push(`(${expression.sql} IS NULL OR ${expression.sql} NOT IN (${placeholders}))`);
        bindings.push(...expression.bindings, ...nonNullValues.map(sqlValue));
      }
      return;
    }
    case "re": {
      addExpression();
      const pattern = `%${escapeLike(String(filter.value))}%`;
      if (new TextEncoder().encode(pattern).byteLength > MAX_LIKE_PATTERN_BYTES) {
        throw new DocumentQueryError(
          "QUERY_LIKE_PATTERN_LIMIT",
          `LIKE pattern exceeds SQLite's ${MAX_LIKE_PATTERN_BYTES}-byte limit`,
        );
      }
      clauses.push(`CAST(${expression.sql} AS TEXT) LIKE ? ESCAPE '\\'`);
      bindings.push(pattern);
      return;
    }
    case "exists": {
      const exists = filter.value !== false
        && filter.value !== 0
        && filter.value !== "false"
        && filter.value !== "0";
      clauses.push(exists ? expression.existsSql : `NOT (${expression.existsSql})`);
      bindings.push(...expression.existsBindings);
      return;
    }
    default:
      throw new DocumentQueryError(
        "QUERY_OPERATOR_UNSUPPORTED",
        `unsupported document query operator ${String(filter.operator)}`,
      );
  }
}

function assertSqlQueryWithinLimits(statement: string, bindings: SqlStorageValue[]): void {
  if (bindings.length > MAX_SQL_BINDINGS) {
    throw new DocumentQueryError(
      "QUERY_BINDING_LIMIT",
      `document query exceeds SQLite's ${MAX_SQL_BINDINGS} bound-parameter limit`,
    );
  }
  if (new TextEncoder().encode(statement).byteLength > MAX_SQL_STATEMENT_BYTES) {
    throw new DocumentQueryError(
      "QUERY_STATEMENT_LIMIT",
      `document query exceeds SQLite's ${MAX_SQL_STATEMENT_BYTES}-byte statement limit`,
    );
  }
}

function tableColumnNames(sql: SqlStorage, table: "documents" | "document_changes"): Set<string> {
  return new Set(
    sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map((column) => column.name),
  );
}

function changeTableNeedsNullableSrvColumns(sql: SqlStorage): boolean {
  const columns = sql.exec<{ name: string; notnull: number }>(
    "PRAGMA table_info(document_changes)",
  ).toArray();
  return columns.some(
    (column) => (column.name === "srv_created" || column.name === "srv_modified")
      && column.notnull !== 0,
  );
}

function rebuildChangeTableWithNullableSrvColumns(sql: SqlStorage): void {
  if (!changeTableNeedsNullableSrvColumns(sql)) return;
  sql.exec(`
    ALTER TABLE document_changes RENAME TO document_changes_v4_not_null;
    CREATE TABLE document_changes (
      change_id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      identifier TEXT,
      identifier_present INTEGER,
      body TEXT NOT NULL,
      srv_created INTEGER,
      srv_modified INTEGER,
      is_valid INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      operation TEXT NOT NULL,
      srv_metadata_version INTEGER
    );
    INSERT INTO document_changes
      (change_id, collection, id, identifier, identifier_present, body,
       srv_created, srv_modified, is_valid, revision, operation, srv_metadata_version)
    SELECT change_id, collection, id, identifier, identifier_present, body,
           srv_created, srv_modified, is_valid, revision, operation, srv_metadata_version
    FROM document_changes_v4_not_null;
    DROP TABLE document_changes_v4_not_null;
  `);
}

function addColumn(sql: SqlStorage, columns: Set<string>, name: string, definition: string): void {
  if (columns.has(name)) return;
  sql.exec(`ALTER TABLE documents ADD COLUMN ${name} ${definition}`);
  columns.add(name);
}

export function migrateDocumentsV4(sql: SqlStorage): void {
  const columns = tableColumnNames(sql, "documents");
  addColumn(sql, columns, "identifier", "TEXT");
  addColumn(sql, columns, "identifier_present", "INTEGER");
  addColumn(sql, columns, "srv_created", "INTEGER");
  addColumn(sql, columns, "srv_modified", "INTEGER");
  addColumn(sql, columns, "is_valid", "INTEGER");
  addColumn(sql, columns, "fallback_key", "TEXT");
  addColumn(sql, columns, "revision", "INTEGER");
  addColumn(sql, columns, "srv_metadata_version", "INTEGER");

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
      identifier_present INTEGER,
      body TEXT NOT NULL,
      srv_created INTEGER,
      srv_modified INTEGER,
      is_valid INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      operation TEXT NOT NULL,
      srv_metadata_version INTEGER
    );
  `);

  const changeColumns = tableColumnNames(sql, "document_changes");
  const changePresenceWasMissing = !changeColumns.has("identifier_present");
  if (changePresenceWasMissing) {
    sql.exec("ALTER TABLE document_changes ADD COLUMN identifier_present INTEGER");
    changeColumns.add("identifier_present");
  }
  if (!changeColumns.has("srv_metadata_version")) {
    sql.exec("ALTER TABLE document_changes ADD COLUMN srv_metadata_version INTEGER");
    changeColumns.add("srv_metadata_version");
  }
  rebuildChangeTableWithNullableSrvColumns(sql);

  sql.exec(`
    CREATE INDEX IF NOT EXISTS documents_collection_sort
      ON documents(collection, sort_time DESC);
    CREATE INDEX IF NOT EXISTS documents_collection_identifier
      ON documents(collection, identifier);
    CREATE INDEX IF NOT EXISTS documents_collection_identifier_presence
      ON documents(collection, identifier_present, identifier);
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
           identifier, identifier_present, srv_created, srv_modified, is_valid, fallback_key,
           revision, srv_metadata_version
    FROM documents
    WHERE identifier_present IS NULL OR srv_metadata_version IS NULL
       OR is_valid IS NULL OR revision IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM document_changes
         WHERE document_changes.collection = documents.collection
           AND document_changes.id = documents.id
           AND document_changes.revision = documents.revision
       )
    ORDER BY collection ASC, updated_at ASC, id ASC
  `).toArray();

  for (const row of rows) {
    const collection = String(row.collection);
    const document = parseBody(row.body);
    // v4 rows written before this repair may contain an allocator/upload time
    // even though their preserved body never had srv*. Rebuild the nullable
    // metadata from the body, which is the locked Mongo-observable source.
    const srvModified = finiteInteger(document.srvModified);
    const srvCreated = finiteInteger(document.srvCreated);
    const isValid = row.is_valid ?? (document.isValid === false ? 0 : 1);
    const identity = identifierMetadata(document);
    const identifierPresent = identity.present;
    const identifier = identity.identifier;
    // Older v4 builds stored the literal created_at offset in fallback_key.
    // Recompute treatment metadata from the preserved body so equivalent
    // -05:00 and Z retransmissions converge after upgrade.
    const documentFallback = collection === TREATMENTS
      ? fallbackKey(document)
      : row.fallback_key;
    const revision = row.revision ?? 1;

    sql.exec(
      `UPDATE documents
       SET identifier = ?, srv_created = ?, srv_modified = ?, is_valid = ?,
           identifier_present = ?, fallback_key = ?, revision = ?, srv_metadata_version = 1
       WHERE collection = ? AND id = ?`,
      identifier,
      srvCreated,
      srvModified,
      isValid,
      identifierPresent,
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
          (collection, id, identifier, identifier_present, body, srv_created, srv_modified,
           is_valid, revision, operation, srv_metadata_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'migrate', 1)`,
        collection,
        row.id,
        identifier,
        identifierPresent,
        row.body,
        srvCreated,
        srvModified,
        isValid,
        revision,
      );
    }
  }

  const changes = sql.exec<{ change_id: number; body: string }>(
    `SELECT change_id, body FROM document_changes
     WHERE identifier_present IS NULL OR srv_metadata_version IS NULL`,
  ).toArray();
  for (const change of changes) {
    const document = parseBody(change.body);
    const identity = identifierMetadata(document);
    sql.exec(
      `UPDATE document_changes
       SET identifier_present = ?, srv_created = ?, srv_modified = ?, srv_metadata_version = 1
       WHERE change_id = ?`,
      identity.present,
      finiteInteger(document.srvCreated),
      finiteInteger(document.srvModified),
      change.change_id,
    );
  }

  sql.exec(`
    INSERT INTO collection_clocks (collection, last_srv_modified)
    SELECT collection, MAX(srv_modified)
    FROM documents
    WHERE srv_modified IS NOT NULL
    GROUP BY collection
    ON CONFLICT(collection) DO UPDATE SET
      last_srv_modified = excluded.last_srv_modified
    WHERE excluded.last_srv_modified > collection_clocks.last_srv_modified
  `);
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

  private findLegacyByIdRow(id: string): DbDocumentV4 | undefined {
    return this.sql.exec<DbDocumentV4>(
      `SELECT * FROM documents
       WHERE collection = ? AND id = ? AND identifier_present = 0
       LIMIT 1`,
      TREATMENTS,
      id,
    ).toArray()[0];
  }

  private findByFallbackRow(key: string, legacyOnly: boolean): DbDocumentV4 | undefined {
    return this.sql.exec<DbDocumentV4>(
      `SELECT * FROM documents
       WHERE collection = ? AND fallback_key = ? ${legacyOnly ? "AND identifier_present = 0" : ""}
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
      const identified = this.findByIdentifierRow(identifier)
        ?? (OBJECT_ID.test(identifier) ? this.findLegacyByIdRow(identifier.toLowerCase()) : undefined);
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
    const document = materializeLegacy(row);
    if (document.isReadOnly === true || document.readOnly === true || document.readonly === true) {
      throw new Error("Trying to modify read-only document");
    }
  }

  private assertApi3ImmutableFields(
    row: DbDocumentV4,
    document: JsonDocument,
    isDeduplication = false,
    resolveStoredDates = false,
  ): void {
    this.assertWritable(row);
    if (row.is_valid === 0) return;
    const stored = resolveStoredDates ? materializeApi3(row) : materializeLegacy(row);
    if (!resolveStoredDates) stored.identifier = row.identifier || row.id;
    for (const field of API3_IMMUTABLE_FIELDS) {
      if (field === "identifier" && isDeduplication) continue;
      if (document[field] !== undefined && document[field] !== stored[field]) {
        throw new Error(`Field ${field} cannot be modified by the client`);
      }
    }
  }

  private writeSnapshot(
    id: string,
    document: JsonDocument,
    existing: DbDocumentV4 | undefined,
    operation: "create" | "replace" | "patch" | "delete",
    policy: MutationPolicy,
    serverSrvCreated?: number,
  ): DocumentMutationResult {
    const revision = (existing?.revision ?? 0) + 1;
    const identity = identifierMetadata(document);
    const identifier = identity.identifier;
    const isValid = document.isValid === false ? 0 : 1;
    const stored = { ...document };
    stored._id = id;
    const generatedSrvModified = policy === "api3"
      ? this.nextSrvModified(Date.now())
      : null;
    if (policy === "api3") {
      if (generatedSrvModified === null) throw new Error("API3 srvModified allocation failed");
      if (operation === "patch" || operation === "delete") {
        // Locked PATCH and soft DELETE only persist srvModified. If a legacy
        // document has no srvCreated, READ will resolve it virtually later.
        stored.srvModified = generatedSrvModified;
      } else {
        const rawExisting = existing === undefined ? undefined : parseBody(existing.body);
        stored.srvCreated = existing === undefined
          ? generatedSrvModified
          : serverSrvCreated
            ?? finiteInteger(rawExisting?.srvCreated)
            ?? generatedSrvModified;
        stored.srvModified = generatedSrvModified;
      }
    }
    if (isValid === 0) stored.isValid = false;
    const srvCreated = finiteInteger(stored.srvCreated);
    const srvModified = finiteInteger(stored.srvModified);
    const body = JSON.stringify(stored);
    const now = Date.now();

    this.sql.exec(
      `INSERT INTO documents
        (collection, id, body, sort_time, created_at, updated_at, identifier,
         identifier_present, srv_created, srv_modified, is_valid, fallback_key, revision,
         srv_metadata_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(collection, id) DO UPDATE SET
         body = excluded.body,
         sort_time = excluded.sort_time,
         updated_at = excluded.updated_at,
         identifier = excluded.identifier,
         identifier_present = excluded.identifier_present,
         srv_created = excluded.srv_created,
         srv_modified = excluded.srv_modified,
         is_valid = excluded.is_valid,
         fallback_key = excluded.fallback_key,
         revision = excluded.revision,
         srv_metadata_version = excluded.srv_metadata_version`,
      TREATMENTS,
      id,
      body,
      sortTime(stored, existing?.sort_time ?? now),
      existing?.created_at ?? now,
      now,
      identifier,
      identity.present,
      srvCreated,
      srvModified,
      isValid,
      fallbackKey(stored),
      revision,
    );
    this.sql.exec(
      `INSERT INTO document_changes
        (collection, id, identifier, identifier_present, body, srv_created, srv_modified,
         is_valid, revision, operation, srv_metadata_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      TREATMENTS,
      id,
      identifier,
      identity.present,
      body,
      srvCreated,
      srvModified,
      isValid,
      revision,
      operation,
    );

    const result: DocumentMutationResult = {
      document: policy === "api3"
        ? materializeApi3({
          id,
          body,
        })
        : stored,
      created: existing === undefined,
      deduplicated: existing !== undefined,
      revision,
      srvModified,
    };
    const oldIdentifier = existing === undefined ? null : existing.identifier || existing.id;
    if (existing !== undefined && oldIdentifier !== identifier && oldIdentifier !== null) {
      result.deduplicatedIdentifier = oldIdentifier;
    }
    return result;
  }

  findTreatmentById(id: string, includeDeleted = false): JsonDocument | null {
    const row = this.findByIdRow(id);
    if (row === undefined || (!includeDeleted && row.is_valid === 0)) return null;
    return materializeApi3(row);
  }

  findTreatmentByIdentifier(identifier: string, includeDeleted = false): JsonDocument | null {
    const row = this.findByIdentifierRow(identifier) ?? this.findByIdRow(identifier);
    if (row === undefined || (!includeDeleted && row.is_valid === 0)) return null;
    return materializeApi3(row);
  }

  findTreatmentByFallback(createdAt: JsonValue, eventType: JsonValue, includeDeleted = false): JsonDocument | null {
    const key = fallbackKey({ created_at: createdAt, eventType });
    const row = key === null ? undefined : this.findByFallbackRow(key, true);
    if (row === undefined || (!includeDeleted && row.is_valid === 0)) return null;
    return materializeApi3(row);
  }

  private queryTreatmentRows(
    query: DocumentQuery,
    policy: MaterializationPolicy,
  ): DbDocumentV4[] {
    const clauses = ["collection = ?"];
    const bindings: SqlStorageValue[] = [TREATMENTS];
    if (policy === "api3" && query.includeDeleted !== true) clauses.push("is_valid != 0");
    for (const filter of query.filters ?? []) appendFilter(clauses, bindings, filter, policy);

    let order = policy === "legacy"
      ? "json_extract(body, '$.created_at') DESC, id ASC"
      : "sort_time DESC, srv_modified DESC, id ASC";
    if (query.sort !== undefined) {
      const expression = fieldExpression(query.sort.field, policy);
      order = `${expression.sql} ${query.sort.direction === "asc" ? "ASC" : "DESC"}, id ASC`;
      bindings.push(...expression.bindings);
    }
    bindings.push(boundedLimit(query.limit), boundedSkip(query.skip));
    const statement = `SELECT * FROM documents
       WHERE ${clauses.join(" AND ")}
       ORDER BY ${order}
       LIMIT ? OFFSET ?`;
    assertSqlQueryWithinLimits(statement, bindings);
    return this.sql.exec<DbDocumentV4>(statement, ...bindings).toArray();
  }

  queryTreatments(query: DocumentQuery = {}): JsonDocument[] {
    return this.queryTreatmentRows(query, "api3")
      .map(materializeApi3)
      .map((document) => project(document, query.fields));
  }

  queryLegacyTreatments(query: DocumentQuery = {}): JsonDocument[] {
    return this.queryTreatmentRows(query, "legacy")
      .map(materializeLegacy)
      .map((document) => project(document, query.fields));
  }

  upsertTreatment(input: JsonDocument): DocumentMutationResult {
    return this.storage.transactionSync(() => {
      const document = normalizeLegacyTreatment(normalizeTreatmentIdentity(input));
      const existing = this.findTreatmentUpsertCandidate(document);
      if (requestedIdentifier(document) !== null) delete document._id;
      const id = existing?.id ?? requestedId(document) ?? randomObjectId();
      return this.writeSnapshot(
        id,
        document,
        existing,
        existing === undefined ? "create" : "replace",
        "legacy",
      );
    });
  }

  createTreatment(input: JsonDocument): DocumentMutationResult {
    return this.storage.transactionSync(() => {
      const document = normalizeTreatmentIdentity(input);
      const existing = this.findApi3CreateCandidate(document);
      if (existing !== undefined) this.assertApi3ImmutableFields(existing, document, true);
      const id = existing?.id ?? requestedId(document) ?? randomObjectId();
      return this.writeSnapshot(
        id,
        document,
        existing,
        existing === undefined ? "create" : "replace",
        "api3",
      );
    });
  }

  replaceTreatment(identity: string, input: JsonDocument): DocumentMutationResult {
    return this.storage.transactionSync(() => {
      const existing = this.findByIdentity(identity);
      if (existing === undefined) {
        const document = normalizeTreatmentIdentity({ ...input, identifier: identity });
        return this.writeSnapshot(
          requestedId(document) ?? randomObjectId(),
          document,
          undefined,
          "create",
          "api3",
        );
      }
      if (existing.is_valid === 0) throw new Error("document is deleted");
      const document = normalizeTreatmentIdentity({ ...input });
      document._id = existing.id;
      document.identifier = identity;
      this.assertApi3ImmutableFields(existing, document, false, true);
      const resolvedExisting = materializeApi3(existing);
      if (resolvedExisting.srvCreated !== undefined) {
        document.srvCreated = resolvedExisting.srvCreated;
      }
      const serverSrvCreated = finiteInteger(resolvedExisting.srvCreated);
      return this.writeSnapshot(
        existing.id,
        document,
        existing,
        "replace",
        "api3",
        serverSrvCreated ?? undefined,
      );
    });
  }

  patchTreatment(identity: string, patch: JsonDocument): DocumentMutationResult | null {
    return this.storage.transactionSync(() => {
      const existing = this.findByIdentity(identity);
      if (existing === undefined) return null;
      if (existing.is_valid === 0) throw new Error("document is deleted");
      this.assertApi3ImmutableFields(existing, patch, false, true);
      const original = materializeLegacy(existing);
      const document = { ...original, ...patch };
      return this.writeSnapshot(existing.id, document, existing, "patch", "api3");
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
      const document = materializeLegacy(existing);
      document.isValid = false;
      const mutation = this.writeSnapshot(existing.id, document, existing, "delete", "api3");
      if (mutation.srvModified === null) throw new Error("soft delete has no srvModified");
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
      this.sql.exec("DELETE FROM document_changes WHERE collection = ? AND id = ?", TREATMENTS, id);
      this.sql.exec("DELETE FROM documents WHERE collection = ? AND id = ?", TREATMENTS, id);
      return true;
    });
  }

  deleteLegacyTreatment(identity: string): boolean {
    return this.storage.transactionSync(() => {
      const existing = OBJECT_ID.test(identity)
        ? this.findByIdRow(identity.toLowerCase())
        : UUID.test(identity)
          ? this.findByIdentifierRow(identity) ?? this.findByIdRow(identity)
          : undefined;
      if (existing === undefined) return false;
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
      return true;
    });
  }

  treatmentsLastModified(): number | null {
    const row = this.sql.exec<MaxModifiedRow>(
      `SELECT MAX(CASE
                    WHEN json_type(body, '$.srvModified') IN ('integer', 'real')
                      THEN CAST(json_extract(body, '$.srvModified') AS INTEGER)
                    ELSE NULL
                  END) AS srv_modified,
              MAX(CASE
                    WHEN json_type(body, '$.created_at') IN ('integer', 'real')
                      THEN CAST(json_extract(body, '$.created_at') AS INTEGER)
                    ELSE NULL
                  END) AS created_at_number
       FROM documents
       WHERE collection = ?`,
      TREATMENTS,
    ).one();
    const textCreatedAt = this.sql.exec<TextModifiedRow>(
      `SELECT json_extract(body, '$.created_at') AS created_at_text
       FROM documents
       WHERE collection = ?
         AND json_type(body, '$.created_at') = 'text'
         AND julianday(json_extract(body, '$.created_at')) IS NOT NULL
       ORDER BY julianday(json_extract(body, '$.created_at')) DESC
       LIMIT 1`,
      TREATMENTS,
    ).toArray()[0]?.created_at_text;
    const candidates = [
      row.srv_modified,
      row.created_at_number,
      textCreatedAt === undefined ? null : timestamp(textCreatedAt),
    ].filter((value): value is number => value !== null);
    return candidates.length === 0 ? null : Math.max(...candidates);
  }

  treatmentHistory(query: DocumentHistoryQuery): JsonDocument[] {
    if (!Number.isFinite(query.since)) throw new Error("history timestamp must be finite");
    const comparison = query.inclusive === true ? ">=" : ">";
    const rows = this.sql.exec<DbDocumentV4>(
      `SELECT *
       FROM documents
       WHERE collection = ?
         AND srv_modified ${comparison} ?
       ORDER BY srv_modified ASC, id ASC
       LIMIT ?`,
      TREATMENTS,
      Math.trunc(query.since),
      boundedLimit(query.limit),
    ).toArray();
    return rows.map(materializeApi3).map((document) => project(document, query.fields));
  }
}
