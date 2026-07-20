import type { RealtimeDocument } from "../realtime/ddata-snapshot";
import { INFO, NONE, URGENT, WARN } from "../runtime/levels";
import { nightscoutTimes } from "../runtime/times";

export type AgeTranslator = (
  text: string,
  params?: readonly (number | string)[],
) => string;

export interface AgePreferences extends Record<string, unknown> {
  info?: unknown;
  warn?: unknown;
  urgent?: unknown;
  display?: unknown;
  enableAlerts?: unknown;
}

export interface AgeNotification extends RealtimeDocument {
  title: string;
  message: string;
  pushoverSound: "incoming" | "persistent";
  level: number;
  group: "CAGE" | "IAGE" | "SAGE";
}

export interface AgeVisualization extends RealtimeDocument {
  value: unknown;
  label: "CAGE" | "IAGE" | "SAGE";
  info: RealtimeDocument[];
  pillClass: "urgent" | "warn" | null;
}

const CANNULA_PLUGIN = {
  name: "cage",
  label: "Cannula Age",
  pluginType: "pill-minor",
} as const;

const INSULIN_PLUGIN = {
  name: "iage",
  label: "Insulin Age",
  pluginType: "pill-minor",
} as const;

const SENSOR_PLUGIN = {
  name: "sage",
  label: "Sensor Age",
  pluginType: "pill-minor",
} as const;

const translateEnglish: AgeTranslator = (text, params = []) => {
  let translated = text;
  params.forEach((value, index) => {
    translated = translated.replaceAll(`%${index + 1}`, String(value));
  });
  return translated;
};

function preference(value: unknown, fallback: unknown): unknown {
  return value ? value : fallback;
}

function eventMills(treatment: RealtimeDocument): number {
  return Number(treatment.mills);
}

function ageParts(now: number, treatmentDate: number): {
  age: number;
  days: number;
  hours: number;
  minFractions: number;
} {
  const elapsed = now - treatmentDate;
  const age = Math.floor(elapsed / nightscoutTimes.hour().msecs);
  const days = Math.floor(elapsed / nightscoutTimes.day().msecs);
  return {
    age,
    days,
    hours: age - days * 24,
    minFractions: Math.floor(elapsed / nightscoutTimes.min().msecs) - age * 60,
  };
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" || Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return true;
}

function statusClass(level: unknown): "urgent" | "warn" | null {
  if (level === URGENT) return "urgent";
  if (level === WARN) return "warn";
  return null;
}

function notificationRequest(
  property: RealtimeDocument,
  plugin: typeof CANNULA_PLUGIN | typeof INSULIN_PLUGIN | typeof SENSOR_PLUGIN,
): RealtimeDocument | null {
  const notification = property.notification;
  if (typeof notification !== "object" || notification === null || Array.isArray(notification)) {
    return null;
  }
  return {
    ...notification,
    plugin,
    debug: { age: property.age },
  };
}

/** Direct request-local port of locked plugins/cannulaage.findLatestTimeChange(). */
export function calculateCannulaAgeProperty(
  treatments: RealtimeDocument[],
  now: number,
  preferences: AgePreferences = {},
  translate: AgeTranslator = translateEnglish,
): RealtimeDocument {
  const prefs = {
    info: preference(preferences.info, 44),
    warn: preference(preferences.warn, 48),
    urgent: preference(preferences.urgent, 72),
    display: preference(preferences.display, "hours"),
    enableAlerts: preference(preferences.enableAlerts, false),
  };
  const result: RealtimeDocument = {
    found: false,
    age: 0,
    treatmentDate: null,
    checkForAlert: false,
  };
  let previousDate = 0;

  for (const treatment of treatments) {
    if (!String(treatment.eventType ?? "").includes("Site Change")) continue;
    const treatmentDate = eventMills(treatment);
    if (!(treatmentDate > previousDate && treatmentDate <= now)) continue;
    previousDate = treatmentDate;
    result.treatmentDate = treatmentDate;
    const parts = ageParts(now, treatmentDate);
    if (!result.found || (parts.age >= 0 && parts.age < Number(result.age))) {
      Object.assign(result, parts, {
        found: true,
        notes: treatment.notes,
      });
    }
  }

  result.level = NONE;
  let sound: AgeNotification["pushoverSound"] = "incoming";
  let message: string | undefined;
  let sendNotification = false;
  const age = Number(result.age);

  if (age >= Number(prefs.urgent)) {
    sendNotification = age === prefs.urgent;
    message = translate("Cannula change overdue!");
    sound = "persistent";
    result.level = URGENT;
  } else if (age >= Number(prefs.warn)) {
    sendNotification = age === prefs.warn;
    message = translate("Time to change cannula");
    result.level = WARN;
  } else if (age >= Number(prefs.info)) {
    sendNotification = age === prefs.info;
    message = "Change cannula soon";
    result.level = INFO;
  }

  if (prefs.display === "days" && result.found) {
    result.display = `${age >= 24 ? `${String(result.days)}d` : ""}${String(result.hours)}h`;
  } else {
    result.display = result.found ? `${age}h` : "n/a ";
  }

  if (
    prefs.enableAlerts && sendNotification &&
    Number(result.minFractions) <= 20
  ) {
    result.notification = {
      title: translate("Cannula age %1 hours", [age]),
      message: message as string,
      pushoverSound: sound,
      level: Number(result.level),
      group: "CAGE",
    } satisfies AgeNotification;
  }
  return result;
}

export function cannulaAgeNotification(property: RealtimeDocument): RealtimeDocument | null {
  return notificationRequest(property, CANNULA_PLUGIN);
}

export function cannulaAgeVisualization(
  property: RealtimeDocument,
  translate: AgeTranslator = translateEnglish,
): AgeVisualization {
  const info: RealtimeDocument[] = [{
    label: translate("Inserted"),
    value: new Date(Number(property.treatmentDate)).toLocaleString(),
  }];
  if (!isEmpty(property.notes)) {
    info.push({ label: `${translate("Notes")}:`, value: property.notes });
  }
  return {
    value: property.display,
    label: "CAGE",
    info,
    pillClass: statusClass(property.level),
  };
}

/** Direct request-local port of locked plugins/insulinage.findLatestTimeChange(). */
export function calculateInsulinAgeProperty(
  treatments: RealtimeDocument[],
  now: number,
  preferences: AgePreferences = {},
  translate: AgeTranslator = translateEnglish,
): RealtimeDocument {
  const result: RealtimeDocument = {
    found: false,
    age: 0,
    treatmentDate: null,
  };
  let previousDate = 0;
  for (const treatment of treatments) {
    if (!String(treatment.eventType ?? "").includes("Insulin Change")) continue;
    const treatmentDate = eventMills(treatment);
    if (!(treatmentDate > previousDate && treatmentDate <= now)) continue;
    previousDate = treatmentDate;
    result.treatmentDate = treatmentDate;
    const parts = ageParts(now, treatmentDate);
    if (!result.found || (parts.age >= 0 && parts.age < Number(result.age))) {
      Object.assign(result, parts, {
        found: true,
        notes: treatment.notes,
        display: `${parts.age >= 24 ? `${parts.days}d` : ""}${parts.hours}h`,
      });
    }
  }

  const prefs = {
    info: preference(preferences.info, 44),
    warn: preference(preferences.warn, 48),
    urgent: preference(preferences.urgent, 72),
    enableAlerts: preference(preferences.enableAlerts, false),
  };
  result.level = NONE;
  let sound: AgeNotification["pushoverSound"] = "incoming";
  let message: string | undefined;
  let sendNotification = false;
  const age = Number(result.age);

  // Preserve v15.0.7 exactly: the urgent comparison reads the calculated
  // object rather than prefs.urgent, so its undefined value never matches.
  if (age >= Number(result.urgent)) {
    sendNotification = age === prefs.urgent;
    message = translate("Insulin reservoir change overdue!");
    sound = "persistent";
    result.level = URGENT;
  } else if (age >= Number(prefs.warn)) {
    sendNotification = age === prefs.warn;
    message = translate("Time to change insulin reservoir");
    result.level = WARN;
  } else if (age >= Number(prefs.info)) {
    sendNotification = age === prefs.info;
    message = translate("Change insulin reservoir soon");
    result.level = INFO;
  }

  if (
    prefs.enableAlerts && sendNotification &&
    Number(result.minFractions) <= 20
  ) {
    result.notification = {
      title: translate("Insulin reservoir age %1 hours", [age]),
      message: message as string,
      pushoverSound: sound,
      level: Number(result.level),
      group: "IAGE",
    } satisfies AgeNotification;
  }
  return result;
}

export function insulinAgeNotification(property: RealtimeDocument): RealtimeDocument | null {
  return notificationRequest(property, INSULIN_PLUGIN);
}

export function insulinAgeVisualization(
  property: RealtimeDocument,
  translate: AgeTranslator = translateEnglish,
): AgeVisualization {
  const info: RealtimeDocument[] = [{
    label: translate("Changed"),
    value: new Date(Number(property.treatmentDate)).toLocaleString(),
  }];
  if (!isEmpty(property.notes)) {
    info.push({ label: translate("Notes:"), value: property.notes });
  }
  return {
    value: property.display,
    label: "IAGE",
    info,
    pillClass: statusClass(property.level),
  };
}

type SensorEvent = "Sensor Start" | "Sensor Change";

function sensorEventInfo(value: unknown): RealtimeDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RealtimeDocument
    : { found: false };
}

/** Direct request-local port of locked plugins/sensorage.findLatestTimeChange(). */
export function calculateSensorAgeProperty(
  treatments: RealtimeDocument[],
  now: number,
  preferences: AgePreferences = {},
  translate: AgeTranslator = translateEnglish,
): RealtimeDocument {
  const result: RealtimeDocument = {
    "Sensor Start": { found: false },
    "Sensor Change": { found: false },
  };
  const previousDate: Record<SensorEvent, number> = {
    "Sensor Start": 0,
    "Sensor Change": 0,
  };

  for (const treatment of treatments) {
    for (const event of ["Sensor Start", "Sensor Change"] as const) {
      const treatmentDate = eventMills(treatment);
      if (
        treatment.eventType !== event ||
        !(treatmentDate > previousDate[event] && treatmentDate <= now)
      ) continue;
      previousDate[event] = treatmentDate;
      const parts = ageParts(now, treatmentDate);
      const eventValue = sensorEventInfo(result[event]);
      if (!eventValue.found || (parts.age >= 0 && parts.age < Number(eventValue.age))) {
        let displayLong = "";
        if (parts.age >= 24) displayLong += `${parts.days} ${translate("days")}`;
        if (displayLong.length > 0) displayLong += " ";
        displayLong += `${parts.hours} ${translate("hours")}`;
        Object.assign(eventValue, parts, {
          found: true,
          treatmentDate,
          notes: treatment.notes,
          display: `${parts.age >= 24 ? `${parts.days}d` : ""}${parts.hours}h`,
          displayLong,
        });
        result[event] = eventValue;
      }
    }
  }

  const start = sensorEventInfo(result["Sensor Start"]);
  const change = sensorEventInfo(result["Sensor Change"]);
  if (
    change.found && start.found &&
    Number(change.treatmentDate) >= Number(start.treatmentDate)
  ) start.found = false;

  const found = (["Sensor Start", "Sensor Change"] as const)
    .filter((event) => sensorEventInfo(result[event]).found)
    .sort((left, right) =>
      Number(sensorEventInfo(result[left]).treatmentDate) -
      Number(sensorEventInfo(result[right]).treatmentDate)
    );
  const selected: SensorEvent = found.at(-1) ?? "Sensor Start";
  result.min = selected;
  const sensor = sensorEventInfo(result[selected]);
  const prefs = {
    info: preference(preferences.info, nightscoutTimes.days(6).hours),
    warn: preference(preferences.warn, Number(nightscoutTimes.days(7).hours) - 4),
    urgent: preference(preferences.urgent, Number(nightscoutTimes.days(7).hours) - 2),
    enableAlerts: preference(preferences.enableAlerts, false),
  };
  sensor.level = NONE;
  let sound: AgeNotification["pushoverSound"] = "incoming";
  let message: string | undefined;
  let sendNotification = false;
  const age = Number(sensor.age);

  if (age >= Number(prefs.urgent)) {
    sendNotification = age === prefs.urgent;
    message = translate("Sensor change/restart overdue!");
    sound = "persistent";
    sensor.level = URGENT;
  } else if (age >= Number(prefs.warn)) {
    sendNotification = age === prefs.warn;
    message = translate("Time to change/restart sensor");
    sensor.level = WARN;
  } else if (age >= Number(prefs.info)) {
    sendNotification = age === prefs.info;
    message = translate("Change/restart sensor soon");
    sensor.level = INFO;
  }

  if (
    prefs.enableAlerts && sendNotification &&
    Number(sensor.minFractions) <= 20
  ) {
    sensor.notification = {
      title: translate("Sensor age %1 days %2 hours", [
        Number(sensor.days),
        Number(sensor.hours),
      ]),
      message: message as string,
      pushoverSound: sound,
      level: Number(sensor.level),
      group: "SAGE",
    } satisfies AgeNotification;
  }
  return result;
}

export function sensorAgeNotification(property: RealtimeDocument): RealtimeDocument | null {
  const selected = property.min === "Sensor Change" ? "Sensor Change" : "Sensor Start";
  return notificationRequest(sensorEventInfo(property[selected]), SENSOR_PLUGIN);
}

export function sensorAgeVisualization(
  property: RealtimeDocument,
  translate: AgeTranslator = translateEnglish,
): AgeVisualization {
  const selected = property.min === "Sensor Change" ? "Sensor Change" : "Sensor Start";
  const sensor = sensorEventInfo(property[selected]);
  const info: RealtimeDocument[] = [];
  for (const event of ["Sensor Change", "Sensor Start"] as const) {
    const value = sensorEventInfo(property[event]);
    if (!value.found) continue;
    const label = event === "Sensor Change" ? "Sensor Insert" : event;
    info.push({
      label: translate(label),
      value: new Date(Number(value.treatmentDate)).toLocaleString(),
    });
    info.push({ label: translate("Duration"), value: value.displayLong });
    if (!isEmpty(value.notes)) info.push({ label: translate("Notes"), value: value.notes });
    if (!isEmpty(value.transmitterId)) {
      info.push({ label: translate("Transmitter ID"), value: value.transmitterId });
    }
    if (!isEmpty(value.sensorCode)) {
      info.push({ label: translate("Sensor Code"), value: value.sensorCode });
    }
  }
  return {
    value: sensor.display,
    label: "SAGE",
    info,
    pillClass: statusClass(sensor.level),
  };
}
