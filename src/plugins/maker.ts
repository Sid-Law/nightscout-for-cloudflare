import { nightscoutTimes } from "../runtime/times";

export interface MakerConfiguration {
  key?: string;
  announcementKey?: string;
}

export interface MakerEvent extends Record<string, unknown> {
  name?: string;
  level?: string;
  value1?: unknown;
  value2?: unknown;
  value3?: unknown;
  isAnnouncement?: boolean;
}

export type MakerCallback = (error?: unknown, result?: unknown) => void;
export type MakerRequestTransport = (
  key: string,
  event: MakerEvent,
  eventName: string,
  callback?: MakerCallback,
) => void;

export interface MakerStateStore {
  getLastAllClear: () => number;
  setLastAllClear: (value: number) => void;
}

export interface NightscoutMaker {
  valuesToQuery: (event: MakerEvent) => string;
  sendEvent: (event: MakerEvent, callback: MakerCallback) => void;
  sendAllClear: (event: MakerEvent, callback: MakerCallback) => void;
  makeRequests: (event: MakerEvent, callback: MakerCallback) => void;
  makeKeyRequests: (event: MakerEvent, eventName: string, callback: MakerCallback) => void;
  makeKeyRequest: MakerRequestTransport;
}

function splitKeys(value: string | undefined): string[] | undefined {
  return typeof value === "string" && value.length > 0 ? value.split(" ") : undefined;
}

export function makerValuesToQuery(event: MakerEvent): string {
  let query = "";
  for (let index = 1; index <= 3; index += 1) {
    const name = `value${String(index)}`;
    const value = event[name];
    if (!value) continue;
    query += query.length > 0 ? "&" : "?";
    query += `${name}=${encodeURIComponent(String(value))}`;
  }
  return query;
}

/** Request-local port of locked v15.0.7 lib/plugins/maker.js. */
export function createNightscoutMaker(
  configuration: MakerConfiguration,
  request: MakerRequestTransport,
  now: () => number = Date.now,
  suppliedState?: MakerStateStore,
): NightscoutMaker | null {
  const keys = splitKeys(configuration.key);
  const announcementKeys = splitKeys(configuration.announcementKey) ?? keys;
  if (keys === undefined || keys.length === 0) return null;
  let memoryLastAllClear = 0;
  const state: MakerStateStore = suppliedState ?? {
    getLastAllClear: () => memoryLastAllClear,
    setLastAllClear: (value) => {
      memoryLastAllClear = value;
    },
  };

  const maker = {} as NightscoutMaker;

  maker.valuesToQuery = (event): string => {
    state.setLastAllClear(0);
    return makerValuesToQuery(event);
  };

  maker.makeKeyRequest = request;

  maker.makeKeyRequests = (event, eventName, callback): void => {
    const selectedKeys = event.isAnnouncement ? announcementKeys : keys;
    if (selectedKeys === undefined || selectedKeys.length === 0) {
      callback();
      return;
    }
    let remaining = selectedKeys.length;
    let finished = false;
    for (const key of selectedKeys) {
      maker.makeKeyRequest(key, event, eventName, (error, result) => {
        if (finished) return;
        if (error !== undefined && error !== null) {
          finished = true;
          callback(error);
          return;
        }
        remaining -= 1;
        if (remaining === 0) {
          finished = true;
          callback(undefined, result);
        }
      });
    }
  };

  maker.makeRequests = (event, callback): void => {
    const eventNames = [
      "ns-event",
      `ns-${String(event.level)}`,
      `ns-${String(event.level)}-${String(event.name)}`,
    ];
    let index = 0;
    const next: MakerCallback = (error, result) => {
      if (error !== undefined && error !== null) {
        callback(error);
        return;
      }
      if (index >= eventNames.length) {
        callback(undefined, result);
        return;
      }
      const eventName = eventNames[index++]!;
      maker.makeKeyRequests(event, eventName, next);
    };
    next();
  };

  maker.sendEvent = (event, callback): void => {
    if (!event?.name) {
      callback("No event name found");
      return;
    }
    if (!event.level) {
      callback("No event level found");
      return;
    }
    maker.makeRequests(event, (error, response) => {
      if (error !== undefined && error !== null) {
        callback(error);
        return;
      }
      state.setLastAllClear(0);
      callback(undefined, response);
    });
  };

  maker.sendAllClear = (notification, callback): void => {
    const current = now();
    if (current - state.getLastAllClear() <= nightscoutTimes.mins(30).msecs) {
      callback(undefined, { sent: false });
      return;
    }
    state.setLastAllClear(current);
    maker.makeKeyRequests({
      value1: notification.title || "All Clear",
      value2: notification.message ? `\n${String(notification.message)}` : undefined,
      value3: `\n${String(Math.round(current / 1_000 / 60))}`,
    }, "ns-allclear", (error) => {
      if (error !== undefined && error !== null) {
        state.setLastAllClear(0);
        callback(error);
        return;
      }
      callback(undefined, { sent: true });
    });
  };

  return maker;
}
