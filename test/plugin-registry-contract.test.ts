import { describe, expect, it, vi } from "vitest";
import {
  createDefaultPluginCatalogs,
  createNightscoutPluginRegistry,
  NIGHTSCOUT_CLIENT_PLUGIN_METADATA,
  NIGHTSCOUT_SERVER_PLUGIN_METADATA,
  type NightscoutPlugin,
  type PluginExecutionSandbox,
} from "../src/plugins/registry";

function selected(
  registry: ReturnType<typeof createNightscoutPluginRegistry>,
  name: string,
): NightscoutPlugin | undefined {
  return registry(name) as NightscoutPlugin | undefined;
}

function sandbox(showPlugins = ""): PluginExecutionSandbox {
  const value: PluginExecutionSandbox = {
    showPlugins,
    withExtendedSettings(): PluginExecutionSandbox {
      return value;
    },
  };
  return value;
}

describe("locked Nightscout plugins.test.js", () => {
  it("finds client defaults but excludes the server-only treatment notifier", () => {
    const plugins = createNightscoutPluginRegistry({ settings: {} })
      .registerClientDefaults();

    expect(selected(plugins, "bgnow")?.name).toBe("bgnow");
    expect(selected(plugins, "rawbg")?.name).toBe("rawbg");
    expect(selected(plugins, "treatmentnotify")).toBeUndefined();
  });

  it("finds server defaults but not the locked client-only lookup", () => {
    const plugins = createNightscoutPluginRegistry({ settings: {} })
      .registerServerDefaults();

    expect(selected(plugins, "rawbg")?.name).toBe("rawbg");
    expect(selected(plugins, "treatmentnotify")?.name).toBe("treatmentnotify");
    expect(selected(plugins, "cannulaage")).toBeUndefined();
  });
});

describe("request-local Nightscout plugin registry surface", () => {
  it("keeps the complete static client/server order and enable state isolated", () => {
    expect(NIGHTSCOUT_CLIENT_PLUGIN_METADATA.map(({ name }) => name)).toEqual([
      "bgnow", "rawbg", "direction", "timeago", "upbat", "ar2", "errorcodes",
      "iob", "cob", "careportal", "pump", "openaps", "xdripjs", "loop",
      "override", "bwp", "cage", "sage", "iage", "bage", "basal", "bolus",
      "boluscalc", "profile", "speech", "dbsize",
    ]);
    expect(NIGHTSCOUT_SERVER_PLUGIN_METADATA.map(({ name }) => name)).toEqual([
      "bgnow", "rawbg", "direction", "upbat", "ar2", "simplealarms", "errorcodes",
      "iob", "cob", "pump", "openaps", "xdripjs", "loop", "bwp", "cage",
      "sage", "iage", "bage", "treatmentnotify", "timeago", "basal", "dbsize",
      "runtimestate",
    ]);

    const first = createNightscoutPluginRegistry({
      settings: { enable: ["rawbg", "loop"] },
    }).registerServerDefaults();
    const second = createNightscoutPluginRegistry({
      settings: { enable: ["bgnow"] },
    }).registerServerDefaults();
    expect(first.enabledPluginNames()).toBe("rawbg loop");
    expect(second.enabledPluginNames()).toBe("bgnow");
    expect(selected(first, "bgnow")?.enabled).toBe(false);
    expect(selected(second, "bgnow")?.enabled).toBe(true);

    // Preserve the locked v15.0.7 lodash/find call shape. It is not used as
    // the production enable gate; exact-name lookup remains registry(name).
    expect(first.getPlugin("not-the-name")?.name).toBe("rawbg");
    expect(first.isPluginEnabled("not-the-name")).toBe(true);
    const empty = createNightscoutPluginRegistry({ settings: { enable: [] } })
      .registerServerDefaults();
    expect(empty.getPlugin("rawbg")).toBeUndefined();
    expect(empty.isPluginEnabled("rawbg")).toBe(true);
  });

  it("dispatches enabled hooks in server order and contains individual failures", () => {
    const calls: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const catalogs = createDefaultPluginCatalogs({
      server: {
        bgnow: { setProperties: () => calls.push("property:bgnow") },
        rawbg: {
          setProperties: () => {
            calls.push("property:rawbg");
            throw new Error("raw failure");
          },
        },
        loop: {
          setProperties: () => calls.push("property:loop"),
          checkNotifications: () => calls.push("notify:loop"),
          getEventTypes: () => ["Temporary Target", "Profile Switch"],
          updateVisualisation: () => calls.push("visual:loop"),
        },
      },
    });
    const plugins = createNightscoutPluginRegistry(
      { settings: { enable: ["bgnow", "rawbg", "loop"] } },
      catalogs,
    ).registerServerDefaults();
    const sbx = sandbox("loop");

    plugins.setProperties(sbx);
    plugins.checkNotifications(sbx);
    plugins.updateVisualisations(sbx);

    expect(calls).toEqual([
      "property:bgnow",
      "property:rawbg",
      "property:loop",
      "notify:loop",
      "visual:loop",
    ]);
    expect(error).toHaveBeenCalledOnce();
    expect(plugins.getAllEventTypes(sbx)).toEqual([
      "Temporary Target",
      "Profile Switch",
    ]);
    expect(plugins.shownPlugins(sbx).map(({ name }) => name)).toEqual([
      "bgnow",
      "rawbg",
      "loop",
    ]);
    expect(plugins.hasShownType("pill-status", sbx)).toBe(true);
    error.mockRestore();
  });

  it("filters client extended settings and exposes every public iterator", () => {
    const plugins = createNightscoutPluginRegistry({
      settings: { enable: ["rawbg", "treatmentnotify"] },
    }).registerServerDefaults();
    const all: string[] = [];
    const enabled: string[] = [];
    const shown: string[] = [];
    plugins.eachPlugin((plugin) => all.push(plugin.name));
    plugins.eachEnabledPlugin((plugin) => enabled.push(plugin.name));
    plugins.eachShownPlugins(sandbox(), (plugin) => shown.push(plugin.name));
    expect(all).toHaveLength(23);
    expect(enabled).toEqual(["rawbg", "treatmentnotify"]);
    expect(shown).toEqual(["rawbg"]);

    const client = createNightscoutPluginRegistry({ settings: {} });
    const filtered = client.extendedClientSettings({
      rawbg: { alarm: true },
      treatmentnotify: { ignored: true },
      devicestatus: { advanced: true },
    });
    expect(filtered.rawbg).toEqual({ alarm: true });
    expect(filtered.treatmentnotify).toBeUndefined();
    expect(filtered.devicestatus).toEqual({ advanced: true });
    expect(Object.keys(filtered)).toHaveLength(27);
  });
});
