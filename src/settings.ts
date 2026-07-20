import { URGENT } from "./runtime/levels";

export const NIGHTSCOUT_DEFAULT_FEATURES = [
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

export const NIGHTSCOUT_DEFAULT_THRESHOLDS = Object.freeze({
  bgHigh: 260,
  bgTargetTop: 180,
  bgTargetBottom: 80,
  bgLow: 55,
});

const MMOL_TO_MGDL = 18.01559;
const SECURE_SETTING_KEYS = new Set([
  "apnsKey",
  "apnsKeyId",
  "developerTeamId",
  "userName",
  "password",
  "obscured",
  "obscureDeviceProvenance",
]);

export interface NightscoutAlarmEvent {
  eventName: string;
  level: number;
}

export type NightscoutSettingAccessor = (name: string) => unknown;

export interface NightscoutSettings extends Record<string, unknown> {
  units: unknown;
  thresholds: Record<string, unknown>;
  DEFAULT_FEATURES: string[];
  showPlugins: unknown;
  showRawbg: unknown;
  enable?: string[];
  alarmTypes?: string[];
  obscured: unknown;
  eachSetting: (accessor: NightscoutSettingAccessor) => void;
  eachSettingAsEnv: (accessor: NightscoutSettingAccessor) => void;
  isEnabled: (feature: string | readonly string[]) => boolean;
  isAlarmEventEnabled: (notification: NightscoutAlarmEvent) => boolean;
  snoozeMinsForAlarmEvent: (notification: NightscoutAlarmEvent) => unknown;
  snoozeFirstMinsForAlarmEvent: (notification: NightscoutAlarmEvent) => unknown;
  filteredSettings: (settingsObject: unknown) => unknown;
}

type MutableSettings = Record<string, unknown> & {
  thresholds: Record<string, unknown>;
  DEFAULT_FEATURES: string[];
  obscured: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function deepClone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => deepClone(item));
  if (!isRecord(value)) return value;
  const clone: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) clone[key] = deepClone(item);
  return clone;
}

function filterSecureKeys(value: unknown): unknown {
  if (!isRecord(value)) return value;
  for (const key of Object.keys(value)) {
    if (SECURE_SETTING_KEYS.has(key)) {
      delete value[key];
    } else {
      filterSecureKeys(value[key]);
    }
  }
  return value;
}

function mapNumberArray(value: unknown): unknown {
  if (!value || Array.isArray(value)) return value;
  if (Number.isNaN(Number(value))) {
    return String(value)
      .split(" ")
      .map((item) => Number.isNaN(Number(item)) ? null : Number(item));
  }
  return [Number(value)];
}

function mapNumber(value: unknown): unknown {
  if (!value) return value;
  let mapped = value;
  if (typeof mapped === "string" && Number.isNaN(Number(mapped))) {
    const decommaed = mapped.replace(",", ".");
    if (!Number.isNaN(Number(decommaed))) mapped = decommaed;
  }
  return Number.isNaN(Number(mapped)) ? mapped : Number(mapped);
}

function mapTruthy(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const normalized = value.toLowerCase();
  if (normalized === "on" || normalized === "true") return true;
  if (normalized === "off" || normalized === "false") return false;
  return value;
}

function isSimple(value: unknown): boolean {
  return Array.isArray(value) || (typeof value !== "function" && typeof value !== "object");
}

function environmentName(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toUpperCase();
}

function preparedList(value: unknown): string[] {
  const raw = value || "";
  const decoded = decodeURIComponent(String(raw)).toLowerCase();
  return decoded.length === 0 ? [] : decoded.split(" ").filter((item) => item !== "");
}

/**
 * Request-local Workers port of locked Nightscout v15.0.7 lib/settings.js.
 * It deliberately has no module-global mutable state: every request/tenant
 * receives a fresh object while retaining the upstream public method surface.
 */
export function createNightscoutSettings(): NightscoutSettings {
  const settings: MutableSettings = {
    units: "mg/dl",
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
    showPlugins: "dbsize",
    showForecast: "ar2",
    focusHours: 3,
    heartbeat: 60,
    baseURL: "",
    authDefaultRoles: "readable",
    thresholds: { ...NIGHTSCOUT_DEFAULT_THRESHOLDS },
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
    authFailDelay: 5000,
    adminNotifiesEnabled: true,
    obscured: "",
    obscureDeviceProvenance: "",
    authenticationPromptOnLoad: false,
    DEFAULT_FEATURES: [...NIGHTSCOUT_DEFAULT_FEATURES],
  };
  const wasSet: string[] = [];
  const valueMappers: Readonly<Record<string, (value: unknown) => unknown>> = {
    nightMode: mapTruthy,
    alarmUrgentHigh: mapTruthy,
    alarmUrgentHighMins: mapNumberArray,
    alarmHigh: mapTruthy,
    alarmHighMins: mapNumberArray,
    alarmLow: mapTruthy,
    alarmLowMins: mapNumberArray,
    alarmUrgentLow: mapTruthy,
    alarmUrgentLowMins: mapNumberArray,
    alarmUrgentMins: mapNumberArray,
    alarmTimeagoWarn: mapTruthy,
    alarmTimeagoUrgent: mapTruthy,
    alarmWarnMins: mapNumberArray,
    timeFormat: mapNumber,
    insecureUseHttp: mapTruthy,
    secureHstsHeader: mapTruthy,
    secureCsp: mapTruthy,
    deNormalizeDates: mapTruthy,
    showClockDelta: mapTruthy,
    showClockLastTime: mapTruthy,
    bgHigh: mapNumber,
    bgLow: mapNumber,
    bgTargetTop: mapNumber,
    bgTargetBottom: mapNumber,
    authFailDelay: mapNumber,
    adminNotifiesEnabled: mapTruthy,
    authenticationPromptOnLoad: mapTruthy,
  };

  function verifyThresholds(): void {
    const thresholds = settings.thresholds;
    let bgHigh = Number(thresholds.bgHigh);
    let bgTargetTop = Number(thresholds.bgTargetTop);
    let bgTargetBottom = Number(thresholds.bgTargetBottom);
    let bgLow = Number(thresholds.bgLow);
    if (bgTargetBottom >= bgTargetTop) bgTargetBottom = bgTargetTop - 1;
    if (bgTargetTop <= bgTargetBottom) bgTargetTop = bgTargetBottom + 1;
    if (bgLow >= bgTargetBottom) bgLow = bgTargetBottom - 1;
    if (bgHigh <= bgTargetTop) bgHigh = bgTargetTop + 1;
    thresholds.bgHigh = bgHigh;
    thresholds.bgTargetTop = bgTargetTop;
    thresholds.bgTargetBottom = bgTargetBottom;
    thresholds.bgLow = bgLow;
  }

  function isEnabled(feature: string | readonly string[]): boolean {
    const enable = settings.enable;
    if (!Array.isArray(enable)) return false;
    return Array.isArray(feature)
      ? feature.some((candidate) => enable.includes(candidate))
      : enable.includes(feature);
  }

  function adjustShownPlugins(): void {
    const current = settings.showPlugins;
    const showPluginsUnset = Boolean(current)
      && typeof (current as { length?: unknown }).length === "number"
      && (current as { length: number }).length === 0;
    settings.showPlugins = `${String(current)} delta direction upbat`;
    if (settings.showRawbg === "always" || settings.showRawbg === "noise") {
      settings.showPlugins = `${String(settings.showPlugins)} rawbg`;
    }
    if (showPluginsUnset && Array.isArray(settings.enable)) {
      for (const feature of settings.enable) {
        if (isEnabled(feature)) settings.showPlugins = `${String(settings.showPlugins)} ${feature}`;
      }
    }
  }

  function enableAndDisableFeatures(accessor: NightscoutSettingAccessor, envNames: boolean): void {
    const read = (key: string): unknown => accessor(envNames ? environmentName(key) : key);
    const enable = preparedList(read("enable"));
    const disable = preparedList(read("disable"));
    const obscured = preparedList(read("obscured"));
    const alarmTypes = preparedList(read("alarmTypes"))
      .filter((type) => type === "predict" || type === "simple");
    if (alarmTypes.length === 0) {
      alarmTypes.push(wasSet.some((name) => name.startsWith("bg")) ? "simple" : "predict");
    }
    settings.alarmTypes = alarmTypes;

    if (read("pushoverApiToken")) enable.push("pushover");
    if (["careportal", "pushover", "maker"].some((feature) => enable.includes(feature))) {
      enable.push("treatmentnotify");
    }
    for (const feature of settings.DEFAULT_FEATURES) {
      if (!enable.includes(feature)) enable.push(feature);
    }
    if (alarmTypes.includes("simple")) enable.push("simplealarms");
    if (alarmTypes.includes("predict")) enable.push("ar2");
    settings.enable = enable.filter((feature) => !disable.includes(feature));
    settings.obscured = obscured;

    const thresholds = settings.thresholds;
    thresholds.bgHigh = Number(thresholds.bgHigh);
    thresholds.bgTargetTop = Number(thresholds.bgTargetTop);
    thresholds.bgTargetBottom = Number(thresholds.bgTargetBottom);
    thresholds.bgLow = Number(thresholds.bgLow);
    if (String(settings.units).toLowerCase().includes("mmol") && Number(thresholds.bgHigh) < 50) {
      thresholds.bgHigh = Math.round(Number(thresholds.bgHigh) * MMOL_TO_MGDL);
      thresholds.bgTargetTop = Math.round(Number(thresholds.bgTargetTop) * MMOL_TO_MGDL);
      thresholds.bgTargetBottom = Math.round(Number(thresholds.bgTargetBottom) * MMOL_TO_MGDL);
      thresholds.bgLow = Math.round(Number(thresholds.bgLow) * MMOL_TO_MGDL);
    }
    verifyThresholds();
    adjustShownPlugins();
  }

  function eachSettingAs(envNames: boolean): (accessor: NightscoutSettingAccessor) => void {
    return (accessor): void => {
      const mapKeys = (keys: Record<string, unknown>): void => {
        for (const [key, value] of Object.entries(keys)) {
          if (!isSimple(value)) continue;
          const replacement = accessor(envNames ? environmentName(key) : key);
          if (replacement === undefined) continue;
          const mapper = valueMappers[key];
          wasSet.push(key);
          keys[key] = mapper === undefined ? replacement : mapper(replacement);
        }
      };
      mapKeys(settings);
      mapKeys(settings.thresholds);
      enableAndDisableFeatures(accessor, envNames);
    };
  }

  function isUrgentHighAlarmEnabled(notification: NightscoutAlarmEvent): boolean {
    return notification.eventName === "high"
      && notification.level === URGENT
      && Boolean(settings.alarmUrgentHigh);
  }

  function isHighAlarmEnabled(notification: NightscoutAlarmEvent): boolean {
    return notification.eventName === "high" && Boolean(settings.alarmHigh);
  }

  function isUrgentLowAlarmEnabled(notification: NightscoutAlarmEvent): boolean {
    return notification.eventName === "low"
      && notification.level === URGENT
      && Boolean(settings.alarmUrgentLow);
  }

  function isLowAlarmEnabled(notification: NightscoutAlarmEvent): boolean {
    return notification.eventName === "low" && Boolean(settings.alarmLow);
  }

  function isAlarmEventEnabled(notification: NightscoutAlarmEvent): boolean {
    return (notification.eventName !== "high" && notification.eventName !== "low")
      || isUrgentHighAlarmEnabled(notification)
      || isHighAlarmEnabled(notification)
      || isUrgentLowAlarmEnabled(notification)
      || isLowAlarmEnabled(notification);
  }

  function snoozeMinsForAlarmEvent(notification: NightscoutAlarmEvent): unknown {
    if (isUrgentHighAlarmEnabled(notification)) return settings.alarmUrgentHighMins;
    if (isHighAlarmEnabled(notification)) return settings.alarmHighMins;
    if (isUrgentLowAlarmEnabled(notification)) return settings.alarmUrgentLowMins;
    if (isLowAlarmEnabled(notification)) return settings.alarmLowMins;
    return notification.level === URGENT ? settings.alarmUrgentMins : settings.alarmWarnMins;
  }

  function snoozeFirstMinsForAlarmEvent(notification: NightscoutAlarmEvent): unknown {
    const values = snoozeMinsForAlarmEvent(notification);
    return Array.isArray(values) ? values[0] : undefined;
  }

  function filteredSettings(settingsObject: unknown): unknown {
    const clone = deepClone(settingsObject);
    if (isRecord(clone) && clone.obscured && Array.isArray(clone.enable)) {
      const obscured = Array.isArray(clone.obscured) ? clone.obscured : [];
      clone.enable = clone.enable.filter((feature) => !obscured.includes(feature));
    }
    return filterSecureKeys(clone);
  }

  settings.eachSetting = eachSettingAs(false);
  settings.eachSettingAsEnv = eachSettingAs(true);
  settings.isEnabled = isEnabled;
  settings.isAlarmEventEnabled = isAlarmEventEnabled;
  settings.snoozeMinsForAlarmEvent = snoozeMinsForAlarmEvent;
  settings.snoozeFirstMinsForAlarmEvent = snoozeFirstMinsForAlarmEvent;
  settings.filteredSettings = filteredSettings;
  return settings as NightscoutSettings;
}
