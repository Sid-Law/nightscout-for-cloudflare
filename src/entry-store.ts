import { DurableObject } from "cloudflare:workers";
import {
  createJwtSecret,
  issueJwt as signJwt,
  verifyJwt as validateJwt,
} from "./jwt";
import type { HistoryQuery, PublicEntry, ValidatedEntry } from "./model";

export type DocumentCollection =
  | "activity"
  | "food"
  | "profile"
  | "treatments"
  | "devicestatus"
  | "subjects"
  | "roles";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface JsonDocument {
  [key: string]: JsonValue;
}

interface DbEntry {
  [key: string]: SqlStorageValue;
  id: string;
  identifier: string | null;
  dedupe_key: string;
  sgv: number;
  date: number;
  date_string: string;
  direction: string;
  device: string;
  type: "sgv";
}

interface DbDocument {
  [key: string]: SqlStorageValue;
  id: string;
  body: string;
  sort_time: number;
}

interface DbSecret {
  [key: string]: SqlStorageValue;
  value: string;
}

export interface WriteResult {
  inserted: number;
  duplicates: number;
  entries: PublicEntry[];
}

function randomObjectId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toPublicEntry(row: DbEntry): PublicEntry {
  const entry: PublicEntry = {
    _id: row.id,
    sgv: row.sgv,
    date: row.date,
    dateString: row.date_string,
    direction: row.direction,
    device: row.device,
    type: "sgv",
  };
  if (row.identifier !== null) entry.identifier = row.identifier;
  return entry;
}

function documentSortTime(document: JsonDocument): number {
  for (const field of ["date", "mills", "created_at", "timestamp", "startDate"]) {
    const value = document[field];
    if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return Date.now();
}

function toDocument(row: DbDocument): JsonDocument {
  return JSON.parse(row.body) as JsonDocument;
}

export class EntryStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const version = this.ctx.storage.sql
      .exec<{ version: number }>(
        "SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations",
      )
      .one().version;

    if (version < 1) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS entries (
          id TEXT PRIMARY KEY,
          identifier TEXT UNIQUE,
          dedupe_key TEXT NOT NULL UNIQUE,
          sgv INTEGER NOT NULL CHECK (sgv >= 20 AND sgv <= 600),
          date INTEGER NOT NULL,
          date_string TEXT NOT NULL,
          direction TEXT NOT NULL,
          device TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type = 'sgv'),
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS entries_date_desc ON entries(date DESC);
        INSERT INTO _sql_schema_migrations (id) VALUES (1);
      `);
    }

    if (version < 2) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS documents (
          collection TEXT NOT NULL,
          id TEXT NOT NULL,
          body TEXT NOT NULL,
          sort_time INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (collection, id)
        );
        CREATE INDEX IF NOT EXISTS documents_collection_sort
          ON documents(collection, sort_time DESC);
        INSERT INTO _sql_schema_migrations (id) VALUES (2);
      `);
    }

    if (version < 3) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS tenant_secrets (
          name TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        INSERT INTO _sql_schema_migrations (id) VALUES (3);
      `);
    }
  }

  private getOrCreateJwtSecret(): string {
    const existing = this.ctx.storage.sql
      .exec<DbSecret>(
        "SELECT value FROM tenant_secrets WHERE name = 'authorization-jwt' LIMIT 1",
      )
      .toArray()[0];
    if (existing !== undefined) return existing.value;

    const value = createJwtSecret();
    this.ctx.storage.sql.exec(
      "INSERT INTO tenant_secrets (name, value, created_at) VALUES ('authorization-jwt', ?, ?)",
      value,
      Date.now(),
    );
    return value;
  }

  async issueAccessJwt(accessToken: string): Promise<string> {
    if (accessToken.length === 0 || accessToken.length > 512) {
      throw new Error("invalid access token length");
    }
    return JSON.stringify(await signJwt(this.getOrCreateJwtSecret(), accessToken));
  }

  async verifyAccessJwt(token: string): Promise<string | null> {
    if (token.length === 0 || token.length > 4096) return null;
    const claims = await validateJwt(this.getOrCreateJwtSecret(), token);
    return claims === null ? null : JSON.stringify(claims);
  }

  async putEntries(entries: ValidatedEntry[]): Promise<WriteResult> {
    let inserted = 0;
    let duplicates = 0;
    const stored: PublicEntry[] = [];

    for (const entry of entries) {
      const id = entry.requestedId ?? randomObjectId();
      const existing = this.ctx.storage.sql
        .exec<DbEntry>(
          `SELECT id, identifier, dedupe_key, sgv, date, date_string, direction, device, type
           FROM entries
           WHERE dedupe_key = ? OR id = ? OR identifier = ?
           LIMIT 1`,
          entry.dedupeKey,
          id,
          entry.identifier,
        )
        .toArray()[0];

      if (existing !== undefined) {
        duplicates += 1;
        stored.push(toPublicEntry(existing));
        continue;
      }

      this.ctx.storage.sql.exec(
        `INSERT INTO entries
          (id, identifier, dedupe_key, sgv, date, date_string, direction, device, type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sgv', ?)`,
        id,
        entry.identifier,
        entry.dedupeKey,
        entry.sgv,
        entry.date,
        entry.dateString,
        entry.direction,
        entry.device,
        Date.now(),
      );
      inserted += 1;
      stored.push(
        toPublicEntry({
          id,
          identifier: entry.identifier,
          dedupe_key: entry.dedupeKey,
          sgv: entry.sgv,
          date: entry.date,
          date_string: entry.dateString,
          direction: entry.direction,
          device: entry.device,
          type: "sgv",
        }),
      );
    }

    return { inserted, duplicates, entries: stored };
  }

  async getEntries(query: HistoryQuery): Promise<PublicEntry[]> {
    const conditions: string[] = [];
    const bindings: number[] = [];
    const add = (operator: string, value: number | null): void => {
      if (value !== null) {
        conditions.push(`date ${operator} ?`);
        bindings.push(value);
      }
    };
    add(">", query.gt);
    add(">=", query.gte);
    add("<", query.lt);
    add("<=", query.lte);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.ctx.storage.sql
      .exec<DbEntry>(
        `SELECT id, identifier, dedupe_key, sgv, date, date_string, direction, device, type
         FROM entries ${where}
         ORDER BY date DESC
         LIMIT ?`,
        ...bindings,
        query.count,
      )
      .toArray();
    return rows.map(toPublicEntry);
  }

  async getCurrent(): Promise<PublicEntry[]> {
    const row = this.ctx.storage.sql
      .exec<DbEntry>(
        `SELECT id, identifier, dedupe_key, sgv, date, date_string, direction, device, type
         FROM entries
         ORDER BY date DESC
         LIMIT 1`,
      )
      .toArray()[0];
    return row === undefined ? [] : [toPublicEntry(row)];
  }

  async deleteEntries(
    ids: string[],
    lte: number | null = null,
    gte: number | null = null,
  ): Promise<number> {
    let deleted = 0;
    for (const id of ids) {
      deleted += this.ctx.storage.sql.exec("DELETE FROM entries WHERE id = ?", id).rowsWritten;
    }
    if (ids.length === 0 && (lte !== null || gte !== null)) {
      const conditions: string[] = [];
      const bindings: number[] = [];
      if (lte !== null) {
        conditions.push("date <= ?");
        bindings.push(lte);
      }
      if (gte !== null) {
        conditions.push("date >= ?");
        bindings.push(gte);
      }
      deleted += this.ctx.storage.sql
        .exec(`DELETE FROM entries WHERE ${conditions.join(" AND ")}`, ...bindings).rowsWritten;
    }
    return deleted;
  }

  async listDocuments(collection: DocumentCollection, limit = 5000): Promise<string> {
    const boundedLimit = Math.max(1, Math.min(10000, Math.trunc(limit)));
    const documents = this.ctx.storage.sql
      .exec<DbDocument>(
        `SELECT id, body, sort_time
         FROM documents
         WHERE collection = ?
         ORDER BY sort_time DESC, updated_at DESC
         LIMIT ?`,
        collection,
        boundedLimit,
      )
      .toArray()
      .map(toDocument);
    return JSON.stringify(documents);
  }

  async createDocuments(
    collection: DocumentCollection,
    documentsJson: string,
  ): Promise<string> {
    const documents = JSON.parse(documentsJson) as JsonDocument[];
    const now = Date.now();
    const stored: JsonDocument[] = [];
    for (const document of documents) {
      const id = typeof document._id === "string" ? document._id : randomObjectId();
      const normalized = { ...document, _id: id };
      this.ctx.storage.sql.exec(
        `INSERT INTO documents (collection, id, body, sort_time, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        collection,
        id,
        JSON.stringify(normalized),
        documentSortTime(normalized),
        now,
        now,
      );
      stored.push(normalized);
    }
    return JSON.stringify(stored);
  }

  async saveDocuments(
    collection: DocumentCollection,
    documentsJson: string,
  ): Promise<string> {
    const documents = JSON.parse(documentsJson) as JsonDocument[];
    const now = Date.now();
    for (const document of documents) {
      const id = document._id as string;
      this.ctx.storage.sql.exec(
        `INSERT INTO documents (collection, id, body, sort_time, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(collection, id) DO UPDATE SET
           body = excluded.body,
           sort_time = excluded.sort_time,
           updated_at = excluded.updated_at`,
        collection,
        id,
        JSON.stringify(document),
        documentSortTime(document),
        now,
        now,
      );
    }
    return JSON.stringify(documents);
  }

  async deleteDocuments(collection: DocumentCollection, ids: string[]): Promise<number> {
    let deleted = 0;
    for (const id of ids) {
      deleted += this.ctx.storage.sql
        .exec("DELETE FROM documents WHERE collection = ? AND id = ?", collection, id).rowsWritten;
    }
    return deleted;
  }

  async findDocumentByField(
    collection: DocumentCollection,
    field: string,
    expected: string,
  ): Promise<string | null> {
    const documents = JSON.parse(await this.listDocuments(collection)) as JsonDocument[];
    const found = documents.find((document) => document[field] === expected);
    return found === undefined ? null : JSON.stringify(found);
  }
}
