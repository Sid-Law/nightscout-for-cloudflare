import { describe, expect, it, vi } from "vitest";
import {
  createNightscoutMaker,
  type MakerEvent,
  type MakerRequestTransport,
} from "../src/plugins/maker";
import {
  createNightscoutPushover,
  PUSHOVER_PRIORITY_EMERGENCY,
  type NightscoutPushover,
  type PushoverMessage,
} from "../src/plugins/pushover";
import { NightscoutPushNotify } from "../src/pushnotify";
import { INFO, URGENT, WARN } from "../src/runtime/levels";

function pushover(
  configuration: Parameters<typeof createNightscoutPushover>[0],
  messages: PushoverMessage[],
): NightscoutPushover {
  const plugin = createNightscoutPushover(configuration, (message) => messages.push(message));
  expect(plugin).not.toBeNull();
  return plugin!;
}

describe("locked pushover.test.js contract", () => {
  it("converts a warning to an emergency message with callback and 15-minute retry", () => {
    const messages: PushoverMessage[] = [];
    const plugin = pushover({
      apiToken: "6789",
      userKey: "12345",
      baseURL: "https://nightscout.test",
    }, messages);
    plugin.send({
      title: "Warning, this is a test!",
      level: WARN,
      pushoverSound: "climb",
      plugin: { name: "test" },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      title: "Warning, this is a test!",
      message: undefined,
      priority: PUSHOVER_PRIORITY_EMERGENCY,
      retry: 15 * 60,
      sound: "climb",
      callback: "https://nightscout.test/api/v1/notifications/pushovercallback",
      user: "12345",
    });
  });

  it("converts an urgent notification with its message and two-minute retry", () => {
    const messages: PushoverMessage[] = [];
    const plugin = pushover({ apiToken: "6789", userKey: "12345" }, messages);
    plugin.send({
      title: "Urgent, this is a test!",
      message: "details details details details",
      level: URGENT,
      pushoverSound: "persistent",
      plugin: { name: "test" },
    });
    expect(messages[0]).toMatchObject({
      title: "Urgent, this is a test!",
      message: "details details details details",
      priority: PUSHOVER_PRIORITY_EMERGENCY,
      retry: 2 * 60,
      sound: "persistent",
    });
  });

  it("supports the legacy groupKey fallback", () => {
    const messages: PushoverMessage[] = [];
    const plugin = pushover({ apiToken: "6789", groupKey: "abcd" }, messages);
    plugin.send({
      title: "Warning, this is a test!",
      message: "details details details details",
      level: WARN,
      pushoverSound: "climb",
      plugin: { name: "test" },
      isAnnouncement: true,
    });
    expect(messages[0]).toMatchObject({ user: "abcd", priority: 2, sound: "climb" });
  });

  it("sends an announcement to every space-separated announcement key", () => {
    const messages: PushoverMessage[] = [];
    const plugin = pushover({
      apiToken: "6789",
      userKey: "use announcementKey instead",
      announcementKey: "abcd efgh",
    }, messages);
    plugin.send({
      title: "Warning, this is a test!",
      message: "details details details details",
      level: WARN,
      pushoverSound: "climb",
      plugin: { name: "test" },
      isAnnouncement: true,
    });
    expect(messages.map((message) => message.user)).toEqual(["abcd", "efgh"]);
    expect(messages.every((message) =>
      message.priority === PUSHOVER_PRIORITY_EMERGENCY && message.sound === "climb"
    )).toBe(true);
  });

  it("supports an announcement-only Pushover configuration", () => {
    const messages: PushoverMessage[] = [];
    const plugin = pushover({ apiToken: "6789", announcementKey: "abcd" }, messages);
    plugin.send({
      title: "Warning, this is a test!",
      message: "details details details details",
      level: WARN,
      pushoverSound: "climb",
      plugin: { name: "test" },
      isAnnouncement: true,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.user).toBe("abcd");
  });

  it("does not send a non-announcement when only announcement keys exist", () => {
    const messages: PushoverMessage[] = [];
    const callback = vi.fn();
    const plugin = pushover({ apiToken: "6789", announcementKey: "abcd" }, messages);
    expect(plugin.send({
      title: "Warning, this is a test!",
      message: "details details details details",
      level: WARN,
      pushoverSound: "climb",
      plugin: { name: "test" },
    }, callback)).toBe(0);
    expect(callback).toHaveBeenCalledWith("no-key-defined");
    expect(messages).toEqual([]);
  });
});

describe("locked maker.test.js contract", () => {
  it("turns truthy values into the locked query string", () => {
    const maker = createNightscoutMaker({ key: "12345" }, () => undefined)!;
    expect(maker.valuesToQuery({
      value1: "This is a title",
      value2: "This is the message",
    })).toBe("?value1=This%20is%20a%20title&value2=This%20is%20the%20message");
  });

  it("sends the generic, level and level-name event sequence", () => {
    const eventNames: string[] = [];
    const transport: MakerRequestTransport = (_key, _event, eventName, callback) => {
      eventNames.push(eventName);
      callback?.();
    };
    const maker = createNightscoutMaker({ key: "12345" }, transport)!;
    const callback = vi.fn();
    maker.sendEvent({ name: "test", message: "This is the message", level: "warning" }, callback);
    expect(callback).toHaveBeenCalledWith(undefined, undefined);
    expect(eventNames).toEqual(["ns-event", "ns-warning", "ns-warning-test"]);
  });

  it("rejects an event without a name", () => {
    const maker = createNightscoutMaker({ key: "12345" }, () => undefined)!;
    const callback = vi.fn();
    maker.sendEvent({ level: "warning" }, callback);
    expect(callback).toHaveBeenCalledWith("No event name found");
  });

  it("rejects an event without a level", () => {
    const maker = createNightscoutMaker({ key: "12345" }, () => undefined)!;
    const callback = vi.fn();
    maker.sendEvent({ name: "test" }, callback);
    expect(callback).toHaveBeenCalledWith("No event level found");
  });

  it("sends All Clear only once inside the 30-minute window", () => {
    const eventNames: string[] = [];
    const maker = createNightscoutMaker(
      { key: "12345" },
      (_key, _event, eventName, callback) => {
        eventNames.push(eventName);
        callback?.();
      },
      () => 1_800_001,
    )!;
    const first = vi.fn();
    const second = vi.fn();
    maker.sendAllClear({}, first);
    maker.sendAllClear({}, second);
    expect(first).toHaveBeenCalledWith(undefined, { sent: true });
    expect(second).toHaveBeenCalledWith(undefined, { sent: false });
    expect(eventNames).toEqual(["ns-allclear"]);
  });

  it("sends an announcement to both configured Maker keys", () => {
    const observed: Array<{ key: string; eventName: string; event: MakerEvent }> = [];
    const maker = createNightscoutMaker(
      { key: "use announcementKey instead", announcementKey: "12345 6789" },
      (key, event, eventName, callback) => {
        observed.push({ key, eventName, event });
        callback?.();
      },
    )!;
    maker.sendEvent({ name: "test", level: "warning", isAnnouncement: true }, () => undefined);
    const mostSpecific = observed.filter((item) => item.eventName === "ns-warning-test");
    expect(mostSpecific.map((item) => item.key)).toEqual(["12345", "6789"]);
  });
});

describe("locked pushnotify.test.js contract", () => {
  function fakePushover(
    send: NightscoutPushover["send"],
    cancelWithReceipt: NightscoutPushover["cancelWithReceipt"] = () => undefined,
  ): NightscoutPushover {
    return {
      PRIORITY_NORMAL: 0,
      PRIORITY_EMERGENCY: 2,
      send,
      cancelWithReceipt,
    };
  }

  it("sends one warning alarm and deduplicates the immediate repeat", () => {
    const send = vi.fn<NightscoutPushover["send"]>((_notification, callback) => {
      callback?.(null, JSON.stringify({ receipt: "abcd12345" }));
      return 1;
    });
    const push = new NightscoutPushNotify({ pushover: fakePushover(send) });
    const notification = {
      title: "Warning, this is a test!",
      message: "details details details details",
      level: WARN,
      pushoverSound: "climb",
      plugin: { name: "test" },
    };
    push.emitNotification(notification);
    push.emitNotification(notification);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe(notification);
  });

  it("sends one informational notification and deduplicates its content hash", () => {
    const send = vi.fn<NightscoutPushover["send"]>((_notification, callback) => {
      callback?.(null, JSON.stringify({}));
      return 1;
    });
    const push = new NightscoutPushNotify({ pushover: fakePushover(send) });
    const notification = {
      title: "Sent from a test",
      message: "details details details details",
      level: INFO,
      plugin: { name: "test" },
    };
    push.emitNotification(notification);
    push.emitNotification({ ...notification });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("cancels the stored emergency receipt when All Clear is emitted", () => {
    const cancel = vi.fn<NightscoutPushover["cancelWithReceipt"]>((receipt, callback) => {
      expect(receipt).toBe("abcd12345");
      callback?.(null);
    });
    const push = new NightscoutPushNotify({
      pushover: fakePushover((_notification, callback) => {
        callback?.(null, JSON.stringify({ receipt: "abcd12345" }));
        return 1;
      }, cancel),
    });
    push.emitNotification({
      title: "Warning, this is a test!",
      message: "details details details details",
      level: WARN,
      pushoverSound: "climb",
      plugin: { name: "test" },
    });
    push.emitNotification({ clear: true });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
