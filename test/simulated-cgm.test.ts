import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EntryStore } from "../src/entry-store";
import type { NightscoutStatusEnvironment } from "../src/status";

interface MutableEntryStoreSurface {
  env: NightscoutStatusEnvironment;
}

const TEST_API_SECRET = "nscf-test-secret-20260717";

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

async function secretDigest(): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(TEST_API_SECRET),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function endpoint(tenantName: string, path: string): string {
  const url = new URL(path, "https://example.test/");
  url.searchParams.set("tenant", tenantName);
  return url.toString();
}

async function configure(tenantName: string, enabled: boolean): Promise<Response> {
  return SELF.fetch(endpoint(tenantName, "/_nscf/simulated-cgm"), {
    method: "POST",
    headers: {
      "api-secret": await secretDigest(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ enabled }),
  });
}

async function entries(tenantName: string): Promise<Record<string, unknown>[]> {
  const response = await SELF.fetch(endpoint(
    tenantName,
    "/api/v1/entries.json?count=100",
  ));
  expect(response.status).toBe(200);
  return response.json<Record<string, unknown>[]>();
}

describe("opt-in Cloudflare simulated CGM", () => {
  it("is disabled per tenant by default and rejects anonymous configuration", async () => {
    const tenantName = tenant("sim-cgm-default");
    const status = await SELF.fetch(endpoint(tenantName, "/_nscf/simulated-cgm"));
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      enabled: false,
      intervalMs: 300_000,
      nextAt: null,
      device: "simulator://nscf-test",
    });

    const denied = await SELF.fetch(endpoint(tenantName, "/_nscf/simulated-cgm"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(denied.status).toBe(401);
    expect(await entries(tenantName)).toEqual([]);
  });

  it("seeds one hour, survives eviction, and appends one fresh SGV per due alarm", async () => {
    const tenantName = tenant("sim-cgm-alarm");
    const enabled = await configure(tenantName, true);
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({
      enabled: true,
      intervalMs: 300_000,
      device: "simulator://nscf-test",
      nextAt: expect.any(Number),
    });

    const seeded = await entries(tenantName);
    expect(seeded).toHaveLength(12);
    expect(seeded.every((entry) => entry.device === "simulator://nscf-test")).toBe(true);
    const ascendingDates = seeded.map((entry) => Number(entry.date)).reverse();
    for (let index = 1; index < ascendingDates.length; index += 1) {
      expect(ascendingDates[index]! - ascendingDates[index - 1]!).toBe(300_000);
    }

    // Re-enabling an already-running tenant is idempotent and does not reseed.
    expect((await configure(tenantName, true)).status).toBe(200);
    expect(await entries(tenantName)).toHaveLength(12);

    const stub = env.ENTRY_STORE.getByName(tenantName) as DurableObjectStub<EntryStore>;
    await runInDurableObject(stub, async (_instance, state) => {
      const due = Date.now() - 1;
      state.storage.sql.exec(
        "UPDATE simulated_cgm_state SET next_at = ? WHERE singleton = 1",
        due,
      );
      await state.storage.setAlarm(due);
    });
    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const continued = await entries(tenantName);
    expect(continued).toHaveLength(13);
    expect(Number(continued[0]!.date)).toBeGreaterThanOrEqual(Date.now() - 5_000);
    await runInDurableObject(stub, async (_instance, state) => {
      const row = state.storage.sql.exec<{
        enabled: number;
        next_at: number | null;
        sequence: number;
      }>(
        "SELECT enabled, next_at, sequence FROM simulated_cgm_state WHERE singleton = 1",
      ).one();
      expect(row.enabled).toBe(1);
      expect(row.sequence).toBe(13);
      expect(row.next_at).toBeGreaterThan(Date.now());
      expect(await state.storage.getAlarm()).not.toBeNull();
    });

    const disabled = await configure(tenantName, false);
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ enabled: false, nextAt: null });
  });

  it("clears an existing stale-data alarm as soon as fresh simulated SGV data resumes", async () => {
    const tenantName = tenant("sim-cgm-all-clear");
    const stub = env.ENTRY_STORE.getByName(tenantName) as DurableObjectStub<EntryStore>;
    const now = Date.now();
    await runInDurableObject(stub, async (instance, state) => {
      Object.assign((instance as unknown as MutableEntryStoreSurface).env, {
        ENABLE: "timeago",
        DISABLE: "simplealarms treatmentnotify",
        TIMEAGO_ENABLE_ALERTS: "true",
        ALARM_TIMEAGO_WARN: "true",
        ALARM_TIMEAGO_WARN_MINS: "1",
        ALARM_TIMEAGO_URGENT: "true",
        ALARM_TIMEAGO_URGENT_MINS: "2",
        HEARTBEAT: "60",
      });
      const staleAt = now - 10 * 60_000;
      await instance.processAlarmNotificationRequests(JSON.stringify({
        notifications: [{
          level: 1,
          title: "Warning, BG data stale",
          message: "10 mins ago",
          group: "default",
          eventName: "timeago",
          plugin: { name: "timeago" },
        }],
        snoozes: [],
      }), staleAt);
      expect(state.storage.sql.exec<{ last_emit_at: number | null }>(
        `SELECT last_emit_at FROM realtime_alarm_silences
         WHERE level = 1 AND alarm_group = 'default'`,
      ).one().last_emit_at).toBe(staleAt);

      await instance.configureSimulatedCgm(true, now);
      const cleared = state.storage.sql.exec<{
        last_ack_at: number;
        silence_time: number;
        last_emit_at: number | null;
      }>(
        `SELECT last_ack_at, silence_time, last_emit_at
         FROM realtime_alarm_silences
         WHERE level = 1 AND alarm_group = 'default'`,
      ).one();
      expect(cleared.last_ack_at).toBeGreaterThanOrEqual(now);
      expect(cleared.silence_time).toBe(1);
      expect(cleared.last_emit_at).toBeNull();
    });
  });
});
