export interface NightscoutDatabaseStats {
  dataSize: unknown;
  indexSize: unknown;
}

export interface NightscoutDataWithStats {
  dbstats: Record<string, unknown>;
}

export interface NightscoutDatabaseStatsSource {
  stats: () => NightscoutDatabaseStats | null | undefined |
    Promise<NightscoutDatabaseStats | null | undefined>;
}

/**
 * Locked dataloader.update() waits for Promise-based db.stats() before its
 * completion callback. Workers uses the same await boundary without Node's
 * async.parallel callback shell.
 */
export async function loadNightscoutDatabaseStats(
  data: NightscoutDataWithStats,
  database: NightscoutDatabaseStatsSource,
): Promise<void> {
  data.dbstats = {};
  try {
    const result = await Promise.resolve(database.stats());
    if (result !== null && result !== undefined) {
      data.dbstats = {
        dataSize: result.dataSize,
        indexSize: result.indexSize,
      };
    }
  } catch (error) {
    console.log("Problem loading database stats");
    if (error !== undefined && error !== null) console.error(error);
  }
}

/**
 * Cloudflare exposes the complete SQLite file size, not MongoDB's separate
 * data/index sizes. Put the total in dataSize and zero in indexSize so the
 * locked dbsize plugin's sum remains the real byte total.
 */
export function sqliteNightscoutDatabaseStats(databaseSize: number): {
  dataSize: number;
  indexSize: number;
} {
  return {
    dataSize: Number.isFinite(databaseSize) && databaseSize >= 0 ? databaseSize : 0,
    indexSize: 0,
  };
}
