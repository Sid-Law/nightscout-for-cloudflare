import { env } from "cloudflare:workers";
import {
  listDurableObjectIds,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
  DexcomShareEnvironment,
  DexcomSharePersistedState,
} from "../src/dexcom-share";
import type { DexcomShareConnector } from "../src/dexcom-share-connector";
import type { EntryStore } from "../src/entry-store";
import { parseEntryPayload, type ValidatedEntry } from "../src/model";

const TEST_API_SECRET = "nscf-test-secret-20260717";
const FAKE_ACCOUNT = "contract-only@example.invalid";
const FAKE_PASSWORD = "not-a-real-dexcom-password";
const CONNECTOR_RECORD_KEY = "dexcom-share-connector";

const CONFIG_KEYS = [
  "ENABLE",
  "CONNECT_SOURCE",
  "CONNECT_SHARE_ACCOUNT_NAME",
  "CONNECT_SHARE_PASSWORD",
  "CONNECT_SHARE_REGION",
] as const;

type ConfigKey = typeof CONFIG_KEYS[number];
type ConfigSnapshot = Pick<DexcomShareEnvironment, ConfigKey>;

interface MutableConnectorSurface {
  env: DexcomShareEnvironment & {
    ENTRY_STORE: DurableObjectNamespace<EntryStore>;
  };
  commitCycle: (
    expected: ConnectorRecordSnapshot,
    state: DexcomSharePersistedState,
    nextDueAt: number,
    entries: ValidatedEntry[],
  ) => Promise<void>;
}

interface ConnectorRecordSnapshot {
  version: 1;
  tenant: string;
  generation: string;
  configFingerprint: string;
  nextDueAt: number;
  state: DexcomSharePersistedState;
}

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function connector(name: string): DurableObjectStub<DexcomShareConnector> {
  return connectorNamespace().getByName(name);
}

function connectorNamespace(): DurableObjectNamespace<DexcomShareConnector> {
  return (env as unknown as {
    DEXCOM_SHARE_CONNECTOR: DurableObjectNamespace<DexcomShareConnector>;
  }).DEXCOM_SHARE_CONNECTOR;
}

function store(name: string): DurableObjectStub<EntryStore> {
  return env.ENTRY_STORE.getByName(name);
}

async function snapshotConfig(
  stub: DurableObjectStub<DexcomShareConnector>,
): Promise<ConfigSnapshot> {
  return runInDurableObject(stub, async (instance) => {
    const current = (instance as unknown as MutableConnectorSurface).env;
    return Object.fromEntries(
      CONFIG_KEYS.map((key) => [key, current[key]]),
    ) as ConfigSnapshot;
  });
}

async function setConfig(
  stub: DurableObjectStub<DexcomShareConnector>,
  values: Partial<DexcomShareEnvironment>,
): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    Object.assign(
      (instance as unknown as MutableConnectorSurface).env,
      values,
    );
  });
}

async function storedConnectorRecord(
  stub: DurableObjectStub<DexcomShareConnector>,
): Promise<ConnectorRecordSnapshot | undefined> {
  return runInDurableObject(stub, async (_instance, state) =>
    state.storage.get<ConnectorRecordSnapshot>(CONNECTOR_RECORD_KEY)
  );
}

async function reconcileWithoutRunningExternalAlarm(
  stub: DurableObjectStub<DexcomShareConnector>,
  tenantName: string,
): Promise<void> {
  await runInDurableObject(stub, async (instance, state) => {
    await (instance as DexcomShareConnector).reconcile(tenantName);
    if (await state.storage.get(CONNECTOR_RECORD_KEY) !== undefined) {
      await state.storage.setAlarm(Date.now() + 60_000);
    }
  });
}

async function apiSecretDigest(): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(TEST_API_SECRET),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

describe("Dexcom Share connector Durable Object", () => {
  it("is absent by default and reports a sanitized disabled state", async () => {
    const tenantName = tenant("dexcom-disabled");
    const stub = connector(tenantName);

    expect(JSON.parse(await stub.statusJson(tenantName))).toEqual({
      enabled: false,
      source: null,
      region: null,
      state: "disabled",
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastEntryAt: null,
      consecutiveFailures: 0,
      lastErrorCode: null,
      nextAttemptAt: null,
    });
    expect(await storedConnectorRecord(stub)).toBeUndefined();
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("reconciles one alarm, rotates generation on config changes, and clears on disable", async () => {
    const tenantName = tenant("dexcom-reconcile");
    const stub = connector(tenantName);
    const original = await snapshotConfig(stub);
    try {
      await setConfig(stub, {
        ENABLE: "connect",
        CONNECT_SOURCE: "dexcomshare",
        CONNECT_SHARE_ACCOUNT_NAME: FAKE_ACCOUNT,
        CONNECT_SHARE_PASSWORD: FAKE_PASSWORD,
        CONNECT_SHARE_REGION: "ous",
      });
      await reconcileWithoutRunningExternalAlarm(stub, tenantName);

      const first = await storedConnectorRecord(stub);
      expect(first).toMatchObject({
        version: 1,
        tenant: tenantName,
        state: {
          lastAttemptAt: null,
          consecutiveFailures: 0,
        },
      });
      expect(first?.generation).toBeTruthy();
      await runInDurableObject(stub, async (_instance, state) => {
        expect(await state.storage.getAlarm()).not.toBeNull();
      });

      const statusText = await stub.statusJson(tenantName);
      expect(statusText).not.toContain(FAKE_ACCOUNT);
      expect(statusText).not.toContain(FAKE_PASSWORD);
      expect(JSON.parse(statusText)).toMatchObject({
        enabled: true,
        source: "dexcomshare",
        region: "ous",
        state: "idle",
      });

      await setConfig(stub, {
        CONNECT_SHARE_PASSWORD: `${FAKE_PASSWORD}-rotated`,
      });
      await reconcileWithoutRunningExternalAlarm(stub, tenantName);
      const rotated = await storedConnectorRecord(stub);
      expect(rotated?.generation).not.toBe(first?.generation);
      expect(rotated?.configFingerprint).not.toBe(first?.configFingerprint);
      expect(rotated?.state.lastAttemptAt).toBeNull();

      await setConfig(stub, { ENABLE: "" });
      await reconcileWithoutRunningExternalAlarm(stub, tenantName);
      expect(await storedConnectorRecord(stub)).toBeUndefined();
      await runInDurableObject(stub, async (_instance, state) => {
        expect(await state.storage.getAlarm()).toBeNull();
      });
    } finally {
      await setConfig(stub, original);
    }
  });

  it("protects the public connector status endpoint with admin authorization", async () => {
    const url = "https://example.test/_nscf/connect/status";
    expect((await SELF.fetch(url)).status).toBe(401);

    const response = await SELF.fetch(url, {
      headers: { "api-secret": await apiSecretDigest() },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      enabled: false,
      source: null,
      state: "disabled",
    });
  });

  it("pins public connector status to the canonical demo identity", async () => {
    const namespace = connectorNamespace();
    const untrustedTenants = [
      tenant("dexcom-public-a"),
      tenant("dexcom-public-b"),
    ];
    const headers = { "api-secret": await apiSecretDigest() };

    for (const tenantName of untrustedTenants) {
      const response = await SELF.fetch(
        `https://example.test/_nscf/connect/status?tenant=${tenantName}`,
        { headers },
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: {
          code: "dexcom_share_connector_not_available",
          message: "Dexcom Share connector is available only for the default tenant",
        },
      });
    }

    const rejectedIds = new Set(
      (await listDurableObjectIds(namespace)).map((id) => id.toString()),
    );
    for (const tenantName of untrustedTenants) {
      expect(rejectedIds).not.toContain(
        namespace.idFromName(tenantName).toString(),
      );
    }

    const canonical = await SELF.fetch(
      "https://example.test/_nscf/connect/status",
      { headers },
    );
    expect(canonical.status).toBe(200);
    expect(await canonical.json()).toMatchObject({
      enabled: false,
      state: "disabled",
    });
  });

  it("keeps connector and EntryStore alarms independently runnable", async () => {
    const tenantName = tenant("dexcom-isolation");
    const connectorStub = connector(tenantName);
    const entryStoreStub = store(tenantName);
    const connectorDueAt = Date.now() + 60_000;

    await runInDurableObject(connectorStub, async (_instance, state) => {
      await state.storage.setAlarm(connectorDueAt);
    });
    await runInDurableObject(entryStoreStub, async (_instance, state) => {
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(entryStoreStub)).toBe(true);
    await runInDurableObject(connectorStub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(connectorDueAt);
    });

    expect(await runDurableObjectAlarm(connectorStub)).toBe(true);
    await runInDurableObject(connectorStub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("commits a successful cycle once and deduplicates a replayed delivery", async () => {
    const tenantName = tenant("dexcom-write");
    const connectorStub = connector(tenantName);
    const entryStoreStub = store(tenantName);
    const original = await snapshotConfig(connectorStub);
    const readingAt = Date.now() - 60_000;

    try {
      await setConfig(connectorStub, {
        ENABLE: "connect",
        CONNECT_SOURCE: "dexcomshare",
        CONNECT_SHARE_ACCOUNT_NAME: FAKE_ACCOUNT,
        CONNECT_SHARE_PASSWORD: FAKE_PASSWORD,
        CONNECT_SHARE_REGION: "us",
      });
      await reconcileWithoutRunningExternalAlarm(connectorStub, tenantName);
      const record = await storedConnectorRecord(connectorStub);
      if (record === undefined) throw new Error("missing connector record");
      const successState: DexcomSharePersistedState = {
        ...record.state,
        sessionId: "contract-session",
        sessionCreatedAt: Date.now(),
        lastAttemptAt: Date.now(),
        lastSuccessAt: Date.now(),
        lastEntryAt: readingAt,
        consecutiveFailures: 0,
        lastErrorCode: null,
      };
      const entries = parseEntryPayload([{
        sgv: 123,
        date: readingAt,
        dateString: new Date(readingAt).toISOString(),
        trend: 4,
        direction: "Flat",
        device: "nightscout-connect",
        type: "sgv",
      }]);
      const nextDueAt = Date.now() + 5 * 60_000;
      await runInDurableObject(connectorStub, async (instance) => {
        await (instance as unknown as MutableConnectorSurface).commitCycle(
          record,
          successState,
          nextDueAt,
          entries,
        );
      });

      await runInDurableObject(entryStoreStub, async (_instance, state) => {
        expect(state.storage.sql.exec<{
          sgv: number;
          date: number;
          direction: string;
          device: string;
        }>(
          `SELECT sgv, date, direction, device
           FROM entries WHERE device = 'nightscout-connect'`,
        ).one()).toEqual({
          sgv: 123,
          date: readingAt,
          direction: "Flat",
          device: "nightscout-connect",
        });
      });

      await runInDurableObject(connectorStub, async (instance) => {
        await (instance as unknown as MutableConnectorSurface).commitCycle(
          record,
          successState,
          nextDueAt,
          entries,
        );
      });
      await runInDurableObject(entryStoreStub, async (_instance, state) => {
        expect(state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count
           FROM entries WHERE device = 'nightscout-connect'`,
        ).one().count).toBe(1);
      });

      const committed = await storedConnectorRecord(connectorStub);
      expect(committed?.state).toMatchObject({
        lastEntryAt: readingAt,
        consecutiveFailures: 0,
        lastErrorCode: null,
      });
      expect(committed?.state.lastSuccessAt).not.toBeNull();
      await runInDurableObject(connectorStub, async (_instance, state) => {
        expect(await state.storage.getAlarm()).toBe(nextDueAt);
      });
    } finally {
      await setConfig(connectorStub, original);
    }
  });

  it("records an EntryStore RPC failure and retries after 2.5 minutes", async () => {
    const tenantName = tenant("dexcom-write-failure");
    const connectorStub = connector(tenantName);
    const original = await snapshotConfig(connectorStub);
    const readingAt = Date.now() - 60_000;

    try {
      await setConfig(connectorStub, {
        ENABLE: "connect",
        CONNECT_SOURCE: "dexcomshare",
        CONNECT_SHARE_ACCOUNT_NAME: FAKE_ACCOUNT,
        CONNECT_SHARE_PASSWORD: FAKE_PASSWORD,
        CONNECT_SHARE_REGION: "us",
      });
      await reconcileWithoutRunningExternalAlarm(connectorStub, tenantName);
      const record = await storedConnectorRecord(connectorStub);
      if (record === undefined) throw new Error("missing connector record");
      const successState: DexcomSharePersistedState = {
        ...record.state,
        sessionId: "contract-session",
        sessionCreatedAt: Date.now(),
        lastAttemptAt: Date.now(),
        lastSuccessAt: Date.now(),
        lastEntryAt: readingAt,
        consecutiveFailures: 0,
        lastErrorCode: null,
      };
      const entries = parseEntryPayload([{
        sgv: 123,
        date: readingAt,
        dateString: new Date(readingAt).toISOString(),
        trend: 4,
        direction: "Flat",
        device: "nightscout-connect",
        type: "sgv",
      }]);
      const before = Date.now();
      const writeAttempts = await runInDurableObject(
        connectorStub,
        async (instance) => {
          const mutable = instance as unknown as MutableConnectorSurface;
          const entryStore = mutable.env.ENTRY_STORE;
          let attempts = 0;
          mutable.env.ENTRY_STORE = {
            getByName: () => ({
              putEntriesJson: async () => {
                attempts += 1;
                throw new Error("simulated EntryStore RPC failure");
              },
            }),
          } as unknown as DurableObjectNamespace<EntryStore>;
          try {
            await mutable.commitCycle(
              record,
              successState,
              Date.now() + 5 * 60_000,
              entries,
            );
          } finally {
            mutable.env.ENTRY_STORE = entryStore;
          }
          return attempts;
        },
      );
      const after = Date.now();

      expect(writeAttempts).toBe(1);
      const committed = await storedConnectorRecord(connectorStub);
      expect(committed?.state).toMatchObject({
        sessionId: record.state.sessionId,
        lastSuccessAt: record.state.lastSuccessAt,
        lastEntryAt: record.state.lastEntryAt,
        consecutiveFailures: record.state.consecutiveFailures + 1,
        lastErrorCode: "internal_error",
      });
      expect(committed?.state.lastAttemptAt).toBeGreaterThanOrEqual(before);
      expect(committed?.state.lastAttemptAt).toBeLessThanOrEqual(after);
      expect(committed?.nextDueAt).toBe(
        committed!.state.lastAttemptAt! + 2.5 * 60_000,
      );
      await runInDurableObject(connectorStub, async (_instance, state) => {
        expect(await state.storage.getAlarm()).toBe(committed?.nextDueAt);
      });
    } finally {
      await setConfig(connectorStub, original);
    }
  });
});
