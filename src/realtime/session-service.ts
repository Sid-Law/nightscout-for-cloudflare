import {
  ProtocolError,
  createEngineIoV4HandshakePacket,
  createSocketIoV5ServerConnectPacket,
  decodeEngineIoV4PollingPayload,
  encodeEngineIoV4Packet,
  encodeEngineIoV4PollingPayload,
  wrapSocketIoV5Packet,
  unwrapSocketIoV5Packet,
  type EngineIoV4Packet,
  type SocketIoV5EventPacket,
  type SocketIoV5Packet,
} from "../protocol";
import {
  REALTIME_MAX_PAYLOAD_BYTES,
  REALTIME_PING_INTERVAL_MS,
  REALTIME_PING_TIMEOUT_MS,
  REALTIME_POLL_LEASE_MS,
  REALTIME_POST_LEASE_MS,
} from "./constants";
import {
  createRealtimeSocketId,
  RealtimeRepositoryError,
  SqliteRealtimeSessionRepository,
  type RealtimeSession,
} from "./session-repository";

export interface RealtimeAuthorization {
  read: boolean;
  write: false;
  write_treatment: false;
}

export interface RealtimeSnapshot {
  devicestatus: unknown[];
  sgvs: unknown[];
  cals: unknown[];
  profiles: unknown[];
  mbgs: unknown[];
  food: unknown[];
  treatments: unknown[];
  dbstats: Record<string, never>;
  status?: Record<string, unknown>;
}

export interface RealtimeServiceOptions {
  now?: () => number;
  pollWaitMs?: number;
  authorize?: (message: Record<string, unknown>) =>
    | RealtimeAuthorization
    | null
    | Promise<RealtimeAuthorization | null>;
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

export class RealtimeSessionService {
  private readonly repository: SqliteRealtimeSessionRepository;
  private readonly now: () => number;
  private readonly pollWaitMs: number;
  private readonly authorize: NonNullable<RealtimeServiceOptions["authorize"]>;
  private readonly snapshot: NonNullable<RealtimeServiceOptions["snapshot"]>;
  private readonly retroDeviceStatus: NonNullable<RealtimeServiceOptions["retroDeviceStatus"]>;
  private readonly status: RealtimeServiceOptions["status"];
  private readonly waiters = new Map<string, PollWaiter>();

  constructor(
    private readonly storage: DurableObjectStorage,
    options: RealtimeServiceOptions = {},
  ) {
    this.repository = new SqliteRealtimeSessionRepository(storage);
    this.now = options.now ?? Date.now;
    this.pollWaitMs = options.pollWaitMs ?? REALTIME_PING_INTERVAL_MS;
    this.authorize = options.authorize ?? defaultAuthorization;
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

  async submitPost(sid: string, token: string, payload: string): Promise<void> {
    let packets: EngineIoV4Packet[];
    try {
      packets = decodeEngineIoV4PollingPayload(payload);
    } catch (error) {
      this.closeForBadPacket(sid);
      throw this.badPacket(error);
    }

    const initial = this.repository.getSession(sid);
    if (initial === null) throw new RealtimeSessionError("unknown_sid", "session ID is unknown");
    if (initial.postToken !== token || (initial.postDeadline ?? 0) <= this.now()) {
      this.closeForBadPacket(sid);
      throw new RealtimeSessionError("invalid_post_lease", "polling POST lease is invalid");
    }

    const session = cloneSession(initial);
    const outbound: EngineIoV4Packet[] = [];
    const broadcasts: EngineIoV4Packet[] = [];
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
        await this.processSocketPacket(session, socketPacket, outbound, broadcasts);
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
    const commitError = this.storage.transactionSync((): RealtimeSessionError | null => {
      const current = this.repository.getSession(sid);
      if (current === null) {
        return new RealtimeSessionError("unknown_sid", "session ID is unknown");
      }
      if (current.postToken !== token) {
        this.repository.deleteSessionInTransaction(sid);
        return new RealtimeSessionError("invalid_post_lease", "polling POST lease changed");
      }
      session.postToken = null;
      session.postDeadline = null;
      // Authorization may await tenant storage/crypto while a GET emits a due
      // ping. Heartbeat, queue, and lease fields remain owned by the current
      // row and must never be replaced by the pre-await clone.
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
        this.repository.deleteSessionInTransaction(sid);
        return this.translateRepositoryError(error);
      }
      for (const broadcast of broadcasts) {
        const frame = encodeEngineIoV4Packet(broadcast);
        for (const targetSid of this.repository.listConnectedSessionIds()) {
          if (targetSid === sid) continue;
          try {
            this.repository.enqueueFrames(targetSid, [frame], now);
          } catch (error) {
            if (
              error instanceof RealtimeRepositoryError &&
              error.code === "queue_overflow"
            ) {
              this.repository.deleteSessionInTransaction(targetSid);
              continue;
            }
            throw error;
          }
        }
      }
      return null;
    });
    if (commitError !== null) {
      this.wake(sid);
      throw commitError;
    }
    if (outbound.length > 0) this.wake(sid);
    if (broadcasts.length > 0) {
      for (const targetSid of this.repository.listConnectedSessionIds()) {
        if (targetSid !== sid) this.wake(targetSid);
      }
    }
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
        return { overlap: false as const, token: "", immediate };
      }
      return { overlap: false as const, token: session.pollToken, immediate: null };
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
      const timer = setTimeout(resolve, this.pollWaitMs);
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

  private async processSocketPacket(
    session: RealtimeSession,
    packet: SocketIoV5Packet,
    outbound: EngineIoV4Packet[],
    broadcasts: EngineIoV4Packet[],
  ): Promise<void> {
    if (packet.type === "connect") {
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
      if (packet.namespace === "/") {
        session.socketConnected = false;
        session.authorized = false;
        session.readAllowed = false;
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
    if (packet.namespace !== "/" || !session.socketConnected) {
      throw new RealtimeSessionError("bad_packet", "event requires the connected root namespace");
    }
    await this.processRootEvent(session, packet, outbound, broadcasts);
  }

  private async processRootEvent(
    session: RealtimeSession,
    packet: SocketIoV5EventPacket,
    outbound: EngineIoV4Packet[],
    broadcasts: EngineIoV4Packet[],
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
            write: false,
            write_treatment: false,
          }],
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
    // Other unimplemented events, including every write event, behave the same.
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

  private requireLiveSession(sid: string, now: number): RealtimeSession {
    const session = this.repository.getSession(sid);
    if (
      session === null ||
      session.expiresAt <= now ||
      (session.pongDeadline !== null && session.pongDeadline <= now)
    ) {
      if (session !== null) this.repository.deleteSessionInTransaction(sid);
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

  private enqueueClientsForConnectedSessions(now: number): string[] {
    const targets = this.repository.listConnectedSessionIds();
    if (targets.length === 0) return [];
    const frame = encodeEngineIoV4Packet(wrapSocketIoV5Packet({
      type: "event",
      namespace: "/",
      data: ["clients", targets.length],
    }));
    const enqueued: string[] = [];
    for (const targetSid of targets) {
      try {
        this.repository.enqueueFrames(targetSid, [frame], now);
        enqueued.push(targetSid);
      } catch (error) {
        if (
          error instanceof RealtimeRepositoryError &&
          error.code === "queue_overflow"
        ) {
          this.repository.deleteSessionInTransaction(targetSid);
          continue;
        }
        throw error;
      }
    }
    return enqueued;
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
