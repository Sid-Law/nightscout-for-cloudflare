const DEFAULT_FEATURES = [
  "bgnow",
  "delta",
  "direction",
  "timeago",
  "devicestatus",
  "upbat",
  "errorcodes",
  "profile",
  "bolus",
  "dbsize",
  "runtimestate",
  "basal",
  "careportal",
] as const;

const DEFAULT_THRESHOLDS = {
  bgHigh: 260,
  bgTargetTop: 180,
  bgTargetBottom: 80,
  bgLow: 55,
};
const MMOL_TO_MGDL = 18.01559;
const MAX_AUTH_FAIL_DELAY_MS = 60_000;

export type NightscoutDisplayUnits = "mg/dl" | "mmol";

export interface NightscoutStatusEnvironment {
  DISPLAY_UNITS?: string;
  AUTH_FAIL_DELAY?: string;
  BG_HIGH?: string;
  BG_TARGET_TOP?: string;
  BG_TARGET_BOTTOM?: string;
  BG_LOW?: string;
}

export interface NightscoutStatusSettingsOverrides {
  units?: NightscoutDisplayUnits;
  authFailDelay?: number;
  thresholds?: {
    bgHigh: number;
    bgTargetTop: number;
    bgTargetBottom: number;
    bgLow: number;
  };
  simpleAlarms?: boolean;
}

/**
 * Normalize only the unit spellings used by locked profile records. Profile
 * data is persisted user input, so substring guesses such as `notmmol` must
 * not alter the server-wide unit contract.
 */
export function normalizeProfileUnits(value: unknown): NightscoutDisplayUnits | null {
  if (typeof value !== "string") return null;
  const compact = value.trim().toLowerCase().replaceAll(" ", "");
  if (compact === "mmol" || compact === "mmol/l") return "mmol";
  if (compact === "mg/dl" || compact === "mgdl") return "mg/dl";
  return null;
}

/** Locked v15.0.7 lib/server/env.js DISPLAY_UNITS normalization. */
export function normalizeConfiguredDisplayUnits(value: string): NightscoutDisplayUnits {
  return value.toLowerCase().includes("mmol") ? "mmol" : "mg/dl";
}

function profileDisplayUnits(profile: unknown): NightscoutDisplayUnits | null {
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) return null;
  const record = profile as Record<string, unknown>;
  const recordUnits = normalizeProfileUnits(record.units);
  if (recordUnits !== null) return recordUnits;

  const defaultProfile = record.defaultProfile;
  const store = record.store;
  if (
    typeof defaultProfile !== "string"
    || typeof store !== "object"
    || store === null
    || Array.isArray(store)
  ) {
    return null;
  }
  const selected = (store as Record<string, unknown>)[defaultProfile];
  if (typeof selected !== "object" || selected === null || Array.isArray(selected)) return null;
  return normalizeProfileUnits((selected as Record<string, unknown>).units);
}

/**
 * Cloudflare cannot hold an incoming request open for Nightscout's unbounded
 * AUTH_FAIL_DELAY. Report the same 0..60s value the Worker actually enforces.
 */
export function normalizePlatformAuthFailDelay(value: string | undefined): number {
  const normalized = value?.trim();
  const parsed = Number(normalized === undefined || normalized === "" ? 5000 : normalized);
  return Number.isFinite(parsed)
    ? Math.max(0, Math.min(MAX_AUTH_FAIL_DELAY_MS, Math.trunc(parsed)))
    : 5000;
}

function lockedThresholdNumber(value: string | undefined, fallback: number): number {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") return fallback;
  // Locked settings.js accepts a decimal comma, then coerces every configured
  // threshold with Number(). Invalid values become NaN and JSON renders null.
  return Number(normalized.replace(",", "."));
}

function configuredThresholdValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized === "" ? undefined : normalized;
}

function configuredThresholds(
  environment: NightscoutStatusEnvironment,
  units: NightscoutDisplayUnits,
): NightscoutStatusSettingsOverrides["thresholds"] | undefined {
  const values = [
    configuredThresholdValue(environment.BG_HIGH),
    configuredThresholdValue(environment.BG_TARGET_TOP),
    configuredThresholdValue(environment.BG_TARGET_BOTTOM),
    configuredThresholdValue(environment.BG_LOW),
  ];
  if (values.every((value) => value === undefined)) return undefined;

  const thresholds = {
    bgHigh: lockedThresholdNumber(values[0], DEFAULT_THRESHOLDS.bgHigh),
    bgTargetTop: lockedThresholdNumber(
      values[1],
      DEFAULT_THRESHOLDS.bgTargetTop,
    ),
    bgTargetBottom: lockedThresholdNumber(
      values[2],
      DEFAULT_THRESHOLDS.bgTargetBottom,
    ),
    bgLow: lockedThresholdNumber(values[3], DEFAULT_THRESHOLDS.bgLow),
  };

  // Locked settings.js accepts mmol thresholds, but keeps legacy mg/dl values
  // when bgHigh is already above the mmol range.
  if (units === "mmol" && thresholds.bgHigh < 50) {
    thresholds.bgHigh = Math.round(thresholds.bgHigh * MMOL_TO_MGDL);
    thresholds.bgTargetTop = Math.round(thresholds.bgTargetTop * MMOL_TO_MGDL);
    thresholds.bgTargetBottom = Math.round(thresholds.bgTargetBottom * MMOL_TO_MGDL);
    thresholds.bgLow = Math.round(thresholds.bgLow * MMOL_TO_MGDL);
  }
  if (thresholds.bgTargetBottom >= thresholds.bgTargetTop) {
    thresholds.bgTargetBottom = thresholds.bgTargetTop - 1;
  }
  if (thresholds.bgTargetTop <= thresholds.bgTargetBottom) {
    thresholds.bgTargetTop = thresholds.bgTargetBottom + 1;
  }
  if (thresholds.bgLow >= thresholds.bgTargetBottom) {
    thresholds.bgLow = thresholds.bgTargetBottom - 1;
  }
  if (thresholds.bgHigh <= thresholds.bgTargetTop) {
    thresholds.bgHigh = thresholds.bgTargetTop + 1;
  }
  return thresholds;
}

export function tenantStatusSettings(
  environment: NightscoutStatusEnvironment,
  latestProfile?: unknown,
): NightscoutStatusSettingsOverrides {
  const units = environment.DISPLAY_UNITS === undefined
    ? profileDisplayUnits(latestProfile) ?? "mg/dl"
    : normalizeConfiguredDisplayUnits(environment.DISPLAY_UNITS);
  const thresholds = configuredThresholds(environment, units);
  const base = {
    units,
    authFailDelay: normalizePlatformAuthFailDelay(environment.AUTH_FAIL_DELAY),
    simpleAlarms: thresholds !== undefined,
  };
  return thresholds === undefined ? base : { ...base, thresholds };
}

function nightscoutSettings(
  authDefaultRoles: string,
  overrides: NightscoutStatusSettingsOverrides,
): Record<string, unknown> {
  const simpleAlarms = overrides.simpleAlarms === true;
  // This is the JSON-visible result of locked v15.0.7
  // env.settings.filteredSettings(env.settings) with the reviewed settings
  // overrides. Keep it explicit so functions and secure settings cannot leak.
  return {
    units: overrides.units ?? "mg/dl",
    timeFormat: 12,
    dayStart: 7,
    dayEnd: 21,
    nightMode: false,
    editMode: true,
    showRawbg: "never",
    customTitle: "Nightscout",
    theme: "default",
    alarmUrgentHigh: true,
    alarmUrgentHighMins: [30, 60, 90, 120],
    alarmHigh: true,
    alarmHighMins: [30, 60, 90, 120],
    alarmLow: true,
    alarmLowMins: [15, 30, 45, 60],
    alarmUrgentLow: true,
    alarmUrgentLowMins: [15, 30, 45],
    alarmUrgentMins: [30, 60, 90, 120],
    alarmWarnMins: [30, 60, 90, 120],
    alarmTimeagoWarn: true,
    alarmTimeagoWarnMins: 15,
    alarmTimeagoUrgent: true,
    alarmTimeagoUrgentMins: 30,
    alarmPumpBatteryLow: false,
    language: "en",
    scaleY: "log",
    showPlugins: "dbsize delta direction upbat",
    showForecast: "ar2",
    focusHours: 3,
    heartbeat: 60,
    baseURL: "",
    authDefaultRoles,
    thresholds: overrides.thresholds ?? { ...DEFAULT_THRESHOLDS },
    insecureUseHttp: false,
    secureHstsHeader: true,
    secureHstsHeaderIncludeSubdomains: false,
    secureHstsHeaderPreload: false,
    secureCsp: false,
    deNormalizeDates: false,
    showClockDelta: false,
    showClockLastTime: false,
    frameUrl1: "",
    frameUrl2: "",
    frameUrl3: "",
    frameUrl4: "",
    frameUrl5: "",
    frameUrl6: "",
    frameUrl7: "",
    frameUrl8: "",
    frameName1: "",
    frameName2: "",
    frameName3: "",
    frameName4: "",
    frameName5: "",
    frameName6: "",
    frameName7: "",
    frameName8: "",
    authFailDelay: overrides.authFailDelay ?? 5000,
    adminNotifiesEnabled: true,
    authenticationPromptOnLoad: false,
    DEFAULT_FEATURES: [...DEFAULT_FEATURES],
    alarmTypes: [simpleAlarms ? "simple" : "predict"],
    enable: [...DEFAULT_FEATURES, simpleAlarms ? "simplealarms" : "ar2"],
  };
}

export function nightscoutStatus(
  now = new Date(),
  authDefaultRoles = "readable",
  settingsOverrides: NightscoutStatusSettingsOverrides = {},
  authorized: unknown = null,
): Record<string, unknown> {
  const settings = nightscoutSettings(authDefaultRoles, settingsOverrides);
  const enable = settings.enable as string[];
  return {
    status: "ok",
    name: "Nightscout",
    version: "15.0.7",
    serverTime: now.toISOString(),
    serverTimeEpoch: now.getTime(),
    apiEnabled: true,
    careportalEnabled: enable.includes("careportal"),
    boluscalcEnabled: enable.includes("boluscalc"),
    settings,
    extendedSettings: {},
    authorized,
    runtimeState: "loaded",
  };
}

/** Exact field set/order used by locked Nightscout's Socket.IO authorize path. */
export function nightscoutWebsocketStatus(
  now = new Date(),
  activeProfile?: unknown,
  authDefaultRoles = "readable",
  settingsOverrides: NightscoutStatusSettingsOverrides = {},
): Record<string, unknown> {
  const httpStatus = nightscoutStatus(now, authDefaultRoles, settingsOverrides);
  const websocketStatus: Record<string, unknown> = {
    status: "ok",
    name: "Nightscout",
    version: "15.0.7",
    versionNum: 150007,
    serverTime: now.toISOString(),
    apiEnabled: true,
    careportalEnabled: httpStatus.careportalEnabled,
    boluscalcEnabled: httpStatus.boluscalcEnabled,
    settings: httpStatus.settings,
    extendedSettings: {},
  };
  if (activeProfile !== undefined && activeProfile !== null) {
    websocketStatus.activeProfile = activeProfile;
  }
  return websocketStatus;
}
