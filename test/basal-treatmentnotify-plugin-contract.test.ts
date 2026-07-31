import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createNightscoutProfileFunctions } from "../src/profile-functions";
import {
  basalAssistantResponse,
  basalVisualization,
  calculateBasalProperty,
} from "../src/plugins/basal";
import { calculatePluginProperties } from "../src/plugins/properties";
import { calculateTreatmentNotificationRequests } from "../src/plugins/treatmentnotify";
import { INFO, URGENT } from "../src/runtime/levels";
import { nightscoutStatus, tenantStatusSettings } from "../src/status";

const BASAL_NOW = Date.parse("2015-06-21T00:00:00.000Z");
const PROFILE_DATA = [{
  timezone: "UTC",
  startDate: "2015-06-21",
  basal: [
    { time: "00:00", value: 0.175 },
    { time: "02:30", value: 0.125 },
    { time: "05:00", value: 0.075 },
    { time: "08:00", value: 0.1 },
    { time: "14:00", value: 0.125 },
    { time: "20:00", value: 0.3 },
    { time: "22:00", value: 0.225 },
  ],
}];

const ALARM_SETTINGS = {
  units: "mg/dl",
  thresholds: {
    bgHigh: 260,
    bgTargetTop: 180,
    bgTargetBottom: 80,
    bgLow: 55,
  },
  alarmUrgentHigh: true,
  alarmHigh: true,
  alarmUrgentLow: true,
  alarmLow: true,
};

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function endpoint(path: string, name: string): string {
  return `https://example.test${path}?tenant=${name}`;
}

describe("locked Nightscout v15.0.7 basal profile plugin", () => {
  it("update basal profile pill", () => {
    const profile = createNightscoutProfileFunctions(structuredClone(PROFILE_DATA));
    const property = calculateBasalProperty(profile, BASAL_NOW);
    expect(property).toMatchObject({ display: "0.175U" });
    expect(basalVisualization(property, profile, BASAL_NOW)).toMatchObject({
      value: "0.175U",
      label: "BASAL",
    });
  });

  it("should handle virtAsst requests", () => {
    const profile = createNightscoutProfileFunctions(structuredClone(PROFILE_DATA));
    expect(basalAssistantResponse(profile, BASAL_NOW)).toEqual({
      title: "Current Basal",
      response: "Your current basal is 0.175 units per hour",
      priority: 1,
    });
  });
});

describe("locked Nightscout v15.0.7 treatmentnotify plugin", () => {
  const now = Date.parse("2026-07-20T08:00:00.000Z");

  it("Request a snooze for a recent treatment and request an info notify", async () => {
    const result = await calculateTreatmentNotificationRequests(
      [{ eventType: "BG Check", glucose: "100", mills: now }],
      [],
      now,
      {},
      ALARM_SETTINGS,
    );
    expect(result.snoozes).toEqual([expect.objectContaining({
      level: URGENT,
      group: "default",
      lengthMills: 600_000,
    })]);
    expect(result.notifications).toEqual([expect.objectContaining({
      level: INFO,
      title: "BG Check",
      group: "default",
      notifyhash: expect.stringMatching(/^[0-9a-f]{40}$/),
    })]);
  });

  it("Not Request a snooze for an older treatment and not request an info notification", async () => {
    expect(await calculateTreatmentNotificationRequests(
      [{ mills: now - 15 * 60_000 }],
      [],
      now,
      {},
      ALARM_SETTINGS,
    )).toEqual({ notifications: [], snoozes: [] });
  });

  it("Request a snooze for a recent calibration and request an info notify", async () => {
    const result = await calculateTreatmentNotificationRequests(
      [{ mills: now - 15 * 60_000 }],
      [{ mgdl: "100", mills: now }],
      now,
      {},
      ALARM_SETTINGS,
    );
    expect(result.snoozes).toHaveLength(1);
    expect(result.notifications).toEqual([expect.objectContaining({
      level: INFO,
      title: "Calibration",
      message: "Meter BG: 100 mg/dl",
      pushoverSound: "magic",
    })]);
  });

  it("Not Request a snooze for an older calibration treatment and not request an info notification", async () => {
    expect(await calculateTreatmentNotificationRequests(
      [{ mills: now - 15 * 60_000 }],
      [{ mgdl: "100", mills: now - 15 * 60_000 }],
      now,
      {},
      ALARM_SETTINGS,
    )).toEqual({ notifications: [], snoozes: [] });
  });

  it("Request a notification for an announcement even there is an active snooze", async () => {
    const result = await calculateTreatmentNotificationRequests(
      [{
        mills: now,
        mgdl: 40,
        eventType: "Announcement",
        isAnnouncement: true,
        notes: "This not an alarm",
      }],
      [],
      now,
      {},
      ALARM_SETTINGS,
    );
    expect(result.snoozes).toEqual([]);
    expect(result.notifications).toEqual([expect.objectContaining({
      title: "Urgent Announcement",
      level: URGENT,
      group: "Announcement",
      pushoverSound: "persistent",
      isAnnouncement: true,
    })]);
  });

  it("Request a notification for a non-error announcement", async () => {
    const result = await calculateTreatmentNotificationRequests(
      [{
        mills: now,
        mgdl: 100,
        eventType: "Announcement",
        isAnnouncement: true,
        notes: "This not an alarm",
      }],
      [],
      now,
      {},
      ALARM_SETTINGS,
    );
    expect(result.notifications).toEqual([expect.objectContaining({
      title: "Announcement",
      level: INFO,
      group: "Announcement",
      isAnnouncement: true,
    })]);
    expect(result.notifications[0]).not.toHaveProperty("pushoverSound");
  });
});

describe("Cloudflare basal/treatmentnotify integration", () => {
  it("serves the default-enabled basal property with active temp-basal context", async () => {
    const name = tenant("basal-property");
    const now = Date.now();
    const store = env.ENTRY_STORE.getByName(name);
    await store.createDocuments("profile", JSON.stringify([{
      defaultProfile: "Default",
      startDate: "2026-01-01T00:00:00.000Z",
      store: {
        Default: {
          timezone: "UTC",
          units: "mg/dl",
          basal: [{ time: "00:00", value: 0.175 }],
          sens: [{ time: "00:00", value: 50 }],
          carbratio: [{ time: "00:00", value: 12 }],
        },
      },
    }]));
    await store.createDocuments("treatments", JSON.stringify([{
      eventType: "Temp Basal",
      absolute: 0.25,
      duration: 30,
      created_at: new Date(now - 5 * 60_000).toISOString(),
    }]));

    const response = await SELF.fetch(endpoint("/api/v2/properties/basal", name));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      basal: expect.objectContaining({
        display: "T: 0.250U",
        current: expect.objectContaining({
          basal: 0.175,
          tempbasal: 0.25,
          totalbasal: 0.25,
        }),
      }),
    });
  });

  it("maps treatmentnotify enable dependencies and official environment settings", () => {
    const overrides = tenantStatusSettings({
      ENABLE: "careportal",
      TREATMENTNOTIFY_SNOOZE_MINS: "12",
      TREATMENTNOTIFY_INCLUDE_BOLUSES_OVER: "0.5",
    });
    expect(overrides.enable).toContain("treatmentnotify");
    expect(overrides.extendedSettings).toMatchObject({
      treatmentnotify: { snoozeMins: 12, includeBolusesOver: 0.5 },
    });
    const status = nightscoutStatus(new Date(), "readable", overrides) as {
      settings: { enable: string[] };
    };
    expect(status.settings.enable).toContain("treatmentnotify");

    const context = {
      sgvs: [],
      cals: [],
      devicestatus: [],
      treatments: [],
      profiles: PROFILE_DATA,
      dbstats: {},
    };
    expect(calculatePluginProperties(
      context,
      "mg/dl",
      BASAL_NOW,
      new Set(["basal"]),
    )).toMatchObject({ basal: { display: "0.175U" } });
  });
});
