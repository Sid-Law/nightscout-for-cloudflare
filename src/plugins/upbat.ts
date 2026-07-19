import type { RealtimeDocument } from "../realtime/ddata-snapshot";
import {
  levelToStatusClass,
  URGENT,
  WARN,
} from "../runtime/levels";
import { nightscoutTimes } from "../runtime/times";

export interface UploaderBatteryPreferences {
  warn?: unknown;
  urgent?: unknown;
  enableAlerts?: unknown;
}

export const UPLOADER_BATTERY_INTENTS = [
  { intent: "UploaderBattery" },
  { intent: "MetricNow", metrics: ["uploader battery"] },
] as const;

interface UploaderDevice extends RealtimeDocument {
  name: string;
  uri: string;
  statuses: RealtimeDocument[];
  min?: RealtimeDocument;
}

function cloneDocument(document: RealtimeDocument): RealtimeDocument {
  return JSON.parse(JSON.stringify(document)) as RealtimeDocument;
}

function entryMills(entry: RealtimeDocument | undefined): number {
  return Number(entry?.mills);
}

function batteryValue(status: RealtimeDocument): unknown {
  return (status.uploader as RealtimeDocument).battery;
}

function minimumByBattery(statuses: RealtimeDocument[]): RealtimeDocument | undefined {
  let minimum: RealtimeDocument | undefined;
  for (const status of statuses) {
    if (minimum === undefined || Number(batteryValue(status)) < Number(batteryValue(minimum))) {
      minimum = status;
    }
  }
  return minimum;
}

function analyzeUploaderStatus(
  status: RealtimeDocument,
  warn: unknown,
  urgent: unknown,
): void {
  const uploader = status.uploader as RealtimeDocument;
  const battery = uploader.battery;
  let voltage = uploader.batteryVoltage;
  const charging = status.isCharging ? status.isCharging : false;
  let voltageDisplay: string | undefined;

  if (voltage) {
    let numericVoltage = Number(voltage);
    if (numericVoltage > 1_000) numericVoltage /= 1_000;
    voltage = numericVoltage;
    voltageDisplay = `${numericVoltage.toFixed(3)}v`;
  }

  if (battery || voltage) {
    uploader.value = battery || voltage;
    if (battery) uploader.battery = battery;
    if (voltage) {
      uploader.voltage = voltage;
      uploader.voltageDisplay = voltageDisplay;
    }
    uploader.display = `${battery ? `${String(battery)}%` : voltageDisplay}${charging ? "⚡" : ""}`;

    const numericBattery = Number(battery);
    if (numericBattery >= 95) uploader.level = 100;
    else if (numericBattery < 95 && numericBattery >= 55) uploader.level = 75;
    else if (numericBattery < 55 && numericBattery >= 30) uploader.level = 50;
    else uploader.level = 25;

    if (numericBattery <= Number(warn) && numericBattery > Number(urgent)) {
      uploader.notification = WARN;
    } else if (numericBattery <= Number(urgent)) {
      uploader.notification = URGENT;
    }
  }
}

/** Direct stateless port of locked plugins/upbat.analyzeData(). */
export function calculateUploaderBatteryProperty(
  input: RealtimeDocument[],
  now: number,
  preferences: UploaderBatteryPreferences = {},
): RealtimeDocument {
  const warn = preferences.warn ? preferences.warn : 30;
  const urgent = preferences.urgent ? preferences.urgent : 20;
  const recentMills = now - nightscoutTimes.mins(30).msecs;
  const recent = input
    .filter((status) =>
      Object.prototype.hasOwnProperty.call(status, "uploader") &&
      entryMills(status) <= now && entryMills(status) >= recentMills
    )
    .map(cloneDocument);

  const devices: Record<string, UploaderDevice> = {};
  const result: RealtimeDocument = {
    level: undefined,
    display: "?%",
    status: undefined,
    devices,
  };

  for (const status of recent) {
    analyzeUploaderStatus(status, warn, urgent);
    const uri = typeof status.device === "string" && status.device.length > 0
      ? status.device
      : "uploader";
    let device = devices[uri];
    if (device === undefined) {
      device = {
        name: uri.startsWith("openaps://") ? uri.slice("openaps://".length) : uri,
        uri,
        statuses: [],
      };
      devices[uri] = device;
    }
    const selected: RealtimeDocument = { uploader: status.uploader };
    for (const field of ["created_at", "mills", "_id"] as const) {
      if (status[field] !== undefined) selected[field] = status[field];
    }
    device.statuses.push(selected);
  }

  const recentLowests: RealtimeDocument[] = [];
  for (const device of Object.values(devices)) {
    device.statuses.sort((left, right) => entryMills(right) - entryMills(left));
    const first = device.statuses[0];
    const recentThreshold = entryMills(first) - nightscoutTimes.mins(10).msecs;
    const recentLowest = minimumByBattery(
      device.statuses.filter((status) => entryMills(status) > recentThreshold),
    );
    if (recentLowest === undefined) continue;
    device.min = recentLowest.uploader as RealtimeDocument;
    recentLowests.push(recentLowest);
  }

  const minimum = minimumByBattery(recentLowests);
  if (minimum?.uploader) {
    const uploader = minimum.uploader as RealtimeDocument;
    result.level = uploader.level;
    result.display = uploader.display;
    result.status = levelToStatusClass(uploader.notification);
    result.min = uploader;
  }
  return result;
}

/** Locked updateVisualisation payload, kept pure for official client contracts. */
export function uploaderBatteryVisualization(property: RealtimeDocument): RealtimeDocument {
  const devices = property.devices as Record<string, UploaderDevice>;
  let info: RealtimeDocument[] | null = null;
  const values = Object.values(devices);
  if (values.length > 1) {
    info = values.map((device) => {
      const value = device.min as RealtimeDocument;
      let display = String(value.display);
      if (value.battery && value.voltageDisplay) display += ` (${String(value.voltageDisplay)})`;
      if (value.temperature) display += ` ${String(value.temperature)}`;
      return { label: device.name, value: display };
    });
  } else {
    const minimum = property.min as RealtimeDocument | undefined;
    if (minimum?.battery && minimum.voltageDisplay) {
      info = [{ label: "Voltage", value: minimum.voltageDisplay }];
    }
    if (minimum?.temperature) {
      if (info === null) info = [];
      info.push({ label: "Temp", value: minimum.temperature });
    }
  }

  const minimum = property.min as RealtimeDocument | undefined;
  return {
    value: property.display,
    labelClass: property.level ? `icon-battery-${String(property.level)}` : undefined,
    pillClass: property.status,
    info,
    hide: !(minimum?.value && Number(minimum.value) >= 0),
  };
}

export function uploaderBatteryAssistantResponse(property: RealtimeDocument | undefined): {
  title: string;
  response: string;
} {
  const display = property?.display;
  return {
    title: "Uploader Battery",
    response: display
      ? `Your uploader battery is at ${String(display)}`
      : "That value is unknown at the moment. Please see your Nightscout site for more details.",
  };
}
