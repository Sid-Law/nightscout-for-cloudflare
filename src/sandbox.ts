import { createNightscoutProfileFunctions } from "./profile-functions";
import { nightscoutTimes } from "./runtime/times";
import { mgdlToMMOL, mmolToMgdl } from "./runtime/units";

export type SandboxDocument = Record<string, unknown>;
export type SandboxNotificationFunction = (...args: unknown[]) => unknown;

export interface SandboxNotifications extends Record<string, unknown> {
  requestNotify?: SandboxNotificationFunction;
  requestSnooze?: SandboxNotificationFunction;
  requestClear?: SandboxNotificationFunction;
}

export interface SandboxData extends Record<string, unknown> {
  sgvs?: SandboxDocument[];
  profiles?: SandboxDocument[];
  profileTreatments?: SandboxDocument[];
  tempbasalTreatments?: SandboxDocument[];
  combobolusTreatments?: SandboxDocument[];
}

export interface SandboxDdata extends SandboxData {
  clone: () => SandboxData;
}

export interface SandboxLanguage extends Record<string, unknown> {
  translate: (...args: unknown[]) => unknown;
}

export interface SandboxPlugin {
  name: string;
}

export interface SandboxPluginBase extends Record<string, unknown> {
  forecastInfos?: unknown[];
  forecastPoints?: Record<string, unknown>;
}

export interface SandboxEnvironment {
  settings: Record<string, unknown>;
  extendedSettings?: Record<string, unknown>;
}

export interface ServerSandboxContext {
  ddata: SandboxDdata;
  notifications?: SandboxNotifications;
  levels?: unknown;
  language: SandboxLanguage;
  runtimeState?: unknown;
}

export interface ClientSandboxContext {
  settings: Record<string, unknown>;
  pluginBase?: SandboxPluginBase | undefined;
  notifications?: SandboxNotifications;
  levels?: unknown;
  language: SandboxLanguage;
}

export interface NightscoutSandbox extends Record<string, unknown> {
  runtimeEnvironment?: "client" | "server";
  runtimeState?: unknown;
  settings: Record<string, unknown>;
  showPlugins?: unknown;
  time: number;
  data: SandboxData;
  pluginBase?: SandboxPluginBase | undefined;
  notifications: SandboxNotifications;
  levels?: unknown;
  language: SandboxLanguage;
  translate: (...args: unknown[]) => unknown;
  properties: Record<string, unknown>;
  unitsLabel: string;
  extendedSettings: Record<string, unknown>;
  serverInit: (environment: SandboxEnvironment, context: ServerSandboxContext) => NightscoutSandbox;
  clientInit: (
    context: ClientSandboxContext,
    time: number,
    data: SandboxData,
  ) => NightscoutSandbox;
  withExtendedSettings: (plugin: SandboxPlugin) => NightscoutSandbox;
  offerProperty: (name: string, setter: () => unknown) => void;
  isCurrent: (entry: SandboxDocument | null | undefined) => boolean | null | undefined;
  lastEntry: (entries: SandboxDocument[]) => SandboxDocument | undefined;
  lastNEntries: (entries: SandboxDocument[], count: number) => SandboxDocument[];
  prevEntry: (entries: SandboxDocument[]) => SandboxDocument | undefined;
  prevSGVEntry: () => SandboxDocument | undefined;
  lastSGVEntry: () => SandboxDocument | undefined;
  lastSGVMgdl: () => unknown;
  lastSGVMills: () => unknown;
  entryMills: (entry: SandboxDocument | null | undefined) => unknown;
  lastScaledSGV: () => number | undefined;
  lastDisplaySVG: () => number | string | undefined;
  buildBGNowLine: () => string;
  propertyLine: (propertyName: string) => unknown;
  appendPropertyLine: (propertyName: string, lines?: unknown[]) => unknown[];
  prepareDefaultLines: () => unknown[];
  buildDefaultMessage: () => string;
  displayBg: (entry: SandboxDocument) => number | string | undefined;
  scaleEntry: (entry: SandboxDocument | null | undefined) => number | null | undefined;
  scaleMgdl: (mgdl: unknown) => number;
  roundInsulinForDisplayFormat: (insulin: number) => string;
  roundBGToDisplayFormat: (bg: number) => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneDocuments(value: unknown): SandboxDocument[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((document) => structuredClone(document));
}

function safeNotifications(context: { notifications?: SandboxNotifications }): SandboxNotifications {
  const source = context.notifications;
  if (source === undefined) return {};
  const safe: SandboxNotifications = {};
  for (const key of ["requestNotify", "requestSnooze", "requestClear"] as const) {
    const value = source[key];
    if (value !== undefined) safe[key] = value;
  }
  return safe;
}

/**
 * Request-local Workers port of locked Nightscout v15.0.7 lib/sandbox.js.
 * Node's dynamic profile require is replaced by the already locked
 * Workers-safe Profile adapter; the public plugin sandbox surface is retained.
 */
export function createNightscoutSandbox(): NightscoutSandbox {
  const sandbox = {} as NightscoutSandbox;
  let readExtendedSettings = (): Record<string, unknown> | undefined => undefined;

  function reset(): void {
    sandbox.properties = {};
  }

  function unitsLabel(): string {
    return sandbox.settings.units === "mmol" ? "mmol/L" : "mg/dl";
  }

  function extend(): void {
    sandbox.unitsLabel = unitsLabel();
    sandbox.data ??= {};
    sandbox.extendedSettings = { empty: true };
  }

  function withExtendedSettings(plugin: SandboxPlugin): NightscoutSandbox {
    const clone = { ...sandbox } as NightscoutSandbox;
    const selected = readExtendedSettings()?.[plugin.name];
    clone.extendedSettings = isRecord(selected) ? selected : {};
    return clone;
  }

  function serverInit(
    environment: SandboxEnvironment,
    context: ServerSandboxContext,
  ): NightscoutSandbox {
    reset();
    sandbox.runtimeEnvironment = "server";
    sandbox.runtimeState = context.runtimeState;
    sandbox.time = Date.now();
    sandbox.settings = environment.settings;
    sandbox.data = context.ddata.clone();
    sandbox.notifications = safeNotifications(context);
    sandbox.levels = context.levels;
    sandbox.language = context.language;
    sandbox.translate = context.language.translate;

    const profile = createNightscoutProfileFunctions();
    profile.loadData(cloneDocuments(context.ddata.profiles));
    profile.updateTreatments(
      cloneDocuments(context.ddata.profileTreatments),
      cloneDocuments(context.ddata.tempbasalTreatments),
      cloneDocuments(context.ddata.combobolusTreatments),
    );
    sandbox.data.profile = profile;
    delete sandbox.data.profiles;
    sandbox.properties = {};
    readExtendedSettings = (): Record<string, unknown> | undefined =>
      environment.extendedSettings;
    sandbox.withExtendedSettings = withExtendedSettings;
    extend();
    return sandbox;
  }

  function clientInit(
    context: ClientSandboxContext,
    time: number,
    data: SandboxData,
  ): NightscoutSandbox {
    reset();
    sandbox.runtimeEnvironment = "client";
    sandbox.settings = context.settings;
    sandbox.showPlugins = context.settings.showPlugins;
    sandbox.time = time;
    sandbox.data = data;
    sandbox.pluginBase = context.pluginBase;
    sandbox.notifications = safeNotifications(context);
    sandbox.levels = context.levels;
    sandbox.language = context.language;
    sandbox.translate = context.language.translate;
    if (sandbox.pluginBase !== undefined) {
      sandbox.pluginBase.forecastInfos = [];
      sandbox.pluginBase.forecastPoints = {};
    }
    readExtendedSettings = (): Record<string, unknown> | undefined => {
      const extendedSettings = context.settings.extendedSettings;
      return isRecord(extendedSettings) ? extendedSettings : undefined;
    };
    sandbox.extendedSettings = { empty: true };
    sandbox.withExtendedSettings = withExtendedSettings;
    extend();
    return sandbox;
  }

  function offerProperty(name: string, setter: () => unknown): void {
    if (Object.keys(sandbox.properties).includes(name)) return;
    const value = setter();
    if (value) sandbox.properties[name] = value;
  }

  function entryMills(entry: SandboxDocument | null | undefined): unknown {
    return entry?.mills;
  }

  function lastEntry(entries: SandboxDocument[]): SandboxDocument | undefined {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry !== undefined && Number(entryMills(entry)) <= sandbox.time) return entry;
    }
    return undefined;
  }

  function lastNEntries(entries: SandboxDocument[], count: number): SandboxDocument[] {
    const selected: SandboxDocument[] = [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry !== undefined && Number(entryMills(entry)) <= sandbox.time) selected.push(entry);
      if (!(selected.length < count)) break;
    }
    return selected.reverse();
  }

  function lastSGVEntry(): SandboxDocument | undefined {
    return lastEntry(sandbox.data.sgvs ?? []);
  }

  function scaleEntry(
    entry: SandboxDocument | null | undefined,
  ): number | null | undefined {
    if (entry !== undefined && entry !== null && entry.scaled === undefined) {
      entry.scaled = sandbox.settings.units === "mmol"
        ? entry.mmol || mgdlToMMOL(entry.mgdl as number | string)
        : entry.mgdl || mmolToMgdl(entry.mmol as number | string);
    }
    return entry === undefined || entry === null ? entry : Number(entry.scaled);
  }

  function displayBg(entry: SandboxDocument): number | string | undefined {
    if (Number(entry.mgdl) === 39) return "LOW";
    if (Number(entry.mgdl) === 401) return "HIGH";
    return scaleEntry(entry) ?? undefined;
  }

  function buildBGNowLine(): string {
    let line = `BG Now: ${String(sandbox.lastDisplaySVG())}`;
    const delta = isRecord(sandbox.properties.delta) && sandbox.properties.delta.display;
    if (delta) line += ` ${String(delta)}`;
    const direction = isRecord(sandbox.properties.direction) && sandbox.properties.direction.label;
    if (direction) line += ` ${String(direction)}`;
    return `${line} ${sandbox.unitsLabel}`;
  }

  function propertyLine(propertyName: string): unknown {
    const property = sandbox.properties[propertyName];
    return isRecord(property) ? property.displayLine : undefined;
  }

  function appendPropertyLine(propertyName: string, suppliedLines?: unknown[]): unknown[] {
    const lines = suppliedLines ?? [];
    const displayLine = propertyLine(propertyName);
    if (displayLine) lines.push(displayLine);
    return lines;
  }

  function prepareDefaultLines(): unknown[] {
    const lines: unknown[] = [buildBGNowLine()];
    for (const property of ["rawbg", "ar2", "bwp", "iob", "cob"]) {
      appendPropertyLine(property, lines);
    }
    return lines;
  }

  function roundInsulinForDisplayFormat(insulin: number): string {
    if (insulin === 0) return "0";
    if (sandbox.properties.roundingStyle === "medtronic") {
      const denominator = insulin <= 0.5 ? 0.05 : 0.1;
      const digits = insulin <= 0.5 ? 2 : 1;
      const multiplier = 1 / denominator;
      return (Math.floor(insulin * multiplier + 1e-9) / multiplier).toFixed(digits);
    }
    return (Math.floor(insulin * 100 + 1e-9) / 100).toFixed(2);
  }

  sandbox.settings = {};
  sandbox.time = 0;
  sandbox.data = {};
  sandbox.notifications = {};
  sandbox.language = { translate: (key): unknown => key };
  sandbox.translate = sandbox.language.translate;
  sandbox.properties = {};
  sandbox.unitsLabel = "mg/dl";
  sandbox.extendedSettings = { empty: true };
  sandbox.serverInit = serverInit;
  sandbox.clientInit = clientInit;
  sandbox.withExtendedSettings = withExtendedSettings;
  sandbox.offerProperty = offerProperty;
  sandbox.isCurrent = (entry): boolean | null | undefined =>
    entry && sandbox.time - Number(entryMills(entry)) <= nightscoutTimes.mins(15).msecs;
  sandbox.lastEntry = lastEntry;
  sandbox.lastNEntries = lastNEntries;
  sandbox.prevEntry = (entries): SandboxDocument | undefined => lastNEntries(entries, 2)[0];
  sandbox.prevSGVEntry = (): SandboxDocument | undefined =>
    sandbox.prevEntry(sandbox.data.sgvs ?? []);
  sandbox.lastSGVEntry = lastSGVEntry;
  sandbox.lastSGVMgdl = (): unknown => lastSGVEntry()?.mgdl;
  sandbox.lastSGVMills = (): unknown => entryMills(lastSGVEntry());
  sandbox.entryMills = entryMills;
  sandbox.lastScaledSGV = (): number | undefined => scaleEntry(lastSGVEntry()) ?? undefined;
  sandbox.lastDisplaySVG = (): number | string | undefined => {
    const entry = lastSGVEntry();
    return entry === undefined ? undefined : displayBg(entry);
  };
  sandbox.buildBGNowLine = buildBGNowLine;
  sandbox.propertyLine = propertyLine;
  sandbox.appendPropertyLine = appendPropertyLine;
  sandbox.prepareDefaultLines = prepareDefaultLines;
  sandbox.buildDefaultMessage = (): string => prepareDefaultLines().join("\n");
  sandbox.displayBg = displayBg;
  sandbox.scaleEntry = scaleEntry;
  sandbox.scaleMgdl = (mgdl): number =>
    sandbox.settings.units === "mmol" && mgdl ? Number(mgdlToMMOL(mgdl as number | string)) : Number(mgdl);
  sandbox.roundInsulinForDisplayFormat = roundInsulinForDisplayFormat;
  sandbox.roundBGToDisplayFormat = (bg): number =>
    sandbox.settings.units === "mmol" ? Math.round(bg * 10) / 10 : Math.round(bg);
  return sandbox;
}
