import { describe, expect, it } from "vitest";
import {
  createNightscoutSandbox,
  type SandboxData,
  type SandboxDdata,
  type SandboxLanguage,
} from "../src/sandbox";

const NOW = 1_784_515_200_000;
const language: SandboxLanguage = {
  translate: (key): unknown => key,
};

function serverDdata(): SandboxDdata {
  const data: SandboxData = {
    sgvs: [],
    profiles: [],
    profileTreatments: [],
    tempbasalTreatments: [],
    combobolusTreatments: [],
  };
  return {
    ...data,
    clone: (): SandboxData => structuredClone(data),
  };
}

/** Complete named-case mapping of locked v15.0.7 tests/sandbox.test.js. */
describe("locked Nightscout plugin sandbox", () => {
  it("init on client", () => {
    const pluginBase = {};
    const data: SandboxData = { sgvs: [{ mgdl: 100, mills: NOW }] };
    const sandbox = createNightscoutSandbox().clientInit({
      settings: {
        units: "mg/dl",
        thresholds: {
          bgHigh: 260,
          bgTargetTop: 180,
          bgTargetBottom: 80,
          bgLow: 55,
        },
      },
      pluginBase,
      language,
    }, NOW, data);

    expect(sandbox.pluginBase).toBe(pluginBase);
    expect(sandbox.data).toBe(data);
    expect(sandbox.lastSGVMgdl()).toBe(100);
    expect(pluginBase).toEqual({ forecastInfos: [], forecastPoints: {} });
  });

  it("init on server", () => {
    const requestNotify = (): void => undefined;
    const sandbox = createNightscoutSandbox().serverInit(
      { settings: { units: "mg/dl" } },
      {
        ddata: serverDdata(),
        notifications: {
          requestNotify,
          process: (): void => undefined,
          ack: (): void => undefined,
        },
        language,
      },
    );
    sandbox.time = NOW;
    sandbox.data.sgvs = [{ mgdl: 100, mills: NOW }];

    expect(sandbox.notifications.requestNotify).toBe(requestNotify);
    expect(sandbox.notifications.process).toBeUndefined();
    expect(sandbox.notifications.ack).toBeUndefined();
    expect(sandbox.lastSGVMgdl()).toBe(100);
    expect(sandbox.data.profiles).toBeUndefined();
    expect(sandbox.data.profile).toBeDefined();
  });

  it("display 39 as LOW and 401 as HIGH", () => {
    const sandbox = createNightscoutSandbox().serverInit(
      { settings: { units: "mg/dl" } },
      { ddata: serverDdata(), language },
    );
    expect(sandbox.displayBg({ mgdl: 39 })).toBe("LOW");
    expect(sandbox.displayBg({ mgdl: "39" })).toBe("LOW");
    expect(sandbox.displayBg({ mgdl: 401 })).toBe("HIGH");
    expect(sandbox.displayBg({ mgdl: "401" })).toBe("HIGH");
  });

  it("build BG Now line using properties", () => {
    const sandbox = createNightscoutSandbox().serverInit(
      { settings: { units: "mg/dl" } },
      { ddata: serverDdata(), language },
    );
    sandbox.time = NOW;
    sandbox.data.sgvs = [{ mgdl: 99, mills: NOW }];
    sandbox.properties = {
      delta: { display: "+5" },
      direction: { value: "FortyFiveUp", label: "↗", entity: "&#8599;" },
    };
    expect(sandbox.buildBGNowLine()).toBe("BG Now: 99 +5 ↗ mg/dl");
  });

  it("build default message using properties", () => {
    const sandbox = createNightscoutSandbox().serverInit(
      { settings: { units: "mg/dl" } },
      { ddata: serverDdata(), language },
    );
    sandbox.time = NOW;
    sandbox.data.sgvs = [{ mgdl: 99, mills: NOW }];
    sandbox.properties = {
      delta: { display: "+5" },
      direction: { value: "FortyFiveUp", label: "↗", entity: "&#8599;" },
      rawbg: { displayLine: "Raw BG: 100 mg/dl" },
      iob: { displayLine: "IOB: 1.25U" },
      cob: { displayLine: "COB: 15g" },
    };
    expect(sandbox.buildDefaultMessage()).toBe(
      "BG Now: 99 +5 ↗ mg/dl\nRaw BG: 100 mg/dl\nIOB: 1.25U\nCOB: 15g",
    );
  });

  it("retains the remaining immutable-property, history, scaling and extended-settings surface", () => {
    const loopSettings = { warn: 45 };
    const settings: Record<string, unknown> = {
      units: "mmol",
      showPlugins: "loop",
      extendedSettings: { loop: loopSettings },
    };
    const sandbox = createNightscoutSandbox().clientInit({
      settings,
      notifications: {
        requestNotify: (): void => undefined,
        requestClear: (): void => undefined,
        unsafe: (): void => undefined,
      },
      language,
    }, NOW, {
      sgvs: [
        { mgdl: 90, mills: NOW - 10_000 },
        { mgdl: 180, mills: NOW - 5_000 },
        { mgdl: 270, mills: NOW + 5_000 },
      ],
    });

    let setterCalls = 0;
    sandbox.offerProperty("first", () => {
      setterCalls += 1;
      return { value: 1 };
    });
    sandbox.offerProperty("first", () => {
      setterCalls += 1;
      return { value: 2 };
    });
    sandbox.offerProperty("empty", () => null);
    expect(setterCalls).toBe(1);
    expect(sandbox.properties).toEqual({ first: { value: 1 } });
    expect(sandbox.lastSGVMgdl()).toBe(180);
    expect(sandbox.prevSGVEntry()?.mgdl).toBe(90);
    expect(sandbox.lastScaledSGV()).toBe(10);
    expect(sandbox.scaleMgdl(90)).toBe(5);
    expect(sandbox.roundBGToDisplayFormat(5.56)).toBe(5.6);
    expect(sandbox.roundInsulinForDisplayFormat(1.239)).toBe("1.23");
    sandbox.properties.roundingStyle = "medtronic";
    expect(sandbox.roundInsulinForDisplayFormat(0.499)).toBe("0.45");
    expect(sandbox.withExtendedSettings({ name: "loop" }).extendedSettings).toBe(loopSettings);
    const updatedLoopSettings = { warn: 30 };
    settings.extendedSettings = { loop: updatedLoopSettings };
    expect(sandbox.withExtendedSettings({ name: "loop" }).extendedSettings).toBe(
      updatedLoopSettings,
    );
    expect(sandbox.notifications.unsafe).toBeUndefined();
    expect(createNightscoutSandbox().properties).toEqual({});
  });
});
