import { DurableObject } from "cloudflare:workers";
import type { HistoryQuery, PublicEntry, ValidatedEntry } from "./model";

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
}
