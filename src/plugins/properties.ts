import type { RealtimeDocument } from "../realtime/ddata-snapshot";
import {
  calculateBgnowProperties,
  type NightscoutGlucoseUnits,
} from "./bgnow";
import { calculateDirectionProperty } from "./direction";
import { calculateRawBgProperty } from "./rawbg";
import { calculateUploaderBatteryProperty } from "./upbat";

export interface PluginPropertyContext {
  sgvs: RealtimeDocument[];
  cals: RealtimeDocument[];
  devicestatus: RealtimeDocument[];
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
  if (enabled.has("bgnow")) {
    Object.assign(properties, calculateBgnowProperties(context.sgvs, now, units));
  }
  if (enabled.has("rawbg")) {
    properties.rawbg = calculateRawBgProperty(context.sgvs, context.cals, now, units);
  }
  if (enabled.has("direction")) {
    const latest = [...context.sgvs].reverse()
      .find((entry) => Number(entry.mills) <= now);
    const direction = calculateDirectionProperty(latest, now);
    if (direction !== undefined) properties.direction = direction;
  }
  if (enabled.has("upbat")) {
    properties.upbat = calculateUploaderBatteryProperty(context.devicestatus, now);
  }
  return properties;
}
