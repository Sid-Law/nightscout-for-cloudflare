export const PLUGIN_NOTIFICATIONS_TASK = "plugin-notifications";

export interface BackgroundTaskRow {
  [key: string]: SqlStorageValue;
  kind: string;
  due_at: number;
  attempt_count: number;
  updated_at: number;
}

const BACKGROUND_TASK_KIND = /^[a-z0-9-]{1,64}$/;
const BACKGROUND_TASK_MAX_ATTEMPTS = 1_000_000;
const BACKGROUND_TASK_MAX_RETRY_MS = 5 * 60 * 1_000;

interface TableInfoRow {
  [key: string]: SqlStorageValue;
  name: string;
}

function timestamp(value: number): number {
  if (!Number.isFinite(value)) throw new Error("invalid background task timestamp");
  return Math.max(0, Math.trunc(value));
}

function taskKind(value: string): string {
  if (!BACKGROUND_TASK_KIND.test(value)) throw new Error("invalid background task kind");
  return value;
}

/**
 * Schema v14 stores every logical timer in SQLite. A Durable Object exposes a
 * single platform alarm, so the EntryStore derives that one alarm from this
 * table together with its realtime and authorization deadlines.
 */
export function migrateBackgroundTasksV14(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS background_tasks (
      kind TEXT PRIMARY KEY,
      due_at INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);
  const columns = new Set(
    storage.sql
      .exec<TableInfoRow>("PRAGMA table_info(background_tasks)")
      .toArray()
      .map((row) => row.name),
  );
  // Repair a partially applied v14 activation without discarding its due
  // work. `kind` and `due_at` are the minimum viable v14 table and therefore
  // cannot be synthesized safely when absent.
  if (!columns.has("kind") || !columns.has("due_at")) {
    throw new Error("background_tasks is missing its identity columns");
  }
  if (!columns.has("attempt_count")) {
    storage.sql.exec(
      "ALTER TABLE background_tasks ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!columns.has("updated_at")) {
    storage.sql.exec(
      "ALTER TABLE background_tasks ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
    );
  }
  storage.sql.exec(`
    CREATE INDEX IF NOT EXISTS background_tasks_due
      ON background_tasks(due_at, kind);
  `);
}

export class SqliteBackgroundTaskRepository {
  constructor(private readonly storage: DurableObjectStorage) {}

  has(kind: string): boolean {
    return this.storage.sql.exec<{ present: number }>(
      "SELECT EXISTS(SELECT 1 FROM background_tasks WHERE kind = ?) AS present",
      taskKind(kind),
    ).one().present !== 0;
  }

  schedule(kind: string, dueAt: number, now: number): void {
    this.storage.sql.exec(
      `INSERT INTO background_tasks (kind, due_at, attempt_count, updated_at)
       VALUES (?, ?, 0, ?)
       ON CONFLICT(kind) DO UPDATE SET
         due_at = MIN(background_tasks.due_at, excluded.due_at),
         attempt_count = 0,
         updated_at = excluded.updated_at`,
      taskKind(kind),
      timestamp(dueAt),
      timestamp(now),
    );
  }

  nextDeadline(): number | null {
    return this.storage.sql.exec<{ due_at: number | null }>(
      "SELECT MIN(due_at) AS due_at FROM background_tasks",
    ).one().due_at;
  }

  due(now: number, limit: number): BackgroundTaskRow[] {
    const boundedLimit = Math.max(1, Math.min(16, Math.trunc(limit)));
    return this.storage.sql.exec<BackgroundTaskRow>(
      `SELECT kind, due_at, attempt_count, updated_at
       FROM background_tasks
       WHERE due_at <= ?
       ORDER BY due_at ASC, kind ASC
       LIMIT ?`,
      timestamp(now),
      boundedLimit,
    ).toArray();
  }

  complete(kind: string, nextDueAt: number | null, now: number): void {
    const normalizedKind = taskKind(kind);
    if (nextDueAt === null) {
      this.storage.sql.exec("DELETE FROM background_tasks WHERE kind = ?", normalizedKind);
      return;
    }
    this.storage.sql.exec(
      `UPDATE background_tasks
       SET due_at = ?, attempt_count = 0, updated_at = ?
       WHERE kind = ?`,
      timestamp(nextDueAt),
      timestamp(now),
      normalizedKind,
    );
  }

  fail(kind: string, now: number): BackgroundTaskRow | null {
    const normalizedKind = taskKind(kind);
    const current = this.storage.sql.exec<BackgroundTaskRow>(
      `SELECT kind, due_at, attempt_count, updated_at
       FROM background_tasks WHERE kind = ? LIMIT 1`,
      normalizedKind,
    ).toArray()[0];
    if (current === undefined) return null;
    const attemptCount = Math.min(
      BACKGROUND_TASK_MAX_ATTEMPTS,
      Math.max(0, Math.trunc(current.attempt_count)) + 1,
    );
    const retryMs = Math.min(
      BACKGROUND_TASK_MAX_RETRY_MS,
      2_000 * (2 ** Math.min(7, attemptCount - 1)),
    );
    const dueAt = timestamp(now) + retryMs;
    this.storage.sql.exec(
      `UPDATE background_tasks
       SET due_at = ?, attempt_count = ?, updated_at = ?
       WHERE kind = ?`,
      dueAt,
      attemptCount,
      timestamp(now),
      normalizedKind,
    );
    return {
      kind: normalizedKind,
      due_at: dueAt,
      attempt_count: attemptCount,
      updated_at: timestamp(now),
    };
  }
}
