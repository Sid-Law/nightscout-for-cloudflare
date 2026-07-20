import type { RealtimeDocument } from "./realtime/ddata-snapshot";
import { INFO, URGENT, WARN, levelToDisplay } from "./runtime/levels";

const DEFAULT_GROUP = "default";
const DEFAULT_SILENCE_MS = 30 * 60 * 1_000;

export interface NotificationAlarmState {
  level: number;
  group: string;
  lastAckAt: number;
  silenceTime: number;
  lastEmitAt: number | null;
}

export interface NotificationAlarmStore {
  alarmState(level: number, group: string): NotificationAlarmState;
  alarmGroups(): string[];
  markAlarmEmitted(level: number, group: string, lastUpdated: number): boolean;
  ackAlarm(level: number, group: string, silenceTime: number, now: number): boolean;
}

export interface NotificationProcessResult {
  acceptedNotifications: number;
  acceptedSnoozes: number;
  emitted: RealtimeDocument[];
}

function notificationGroup(document: RealtimeDocument): string {
  return typeof document.group === "string" && document.group.length > 0
    ? document.group
    : DEFAULT_GROUP;
}

function numberProperty(document: RealtimeDocument, key: string): number {
  return typeof document[key] === "number" ? document[key] : Number.NaN;
}

/** Request-local in-memory store used by the exact upstream module contract. */
export class MemoryNotificationAlarmStore implements NotificationAlarmStore {
  private readonly states = new Map<string, NotificationAlarmState>();

  private key(level: number, group: string): string {
    return `${String(level)}-${group}`;
  }

  alarmState(level: number, group: string): NotificationAlarmState {
    return this.states.get(this.key(level, group)) ?? {
      level,
      group,
      lastAckAt: 0,
      silenceTime: DEFAULT_SILENCE_MS,
      lastEmitAt: null,
    };
  }

  alarmGroups(): string[] {
    return [...new Set([...this.states.values()].map((state) => state.group))];
  }

  markAlarmEmitted(level: number, group: string, lastUpdated: number): boolean {
    this.states.set(this.key(level, group), {
      ...this.alarmState(level, group),
      lastEmitAt: lastUpdated,
    });
    return true;
  }

  ackAlarm(level: number, group: string, silenceTime: number, now: number): boolean {
    const state = this.alarmState(level, group);
    if (now < state.lastAckAt + state.silenceTime) return false;
    this.states.set(this.key(level, group), {
      ...state,
      lastAckAt: now,
      silenceTime,
      lastEmitAt: null,
    });
    if (level === URGENT) this.ackAlarm(WARN, group, silenceTime, now);
    return true;
  }

  reset(): void {
    this.states.clear();
  }
}

/**
 * Request-local port of locked lib/notifications.js. The request arrays are
 * ephemeral; alarm ACK, silence and last-emission state live behind the store
 * interface so the Durable Object adapter can persist them in SQLite.
 */
export class NightscoutNotificationEngine {
  private notifications: RealtimeDocument[] = [];
  private snoozes: RealtimeDocument[] = [];

  constructor(
    private readonly store: NotificationAlarmStore,
    private readonly emit: (notification: RealtimeDocument) => void,
    private readonly now: () => number = Date.now,
  ) {}

  initRequests(): void {
    this.notifications = [];
    this.snoozes = [];
  }

  requestNotify(notification: RealtimeDocument): boolean {
    if (
      !Object.prototype.hasOwnProperty.call(notification, "level")
      || !notification.title
      || !notification.message
      || !notification.plugin
    ) return false;
    notification.group = notificationGroup(notification);
    this.notifications.push(notification);
    return true;
  }

  requestSnooze(snooze: RealtimeDocument): boolean {
    if (!snooze.level || !snooze.title || !snooze.message || !snooze.lengthMills) {
      return false;
    }
    snooze.group = notificationGroup(snooze);
    this.snoozes.push(snooze);
    return true;
  }

  findHighestAlarm(group = DEFAULT_GROUP): RealtimeDocument | undefined {
    const matches = this.notifications.filter((notification) =>
      notification.group === group
    );
    return matches.find((notification) => notification.level === URGENT)
      ?? matches.find((notification) => notification.level === WARN);
  }

  findUnSnoozeable(): RealtimeDocument[] {
    return this.notifications.filter((notification) =>
      numberProperty(notification, "level") <= INFO || Boolean(notification.isAnnouncement)
    );
  }

  snoozedBy(notification: RealtimeDocument): RealtimeDocument | undefined {
    if (notification.isAnnouncement) return undefined;
    const eligible = this.snoozes
      .filter((snooze) =>
        snooze.group === notification.group
        && numberProperty(snooze, "level") >= numberProperty(notification, "level")
      )
      .sort((left, right) =>
        numberProperty(left, "lengthMills") - numberProperty(right, "lengthMills")
      );
    return eligible.at(-1);
  }

  process(lastUpdated: number): NotificationProcessResult {
    const emitted: RealtimeDocument[] = [];
    const output = (notification: RealtimeDocument): void => {
      emitted.push(notification);
      this.emit(notification);
    };
    const groups = [...new Set([
      ...this.notifications.map(notificationGroup),
      ...this.store.alarmGroups(),
    ])];
    if (groups.length === 0) groups.push(DEFAULT_GROUP);

    for (const group of groups) {
      const highest = this.findHighestAlarm(group);
      if (highest === undefined) {
        this.autoAckAlarms(group, output);
        continue;
      }
      const snooze = this.snoozedBy(highest);
      if (snooze === undefined) {
        this.emitNotification(highest, lastUpdated, output);
      } else {
        const level = numberProperty(snooze, "level");
        const silenceTime = numberProperty(snooze, "lengthMills");
        if (this.store.ackAlarm(level, group, silenceTime, this.now())) {
          output({
            clear: true,
            title: "All Clear",
            message: `${group} - ${levelToDisplay(level)} was ack'd`,
            group,
          });
        }
      }
    }

    for (const notification of this.findUnSnoozeable()) {
      this.emitNotification(notification, lastUpdated, output);
    }
    return {
      acceptedNotifications: this.notifications.length,
      acceptedSnoozes: this.snoozes.length,
      emitted,
    };
  }

  private emitNotification(
    notification: RealtimeDocument,
    lastUpdated: number,
    output: (notification: RealtimeDocument) => void,
  ): void {
    const level = numberProperty(notification, "level");
    const group = notificationGroup(notification);
    const state = this.store.alarmState(level, group);
    if (lastUpdated <= state.lastAckAt + state.silenceTime) return;
    if (!this.store.markAlarmEmitted(level, group, lastUpdated)) return;
    output(notification);
  }

  private autoAckAlarms(
    group: string,
    output: (notification: RealtimeDocument) => void,
  ): void {
    let sendClear = false;
    for (const level of [WARN, URGENT]) {
      if (this.store.alarmState(level, group).lastEmitAt === null) continue;
      this.store.ackAlarm(level, group, 1, this.now());
      sendClear = true;
    }
    if (sendClear) {
      output({
        clear: true,
        title: "All Clear",
        message: "Auto ack'd alarm(s)",
        group,
      });
    }
  }
}
