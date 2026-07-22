import { isAlarmLevel, URGENT, WARN } from "../runtime/levels";
import { nightscoutTimes } from "../runtime/times";

export const PUSHOVER_PRIORITY_NORMAL = 0;
export const PUSHOVER_PRIORITY_EMERGENCY = 2;

export interface PushoverConfiguration {
  apiToken?: string;
  userKey?: string | false;
  groupKey?: string | false;
  alarmKey?: string | false;
  announcementKey?: string | false;
  baseURL?: string;
}

export interface PushoverNotification extends Record<string, unknown> {
  title?: string;
  message?: string;
  level?: number;
  pushoverSound?: string;
  isAnnouncement?: boolean;
}

export interface PushoverMessage extends Record<string, unknown> {
  expire: number;
  title: unknown;
  message: unknown;
  sound: string;
  timestamp: Date;
  priority: number;
  retry?: number;
  callback?: string;
  user: string;
}

export type PushoverSendCallback = (error: unknown, result?: string) => void;
export type PushoverMessageTransport = (
  message: PushoverMessage,
  callback?: PushoverSendCallback,
) => void;
export type PushoverCancelTransport = (
  receipt: string,
  apiToken: string,
  callback?: (error: unknown, result?: unknown) => void,
) => void;

function keysByType(
  value: string | false | undefined,
  fallback: readonly string[] = [],
): string[] {
  if (value === false) return [];
  return typeof value === "string" && value.length > 0
    ? value.split(" ")
    : [...fallback];
}

export interface NightscoutPushover {
  readonly PRIORITY_NORMAL: typeof PUSHOVER_PRIORITY_NORMAL;
  readonly PRIORITY_EMERGENCY: typeof PUSHOVER_PRIORITY_EMERGENCY;
  send: (notification: PushoverNotification, callback?: PushoverSendCallback) => number;
  cancelWithReceipt: (
    receipt: string,
    callback?: (error: unknown, result?: unknown) => void,
  ) => void;
}

/**
 * Request-local port of locked v15.0.7 lib/plugins/pushover.js.
 * Network I/O is injected so a Durable Object outbox can own retries and
 * persistence without changing the official key/message selection logic.
 */
export function createNightscoutPushover(
  configuration: PushoverConfiguration,
  sendMessage: PushoverMessageTransport,
  cancelReceipt: PushoverCancelTransport = (_receipt, _token, callback) => {
    callback?.("pushover-cancel-transport-not-configured");
  },
  now: () => number = Date.now,
): NightscoutPushover | null {
  const userKeys = (() => {
    const configured = keysByType(configuration.userKey);
    return configured.length > 0
      ? configured
      : keysByType(configuration.groupKey);
  })();
  const alarmKeys = keysByType(configuration.alarmKey, userKeys);
  // Preserve the locked `userKeys || alarmKeys` behavior: an empty array is
  // truthy in JavaScript, so the default is always the user-key array.
  const announcementKeys = keysByType(configuration.announcementKey, userKeys);
  const apiToken = configuration.apiToken;
  if (
    !apiToken
    || (userKeys.length === 0 && alarmKeys.length === 0 && announcementKeys.length === 0)
  ) return null;

  function selectKeys(notification: PushoverNotification): string[] {
    if (notification.isAnnouncement) return announcementKeys;
    if (isAlarmLevel(notification.level)) return alarmKeys;
    return userKeys;
  }

  function prepareMessage(notification: PushoverNotification, user: string): PushoverMessage {
    const message: PushoverMessage = {
      expire: nightscoutTimes.mins(15).secs!,
      title: notification.title,
      message: notification.message,
      sound: notification.pushoverSound ?? "gamelan",
      timestamp: new Date(now()),
      priority: typeof notification.level === "number" && notification.level >= WARN
        ? PUSHOVER_PRIORITY_EMERGENCY
        : PUSHOVER_PRIORITY_NORMAL,
      user,
    };
    if (isAlarmLevel(notification.level)) {
      message.retry = notification.level === URGENT
        ? nightscoutTimes.mins(2).secs!
        : nightscoutTimes.mins(15).secs!;
      if (configuration.baseURL) {
        message.callback = `${configuration.baseURL}/api/v1/notifications/pushovercallback`;
      }
    }
    return message;
  }

  return {
    PRIORITY_NORMAL: PUSHOVER_PRIORITY_NORMAL,
    PRIORITY_EMERGENCY: PUSHOVER_PRIORITY_EMERGENCY,
    send(notification, callback): number {
      const selectedKeys = selectKeys(notification);
      if (selectedKeys.length === 0) {
        callback?.("no-key-defined");
        return 0;
      }
      for (const key of selectedKeys) {
        sendMessage(prepareMessage(notification, key), callback);
      }
      return selectedKeys.length;
    },
    cancelWithReceipt(receipt, callback): void {
      cancelReceipt(receipt, apiToken, callback);
    },
  };
}
