import { createHash } from "node:crypto";
import { isAlarmLevel, levelToLowerCase } from "./runtime/levels";
import { nightscoutTimes } from "./runtime/times";
import type {
  NightscoutPushover,
  PushoverNotification,
} from "./plugins/pushover";
import type { MakerEvent, NightscoutMaker } from "./plugins/maker";

export interface PushNotification extends PushoverNotification {
  clear?: boolean;
  notifyhash?: string;
  eventName?: string;
  group?: string;
  key?: string;
  plugin?: { name?: string };
}

export interface PushNotificationSettings {
  isAlarmEventEnabled: (notification: PushNotification) => boolean;
  snoozeFirstMinsForAlarmEvent: (notification: PushNotification) => unknown;
}

export interface PushNotificationAcknowledgements {
  ack: (
    level: number,
    group: string | undefined,
    silenceTimeMs: number,
    fromPushover: boolean,
  ) => void;
}

export interface PushNotifyOptions {
  settings?: PushNotificationSettings;
  notifications?: PushNotificationAcknowledgements;
  pushover?: NightscoutPushover | null;
  maker?: NightscoutMaker | null;
  state?: PushNotificationStateStore;
  now?: () => number;
}

interface ExpiringValue<T> {
  value: T;
  expiresAt: number;
}

export interface PushNotificationStateStore {
  hasRecent: (key: string, now: number) => boolean;
  putRecent: (key: string, notification: PushNotification, expiresAt: number) => void;
  receiptKeys: (now: number) => string[];
  getReceipt: (receipt: string, now: number) => PushNotification | null;
  putReceipt: (receipt: string, notification: PushNotification, expiresAt: number) => void;
  deleteReceipt: (receipt: string) => void;
  prune: (now: number) => void;
}

export class MemoryPushNotificationStateStore implements PushNotificationStateStore {
  private readonly recentlySent = new Map<string, ExpiringValue<PushNotification>>();
  private readonly receipts = new Map<string, ExpiringValue<PushNotification>>();

  hasRecent(key: string, now: number): boolean {
    const found = this.recentlySent.get(key);
    if (found === undefined) return false;
    if (found.expiresAt <= now) {
      this.recentlySent.delete(key);
      return false;
    }
    return true;
  }

  putRecent(key: string, notification: PushNotification, expiresAt: number): void {
    this.recentlySent.set(key, { value: structuredClone(notification), expiresAt });
  }

  receiptKeys(now: number): string[] {
    this.prune(now);
    return [...this.receipts.keys()];
  }

  getReceipt(receipt: string, now: number): PushNotification | null {
    const found = this.receipts.get(receipt);
    if (found === undefined) return null;
    if (found.expiresAt <= now) {
      this.receipts.delete(receipt);
      return null;
    }
    return structuredClone(found.value);
  }

  putReceipt(receipt: string, notification: PushNotification, expiresAt: number): void {
    this.receipts.set(receipt, { value: structuredClone(notification), expiresAt });
  }

  deleteReceipt(receipt: string): void {
    this.receipts.delete(receipt);
  }

  prune(now: number): void {
    for (const [key, value] of this.recentlySent) {
      if (value.expiresAt <= now) this.recentlySent.delete(key);
    }
    for (const [key, value] of this.receipts) {
      if (value.expiresAt <= now) this.receipts.delete(key);
    }
  }
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function notificationHash(notification: PushNotification): string {
  return sha1(JSON.stringify({
    ...(notification.title === undefined ? {} : { title: notification.title }),
    ...(notification.message === undefined ? {} : { message: notification.message }),
  }));
}

function numericMinutes(value: unknown): number {
  if (Array.isArray(value)) return Number(value[0]);
  return Number(value);
}

/**
 * Request-local Workers port of locked v15.0.7 lib/server/pushnotify.js.
 * Its cache maps are intentionally instance-owned. A future live provider
 * adapter can supply a SQLite-backed facade without changing these contracts.
 */
export class NightscoutPushNotify {
  private readonly now: () => number;
  private readonly state: PushNotificationStateStore;

  constructor(private readonly options: PushNotifyOptions) {
    this.now = options.now ?? Date.now;
    this.state = options.state ?? new MemoryPushNotificationStateStore();
  }

  emitNotification(notification: PushNotification): void {
    this.cleanup();
    if (notification.clear) {
      this.cancelPushoverNotifications();
      this.sendMakerAllClear(notification);
      return;
    }

    const key = this.notificationKey(notification);
    notification.key = key;
    if (this.state.hasRecent(key, this.now())) return;
    if (this.options.settings?.isAlarmEventEnabled(notification) === false) return;

    this.state.putRecent(
      key,
      notification,
      this.now() + nightscoutTimes.secs(30).msecs,
    );
    this.sendPushoverNotification(notification);
    this.sendMakerEvent(notification);
  }

  pushoverAck(response: Record<string, unknown>): boolean {
    this.cleanup();
    const receipt = response.receipt;
    if (typeof receipt !== "string" || receipt.length === 0) return false;
    const notification = this.state.getReceipt(receipt, this.now());
    if (notification === null) return false;
    const snoozeMinutes = numericMinutes(
      this.options.settings?.snoozeFirstMinsForAlarmEvent(notification),
    );
    this.options.notifications?.ack(
      Number(notification.level),
      notification.group,
      nightscoutTimes.mins(snoozeMinutes).msecs,
      true,
    );
    this.state.deleteReceipt(receipt);
    return true;
  }

  private notificationKey(notification: PushNotification): string {
    if (notification.notifyhash) return notification.notifyhash;
    if (notification.isAnnouncement || !isAlarmLevel(notification.level)) {
      return notificationHash(notification);
    }
    return `${String(notification.plugin?.name)}_${String(notification.level)}`;
  }

  private extendRecent(notification: PushNotification): void {
    const key = notification.key;
    if (!key) return;
    this.state.putRecent(
      key,
      notification,
      this.now() + nightscoutTimes.mins(15).msecs,
    );
  }

  private sendPushoverNotification(notification: PushNotification): void {
    this.options.pushover?.send(notification, (error, rawResult) => {
      if (error !== undefined && error !== null || typeof rawResult !== "string") return;
      let result: unknown;
      try {
        result = JSON.parse(rawResult) as unknown;
      } catch {
        return;
      }
      this.extendRecent(notification);
      if (
        typeof result === "object"
        && result !== null
        && !Array.isArray(result)
        && typeof (result as Record<string, unknown>).receipt === "string"
      ) {
        this.state.putReceipt(
          (result as Record<string, unknown>).receipt as string,
          notification,
          this.now() + nightscoutTimes.hour().msecs,
        );
      }
    });
  }

  private sendMakerEvent(notification: PushNotification): void {
    if (!this.options.maker) return;
    const name = notification.eventName || notification.plugin?.name;
    const event: MakerEvent = {
      ...(name === undefined ? {} : { name }),
      level: levelToLowerCase(notification.level),
      ...(notification.title === undefined ? {} : { value1: notification.title }),
      ...(notification.message ? { value2: `\n${String(notification.message)}` } : {}),
      ...(notification.isAnnouncement === undefined
        ? {}
        : { isAnnouncement: notification.isAnnouncement }),
    };
    this.options.maker.sendEvent(event, (error) => {
      if (error === undefined || error === null) this.extendRecent(notification);
    });
  }

  private cancelPushoverNotifications(): void {
    if (!this.options.pushover) return;
    for (const receipt of this.state.receiptKeys(this.now())) {
      this.options.pushover.cancelWithReceipt(receipt, (error) => {
        if (error === undefined || error === null) this.state.deleteReceipt(receipt);
      });
    }
  }

  private sendMakerAllClear(notification: PushNotification): void {
    this.options.maker?.sendAllClear({
      ...(notification.title === undefined ? {} : { title: notification.title }),
      ...(notification.message === undefined ? {} : { message: notification.message }),
    }, () => undefined);
  }

  private cleanup(): void {
    this.state.prune(this.now());
  }
}
