import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import {
  nightscoutStatus,
  nightscoutWebsocketStatus,
  normalizeConfiguredDisplayUnits,
  normalizePlatformAuthFailDelay,
  normalizeProfileUnits,
  tenantStatusSettings,
} from "../src/status";

const TEST_API_SECRET = "nscf-test-secret-20260717";

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

async function secretDigest(): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(TEST_API_SECRET),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function saveProfile(tenantName: string, profile: Record<string, unknown>): Promise<void> {
  const response = await SELF.fetch(
    `https://example.test/api/v1/profile?tenant=${tenantName}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "api-secret": await secretDigest(),
      },
      body: JSON.stringify(profile),
    },
  );
  expect(response.status).toBe(200);
}

function settingsOf(status: Record<string, unknown>): Record<string, unknown> {
  return status.settings as Record<string, unknown>;
}

describe("locked Nightscout status settings", () => {
  it("matches the v15.0.7 filtered default settings instead of a downstream approximation", () => {
    const status = nightscoutStatus(new Date(0));
    const settings = settingsOf(status);
    expect(settings).toEqual({
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
      showPlugins: "dbsize delta direction upbat",
      showForecast: "ar2",
      focusHours: 3,
      heartbeat: 60,
      baseURL: "",
      authDefaultRoles: "readable",
      thresholds: {
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
      authFailDelay: 5000,
      adminNotifiesEnabled: true,
      authenticationPromptOnLoad: false,
      DEFAULT_FEATURES: [
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
      ],
      alarmTypes: ["predict"],
      enable: [
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
        "ar2",
      ],
    });
    expect(status.authorized).toBeNull();
    expect(Object.keys(status)).toEqual([
      "status",
      "name",
      "version",
      "serverTime",
      "serverTimeEpoch",
      "apiEnabled",
      "careportalEnabled",
      "boluscalcEnabled",
      "settings",
      "extendedSettings",
      "authorized",
      "runtimeState",
    ]);
  });

  it("normalizes configured and persisted unit spellings without guessing unknown profile data", () => {
    expect(normalizeConfiguredDisplayUnits("mmol/L")).toBe("mmol");
    expect(normalizeConfiguredDisplayUnits("MG/DL")).toBe("mg/dl");
    expect(normalizeConfiguredDisplayUnits("unexpected")).toBe("mg/dl");
    expect(normalizeProfileUnits("mmol / L")).toBe("mmol");
    expect(normalizeProfileUnits("mgdl")).toBe("mg/dl");
    expect(normalizeProfileUnits("notmmol")).toBeNull();
    expect(normalizeProfileUnits("unexpected")).toBeNull();
  });

  it("reports the bounded platform auth delay actually enforced", () => {
    expect(normalizePlatformAuthFailDelay(undefined)).toBe(5000);
    expect(normalizePlatformAuthFailDelay("  ")).toBe(5000);
    expect(normalizePlatformAuthFailDelay("-1")).toBe(0);
    expect(normalizePlatformAuthFailDelay("60001")).toBe(60_000);
    expect(normalizePlatformAuthFailDelay("not-a-number")).toBe(5000);
  });
});

describe("tenant status configuration sources", () => {
  it("uses the current profile units when DISPLAY_UNITS is absent across v1 and v2", async () => {
    const name = tenant("status-profile-units");
    await saveProfile(name, {
      defaultProfile: "Default",
      startDate: new Date().toISOString(),
      units: "mmol/L",
      store: { Default: { units: "mg/dl", timezone: "UTC", dia: 3 } },
    });

    for (const version of ["v1", "v2"] as const) {
      const response = await SELF.fetch(
        `https://example.test/api/${version}/status.json?tenant=${name}`,
      );
      expect(response.status).toBe(200);
      const status = await response.json<Record<string, unknown>>();
      expect(settingsOf(status)).toMatchObject({
        units: "mmol",
        authDefaultRoles: "readable",
        authFailDelay: 1,
      });
    }

    const script = await SELF.fetch(
      `https://example.test/api/v2/status.js?tenant=${name}`,
    );
    expect(await script.text()).toContain('"units":"mmol"');
  });

  it("falls back to the selected store profile units and keeps tenants isolated", async () => {
    const mmolTenant = tenant("status-nested-profile");
    const emptyTenant = tenant("status-empty-profile");
    await saveProfile(mmolTenant, {
      defaultProfile: "Child",
      startDate: new Date().toISOString(),
      store: {
        Default: { units: "mg/dl" },
        Child: { units: "MMOL/L", timezone: "Europe/London" },
      },
    });

    const mmol = await (
      await SELF.fetch(`https://example.test/api/v1/status.json?tenant=${mmolTenant}`)
    ).json<Record<string, unknown>>();
    const empty = await (
      await SELF.fetch(`https://example.test/api/v1/status.json?tenant=${emptyTenant}`)
    ).json<Record<string, unknown>>();
    expect(settingsOf(mmol).units).toBe("mmol");
    expect(settingsOf(empty).units).toBe("mg/dl");
  });

  it("gives DISPLAY_UNITS precedence and applies locked configured-threshold semantics", () => {
    const profile = {
      defaultProfile: "Default",
      startDate: new Date().toISOString(),
      units: "mg/dl",
      store: { Default: { units: "mg/dl" } },
    };
    const overrides = tenantStatusSettings({
      DISPLAY_UNITS: "mmol/L",
      AUTH_FAIL_DELAY: "7",
      BG_HIGH: "14",
      BG_TARGET_TOP: "10",
      BG_TARGET_BOTTOM: "4,4",
      BG_LOW: "3",
    }, profile);
    const status = JSON.parse(JSON.stringify(
      nightscoutStatus(new Date(0), "readable", overrides),
    )) as Record<string, unknown>;
    expect(settingsOf(status)).toMatchObject({
      units: "mmol",
      authFailDelay: 7,
      thresholds: {
        bgHigh: 252,
        bgTargetTop: 180,
        bgTargetBottom: 79,
        bgLow: 54,
      },
      alarmTypes: ["simple"],
    });
    expect(settingsOf(status).enable).toContain("simplealarms");
    expect(settingsOf(status).enable).not.toContain("ar2");
    expect(settingsOf(nightscoutWebsocketStatus(
      new Date(0),
      undefined,
      "readable",
      overrides,
    ))).toEqual(settingsOf(status));

    const invalid = JSON.parse(JSON.stringify(nightscoutStatus(
      new Date(0),
      "readable",
      tenantStatusSettings({ BG_HIGH: "not-a-number" }, profile),
    ))) as Record<string, unknown>;
    expect(settingsOf(invalid)).toMatchObject({
      thresholds: { bgHigh: null },
      alarmTypes: ["simple"],
    });

    const empty = nightscoutStatus(
      new Date(0),
      "readable",
      tenantStatusSettings({ BG_HIGH: "  " }, profile),
    );
    expect(settingsOf(empty).thresholds).toEqual({
      bgHigh: 260,
      bgTargetTop: 180,
      bgTargetBottom: 80,
      bgLow: 55,
    });
    expect(settingsOf(empty).alarmTypes).toEqual(["predict"]);
  });
});

describe("v1/v2 status representations", () => {
  it("contains a status RPC failure behind the generic Worker error envelope", async () => {
    const marker = "private-status-rpc-detail";
    const fakeStub = {
      authorizationDelay: async () => 0,
      listDocuments: async () => "[]",
      nightscoutHttpStatus: async () => {
        throw new Error(marker);
      },
    };
    const fakeNamespace = {
      getByName: () => fakeStub,
    };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await worker.fetch(
        new Request("https://example.test/api/v1/status.json?tenant=status-rpc-failure"),
        {
          ASSETS: env.ASSETS,
          ENTRY_STORE: fakeNamespace,
          API_SECRET: TEST_API_SECRET,
          AUTH_DEFAULT_ROLES: "readable",
          AUTH_FAIL_DELAY: "0",
        } as unknown as Parameters<typeof worker.fetch>[1],
      );
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).toBe(
        JSON.stringify({ error: { code: "internal_error", message: "Internal server error" } }),
      );
      expect(body).not.toContain(marker);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("serves the locked explicit representations through both inherited mounts", async () => {
    for (const version of ["v1", "v2"] as const) {
      const html = await SELF.fetch(`https://example.test/api/${version}/status.html`);
      expect(html.status).toBe(200);
      expect(html.headers.get("Content-Type")).toMatch(/^text\/html/);
      expect(html.headers.get("Vary")).toBe("Accept");
      expect(Number(html.headers.get("Content-Length"))).toBe(
        new TextEncoder().encode("<h1>STATUS OK</h1>").byteLength,
      );
      expect(await html.text()).toBe("<h1>STATUS OK</h1>");

      const text = await SELF.fetch(`https://example.test/api/${version}/status.txt`);
      expect(text.status).toBe(200);
      expect(text.headers.get("Content-Type")).toMatch(/^text\/plain/);
      expect(await text.text()).toBe("STATUS OK");

      for (const extension of ["png", "svg"] as const) {
        const redirect = await SELF.fetch(
          `https://example.test/api/${version}/status.${extension}`,
          { redirect: "manual" },
        );
        expect(redirect.status).toBe(302);
        expect(redirect.headers.get("Content-Type")).toBe(
          extension === "png" ? "image/png" : "image/svg+xml",
        );
        expect(redirect.headers.get("Content-Length")).toBe("0");
        expect(redirect.headers.get("Vary")).toBe("Accept");
        expect(redirect.headers.get("Location")).toBe(
          `http://img.shields.io/badge/Nightscout-OK-green.${extension}`,
        );
      }

      const script = await SELF.fetch(`https://example.test/api/${version}/status.js`);
      expect(script.status).toBe(200);
      expect(script.headers.get("Content-Type")).toMatch(/^application\/javascript/);
      expect(script.headers.get("Vary")).toBe("Accept");
      expect(await script.text()).toMatch(/^this\.serverSettings = \{"status":"ok"/);

      const json = await SELF.fetch(`https://example.test/api/${version}/status.json`);
      expect(json.status).toBe(200);
      expect(json.headers.get("Vary")).toBe("Accept");
      expect(await json.json()).toMatchObject({
        status: "ok",
        version: "15.0.7",
        authorized: null,
      });
    }
  });

  it("negotiates the extensionless route and rejects declared but unrendered formats", async () => {
    const json = await SELF.fetch("https://example.test/api/v1/status", {
      headers: { Accept: "application/json" },
    });
    expect(json.status).toBe(200);
    expect(json.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(json.headers.get("Vary")).toBe("Accept");

    const axiosStyle = await SELF.fetch("https://example.test/api/v1/status", {
      headers: { Accept: "application/json, text/plain, */*" },
    });
    expect(axiosStyle.status).toBe(200);
    expect(axiosStyle.headers.get("Content-Type")).toMatch(/^application\/json/);

    const html = await SELF.fetch("https://example.test/api/v1/status", {
      headers: { Accept: "text/html" },
    });
    expect(html.status).toBe(200);
    expect(await html.text()).toBe("<h1>STATUS OK</h1>");

    const negotiatorPriority = await SELF.fetch("https://example.test/api/v1/status", {
      headers: { Accept: "text/*;q=.1,*/*;q=1" },
      redirect: "manual",
    });
    expect(negotiatorPriority.status).toBe(302);
    expect(negotiatorPriority.headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8",
    );
    const redirectBody =
      "Found. Redirecting to http://img.shields.io/badge/Nightscout-OK-green.png";
    expect(negotiatorPriority.headers.get("Content-Length")).toBe(
      String(new TextEncoder().encode(redirectBody).byteLength),
    );
    expect(await negotiatorPriority.text()).toBe(redirectBody);

    const negotiatorPriorityHead = await SELF.fetch(
      "https://example.test/api/v1/status",
      {
        method: "HEAD",
        headers: { Accept: "text/*;q=.1,*/*;q=1" },
        redirect: "manual",
      },
    );
    expect(negotiatorPriorityHead.status).toBe(302);
    expect(negotiatorPriorityHead.headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(negotiatorPriorityHead.headers.get("Content-Length")).toBe(
      negotiatorPriority.headers.get("Content-Length"),
    );
    expect(await negotiatorPriorityHead.text()).toBe("");

    const wildcard = await SELF.fetch("https://example.test/api/v1/status", {
      headers: { Accept: "*/*" },
    });
    expect(wildcard.status).toBe(200);
    expect(wildcard.headers.get("Content-Type")).toMatch(/^text\/html/);

    // negotiator 0.6.3 intentionally does not trim between the q key and `=`.
    const spacedQuality = await SELF.fetch("https://example.test/api/v1/status", {
      headers: { Accept: "text/html;q =.5" },
    });
    expect(spacedQuality.status).toBe(406);

    const csv = await SELF.fetch("https://example.test/api/v1/status.csv");
    expect(csv.status).toBe(406);
    expect(csv.headers.get("Vary")).toBe("Accept");
    expect(await csv.json()).toEqual({ status: 406, message: "Not Acceptable" });

    const unknown = await SELF.fetch("https://example.test/api/v1/status.xml");
    expect(unknown.status).toBe(404);
    const extensionWithSlash = await SELF.fetch("https://example.test/api/v1/status.json/");
    expect(extensionWithSlash.status).toBe(404);
    const unsupportedExtension = await SELF.fetch("https://example.test/api/v1/status.tsv");
    expect(unsupportedExtension.status).toBe(406);
    expect(unsupportedExtension.headers.get("Vary")).toBe("Accept");
    expect(await unsupportedExtension.json()).toEqual({
      status: 406,
      message: "Not Acceptable",
    });
  });

  it("inherits GET as HEAD without returning a body", async () => {
    const get = await SELF.fetch("https://example.test/api/v2/status.json");
    const response = await SELF.fetch("https://example.test/api/v2/status.json", {
      method: "HEAD",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(response.headers.get("Content-Length")).toBe(get.headers.get("Content-Length"));
    expect(Number(response.headers.get("Content-Length"))).toBeGreaterThan(0);
    expect(response.headers.get("Vary")).toBe("Accept");
    expect(await response.text()).toBe("");
  });
});
