import {
  ENGINE_IO_V4_POLLING_SEPARATOR,
  decodeEngineIoV4Packet,
  encodeEngineIoV4Packet,
} from "../protocol";
import {
  REALTIME_CLEANUP_BATCH,
  REALTIME_ENGINE_PROTOCOL,
  REALTIME_MAX_PAYLOAD_BYTES,
  REALTIME_MAX_QUEUE_BYTES,
  REALTIME_MAX_QUEUE_PACKETS,
  REALTIME_MAX_SESSIONS_PER_TENANT,
  REALTIME_PING_INTERVAL_MS,
  REALTIME_PING_TIMEOUT_MS,
  REALTIME_TRANSPORT,
} from "./constants";

interface SessionRow {
  [key: string]: SqlStorageValue;
  sid: string;
  socket_sid: string;
  socket_connected: number;
  authorized: number;
  read_allowed: number;
  created_at: number;
  last_seen_at: number;
  next_ping_at: number;
  pong_deadline: number | null;
  expires_at: number;
  next_sequence: number;
  outbound_packets: number;
  outbound_bytes: number;
  poll_token: string | null;
  poll_deadline: number | null;
  post_token: string | null;
  post_deadline: number | null;
}

interface QueueRow {
  [key: string]: SqlStorageValue;
  sequence: number;
  packet: string;
  byte_length: number;
}

interface CountRow {
  [key: string]: SqlStorageValue;
  count: number;
}

interface DeadlineRow {
  [key: string]: SqlStorageValue;
  deadline: number | null;
}

interface SidRow {
  [key: string]: SqlStorageValue;
  sid: string;
}

export interface RealtimeSession {
  sid: string;
  socketSid: string;
  socketConnected: boolean;
  authorized: boolean;
  readAllowed: boolean;
  createdAt: number;
  lastSeenAt: number;
  nextPingAt: number;
  pongDeadline: number | null;
  expiresAt: number;
  nextSequence: number;
  outboundPackets: number;
  outboundBytes: number;
  pollToken: string | null;
  pollDeadline: number | null;
  postToken: string | null;
  postDeadline: number | null;
}

export interface ExpiredRealtimeSession {
  sid: string;
  socketConnected: boolean;
}

export class RealtimeRepositoryError extends Error {
  constructor(readonly code: "capacity" | "queue_overflow" | "unknown_sid", message: string) {
    super(message);
    this.name = "RealtimeRepositoryError";
  }
}

function sessionFromRow(row: SessionRow): RealtimeSession {
  return {
    sid: row.sid,
    socketSid: row.socket_sid,
    socketConnected: row.socket_connected === 1,
    authorized: row.authorized === 1,
    readAllowed: row.read_allowed === 1,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    nextPingAt: row.next_ping_at,
    pongDeadline: row.pong_deadline,
    expiresAt: row.expires_at,
    nextSequence: row.next_sequence,
    outboundPackets: row.outbound_packets,
    outboundBytes: row.outbound_bytes,
    pollToken: row.poll_token,
    pollDeadline: row.poll_deadline,
    postToken: row.post_token,
    postDeadline: row.post_deadline,
  };
}

function randomSessionId(): string {
  const bytes = new Uint8Array(15);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function createRealtimeSocketId(): string {
  return randomSessionId();
}

export function migrateRealtimeSessions(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS realtime_sessions (
      sid TEXT PRIMARY KEY,
      socket_sid TEXT NOT NULL UNIQUE,
      engine_protocol INTEGER NOT NULL CHECK (engine_protocol = 4),
      transport TEXT NOT NULL CHECK (transport = 'polling'),
      socket_connected INTEGER NOT NULL DEFAULT 0 CHECK (socket_connected IN (0, 1)),
      authorized INTEGER NOT NULL DEFAULT 0 CHECK (authorized IN (0, 1)),
      read_allowed INTEGER NOT NULL DEFAULT 0 CHECK (read_allowed IN (0, 1)),
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      next_ping_at INTEGER NOT NULL,
      pong_deadline INTEGER,
      expires_at INTEGER NOT NULL,
      next_sequence INTEGER NOT NULL DEFAULT 1,
      outbound_packets INTEGER NOT NULL DEFAULT 0,
      outbound_bytes INTEGER NOT NULL DEFAULT 0,
      poll_token TEXT,
      poll_deadline INTEGER,
      post_token TEXT,
      post_deadline INTEGER
    );
    CREATE INDEX IF NOT EXISTS realtime_sessions_expiry
      ON realtime_sessions(expires_at, sid);
    CREATE TABLE IF NOT EXISTS realtime_outbound_packets (
      sid TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      packet TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (sid, sequence)
    );
    CREATE INDEX IF NOT EXISTS realtime_outbound_by_session
      ON realtime_outbound_packets(sid, sequence);
  `);
}

export class SqliteRealtimeSessionRepository {
  constructor(private readonly storage: DurableObjectStorage) {}

  createSession(now: number): RealtimeSession {
    const count = this.storage.sql
      .exec<CountRow>("SELECT COUNT(*) AS count FROM realtime_sessions")
      .one().count;
    if (count >= REALTIME_MAX_SESSIONS_PER_TENANT) {
      throw new RealtimeRepositoryError(
        "capacity",
        `tenant already has ${REALTIME_MAX_SESSIONS_PER_TENANT} realtime sessions`,
      );
    }

    const sid = randomSessionId();
    const socketSid = randomSessionId();
    const nextPingAt = now + REALTIME_PING_INTERVAL_MS;
    const expiresAt = nextPingAt + REALTIME_PING_TIMEOUT_MS;
    this.storage.sql.exec(
      `INSERT INTO realtime_sessions (
         sid, socket_sid, engine_protocol, transport, created_at, last_seen_at,
         next_ping_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      sid,
      socketSid,
      REALTIME_ENGINE_PROTOCOL,
      REALTIME_TRANSPORT,
      now,
      now,
      nextPingAt,
      expiresAt,
    );
    return this.requireSession(sid);
  }

  getSession(sid: string): RealtimeSession | null {
    const row = this.storage.sql
      .exec<SessionRow>(
        `SELECT sid, socket_sid, socket_connected, authorized, read_allowed,
                created_at, last_seen_at, next_ping_at, pong_deadline, expires_at,
                next_sequence, outbound_packets, outbound_bytes,
                poll_token, poll_deadline, post_token, post_deadline
         FROM realtime_sessions WHERE sid = ? LIMIT 1`,
        sid,
      )
      .toArray()[0];
    return row === undefined ? null : sessionFromRow(row);
  }

  requireSession(sid: string): RealtimeSession {
    const session = this.getSession(sid);
    if (session === null) {
      throw new RealtimeRepositoryError("unknown_sid", "Engine.IO session is unknown");
    }
    return session;
  }

  deleteSession(sid: string): void {
    this.storage.transactionSync(() => this.deleteSessionInTransaction(sid));
  }

  deleteSessionInTransaction(sid: string): void {
    this.storage.sql.exec("DELETE FROM realtime_outbound_packets WHERE sid = ?", sid);
    this.storage.sql.exec("DELETE FROM realtime_sessions WHERE sid = ?", sid);
  }

  cleanupOpportunity(
    now: number,
    limit = REALTIME_CLEANUP_BATCH,
  ): ExpiredRealtimeSession[] {
    return this.storage.transactionSync(() =>
      this.cleanupOpportunityInTransaction(now, limit),
    );
  }

  cleanupOpportunityInTransaction(
    now: number,
    limit = REALTIME_CLEANUP_BATCH,
  ): ExpiredRealtimeSession[] {
    const boundedLimit = Math.max(1, Math.min(REALTIME_CLEANUP_BATCH, Math.trunc(limit)));
    const expired = this.storage.sql
      .exec<SessionRow>(
        `SELECT sid, socket_sid, socket_connected, authorized, read_allowed,
                created_at, last_seen_at, next_ping_at, pong_deadline, expires_at,
                next_sequence, outbound_packets, outbound_bytes,
                poll_token, poll_deadline, post_token, post_deadline
         FROM realtime_sessions
         WHERE expires_at <= ? OR (pong_deadline IS NOT NULL AND pong_deadline <= ?)
         ORDER BY expires_at, sid
         LIMIT ?`,
        now,
        now,
        boundedLimit,
      )
      .toArray()
      .map((row) => ({ sid: row.sid, socketConnected: row.socket_connected === 1 }));
    for (const session of expired) this.deleteSessionInTransaction(session.sid);

    this.storage.sql.exec(
      `UPDATE realtime_sessions
       SET poll_token = NULL, poll_deadline = NULL
       WHERE poll_deadline IS NOT NULL AND poll_deadline <= ?`,
      now,
    );
    this.storage.sql.exec(
      `UPDATE realtime_sessions
       SET post_token = NULL, post_deadline = NULL
       WHERE post_deadline IS NOT NULL AND post_deadline <= ?`,
      now,
    );
    return expired;
  }

  nextDeadline(): number | null {
    // Ignore the already-fired next_ping_at while a pong is outstanding. Lease
    // deadlines participate so abandoned polling requests are also reclaimed.
    return this.storage.sql
      .exec<DeadlineRow>(
        `SELECT MIN(deadline) AS deadline
         FROM (
           SELECT CASE
                    WHEN pong_deadline IS NULL THEN MIN(next_ping_at, expires_at)
                    ELSE MIN(pong_deadline, expires_at)
                  END AS deadline
           FROM realtime_sessions
           UNION ALL
           SELECT poll_deadline AS deadline
           FROM realtime_sessions
           WHERE poll_deadline IS NOT NULL
           UNION ALL
           SELECT post_deadline AS deadline
           FROM realtime_sessions
           WHERE post_deadline IS NOT NULL
         )`,
      )
      .one().deadline;
  }

  listDuePingSessionIds(now: number): string[] {
    return this.storage.sql
      .exec<SidRow>(
        `SELECT sid
         FROM realtime_sessions
         WHERE pong_deadline IS NULL
           AND next_ping_at <= ?
           AND expires_at > ?
         ORDER BY next_ping_at, sid
         LIMIT ?`,
        now,
        now,
        REALTIME_MAX_SESSIONS_PER_TENANT,
      )
      .toArray()
      .map((row) => row.sid);
  }

  updateSession(session: RealtimeSession): void {
    this.storage.sql.exec(
      `UPDATE realtime_sessions SET
         socket_sid = ?, socket_connected = ?, authorized = ?, read_allowed = ?,
         last_seen_at = ?, next_ping_at = ?, pong_deadline = ?, expires_at = ?,
         poll_token = ?, poll_deadline = ?, post_token = ?, post_deadline = ?
       WHERE sid = ?`,
      session.socketSid,
      session.socketConnected ? 1 : 0,
      session.authorized ? 1 : 0,
      session.readAllowed ? 1 : 0,
      session.lastSeenAt,
      session.nextPingAt,
      session.pongDeadline,
      session.expiresAt,
      session.pollToken,
      session.pollDeadline,
      session.postToken,
      session.postDeadline,
      session.sid,
    );
  }

  countConnectedSessions(): number {
    return this.storage.sql
      .exec<CountRow>(
        "SELECT COUNT(*) AS count FROM realtime_sessions WHERE socket_connected = 1",
      )
      .one().count;
  }

  listConnectedSessionIds(): string[] {
    return this.storage.sql
      .exec<SessionRow>(
        `SELECT sid, socket_sid, socket_connected, authorized, read_allowed,
                created_at, last_seen_at, next_ping_at, pong_deadline, expires_at,
                next_sequence, outbound_packets, outbound_bytes,
                poll_token, poll_deadline, post_token, post_deadline
         FROM realtime_sessions
         WHERE socket_connected = 1
         ORDER BY created_at, sid
         LIMIT ?`,
        REALTIME_MAX_SESSIONS_PER_TENANT,
      )
      .toArray()
      .map((row) => row.sid);
  }

  enqueueFrames(sid: string, frames: readonly string[], now: number): void {
    if (frames.length === 0) return;
    const session = this.requireSession(sid);
    const encoded: Array<{ frame: string; bytes: number }> = [];
    let addedBytes = 0;
    for (const frame of frames) {
      const canonical = encodeEngineIoV4Packet(decodeEngineIoV4Packet(frame));
      if (canonical !== frame || canonical.includes(ENGINE_IO_V4_POLLING_SEPARATOR)) {
        throw new RealtimeRepositoryError("queue_overflow", "outbound packet is not canonical");
      }
      const bytes = new TextEncoder().encode(frame).byteLength;
      encoded.push({ frame, bytes });
      addedBytes += bytes;
    }

    const totalPackets = session.outboundPackets + encoded.length;
    const totalBytes = session.outboundBytes + addedBytes;
    const framedBytes = totalBytes + Math.max(0, totalPackets - 1);
    if (
      totalPackets > REALTIME_MAX_QUEUE_PACKETS ||
      totalBytes > REALTIME_MAX_QUEUE_BYTES ||
      framedBytes > REALTIME_MAX_PAYLOAD_BYTES
    ) {
      throw new RealtimeRepositoryError(
        "queue_overflow",
        "realtime outbound queue reached its bounded capacity",
      );
    }

    let sequence = session.nextSequence;
    for (const packet of encoded) {
      this.storage.sql.exec(
        `INSERT INTO realtime_outbound_packets
           (sid, sequence, packet, byte_length, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        sid,
        sequence,
        packet.frame,
        packet.bytes,
        now,
      );
      sequence += 1;
    }
    this.storage.sql.exec(
      `UPDATE realtime_sessions
       SET next_sequence = ?, outbound_packets = ?, outbound_bytes = ?
       WHERE sid = ?`,
      sequence,
      totalPackets,
      totalBytes,
      sid,
    );
  }

  dequeuePayload(sid: string): string | null {
    const session = this.requireSession(sid);
    if (session.outboundPackets === 0) return null;
    const rows = this.storage.sql
      .exec<QueueRow>(
        `SELECT sequence, packet, byte_length
         FROM realtime_outbound_packets
         WHERE sid = ?
         ORDER BY sequence
         LIMIT ?`,
        sid,
        REALTIME_MAX_QUEUE_PACKETS,
      )
      .toArray();
    if (rows.length === 0) {
      throw new Error("realtime queue counters do not match stored packets");
    }

    const payload = rows.map((row) => row.packet).join(ENGINE_IO_V4_POLLING_SEPARATOR);
    const payloadBytes = new TextEncoder().encode(payload).byteLength;
    if (payloadBytes > REALTIME_MAX_PAYLOAD_BYTES) {
      throw new Error("stored realtime payload exceeds the advertised maxPayload");
    }
    for (const row of rows) {
      this.storage.sql.exec(
        "DELETE FROM realtime_outbound_packets WHERE sid = ? AND sequence = ?",
        sid,
        row.sequence,
      );
    }
    const removedBytes = rows.reduce((total, row) => total + row.byte_length, 0);
    this.storage.sql.exec(
      `UPDATE realtime_sessions
       SET outbound_packets = outbound_packets - ?,
           outbound_bytes = outbound_bytes - ?
       WHERE sid = ?`,
      rows.length,
      removedBytes,
      sid,
    );
    return payload;
  }
}
