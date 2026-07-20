import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  loadNightscoutDatabaseStats,
  sqliteNightscoutDatabaseStats,
} from "../src/data-loader";

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

describe("locked Nightscout dataloader.test.js", () => {
  it("waits for Promise-based database stats before completing the update", async () => {
    const data = { dbstats: {} as Record<string, unknown> };
    let resolved = false;

    await loadNightscoutDatabaseStats(data, {
      stats: async () => {
        await Promise.resolve();
        resolved = true;
        return { dataSize: 123, indexSize: 456 };
      },
    });

    expect(resolved).toBe(true);
    expect(data.dbstats).toEqual({ dataSize: 123, indexSize: 456 });
  });
});

describe("SQLite Durable Object dataloader adapter", () => {
  it("completes safely when the stats provider rejects", async () => {
    const data = { dbstats: { stale: true } as Record<string, unknown> };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(loadNightscoutDatabaseStats(data, {
      stats: () => Promise.reject(new Error("stats unavailable")),
    })).resolves.toBeUndefined();
    expect(data.dbstats).toEqual({});
    expect(log).toHaveBeenCalledWith("Problem loading database stats");
    expect(error).toHaveBeenCalledOnce();
    log.mockRestore();
    error.mockRestore();
  });

  it("maps Cloudflare total bytes without double-counting indexes", () => {
    expect(sqliteNightscoutDatabaseStats(12_345)).toEqual({
      dataSize: 12_345,
      indexSize: 0,
    });
    expect(sqliteNightscoutDatabaseStats(Number.NaN)).toEqual({
      dataSize: 0,
      indexSize: 0,
    });
  });

  it("publishes the real tenant SQLite size through v2 ddata", async () => {
    const name = tenant("dataloader-stats");
    const stub = env.ENTRY_STORE.getByName(name);
    const response = await SELF.fetch(
      `https://example.test/api/v2/ddata/at?tenant=${encodeURIComponent(name)}`,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as {
      dbstats: { dataSize: number; indexSize: number };
    };
    expect(body.dbstats.indexSize).toBe(0);
    expect(body.dbstats.dataSize).toBeGreaterThan(0);

    await runInDurableObject(stub, async (_instance, state) => {
      expect(body.dbstats.dataSize).toBe(state.storage.sql.databaseSize);
    });
  });
});
