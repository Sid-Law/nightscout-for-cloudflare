import type { RealtimeDocument } from "../realtime/ddata-snapshot";
import { INFO, URGENT, WARN, isAlarmLevel, levelToDisplay } from "../runtime/levels";
import { nightscoutTimes } from "../runtime/times";
import { mgdlToMMOL } from "../runtime/units";

const MANUAL_TREATMENTS = new Set([
  "BG Check",
  "Meal Bolus",
  "Carb Correction",
  "Correction Bolus",
]);

const TREATMENT_NOTIFY_PLUGIN = {
  name: "treatmentnotify",
  label: "Treatment Notifications",
  pluginType: "notification",
} as const;

export interface TreatmentNotifyPreferences extends Record<string, unknown> {
  snoozeMins?: unknown;
  includeBolusesOver?: unknown;
}

export interface TreatmentNotifySettings extends Record<string, unknown> {
  units?: unknown;
  thresholds?: Record<string, unknown>;
  alarmUrgentHigh?: unknown;
  alarmHigh?: unknown;
  alarmUrgentLow?: unknown;
  alarmLow?: unknown;
}

export interface TreatmentNotificationRequests {
  notifications: RealtimeDocument[];
  snoozes: RealtimeDocument[];
}

function document(value: unknown): value is RealtimeDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lastEntry(entries: RealtimeDocument[], now: number): RealtimeDocument | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry !== undefined && Number(entry.mills) <= now) return entry;
  }
  return undefined;
}

function isCurrent(entry: RealtimeDocument | undefined, now: number): boolean {
  if (entry === undefined) return false;
  const mills = Number(entry.mills);
  const ago = mills <= now ? now - mills : -1;
  return ago !== -1 && ago < nightscoutTimes.mins(10).msecs;
}

function filterTreatments(
  treatments: RealtimeDocument[],
  preferences: TreatmentNotifyPreferences,
): RealtimeDocument[] {
  const includeBolusesOver = preferences.includeBolusesOver || 0;
  return treatments.filter((treatment) => {
    let accepted = true;
    const enteredBy = treatment.enteredBy;
    if (
      typeof enteredBy === "string" &&
      (enteredBy.startsWith("openaps://") || enteredBy.startsWith("loop://"))
    ) {
      accepted = MANUAL_TREATMENTS.has(String(treatment.eventType));
    }
    if (
      accepted && typeof treatment.insulin === "number" &&
      ["Meal Bolus", "Correction Bolus"].includes(String(treatment.eventType))
    ) {
      accepted = treatment.insulin >= Number(includeBolusesOver);
    }
    return accepted;
  });
}

function units(settings: TreatmentNotifySettings): "mg/dl" | "mmol" {
  return settings.units === "mmol" ? "mmol" : "mg/dl";
}

function unitsLabel(settings: TreatmentNotifySettings): "mg/dl" | "mmol/L" {
  return units(settings) === "mmol" ? "mmol/L" : "mg/dl";
}

function scaleMgdl(value: unknown, settings: TreatmentNotifySettings): number {
  return units(settings) === "mmol" && value
    ? Number(mgdlToMMOL(value as number | string))
    : Number(value);
}

function scaleEntry(entry: RealtimeDocument, settings: TreatmentNotifySettings): number {
  if (entry.scaled !== undefined) return Number(entry.scaled);
  return units(settings) === "mmol"
    ? Number(entry.mmol || mgdlToMMOL(entry.mgdl as number | string))
    : Number(entry.mgdl || (Number(entry.mmol) * 18.01559));
}

function compareBgToThresholds(
  scaledBg: number,
  settings: TreatmentNotifySettings,
): { level: number; pushoverSound?: string } {
  const thresholds = document(settings.thresholds) ? settings.thresholds : {};
  const bgHigh = thresholds.bgHigh ?? 260;
  const targetTop = thresholds.bgTargetTop ?? 180;
  const targetBottom = thresholds.bgTargetBottom ?? 80;
  const bgLow = thresholds.bgLow ?? 55;
  let result: { level: number; pushoverSound?: string } = { level: INFO };
  if ((settings.alarmUrgentHigh ?? true) && scaledBg > scaleMgdl(bgHigh, settings)) {
    result = { level: URGENT, pushoverSound: "persistent" };
  } else if ((settings.alarmHigh ?? true) && scaledBg > scaleMgdl(targetTop, settings)) {
    result = { level: WARN, pushoverSound: "climb" };
  }
  if ((settings.alarmUrgentLow ?? true) && scaledBg < scaleMgdl(bgLow, settings)) {
    result = { level: URGENT, pushoverSound: "persistent" };
  } else if ((settings.alarmLow ?? true) && scaledBg < scaleMgdl(targetBottom, settings)) {
    result = { level: WARN, pushoverSound: "falling" };
  }
  return result;
}

function roundInsulin(insulin: unknown): string {
  const value = Number(insulin);
  if (value === 0) return "0";
  return (Math.floor(value * 100 + 1e-9) / 100).toFixed(2);
}

function buildTreatmentMessage(treatment: RealtimeDocument): string {
  return (treatment.glucose
    ? `BG: ${String(treatment.glucose)} (${String(treatment.glucoseType)})`
    : "") +
    (treatment.reason ? `\nReason: ${String(treatment.reason)}` : "") +
    (treatment.targetTop ? `\nTarget Top: ${String(treatment.targetTop)}` : "") +
    (treatment.targetBottom ? `\nTarget Bottom: ${String(treatment.targetBottom)}` : "") +
    (treatment.carbs ? `\nCarbs: ${String(treatment.carbs)}g` : "") +
    (treatment.insulin ? `\nInsulin: ${roundInsulin(treatment.insulin)}U` : "") +
    (treatment.duration ? `\nDuration: ${String(treatment.duration)} min` : "") +
    (treatment.percent
      ? `\nPercent: ${Number(treatment.percent) > 0 ? "+" : ""}${String(treatment.percent)}%`
      : "") +
    (!Number.isNaN(Number(treatment.absolute))
      ? `\nValue: ${String(treatment.absolute)}U`
      : "") +
    (treatment.enteredBy ? `\nEntered By: ${String(treatment.enteredBy)}` : "") +
    (treatment.notes ? `\nNotes: ${String(treatment.notes)}` : "");
}

async function sha1(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-1", new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function addNotification(
  requests: TreatmentNotificationRequests,
  notification: RealtimeDocument,
): void {
  if (
    notification.level === undefined || !notification.title ||
    !notification.message || !notification.plugin
  ) return;
  requests.notifications.push({ group: "default", ...notification });
}

function addSnooze(
  requests: TreatmentNotificationRequests,
  snooze: RealtimeDocument,
): void {
  if (!snooze.level || !snooze.title || !snooze.message || !snooze.lengthMills) return;
  requests.snoozes.push({ group: "default", ...snooze });
}

/**
 * Request-local Workers port of locked treatmentnotify.checkNotifications().
 * Web Crypto replaces Node's synchronous crypto module; all selection,
 * snooze and payload semantics remain upstream-compatible.
 */
export async function calculateTreatmentNotificationRequests(
  treatments: RealtimeDocument[],
  mbgs: RealtimeDocument[],
  now: number,
  preferences: TreatmentNotifyPreferences = {},
  settings: TreatmentNotifySettings = {},
): Promise<TreatmentNotificationRequests> {
  const requests: TreatmentNotificationRequests = { notifications: [], snoozes: [] };
  const filtered = filterTreatments(treatments, preferences);
  const lastMbg = lastEntry(mbgs, now);
  const lastTreatment = lastEntry(filtered, now);
  const mbgCurrent = isCurrent(lastMbg, now);
  const treatmentCurrent = isCurrent(lastTreatment, now);
  if (!mbgCurrent && !treatmentCurrent) return requests;

  const mbgMessage = mbgCurrent && lastMbg !== undefined
    ? `Meter BG ${String(scaleEntry(lastMbg, settings))} ${unitsLabel(settings)}`
    : "";
  const treatmentMessage = treatmentCurrent && lastTreatment !== undefined
    ? `Treatment: ${String(lastTreatment.eventType)}`
    : "";

  // Preserve the locked implementation's exact lastTreatment check: a
  // current MBG can snooze when an older non-announcement treatment remains.
  if (lastTreatment !== undefined && !lastTreatment.isAnnouncement) {
    const lengthMills = preferences.snoozeMins
      ? nightscoutTimes.mins(Number(preferences.snoozeMins)).msecs
      : nightscoutTimes.mins(10).msecs;
    addSnooze(requests, {
      level: URGENT,
      title: "Snoozing alarms since there was a recent treatment",
      message: [mbgMessage, treatmentMessage].join("\n").trim(),
      lengthMills,
    });
  }

  if (mbgCurrent && lastMbg !== undefined) {
    addNotification(requests, {
      level: INFO,
      title: "Calibration",
      message: `Meter BG: ${String(scaleEntry(lastMbg, settings))} ${unitsLabel(settings)}`,
      plugin: TREATMENT_NOTIFY_PLUGIN,
      pushoverSound: "magic",
    });
  }

  if (treatmentCurrent && lastTreatment !== undefined) {
    if (lastTreatment.isAnnouncement) {
      const result = compareBgToThresholds(scaleMgdl(lastTreatment.mgdl, settings), settings);
      addNotification(requests, {
        level: result.level,
        title: `${result.level === URGENT ? `${levelToDisplay(URGENT)} ` : ""}${
          String(lastTreatment.eventType)
        }`,
        message: lastTreatment.notes || ".",
        plugin: TREATMENT_NOTIFY_PLUGIN,
        group: "Announcement",
        ...(isAlarmLevel(result.level) ? { pushoverSound: result.pushoverSound } : {}),
        isAnnouncement: true,
      });
    } else {
      let message = buildTreatmentMessage(lastTreatment);
      let eventType = lastTreatment.eventType;
      if (lastTreatment.duration === 0 && eventType === "Temporary Target") {
        eventType = "Temporary Target Cancel";
        message = "Canceled";
      }
      if (!message) message = "...";
      if (!eventType && lastTreatment.carbs && lastTreatment.insulin) eventType = "Meal Bolus";
      if (!eventType && lastTreatment.carbs) eventType = "Carb Correction";
      if (!eventType && lastTreatment.insulin) eventType = "Correcton Bolus";
      if (!eventType) eventType = "Note";
      const timestamp = lastTreatment.timestamp;
      const notifyhash = await sha1(JSON.stringify({ eventType, timestamp }));
      addNotification(requests, {
        level: INFO,
        title: String(eventType),
        message,
        timestamp,
        plugin: TREATMENT_NOTIFY_PLUGIN,
        notifyhash,
      });
    }
  }

  return requests;
}
