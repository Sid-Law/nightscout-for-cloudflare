export interface PluginExecutionSandbox extends Record<string, unknown> {
  withExtendedSettings: (plugin: NightscoutPlugin) => PluginExecutionSandbox;
  showPlugins?: unknown;
}

export interface NightscoutPlugin extends Record<string, unknown> {
  name: string;
  label?: string;
  pluginType?: string;
  pillFlip?: boolean;
  enabled?: boolean;
  setProperties?: (sandbox: PluginExecutionSandbox) => void;
  checkNotifications?: (sandbox: PluginExecutionSandbox) => void;
  visualizeAlarm?: (
    sandbox: PluginExecutionSandbox,
    alarm: unknown,
    alarmMessage: unknown,
  ) => void;
  updateVisualisation?: (sandbox: PluginExecutionSandbox) => void;
  getEventTypes?: (sandbox: PluginExecutionSandbox) => unknown;
}

export interface PluginRegistryContext {
  settings?: Record<string, unknown>;
  language?: unknown;
  pluginBase?: unknown;
}

export interface PluginCatalogs {
  client: NightscoutPlugin[];
  server: NightscoutPlugin[];
}

export interface PluginCatalogOverrides {
  client?: Record<string, Partial<NightscoutPlugin>>;
  server?: Record<string, Partial<NightscoutPlugin>>;
}

export interface NightscoutPluginRegistry {
  (name?: string): NightscoutPlugin | NightscoutPluginRegistry | undefined;
  base: unknown;
  specialPlugins: string;
  registerClientDefaults: () => NightscoutPluginRegistry;
  registerServerDefaults: () => NightscoutPluginRegistry;
  register: (plugins: NightscoutPlugin[]) => void;
  isPluginEnabled: (pluginName: string) => boolean;
  getPlugin: (pluginName: string) => NightscoutPlugin | undefined;
  eachPlugin: (callback: (plugin: NightscoutPlugin) => void) => void;
  eachEnabledPlugin: (callback: (plugin: NightscoutPlugin) => void) => void;
  shownPlugins: (sandbox?: PluginExecutionSandbox) => NightscoutPlugin[];
  eachShownPlugins: (
    sandbox: PluginExecutionSandbox | undefined,
    callback: (plugin: NightscoutPlugin) => void,
  ) => void;
  hasShownType: (pluginType: string, sandbox?: PluginExecutionSandbox) => boolean;
  setProperties: (sandbox: PluginExecutionSandbox) => void;
  checkNotifications: (sandbox: PluginExecutionSandbox) => void;
  visualizeAlarm: (
    sandbox: PluginExecutionSandbox,
    alarm: unknown,
    alarmMessage: unknown,
  ) => void;
  updateVisualisations: (sandbox: PluginExecutionSandbox) => void;
  getAllEventTypes: (sandbox: PluginExecutionSandbox) => unknown[];
  enabledPluginNames: () => string;
  extendedClientSettings: (
    allExtendedSettings: Record<string, unknown>,
  ) => Record<string, unknown>;
}

interface PluginMetadata {
  name: string;
  label: string;
  pluginType: string;
  pillFlip?: boolean;
}

export const NIGHTSCOUT_CLIENT_PLUGIN_METADATA: readonly PluginMetadata[] = Object.freeze([
  { name: "bgnow", label: "BG Now", pluginType: "pill-primary" },
  { name: "rawbg", label: "Raw BG", pluginType: "bg-status", pillFlip: true },
  { name: "direction", label: "BG direction", pluginType: "bg-status" },
  { name: "timeago", label: "Timeago", pluginType: "pill-status", pillFlip: true },
  { name: "upbat", label: "Uploader Battery", pluginType: "pill-status", pillFlip: true },
  { name: "ar2", label: "AR2", pluginType: "forecast" },
  { name: "errorcodes", label: "Dexcom Error Codes", pluginType: "notification" },
  { name: "iob", label: "Insulin-on-Board", pluginType: "pill-major" },
  { name: "cob", label: "Carbs-on-Board", pluginType: "pill-minor" },
  { name: "careportal", label: "Care Portal", pluginType: "drawer" },
  { name: "pump", label: "Pump", pluginType: "pill-status" },
  { name: "openaps", label: "OpenAPS", pluginType: "pill-status" },
  { name: "xdripjs", label: "CGM Status", pluginType: "pill-status" },
  { name: "loop", label: "Loop", pluginType: "pill-status" },
  { name: "override", label: "Override", pluginType: "pill-status" },
  { name: "bwp", label: "Bolus Wizard Preview", pluginType: "pill-minor" },
  { name: "cage", label: "Cannula Age", pluginType: "pill-minor" },
  { name: "sage", label: "Sensor Age", pluginType: "pill-minor" },
  { name: "iage", label: "Insulin Age", pluginType: "pill-minor" },
  { name: "bage", label: "Pump Battery Age", pluginType: "pill-minor" },
  { name: "basal", label: "Basal Profile", pluginType: "pill-minor" },
  { name: "bolus", label: "Bolus", pluginType: "fake" },
  { name: "boluscalc", label: "Bolus Wizard", pluginType: "drawer" },
  { name: "profile", label: "Profile", pluginType: "fake" },
  { name: "speech", label: "Speech", pluginType: "pill-status", pillFlip: true },
  { name: "dbsize", label: "Database Size", pluginType: "pill-status", pillFlip: true },
]);

export const NIGHTSCOUT_SERVER_PLUGIN_METADATA: readonly PluginMetadata[] = Object.freeze([
  { name: "bgnow", label: "BG Now", pluginType: "pill-primary" },
  { name: "rawbg", label: "Raw BG", pluginType: "bg-status", pillFlip: true },
  { name: "direction", label: "BG direction", pluginType: "bg-status" },
  { name: "upbat", label: "Uploader Battery", pluginType: "pill-status", pillFlip: true },
  { name: "ar2", label: "AR2", pluginType: "forecast" },
  { name: "simplealarms", label: "Simple Alarms", pluginType: "notification" },
  { name: "errorcodes", label: "Dexcom Error Codes", pluginType: "notification" },
  { name: "iob", label: "Insulin-on-Board", pluginType: "pill-major" },
  { name: "cob", label: "Carbs-on-Board", pluginType: "pill-minor" },
  { name: "pump", label: "Pump", pluginType: "pill-status" },
  { name: "openaps", label: "OpenAPS", pluginType: "pill-status" },
  { name: "xdripjs", label: "CGM Status", pluginType: "pill-status" },
  { name: "loop", label: "Loop", pluginType: "pill-status" },
  { name: "bwp", label: "Bolus Wizard Preview", pluginType: "pill-minor" },
  { name: "cage", label: "Cannula Age", pluginType: "pill-minor" },
  { name: "sage", label: "Sensor Age", pluginType: "pill-minor" },
  { name: "iage", label: "Insulin Age", pluginType: "pill-minor" },
  { name: "bage", label: "Pump Battery Age", pluginType: "pill-minor" },
  { name: "treatmentnotify", label: "Treatment Notifications", pluginType: "notification" },
  { name: "timeago", label: "Timeago", pluginType: "pill-status", pillFlip: true },
  { name: "basal", label: "Basal Profile", pluginType: "pill-minor" },
  { name: "dbsize", label: "Database Size", pluginType: "pill-status", pillFlip: true },
  { name: "runtimestate", label: "Runtime state", pluginType: "fake" },
]);

function buildCatalog(
  metadata: readonly PluginMetadata[],
  overrides: Record<string, Partial<NightscoutPlugin>> | undefined,
): NightscoutPlugin[] {
  return metadata.map((definition) => ({
    ...definition,
    ...overrides?.[definition.name],
    name: definition.name,
  }));
}

export function createDefaultPluginCatalogs(
  overrides: PluginCatalogOverrides = {},
): PluginCatalogs {
  return {
    client: buildCatalog(NIGHTSCOUT_CLIENT_PLUGIN_METADATA, overrides.client),
    server: buildCatalog(NIGHTSCOUT_SERVER_PLUGIN_METADATA, overrides.server),
  };
}

function contains(value: unknown, expected: string): boolean {
  if (value === null || value === undefined) return false;
  const indexable = value as { indexOf?: (needle: string) => number };
  return typeof indexable.indexOf === "function" && indexable.indexOf(expected) > -1;
}

/**
 * Request-local Workers port of locked Nightscout v15.0.7 lib/plugins/index.js.
 * Static catalogs replace Node dynamic require while registry order, enable
 * gates, error isolation and the public dispatcher surface remain unchanged.
 */
export function createNightscoutPluginRegistry(
  context: PluginRegistryContext,
  suppliedCatalogs?: PluginCatalogs,
): NightscoutPluginRegistry {
  const catalogs = suppliedCatalogs ?? createDefaultPluginCatalogs();
  const clientDefaultPlugins = catalogs.client.map((plugin) => ({ ...plugin }));
  const serverDefaultPlugins = catalogs.server.map((plugin) => ({ ...plugin }));
  const allPlugins: NightscoutPlugin[] = [];
  let enabledPlugins: NightscoutPlugin[] = [];

  const plugins = ((name?: string) => {
    if (name !== undefined && name !== "") {
      return allPlugins.find((plugin) => plugin.name === name);
    }
    return plugins;
  }) as NightscoutPluginRegistry;

  plugins.base = context.pluginBase;
  plugins.specialPlugins = "ar2 bgnow delta direction timeago upbat rawbg errorcodes profile bolus";

  plugins.register = (registered): void => {
    for (const plugin of registered) allPlugins.push(plugin);
    enabledPlugins = [];
    const enable = context.settings?.enable;
    for (const plugin of allPlugins) {
      plugin.enabled = contains(enable, plugin.name);
      if (plugin.enabled) enabledPlugins.push(plugin);
    }
  };

  plugins.registerClientDefaults = (): NightscoutPluginRegistry => {
    plugins.register(clientDefaultPlugins);
    return plugins;
  };

  plugins.registerServerDefaults = (): NightscoutPluginRegistry => {
    plugins.register(serverDefaultPlugins);
    return plugins;
  };

  // v15.0.7 calls lodash/find(enabledPlugins, "name", pluginName), so the
  // third argument is a start index rather than a name match. Keep that public
  // behavior until an upstream version changes it; production gating uses the
  // exact-name lookup function instead.
  plugins.isPluginEnabled = (_pluginName): boolean => {
    const plugin = enabledPlugins.find((candidate) => Boolean(candidate.name));
    return plugin !== null;
  };

  plugins.getPlugin = (_pluginName): NightscoutPlugin | undefined =>
    enabledPlugins.find((candidate) => Boolean(candidate.name));

  plugins.eachPlugin = (callback): void => {
    for (const plugin of allPlugins) callback(plugin);
  };

  plugins.eachEnabledPlugin = (callback): void => {
    for (const plugin of enabledPlugins) callback(plugin);
  };

  plugins.shownPlugins = (sandbox): NightscoutPlugin[] =>
    enabledPlugins.filter((plugin) =>
      plugins.specialPlugins.indexOf(plugin.name) > -1 ||
      contains(sandbox?.showPlugins, plugin.name)
    );

  plugins.eachShownPlugins = (sandbox, callback): void => {
    for (const plugin of plugins.shownPlugins(sandbox)) callback(plugin);
  };

  plugins.hasShownType = (pluginType, sandbox): boolean =>
    plugins.shownPlugins(sandbox).find((plugin) => plugin.pluginType === pluginType) !== undefined;

  plugins.setProperties = (sandbox): void => {
    plugins.eachEnabledPlugin((plugin) => {
      if (!plugin.setProperties) return;
      try {
        plugin.setProperties(sandbox.withExtendedSettings(plugin));
      } catch (error) {
        console.error("Plugin error on setProperties(): ", plugin.name, error);
      }
    });
  };

  plugins.checkNotifications = (sandbox): void => {
    plugins.eachEnabledPlugin((plugin) => {
      if (!plugin.checkNotifications) return;
      try {
        plugin.checkNotifications(sandbox.withExtendedSettings(plugin));
      } catch (error) {
        console.error("Plugin error on checkNotifications(): ", plugin.name, error);
      }
    });
  };

  plugins.visualizeAlarm = (sandbox, alarm, alarmMessage): void => {
    plugins.eachShownPlugins(sandbox, (plugin) => {
      if (!plugin.visualizeAlarm) return;
      try {
        plugin.visualizeAlarm(sandbox.withExtendedSettings(plugin), alarm, alarmMessage);
      } catch (error) {
        console.error("Plugin error on visualizeAlarm(): ", plugin.name, error);
      }
    });
  };

  plugins.updateVisualisations = (sandbox): void => {
    plugins.eachShownPlugins(sandbox, (plugin) => {
      if (!plugin.updateVisualisation) return;
      try {
        plugin.updateVisualisation(sandbox.withExtendedSettings(plugin));
      } catch (error) {
        console.error("Plugin error on visualizeAlarm(): ", plugin.name, error);
      }
    });
  };

  plugins.getAllEventTypes = (sandbox): unknown[] => {
    let eventTypes: unknown[] = [];
    plugins.eachEnabledPlugin((plugin) => {
      if (!plugin.getEventTypes) return;
      const current = plugin.getEventTypes(sandbox.withExtendedSettings(plugin));
      if (Array.isArray(current)) eventTypes = eventTypes.concat(current);
    });
    return eventTypes;
  };

  plugins.enabledPluginNames = (): string =>
    enabledPlugins.map((plugin) => plugin.name).join(" ");

  plugins.extendedClientSettings = (allExtendedSettings): Record<string, unknown> => {
    const clientSettings: Record<string, unknown> = {};
    for (const plugin of clientDefaultPlugins) {
      clientSettings[plugin.name] = allExtendedSettings[plugin.name];
    }
    clientSettings.devicestatus = allExtendedSettings.devicestatus;
    return clientSettings;
  };

  return plugins() as NightscoutPluginRegistry;
}
