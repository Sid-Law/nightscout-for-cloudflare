import type { RealtimeDocument } from "../realtime/ddata-snapshot";
import { NONE, URGENT, WARN, levelToStatusClass } from "../runtime/levels";
import { nightscoutTimes } from "../runtime/times";
import { mgdlToMMOL } from "../runtime/units";

export interface LoopPreferences {
  warn?: unknown;
  urgent?: unknown;
  enableAlerts?: unknown;
}

export interface LoopDisplay extends RealtimeDocument {
  symbol: string;
  code: "warning" | "error" | "enacted" | "recommendation" | "looping";
  label: string;
}

export interface LoopProperty extends RealtimeDocument {
  lastLoop: RealtimeDocument | null;
  lastEnacted: RealtimeDocument | null;
  lastPredicted: RealtimeDocument | null;
  lastOkMoment: string | null;
  lastOverride?: RealtimeDocument;
  display: LoopDisplay;
}

export interface LoopVisualization {
  pill: {
    value: string | null;
    label: string;
    info: RealtimeDocument[];
    pillClass: "current" | "warn" | "urgent";
  };
  forecastPoints: RealtimeDocument[];
  forecastInfo: { type: "loop"; label: "Loop Forecasts" } | null;
}

export interface LoopNotification extends RealtimeDocument {
  level: number;
  title: string;
  message: string;
  pushoverSound: "echo";
  group: "Loop";
  plugin: {
    name: "loop";
    label: "Loop";
    pluginType: "pill-status";
  };
  debug: LoopProperty;
}

export const LOOP_INTENTS = [
  { intent: "MetricNow", metrics: ["loop forecast", "forecast"] },
  { intent: "LastLoop" },
] as const;

const LOOP_PLUGIN = {
  name: "loop",
  label: "Loop",
  pluginType: "pill-status",
} as const;

const ENGLISH = {
  virtAsstTitleLoopForecast: "Loop Forecast",
  virtAsstTitleLastLoop: "Last Loop",
  virtAsstForecastUnavailable: "Unable to forecast with the data that is available",
  virtAsstUnknown:
    "That value is unknown at the moment. Please see your Nightscout site for more details.",
  virtAsstLoopForecastAround:
    "According to the loop forecast you are expected to be around %1 over the next %2",
  virtAsstLoopForecastBetween:
    "According to the loop forecast you are expected to be between %1 and %2 over the next %3",
  virtAsstLastLoop: "The last successful loop was %1",
} as const;

type LoopTranslationKey = keyof typeof ENGLISH;
export type LoopTranslator = (
  key: LoopTranslationKey,
  params?: readonly (number | string)[],
) => string;

const translateEnglish: LoopTranslator = (key, params = []) => {
  let result: string = ENGLISH[key];
  params.forEach((value, index) => {
    result = result.replaceAll(`%${index + 1}`, String(value));
  });
  return result;
};

function document(value: unknown): RealtimeDocument | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RealtimeDocument
    : undefined;
}

function cloneDocument(value: RealtimeDocument): RealtimeDocument {
  return JSON.parse(JSON.stringify(value)) as RealtimeDocument;
}

function dateMills(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return Number.NaN;
  return Date.parse(value);
}

function isoMoment(value: unknown): string | null {
  const mills = dateMills(value);
  return Number.isFinite(mills) ? new Date(mills).toISOString() : null;
}

function entryMills(entry: RealtimeDocument): number {
  return Number(entry.mills);
}

function normalizedPreferences(preferences: LoopPreferences): {
  warn: number;
  urgent: number;
  enableAlerts: unknown;
} {
  return {
    // Preserve the locked plugin's truthy fallback rather than replacing it
    // with nullish coalescing: configured zero uses the upstream defaults.
    warn: Number(preferences.warn ? preferences.warn : 30),
    urgent: Number(preferences.urgent ? preferences.urgent : 60),
    enableAlerts: preferences.enableAlerts,
  };
}

function loopDisplay(
  status: RealtimeDocument | null,
  now: number,
  warnMinutes: number,
): LoopDisplay {
  const display: LoopDisplay = {
    symbol: "⚠",
    code: "warning",
    label: "Warning",
  };
  if (status === null) return display;

  const enacted = document(status.enacted);
  if (status.failureReason || (enacted !== undefined && !enacted.received)) {
    return { symbol: "x", code: "error", label: "Error" };
  }

  const recent = now - warnMinutes / 2 * nightscoutTimes.min().msecs;
  if (enacted !== undefined && dateMills(status.timestamp) > recent) {
    return { symbol: "⌁", code: "enacted", label: "Enacted" };
  }
  const recommended = document(status.recommendedTempBasal);
  if (recommended !== undefined && dateMills(recommended.timestamp) > recent) {
    return { symbol: "⏀", code: "recommendation", label: "Recomendation" };
  }
  if (dateMills(status.moment) > recent) {
    return { symbol: "↻", code: "looping", label: "Looping" };
  }
  return display;
}

/** Direct, request-local port of locked plugins/loop.analyzeData(). */
export function calculateLoopProperty(
  deviceStatuses: RealtimeDocument[],
  now: number,
  preferences: LoopPreferences = {},
): LoopProperty {
  const recentMills = now - nightscoutTimes.hours(6).msecs;
  const recent = deviceStatuses.filter((status) =>
    Object.prototype.hasOwnProperty.call(status, "loop") &&
    entryMills(status) <= now && entryMills(status) >= recentMills
  );
  const result: LoopProperty = {
    lastLoop: null,
    lastEnacted: null,
    lastPredicted: null,
    lastOkMoment: null,
    display: { symbol: "⚠", code: "warning", label: "Warning" },
  };

  for (const status of recent) {
    const rawLoop = document(status.loop);
    if (rawLoop === undefined || !rawLoop.timestamp) continue;
    const loop = cloneDocument(rawLoop);
    loop.moment = isoMoment(loop.timestamp);
    const loopMills = dateMills(loop.moment);

    const enacted = document(loop.enacted);
    if (enacted?.timestamp) {
      enacted.moment = isoMoment(enacted.timestamp);
      const current = result.lastEnacted;
      if (current === null || dateMills(enacted.moment) > dateMills(current.moment)) {
        result.lastEnacted = enacted;
      }
    }

    const predicted = document(loop.predicted);
    if (predicted?.startDate) result.lastPredicted = predicted;

    if (result.lastLoop === null || loopMills > dateMills(result.lastLoop.moment)) {
      result.lastLoop = loop;
    }

    const override = document(status.override);
    if (override?.timestamp) {
      const copiedOverride = cloneDocument(override);
      copiedOverride.moment = isoMoment(copiedOverride.timestamp);
      if (
        result.lastOverride === undefined ||
        dateMills(copiedOverride.moment) > dateMills(result.lastOverride.moment)
      ) {
        result.lastOverride = copiedOverride;
      }
    }

    if (
      !loop.failureReason &&
      (result.lastOkMoment === null || loopMills > dateMills(result.lastOkMoment))
    ) {
      result.lastOkMoment = loop.moment as string | null;
    }
  }

  result.display = loopDisplay(
    result.lastLoop,
    now,
    normalizedPreferences(preferences).warn,
  );
  return result;
}

function shortAgo(when: unknown, now: number): string {
  const mills = dateMills(when);
  if (!Number.isFinite(mills)) return "ago";
  const since = now - mills;
  if (mills - nightscoutTimes.mins(5).msecs > now) return "future";
  if (mills > now) return "1m ago";
  if (since < nightscoutTimes.mins(2).msecs) {
    return `${Math.max(1, Math.round(since / nightscoutTimes.min().msecs))}m ago`;
  }
  if (since < nightscoutTimes.hour().msecs) {
    return `${Math.max(1, Math.round(since / nightscoutTimes.min().msecs))}m ago`;
  }
  if (since < nightscoutTimes.hours(2).msecs) {
    return `${Math.max(1, Math.round(since / nightscoutTimes.hour().msecs))}h ago`;
  }
  if (since < nightscoutTimes.day().msecs) {
    return `${Math.max(1, Math.round(since / nightscoutTimes.hour().msecs))}h ago`;
  }
  if (since < nightscoutTimes.days(2).msecs) {
    return `${Math.max(1, Math.round(since / nightscoutTimes.day().msecs))}d ago`;
  }
  if (since < nightscoutTimes.week().msecs) {
    return `${Math.max(1, Math.round(since / nightscoutTimes.day().msecs))}d ago`;
  }
  return "ago";
}

function momentRelative(target: unknown, base: number): string {
  const targetMills = dateMills(target);
  if (!Number.isFinite(targetMills)) return "Invalid date";
  const future = targetMills > base;
  const seconds = Math.round(Math.abs(targetMills - base) / 1_000);
  let text: string;
  if (seconds <= 44) text = "a few seconds";
  else if (seconds <= 89) text = "a minute";
  else {
    const minutes = Math.round(seconds / 60);
    if (minutes <= 44) text = `${minutes} minutes`;
    else if (minutes <= 89) text = "an hour";
    else {
      const hours = Math.round(minutes / 60);
      if (hours <= 21) text = `${hours} hours`;
      else if (hours <= 35) text = "a day";
      else {
        const days = Math.round(hours / 24);
        if (days <= 25) text = `${days} days`;
        else if (days <= 45) text = "a month";
        else {
          const months = Math.round(days / 30);
          if (months <= 10) text = `${months} months`;
          else if (months <= 17) text = "a year";
          else text = `${Math.round(days / 365)} years`;
        }
      }
    }
  }
  return future ? `in ${text}` : `${text} ago`;
}

function roundInsulin(value: unknown): string {
  const insulin = Number(value);
  if (insulin === 0) return "0";
  return (Math.floor(insulin * 100 + 1e-9) / 100).toFixed(2);
}

function scaledBg(value: number, units: "mg/dl" | "mmol"): number {
  return units === "mmol" ? Number(mgdlToMMOL(value)) : value;
}

function roundedBg(value: number, units: "mg/dl" | "mmol"): number {
  const scaled = scaledBg(value, units);
  return units === "mmol" ? Math.round(scaled * 10) / 10 : Math.round(scaled);
}

function displayTime(when: unknown, now: number, inRetroMode: boolean): string {
  if (!inRetroMode) return shortAgo(when, now);
  const mills = dateMills(when);
  if (!Number.isFinite(mills)) return "unknown";
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(mills));
}

/** Pure form of locked plugins/loop.updateVisualisation(). */
export function loopVisualization(
  property: LoopProperty,
  deviceStatuses: RealtimeDocument[],
  now: number,
  units: "mg/dl" | "mmol" = "mg/dl",
  preferences: LoopPreferences = {},
  inRetroMode = false,
): LoopVisualization {
  const events: { time: number; value: string }[] = [];
  const lastLoop = property.lastLoop;

  const concatLoopValues = (parts: string[]): string[] => {
    const iob = document(lastLoop?.iob);
    if (iob !== undefined) {
      parts.push(", IOB: ", `${roundInsulin(iob.iob)}U`);
      if (iob.basaliob) parts.push(`, Basal IOB ${roundInsulin(iob.basaliob)}U`);
    }
    const cob = document(lastLoop?.cob);
    if (cob !== undefined) parts.push(", COB: ", `${Math.round(Number(cob.cob))}g`);
    const predicted = document(lastLoop?.predicted);
    const values = Array.isArray(predicted?.values)
      ? predicted.values.map(Number)
      : [];
    if (predicted !== undefined && values.length > 0) {
      const eventual = values[values.length - 1]!;
      parts.push(
        ", Predicted Min-Max BG: ",
        String(roundedBg(Math.min(...values), units)),
        "-",
        String(roundedBg(Math.max(...values), units)),
        ", Eventual BG: ",
        String(roundedBg(eventual, units)),
      );
    }
    if (lastLoop?.recommendedBolus) {
      parts.push(", Recommended Bolus: ", `${String(lastLoop.recommendedBolus)}U`);
    }
    return parts;
  };

  const addRecommendedTempBasal = (): void => {
    const recommended = document(lastLoop?.recommendedTempBasal);
    if (recommended === undefined) return;
    const parts = concatLoopValues([
      `Suggested Temp: ${String(recommended.rate)}U/hour for ${String(recommended.duration)}m`,
    ]);
    events.push({ time: dateMills(recommended.timestamp), value: parts.join("") });
  };

  const addLastEnacted = (): void => {
    const enacted = property.lastEnacted;
    if (enacted === null) return;
    const parts: string[] = [];
    if (enacted.bolusVolume) {
      parts.push("<b>Automatic Bolus</b>", ` ${String(enacted.bolusVolume)}U`);
      if (enacted.rate === 0 && enacted.duration === 0) {
        parts.push(" (Temp Basal Canceled)");
      }
    } else if (enacted.rate === 0 && enacted.duration === 0) {
      parts.push("<b>Temp Basal Canceled</b>");
    } else if (enacted.rate != null) {
      parts.push(
        "<b>Temp Basal Started</b>",
        ` ${Number(enacted.rate).toFixed(2)}U/hour for ${String(enacted.duration)}m`,
      );
    }
    if (enacted.reason != null) parts.push(`, ${String(enacted.reason)}`);
    concatLoopValues(parts);
    events.push({ time: dateMills(enacted.moment), value: parts.join("") });
  };

  if (property.display.code === "error") {
    events.push({
      time: dateMills(lastLoop?.moment),
      value: `Error: ${lastLoop?.failureReason == null ? "" : String(lastLoop.failureReason)}`,
    });
    addRecommendedTempBasal();
  } else if (property.display.code === "enacted" || property.display.code === "looping") {
    addLastEnacted();
  } else {
    addRecommendedTempBasal();
  }

  let newestRadioTime = Number.NEGATIVE_INFINITY;
  let pumpRssi: unknown = "";
  let bleRssi: unknown = "";
  for (const status of deviceStatuses) {
    const radio = document(status.radioAdapter);
    if (radio === undefined) continue;
    const mills = dateMills(status.created_at);
    if (mills <= newestRadioTime) continue;
    newestRadioTime = mills;
    pumpRssi = radio.pumpRSSI ? radio.pumpRSSI : "";
    bleRssi = radio.RSSI ? radio.RSSI : "";
  }
  let rssi = bleRssi !== "" ? `BLE RSSI: ${String(bleRssi)} ` : "";
  if (pumpRssi !== "") rssi += `Pump RSSI: ${String(pumpRssi)}`;
  if (rssi !== "" && Number.isFinite(newestRadioTime)) {
    events.push({ time: newestRadioTime, value: rssi });
  }

  const info = events
    .sort((left, right) => right.time - left.time)
    .map((event) => ({
      label: `${inRetroMode ? "@ " : ""}${displayTime(event.time, now, inRetroMode)}`,
      value: event.value,
    }));

  const predicted = document(lastLoop?.predicted);
  const predictedValues = Array.isArray(predicted?.values) ? predicted.values : [];
  const eventual = predictedValues.length > 0
    ? ` ↝ ${String(roundedBg(Number(predictedValues[predictedValues.length - 1]), units))}`
    : "";
  const label = `${typeof lastLoop?.name === "string" ? lastLoop.name : "Loop"} ${property.display.symbol}`;
  const prefs = normalizedPreferences(preferences);
  const forecastPoints: RealtimeDocument[] = [];
  const start = dateMills(predicted?.startDate);
  if (Number.isFinite(start)) {
    predictedValues.forEach((value, index) => {
      forecastPoints.push({
        mgdl: value,
        color: "#ff00ff",
        mills: start + nightscoutTimes.mins(5 * index).msecs,
        noFade: true,
      });
    });
  }

  return {
    pill: {
      value: lastLoop === null
        ? null
        : `${displayTime(lastLoop.moment, now, inRetroMode)}${eventual}`,
      label,
      info,
      pillClass: levelToStatusClass(loopStatusLevel(property, now, prefs)),
    },
    forecastPoints,
    forecastInfo: forecastPoints.length > 0
      ? { type: "loop", label: "Loop Forecasts" }
      : null,
  };
}

export function loopStatusLevel(
  property: LoopProperty,
  now: number,
  preferences: LoopPreferences = {},
): number {
  const prefs = normalizedPreferences(preferences);
  const lastOk = dateMills(property.lastOkMoment);
  if (!Number.isFinite(lastOk)) return NONE;
  if (lastOk + nightscoutTimes.mins(prefs.urgent).msecs < now) return URGENT;
  if (lastOk + nightscoutTimes.mins(prefs.warn).msecs < now) return WARN;
  return NONE;
}

/** Pure request emitted by locked plugins/loop.checkNotifications(). */
export function loopNotification(
  property: LoopProperty,
  now: number,
  preferences: LoopPreferences = {},
): LoopNotification | null {
  const prefs = normalizedPreferences(preferences);
  if (!prefs.enableAlerts || property.lastLoop === null) return null;
  const level = loopStatusLevel(property, now, prefs);
  if (level < WARN) return null;
  return {
    level,
    title: "Loop isn't looping",
    message: `Last Loop: ${shortAgo(property.lastOkMoment, now)}`,
    pushoverSound: "echo",
    group: "Loop",
    plugin: LOOP_PLUGIN,
    debug: property,
  };
}

export function loopForecastAssistantResponse(
  property: LoopProperty | undefined,
  now: number,
  translate: LoopTranslator = translateEnglish,
): { title: string; response: string } {
  const title = translate("virtAsstTitleLoopForecast");
  const predicted = document(property?.lastLoop?.predicted);
  if (predicted === undefined || !Array.isArray(predicted.values)) {
    return { title, response: translate("virtAsstUnknown") };
  }
  const forecast = predicted.values.map(Number);
  const count = Math.min(6, forecast.length);
  const end = dateMills(predicted.startDate) + nightscoutTimes.mins(count * 5).msecs;
  if (end < now) return { title, response: translate("virtAsstForecastUnavailable") };
  let minimum = forecast[0]!;
  let maximum = forecast[0]!;
  for (const value of forecast.slice(0, count)) {
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
  }
  const relative = momentRelative(end, now);
  return {
    title,
    response: minimum === maximum
      ? translate("virtAsstLoopForecastAround", [maximum, relative])
      : translate("virtAsstLoopForecastBetween", [minimum, maximum, relative]),
  };
}

export function loopLastAssistantResponse(
  property: LoopProperty | undefined,
  now: number,
  translate: LoopTranslator = translateEnglish,
): { title: string; response: string } {
  const title = translate("virtAsstTitleLastLoop");
  return property?.lastLoop
    ? {
      title,
      response: translate("virtAsstLastLoop", [momentRelative(property.lastOkMoment, now)]),
    }
    : { title, response: translate("virtAsstUnknown") };
}
