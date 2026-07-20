import type { RealtimeDocument } from "../realtime/ddata-snapshot";
import { URGENT, WARN } from "../runtime/levels";
import { nightscoutTimes } from "../runtime/times";

export interface TimeAgoDisplay extends RealtimeDocument {
  value?: number;
  label: string;
  shortLabel: string;
}

export interface TimeAgoSettings extends Record<string, unknown> {
  units?: unknown;
  alarmTimeagoWarn?: unknown;
  alarmTimeagoWarnMins?: unknown;
  alarmTimeagoUrgent?: unknown;
  alarmTimeagoUrgentMins?: unknown;
}

export interface TimeAgoPreferences extends Record<string, unknown> {
  enableAlerts?: unknown;
}

export interface TimeAgoClientRuntimeState {
  lastChecked: number;
  lastRecoveryTimeFromSuspend: number;
}

const TIMEAGO_PLUGIN = {
  name: "timeago",
  label: "Timeago",
  pluginType: "pill-status",
  pillFlip: true,
} as const;

function numeric(value: unknown): number {
  return Number(value);
}

/** Direct pure port of locked plugins/timeago.calcDisplay(). */
export function calculateTimeAgoDisplay(
  entry: RealtimeDocument | null | undefined,
  time: number,
): TimeAgoDisplay {
  const mills = entry?.mills;
  const timeSince = time && mills ? time - numeric(mills) : Number.NaN;
  if (
    entry === null || entry === undefined ||
    Number.isNaN(numeric(mills)) || Number.isNaN(numeric(time)) ||
    Number.isNaN(timeSince)
  ) {
    return { label: "time ago", shortLabel: "ago" };
  }
  if (numeric(mills) - nightscoutTimes.mins(5).msecs > time) {
    return { label: "in the future", shortLabel: "future" };
  }
  if (numeric(mills) > time) return { value: 1, label: "min ago", shortLabel: "m" };

  const ranges = [
    [nightscoutTimes.mins(2).msecs, nightscoutTimes.min().msecs, "min ago", "m"],
    [nightscoutTimes.hour().msecs, nightscoutTimes.min().msecs, "mins ago", "m"],
    [nightscoutTimes.hours(2).msecs, nightscoutTimes.hour().msecs, "hour ago", "h"],
    [nightscoutTimes.day().msecs, nightscoutTimes.hour().msecs, "hours ago", "h"],
    [nightscoutTimes.days(2).msecs, nightscoutTimes.day().msecs, "day ago", "d"],
    [nightscoutTimes.week().msecs, nightscoutTimes.day().msecs, "days ago", "d"],
  ] as const;
  for (const [limit, divisor, label, shortLabel] of ranges) {
    if (timeSince < limit) {
      return {
        value: Math.max(1, Math.round(timeSince / divisor)),
        label,
        shortLabel,
      };
    }
  }
  return { label: "long ago", shortLabel: "ago" };
}

function lastSgvAtOrBefore(
  sgvs: RealtimeDocument[],
  now: number,
): RealtimeDocument | undefined {
  for (let index = sgvs.length - 1; index >= 0; index -= 1) {
    const entry = sgvs[index];
    if (entry !== undefined && numeric(entry.mills) <= now) return entry;
  }
  return undefined;
}

export function createTimeAgoClientRuntimeState(): TimeAgoClientRuntimeState {
  return {
    lastChecked: Date.now(),
    lastRecoveryTimeFromSuspend: Date.parse("1900-01-01T00:00:00.000Z"),
  };
}

/**
 * Direct port of checkStatus(). Client hibernation state is explicit and
 * request-local; the server path used by the future alarm runner is stateless.
 */
export function calculateTimeAgoStatus(
  sgvs: RealtimeDocument[],
  now: number,
  settings: TimeAgoSettings,
  runtimeEnvironment: "client" | "server" = "server",
  runtimeState?: TimeAgoClientRuntimeState,
  wallClock = Date.now(),
): "current" | "warn" | "urgent" {
  if (runtimeEnvironment === "client" && runtimeState !== undefined) {
    const delta = wallClock - runtimeState.lastChecked;
    runtimeState.lastChecked = wallClock;
    if (delta > 20_000) runtimeState.lastRecoveryTimeFromSuspend = wallClock;
    if (wallClock - runtimeState.lastRecoveryTimeFromSuspend < 10_000) return "current";
  }

  const last = lastSgvAtOrBefore(sgvs, now);
  if (last === undefined) return "current";
  const warnMins = settings.alarmTimeagoWarnMins || 15;
  const urgentMins = settings.alarmTimeagoUrgentMins || 30;
  const stale = (minutes: unknown): boolean =>
    now - numeric(last.mills) > nightscoutTimes.mins(numeric(minutes)).msecs;
  if (settings.alarmTimeagoUrgent && stale(urgentMins)) return "urgent";
  if (settings.alarmTimeagoWarn && stale(warnMins)) return "warn";
  return "current";
}

/** Complete locked notification request shape, kept pure until alarm scheduling is connected. */
export function timeAgoNotification(
  sgvs: RealtimeDocument[],
  now: number,
  settings: TimeAgoSettings,
  preferences: TimeAgoPreferences,
  defaultLines?: readonly string[],
): RealtimeDocument | null {
  if (!preferences.enableAlerts) return null;
  const last = lastSgvAtOrBefore(sgvs, now);
  if (last === undefined || numeric(last.mills) >= now) return null;
  const status = calculateTimeAgoStatus(sgvs, now, settings);
  if (status !== "warn" && status !== "urgent") return null;
  const display = calculateTimeAgoDisplay(last, now);
  const lines = defaultLines === undefined
    ? [`BG Now: ${String(last.mgdl)} ${settings.units === "mmol" ? "mmol/L" : "mg/dl"}`]
    : [...defaultLines];
  lines.unshift(`Last received: ${String(display.value)} ${display.label}`);
  return {
    level: status === "urgent" ? URGENT : WARN,
    title: "Stale data, check rig?",
    message: lines.join("\n"),
    eventName: "timeago",
    plugin: TIMEAGO_PLUGIN,
    group: "Time Ago",
    pushoverSound: "echo",
    debug: display,
  };
}

export function timeAgoVisualization(
  sgvs: RealtimeDocument[],
  now: number,
  settings: TimeAgoSettings,
  inRetroMode = false,
): RealtimeDocument {
  const display = calculateTimeAgoDisplay(lastSgvAtOrBefore(sgvs, now), now);
  return {
    value: inRetroMode ? null : display.value,
    label: inRetroMode ? "RETRO" : display.label,
    pillClass: inRetroMode ? "current" : calculateTimeAgoStatus(sgvs, now, settings),
  };
}
