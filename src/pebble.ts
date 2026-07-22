import type { RealtimeDocument } from "./realtime/ddata-snapshot";
import type { PluginPropertyContext } from "./plugins/properties";
import { mgdlToMMOL } from "./runtime/units";

const DIRECTIONS: Readonly<Record<string, number>> = {
  NONE: 0,
  DoubleUp: 1,
  SingleUp: 2,
  FortyFiveUp: 3,
  Flat: 4,
  FortyFiveDown: 5,
  SingleDown: 6,
  DoubleDown: 7,
  "NOT COMPUTABLE": 8,
  "RATE OUT OF RANGE": 9,
};

export interface NightscoutPebbleOptions {
  now: number;
  count: number;
  mmol: boolean;
  rawbg: boolean;
  iob: boolean;
  cob: boolean;
  properties?: Record<string, unknown>;
}

export interface NightscoutPebbleResponse {
  status: Array<{ now: number }>;
  bgs: RealtimeDocument[];
  cals: RealtimeDocument[];
}

function record(value: unknown): RealtimeDocument | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RealtimeDocument
    : undefined;
}

function reverseAndSlice(
  documents: RealtimeDocument[] | undefined,
  count: number,
): RealtimeDocument[] {
  return (documents ?? []).slice().reverse().slice(0, count);
}

function lastAtOrBefore(
  documents: RealtimeDocument[] | undefined,
  now: number,
): RealtimeDocument | undefined {
  const values = documents ?? [];
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const document = values[index];
    if (document !== undefined && Number(document.mills) <= now) return document;
  }
  return undefined;
}

function directionToTrend(direction: unknown): number {
  return typeof direction === "string" && Object.prototype.hasOwnProperty.call(DIRECTIONS, direction)
    ? DIRECTIONS[direction]!
    : 8;
}

function latestUploaderBattery(
  deviceStatuses: RealtimeDocument[],
): unknown {
  for (let index = deviceStatuses.length - 1; index >= 0; index -= 1) {
    const status = deviceStatuses[index];
    if (status === undefined || !("uploader" in status)) continue;
    return record(status.uploader)?.battery;
  }
  return undefined;
}

/**
 * Request-local port of locked Nightscout v15.0.7 lib/server/pebble.js.
 * The caller supplies the already bounded tenant snapshot and the official
 * plugin properties, so this adapter retains response semantics without a
 * process-global ddata cache or dynamic plugin lookup.
 */
export function buildNightscoutPebbleResponse(
  context: PluginPropertyContext,
  options: NightscoutPebbleOptions,
): NightscoutPebbleResponse {
  const properties = options.properties ?? {};
  const calibration = lastAtOrBefore(context.cals, options.now);
  const bgs = reverseAndSlice(context.sgvs, options.count).map((sgv) => {
    const transformed: RealtimeDocument = {
      sgv: options.mmol
        ? mgdlToMMOL(Number(sgv.mgdl))
        : Number(sgv.mgdl).toString(),
      trend: directionToTrend(sgv.direction),
      direction: sgv.direction,
      datetime: sgv.mills,
    };
    if (options.rawbg && calibration !== undefined) {
      transformed.filtered = sgv.filtered;
      transformed.unfiltered = sgv.unfiltered;
      transformed.noise = sgv.noise;
    }
    return transformed;
  });

  const first = bgs[0];
  if (first !== undefined) {
    const delta = record(properties.delta);
    first.bgdelta = delta?.scaled || 0;
    if (options.mmol) first.bgdelta = Number(first.bgdelta).toFixed(1);

    const battery = latestUploaderBattery(context.devicestatus);
    if (battery && Number(battery) >= 0) first.battery = String(battery);

    if (options.iob) first.iob = record(properties.iob)?.display || 0;
    if (options.cob) first.cob = record(properties.cob)?.display || 0;
  }

  const cals = options.rawbg
    ? reverseAndSlice(context.cals, options.count).map((calibrationDocument) => ({
      slope: calibrationDocument.slope,
      intercept: calibrationDocument.intercept,
      scale: calibrationDocument.scale,
    }))
    : [];

  return {
    status: [{ now: options.now }],
    bgs,
    cals,
  };
}
