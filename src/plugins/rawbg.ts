import type { RealtimeDocument } from "../realtime/ddata-snapshot";
import { mgdlToMMOL } from "../runtime/units";

export type RawBgDisplay = "unfiltered" | "filtered" | "unsmoothed" | string;

export const RAW_BG_INTENTS = [{
  intent: "MetricNow",
  metrics: ["raw bg", "raw blood glucose"],
}] as const;

function integerOrZero(value: unknown): number {
  return Number.parseInt(String(value)) || 0;
}

function floatOrZero(value: unknown): number {
  return Number.parseFloat(String(value)) || 0;
}

function lastAtOrBefore(
  entries: RealtimeDocument[],
  now: number,
): RealtimeDocument | undefined {
  return [...entries].reverse().find((entry) => Number(entry.mills) <= now);
}

function scaledMgdl(mgdl: unknown, units: "mg/dl" | "mmol"): number {
  return units === "mmol" && mgdl ? Number(mgdlToMMOL(Number(mgdl))) : Number(mgdl);
}

/** Direct stateless port of locked plugins/rawbg.calc(). */
export function calculateRawBg(
  sgv: RealtimeDocument,
  cal: RealtimeDocument,
  display: RawBgDisplay = "unsmoothed",
): number {
  const unfiltered = integerOrZero(sgv.unfiltered);
  const filtered = integerOrZero(sgv.filtered);
  const scale = floatOrZero(cal.scale);
  const intercept = floatOrZero(cal.intercept);
  const slope = floatOrZero(cal.slope);

  let raw = 0;
  if (slope === 0 || unfiltered === 0 || scale === 0) {
    raw = 0;
  } else if (filtered === 0 || Number(sgv.mgdl) < 40 || display === "unfiltered") {
    raw = scale * (unfiltered - intercept) / slope;
  } else if (display === "filtered") {
    raw = scale * (filtered - intercept) / slope;
  } else {
    const ratio = scale * (filtered - intercept) / slope / Number(sgv.mgdl);
    raw = scale * (unfiltered - intercept) / slope / ratio;
  }
  return Math.round(raw);
}

/** English identity-translation form of locked rawbg.noiseCodeToDisplay(). */
export function rawBgNoiseLabel(mgdl: unknown, noise: unknown): string {
  switch (Number.parseInt(String(noise))) {
    case 0: return "---";
    case 1: return "Clean";
    case 2: return "Light";
    case 3: return "Medium";
    case 4: return "Heavy";
    default: return Number(mgdl) < 40 ? "Heavy" : "~~~";
  }
}

/** Direct property offer used by the locked rawbg plugin. */
export function calculateRawBgProperty(
  sgvs: RealtimeDocument[],
  cals: RealtimeDocument[],
  now: number,
  units: "mg/dl" | "mmol",
  display: RawBgDisplay = "unsmoothed",
  inRetroMode = false,
): RealtimeDocument {
  const result: RealtimeDocument = {};
  const currentSgv = lastAtOrBefore(sgvs, now);
  // Preserve upstream's TODO-documented behavior: the last loaded calibration
  // is selected even when that calibration is in the future.
  const currentCal = cals.at(-1);
  const staleAndInRetroMode = inRetroMode &&
    currentSgv !== undefined && now - Number(currentSgv.mills) > 15 * 60_000;
  if (!staleAndInRetroMode && currentSgv !== undefined && currentCal !== undefined) {
    result.mgdl = calculateRawBg(currentSgv, currentCal, display);
    result.noiseLabel = rawBgNoiseLabel(currentSgv.mgdl, currentSgv.noise);
    result.sgv = currentSgv;
    result.cal = currentCal;
    result.displayLine = [
      "Raw BG:",
      scaledMgdl(result.mgdl, units),
      units === "mmol" ? "mmol/L" : "mg/dl",
      result.noiseLabel,
    ].join(" ");
  }
  return result;
}

export function rawBgVisualization(
  property: RealtimeDocument | undefined,
  units: "mg/dl" | "mmol",
  show: boolean,
): RealtimeDocument {
  return show && property?.sgv && property.cal
    ? {
      hide: !property.mgdl,
      value: scaledMgdl(property.mgdl, units),
      label: property.noiseLabel,
    }
    : { hide: true };
}

export function rawBgAssistantResponse(property: RealtimeDocument | undefined): {
  title: string;
  response: string;
} {
  const raw = property?.mgdl;
  return {
    title: "Current Raw BG",
    response: raw
      ? `Your raw bg is ${String(raw)}`
      : "That value is unknown at the moment. Please see your Nightscout site for more details.",
  };
}
