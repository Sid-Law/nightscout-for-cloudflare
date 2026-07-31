import { describe, expect, it } from "vitest";
import type { RealtimeDocument } from "../src/realtime/ddata-snapshot";
import {
  LOOP_INTENTS,
  calculateLoopProperty,
  loopForecastAssistantResponse,
  loopLastAssistantResponse,
  loopNotification,
  loopVisualization,
  type LoopProperty,
} from "../src/plugins/loop";
import { calculatePluginProperties } from "../src/plugins/properties";
import { URGENT } from "../src/runtime/levels";
import { tenantStatusSettings } from "../src/status";

const statuses: RealtimeDocument[] = [
  {
    created_at: "2016-08-13T20:09:15Z",
    mills: Date.parse("2016-08-13T20:09:15Z"),
    device: "loop://ExamplePhone",
    loop: {
      enacted: {
        timestamp: "2016-08-13T20:09:15Z",
        rate: 0.875,
        duration: 30,
        received: true,
      },
      version: "0.9.1",
      recommendedBolus: 0,
      timestamp: "2016-08-13T20:09:15Z",
      predicted: {
        startDate: "2016-08-13T20:03:47Z",
        values: [149, 149, 148, 148, 147, 147],
      },
      iob: {
        timestamp: "2016-08-13T20:05:00Z",
        iob: 0.1733152537837709,
      },
      name: "Loop",
    },
  },
  {
    created_at: "2016-08-13T20:04:15Z",
    mills: Date.parse("2016-08-13T20:04:15Z"),
    device: "loop://ExamplePhone",
    loop: {
      version: "0.9.1",
      recommendedBolus: 0,
      timestamp: "2016-08-13T20:04:15Z",
      failureReason: "SomeError",
      name: "Loop",
    },
  },
  {
    created_at: "2016-08-13T01:13:20Z",
    mills: Date.parse("2016-08-13T01:13:20Z"),
    device: "loop://ExamplePhone",
    loop: {
      timestamp: "2016-08-13T01:18:20Z",
      version: "0.9.1",
      iob: { timestamp: "2016-08-13T01:15:00Z", iob: -0.1205140849137931 },
      name: "Loop",
    },
  },
  {
    created_at: "2016-08-13T01:13:20Z",
    mills: Date.parse("2016-08-13T01:13:20Z"),
    device: "loop://ExamplePhone",
    loop: {
      timestamp: "2016-08-13T01:13:20Z",
      version: "0.9.1",
      iob: { timestamp: "2016-08-13T01:10:00Z", iob: -0.1205140849137931 },
      failureReason:
        "StaleDataError(\"Glucose Date: 2016-08-12 23:23:49 +0000 or Pump status date: 2016-08-13 01:13:10 +0000 older than 15.0 min\")",
      name: "Loop",
    },
  },
  {
    created_at: "2016-08-13T01:13:15Z",
    mills: Date.parse("2016-08-13T01:13:15Z"),
    device: "loop://ExamplePhone",
    pump: {
      reservoir: 90.5,
      clock: "2016-08-13T01:13:10Z",
      battery: { status: "normal", voltage: 1.5 },
      pumpID: "543204",
    },
    uploader: {
      timestamp: "2016-08-13T01:13:15Z",
      battery: 43,
      name: "ExamplePhone",
    },
  },
];

function cloneStatuses(): RealtimeDocument[] {
  return JSON.parse(JSON.stringify(statuses)) as RealtimeDocument[];
}

describe("locked Nightscout loop.test.js", () => {
  const now = Date.parse("2016-08-13T20:09:15Z");

  it("should set the property and update the pill and add forecast points", () => {
    const input = cloneStatuses();
    const properties = calculatePluginProperties(
      { sgvs: [], cals: [], devicestatus: input },
      "mg/dl",
      now,
      new Set(["loop"]),
    );
    const property = properties.loop as LoopProperty;
    expect(property.display).toEqual({ symbol: "⌁", code: "enacted", label: "Enacted" });

    const visual = loopVisualization(property, input, now);
    expect(visual.pill.label).toBe("Loop ⌁");
    expect(visual.pill.value).toBe("1m ago ↝ 147");
    expect(visual.pill.info[0]).toEqual({
      label: "1m ago",
      value:
        "<b>Temp Basal Started</b> 0.88U/hour for 30m, IOB: 0.17U, Predicted Min-Max BG: 147-149, Eventual BG: 147",
    });
    expect(visual.forecastPoints).toHaveLength(6);
    expect(visual.forecastInfo).toEqual({ type: "loop", label: "Loop Forecasts" });
  });

  it("should show errors", () => {
    const errorTime = Date.parse("2016-08-13T20:04:15Z");
    const input = cloneStatuses();
    const property = calculateLoopProperty(input, errorTime);
    expect(property.display).toEqual({ symbol: "x", code: "error", label: "Error" });

    const visual = loopVisualization(property, input, errorTime);
    expect(visual.pill.label).toBe("Loop x");
    expect(visual.pill.value).toBe("1m ago");
    expect(visual.pill.info[0]).toEqual({ label: "1m ago", value: "Error: SomeError" });
  });

  it("should check the recieved flag to see if it was received", () => {
    const input = cloneStatuses();
    const newestLoop = input[0]!.loop as RealtimeDocument;
    (newestLoop.enacted as RealtimeDocument).received = false;
    const property = calculateLoopProperty(input, now);
    expect(property.display.symbol).toBe("x");
    expect(property.display.code).toBe("error");
  });

  it("should generate an alert for a stuck loop", () => {
    const checkTime = now + 2 * 60 * 60 * 1_000;
    const property = calculateLoopProperty(cloneStatuses(), checkTime, {
      enableAlerts: "TRUE",
    });
    const notification = loopNotification(property, checkTime, {
      enableAlerts: "TRUE",
    });
    expect(notification?.level).toBe(URGENT);
    expect(notification?.title).toBe("Loop isn't looping");
    expect(notification?.group).toBe("Loop");
  });

  it("should handle virtAsst requests", () => {
    const property = calculateLoopProperty(cloneStatuses(), now);
    expect(LOOP_INTENTS).toHaveLength(2);
    expect(loopForecastAssistantResponse(property, now)).toEqual({
      title: "Loop Forecast",
      response:
        "According to the loop forecast you are expected to be between 147 and 149 over the next in 25 minutes",
    });
    expect(loopLastAssistantResponse(property, now)).toEqual({
      title: "Last Loop",
      response: "The last successful loop was a few seconds ago",
    });
  });
});

describe("Workers Loop platform adapter", () => {
  it("maps the locked Loop alert environment only while the plugin is enabled", () => {
    expect(tenantStatusSettings({
      ENABLE: "loop",
      LOOP_ENABLE_ALERTS: "true",
      LOOP_WARN: "20",
      LOOP_URGENT: "40",
    }).extendedSettings).toMatchObject({
      loop: { enableAlerts: true, warn: 20, urgent: 40 },
    });
    expect(tenantStatusSettings({
      LOOP_ENABLE_ALERTS: "true",
      LOOP_WARN: "20",
    }).extendedSettings).not.toHaveProperty("loop");
  });
});
