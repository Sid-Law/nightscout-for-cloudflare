import type { RealtimeDocument } from "../realtime/ddata-snapshot";
import { INFO, NONE, URGENT, WARN } from "../runtime/levels";
import { nightscoutTimes } from "../runtime/times";

export const XDRIPJS_PLUGIN = {
  name: "xdripjs",
  label: "CGM Status",
  pluginType: "pill-status",
} as const;

export interface XdripJsPreferences extends Record<string, unknown> {
  enableAlerts?: unknown;
  warnBatV?: unknown;
  stateNotifyIntrvl?: unknown;
}

export interface XdripJsStateNotification extends Record<string, unknown> {
  state: unknown;
  timestamp: number;
}

export interface XdripJsEvaluation {
  property: RealtimeDocument;
  notification: RealtimeDocument | null;
  stateNotification: XdripJsStateNotification | null;
  stateNotificationChanged: boolean;
  nextStateDueAt: number | null;
  repeatsAtHeartbeat: boolean;
}

export interface XdripJsVisualization extends RealtimeDocument {
  value: unknown;
  label: "CGM";
  info: RealtimeDocument[];
  pillClass: "urgent" | "warn" | null;
}

const XDRIPJS_WINDOW_MS = nightscoutTimes.hours(24).msecs;

function preference(value: unknown, fallback: unknown): unknown {
  return value ? value : fallback;
}

function timestampMills(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoTimestamp(value: unknown): string | null {
  const mills = timestampMills(value);
  return mills === null ? null : new Date(mills).toISOString();
}

function deviceName(device: unknown): string {
  if (!device) return "unknown";
  const finalSegment = String(device).split("://").at(-1) ?? "unknown";
  return finalSegment.split("/")[0] ?? "unknown";
}

function xdripRecord(status: RealtimeDocument): RealtimeDocument | null {
  const value = status.xdripjs;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RealtimeDocument
    : null;
}

function upstreamLooseEqual(left: unknown, right: unknown): boolean {
  // Locked xdripjs uses ==/!= for wire values that can arrive as strings.
  // eslint-disable-next-line eqeqeq
  return left == right;
}

function roundedOrNull(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : null;
}

function notificationIntervalHours(preferences: XdripJsPreferences): number {
  return Number(preference(preferences.stateNotifyIntrvl, 0.5));
}

function stateNotificationReady(
  previous: XdripJsStateNotification | null,
  state: unknown,
  now: number,
  intervalHours: number,
): boolean {
  if (previous === null || !upstreamLooseEqual(previous.state, state)) return true;
  if (!intervalHours) return true;
  const elapsedWholeMinutes = Math.floor((now - previous.timestamp) / 60_000);
  return elapsedWholeMinutes > intervalHours * 60;
}

function nextStateNotificationAt(
  stateNotification: XdripJsStateNotification | null,
  intervalHours: number,
  now: number,
): number | null {
  if (stateNotification === null || !Number.isFinite(intervalHours)) return null;
  if (!intervalHours) return now;
  const delayMinutes = Math.floor(intervalHours * 60) + 1;
  return Math.max(now, Math.trunc(stateNotification.timestamp + delayMinutes * 60_000));
}

function emptySensorState(): RealtimeDocument {
  return {
    seenDevices: Object.create(null) as Record<string, unknown>,
    latest: null,
    lastDevice: null,
    lastState: null,
    lastStateString: null,
    lastStateStringShort: null,
    lastSessionStart: null,
    lastStateTime: null,
    lastTxId: null,
    lastTxStatus: null,
    lastTxStatusString: null,
    lastTxStatusStringShort: null,
    lastTxActivation: null,
    lastMode: null,
    lastRssi: null,
    lastUnfiltered: null,
    lastFiltered: null,
    lastNoise: null,
    lastNoiseString: null,
    lastSlope: null,
    lastIntercept: null,
    lastCalType: null,
    lastCalibrationDate: null,
    lastBatteryTimestamp: null,
    lastVoltageA: null,
    lastVoltageB: null,
    lastTemperature: null,
    lastResistance: null,
  };
}

/**
 * Request-local port of locked plugins/xdripjs.getStateString(). The caller
 * supplies the prior process-local state marker so Workers can persist it in
 * the tenant Durable Object rather than relying on isolate lifetime.
 */
export function calculateXdripJsEvaluation(
  devicestatus: RealtimeDocument[],
  now: number,
  preferences: XdripJsPreferences = {},
  previousStateNotification: XdripJsStateNotification | null = null,
): XdripJsEvaluation {
  const property = emptySensorState();
  const seenDevices = property.seenDevices as Record<string, unknown>;
  const recent = devicestatus
    .filter((status) =>
      Object.prototype.hasOwnProperty.call(status, "xdripjs")
      && Number(status.mills) <= now
      && Number(status.mills) >= now - XDRIPJS_WINDOW_MS
    )
    .sort((left, right) => {
      const leftAt = timestampMills(xdripRecord(left)?.timestamp);
      const rightAt = timestampMills(xdripRecord(right)?.timestamp);
      if (leftAt === null && rightAt === null) return 0;
      if (leftAt === null) return 1;
      if (rightAt === null) return -1;
      return leftAt - rightAt;
    });

  let latest: RealtimeDocument | null = null;
  let latestTimestamp: number | null = null;
  for (const status of recent) {
    const uri = status.device || "device";
    const key = String(uri);
    if (!Object.prototype.hasOwnProperty.call(seenDevices, key)) {
      seenDevices[key] = { name: deviceName(uri), uri };
    }
    const xdripjs = xdripRecord(status);
    if (xdripjs === null) continue;
    const candidateTimestamp = timestampMills(xdripjs.timestamp);
    if (latest === null || (candidateTimestamp !== null
      && (latestTimestamp === null || candidateTimestamp > latestTimestamp))) {
      latest = status;
      latestTimestamp = candidateTimestamp;
    }
  }

  property.level = NONE;
  let nextState = previousStateNotification;
  let stateChanged = false;
  let sendNotification = false;
  let message: string | undefined;
  let title: string | undefined;
  let batteryAlert = false;
  const enableAlerts = preference(preferences.enableAlerts, false);
  const warnBatV = Number(preference(preferences.warnBatV, 300));
  const intervalHours = notificationIntervalHours(preferences);
  const sensor = latest === null ? null : xdripRecord(latest);

  if (latest !== null && sensor !== null) {
    const state = sensor.state;
    if (!upstreamLooseEqual(state, 0x6)) {
      if (stateNotificationReady(previousStateNotification, state, now, intervalHours)) {
        sendNotification = true;
        nextState = { timestamp: now, state };
        stateChanged = true;
      }
      message = `CGM Transmitter state: ${String(sensor.stateString)}`;
      title = message;
      property.level = upstreamLooseEqual(state, 0x7) ? INFO : WARN;
    }

    if (sensor.voltagea && Number(sensor.voltagea) < warnBatV) {
      sendNotification = true;
      batteryAlert = true;
      message = `CGM Transmitter Battery A Low Voltage: ${String(sensor.voltagea)}`;
      title = "CGM Transmitter Battery Low";
      property.level = WARN;
    }
    if (sensor.voltageb && Number(sensor.voltageb) < warnBatV - 10) {
      sendNotification = true;
      batteryAlert = true;
      message = `CGM Transmitter Battery B Low Voltage: ${String(sensor.voltageb)}`;
      title = "CGM Transmitter Battery Low";
      property.level = WARN;
    }

    if (enableAlerts && sendNotification) {
      property.notification = {
        title,
        message,
        pushoverSound: "incoming",
        level: property.level,
        group: "xDrip-js",
      };
    }

    property.latest = latest;
    property.lastState = sensor.state;
    property.lastStateString = sensor.stateString;
    property.lastStateStringShort = sensor.stateStringShort;
    property.lastSessionStart = sensor.sessionStart;
    property.lastStateTime = isoTimestamp(sensor.timestamp);
    property.lastTxId = sensor.txId;
    property.lastTxStatus = sensor.txStatus;
    property.lastTxStatusString = sensor.txStatusString;
    property.lastTxStatusStringShort = sensor.txStatusStringShort;
    property.lastTxActivation = sensor.txActivation;
    property.lastMode = sensor.mode;
    property.lastRssi = sensor.rssi;
    property.lastUnfiltered = sensor.unfiltered;
    property.lastFiltered = sensor.filtered;
    property.lastNoise = sensor.noise;
    property.lastNoiseString = sensor.noiseString;
    property.lastSlope = roundedOrNull(sensor.slope);
    property.lastIntercept = roundedOrNull(sensor.intercept);
    property.lastCalType = sensor.calType;
    property.lastCalibrationDate = sensor.lastCalibrationDate;
    property.lastBatteryTimestamp = sensor.batteryTimestamp;
    property.lastVoltageA = sensor.voltagea;
    property.lastVoltageB = sensor.voltageb;
    property.lastTemperature = sensor.temperature;
    property.lastResistance = sensor.resistance;
  }

  const rawNotification = property.notification;
  const notification = typeof rawNotification === "object"
      && rawNotification !== null
      && !Array.isArray(rawNotification)
    ? {
      ...rawNotification as RealtimeDocument,
      plugin: XDRIPJS_PLUGIN,
      debug: { stateString: property.lastStateString },
    }
    : null;
  const abnormalState = sensor !== null && !upstreamLooseEqual(sensor.state, 0x6);
  return {
    property,
    notification,
    stateNotification: nextState,
    stateNotificationChanged: stateChanged,
    nextStateDueAt: abnormalState
      ? nextStateNotificationAt(nextState, intervalHours, now)
      : null,
    repeatsAtHeartbeat: Boolean(enableAlerts && batteryAlert),
  };
}

/** Direct setProperties-compatible projection. */
export function calculateXdripJsProperty(
  devicestatus: RealtimeDocument[],
  now: number,
  preferences: XdripJsPreferences = {},
): RealtimeDocument {
  return calculateXdripJsEvaluation(devicestatus, now, preferences).property;
}

/** Direct updateVisualisation-compatible data, rendered by the official client. */
export function xdripJsVisualization(
  property: RealtimeDocument,
  now: number,
): XdripJsVisualization {
  const info: RealtimeDocument[] = [];
  const seen = property.seenDevices;
  if (typeof seen === "object" && seen !== null && !Array.isArray(seen)) {
    for (const device of Object.values(seen)) {
      if (typeof device === "object" && device !== null && !Array.isArray(device)) {
        info.push({ label: "Seen: ", value: (device as RealtimeDocument).name });
      }
    }
  }
  const stateAt = timestampMills(property.lastStateTime);
  info.push({
    label: "State Time: ",
    value: stateAt === null ? "Unknown" : `${Math.floor((now - stateAt) / 60_000)} minutes ago`,
  });
  info.push({ label: "Mode: ", value: property.lastMode || "Unknown" });
  info.push({ label: "Status: ", value: property.lastStateString || "Unknown" });
  const sessionStart = timestampMills(property.lastSessionStart);
  if (sessionStart !== null && !upstreamLooseEqual(property.lastState, 0x1)) {
    const elapsed = Math.max(0, now - sessionStart);
    const days = Math.floor(elapsed / nightscoutTimes.day().msecs);
    const hours = Math.floor(elapsed / nightscoutTimes.hour().msecs) - days * 24;
    info.push({ label: "Session Age: ", value: `${days} days ${hours} hours` });
  }
  info.push({ label: "Tx ID: ", value: property.lastTxId || "Unknown" });
  info.push({ label: "Tx Status: ", value: property.lastTxStatusString || "Unknown" });

  const txActivation = timestampMills(property.lastTxActivation);
  if (txActivation !== null) {
    info.push({
      label: "Tx Age: ",
      value: `${Math.floor((now - txActivation) / nightscoutTimes.day().msecs)} days`,
    });
  }

  const optional: Array<[unknown, string, unknown]> = [
    [property.lastRssi, "RSSI: ", property.lastRssi],
    [property.lastUnfiltered, "Unfiltered: ", property.lastUnfiltered],
    [property.lastFiltered, "Filtered: ", property.lastFiltered],
    [property.lastNoiseString, "Noise: ", property.lastNoiseString],
    [property.lastSlope, "Slope: ", property.lastSlope],
    [property.lastIntercept, "Intercept: ", property.lastIntercept],
    [property.lastCalType, "CalType: ", property.lastCalType],
  ];
  for (const [gate, label, value] of optional) {
    if (gate) info.push({ label, value });
  }
  const calibrationAt = timestampMills(property.lastCalibrationDate);
  if (calibrationAt !== null) {
    info.push({
      label: "Calibration: ",
      value: `${Math.floor((now - calibrationAt) / nightscoutTimes.hour().msecs)} hours ago`,
    });
  }
  const batteryAt = timestampMills(property.lastBatteryTimestamp);
  if (batteryAt !== null) {
    info.push({
      label: "Battery: ",
      value: `${Math.floor((now - batteryAt) / nightscoutTimes.min().msecs)} minutes ago`,
    });
  }
  for (const [gate, label, value] of [
    [property.lastVoltageA, "VoltageA: ", property.lastVoltageA],
    [property.lastVoltageB, "VoltageB: ", property.lastVoltageB],
    [property.lastTemperature, "Temperature: ", property.lastTemperature],
    [property.lastResistance, "Resistance: ", property.lastResistance],
  ] as Array<[unknown, string, unknown]>) {
    if (gate) info.push({ label, value });
  }
  const level = Number(property.level);
  return {
    value: property.lastStateStringShort || property.lastStateString || "Unknown",
    label: "CGM",
    info,
    pillClass: level === URGENT ? "urgent" : level === WARN || level === INFO ? "warn" : null,
  };
}
