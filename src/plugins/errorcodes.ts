import type { RealtimeDocument } from "../realtime/ddata-snapshot";
import { INFO, URGENT, WARN } from "../runtime/levels";
import { nightscoutTimes } from "../runtime/times";

export const ERROR_CODES_PLUGIN = {
  name: "errorcodes",
  label: "Dexcom Error Codes",
  pluginType: "notification",
} as const;

export interface ErrorCodeSettings extends Record<string, unknown> {
  info?: unknown;
  warn?: unknown;
  urgent?: unknown;
}

const CODE_TO_DISPLAY: Readonly<Record<number, string>> = Object.freeze({
  1: "?SN",
  2: "?MD",
  3: "?NA",
  5: "?NC",
  6: "?CD",
  9: "?AD",
  10: "???",
  12: "?RF",
});

const CODE_TO_PUSHOVER_SOUND: Readonly<Record<number, string>> = Object.freeze({
  5: "intermission",
  9: "alien",
  10: "alien",
});

/** Direct port of locked errorcodes.toDisplay(). */
export function errorCodeDisplay(errorCode: number): string {
  return CODE_TO_DISPLAY[errorCode] ?? `${String(errorCode)}??`;
}

/** Direct port of locked errorcodes.buildMappingFromSettings(). */
export function buildErrorCodeLevelMapping(
  settings: ErrorCodeSettings = {},
): Record<number, number> {
  const mapping: Record<number, number> = {};
  const addValues = (value: unknown, level: number): void => {
    if (!value || typeof (value as { split?: unknown }).split !== "function") return;
    for (const token of (value as string).split(" ")) {
      // Preserve upstream global isNaN coercion, including an empty token -> 0.
      if (!Number.isNaN(Number(token))) mapping[Number(token)] = level;
    }
  };

  addValues(settings.info || "1 2 3 4 5 6 7 8", INFO);
  addValues(settings.warn || false, WARN);
  addValues(settings.urgent || "9 10", URGENT);
  return mapping;
}

function lastSgvAtOrBefore(
  sgvs: RealtimeDocument[],
  now: number,
): RealtimeDocument | undefined {
  for (let index = sgvs.length - 1; index >= 0; index -= 1) {
    const entry = sgvs[index];
    if (entry !== undefined && Number(entry.mills) <= now) return entry;
  }
  return undefined;
}

/** Direct request-local port of locked errorcodes.checkNotifications(). */
export function calculateErrorCodeNotification(
  sgvs: RealtimeDocument[],
  now: number,
  settings: ErrorCodeSettings = {},
): RealtimeDocument | null {
  const lastSgv = lastSgvAtOrBefore(sgvs, now);
  if (
    lastSgv === undefined
    || now - Number(lastSgv.mills) >= nightscoutTimes.mins(10).msecs
    || Number(lastSgv.mgdl) >= 39
  ) return null;

  const code = Number(lastSgv.mgdl);
  const level = buildErrorCodeLevelMapping(settings)[code];
  if (level === undefined) return null;

  return {
    level,
    title: "CGM Error Code",
    message: errorCodeDisplay(code),
    plugin: ERROR_CODES_PLUGIN,
    pushoverSound: CODE_TO_PUSHOVER_SOUND[code] ?? null,
    group: "CGM Error Code",
    debug: { lastSGV: lastSgv },
  };
}
