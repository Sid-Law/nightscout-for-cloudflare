import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PLUGIN_NOTIFICATIONS_TASK, type BackgroundTaskRow } from "../src/background-tasks";
import {
  DATA_UPDATE_DEBOUNCE_MS,
  DATA_UPDATE_MAX_WAIT_MS,
  SqliteDataUpdateDebounceRepository,
} from "../src/data-update-debounce";
import type { EntryStore } from "../src/entry-store";
import type { NightscoutStatusEnvironment } from "../src/status";

interface MutableEntryStoreSurface {
  env: NightscoutStatusEnvironment;
  processDueBackgroundTasks: (now: number) => void;
  processPluginNotificationTask: (task: BackgroundTaskRow, now: number) => void;
}

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function store(name: string): DurableObjectStub<EntryStore> {
  return env.ENTRY_STORE.getByName(name);
}

async function withRepository<T>(
  prefix: string,
  operation: (repository: SqliteDataUpdateDebounceRepository) => T | Promise<T>,
): Promise<T> {
  return runInDurableObject(store(tenant(prefix)), async (_instance, state) =>
    operation(new SqliteDataUpdateDebounceRepository(state.storage)));
}

describe("locked bootevent leading/trailing debounce contract", () => {
  it("fires the first data-received update on the leading edge", async () => {
    await withRepository("debounce-leading", (repository) => {
      expect(repository.record(PLUGIN_NOTIFICATIONS_TASK, 10_000)).toBe(true);
      expect(repository.state(PLUGIN_NOTIFICATIONS_TASK)).toMatchObject({
        burst_started_at: 10_000,
        last_event_at: 10_000,
        due_at: 10_000 + DATA_UPDATE_DEBOUNCE_MS,
        pending: 0,
      });
      expect(repository.nextDeadline()).toBeNull();
    });
  });

  it("fires a tick immediately when it starts a quiet new burst", async () => {
    await withRepository("debounce-tick", (repository) => {
      expect(repository.record(PLUGIN_NOTIFICATIONS_TASK, 10_000)).toBe(true);
      expect(repository.record(
        PLUGIN_NOTIFICATIONS_TASK,
        10_000 + DATA_UPDATE_DEBOUNCE_MS + 1,
      )).toBe(true);
      expect(repository.state(PLUGIN_NOTIFICATIONS_TASK)).toMatchObject({
        burst_started_at: 11_001,
        pending: 0,
      });
    });
  });

  it("coalesces 20 rapid data-received events into at most three runs", async () => {
    await withRepository("debounce-20", (repository) => {
      const base = 20_000;
      let runs = 0;
      for (let index = 0; index < 20; index += 1) {
        if (repository.record(PLUGIN_NOTIFICATIONS_TASK, base + index * 10)) runs += 1;
      }
      const dueAt = base + 190 + DATA_UPDATE_DEBOUNCE_MS;
      expect(runs).toBe(1);
      expect(repository.nextDeadline()).toBe(dueAt);
      expect(repository.consumeDue(dueAt - 1)).toEqual([]);
      runs += repository.consumeDue(dueAt).length;
      expect(runs).toBeGreaterThan(0);
      expect(runs).toBeLessThanOrEqual(3);
    });
  });

  it("coalesces a 50-event burst into far fewer than 50 runs", async () => {
    await withRepository("debounce-50", (repository) => {
      const base = 30_000;
      let runs = 0;
      for (let index = 0; index < 50; index += 1) {
        if (repository.record(PLUGIN_NOTIFICATIONS_TASK, base + index)) runs += 1;
      }
      const dueAt = base + 49 + DATA_UPDATE_DEBOUNCE_MS;
      runs += repository.consumeDue(dueAt).length;
      expect(runs).toBe(2);
      expect(runs).toBeLessThan(50);
    });
  });

  it("serializes the trailing claim so evaluation cannot overlap", async () => {
    await withRepository("debounce-serial", (repository) => {
      repository.record(PLUGIN_NOTIFICATIONS_TASK, 40_000);
      repository.record(PLUGIN_NOTIFICATIONS_TASK, 40_050);
      const dueAt = 40_050 + DATA_UPDATE_DEBOUNCE_MS;
      expect(repository.consumeDue(dueAt)).toEqual([PLUGIN_NOTIFICATIONS_TASK]);
      expect(repository.consumeDue(dueAt)).toEqual([]);
      expect(repository.state(PLUGIN_NOTIFICATIONS_TASK)).toBeNull();
    });
  });

  it("retains one pending final run for events received during a burst", async () => {
    await withRepository("debounce-pending", (repository) => {
      repository.record(PLUGIN_NOTIFICATIONS_TASK, 50_000);
      for (const offset of [50, 100, 150]) {
        expect(repository.record(PLUGIN_NOTIFICATIONS_TASK, 50_000 + offset)).toBe(false);
      }
      const dueAt = 50_150 + DATA_UPDATE_DEBOUNCE_MS;
      expect(repository.state(PLUGIN_NOTIFICATIONS_TASK)).toMatchObject({ pending: 1, due_at: dueAt });
      expect(repository.consumeDue(dueAt)).toEqual([PLUGIN_NOTIFICATIONS_TASK]);
    });
  });

  it("runs the trailing edge only after the burst becomes quiet", async () => {
    await withRepository("debounce-trailing", (repository) => {
      repository.record(PLUGIN_NOTIFICATIONS_TASK, 60_000);
      repository.record(PLUGIN_NOTIFICATIONS_TASK, 60_500);
      const dueAt = 60_500 + DATA_UPDATE_DEBOUNCE_MS;
      expect(repository.consumeDue(dueAt - 1)).toEqual([]);
      expect(repository.consumeDue(dueAt)).toEqual([PLUGIN_NOTIFICATIONS_TASK]);
    });
  });

  it("processes events spaced beyond one second as independent leading edges", async () => {
    await withRepository("debounce-spaced", (repository) => {
      let leadingRuns = 0;
      for (const eventAt of [70_000, 71_500, 73_000]) {
        if (repository.record(PLUGIN_NOTIFICATIONS_TASK, eventAt)) leadingRuns += 1;
      }
      expect(leadingRuns).toBe(3);
      expect(repository.nextDeadline()).toBeNull();
    });
  });

  it("forces a sustained burst to a trailing run within five seconds", async () => {
    await withRepository("debounce-maxwait", (repository) => {
      const base = 80_000;
      expect(repository.record(PLUGIN_NOTIFICATIONS_TASK, base)).toBe(true);
      for (let offset = 500; offset <= 4_500; offset += 500) {
        expect(repository.record(PLUGIN_NOTIFICATIONS_TASK, base + offset)).toBe(false);
      }
      const maxWaitAt = base + DATA_UPDATE_MAX_WAIT_MS;
      expect(repository.nextDeadline()).toBe(maxWaitAt);
      expect(repository.consumeDue(maxWaitAt - 1)).toEqual([]);
      expect(repository.consumeDue(maxWaitAt)).toEqual([PLUGIN_NOTIFICATIONS_TASK]);
    });
  });

  it("wires schema v16 into real Profile batches and evaluates leading plus final state", async () => {
    const stub = store(tenant("debounce-integration"));
    await runInDurableObject(stub, async (instance, state) => {
      const mutable = instance as unknown as MutableEntryStoreSurface;
      const originalEnvironment = { ...mutable.env };
      const originalProcessor = mutable.processPluginNotificationTask.bind(instance);
      let runs = 0;
      mutable.processPluginNotificationTask = (task, now) => {
        runs += 1;
        originalProcessor(task, now);
      };
      Object.assign(mutable.env, {
        ENABLE: undefined,
        DISABLE: undefined,
        BG_HIGH: "200",
        BG_TARGET_TOP: "180",
        BG_TARGET_BOTTOM: "80",
        BG_LOW: "55",
      });
      try {
        expect(state.storage.sql.exec<{ present: number }>(
          "SELECT EXISTS(SELECT 1 FROM _sql_schema_migrations WHERE id = 16) AS present",
        ).one().present).toBe(1);

        const start = Date.now() - 60_000;
        await instance.createDocuments("profile", JSON.stringify(
          Array.from({ length: 20 }, (_, index) => ({
            defaultProfile: `Batch-${index}`,
            startDate: new Date(start + index).toISOString(),
            units: "mg/dl",
            store: {
              [`Batch-${index}`]: {
                dia: 3,
                units: "mg/dl",
                basal: [{ time: "00:00", value: 0.5 }],
              },
            },
          })),
        ));
        expect(runs).toBe(1);
        const row = state.storage.sql.exec<{ due_at: number; pending: number }>(
          `SELECT due_at, pending FROM data_update_debounce
           WHERE kind = ? LIMIT 1`,
          PLUGIN_NOTIFICATIONS_TASK,
        ).one();
        expect(row.pending).toBe(1);
        expect(await state.storage.getAlarm()).not.toBeNull();

        mutable.processDueBackgroundTasks(row.due_at);
        expect(runs).toBe(2);
        expect(state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM data_update_debounce",
        ).one().count).toBe(0);
      } finally {
        mutable.processPluginNotificationTask = originalProcessor;
        Object.assign(mutable.env, originalEnvironment, {
          ENABLE: originalEnvironment.ENABLE,
          DISABLE: originalEnvironment.DISABLE,
          BG_HIGH: originalEnvironment.BG_HIGH,
          BG_TARGET_TOP: originalEnvironment.BG_TARGET_TOP,
          BG_TARGET_BOTTOM: originalEnvironment.BG_TARGET_BOTTOM,
          BG_LOW: originalEnvironment.BG_LOW,
        });
      }
    });
  });
});
