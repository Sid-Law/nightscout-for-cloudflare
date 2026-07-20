import {
  ProtocolError,
  createEngineIoV4HandshakePacket,
  createSocketIoV5ServerConnectPacket,
  decodeEngineIoV4Packet,
  decodeEngineIoV4PollingPayload,
  encodeEngineIoV4Packet,
  encodeEngineIoV4PollingPayload,
  wrapSocketIoV5Packet,
  unwrapSocketIoV5Packet,
  type EngineIoV4Packet,
  type SocketIoV5EventPacket,
  type SocketIoV5Packet,
} from "../protocol";
import type {
  Api3CollectionName,
  Api3RealtimeMutationEvent,
} from "../document-repository";
import {
  calculateRealtimeDelta,
  type RealtimeDeltaDocument,
  type RealtimeDeltaState,
} from "./calcdelta";
import {
  REALTIME_CLEANUP_BATCH,
  REALTIME_MAX_ALARM_GROUP_CHARACTERS,
  REALTIME_MAX_PAYLOAD_BYTES,
  REALTIME_PING_INTERVAL_MS,
  REALTIME_PING_TIMEOUT_MS,
  REALTIME_POLL_LEASE_MS,
  REALTIME_POST_LEASE_MS,
  REALTIME_TRANSPORT,
  REALTIME_WEBSOCKET_TRANSPORT,
  type RealtimeTransport,
} from "./constants";
import {
  createRealtimeSocketId,
  RealtimeRepositoryError,
  SqliteRealtimeSessionRepository,
  type RealtimeSession,
  type RealtimeWebSocketClosure,
  type RealtimeWebSocketClosureRetry,
} from "./session-repository";

export interface RealtimeAuthorization {
  read: boolean;
  write: boolean;
  write_treatment: boolean;
}

export type RealtimeRootWriteCollection =
  | "activity"
  | "devicestatus"
  | "entries"
  | "food"
  | "profile"
  | "treatments";

export type RealtimeRootWriteRequest =
  | {
      event: "dbAdd";
      collection: RealtimeRootWriteCollection;
      data: unknown;
      receivedAt: number;
    }
  | {
      event: "dbUpdate" | "dbUpdateUnset";
      collection: RealtimeRootWriteCollection;
      id: string;
      data: unknown;
      receivedAt: number;
    }
  | {
      event: "dbRemove";
      collection: RealtimeRootWriteCollection;
      id: string;
      receivedAt: number;
    };

export interface RealtimeRootWriteResult {
  acknowledgement: unknown;
  changed: boolean;
}

export type RealtimeAlarmAuthorization =
  | { mode: "accessToken" }
  | { mode: "web"; read: boolean; ack: boolean };

export interface RealtimeSnapshot {
  devicestatus: unknown[];
  sgvs: unknown[];
  cals: unknown[];
  profiles: unknown[];
  mbgs: unknown[];
  food: unknown[];
  treatments: unknown[];
  dbstats: Record<string, unknown>;
  status?: Record<string, unknown>;
}

export interface RealtimeServiceOptions {
  now?: () => number;
  pollWaitMs?: number;
  authorize?: (message: Record<string, unknown>) =>
    | RealtimeAuthorization
    | null
    | Promise<RealtimeAuthorization | null>;
  authorizeStorage?: (message: Record<string, unknown>) =>
    | readonly Api3CollectionName[]
    | null
    | Promise<readonly Api3CollectionName[] | null>;
  authorizeAlarm?: (message: Record<string, unknown>) =>
    | RealtimeAlarmAuthorization
    | null
    | Promise<RealtimeAlarmAuthorization | null>;
  writeRoot?: (request: RealtimeRootWriteRequest) =>
    | RealtimeRootWriteResult
    | Promise<RealtimeRootWriteResult>;
  snapshot?: (now: number) => RealtimeSnapshot | null;
  retroDeviceStatus?: (now: number) => unknown[] | null;
  status?: (now: number) => Record<string, unknown>;
}

export class RealtimeSessionError extends Error {
  constructor(
    readonly code:
      | "unknown_sid"
      | "overlap"
      | "bad_packet"
      | "capacity"
      | "queue_overflow"
      | "invalid_post_lease",
    message: string,
  ) {
    super(message);
    this.name = "RealtimeSessionError";
  }
}

interface PollWaiter {
  token: string;
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

interface RealtimeAlarmAcknowledgement {
  level: number;
  group: string;
  silenceTime: number;
}

interface RealtimeRootMutationState {
  changed: boolean;
}

function cloneSession(session: RealtimeSession): RealtimeSession {
  return { ...session };
}

function defaultSnapshot(_now: number): RealtimeSnapshot {
  return {
    devicestatus: [],
    sgvs: [],
    cals: [],
    profiles: [],
    mbgs: [],
    food: [],
    treatments: [],
    dbstats: {},
  };
}

function defaultAuthorization(message: Record<string, unknown>): RealtimeAuthorization | null {
  const credential = message.secret ?? message.token;
  // Nightscout's locked default role is readable. Explicit credentials must
  // be resolved by the tenant authorization adapter; they are never silently
  // treated as anonymous or valid.
  return credential === undefined || credential === null || credential === ""
    ? { read: true, write: false, write_treatment: false }
    : null;
}

function defaultStorageAuthorization(
  _message: Record<string, unknown>,
): readonly Api3CollectionName[] | null {
  return null;
}

function defaultAlarmAuthorization(
  message: Record<string, unknown>,
): RealtimeAlarmAuthorization | null {
  if (message.accessToken) return null;
  const credential = message.secret ?? message.jwtToken;
  return credential === undefined || credential === null || credential === ""
    ? { mode: "web", read: true, ack: false }
    : null;
}

function defaultRootWrite(request: RealtimeRootWriteRequest): RealtimeRootWriteResult {
  return {
    acknowledgement: request.event === "dbAdd" ? [] : { result: "success" },
    changed: false,
  };
}

const REALTIME_ROOT_WRITE_COLLECTIONS: readonly RealtimeRootWriteCollection[] = [
  "treatments",
  "entries",
  "devicestatus",
  "profile",
  "food",
  "activity",
];

function realtimeRootWriteCollection(value: unknown): RealtimeRootWriteCollection | null {
  return typeof value === "string"
      && REALTIME_ROOT_WRITE_COLLECTIONS.includes(value as RealtimeRootWriteCollection)
    ? value as RealtimeRootWriteCollection
    : null;
}

function realtimeRootWriteId(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return null;
  return value;
}

function alarmLevelDisplay(level: number): string {
  switch (level) {
    case 2: return "Urgent";
    case 1: return "Warning";
    case 0: return "Info";
    case -1: return "Low";
    case -2: return "Lowest";
    case -3: return "None";
    default: return "Unknown";
  }
}

function alarmEventName(notification: Record<string, unknown>): string {
  if (notification.clear) return "clear_alarm";
  if (notification.level === 1) return "alarm";
  if (notification.level === 2) return "urgent_alarm";
  if (notification.isAnnouncement) return "announcement";
  return "notification";
}

function normalizeAlarmAcknowledgement(
  level: number,
  group: string,
  rawSilenceTime: number,
): RealtimeAlarmAcknowledgement | null {
  if (
    !Number.isSafeInteger(level)
    || level < -3
    || level > 2
    || typeof group !== "string"
    || group.length === 0
    || group.length > REALTIME_MAX_ALARM_GROUP_CHARACTERS
  ) {
    return null;
  }
  let silenceTime = 30 * 60 * 1_000;
  // Locked notifications.ack() uses the default for every falsy value,
  // including 0 and NaN. A truthy value must fit SQLite's integer contract.
  if (rawSilenceTime) {
    if (!Number.isSafeInteger(rawSilenceTime)) return null;
    silenceTime = rawSilenceTime;
  }
  return { level, group, silenceTime };
}

function randomLeaseToken(): string {
  return crypto.randomUUID();
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RealtimeSessionError("bad_packet", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function engineFrames(packets: readonly EngineIoV4Packet[]): string[] {
  return packets.map((packet) => encodeEngineIoV4Packet(packet));
}

function deltaDocuments(values: unknown[]): RealtimeDeltaDocument[] {
  return values.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("realtime snapshot arrays must contain objects");
    }
    return value as RealtimeDeltaDocument;
  });
}

function deltaState(snapshot: RealtimeSnapshot, now: number): RealtimeDeltaState {
  return {
    sgvs: deltaDocuments(snapshot.sgvs),
    treatments: deltaDocuments(snapshot.treatments),
    mbgs: deltaDocuments(snapshot.mbgs),
    cals: deltaDocuments(snapshot.cals),
    profiles: snapshot.profiles,
    devicestatus: deltaDocuments(snapshot.devicestatus),
    food: deltaDocuments(snapshot.food),
    activity: [],
    dbstats: snapshot.dbstats,
    lastUpdated: now,
  };
}

export class RealtimeSessionService {
  private readonly repository: SqliteRealtimeSessionRepository;
  private readonly now: () => number;
  private readonly pollWaitMs: number;
  private readonly authorize: NonNullable<RealtimeServiceOptions["authorize"]>;
  private readonly authorizeStorage: NonNullable<RealtimeServiceOptions["authorizeStorage"]>;
  private readonly authorizeAlarm: NonNullable<RealtimeServiceOptions["authorizeAlarm"]>;
  private readonly writeRoot: NonNullable<RealtimeServiceOptions["writeRoot"]>;
  private readonly snapshot: NonNullable<RealtimeServiceOptions["snapshot"]>;
  private readonly retroDeviceStatus: NonNullable<RealtimeServiceOptions["retroDeviceStatus"]>;
  private readonly status: RealtimeServiceOptions["status"];
  private readonly waiters = new Map<string, PollWaiter>();
  private readonly pendingApplicationWakeSids = new Set<string>();

  constructor(
    private readonly storage: DurableObjectStorage,
    options: RealtimeServiceOptions = {},
  ) {
    this.repository = new SqliteRealtimeSessionRepository(storage);
    this.now = options.now ?? Date.now;
    this.pollWaitMs = options.pollWaitMs ?? REALTIME_PING_INTERVAL_MS;
    this.authorize = options.authorize ?? defaultAuthorization;
    this.authorizeStorage = options.authorizeStorage ?? defaultStorageAuthorization;
    this.authorizeAlarm = options.authorizeAlarm ?? defaultAlarmAuthorization;
    this.writeRoot = options.writeRoot ?? defaultRootWrite;
    this.snapshot = options.snapshot ?? defaultSnapshot;
    this.retroDeviceStatus = options.retroDeviceStatus ?? ((now) =>
      this.snapshot(now)?.devicestatus ?? null
    );
    this.status = options.status;
  }

  createHandshake(): { sid: string; payload: string } {
    const now = this.now();
    this.cleanup(now);
    let session: RealtimeSession;
    try {
      session = this.repository.createSession(now);
    } catch (error) {
      throw this.translateRepositoryError(error);
    }
    const payload = encodeEngineIoV4PollingPayload([
      createEngineIoV4HandshakePacket({
        sid: session.sid,
        // This slice does not implement or advertise a WebSocket upgrade.
        upgrades: [],
        pingInterval: REALTIME_PING_INTERVAL_MS,
        pingTimeout: REALTIME_PING_TIMEOUT_MS,
        maxPayload: REALTIME_MAX_PAYLOAD_BYTES,
      }),
    ]);
    return { sid: session.sid, payload };
  }

  createWebSocketHandshake(): { sid: string; frame: string } {
    const now = this.now();
    this.cleanup(now);
    let session: RealtimeSession;
    try {
      session = this.repository.createSession(now, REALTIME_WEBSOCKET_TRANSPORT);
    } catch (error) {
      throw this.translateRepositoryError(error);
    }
    return {
      sid: session.sid,
      frame: encodeEngineIoV4Packet(createEngineIoV4HandshakePacket({
        sid: session.sid,
        // A direct WebSocket is already at Engine.IO's terminal transport.
        // Polling-to-WebSocket upgrade remains intentionally unimplemented.
        upgrades: [],
        pingInterval: REALTIME_PING_INTERVAL_MS,
        pingTimeout: REALTIME_PING_TIMEOUT_MS,
        maxPayload: REALTIME_MAX_PAYLOAD_BYTES,
      })),
    };
  }

  validateSession(sid: string): void {
    const now = this.now();
    this.cleanup(now);
    this.storage.transactionSync(() => {
      this.requireLiveSession(sid, now);
    });
  }

  beginPost(sid: string): string {
    const now = this.now();
    this.cleanup(now);
    const token = this.storage.transactionSync(() => {
      const session = this.requireLiveSession(sid, now);
      if (session.postToken !== null && (session.postDeadline ?? 0) > now) {
        this.repository.deleteSessionInTransaction(sid);
        return null;
      }
      session.postToken = randomLeaseToken();
      session.postDeadline = now + REALTIME_POST_LEASE_MS;
      this.repository.updateSession(session);
      return session.postToken;
    });
    if (token === null) {
      this.wake(sid);
      throw new RealtimeSessionError("overlap", "concurrent polling POST closed the session");
    }
    return token;
  }

  abortPost(sid: string, token: string): void {
    this.storage.transactionSync(() => {
      const session = this.repository.getSession(sid);
      if (session === null || session.postToken !== token) return;
      session.postToken = null;
      session.postDeadline = null;
      this.repository.updateSession(session);
    });
  }

  rejectPost(sid: string, token: string): void {
    const now = this.now();
    this.cleanup(now);
    const result = this.storage.transactionSync((): {
      error: RealtimeSessionError | null;
      wakeTargets: string[];
    } => {
      const session = this.repository.getSession(sid);
      if (session === null) {
        return {
          error: new RealtimeSessionError("unknown_sid", "session ID is unknown"),
          wakeTargets: [],
        };
      }
      const leaseIsValid =
        session.postToken === token && (session.postDeadline ?? 0) > now;
      const wasConnected = session.socketConnected;
      this.repository.deleteSessionInTransaction(sid);
      return {
        error: leaseIsValid
          ? null
          : new RealtimeSessionError(
              "invalid_post_lease",
              "polling POST lease is invalid",
            ),
        wakeTargets: wasConnected ? this.enqueueClientsForConnectedSessions(now) : [],
      };
    });
    this.wake(sid);
    for (const targetSid of result.wakeTargets) this.wake(targetSid);
    if (result.error !== null) throw result.error;
  }

  async submitPost(sid: string, token: string, payload: string): Promise<void> {
    let packets: EngineIoV4Packet[];
    try {
      packets = decodeEngineIoV4PollingPayload(payload);
    } catch (error) {
      this.closeForBadPacket(sid);
      throw this.badPacket(error);
    }

    const initial = this.repository.getSession(sid);
    if (initial === null || initial.transport !== REALTIME_TRANSPORT) {
      throw new RealtimeSessionError("unknown_sid", "session ID is unknown");
    }
    if (initial.postToken !== token || (initial.postDeadline ?? 0) <= this.now()) {
      this.closeForBadPacket(sid);
      throw new RealtimeSessionError("invalid_post_lease", "polling POST lease is invalid");
    }

    const session = cloneSession(initial);
    const outbound: EngineIoV4Packet[] = [];
    const broadcasts: EngineIoV4Packet[] = [];
    const alarmAcknowledgements: RealtimeAlarmAcknowledgement[] = [];
    const rootMutation: RealtimeRootMutationState = { changed: false };
    let closed = false;
    try {
      for (const packet of packets) {
        if (packet.type === "close") {
          closed = true;
          break;
        }
        if (packet.type === "pong") {
          this.acceptPong(session, packet);
          continue;
        }
        if (packet.type !== "message") {
          throw new RealtimeSessionError(
            "bad_packet",
            `client packet type ${packet.type} is invalid for EIO4 polling`,
          );
        }
        this.refreshInboundLiveness(session, this.now());
        const socketPacket = unwrapSocketIoV5Packet(packet);
        await this.processSocketPacket(
          session,
          socketPacket,
          outbound,
          broadcasts,
          alarmAcknowledgements,
          rootMutation,
        );
      }
    } catch (error) {
      this.closeForBadPacket(sid);
      throw this.badPacket(error);
    }

    if (closed) {
      this.closeSession(sid);
      return;
    }

    const now = this.now();
    session.postToken = null;
    session.postDeadline = null;
    const commit = this.commitProcessedSession(
      sid,
      initial,
      session,
      outbound,
      broadcasts,
      alarmAcknowledgements,
      now,
      (current) =>
        current.transport !== REALTIME_TRANSPORT
          ? new RealtimeSessionError("unknown_sid", "session ID is unknown")
          : current.postToken !== token || (current.postDeadline ?? 0) <= now
            ? new RealtimeSessionError(
                "invalid_post_lease",
                "polling POST lease changed or expired",
              )
            : null,
    );
    if (commit.error !== null) {
      this.wake(sid);
      throw commit.error;
    }
    if (rootMutation.changed) {
      this.storage.transactionSync(() => this.recordRootDataUpdateInTransaction());
      this.flushApplicationWakes();
    }
    for (const targetSid of commit.wakeTargets) this.wake(targetSid);
    if (outbound.length > 0) this.wake(sid);
  }

  async submitWebSocketFrame(sid: string, frame: string): Promise<{ closed: boolean }> {
    let packet: EngineIoV4Packet;
    try {
      packet = decodeEngineIoV4Packet(frame);
    } catch (error) {
      this.closeForBadPacket(sid);
      throw this.badPacket(error);
    }

    const initial = this.repository.getSession(sid);
    if (initial === null || initial.transport !== REALTIME_WEBSOCKET_TRANSPORT) {
      throw new RealtimeSessionError("unknown_sid", "session ID is unknown");
    }

    if (packet.type === "close") {
      this.closeSession(sid);
      return { closed: true };
    }

    const session = cloneSession(initial);
    const outbound: EngineIoV4Packet[] = [];
    const broadcasts: EngineIoV4Packet[] = [];
    const alarmAcknowledgements: RealtimeAlarmAcknowledgement[] = [];
    const rootMutation: RealtimeRootMutationState = { changed: false };
    try {
      if (packet.type === "pong") {
        this.acceptPong(session, packet);
      } else if (packet.type === "message") {
        this.refreshInboundLiveness(session, this.now());
        await this.processSocketPacket(
          session,
          unwrapSocketIoV5Packet(packet),
          outbound,
          broadcasts,
          alarmAcknowledgements,
          rootMutation,
        );
      } else {
        throw new RealtimeSessionError(
          "bad_packet",
          `client packet type ${packet.type} is invalid for EIO4 websocket`,
        );
      }
    } catch (error) {
      this.closeForBadPacket(sid);
      throw this.badPacket(error);
    }

    const now = this.now();
    const commit = this.commitProcessedSession(
      sid,
      initial,
      session,
      outbound,
      broadcasts,
      alarmAcknowledgements,
      now,
      (current) =>
        current.transport === REALTIME_WEBSOCKET_TRANSPORT
          ? null
          : new RealtimeSessionError("unknown_sid", "session ID is unknown"),
    );
    if (commit.error !== null) throw commit.error;
    if (rootMutation.changed) {
      this.storage.transactionSync(() => this.recordRootDataUpdateInTransaction());
      this.flushApplicationWakes();
    }
    for (const targetSid of commit.wakeTargets) this.wake(targetSid);
    return { closed: false };
  }

  validateWebSocketSession(sid: string): void {
    const now = this.now();
    this.cleanup(now);
    this.storage.transactionSync(() => {
      this.requireLiveSession(sid, now, REALTIME_WEBSOCKET_TRANSPORT);
    });
  }

  queuedWebSocketSessionIds(limit: number): string[] {
    return this.repository.listQueuedWebSocketSessionIds(limit);
  }

  takeWebSocketClosures(limit: number, now: number): RealtimeWebSocketClosure[] {
    return this.storage.transactionSync(() =>
      this.repository.takeWebSocketClosures(limit, now)
    );
  }

  requeueWebSocketClosure(
    closure: RealtimeWebSocketClosure,
    retry: RealtimeWebSocketClosureRetry,
    now: number,
  ): void {
    this.storage.transactionSync(() => {
      this.repository.requeueWebSocketClosure(closure, retry, now);
    });
  }

  drainWebSocketFrames(
    sid: string,
    maxPackets: number,
    maxBytes: number,
  ): string[] {
    const now = this.now();
    return this.storage.transactionSync(() => {
      this.requireLiveSession(sid, now, REALTIME_WEBSOCKET_TRANSPORT);
      return this.repository.dequeueFrames(sid, maxPackets, maxBytes);
    });
  }

  closeWebSocketSession(sid: string): void {
    const session = this.repository.getSession(sid);
    if (session?.transport !== REALTIME_WEBSOCKET_TRANSPORT) return;
    this.closeSession(sid);
  }

  async poll(sid: string): Promise<string> {
    const startedAt = this.now();
    this.cleanup(startedAt);
    const acquired = this.storage.transactionSync(() => {
      const session = this.requireLiveSession(sid, startedAt);
      if (session.pollToken !== null && (session.pollDeadline ?? 0) > startedAt) {
        this.repository.deleteSessionInTransaction(sid);
        return { overlap: true as const };
      }
      session.pollToken = randomLeaseToken();
      session.pollDeadline = startedAt + REALTIME_POLL_LEASE_MS;
      this.enqueuePingIfDue(session, startedAt);
      this.repository.updateSession(session);
      const immediate = this.repository.dequeuePayload(sid);
      if (immediate !== null) {
        session.pollToken = null;
        session.pollDeadline = null;
        this.repository.updateSession(session);
        return { overlap: false as const, token: "", immediate, waitMs: 0 };
      }
      const heartbeatDeadline = session.pongDeadline ?? session.nextPingAt;
      const waitUntil = Math.min(
        startedAt + Math.max(0, this.pollWaitMs),
        heartbeatDeadline,
        session.expiresAt,
      );
      return {
        overlap: false as const,
        token: session.pollToken,
        immediate: null,
        waitMs: Math.max(0, waitUntil - startedAt),
      };
    });

    if (acquired.overlap) {
      this.wake(sid);
      throw new RealtimeSessionError("overlap", "concurrent polling GET closed the session");
    }

    if (acquired.immediate !== null) return acquired.immediate;
    const pollToken = acquired.token;
    if (pollToken === null || pollToken === "") {
      throw new Error("polling lease was not created");
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, acquired.waitMs);
      this.waiters.set(sid, { token: pollToken, resolve, timer });
    });
    const waiter = this.waiters.get(sid);
    if (waiter?.token === pollToken) {
      clearTimeout(waiter.timer);
      this.waiters.delete(sid);
    }

    const now = this.now();
    return this.storage.transactionSync(() => {
      const session = this.requireLiveSession(sid, now);
      if (session.pollToken !== pollToken) {
        throw new RealtimeSessionError("unknown_sid", "polling GET no longer owns the session");
      }
      this.enqueuePingIfDue(session, now);
      let payload = this.repository.dequeuePayload(sid);
      if (payload === null) {
        // A bounded wake without application data is represented by EIO noop.
        payload = encodeEngineIoV4PollingPayload([{ type: "noop" }]);
      }
      session.pollToken = null;
      session.pollDeadline = null;
      session.lastSeenAt = now;
      this.repository.updateSession(session);
      return payload;
    });
  }

  nextDeadline(): number | null {
    return this.repository.nextDeadline();
  }

  processAlarm(): void {
    const now = this.now();
    const result = this.storage.transactionSync(() => {
      const closed = new Set<string>();
      const wakeTargets = new Set<string>();
      let connectedSessionRemoved = false;

      while (true) {
        const expired = this.repository.cleanupOpportunityInTransaction(now);
        for (const session of expired) {
          closed.add(session.sid);
          if (session.socketConnected) connectedSessionRemoved = true;
        }
        if (expired.length < REALTIME_CLEANUP_BATCH) break;
      }

      for (const sid of this.repository.listDuePingSessionIds(now)) {
        const session = this.repository.getSession(sid);
        if (session === null) continue;
        try {
          this.enqueuePingIfDue(session, now);
          this.repository.updateSession(session);
          wakeTargets.add(sid);
        } catch (error) {
          if (
            error instanceof RealtimeRepositoryError &&
            error.code === "queue_overflow"
          ) {
            this.repository.deleteSessionInTransaction(sid);
            closed.add(sid);
            if (session.socketConnected) connectedSessionRemoved = true;
            continue;
          }
          throw error;
        }
      }

      if (connectedSessionRemoved) {
        for (const targetSid of this.enqueueClientsForConnectedSessions(now, closed)) {
          wakeTargets.add(targetSid);
        }
      }
      return { closed: [...closed], wakeTargets: [...wakeTargets] };
    });

    for (const sid of result.closed) this.wake(sid);
    for (const sid of result.wakeTargets) this.wake(sid);
  }

  /** Seeds the persisted replacement for upstream websocket.js `lastData`. */
  synchronizeRootDataSnapshot(): void {
    const now = this.now();
    const snapshot = this.snapshot(now);
    if (snapshot === null) return;
    const encoded = JSON.stringify(deltaState(snapshot, now));
    this.storage.transactionSync(() => {
      this.repository.initializeRootDataState(encoded, now);
    });
  }

  /**
   * Recomputes the bounded tenant ddata state and queues the locked calcdelta
   * event for current root DataReceivers. The caller already owns the document
   * mutation transaction, so the new baseline and accepted frames commit with
   * that mutation. Queue saturation drops only the affected realtime session.
   */
  recordRootDataUpdateInTransaction(): void {
    const now = this.now();
    const snapshot = this.snapshot(now);
    if (snapshot === null) return;
    const current = deltaState(snapshot, now);
    const currentJson = JSON.stringify(current);
    const previousJson = this.repository.rootDataStateJson();
    this.repository.replaceRootDataState(currentJson, now);
    if (previousJson === null) return;

    let previous: RealtimeDeltaState;
    try {
      const parsed = JSON.parse(previousJson) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      previous = parsed as RealtimeDeltaState;
    } catch {
      // A bad legacy baseline must not roll back the user's document mutation.
      // The valid current snapshot above repairs it for the next update.
      return;
    }

    const delta = calculateRealtimeDelta(previous, current);
    if (delta.delta !== true) return;

    let frame: string;
    try {
      frame = encodeEngineIoV4Packet(wrapSocketIoV5Packet({
        type: "event",
        namespace: "/",
        data: ["dataUpdate", delta],
      }));
    } catch {
      return;
    }

    let droppedConnectedRoot = false;
    for (const sid of this.repository.listDataReceiverSessionIds(now)) {
      try {
        this.repository.enqueueFrames(sid, [frame], now);
        this.pendingApplicationWakeSids.add(sid);
      } catch {
        this.repository.deleteSessionInTransaction(sid);
        this.pendingApplicationWakeSids.add(sid);
        droppedConnectedRoot = true;
      }
    }
    if (droppedConnectedRoot) {
      for (const sid of this.enqueueClientsForConnectedSessions(now)) {
        this.pendingApplicationWakeSids.add(sid);
      }
    }
  }

  /**
   * Called from the document repository while its API3 mutation transaction is
   * still open. The persisted per-session packet queues are therefore the
   * change outbox: either the document and every accepted frame commit
   * together, or neither does. A saturated subscriber is dropped without
   * failing the storage mutation.
   */
  recordApi3StorageMutationInTransaction(event: Api3RealtimeMutationEvent): void {
    this.recordRootDataUpdateInTransaction();
    let packet: string;
    try {
      const payload = event.type === "delete"
        ? { colName: event.collection, identifier: event.identifier }
        : { colName: event.collection, doc: event.document };
      packet = encodeEngineIoV4Packet(wrapSocketIoV5Packet({
        type: "event",
        namespace: "/storage",
        data: [event.type, payload],
      }));
    } catch {
      // A document mutation must never be rolled back because one realtime
      // representation cannot fit the bounded transport adapter.
      return;
    }

    const now = this.now();
    let droppedConnectedRoot = false;
    for (const sid of this.repository.listStorageSubscriberSessionIds(event.collection, now)) {
      try {
        this.repository.enqueueFrames(sid, [packet], now);
        this.pendingApplicationWakeSids.add(sid);
      } catch {
        const session = this.repository.getSession(sid);
        if (session?.socketConnected === true) droppedConnectedRoot = true;
        this.repository.deleteSessionInTransaction(sid);
        this.pendingApplicationWakeSids.add(sid);
      }
    }
    if (droppedConnectedRoot) {
      for (const sid of this.enqueueClientsForConnectedSessions(now)) {
        this.pendingApplicationWakeSids.add(sid);
      }
    }
  }

  /**
   * Trusted server-side notification outlet used by the future plugin/bus
   * adapter. Like upstream namespace.emit(), this broadcasts to every current
   * `/alarm` connection (subscription only controls ACK authority) and does not
   * create an offline replay log.
   */
  publishAlarmNotification(notification: Record<string, unknown>): number {
    let frame: string;
    try {
      frame = encodeEngineIoV4Packet(wrapSocketIoV5Packet({
        type: "event",
        namespace: "/alarm",
        data: [alarmEventName(notification), notification],
      }));
    } catch {
      return 0;
    }
    const now = this.now();
    const result = this.storage.transactionSync(() => {
      const wakeTargets = new Set<string>();
      const delivered = this.enqueueAlarmFrameInTransaction(frame, now, wakeTargets);
      return { delivered, wakeTargets: [...wakeTargets] };
    });
    for (const sid of result.wakeTargets) this.wake(sid);
    return result.delivered;
  }

  acknowledgeAlarm(level: number, group: string, rawSilenceTime: number): boolean {
    const acknowledgement = normalizeAlarmAcknowledgement(level, group, rawSilenceTime);
    if (acknowledgement === null) return false;
    const now = this.now();
    const result = this.storage.transactionSync(() => {
      const wakeTargets = new Set<string>();
      const accepted = this.acknowledgeAlarmInTransaction(
        acknowledgement,
        now,
        wakeTargets,
      );
      return { accepted, wakeTargets: [...wakeTargets] };
    });
    for (const sid of result.wakeTargets) this.wake(sid);
    return result.accepted;
  }

  flushApplicationWakes(): number {
    const sids = [...this.pendingApplicationWakeSids];
    this.pendingApplicationWakeSids.clear();
    for (const sid of sids) this.wake(sid);
    return sids.length;
  }

  private enqueueAlarmFrameInTransaction(
    frame: string,
    now: number,
    wakeTargets: Set<string>,
  ): number {
    let delivered = 0;
    let droppedConnectedRoot = false;
    for (const sid of this.repository.listAlarmConnectionSessionIds(now)) {
      try {
        this.repository.enqueueFrames(sid, [frame], now);
        wakeTargets.add(sid);
        delivered += 1;
      } catch {
        const session = this.repository.getSession(sid);
        if (session?.socketConnected === true) droppedConnectedRoot = true;
        this.repository.deleteSessionInTransaction(sid);
        wakeTargets.add(sid);
      }
    }
    if (droppedConnectedRoot) {
      for (const sid of this.enqueueClientsForConnectedSessions(now)) {
        wakeTargets.add(sid);
      }
    }
    return delivered;
  }

  private acknowledgeAlarmInTransaction(
    acknowledgement: RealtimeAlarmAcknowledgement,
    now: number,
    wakeTargets: Set<string>,
  ): boolean {
    const { level, group, silenceTime } = acknowledgement;
    if (!this.repository.ackAlarm(level, group, silenceTime, now)) return false;
    const clear = {
      clear: true,
      title: "All Clear",
      message: `${group} - ${alarmLevelDisplay(level)} was ack'd`,
      group,
    };
    const frame = encodeEngineIoV4Packet(wrapSocketIoV5Packet({
      type: "event",
      namespace: "/alarm",
      data: ["clear_alarm", clear],
    }));
    this.enqueueAlarmFrameInTransaction(frame, now, wakeTargets);
    return true;
  }

  private commitProcessedSession(
    sid: string,
    initial: RealtimeSession,
    session: RealtimeSession,
    outbound: readonly EngineIoV4Packet[],
    broadcasts: readonly EngineIoV4Packet[],
    alarmAcknowledgements: readonly RealtimeAlarmAcknowledgement[],
    now: number,
    validateCurrent: (current: RealtimeSession) => RealtimeSessionError | null,
  ): { error: RealtimeSessionError | null; wakeTargets: string[] } {
    return this.storage.transactionSync(() => {
      const wakeTargets = new Set<string>();
      const current = this.repository.getSession(sid);
      if (current === null) {
        return {
          error: new RealtimeSessionError("unknown_sid", "session ID is unknown"),
          wakeTargets: [],
        };
      }
      const closeCurrent = (
        error: RealtimeSessionError,
        wasConnected: boolean,
      ): { error: RealtimeSessionError; wakeTargets: string[] } => {
        this.repository.deleteSessionInTransaction(sid);
        if (wasConnected) {
          for (const targetSid of this.enqueueClientsForConnectedSessions(now)) {
            wakeTargets.add(targetSid);
          }
        }
        return { error, wakeTargets: [...wakeTargets] };
      };
      if (
        current.expiresAt <= now ||
        (current.pongDeadline !== null && current.pongDeadline <= now)
      ) {
        return closeCurrent(
          new RealtimeSessionError("unknown_sid", "session ID is unknown or expired"),
          current.socketConnected,
        );
      }
      const validationError = validateCurrent(current);
      if (validationError !== null) {
        return closeCurrent(validationError, current.socketConnected);
      }

      // Authorization may await tenant storage/crypto while an alarm emits a
      // due ping. Heartbeat, queue, and polling-lease fields remain owned by
      // the current row and must never be replaced by the pre-await clone.
      session.pollToken = current.pollToken;
      session.pollDeadline = current.pollDeadline;
      session.lastSeenAt = Math.max(session.lastSeenAt, current.lastSeenAt, now);
      const heartbeatChangedConcurrently =
        current.nextPingAt !== initial.nextPingAt ||
        current.pongDeadline !== initial.pongDeadline ||
        current.expiresAt !== initial.expiresAt;
      if (heartbeatChangedConcurrently) {
        session.nextPingAt = current.nextPingAt;
        session.pongDeadline = current.pongDeadline;
        session.expiresAt = current.expiresAt;
      }
      this.repository.updateSession(session);
      try {
        this.repository.enqueueFrames(sid, engineFrames(outbound), now);
      } catch (error) {
        return closeCurrent(
          this.translateRepositoryError(error),
          session.socketConnected,
        );
      }
      for (const broadcast of broadcasts) {
        const frame = encodeEngineIoV4Packet(broadcast);
        let droppedTarget = false;
        for (const targetSid of this.repository.listConnectedSessionIds()) {
          if (targetSid === sid) continue;
          try {
            this.repository.enqueueFrames(targetSid, [frame], now);
            wakeTargets.add(targetSid);
          } catch (error) {
            if (
              error instanceof RealtimeRepositoryError &&
              error.code === "queue_overflow"
            ) {
              this.repository.deleteSessionInTransaction(targetSid);
              droppedTarget = true;
              continue;
            }
            throw error;
          }
        }
        if (droppedTarget) {
          for (const targetSid of this.enqueueClientsForConnectedSessions(now)) {
            wakeTargets.add(targetSid);
          }
        }
      }
      for (const acknowledgement of alarmAcknowledgements) {
        this.acknowledgeAlarmInTransaction(acknowledgement, now, wakeTargets);
      }
      return { error: null, wakeTargets: [...wakeTargets] };
    });
  }

  private async processSocketPacket(
    session: RealtimeSession,
    packet: SocketIoV5Packet,
    outbound: EngineIoV4Packet[],
    broadcasts: EngineIoV4Packet[],
    alarmAcknowledgements: RealtimeAlarmAcknowledgement[],
    rootMutation: RealtimeRootMutationState,
  ): Promise<void> {
    if (packet.type === "connect") {
      if (packet.namespace === "/storage") {
        const socketSid = this.repository.connectStorageNamespace(session.sid, this.now());
        if (socketSid === null) {
          throw new RealtimeSessionError(
            "bad_packet",
            "storage namespace is already connected",
          );
        }
        outbound.push(wrapSocketIoV5Packet(
          createSocketIoV5ServerConnectPacket("/storage", socketSid),
        ));
        return;
      }
      if (packet.namespace === "/alarm") {
        const socketSid = this.repository.connectAlarmNamespace(session.sid, this.now());
        if (socketSid === null) {
          throw new RealtimeSessionError(
            "bad_packet",
            "alarm namespace is already connected",
          );
        }
        outbound.push(wrapSocketIoV5Packet(
          createSocketIoV5ServerConnectPacket("/alarm", socketSid),
        ));
        return;
      }
      if (packet.namespace !== "/") {
        outbound.push(wrapSocketIoV5Packet({
          type: "error",
          namespace: packet.namespace,
          data: { message: "Invalid namespace" },
        }));
        return;
      }
      if (session.socketConnected) {
        throw new RealtimeSessionError("bad_packet", "root namespace is already connected");
      }
      session.socketSid = createRealtimeSocketId();
      session.socketConnected = true;
      outbound.push(wrapSocketIoV5Packet(
        createSocketIoV5ServerConnectPacket("/", session.socketSid),
      ));
      const clients = wrapSocketIoV5Packet({
        type: "event",
        namespace: "/",
        data: ["clients", this.repository.countConnectedSessions() + 1],
      });
      // Socket.IO sends the root CONNECT response before invoking the locked
      // Nightscout connection handler, which then broadcasts `clients`.
      outbound.push(clients);
      broadcasts.push(clients);
      return;
    }

    if (packet.type === "disconnect") {
      if (packet.namespace === "/storage") {
        this.repository.disconnectStorageNamespace(session.sid);
        return;
      }
      if (packet.namespace === "/alarm") {
        this.repository.disconnectAlarmNamespace(session.sid);
        return;
      }
      if (packet.namespace === "/") {
        session.socketConnected = false;
        session.authorized = false;
        session.readAllowed = false;
        session.writeAllowed = false;
        session.treatmentWriteAllowed = false;
        broadcasts.push(wrapSocketIoV5Packet({
          type: "event",
          namespace: "/",
          data: [
            "clients",
            Math.max(0, this.repository.countConnectedSessions() - 1),
          ],
        }));
      }
      return;
    }

    if (packet.type === "ack" || packet.type === "error") return;
    if (packet.namespace === "/alarm") {
      if (!this.repository.alarmNamespaceConnected(session.sid)) {
        throw new RealtimeSessionError(
          "bad_packet",
          "alarm event requires the connected alarm namespace",
        );
      }
      await this.processAlarmEvent(session, packet, outbound, alarmAcknowledgements);
      return;
    }
    if (packet.namespace === "/storage") {
      if (!this.repository.storageNamespaceConnected(session.sid)) {
        throw new RealtimeSessionError(
          "bad_packet",
          "storage event requires the connected storage namespace",
        );
      }
      await this.processStorageEvent(session, packet, outbound);
      return;
    }
    if (packet.namespace !== "/" || !session.socketConnected) {
      throw new RealtimeSessionError("bad_packet", "event requires the connected root namespace");
    }
    await this.processRootEvent(session, packet, outbound, broadcasts, rootMutation);
  }

  private async processAlarmEvent(
    session: RealtimeSession,
    packet: SocketIoV5EventPacket,
    outbound: EngineIoV4Packet[],
    alarmAcknowledgements: RealtimeAlarmAcknowledgement[],
  ): Promise<void> {
    const eventName = packet.data[0];
    if (eventName === "subscribe") {
      const rawMessage = packet.data.length === 2 ? packet.data[1] : undefined;
      const message = typeof rawMessage === "object"
          && rawMessage !== null
          && !Array.isArray(rawMessage)
        ? rawMessage as Record<string, unknown>
        : {};
      const authorization = await this.authorizeAlarm(message);
      let result: Record<string, unknown>;
      if (authorization === null) {
        result = { success: false, message: "Missing or bad accessToken" };
      } else if (authorization.mode === "accessToken") {
        this.repository.setAlarmSubscription(
          session.sid,
          "accessToken",
          false,
          true,
          this.now(),
        );
        result = { success: true, message: "Subscribed for alarms" };
      } else {
        this.repository.setAlarmSubscription(
          session.sid,
          "web",
          authorization.read,
          authorization.ack,
          this.now(),
        );
        result = {
          success: true,
          message: "Subscribed for alarms",
          read: authorization.read,
          ack: authorization.ack,
        };
      }
      if (packet.id !== undefined) {
        outbound.push(wrapSocketIoV5Packet({
          type: "ack",
          namespace: "/alarm",
          id: packet.id,
          data: [result],
        }));
      }
      return;
    }

    if (eventName !== "ack" || !this.repository.alarmAckAllowed(session.sid)) return;
    const acknowledgement = normalizeAlarmAcknowledgement(
      packet.data[1] as number,
      packet.data[2] as string,
      packet.data[3] as number,
    );
    if (acknowledgement === null) {
      // Upstream has no protocol ACK or error for malformed alarm ACK events.
      // Ignore them without allocating tenant state or closing the transport.
      return;
    }
    alarmAcknowledgements.push(acknowledgement);
  }

  private async processStorageEvent(
    session: RealtimeSession,
    packet: SocketIoV5EventPacket,
    outbound: EngineIoV4Packet[],
  ): Promise<void> {
    if (packet.data[0] !== "subscribe") return;

    const rawMessage = packet.data.length === 2 ? packet.data[1] : undefined;
    const message = typeof rawMessage === "object"
      && rawMessage !== null
      && !Array.isArray(rawMessage)
      ? rawMessage as Record<string, unknown>
      : null;
    const collections = message === null ? null : await this.authorizeStorage(message);
    let result: Record<string, unknown>;
    if (collections === null) {
      result = { success: false, message: "Missing or bad accessToken" };
    } else if (collections.length === 0) {
      result = { success: false, message: "Unauthorized to receive any collection" };
    } else {
      const granted = [...collections];
      this.repository.addStorageSubscriptions(session.sid, granted, this.now());
      result = { success: true, collections: granted };
    }

    if (packet.id !== undefined) {
      outbound.push(wrapSocketIoV5Packet({
        type: "ack",
        namespace: "/storage",
        id: packet.id,
        data: [result],
      }));
    }
  }

  private async processRootEvent(
    session: RealtimeSession,
    packet: SocketIoV5EventPacket,
    outbound: EngineIoV4Packet[],
    broadcasts: EngineIoV4Packet[],
    rootMutation: RealtimeRootMutationState,
  ): Promise<void> {
    const eventName = packet.data[0];
    if (eventName === "authorize") {
      if (packet.data.length !== 2) {
        throw new RealtimeSessionError("bad_packet", "authorize requires one object payload");
      }
      const message = recordValue(packet.data[1], "authorize payload");
      const authorization = await this.authorize(message);

      if (authorization === null) {
        // Locked verifyAuthorization errors call socket.disconnect() and never
        // invoke the callback. This disconnects only root; EIO stays alive so
        // the client may reconnect a namespace on the same transport.
        session.socketConnected = false;
        session.authorized = false;
        session.readAllowed = false;
        session.writeAllowed = false;
        session.treatmentWriteAllowed = false;
        outbound.push(wrapSocketIoV5Packet({ type: "disconnect", namespace: "/" }));
        broadcasts.push(wrapSocketIoV5Packet({
          type: "event",
          namespace: "/",
          data: [
            "clients",
            Math.max(0, this.repository.countConnectedSessions() - 1),
          ],
        }));
        return;
      }

      // Locked Nightscout v15.0.7 order: connected, authorization state,
      // optional initial dataUpdate, then the callback ACK.
      outbound.push(wrapSocketIoV5Packet({
        type: "event",
        namespace: "/",
        data: ["connected"],
      }));
      session.authorized = true;
      session.readAllowed = authorization.read;
      session.writeAllowed = authorization.write;
      session.treatmentWriteAllowed = authorization.write_treatment;
      if (authorization.read) {
        const now = this.now();
        const snapshot = this.snapshot(now);
        if (snapshot !== null) {
          const data: RealtimeSnapshot = { ...snapshot };
          if (message.status && this.status !== undefined) {
            data.status = this.status(now);
          }
          outbound.push(wrapSocketIoV5Packet({
            type: "event",
            namespace: "/",
            data: ["dataUpdate", data],
          }));
        }
      }
      if (packet.id !== undefined) {
        outbound.push(wrapSocketIoV5Packet({
          type: "ack",
          namespace: "/",
          id: packet.id,
          data: [{
            read: authorization.read,
            write: authorization.write,
            write_treatment: authorization.write_treatment,
          }],
        }));
      }
      return;
    }

    if (
      eventName === "dbAdd"
      || eventName === "dbUpdate"
      || eventName === "dbUpdateUnset"
      || eventName === "dbRemove"
    ) {
      const rawMessage = packet.data.length >= 2 ? packet.data[1] : undefined;
      const message = typeof rawMessage === "object"
          && rawMessage !== null
          && !Array.isArray(rawMessage)
        ? rawMessage as Record<string, unknown>
        : {};
      const collection = realtimeRootWriteCollection(message.collection);
      let acknowledgement: unknown;
      if (collection === null) {
        acknowledgement = { result: "Wrong collection" };
      } else if (!session.authorized) {
        acknowledgement = { result: "Not authorized" };
      } else if (
        collection === "treatments"
          ? !session.treatmentWriteAllowed
          : !session.writeAllowed
      ) {
        acknowledgement = { result: "Not permitted" };
      } else {
        const receivedAt = this.now();
        const id = eventName === "dbAdd" ? null : realtimeRootWriteId(message._id);
        if (eventName !== "dbAdd" && id === null) {
          acknowledgement = { result: "Missing _id" };
        } else {
          let result: RealtimeRootWriteResult;
          try {
            result = eventName === "dbAdd"
              ? await this.writeRoot({
                event: "dbAdd",
                collection,
                data: message.data,
                receivedAt,
              })
              : eventName === "dbRemove"
                ? await this.writeRoot({
                  event: "dbRemove",
                  collection,
                  id: id!,
                  receivedAt,
                })
                : await this.writeRoot({
                  event: eventName,
                  collection,
                  id: id!,
                  data: message.data,
                  receivedAt,
                });
          } catch {
            // Locked websocket.js logs storage failures but keeps the namespace
            // connected. dbAdd reports an empty result; update/unset/remove
            // have already exposed their optimistic success callback shape.
            result = {
              acknowledgement: eventName === "dbAdd" ? [] : { result: "success" },
              changed: false,
            };
          }
          acknowledgement = result.acknowledgement;
          rootMutation.changed ||= result.changed;
        }
      }

      if (packet.id !== undefined) {
        outbound.push(wrapSocketIoV5Packet({
          type: "ack",
          namespace: "/",
          id: packet.id,
          data: [acknowledgement],
        }));
      }
      return;
    }

    if (eventName === "loadRetro") {
      if (packet.data.length !== 2) {
        throw new RealtimeSessionError("bad_packet", "loadRetro requires one object payload");
      }
      recordValue(packet.data[1], "loadRetro payload");
      const devicestatus = this.retroDeviceStatus(this.now());
      // Locked upstream calls the callback before emitting retroUpdate.
      if (packet.id !== undefined) {
        outbound.push(wrapSocketIoV5Packet({
          type: "ack",
          namespace: "/",
          id: packet.id,
          data: [{ result: "success" }],
        }));
      }
      outbound.push(wrapSocketIoV5Packet({
        type: "event",
        namespace: "/",
        data: ["retroUpdate", { devicestatus: devicestatus ?? [] }],
      }));
      return;
    }

    // `subscribe` is intentionally included here only as locked evidence: the
    // v15.0.7 root namespace has no listener, so Socket.IO produces no ACK.
    // Other unimplemented events behave the same.
  }

  private acceptPong(session: RealtimeSession, _packet: EngineIoV4Packet): void {
    const now = this.now();
    // engine.io 6.2.1 ignores optional pong data on the normal polling path.
    session.pongDeadline = null;
    session.nextPingAt = now + REALTIME_PING_INTERVAL_MS;
    session.expiresAt = session.nextPingAt + REALTIME_PING_TIMEOUT_MS;
    session.lastSeenAt = now;
  }

  private refreshInboundLiveness(session: RealtimeSession, now: number): void {
    session.lastSeenAt = now;
    // engine.io 6.2.1 resets its liveness timeout for every inbound packet.
    // The independent server-ping interval remains unchanged until a pong.
    session.expiresAt = now + REALTIME_PING_INTERVAL_MS + REALTIME_PING_TIMEOUT_MS;
    if (session.pongDeadline !== null) session.pongDeadline = session.expiresAt;
  }

  private enqueuePingIfDue(session: RealtimeSession, now: number): void {
    if (session.pongDeadline !== null || now < session.nextPingAt) return;
    this.repository.enqueueFrames(sidOf(session), [encodeEngineIoV4Packet({ type: "ping" })], now);
    session.pongDeadline = now + REALTIME_PING_TIMEOUT_MS;
    session.expiresAt = session.pongDeadline;
  }

  private requireLiveSession(
    sid: string,
    now: number,
    transport: RealtimeTransport = REALTIME_TRANSPORT,
  ): RealtimeSession {
    const session = this.repository.getSession(sid);
    if (session === null || session.transport !== transport) {
      throw new RealtimeSessionError("unknown_sid", "session ID is unknown or expired");
    }
    if (
      session.expiresAt <= now ||
      (session.pongDeadline !== null && session.pongDeadline <= now)
    ) {
      this.repository.deleteSessionInTransaction(sid);
      throw new RealtimeSessionError("unknown_sid", "session ID is unknown or expired");
    }
    return session;
  }

  private cleanup(now: number): void {
    const expired = this.repository.cleanupOpportunity(now);
    for (const session of expired) this.wake(session.sid);
    if (expired.some((session) => session.socketConnected)) {
      const targets = this.storage.transactionSync(() =>
        this.enqueueClientsForConnectedSessions(now),
      );
      for (const targetSid of targets) this.wake(targetSid);
    }
  }

  private wake(sid: string): void {
    const waiter = this.waiters.get(sid);
    if (waiter === undefined) return;
    clearTimeout(waiter.timer);
    this.waiters.delete(sid);
    waiter.resolve();
  }

  private closeForBadPacket(sid: string): void {
    this.closeSession(sid);
  }

  private closeSession(sid: string): void {
    const now = this.now();
    const targets = this.storage.transactionSync(() => {
      const session = this.repository.getSession(sid);
      if (session === null) return [];
      const wasConnected = session.socketConnected;
      this.repository.deleteSessionInTransaction(sid);
      return wasConnected ? this.enqueueClientsForConnectedSessions(now) : [];
    });
    this.wake(sid);
    for (const targetSid of targets) this.wake(targetSid);
  }

  private enqueueClientsForConnectedSessions(
    now: number,
    droppedSessions?: Set<string>,
  ): string[] {
    const enqueued = new Set<string>();
    // A saturated client's removal changes the count. Append a corrected count
    // and repeat until every surviving connected session has received the final
    // value (or all saturated sessions have been removed).
    while (true) {
      const targets = this.repository.listConnectedSessionIds();
      if (targets.length === 0) return [...enqueued];
      const frame = encodeEngineIoV4Packet(wrapSocketIoV5Packet({
        type: "event",
        namespace: "/",
        data: ["clients", targets.length],
      }));
      let droppedTarget = false;
      for (const targetSid of targets) {
        try {
          this.repository.enqueueFrames(targetSid, [frame], now);
          enqueued.add(targetSid);
        } catch (error) {
          if (
            error instanceof RealtimeRepositoryError &&
            error.code === "queue_overflow"
          ) {
            this.repository.deleteSessionInTransaction(targetSid);
            droppedSessions?.add(targetSid);
            droppedTarget = true;
            continue;
          }
          throw error;
        }
      }
      if (!droppedTarget) return [...enqueued];
    }
  }

  private badPacket(error: unknown): RealtimeSessionError {
    if (error instanceof RealtimeSessionError) return error;
    if (error instanceof ProtocolError) {
      return new RealtimeSessionError("bad_packet", `${error.code}: ${error.message}`);
    }
    return new RealtimeSessionError(
      "bad_packet",
      error instanceof Error ? error.message : "invalid realtime packet",
    );
  }

  private translateRepositoryError(error: unknown): RealtimeSessionError {
    if (error instanceof RealtimeSessionError) return error;
    if (error instanceof RealtimeRepositoryError) {
      return new RealtimeSessionError(error.code, error.message);
    }
    throw error;
  }
}

function sidOf(session: RealtimeSession): string {
  return session.sid;
}
