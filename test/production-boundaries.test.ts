import {
  env,
  evictDurableObject,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EntryStore } from "../src/entry-store";
import { parseEntryPayload } from "../src/model";

const RETIRED_TEST_DEVICE = "simulator://nscf-test";

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function store(name: string): DurableObjectStub<EntryStore> {
  return env.ENTRY_STORE.getByName(name) as DurableObjectStub<EntryStore>;
}

describe("production runtime boundaries", () => {
  it("does not expose the retired test-data route", async () => {
    const response = await SELF.fetch(
      `https://example.test/_nscf/simulated-cgm?tenant=${tenant("no-test-route")}`,
    );
    expect(response.status).toBe(404);
  });

  it("does not create test-feed state in a fresh Durable Object", async () => {
    const stub = store(tenant("clean-schema"));
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE type = 'table' AND name = 'simulated_cgm_state'`,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM _sql_schema_migrations WHERE id = 22",
      ).one().count).toBe(1);
    });
  });

  it("removes prior test-feed state and generated entries during migration", async () => {
    const stub = store(tenant("retired-test-data"));
    const now = Date.now();
    await runInDurableObject(stub, async (instance, state) => {
      await instance.putEntries(parseEntryPayload([{
        type: "sgv",
        sgv: 123,
        date: now,
        dateString: new Date(now).toISOString(),
        direction: "Flat",
        device: RETIRED_TEST_DEVICE,
      }]));
      state.storage.sql.exec(`
        CREATE TABLE simulated_cgm_state (
          singleton INTEGER PRIMARY KEY,
          enabled INTEGER NOT NULL,
          next_at INTEGER,
          sequence INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO simulated_cgm_state
          (singleton, enabled, next_at, sequence, updated_at)
        VALUES (1, 1, ${now + 300_000}, 1, ${now});
        DELETE FROM _sql_schema_migrations WHERE id = 22;
      `);
    });

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM entries WHERE device = ?",
        RETIRED_TEST_DEVICE,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM documents
         WHERE collection = 'entries'
           AND json_extract(body, '$.device') = ?`,
        RETIRED_TEST_DEVICE,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM document_changes
         WHERE collection = 'entries'
           AND json_extract(body, '$.device') = ?`,
        RETIRED_TEST_DEVICE,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE type = 'table' AND name = 'simulated_cgm_state'`,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM _sql_schema_migrations WHERE id = 22",
      ).one().count).toBe(1);
    });
  });
});
