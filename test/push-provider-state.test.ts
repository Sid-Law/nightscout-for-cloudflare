import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EntryStore } from "../src/entry-store";
import { SqlitePushNotificationStateStore } from "../src/push-notification-store";

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function store(name: string): DurableObjectStub<EntryStore> {
  return env.ENTRY_STORE.getByName(name) as DurableObjectStub<EntryStore>;
}

function callback(name: string, version: "v1" | "v2", receipt: string): Promise<Response> {
  return SELF.fetch(
    `https://example.test/api/${version}/notifications/pushovercallback?tenant=${name}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ receipt }).toString(),
    },
  );
}

describe("Durable Object push-provider state", () => {
  it("persists dedupe, receipt and Maker All Clear state across eviction", async () => {
    const name = tenant("push-state");
    const durable = store(name);
    const now = Date.now();
    await runInDurableObject(durable, async (_instance, state) => {
      const repository = new SqlitePushNotificationStateStore(state.storage);
      repository.migrate();
      repository.putRecent("alarm-key", { title: "Alarm", message: "Test" }, now + 60_000);
      repository.putReceipt(
        "receipt-key",
        { title: "Alarm", message: "Test", level: 1, group: "default" },
        now + 60_000,
      );
      repository.setLastAllClear(now);
    });

    await evictDurableObject(durable);
    await runInDurableObject(durable, async (_instance, state) => {
      const repository = new SqlitePushNotificationStateStore(state.storage);
      expect(repository.hasRecent("alarm-key", now)).toBe(true);
      expect(repository.getReceipt("receipt-key", now)).toMatchObject({
        level: 1,
        group: "default",
      });
      expect(repository.getLastAllClear()).toBe(now);
    });
  });

  it("inherits the official receipt callback through v1 and v2", async () => {
    for (const version of ["v1", "v2"] as const) {
      const name = tenant(`pushover-callback-${version}`);
      const receipt = `receipt-${version}`;
      const durable = store(name);
      const now = Date.now();
      await runInDurableObject(durable, async (_instance, state) => {
        const repository = new SqlitePushNotificationStateStore(state.storage);
        repository.migrate();
        repository.putReceipt(receipt, {
          title: "Data is stale",
          message: "No new SGV",
          level: 1,
          group: `callback-${version}`,
          eventName: "timeago",
          plugin: { name: "timeago" },
        }, now + 60_000);
      });

      await evictDurableObject(durable);
      const accepted = await callback(name, version, receipt);
      expect(accepted.status).toBe(200);
      expect(accepted.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
      expect(await accepted.text()).toBe("OK");

      await runInDurableObject(durable, async (_instance, state) => {
        const repository = new SqlitePushNotificationStateStore(state.storage);
        expect(repository.getReceipt(receipt, Date.now())).toBeNull();
        expect(state.storage.sql.exec<{
          level: number;
          alarm_group: string;
          silence_time: number;
        }>(
          `SELECT level, alarm_group, silence_time
           FROM realtime_alarm_silences WHERE alarm_group = ?`,
          `callback-${version}`,
        ).one()).toEqual({
          level: 1,
          alarm_group: `callback-${version}`,
          silence_time: 30 * 60 * 1_000,
        });
      });

      const repeated = await callback(name, version, receipt);
      expect(repeated.status).toBe(500);
      expect(await repeated.text()).toBe("Internal Server Error");
    }
  });

  it("rejects unknown or malformed callbacks without changing alarm state", async () => {
    const name = tenant("pushover-callback-invalid");
    for (const version of ["v1", "v2"] as const) {
      const unknown = await callback(name, version, "unknown");
      expect(unknown.status).toBe(500);
      expect(await unknown.text()).toBe("Internal Server Error");
    }
    const malformed = await SELF.fetch(
      `https://example.test/api/v1/notifications/pushovercallback?tenant=${name}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "[]",
      },
    );
    expect(malformed.status).toBe(500);
  });
});
