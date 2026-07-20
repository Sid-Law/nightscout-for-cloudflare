import {
  createNightscoutSettings,
  NIGHTSCOUT_DEFAULT_FEATURES as DEFAULT_FEATURES,
  NIGHTSCOUT_DEFAULT_THRESHOLDS as DEFAULT_THRESHOLDS,
} from "./settings";

const MMOL_TO_MGDL = 18.01559;
const MAX_AUTH_FAIL_DELAY_MS = 60_000;
export const CLOUDFLARE_FREE_SQLITE_DO_MAX_MIB = 1_000_000_000 / (1024 * 1024);

export type NightscoutDisplayUnits = "mg/dl" | "mmol";

export interface NightscoutStatusEnvironment {
  DISPLAY_UNITS?: string;
  ENABLE?: string;
  DISABLE?: string;
  AUTH_FAIL_DELAY?: string;
  BG_HIGH?: string;
  BG_TARGET_TOP?: string;
  BG_TARGET_BOTTOM?: string;
  BG_LOW?: string;
  DBSIZE_MAX?: string;
  DBSIZE_WARN_PERCENTAGE?: string;
  DBSIZE_URGENT_PERCENTAGE?: string;
  DBSIZE_ENABLE_ALERTS?: string;
  DBSIZE_IN_MIB?: string;
}

function configuredFeatureNames(value: string | undefined): string[] {
  const raw = value?.trim();
  if (raw === undefined || raw.length === 0) return [];
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw).toLowerCase();
  } catch {
    return [];
  }
  return decoded.split(" ").filter((feature) => feature.length > 0);
}

function configuredEnable(
  environment: NightscoutStatusEnvironment,
  simpleAlarms: boolean,
): string[] | undefined {
  if (environment.ENABLE === undefined && environment.DISABLE === undefined) return undefined;
  const enabled = configuredFeatureNames(environment.ENABLE);
  for (const feature of DEFAULT_FEATURES) {
    if (!enabled.includes(feature)) enabled.push(feature);
  }
  const alarmPlugin = simpleAlarms ? "simplealarms" : "ar2";
  if (!enabled.includes(alarmPlugin)) enabled.push(alarmPlugin);
  const disabled = new Set(configuredFeatureNames(environment.DISABLE));
  return enabled.filter((feature) => !disabled.has(feature));
}

export interface NightscoutStatusSettingsOverrides {
  units?: NightscoutDisplayUnits;
  authFailDelay?: number;
  /** Test/platform-context override matching a resolved upstream settings.enable array. */
  enable?: string[];
  thresholds?: {
    bgHigh: number;
    bgTargetTop: number;
    bgTargetBottom: number;
    bgLow: number;
  };
  simpleAlarms?: boolean;
  /** Request-local client/server plugin settings after platform adaptation. */
  extendedSettings?: Record<string, unknown>;
}

function normalizeExtendedSetting(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  if (!Number.isNaN(Number(value))) return Number(value);
  const normalized = value.toLowerCase();
  if (normalized === "on" || normalized === "true") return true;
  if (normalized === "off" || normalized === "false") return false;
  return value;
}

function platformExtendedSettings(
  environment: NightscoutStatusEnvironment,
): Record<string, unknown> {
  const dbsize: Record<string, unknown> = {
    // Cloudflare documents a 1 GB per-object ceiling on Workers Free, while
    // the locked plugin expresses its configured maximum in binary MiB.
    max: normalizeExtendedSetting(environment.DBSIZE_MAX)
      ?? CLOUDFLARE_FREE_SQLITE_DO_MAX_MIB,
  };
  const configured = [
    ["warnPercentage", environment.DBSIZE_WARN_PERCENTAGE],
    ["urgentPercentage", environment.DBSIZE_URGENT_PERCENTAGE],
    ["enableAlerts", environment.DBSIZE_ENABLE_ALERTS],
    ["inMib", environment.DBSIZE_IN_MIB],
  ] as const;
  for (const [key, raw] of configured) {
    const value = normalizeExtendedSetting(raw);
    if (value !== undefined) dbsize[key] = value;
  }
  return { dbsize };
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
  const enable = configuredEnable(environment, base.simpleAlarms);
  return {
    ...base,
    extendedSettings: platformExtendedSettings(environment),
    ...(thresholds === undefined ? {} : { thresholds }),
    ...(enable === undefined ? {} : { enable }),
  };
}

function nightscoutSettings(
  authDefaultRoles: string,
  overrides: NightscoutStatusSettingsOverrides,
): Record<string, unknown> {
  const settings = createNightscoutSettings();
  const thresholds = overrides.thresholds;
  settings.eachSettingAsEnv((name) => {
    if (name === "UNITS") return overrides.units ?? "mg/dl";
    if (name === "AUTH_FAIL_DELAY") return overrides.authFailDelay ?? 5000;
    if (name === "ALARM_TYPES") return overrides.simpleAlarms === true ? "simple" : "predict";
    if (thresholds === undefined) return undefined;
    if (name === "BG_HIGH") return thresholds.bgHigh;
    if (name === "BG_TARGET_TOP") return thresholds.bgTargetTop;
    if (name === "BG_TARGET_BOTTOM") return thresholds.bgTargetBottom;
    if (name === "BG_LOW") return thresholds.bgLow;
    return undefined;
  });
  settings.authDefaultRoles = authDefaultRoles;
  if (overrides.enable !== undefined) settings.enable = [...overrides.enable];

  // filteredSettings retains enumerable method functions exactly like the
  // upstream module; Express JSON serialization omits those functions. Build
  // the same request snapshot explicitly before returning it to Worker routes.
  const filtered = settings.filteredSettings(settings);
  if (typeof filtered !== "object" || filtered === null || Array.isArray(filtered)) return {};
  return Object.fromEntries(
    Object.entries(filtered).filter(([, value]) => typeof value !== "function"),
  );
}

export function nightscoutStatus(
  now = new Date(),
  authDefaultRoles = "readable",
  settingsOverrides: NightscoutStatusSettingsOverrides = {},
  authorized: unknown = null,
): Record<string, unknown> {
  const settings = nightscoutSettings(authDefaultRoles, settingsOverrides);
  const enable = settings.enable as string[];
  const extendedSettings = settingsOverrides.extendedSettings ?? {};
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
    extendedSettings,
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
    extendedSettings: httpStatus.extendedSettings,
  };
  if (activeProfile !== undefined && activeProfile !== null) {
    websocketStatus.activeProfile = activeProfile;
  }
  return websocketStatus;
}
