export const ADMIN_NOTIFY_API_WINDOW_MS = 8 * 60 * 60 * 1_000;
export const ADMIN_NOTIFY_RETENTION_MS = 12 * 60 * 60 * 1_000;
export const ADMIN_NOTIFY_LIMIT = 128;

export const READABLE_SITE_ADMIN_NOTIFY = {
  title: "Nightscout readable by world",
  message:
    "Your Nightscout installation is readable by anyone who knows the web page URL. Please consider closing access to the site by following the instructions in the <a href=\"http://nightscout.github.io/nightscout/security/#how-to-turn-off-unauthorized-access\" target=\"_new\">Nightscout documentation</a>.",
  persistent: true,
} as const;

export interface AdminNotify extends Record<string, unknown> {
  title: string;
  message: string;
  count: number;
  lastRecorded: number;
  persistent?: boolean;
}

interface AdminNotifyRow {
  [key: string]: SqlStorageValue;
  message: string;
  body: string;
  count: number;
  last_recorded: number;
  persistent: number;
}

function timestamp(value: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : Date.now();
}

function normalizeNotification(value: Record<string, unknown>): Record<string, unknown> {
  return {
    ...value,
    title: value.title || "No title",
    message: value.message || "No message",
  };
}

function toAdminNotify(row: AdminNotifyRow): AdminNotify {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.body);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // A malformed row cannot originate from the repository, but the API must
    // stay usable if a development build left one behind.
  }
  return {
    ...body,
    title: typeof body.title === "string" ? body.title : "No title",
    message: row.message,
    count: row.count,
    lastRecorded: row.last_recorded,
    ...(row.persistent === 0 ? {} : { persistent: true }),
  };
}

/** SQLite Durable Object adapter for locked v15.0.7 lib/adminnotifies.js. */
export class SqliteAdminNotifyRepository {
  constructor(private readonly storage: DurableObjectStorage) {}

  migrate(): void {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS admin_notifies (
        message TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        count INTEGER NOT NULL,
        last_recorded INTEGER NOT NULL,
        persistent INTEGER NOT NULL CHECK (persistent IN (0, 1))
      );
      CREATE INDEX IF NOT EXISTS admin_notifies_recent
        ON admin_notifies(persistent, last_recorded DESC, message);
    `);
  }

  clean(now = Date.now()): void {
    const current = timestamp(now);
    this.storage.sql.exec(
      `DELETE FROM admin_notifies
       WHERE persistent = 0 AND last_recorded <= ?`,
      current - ADMIN_NOTIFY_RETENTION_MS,
    );
  }

  add(
    notification: Record<string, unknown> | null | undefined,
    enabled = true,
    now = Date.now(),
  ): void {
    if (!enabled || notification === null || notification === undefined) return;
    const current = timestamp(now);
    const normalized = normalizeNotification(notification);
    const message = String(normalized.message);
    const existing = this.storage.sql.exec<{ count: number }>(
      "SELECT count FROM admin_notifies WHERE message = ? LIMIT 1",
      message,
    ).toArray()[0];

    if (existing !== undefined) {
      // Upstream deduplicates only by message. It retains the first title and
      // persistence flag, then updates only count and lastRecorded.
      this.storage.sql.exec(
        `UPDATE admin_notifies
         SET count = ?, last_recorded = ?
         WHERE message = ?`,
        existing.count + 1,
        current,
        message,
      );
    } else {
      this.storage.sql.exec(
        `INSERT INTO admin_notifies
           (message, body, count, last_recorded, persistent)
         VALUES (?, ?, 1, ?, ?)`,
        message,
        JSON.stringify(normalized),
        current,
        normalized.persistent ? 1 : 0,
      );
    }

    this.clean(current);
    const excess = this.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM admin_notifies WHERE persistent = 0",
    ).one().count - ADMIN_NOTIFY_LIMIT;
    if (excess > 0) {
      // Upstream's process-local array is unbounded. A tenant can receive a
      // different message for each bad IP, so retain the ordinary recent
      // surface while protecting a Free-plan Durable Object from abuse.
      this.storage.sql.exec(
        `DELETE FROM admin_notifies
         WHERE message IN (
           SELECT message FROM admin_notifies
           WHERE persistent = 0
           ORDER BY last_recorded ASC, message ASC
           LIMIT ?
         )`,
        excess,
      );
    }
  }

  reconcileReadableSite(readable: boolean, enabled = true, now = Date.now()): void {
    if (!enabled) {
      this.storage.sql.exec("DELETE FROM admin_notifies");
      return;
    }
    if (readable) {
      const present = this.storage.sql.exec<{ present: number }>(
        "SELECT EXISTS(SELECT 1 FROM admin_notifies WHERE message = ?) AS present",
        READABLE_SITE_ADMIN_NOTIFY.message,
      ).one().present !== 0;
      if (!present) this.add(READABLE_SITE_ADMIN_NOTIFY, true, now);
      return;
    }
    this.storage.sql.exec(
      "DELETE FROM admin_notifies WHERE message = ?",
      READABLE_SITE_ADMIN_NOTIFY.message,
    );
  }

  listForApi(now = Date.now(), cleanExpired = true): AdminNotify[] {
    const current = timestamp(now);
    if (cleanExpired) this.clean(current);
    return this.storage.sql.exec<AdminNotifyRow>(
      `SELECT message, body, count, last_recorded, persistent
       FROM admin_notifies
       WHERE persistent = 1 OR last_recorded > ?
       ORDER BY last_recorded ASC, message ASC`,
      current - ADMIN_NOTIFY_API_WINDOW_MS,
    ).toArray().map(toAdminNotify);
  }
}
