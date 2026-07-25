import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  entryStoreSchemaSupportsReadOnly,
  type EntryStore,
} from "../src/entry-store";
import { SqliteRealtimeSessionRepository } from "../src/realtime/session-repository";

describe("SQLite write-quota read-only fallback", () => {
  it("requires every migration marker and the exact Entries contract", async () => {
    const stub = env.ENTRY_STORE.getByName(
      `quota-readonly-${crypto.randomUUID().slice(0, 8)}`,
    );
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(entryStoreSchemaSupportsReadOnly(state.storage.sql)).toBe(true);

      state.storage.sql.exec(
        "DELETE FROM _sql_schema_migrations WHERE id = 10",
      );
      expect(entryStoreSchemaSupportsReadOnly(state.storage.sql)).toBe(false);
      state.storage.sql.exec(
        "INSERT INTO _sql_schema_migrations (id) VALUES (10)",
      );

      state.storage.sql.exec("DROP INDEX entries_date_desc");
      expect(entryStoreSchemaSupportsReadOnly(state.storage.sql)).toBe(false);
    });
  });

  it("automatically leaves quota mode at the next UTC reset", async () => {
    vi.useFakeTimers();
    try {
      const stub = env.ENTRY_STORE.getByName(
        `quota-reset-${crypto.randomUUID().slice(0, 8)}`,
      );
      await runInDurableObject(stub, async (instance: EntryStore) => {
        const internal = instance as unknown as {
          storageWriteQuotaBlockedUntil: number;
          storageWritesBlocked: () => boolean;
        };
        internal.storageWriteQuotaBlockedUntil =
          Date.parse("2026-07-26T00:00:00.000Z");

        vi.setSystemTime("2026-07-25T23:59:59.000Z");
        expect(internal.storageWritesBlocked()).toBe(true);

        vi.setSystemTime("2026-07-26T00:00:00.000Z");
        expect(internal.storageWritesBlocked()).toBe(false);
        expect(internal.storageWriteQuotaBlockedUntil).toBe(0);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes an existing WebSocket without mutating its durable session while blocked", async () => {
    const stub = env.ENTRY_STORE.getByName(
      `quota-websocket-${crypto.randomUUID().slice(0, 8)}`,
    );
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      const session = repository.createSession(Date.now(), "websocket");
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      state.acceptWebSocket(server, [
        "eio4-websocket",
        `eio4-sid:${session.sid}`,
      ]);
      server.serializeAttachment({
        version: 1,
        objectId: state.id.toString(),
        sid: session.sid,
        mode: "session",
      });
      client.accept();

      const before = state.storage.sql.exec<Record<string, SqlStorageValue>>(
        "SELECT * FROM realtime_sessions WHERE sid = ?",
        session.sid,
      ).one();
      const internal = instance as unknown as {
        storageWriteQuotaBlockedUntil: number;
      };
      internal.storageWriteQuotaBlockedUntil = Date.now() + 60_000;

      await instance.webSocketMessage(server, "2");

      const after = state.storage.sql.exec<Record<string, SqlStorageValue>>(
        "SELECT * FROM realtime_sessions WHERE sid = ?",
        session.sid,
      ).one();
      expect(after).toEqual(before);
    });
  });
});
