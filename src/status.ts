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

const DEFAULT_ENABLE = [...DEFAULT_FEATURES, "ar2"] as const;

export type NightscoutDisplayUnits = "mg/dl" | "mmol";

export interface NightscoutStatusSettingsOverrides {
  units?: NightscoutDisplayUnits;
  authFailDelay?: number;
  thresholds?: {
    bgHigh: number;
    bgTargetTop: number;
    bgTargetBottom: number;
    bgLow: number;
  };
}

/**
 * Normalize units stored in an upstream profile document. Unlike the locked
 * DISPLAY_UNITS parser, invalid profile data is ignored instead of silently
 * changing it to mg/dl.
 */
export function normalizeProfileUnits(value: unknown): NightscoutDisplayUnits | null {
  if (typeof value !== "string") return null;
  const compact = value.trim().toLowerCase().replaceAll(" ", "");
  if (compact.includes("mmol")) return "mmol";
  if (compact === "mg/dl" || compact === "mgdl" || compact === "mg/dl.") {
    return "mg/dl";
  }
  return null;
}

/** Locked v15.0.7 lib/server/env.js DISPLAY_UNITS normalization. */
export function normalizeConfiguredDisplayUnits(value: string): NightscoutDisplayUnits {
  return value.toLowerCase().includes("mmol") ? "mmol" : "mg/dl";
}

function nightscoutSettings(
  authDefaultRoles: string,
  overrides: NightscoutStatusSettingsOverrides,
): Record<string, unknown> {
  // This is the JSON-visible result of locked v15.0.7
  // env.settings.filteredSettings(env.settings) with no optional env
  // overrides. Keep this list explicit so functions and secure settings from
  // the Node settings object can never leak into the public status response.
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
    thresholds: overrides.thresholds ?? {
      bgHigh: 260,
      bgTargetTop: 180,
      bgTargetBottom: 80,
      bgLow: 55,
    },
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
    alarmTypes: ["predict"],
    enable: [...DEFAULT_ENABLE],
  };
}

export function nightscoutStatus(
  now = new Date(),
  authDefaultRoles = "readable",
  settingsOverrides: NightscoutStatusSettingsOverrides = {},
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
    runtimeState: "loaded",
  };
}

/** Exact field set/order used by locked Nightscout's Socket.IO authorize path. */
export function nightscoutWebsocketStatus(
  now = new Date(),
  activeProfile?: unknown,
  authDefaultRoles = "readable",
): Record<string, unknown> {
  const httpStatus = nightscoutStatus(now, authDefaultRoles);
  const websocketStatus: Record<string, unknown> = {
    status: "ok",
    name: "Nightscout",
    version: "15.0.7",
    versionNum: 150007,
    serverTime: now.toISOString(),
    apiEnabled: true,
    careportalEnabled: true,
    boluscalcEnabled: false,
    settings: httpStatus.settings,
    extendedSettings: {},
  };
  if (activeProfile !== undefined && activeProfile !== null) {
    websocketStatus.activeProfile = activeProfile;
  }
  return websocketStatus;
}
