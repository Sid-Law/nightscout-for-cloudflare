import type { RealtimeDocument } from "../realtime/ddata-snapshot";
import { INFO, URGENT, WARN, isAlarmLevel, levelToDisplay } from "../runtime/levels";
import { nightscoutTimes } from "../runtime/times";
import { mgdlToMMOL, mmolToMgdl } from "../runtime/units";
import { calculateBgnowProperties } from "./bgnow";

const SIMPLE_ALARMS_PLUGIN = {
  name: "simplealarms",
  label: "Simple Alarms",
  pluginType: "notification",
} as const;

export interface SimpleAlarmSettings extends Record<string, unknown> {
  units?: unknown;
  thresholds?: Record<string, unknown>;
  alarmUrgentHigh?: unknown;
  alarmHigh?: unknown;
  alarmUrgentLow?: unknown;
  alarmLow?: unknown;
}

export interface SimpleAlarmComparison {
  level: number;
  title?: string;
  pushoverSound?: string;
  eventName?: "high" | "low";
}

function units(settings: SimpleAlarmSettings): "mg/dl" | "mmol" {
  return settings.units === "mmol" ? "mmol" : "mg/dl";
}

function scaleMgdl(value: unknown, settings: SimpleAlarmSettings): number {
  return units(settings) === "mmol" && value
    ? Number(mgdlToMMOL(value as number | string))
    : Number(value);
}

function scaledEntry(entry: RealtimeDocument, settings: SimpleAlarmSettings): number {
  if (entry.scaled !== undefined) return Number(entry.scaled);
  return units(settings) === "mmol"
    ? Number(entry.mmol || mgdlToMMOL(entry.mgdl as number | string))
    : Number(entry.mgdl || mmolToMgdl(entry.mmol as number | string));
}

function latestSgv(
  sgvs: RealtimeDocument[],
  now: number,
): RealtimeDocument | undefined {
  for (let index = sgvs.length - 1; index >= 0; index -= 1) {
    const entry = sgvs[index];
    if (entry !== undefined && Number(entry.mills) <= now) return entry;
  }
  return undefined;
}

function displaySgv(entry: RealtimeDocument, settings: SimpleAlarmSettings): string {
  if (Number(entry.mgdl) === 39) return "LOW";
  if (Number(entry.mgdl) === 401) return "HIGH";
  return String(scaledEntry(entry, settings));
}

function buildDefaultMessage(
  sgvs: RealtimeDocument[],
  entry: RealtimeDocument,
  now: number,
  settings: SimpleAlarmSettings,
): string {
  const displayUnits = units(settings);
  const properties = calculateBgnowProperties(sgvs, now, displayUnits);
  const delta = properties.delta?.display;
  const deltaText = delta ? ` ${String(delta)}` : "";
  const label = displayUnits === "mmol" ? "mmol/L" : "mg/dl";
  return `BG Now: ${displaySgv(entry, settings)}${deltaText} ${label}`;
}

/** Direct request-local port of locked simplealarms.compareBGToTresholds(). */
export function compareSimpleAlarmThresholds(
  scaledSgv: number,
  settings: SimpleAlarmSettings = {},
): SimpleAlarmComparison {
  const thresholds = settings.thresholds ?? {};
  const bgHigh = thresholds.bgHigh ?? 260;
  const targetTop = thresholds.bgTargetTop ?? 180;
  const targetBottom = thresholds.bgTargetBottom ?? 80;
  const bgLow = thresholds.bgLow ?? 55;
  let result: SimpleAlarmComparison = { level: INFO };

  if (Boolean(settings.alarmUrgentHigh ?? true) && scaledSgv > scaleMgdl(bgHigh, settings)) {
    result = {
      level: URGENT,
      title: `${levelToDisplay(URGENT)} HIGH`,
      pushoverSound: "persistent",
      eventName: "high",
    };
  } else if (Boolean(settings.alarmHigh ?? true) && scaledSgv > scaleMgdl(targetTop, settings)) {
    result = {
      level: WARN,
      title: `${levelToDisplay(WARN)} HIGH`,
      pushoverSound: "climb",
      eventName: "high",
    };
  }

  if (Boolean(settings.alarmUrgentLow ?? true) && scaledSgv < scaleMgdl(bgLow, settings)) {
    result = {
      level: URGENT,
      title: `${levelToDisplay(URGENT)} LOW`,
      pushoverSound: "persistent",
      eventName: "low",
    };
  } else if (Boolean(settings.alarmLow ?? true) && scaledSgv < scaleMgdl(targetBottom, settings)) {
    result = {
      level: WARN,
      title: `${levelToDisplay(WARN)} LOW`,
      pushoverSound: "falling",
      eventName: "low",
    };
  }

  return result;
}

/**
 * Direct request-local port of locked simplealarms.checkNotifications().
 * It returns the official request object; the persisted notification runner
 * remains a separate platform adapter.
 */
export function calculateSimpleAlarmRequest(
  sgvs: RealtimeDocument[],
  now: number,
  settings: SimpleAlarmSettings = {},
): RealtimeDocument | null {
  const entry = latestSgv(sgvs, now);
  if (
    entry === undefined
    || Number(entry.mgdl) <= 39
    || now - Number(entry.mills) >= nightscoutTimes.mins(10).msecs
  ) return null;

  const scaledSgv = scaledEntry(entry, settings);
  const comparison = compareSimpleAlarmThresholds(scaledSgv, settings);
  if (!isAlarmLevel(comparison.level) || comparison.title === undefined) return null;

  return {
    level: comparison.level,
    title: comparison.title,
    message: buildDefaultMessage(sgvs, entry, now, settings),
    eventName: comparison.eventName,
    plugin: SIMPLE_ALARMS_PLUGIN,
    pushoverSound: comparison.pushoverSound,
    debug: {
      lastSGV: scaledSgv,
      thresholds: settings.thresholds ?? {
        bgHigh: 260,
        bgTargetTop: 180,
        bgTargetBottom: 80,
        bgLow: 55,
      },
    },
    group: "default",
  };
}
