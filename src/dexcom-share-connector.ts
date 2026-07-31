import { DurableObject } from "cloudflare:workers";
import {
  dexcomShareConfigFingerprint,
  dexcomSharePublicStatus,
  initialDexcomShareState,
  parseDexcomShareState,
  resolveDexcomShareConfig,
  runDexcomShareCycle,
  type DexcomShareEnvironment,
  type DexcomSharePersistedState,
} from "./dexcom-share";
import type { EntryStore } from "./entry-store";
import type { ValidatedEntry } from "./model";

const CONNECTOR_RECORD_KEY = "dexcom-share-connector";
const CONNECTOR_RECORD_VERSION = 1;
const CONNECTOR_INTERNAL_RETRY_MS = 2.5 * 60_000;
const TENANT = /^[a-z0-9][a-z0-9_-]{0,63}$/;

interface DexcomShareConnectorEnv extends DexcomShareEnvironment {
  ENTRY_STORE: DurableObjectNamespace<EntryStore>;
}

interface DexcomShareConnectorRecord {
  version: 1;
  tenant: string;
  generation: string;
  configFingerprint: string;
  state: DexcomSharePersistedState;
  nextDueAt: number;
}

interface EntryStoreWriteEnvelope {
  ok: boolean;
}

function timestamp(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function connectorRecord(value: unknown): DexcomShareConnectorRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const tenant = typeof record.tenant === "string" && TENANT.test(record.tenant)
    ? record.tenant
    : null;
  const generation = typeof record.generation === "string"
      && record.generation.length > 0
      && record.generation.length <= 128
    ? record.generation
    : null;
  const configFingerprint = typeof record.configFingerprint === "string"
      && /^[0-9a-f]{64}$/.test(record.configFingerprint)
    ? record.configFingerprint
    : null;
  const nextDueAt = timestamp(record.nextDueAt);
  if (
    record.version !== CONNECTOR_RECORD_VERSION
    || tenant === null
    || generation === null
    || configFingerprint === null
    || nextDueAt === null
  ) {
    return null;
  }
  return {
    version: CONNECTOR_RECORD_VERSION,
    tenant,
    generation,
    configFingerprint,
    state: parseDexcomShareState(record.state, configFingerprint),
    nextDueAt,
  };
}

function internalFailureState(
  state: DexcomSharePersistedState,
  now: number,
): DexcomSharePersistedState {
  return {
    ...state,
    lastAttemptAt: now,
    consecutiveFailures: Math.min(1_000_000, state.consecutiveFailures + 1),
    lastErrorCode: "internal_error",
  };
}

export class DexcomShareConnector extends DurableObject<DexcomShareConnectorEnv> {
  private validateTenant(tenant: string): string {
    if (!TENANT.test(tenant)) throw new Error("invalid connector tenant");
    return tenant;
  }

  private async storedRecord(): Promise<DexcomShareConnectorRecord | null> {
    return connectorRecord(await this.ctx.storage.get(CONNECTOR_RECORD_KEY));
  }

  private async clear(): Promise<void> {
    await Promise.all([
      this.ctx.storage.delete(CONNECTOR_RECORD_KEY),
      this.ctx.storage.deleteAlarm(),
    ]);
  }

  async reconcile(tenantValue: string): Promise<void> {
    const tenant = this.validateTenant(tenantValue);
    const config = resolveDexcomShareConfig(this.env);
    if (!config.enabled) {
      await this.ctx.blockConcurrencyWhile(async () => {
        const existing = await this.storedRecord();
        if (existing !== null && existing.tenant !== tenant) {
          throw new Error("connector tenant mismatch");
        }
        await this.clear();
      });
      return;
    }

    const configFingerprint = await dexcomShareConfigFingerprint(config);
    await this.ctx.blockConcurrencyWhile(async () => {
      const existing = await this.storedRecord();
      if (existing !== null && existing.tenant !== tenant) {
        throw new Error("connector tenant mismatch");
      }
      const now = Date.now();
      const firstDueAt = now + 1;
      if (
        existing === null
        || existing.configFingerprint !== configFingerprint
      ) {
        const record: DexcomShareConnectorRecord = {
          version: CONNECTOR_RECORD_VERSION,
          tenant,
          generation: crypto.randomUUID(),
          configFingerprint,
          state: initialDexcomShareState(configFingerprint),
          nextDueAt: firstDueAt,
        };
        await this.ctx.storage.put(CONNECTOR_RECORD_KEY, record);
        await this.ctx.storage.setAlarm(firstDueAt);
        return;
      }
      if (await this.ctx.storage.getAlarm() === null) {
        await this.ctx.storage.setAlarm(Math.max(firstDueAt, existing.nextDueAt));
      }
    });
  }

  async statusJson(tenantValue: string): Promise<string> {
    const tenant = this.validateTenant(tenantValue);
    await this.reconcile(tenant);
    const config = resolveDexcomShareConfig(this.env);
    if (!config.enabled) {
      return JSON.stringify(dexcomSharePublicStatus(config, null, null));
    }
    const configFingerprint = await dexcomShareConfigFingerprint(config);
    const record = await this.storedRecord();
    if (record !== null && record.tenant !== tenant) {
      throw new Error("connector tenant mismatch");
    }
    const state = record !== null
        && record.configFingerprint === configFingerprint
      ? record.state
      : null;
    return JSON.stringify(
      dexcomSharePublicStatus(
        config,
        state,
        state === null ? null : record!.nextDueAt,
      ),
    );
  }

  private async commitCycle(
    expected: DexcomShareConnectorRecord,
    state: DexcomSharePersistedState,
    nextDueAt: number,
    entries: ValidatedEntry[],
  ): Promise<void> {
    const snapshot = await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.storedRecord();
      const config = resolveDexcomShareConfig(this.env);
      if (!config.enabled) {
        await this.clear();
        return null;
      }
      const currentFingerprint = await dexcomShareConfigFingerprint(config);
      if (
        current === null
        || current.tenant !== expected.tenant
      ) {
        return null;
      }
      if (current.configFingerprint !== currentFingerprint) {
        const now = Date.now();
        const firstDueAt = now + 1;
        const replacement: DexcomShareConnectorRecord = {
          version: CONNECTOR_RECORD_VERSION,
          tenant: current.tenant,
          generation: crypto.randomUUID(),
          configFingerprint: currentFingerprint,
          state: initialDexcomShareState(currentFingerprint),
          nextDueAt: firstDueAt,
        };
        await this.ctx.storage.put(CONNECTOR_RECORD_KEY, replacement);
        await this.ctx.storage.setAlarm(firstDueAt);
        return null;
      }
      if (
        current.generation !== expected.generation
      ) {
        return null;
      }
      return current;
    });
    if (snapshot === null) return;

    let committedState = state;
    let committedDueAt = nextDueAt;
    if (entries.length > 0) {
      try {
        const envelope = JSON.parse(
          await this.env.ENTRY_STORE
            .getByName(snapshot.tenant)
            .putEntriesJson(entries),
        ) as EntryStoreWriteEnvelope;
        if (envelope.ok !== true) throw new Error("entry store rejected connector batch");
      } catch {
        const now = Date.now();
        committedState = internalFailureState(snapshot.state, now);
        committedDueAt = now + CONNECTOR_INTERNAL_RETRY_MS;
      }
    }

    await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.storedRecord();
      if (
        current === null
        || current.tenant !== snapshot.tenant
        || current.generation !== snapshot.generation
        || current.configFingerprint !== snapshot.configFingerprint
      ) {
        return;
      }
      const updated: DexcomShareConnectorRecord = {
        ...current,
        state: committedState,
        nextDueAt: committedDueAt,
      };
      await this.ctx.storage.put(CONNECTOR_RECORD_KEY, updated);
      await this.ctx.storage.setAlarm(committedDueAt);
    });
  }

  override async alarm(): Promise<void> {
    const expected = await this.storedRecord();
    if (expected === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const config = resolveDexcomShareConfig(this.env);
    if (!config.enabled) {
      await this.clear();
      return;
    }
    const configFingerprint = await dexcomShareConfigFingerprint(config);
    if (expected.configFingerprint !== configFingerprint) {
      await this.reconcile(expected.tenant);
      return;
    }

    try {
      const result = await runDexcomShareCycle({
        config,
        configFingerprint,
        state: expected.state,
        now: Date.now(),
        latestLocalEntryAt: null,
      });
      await this.commitCycle(
        expected,
        result.state,
        result.nextDueAt,
        result.validatedEntries,
      );
    } catch {
      const now = Date.now();
      await this.commitCycle(
        expected,
        internalFailureState(expected.state, now),
        now + CONNECTOR_INTERNAL_RETRY_MS,
        [],
      );
    }
  }
}
