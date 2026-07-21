import { env } from "cloudflare:workers";
import { SELF, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ADMIN_NOTIFY_API_WINDOW_MS,
  ADMIN_NOTIFY_LIMIT,
  ADMIN_NOTIFY_RETENTION_MS,
  READABLE_SITE_ADMIN_NOTIFY,
  SqliteAdminNotifyRepository,
  type AdminNotify,
} from "../src/admin-notifies";
import type { EntryStore } from "../src/entry-store";
import { nightscoutStatus, tenantStatusSettings } from "../src/status";

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

function endpoint(tenantName: string): string {
  return `https://example.test/api/v1/adminnotifies?tenant=${tenantName}`;
}

async function adminNotifies(
  tenantName: string,
  headers?: Record<string, string>,
): Promise<{ message: { notifies: AdminNotify[]; notifyCount: number } }> {
  const response = await SELF.fetch(
    endpoint(tenantName),
    headers === undefined ? {} : { headers },
  );
  expect(response.status).toBe(200);
  return response.json();
}

describe("locked Nightscout v15.0.7 admin notifications", () => {
  it("retains the official ADMIN_NOTIFIES_ENABLED setting gate", () => {
    const status = nightscoutStatus(
      new Date(0),
      "readable",
      tenantStatusSettings({ ADMIN_NOTIFIES_ENABLED: "false" }),
    );
    expect(status.settings).toMatchObject({ adminNotifiesEnabled: false });
  });

  it("aggregates by message, retains the first metadata, and preserves the 8/12-hour windows", async () => {
    const stub = env.ENTRY_STORE.getByName(tenant("admin-notify-repository"));
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      const repository = new SqliteAdminNotifyRepository(state.storage);
      const now = 10_000_000;
      repository.reconcileReadableSite(false, true, now);
      repository.add({ title: "First title", message: "Repeated", custom: "kept" }, true, now);
      repository.add({ title: "Changed title", message: "Repeated", persistent: true }, true, now + 1);
      repository.add({ title: "Old", message: "Eight hours old" }, true, now - ADMIN_NOTIFY_API_WINDOW_MS);
      repository.add({ title: "Expired", message: "Twelve hours old" }, true, now - ADMIN_NOTIFY_RETENTION_MS);
      repository.add({ title: "Disabled", message: "Skipped" }, false, now);

      expect(repository.listForApi(now)).toEqual([
        expect.objectContaining({
          title: "First title",
          message: "Repeated",
          custom: "kept",
          count: 2,
          lastRecorded: now + 1,
        }),
      ]);
      expect(repository.listForApi(now)[0]).not.toHaveProperty("persistent");
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM admin_notifies WHERE message = 'Twelve hours old'",
      ).one().count).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM admin_notifies WHERE message = 'Eight hours old'",
      ).one().count).toBe(1);
    });
  });

  it("bounds transient bad-device messages without deleting persistent notices", async () => {
    const stub = env.ENTRY_STORE.getByName(tenant("admin-notify-limit"));
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      const repository = new SqliteAdminNotifyRepository(state.storage);
      const now = Date.now();
      repository.reconcileReadableSite(true, true, now);
      for (let index = 0; index < ADMIN_NOTIFY_LIMIT + 5; index += 1) {
        repository.add({ message: `Bad device ${index}` }, true, now + index);
      }
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM admin_notifies WHERE persistent = 0",
      ).one().count).toBe(ADMIN_NOTIFY_LIMIT);
      expect(repository.listForApi(now + ADMIN_NOTIFY_LIMIT + 5)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: READABLE_SITE_ADMIN_NOTIFY.message,
            persistent: true,
          }),
        ]),
      );
    });
  });

  it("exposes the official warning count publicly but its contents only to an admin", async () => {
    const tenantName = tenant("admin-notify-api");
    const anonymous = await adminNotifies(tenantName);
    expect(anonymous.message).toEqual({ notifies: [], notifyCount: 1 });

    const admin = await adminNotifies(tenantName, { "api-secret": await secretDigest() });
    expect(admin.message.notifyCount).toBe(1);
    expect(admin.message.notifies).toEqual([
      expect.objectContaining({
        ...READABLE_SITE_ADMIN_NOTIFY,
        count: 1,
        lastRecorded: expect.any(Number),
      }),
    ]);
  });

  it("persists and aggregates wrong-credential device warnings across DO eviction", async () => {
    const tenantName = tenant("admin-notify-auth-failure");
    const ip = "203.0.113.88";
    const wrongSecret = "wrong-secret-must-not-leak";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await adminNotifies(tenantName, {
        "api-secret": wrongSecret,
        "CF-Connecting-IP": ip,
      });
      expect(response.message.notifies).toEqual([]);
      expect(response.message.notifyCount).toBe(2);
    }

    const stub = env.ENTRY_STORE.getByName(tenantName);
    await evictDurableObject(stub);
    const admin = await adminNotifies(tenantName, { "api-secret": await secretDigest() });
    const failure = admin.message.notifies.find((notify) => notify.title === "Failed authentication");
    expect(failure).toMatchObject({
      message: expect.stringContaining(ip),
      count: 2,
      lastRecorded: expect.any(Number),
    });
    expect(JSON.stringify(admin)).not.toContain(wrongSecret);
  });
});
