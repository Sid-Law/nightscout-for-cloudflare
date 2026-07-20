import type { RealtimeDocument } from "../realtime/ddata-snapshot";
import {
  calculateBgnowProperties,
  type NightscoutGlucoseUnits,
} from "./bgnow";
import { calculateDirectionProperty } from "./direction";
import { calculateDatabaseSizeProperty } from "./dbsize";
import {
  calculateCannulaAgeProperty,
  calculateInsulinAgeProperty,
  calculateSensorAgeProperty,
  type AgePreferences,
} from "./age";
import { calculateLoopProperty } from "./loop";
import { calculateRawBgProperty } from "./rawbg";
import {
  createDefaultPluginCatalogs,
  createNightscoutPluginRegistry,
  type NightscoutPlugin,
  type PluginExecutionSandbox,
} from "./registry";
import { calculateUploaderBatteryProperty } from "./upbat";

export interface PluginPropertyContext {
  sgvs: RealtimeDocument[];
  cals: RealtimeDocument[];
  devicestatus: RealtimeDocument[];
  treatments?: RealtimeDocument[];
  dbstats?: Record<string, unknown>;
}

export interface PluginPropertySource {
  getPluginPropertyContextJson(at: number): Promise<string>;
  getDdataSnapshotJson(at: number, frame: boolean): Promise<string>;
}

const AGE_TREATMENT_WINDOW_MS = 62 * 24 * 60 * 60 * 1_000;
const AGE_TREATMENT_EVENT_TYPES = new Set([
  "Sensor Start",
  "Sensor Change",
  "Sensor Stop",
  "Site Change",
  "Insulin Change",
  "Pump Battery Change",
]);

function parseAgeTreatments(value: unknown, now: number): RealtimeDocument[] {
  if (!Array.isArray(value)) return [];
  const latest = new Map<string, RealtimeDocument>();
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const document = candidate as RealtimeDocument;
    const eventType = document.eventType;
    const mills = Number(document.mills);
    if (
      typeof eventType !== "string" || !AGE_TREATMENT_EVENT_TYPES.has(eventType) ||
      !Number.isFinite(mills) || mills > now || mills < now - AGE_TREATMENT_WINDOW_MS
    ) continue;
    const current = latest.get(eventType);
    if (current === undefined || mills > Number(current.mills)) latest.set(eventType, document);
  }
  return [...latest.values()];
}

function parsePluginPropertyContext(json: string, now: number): PluginPropertyContext {
  const value = JSON.parse(json) as Partial<PluginPropertyContext>;
  return {
    sgvs: Array.isArray(value.sgvs) ? value.sgvs : [],
    cals: Array.isArray(value.cals) ? value.cals : [],
    devicestatus: Array.isArray(value.devicestatus) ? value.devicestatus : [],
    treatments: parseAgeTreatments(value.treatments, now),
    dbstats: typeof value.dbstats === "object"
        && value.dbstats !== null
        && !Array.isArray(value.dbstats)
      ? value.dbstats
      : {},
  };
}

function missingPropertyContextRpc(error: unknown): boolean {
  return error instanceof Error &&
    error.message.includes("RPC receiver does not implement the method") &&
    error.message.includes("getPluginPropertyContextJson");
}

/**
 * New Worker versions can reach an older, still-live Durable Object isolate
 * during Cloudflare's rolling deployment. Fall back only for that precise
 * missing-method condition; all actual storage/parser failures still surface.
 */
export async function loadPluginPropertyContext(
  source: PluginPropertySource,
  now: number,
): Promise<PluginPropertyContext> {
  try {
    return parsePluginPropertyContext(await source.getPluginPropertyContextJson(now), now);
  } catch (error) {
    if (!missingPropertyContextRpc(error)) throw error;
    return parsePluginPropertyContext(await source.getDdataSnapshotJson(now, false), now);
  }
}

/**
 * Workers-safe equivalent of plugins.setProperties(): execute property
 * setters in locked server-plugin order and only for enabled plugins.
 */
export function calculatePluginProperties(
  context: PluginPropertyContext,
  units: NightscoutGlucoseUnits,
  now: number,
  enabled: ReadonlySet<string>,
  extendedSettings: Record<string, unknown> = {},
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const agePreferences = (pluginSandbox: PluginExecutionSandbox): AgePreferences =>
    typeof pluginSandbox.extendedSettings === "object"
        && pluginSandbox.extendedSettings !== null
        && !Array.isArray(pluginSandbox.extendedSettings)
      ? pluginSandbox.extendedSettings as AgePreferences
      : {};
  const server: Record<string, Partial<NightscoutPlugin>> = {
    bgnow: {
      setProperties: () => {
        Object.assign(properties, calculateBgnowProperties(context.sgvs, now, units));
      },
    },
    rawbg: {
      setProperties: () => {
        properties.rawbg = calculateRawBgProperty(context.sgvs, context.cals, now, units);
      },
    },
    direction: {
      setProperties: () => {
        const latest = [...context.sgvs].reverse()
          .find((entry) => Number(entry.mills) <= now);
        const direction = calculateDirectionProperty(latest, now);
        if (direction !== undefined) properties.direction = direction;
      },
    },
    upbat: {
      setProperties: () => {
        properties.upbat = calculateUploaderBatteryProperty(context.devicestatus, now);
      },
    },
    loop: {
      setProperties: () => {
        properties.loop = calculateLoopProperty(context.devicestatus, now);
      },
    },
    cage: {
      setProperties: (pluginSandbox) => {
        properties.cage = calculateCannulaAgeProperty(
          context.treatments ?? [],
          now,
          agePreferences(pluginSandbox),
        );
      },
    },
    sage: {
      setProperties: (pluginSandbox) => {
        properties.sage = calculateSensorAgeProperty(
          context.treatments ?? [],
          now,
          agePreferences(pluginSandbox),
        );
      },
    },
    iage: {
      setProperties: (pluginSandbox) => {
        properties.iage = calculateInsulinAgeProperty(
          context.treatments ?? [],
          now,
          agePreferences(pluginSandbox),
        );
      },
    },
    dbsize: {
      setProperties: (pluginSandbox) => {
        const preferences: Record<string, unknown> =
          typeof pluginSandbox.extendedSettings === "object"
            && pluginSandbox.extendedSettings !== null
            && !Array.isArray(pluginSandbox.extendedSettings)
          ? pluginSandbox.extendedSettings as Record<string, unknown>
          : {};
        properties.dbsize = calculateDatabaseSizeProperty(context.dbstats, preferences);
      },
    },
  };
  const registry = createNightscoutPluginRegistry(
    { settings: { enable: [...enabled] } },
    createDefaultPluginCatalogs({ server }),
  ).registerServerDefaults();
  const sandbox = {
    withExtendedSettings(plugin: NightscoutPlugin): PluginExecutionSandbox {
      const selected = extendedSettings[plugin.name];
      return {
        ...sandbox,
        extendedSettings: typeof selected === "object"
            && selected !== null
            && !Array.isArray(selected)
          ? selected
          : {},
      };
    },
  } satisfies PluginExecutionSandbox;
  registry.setProperties(sandbox);
  return properties;
}
