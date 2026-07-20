import type { RealtimeDocument } from "../realtime/ddata-snapshot";
import {
  calculateBgnowProperties,
  type NightscoutGlucoseUnits,
} from "./bgnow";
import { calculateDirectionProperty } from "./direction";
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
}

export interface PluginPropertySource {
  getPluginPropertyContextJson(at: number): Promise<string>;
  getDdataSnapshotJson(at: number, frame: boolean): Promise<string>;
}

function parsePluginPropertyContext(json: string): PluginPropertyContext {
  const value = JSON.parse(json) as Partial<PluginPropertyContext>;
  return {
    sgvs: Array.isArray(value.sgvs) ? value.sgvs : [],
    cals: Array.isArray(value.cals) ? value.cals : [],
    devicestatus: Array.isArray(value.devicestatus) ? value.devicestatus : [],
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
    return parsePluginPropertyContext(await source.getPluginPropertyContextJson(now));
  } catch (error) {
    if (!missingPropertyContextRpc(error)) throw error;
    return parsePluginPropertyContext(await source.getDdataSnapshotJson(now, false));
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
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
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
  };
  const registry = createNightscoutPluginRegistry(
    { settings: { enable: [...enabled] } },
    createDefaultPluginCatalogs({ server }),
  ).registerServerDefaults();
  const sandbox = {
    withExtendedSettings(): PluginExecutionSandbox {
      return sandbox;
    },
  } satisfies PluginExecutionSandbox;
  registry.setProperties(sandbox);
  return properties;
}
