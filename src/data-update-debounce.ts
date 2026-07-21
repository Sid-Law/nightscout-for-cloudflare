export const DATA_UPDATE_DEBOUNCE_MS = 1_000;
export const DATA_UPDATE_MAX_WAIT_MS = 5_000;

interface DataUpdateDebounceRow {
  [key: string]: SqlStorageValue;
  kind: string;
  burst_started_at: number;
  last_event_at: number;
  due_at: number;
  pending: number;
}

interface TableInfoRow {
  [key: string]: SqlStorageValue;
  name: string;
}

const DATA_UPDATE_KIND = /^[a-z0-9-]{1,64}$/;

function timestamp(value: number): number {
  if (!Number.isFinite(value)) throw new Error("invalid data-update timestamp");
  return Math.max(0, Math.trunc(value));
}

function updateKind(value: string): string {
  if (!DATA_UPDATE_KIND.test(value)) throw new Error("invalid data-update kind");
  return value;
}

/**
 * Schema v16 replaces the Node process-local lodash timer and concurrency
 * flags used by bootevent. A row survives Durable Object eviction and records
 * only the active burst window. `pending = 0` is the leading-edge cooldown;
 * it intentionally has no platform alarm until a second event requires a
 * trailing run.
 */
export function migrateDataUpdateDebounceV16(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS data_update_debounce (
      kind TEXT PRIMARY KEY,
      burst_started_at INTEGER NOT NULL,
      last_event_at INTEGER NOT NULL,
      due_at INTEGER NOT NULL,
      pending INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0, 1))
    );
  `);
  const columns = new Set(
    storage.sql
      .exec<TableInfoRow>("PRAGMA table_info(data_update_debounce)")
      .toArray()
      .map((row) => row.name),
  );
  if (!columns.has("kind")) {
    throw new Error("data_update_debounce is missing its identity column");
  }
  for (const column of ["burst_started_at", "last_event_at", "due_at", "pending"] as const) {
    if (!columns.has(column)) {
      storage.sql.exec(
        `ALTER TABLE data_update_debounce ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`,
      );
    }
  }
  storage.sql.exec(`
    CREATE INDEX IF NOT EXISTS data_update_debounce_due
      ON data_update_debounce(pending, due_at, kind);
  `);
}

export class SqliteDataUpdateDebounceRepository {
  constructor(private readonly storage: DurableObjectStorage) {}

  /** Returns true only when the caller must execute the leading edge now. */
  record(kind: string, now: number): boolean {
    const normalizedKind = updateKind(kind);
    const eventAt = timestamp(now);
    const current = this.storage.sql.exec<DataUpdateDebounceRow>(
      `SELECT kind, burst_started_at, last_event_at, due_at, pending
       FROM data_update_debounce WHERE kind = ? LIMIT 1`,
      normalizedKind,
    ).toArray()[0];

    if (
      current === undefined
      || (current.pending === 0 && eventAt >= current.last_event_at + DATA_UPDATE_DEBOUNCE_MS)
    ) {
      this.storage.sql.exec(
        `INSERT INTO data_update_debounce
           (kind, burst_started_at, last_event_at, due_at, pending)
         VALUES (?, ?, ?, ?, 0)
         ON CONFLICT(kind) DO UPDATE SET
           burst_started_at = excluded.burst_started_at,
           last_event_at = excluded.last_event_at,
           due_at = excluded.due_at,
           pending = 0`,
        normalizedKind,
        eventAt,
        eventAt,
        eventAt + DATA_UPDATE_DEBOUNCE_MS,
      );
      return true;
    }

    const dueAt = Math.min(
      eventAt + DATA_UPDATE_DEBOUNCE_MS,
      current.burst_started_at + DATA_UPDATE_MAX_WAIT_MS,
    );
    this.storage.sql.exec(
      `UPDATE data_update_debounce
       SET last_event_at = ?, due_at = ?, pending = 1
       WHERE kind = ?`,
      eventAt,
      dueAt,
      normalizedKind,
    );
    return false;
  }

  nextDeadline(): number | null {
    return this.storage.sql.exec<{ due_at: number | null }>(
      "SELECT MIN(due_at) AS due_at FROM data_update_debounce WHERE pending = 1",
    ).one().due_at;
  }

  consumeDue(now: number, limit = 16): string[] {
    const at = timestamp(now);
    const boundedLimit = Math.max(1, Math.min(16, Math.trunc(limit)));
    const rows = this.storage.sql.exec<DataUpdateDebounceRow>(
      `SELECT kind, burst_started_at, last_event_at, due_at, pending
       FROM data_update_debounce
       WHERE pending = 1 AND due_at <= ?
       ORDER BY due_at ASC, kind ASC
       LIMIT ?`,
      at,
      boundedLimit,
    ).toArray();
    for (const row of rows) {
      this.storage.sql.exec(
        `DELETE FROM data_update_debounce
         WHERE kind = ? AND pending = 1 AND due_at <= ?`,
        row.kind,
        at,
      );
    }
    return rows.map((row) => row.kind);
  }

  state(kind: string): DataUpdateDebounceRow | null {
    return this.storage.sql.exec<DataUpdateDebounceRow>(
      `SELECT kind, burst_started_at, last_event_at, due_at, pending
       FROM data_update_debounce WHERE kind = ? LIMIT 1`,
      updateKind(kind),
    ).toArray()[0] ?? null;
  }
}
