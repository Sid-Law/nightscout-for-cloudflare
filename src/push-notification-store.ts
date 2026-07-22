import type { MakerStateStore } from "./plugins/maker";
import type {
  PushNotification,
  PushNotificationStateStore,
} from "./pushnotify";

interface StoredNotificationRow extends Record<string, SqlStorageValue> {
  notification_json: string;
}

const PUSH_STATE_LIMIT = 128;

function parseNotification(value: string): PushNotification | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as PushNotification
      : null;
  } catch {
    return null;
  }
}

/** SQLite replacement for pushnotify's process-local NodeCache instances. */
export class SqlitePushNotificationStateStore
implements PushNotificationStateStore, MakerStateStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  migrate(): void {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS push_recent (
        notification_key TEXT PRIMARY KEY,
        notification_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS push_recent_expiry
        ON push_recent(expires_at, notification_key);
      CREATE TABLE IF NOT EXISTS push_receipts (
        receipt TEXT PRIMARY KEY,
        notification_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS push_receipts_expiry
        ON push_receipts(expires_at, receipt);
      CREATE TABLE IF NOT EXISTS push_maker_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        last_all_clear_at INTEGER NOT NULL
      );
    `);
  }

  hasRecent(key: string, now: number): boolean {
    return this.storage.sql.exec<{ found: number }>(
      `SELECT EXISTS(
         SELECT 1 FROM push_recent
         WHERE notification_key = ? AND expires_at > ?
       ) AS found`,
      key,
      now,
    ).one().found !== 0;
  }

  putRecent(key: string, notification: PushNotification, expiresAt: number): void {
    this.storage.sql.exec(
      `INSERT INTO push_recent (notification_key, notification_json, expires_at)
       VALUES (?, ?, ?)
       ON CONFLICT(notification_key) DO UPDATE SET
         notification_json = excluded.notification_json,
         expires_at = excluded.expires_at`,
      key,
      JSON.stringify(notification),
      expiresAt,
    );
    this.storage.sql.exec(
      `DELETE FROM push_recent
       WHERE notification_key NOT IN (
         SELECT notification_key FROM push_recent
         ORDER BY expires_at DESC, notification_key ASC LIMIT ?
       )`,
      PUSH_STATE_LIMIT,
    );
  }

  receiptKeys(now: number): string[] {
    this.prune(now);
    return this.storage.sql.exec<{ receipt: string }>(
      `SELECT receipt FROM push_receipts
       WHERE expires_at > ? ORDER BY expires_at ASC, receipt ASC LIMIT ?`,
      now,
      PUSH_STATE_LIMIT,
    ).toArray().map((row) => row.receipt);
  }

  getReceipt(receipt: string, now: number): PushNotification | null {
    const row = this.storage.sql.exec<StoredNotificationRow>(
      `SELECT notification_json FROM push_receipts
       WHERE receipt = ? AND expires_at > ? LIMIT 1`,
      receipt,
      now,
    ).toArray()[0];
    if (row === undefined) return null;
    const parsed = parseNotification(row.notification_json);
    if (parsed === null) this.deleteReceipt(receipt);
    return parsed;
  }

  putReceipt(receipt: string, notification: PushNotification, expiresAt: number): void {
    this.storage.sql.exec(
      `INSERT INTO push_receipts (receipt, notification_json, expires_at)
       VALUES (?, ?, ?)
       ON CONFLICT(receipt) DO UPDATE SET
         notification_json = excluded.notification_json,
         expires_at = excluded.expires_at`,
      receipt,
      JSON.stringify(notification),
      expiresAt,
    );
    this.storage.sql.exec(
      `DELETE FROM push_receipts
       WHERE receipt NOT IN (
         SELECT receipt FROM push_receipts
         ORDER BY expires_at DESC, receipt ASC LIMIT ?
       )`,
      PUSH_STATE_LIMIT,
    );
  }

  deleteReceipt(receipt: string): void {
    this.storage.sql.exec("DELETE FROM push_receipts WHERE receipt = ?", receipt);
  }

  prune(now: number): void {
    this.storage.sql.exec("DELETE FROM push_recent WHERE expires_at <= ?", now);
    this.storage.sql.exec("DELETE FROM push_receipts WHERE expires_at <= ?", now);
  }

  getLastAllClear(): number {
    return this.storage.sql.exec<{ last_all_clear_at: number }>(
      "SELECT last_all_clear_at FROM push_maker_state WHERE singleton = 1",
    ).toArray()[0]?.last_all_clear_at ?? 0;
  }

  setLastAllClear(value: number): void {
    this.storage.sql.exec(
      `INSERT INTO push_maker_state (singleton, last_all_clear_at)
       VALUES (1, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         last_all_clear_at = excluded.last_all_clear_at`,
      value,
    );
  }
}
