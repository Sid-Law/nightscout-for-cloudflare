import {
  INFO,
  levelToDisplay,
  levelToStatusClass,
  URGENT,
  WARN,
} from "../runtime/levels";

export interface DatabaseSizeStats extends Record<string, unknown> {
  dataSize?: unknown;
  indexSize?: unknown;
}

export interface DatabaseSizePreferences extends Record<string, unknown> {
  warnPercentage?: unknown;
  urgentPercentage?: unknown;
  max?: unknown;
  enableAlerts?: unknown;
  inMib?: unknown;
}

export interface DatabaseSizeProperty extends Record<string, unknown> {
  display: string;
  status: "current" | "warn" | "urgent";
  totalDataSize: number;
  dataPercentage: number;
  notificationLevel: number;
  details: {
    maxSize: number;
    dataSize: number;
  };
}

export interface DatabaseSizeNotification extends Record<string, unknown> {
  level: number;
  title: string;
  message: string;
  pushoverSound: "echo";
  group: "Database Size";
  plugin: { name: "dbsize" };
  debug: DatabaseSizeProperty;
}

export const DATABASE_SIZE_INTENTS = [{
  intent: "MetricNow",
  metrics: ["db size"],
}] as const;

function preference(value: unknown, fallback: number): unknown {
  return value ? value : fallback;
}

function finiteSize(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

/** Direct stateless port of locked plugins/dbsize.analyzeData(). */
export function calculateDatabaseSizeProperty(
  stats: DatabaseSizeStats | undefined,
  preferences: DatabaseSizePreferences = {},
): DatabaseSizeProperty {
  const warnPercentage = preference(preferences.warnPercentage, 60);
  const urgentPercentage = preference(preferences.urgentPercentage, 75);
  const configuredMax = preference(preferences.max, 496);
  const numericMax = Number(configuredMax);
  const maxSize = numericMax > 0 ? numericMax : 100 * 1024;

  const totalBytes = finiteSize(stats?.dataSize) + finiteSize(stats?.indexSize);
  const totalDataSize = totalBytes / (1024 * 1024);
  const dataPercentage = Math.floor((totalDataSize * 100) / maxSize);
  const boundWarnPercentage = Math.max(
    0,
    Math.min(100, Number.parseInt(String(warnPercentage))),
  );
  const boundUrgentPercentage = Math.max(
    0,
    Math.min(100, Number.parseInt(String(urgentPercentage))),
  );
  const warnSize = Math.floor((boundWarnPercentage / 100) * maxSize);
  const urgentSize = Math.floor((boundUrgentPercentage / 100) * maxSize);

  let notificationLevel = INFO;
  if (totalDataSize >= urgentSize && boundUrgentPercentage > 0) {
    notificationLevel = URGENT;
  } else if (totalDataSize >= warnSize && boundWarnPercentage > 0) {
    notificationLevel = WARN;
  }

  return {
    display: preferences.inMib
      ? `${Number.parseFloat(totalDataSize.toFixed(0))}MiB`
      : `${dataPercentage}%`,
    status: levelToStatusClass(notificationLevel),
    totalDataSize,
    dataPercentage,
    notificationLevel,
    details: {
      maxSize: Number.parseFloat(maxSize.toFixed(2)),
      dataSize: Number.parseFloat(totalDataSize.toFixed(2)),
    },
  };
}

/** Locked dbsize.checkNotifications() request payload, kept side-effect free. */
export function databaseSizeNotification(
  property: DatabaseSizeProperty,
  preferences: DatabaseSizePreferences = {},
): DatabaseSizeNotification | null {
  if (!preferences.enableAlerts) return null;
  if (
    !property.dataPercentage
    || !property.notificationLevel
    || property.notificationLevel < WARN
  ) {
    return null;
  }
  return {
    level: property.notificationLevel,
    title: `${levelToDisplay(property.notificationLevel)} Database Size near its limits!`,
    message: `Database size is ${property.details.dataSize} MiB out of ${property.details.maxSize} MiB. Please backup and clean up database!`,
    pushoverSound: "echo",
    group: "Database Size",
    plugin: { name: "dbsize" },
    debug: property,
  };
}

/** Locked updateVisualisation() pill payload. */
export function databaseSizeVisualization(
  property: DatabaseSizeProperty,
): Record<string, unknown> {
  return {
    value: property.display,
    labelClass: "plugicon-database",
    pillClass: property.status,
    info: [{
      label: "Data size",
      value: `${property.details.dataSize} MiB of ${property.details.maxSize} MiB (${property.dataPercentage}%)`,
    }],
    hide: !(property.totalDataSize && property.totalDataSize >= 0),
  };
}

export function databaseSizeAssistantResponse(
  property: DatabaseSizeProperty | undefined,
): { title: string; response: string } {
  return {
    title: "Database file size",
    response: property?.display
      ? `${property.details.dataSize} MiB. That is ${property.dataPercentage}% of available database space.`
      : "That value is unknown at the moment. Please see your Nightscout site for more details.",
  };
}
