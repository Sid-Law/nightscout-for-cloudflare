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
import { calculateIobTotal } from "./iob";
import { calculateCobTotal } from "./cob";
import { calculateRawBgProperty } from "./rawbg";
import {
  createNightscoutProfileFunctions,
  type NightscoutProfileFunctions,
} from "../profile-functions";
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
  profiles?: RealtimeDocument[];
  dbstats?: Record<string, unknown>;
}

export interface PluginPropertySource {
  getPluginPropertyContextJson(at: number): Promise<string>;
  getDdataSnapshotJson(at: number, frame: boolean): Promise<string>;
}

const AGE_TREATMENT_WINDOW_MS = 62 * 24 * 60 * 60 * 1_000;
const RUNTIME_TREATMENT_WINDOW_MS = Math.round(2.5 * 24 * 60 * 60 * 1_000);
const PROFILE_SWITCH_WINDOW_MS = 31 * 12 * 24 * 60 * 60 * 1_000;
const AGE_TREATMENT_EVENT_TYPES = new Set([
  "Sensor Start",
  "Sensor Change",
  "Sensor Stop",
  "Site Change",
  "Insulin Change",
  "Pump Battery Change",
]);

interface TreatmentCandidate {
  document: RealtimeDocument;
  index: number;
}

function treatmentCandidateKey(candidate: TreatmentCandidate): string {
  const document = candidate.document;
  if (typeof document._id === "string") return `_id:${document._id}`;
  if (typeof document.identifier === "string") return `identifier:${document.identifier}`;
  return `input:${candidate.index}`;
}

function parsePluginTreatments(value: unknown, now: number): RealtimeDocument[] {
  if (!Array.isArray(value)) return [];
  const recent: TreatmentCandidate[] = [];
  const latestAges = new Map<string, TreatmentCandidate>();
  let latestProfileSwitch: TreatmentCandidate | undefined;
  value.forEach((candidate, index) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return;
    const document = candidate as RealtimeDocument;
    const eventType = document.eventType;
    const mills = Number(document.mills);
    if (!Number.isFinite(mills) || mills > now) return;
    const wrapped = { document, index };
    if (mills >= now - RUNTIME_TREATMENT_WINDOW_MS) recent.push(wrapped);
    if (
      typeof eventType === "string" && AGE_TREATMENT_EVENT_TYPES.has(eventType) &&
      mills >= now - AGE_TREATMENT_WINDOW_MS
    ) {
      const current = latestAges.get(eventType);
      if (current === undefined || mills > Number(current.document.mills)) {
        latestAges.set(eventType, wrapped);
      }
    }
    if (
      eventType === "Profile Switch" && Number(document.duration) === 0 &&
      mills >= now - PROFILE_SWITCH_WINDOW_MS &&
      (latestProfileSwitch === undefined || mills > Number(latestProfileSwitch.document.mills))
    ) latestProfileSwitch = wrapped;
  });
  const selected = new Map<string, TreatmentCandidate>();
  for (const candidate of recent) selected.set(treatmentCandidateKey(candidate), candidate);
  if (latestProfileSwitch !== undefined) {
    selected.set(treatmentCandidateKey(latestProfileSwitch), latestProfileSwitch);
  }
  for (const candidate of latestAges.values()) {
    selected.set(treatmentCandidateKey(candidate), candidate);
  }
  return [...selected.values()]
    .sort((left, right) =>
      Number(left.document.mills) - Number(right.document.mills) || left.index - right.index
    )
    .map((candidate) => candidate.document);
}

function parsePluginPropertyContext(json: string, now: number): PluginPropertyContext {
  const value = JSON.parse(json) as Partial<PluginPropertyContext>;
  return {
    sgvs: Array.isArray(value.sgvs) ? value.sgvs : [],
    cals: Array.isArray(value.cals) ? value.cals : [],
    devicestatus: Array.isArray(value.devicestatus) ? value.devicestatus : [],
    treatments: parsePluginTreatments(value.treatments, now),
    profiles: Array.isArray(value.profiles)
      ? value.profiles.filter((profile): profile is RealtimeDocument =>
        typeof profile === "object" && profile !== null && !Array.isArray(profile)
      )
      : [],
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
  let profile: NightscoutProfileFunctions | undefined;
  const pluginProfile = (): NightscoutProfileFunctions => {
    if (profile !== undefined) return profile;
    const profiles = JSON.parse(JSON.stringify(context.profiles ?? [])) as RealtimeDocument[];
    profile = createNightscoutProfileFunctions(profiles);
    profile.updateTreatments(
      (context.treatments ?? [])
        .filter((treatment) => treatment.eventType === "Profile Switch")
        .map((treatment) => JSON.parse(JSON.stringify(treatment)) as RealtimeDocument),
      [],
    );
    return profile;
  };
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
    iob: {
      setProperties: () => {
        properties.iob = calculateIobTotal(
          context.treatments ?? [],
          context.devicestatus,
          pluginProfile(),
          now,
        );
      },
    },
    cob: {
      setProperties: () => {
        properties.cob = calculateCobTotal(
          context.treatments ?? [],
          context.devicestatus,
          pluginProfile(),
          now,
        );
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
