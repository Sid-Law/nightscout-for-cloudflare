import { DurableObject } from "cloudflare:workers";
import {
  apiSecretDigestMatches,
  authorizationPermissionGroups,
  authorizationRoleNames,
  authorizationDerivationMarker,
  boundedTokenCandidates,
  deriveSubjectCredential,
  subjectCredentialMatches,
  type PresentedToken,
  type SubjectCredential,
} from "./authorization";
import {
  createJwtSecret,
  isJwtSecret,
  issueJwt as signJwt,
  verifyJwt as validateJwt,
} from "./jwt";
import { permissionGroupsAllow } from "./permissions";
import {
  migrateEntriesV6,
  migrateDocumentsV4,
  SqliteDocumentRepository,
  type Api3CollectionName,
  type Api3MutationOptions,
  type DocumentDeleteResult,
  type DocumentHistoryQuery,
  type DocumentQuery,
} from "./document-repository";
import type { HistoryQuery, PublicEntry, ValidatedEntry } from "./model";
import {
  migrateRealtimeClosuresV8,
  migrateRealtimeSessions,
  migrateRealtimeTransportsV7,
} from "./realtime/session-repository";
import {
  RealtimeSessionError,
  RealtimeSessionService,
  type RealtimeAuthorization,
  type RealtimeSnapshot,
} from "./realtime/session-service";
import {
  buildRealtimeRetroDeviceStatus,
  filterRealtimePublicProfiles,
  normalizeRealtimeDeviceStatus,
  normalizeRealtimeDocument,
  selectRealtimeRecentDeviceStatus,
  type RealtimeDocument,
} from "./realtime/ddata-snapshot";
import {
  REALTIME_DEVICE_STATUS_WINDOW_MS,
  REALTIME_MAX_SESSIONS_PER_TENANT,
  REALTIME_SNAPSHOT_MAX_BYTES,
  REALTIME_SNAPSHOT_MAX_DOCUMENT_DEPTH,
  REALTIME_SNAPSHOT_MAX_DOCUMENTS,
  REALTIME_SNAPSHOT_MAX_NODES,
  REALTIME_SNAPSHOT_MAX_STRING_CHARACTERS,
  REALTIME_WEBSOCKET_FLUSH_MAX_BYTES,
  REALTIME_WEBSOCKET_FLUSH_MAX_FRAMES,
  REALTIME_WEBSOCKET_FLUSH_MAX_SOCKETS,
} from "./realtime/constants";
import { nightscoutWebsocketStatus } from "./status";

export type DocumentCollection =
  | "activity"
  | "food"
  | "profile"
  | "treatments"
  | "devicestatus"
  | "subjects"
  | "roles";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface JsonDocument {
  [key: string]: JsonValue;
}

interface DbDocument {
  [key: string]: SqlStorageValue;
  id: string;
  body: string;
  sort_time: number;
  updated_at: number;
}

interface DbSecret {
  [key: string]: SqlStorageValue;
  value: string;
}

export interface WriteResult {
  inserted: number;
  duplicates: number;
  entries: PublicEntry[];
}

export type RealtimeRpcResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        code: RealtimeSessionError["code"];
        message: string;
      };
    };

export type AuthorizationMutationResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

type EntryStoreEnv = Env & {
  API_SECRET?: string;
  AUTH_DEFAULT_ROLES?: string;
  AUTH_FAIL_DELAY?: string;
};

const REALTIME_WEBSOCKET_TAG = "eio4-websocket";
const REALTIME_WEBSOCKET_SID_TAG_PREFIX = "eio4-sid:";
const REALTIME_WEBSOCKET_ATTACHMENT_VERSION = 1;
const REALTIME_WEBSOCKET_EVENT_TIMEOUT_MS = 15_000;
const REALTIME_SID = /^[A-Za-z0-9_-]{20}$/;

interface RealtimeWebSocketAttachment {
  version: typeof REALTIME_WEBSOCKET_ATTACHMENT_VERSION;
  objectId: string;
  sid: string;
}

type RealtimeWebSocketCloseResult = "inactive" | "closed" | "failed";

function randomObjectId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toPublicEntry(document: JsonDocument): PublicEntry {
  const id = document._id;
  const date = document.date;
  const type = document.type;
  if (
    typeof id !== "string"
    || typeof date !== "number"
    || typeof type !== "string"
  ) {
    throw new Error("stored entry is missing its legacy public fields");
  }
  return { ...document, _id: id, date, type };
}

function documentSortTime(document: JsonDocument): number {
  for (const field of ["date", "mills", "created_at", "timestamp", "startDate"]) {
    const value = document[field];
    if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return Date.now();
}

function toDocument(row: DbDocument): JsonDocument {
  return JSON.parse(row.body) as JsonDocument;
}

function tryDocument(row: DbDocument): JsonDocument | null {
  try {
    const parsed: unknown = JSON.parse(row.body);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as JsonDocument
      : null;
  } catch {
    return null;
  }
}

function publicAuthorizationSubject(subject: JsonDocument): JsonDocument {
  const result: JsonDocument = {};
  for (const field of ["_id", "name", "accessToken", "roles"] as const) {
    const value = subject[field];
    if (value !== undefined) result[field] = value;
  }
  if (result.roles === undefined) result.roles = [];
  return result;
}

function publicAuthorizationSubjectMutation(subject: JsonDocument): JsonDocument {
  const result = { ...subject };
  // Locked Nightscout derives accessToken while loading subjects. Its create
  // and update responses are the database document, so a newly derived token
  // is obtained from the subjects GET rather than leaked by the mutation.
  for (const field of Object.keys(result)) {
    if (
      field === "accessToken" ||
      field === "digest" ||
      field === "accessTokenDigest" ||
      field.startsWith("_nscf")
    ) {
      delete result[field];
    }
  }
  return result;
}

const realtimeJsonEncoder = new TextEncoder();
const AUTHORIZATION_SUBJECT_LIMIT = 256;
const AUTHORIZATION_FAILURE_AGE_MS = 60_000;
const AUTHORIZATION_FAILURE_LIMIT = 4096;
const AUTHORIZATION_FAILURE_MAX_DELAY_MS = 60_000;

function realtimeJsonBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("realtime JSON value is not serializable");
  return realtimeJsonEncoder.encode(serialized).byteLength;
}

function realtimeStoredBodyAllowed(body: string): boolean {
  // UTF-16 length is a cheap lower bound for UTF-8 size and avoids allocating
  // another near-megabyte buffer for a body that is already too large.
  if (body.length > REALTIME_SNAPSHOT_MAX_BYTES) return false;
  const bytes = realtimeJsonEncoder.encode(body).byteLength;
  return bytes <= REALTIME_SNAPSHOT_MAX_BYTES;
}

interface RealtimeJsonMetrics {
  nodes: number;
  maxDepth: number;
  maxStringCharacters: number;
}

function realtimeJsonMetrics(
  value: unknown,
  enforceDocumentShape = false,
): RealtimeJsonMetrics {
  const work: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  let maxDepth = 0;
  let maxStringCharacters = 0;
  while (work.length > 0) {
    const item = work.pop();
    if (item === undefined) break;
    nodes += 1;
    maxDepth = Math.max(maxDepth, item.depth);
    if (nodes > REALTIME_SNAPSHOT_MAX_NODES) {
      return { nodes, maxDepth, maxStringCharacters };
    }
    if (enforceDocumentShape && maxDepth > REALTIME_SNAPSHOT_MAX_DOCUMENT_DEPTH) {
      return { nodes, maxDepth, maxStringCharacters };
    }
    if (typeof item.value === "string") {
      maxStringCharacters = Math.max(maxStringCharacters, item.value.length);
      if (
        enforceDocumentShape &&
        maxStringCharacters > REALTIME_SNAPSHOT_MAX_STRING_CHARACTERS
      ) {
        return { nodes, maxDepth, maxStringCharacters };
      }
    } else if (Array.isArray(item.value)) {
      if (nodes + work.length + item.value.length > REALTIME_SNAPSHOT_MAX_NODES) {
        return {
          nodes: REALTIME_SNAPSHOT_MAX_NODES + 1,
          maxDepth,
          maxStringCharacters,
        };
      }
      for (const child of item.value) work.push({ value: child, depth: item.depth + 1 });
    } else if (typeof item.value === "object" && item.value !== null) {
      for (const key in item.value) {
        if (!Object.prototype.hasOwnProperty.call(item.value, key)) continue;
        maxStringCharacters = Math.max(maxStringCharacters, key.length);
        if (
          enforceDocumentShape &&
          maxStringCharacters > REALTIME_SNAPSHOT_MAX_STRING_CHARACTERS
        ) {
          return { nodes, maxDepth, maxStringCharacters };
        }
        if (nodes + work.length + 1 > REALTIME_SNAPSHOT_MAX_NODES) {
          return {
            nodes: REALTIME_SNAPSHOT_MAX_NODES + 1,
            maxDepth,
            maxStringCharacters,
          };
        }
        const child = (item.value as Record<string, unknown>)[key];
        work.push({ value: child, depth: item.depth + 1 });
      }
    }
  }
  return { nodes, maxDepth, maxStringCharacters };
}

function realtimeDocumentShapeAllowed(metrics: RealtimeJsonMetrics): boolean {
  return metrics.nodes <= REALTIME_SNAPSHOT_MAX_NODES
    && metrics.maxDepth <= REALTIME_SNAPSHOT_MAX_DOCUMENT_DEPTH
    && metrics.maxStringCharacters <= REALTIME_SNAPSHOT_MAX_STRING_CHARACTERS;
}

class RealtimeJsonBudget {
  private usedBytes: number;
  private usedNodes: number;
  private usedDocuments: number;

  constructor(base: unknown, documents = 0) {
    this.usedBytes = realtimeJsonBytes(base);
    this.usedNodes = realtimeJsonMetrics(base).nodes;
    this.usedDocuments = documents;
    if (this.usedBytes > REALTIME_SNAPSHOT_MAX_BYTES) {
      throw new Error("realtime snapshot base exceeds its byte budget");
    }
    if (this.usedNodes > REALTIME_SNAPSHOT_MAX_NODES) {
      throw new Error("realtime snapshot base exceeds its node budget");
    }
  }

  reserveArrayItem(value: unknown, priorItems: number): boolean {
    const metrics = realtimeJsonMetrics(value, true);
    if (
      !realtimeDocumentShapeAllowed(metrics) ||
      this.usedNodes + metrics.nodes > REALTIME_SNAPSHOT_MAX_NODES ||
      this.usedDocuments + 1 > REALTIME_SNAPSHOT_MAX_DOCUMENTS
    ) {
      return false;
    }
    // Stringify only after the iterative shape walk has established safe
    // depth, node, and scalar bounds.
    const addedBytes = realtimeJsonBytes(value) + (priorItems === 0 ? 0 : 1);
    if (this.usedBytes + addedBytes > REALTIME_SNAPSHOT_MAX_BYTES) return false;
    this.usedBytes += addedBytes;
    this.usedNodes += metrics.nodes;
    this.usedDocuments += 1;
    return true;
  }
}

export class EntryStore extends DurableObject<EntryStoreEnv> {
  private readonly realtime: RealtimeSessionService;
  private readonly activeWebSocketSessions = new Set<string>();

  constructor(ctx: DurableObjectState, env: EntryStoreEnv) {
    super(ctx, env);
    ctx.setHibernatableWebSocketEventTimeout(REALTIME_WEBSOCKET_EVENT_TIMEOUT_MS);
    this.realtime = new RealtimeSessionService(ctx.storage, {
      snapshot: (now) => this.realtimeSnapshot(now),
      retroDeviceStatus: (now) => this.realtimeRetroDeviceStatus(now),
      status: (now) => nightscoutWebsocketStatus(
        new Date(now),
        undefined,
        this.env.AUTH_DEFAULT_ROLES ?? "readable",
      ),
      authorize: (message) => this.realtimeAuthorize(message),
    });
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private migrate(): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
          id INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      const version = this.ctx.storage.sql
        .exec<{ version: number }>(
          "SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations",
        )
        .one().version;

      if (version < 1) {
        this.ctx.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS entries (
            id TEXT PRIMARY KEY,
            identifier TEXT,
            dedupe_key TEXT NOT NULL UNIQUE,
            sgv INTEGER CHECK (sgv IS NULL OR (sgv >= 20 AND sgv <= 600)),
            mbg INTEGER CHECK (mbg IS NULL OR (mbg >= 20 AND mbg <= 600)),
            date INTEGER NOT NULL,
            date_string TEXT NOT NULL,
            direction TEXT NOT NULL,
            device TEXT NOT NULL,
            type TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS entries_date_desc ON entries(date DESC);
          INSERT INTO _sql_schema_migrations (id) VALUES (1);
        `);
      }

      if (version < 2) {
        this.ctx.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS documents (
            collection TEXT NOT NULL,
            id TEXT NOT NULL,
            body TEXT NOT NULL,
            sort_time INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (collection, id)
          );
          CREATE INDEX IF NOT EXISTS documents_collection_sort
            ON documents(collection, sort_time DESC);
          INSERT INTO _sql_schema_migrations (id) VALUES (2);
        `);
      }

      if (version < 3) {
        this.ctx.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS tenant_secrets (
            name TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );
          INSERT INTO _sql_schema_migrations (id) VALUES (3);
        `);
      }

      // Schema v4 is also checked after its marker exists so partial installs
      // and the identifier-presence metadata added to the same contract are
      // repaired idempotently on activation.
      migrateDocumentsV4(this.ctx.storage.sql);
      if (version < 4) {
        this.ctx.storage.sql.exec("INSERT INTO _sql_schema_migrations (id) VALUES (4)");
      }

      // Realtime schema creation remains idempotent after its marker so a
      // partially initialized Durable Object is repaired on activation.
      migrateRealtimeSessions(this.ctx.storage);
      if (version < 5) {
        this.ctx.storage.sql.exec("INSERT INTO _sql_schema_migrations (id) VALUES (5)");
      }
      // Run the actual Entries repair on every activation. The marker records
      // provenance only: another branch may already have advanced MAX(id), and
      // an old identifier-UNIQUE table must still be repaired and imported.
      migrateEntriesV6(this.ctx.storage.sql);
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (6)",
      );

      migrateRealtimeTransportsV7(this.ctx.storage);
      // MAX(id) is not proof that this specific repair marker exists: a later
      // independent migration may already have a higher id.
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (7)",
      );

      migrateRealtimeClosuresV8(this.ctx.storage);
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (8)",
      );

      // This named, idempotent auth state is intentionally independent of the
      // numeric migration sequence. WebSocket transport remediation owns the
      // next numeric marker, while delay-list state can safely repair itself
      // even when a later branch has already advanced MAX(id).
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS authorization_failures (
          ip TEXT PRIMARY KEY,
          retry_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS authorization_failures_updated
          ON authorization_failures(updated_at, ip);
      `);
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method !== "GET" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
      url.searchParams.get("EIO") !== "4" ||
      url.searchParams.get("transport") !== "websocket" ||
      url.searchParams.has("sid") ||
      url.searchParams.has("j")
    ) {
      return Response.json(
        { code: 3, message: "Bad request" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    // Reap a bounded batch of durable closure tombstones before enforcing the
    // attachment cap so stale hibernated sockets cannot wedge new handshakes.
    this.flushRealtimeWebSockets();
    if (
      this.ctx.getWebSockets(REALTIME_WEBSOCKET_TAG).length >=
      REALTIME_MAX_SESSIONS_PER_TENANT
    ) {
      return Response.json(
        { code: 3, message: "Bad request" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    let opened: { sid: string; frame: string } | null = null;
    try {
      opened = this.realtime.createWebSocketHandshake();
      const attachment: RealtimeWebSocketAttachment = {
        version: REALTIME_WEBSOCKET_ATTACHMENT_VERSION,
        objectId: this.ctx.id.toString(),
        sid: opened.sid,
      };
      this.ctx.acceptWebSocket(server, [
        REALTIME_WEBSOCKET_TAG,
        `${REALTIME_WEBSOCKET_SID_TAG_PREFIX}${opened.sid}`,
      ]);
      server.serializeAttachment(attachment);
      server.send(opened.frame);
      this.flushRealtimeWebSockets();
      await this.synchronizeRealtimeAlarm();
      return new Response(null, { status: 101, webSocket: client });
    } catch (error) {
      if (opened !== null) this.realtime.closeWebSocketSession(opened.sid);
      this.safeCloseWebSocket(server, 1011, "handshake failed");
      this.flushRealtimeWebSockets();
      await this.synchronizeRealtimeAlarm();
      if (error instanceof RealtimeSessionError && error.code === "capacity") {
        return Response.json(
          { code: 3, message: "Bad request" },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        );
      }
      throw error;
    }
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const attachment = this.realtimeWebSocketAttachment(ws);
    if (attachment === null) {
      this.closeInvalidRealtimeWebSocket(ws);
      this.flushRealtimeWebSockets();
      await this.synchronizeRealtimeAlarm();
      return;
    }
    if (this.activeWebSocketSessions.has(attachment.sid)) {
      this.realtime.closeWebSocketSession(attachment.sid);
      this.safeCloseWebSocket(ws, 1008, "concurrent frame");
      this.flushRealtimeWebSockets();
      await this.synchronizeRealtimeAlarm();
      return;
    }

    this.activeWebSocketSessions.add(attachment.sid);
    try {
      if (typeof message !== "string") {
        this.realtime.closeWebSocketSession(attachment.sid);
        this.safeCloseWebSocket(ws, 1003, "binary packets unsupported");
        return;
      }
      const result = await this.realtime.submitWebSocketFrame(attachment.sid, message);
      if (result.closed) this.safeCloseWebSocket(ws, 1000, "transport close");
    } catch (error) {
      this.realtime.closeWebSocketSession(attachment.sid);
      const oversized =
        error instanceof RealtimeSessionError &&
        error.code === "bad_packet" &&
        error.message.includes("too_large");
      const unavailable =
        error instanceof RealtimeSessionError && error.code === "unknown_sid";
      this.safeCloseWebSocket(
        ws,
        oversized ? 1009 : unavailable ? 1008 : 1002,
        oversized ? "packet too large" : unavailable ? "session unavailable" : "bad packet",
      );
    } finally {
      this.activeWebSocketSessions.delete(attachment.sid);
      this.flushRealtimeWebSockets();
      await this.synchronizeRealtimeAlarm();
    }
  }

  override async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const sid = this.trustedRealtimeWebSocketSid(ws);
    if (sid !== null) this.realtime.closeWebSocketSession(sid);
    this.flushRealtimeWebSockets();
    await this.synchronizeRealtimeAlarm();
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    const sid = this.trustedRealtimeWebSocketSid(ws);
    if (sid !== null) this.realtime.closeWebSocketSession(sid);
    console.error(JSON.stringify({ message: "realtime websocket transport error" }));
    this.safeCloseWebSocket(ws, 1011, "transport error");
    this.flushRealtimeWebSockets();
    await this.synchronizeRealtimeAlarm();
  }

  private trustedRealtimeWebSocketSid(ws: WebSocket): string | null {
    let tags: string[];
    try {
      tags = this.ctx.getTags(ws);
    } catch {
      return null;
    }
    const sidTags = tags.filter((tag) => tag.startsWith(REALTIME_WEBSOCKET_SID_TAG_PREFIX));
    if (sidTags.length !== 1) return null;
    const sid = sidTags[0]!.slice(REALTIME_WEBSOCKET_SID_TAG_PREFIX.length);
    return REALTIME_SID.test(sid) ? sid : null;
  }

  private realtimeWebSocketAttachment(
    ws: WebSocket,
  ): RealtimeWebSocketAttachment | null {
    let attachment: unknown;
    try {
      attachment = ws.deserializeAttachment();
    } catch {
      return null;
    }
    if (typeof attachment !== "object" || attachment === null || Array.isArray(attachment)) {
      return null;
    }
    const value = attachment as Record<string, unknown>;
    const trustedSid = this.trustedRealtimeWebSocketSid(ws);
    if (
      value.version !== REALTIME_WEBSOCKET_ATTACHMENT_VERSION ||
      value.objectId !== this.ctx.id.toString() ||
      typeof value.sid !== "string" ||
      value.sid !== trustedSid ||
      !REALTIME_SID.test(value.sid)
    ) {
      return null;
    }
    return {
      version: REALTIME_WEBSOCKET_ATTACHMENT_VERSION,
      objectId: value.objectId,
      sid: value.sid,
    };
  }

  private closeInvalidRealtimeWebSocket(ws: WebSocket): void {
    const sid = this.trustedRealtimeWebSocketSid(ws);
    if (sid !== null) this.realtime.closeWebSocketSession(sid);
    this.safeCloseWebSocket(ws, 1008, "invalid session attachment");
  }

  private safeCloseWebSocket(
    ws: WebSocket,
    code: number,
    reason: string,
  ): RealtimeWebSocketCloseResult {
    if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) {
      return "inactive";
    }
    try {
      ws.close(code, reason);
      return "closed";
    } catch {
      // Transport teardown is best-effort after durable session cleanup.
      return "failed";
    }
  }

  private flushRealtimeWebSockets(): void {
    const now = Date.now();
    let remainingSockets = REALTIME_WEBSOCKET_FLUSH_MAX_SOCKETS;
    let remainingFrames = REALTIME_WEBSOCKET_FLUSH_MAX_FRAMES;
    let remainingBytes = REALTIME_WEBSOCKET_FLUSH_MAX_BYTES;
    let remainingClosureRows = REALTIME_WEBSOCKET_FLUSH_MAX_SOCKETS;

    // Take one tombstone at a time. A corrupt duplicate SID tag may map one
    // durable closure to many physical sockets, so bulk-taking rows before an
    // early budget return could otherwise lose unprocessed tombstones.
    while (remainingSockets > 0 && remainingClosureRows > 0) {
      const closure = this.realtime.takeWebSocketClosures(1, now)[0];
      if (closure === undefined) break;
      remainingClosureRows -= 1;
      const sockets = this.ctx.getWebSockets(
        `${REALTIME_WEBSOCKET_SID_TAG_PREFIX}${closure.sid}`,
      );
      const activeSockets = sockets.filter((ws) =>
        ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING
      );
      const socketOffset = activeSockets.length === 0
        ? 0
        : closure.socketOffset % activeSockets.length;
      const rotatedSockets = socketOffset === 0
        ? activeSockets
        : activeSockets.slice(socketOffset).concat(activeSockets.slice(0, socketOffset));
      const selectedSockets = rotatedSockets.slice(0, remainingSockets);
      const nextSocketOffset = activeSockets.length === 0
        ? 0
        : (socketOffset + selectedSockets.length) % activeSockets.length;
      let closeFailed = false;
      for (const ws of selectedSockets) {
        const result = this.safeCloseWebSocket(ws, closure.code, closure.reason);
        if (result === "inactive") continue;
        remainingSockets -= 1;
        if (result === "failed") closeFailed = true;
      }
      const budgetDeferred = activeSockets.length > selectedSockets.length;
      if (budgetDeferred || closeFailed) {
        this.realtime.requeueWebSocketClosure(
          closure,
          { budgetDeferred, closeFailed, nextSocketOffset },
          now,
        );
      }
    }
    if (remainingSockets === 0) return;

    const queuedSids = this.realtime.queuedWebSocketSessionIds(
      remainingSockets,
    );

    for (const sid of queuedSids) {
      const sockets = this.ctx.getWebSockets(
        `${REALTIME_WEBSOCKET_SID_TAG_PREFIX}${sid}`,
      );
      if (sockets.length !== 1) {
        this.realtime.closeWebSocketSession(sid);
        for (const socket of sockets) {
          if (remainingSockets === 0) break;
          const result = this.safeCloseWebSocket(
            socket,
            1008,
            "ambiguous session attachment",
          );
          if (result === "inactive") continue;
          remainingSockets -= 1;
        }
        if (remainingSockets === 0) return;
        continue;
      }

      const ws = sockets[0]!;
      remainingSockets -= 1;
      const attachment = this.realtimeWebSocketAttachment(ws);
      if (attachment === null || attachment.sid !== sid) {
        this.closeInvalidRealtimeWebSocket(ws);
        continue;
      }
      try {
        const frames = this.realtime.drainWebSocketFrames(
          sid,
          remainingFrames,
          remainingBytes,
        );
        if (frames.length === 0) break;
        for (const frame of frames) {
          const frameBytes = realtimeJsonEncoder.encode(frame).byteLength;
          if (frameBytes > remainingBytes || remainingFrames === 0) {
            throw new Error("websocket flush budget invariant failed");
          }
          ws.send(frame);
          remainingBytes -= frameBytes;
          remainingFrames -= 1;
        }
      } catch {
        this.realtime.closeWebSocketSession(sid);
        this.safeCloseWebSocket(ws, 1011, "outbound queue failure");
      }
      if (remainingSockets === 0 || remainingFrames === 0 || remainingBytes === 0) break;
    }
  }

  private documentRepository(): SqliteDocumentRepository {
    return new SqliteDocumentRepository(this.ctx.storage);
  }

  private configuredApiSecret(): string | null {
    const secret = this.env.API_SECRET;
    return secret !== undefined && secret.length >= 12 ? secret : null;
  }

  private async deriveAuthorizationSubject(
    document: JsonDocument,
  ): Promise<(JsonDocument & SubjectCredential) | null> {
    const configured = this.configuredApiSecret();
    const subjectId = document._id;
    const subjectName = document.name;
    if (
      configured === null ||
      typeof subjectId !== "string" ||
      typeof subjectName !== "string"
    ) {
      return null;
    }
    return {
      ...document,
      ...await deriveSubjectCredential(configured, subjectId, subjectName),
    };
  }

  private authorizationSubjectRows(): DbDocument[] {
    return this.ctx.storage.sql.exec<DbDocument>(
      `SELECT id, body, sort_time, updated_at
       FROM documents
       WHERE collection = 'subjects'
       ORDER BY
         CASE WHEN json_valid(body) THEN json_extract(body, '$.name') ELSE '' END ASC,
         id ASC
       LIMIT ?`,
      AUTHORIZATION_SUBJECT_LIMIT + 1,
    ).toArray();
  }

  private authorizationSubjectCredentialShapeIsCurrent(document: JsonDocument): boolean {
    const name = document.name;
    const digest = document.digest;
    const accessToken = document.accessToken;
    const accessTokenDigest = document.accessTokenDigest;
    if (
      typeof name !== "string" ||
      typeof digest !== "string" ||
      typeof accessToken !== "string" ||
      typeof accessTokenDigest !== "string" ||
      !/^[0-9a-f]{40}$/.test(digest) ||
      !/^[0-9a-f]{40}$/.test(accessTokenDigest)
    ) {
      return false;
    }
    const abbreviation = name.toLowerCase().replace(/\W/g, "").slice(0, 10);
    return accessToken === `${abbreviation}-${digest.slice(0, 16)}`;
  }

  private async ensureAuthorizationSubjectsCurrent(): Promise<boolean> {
    const configured = this.configuredApiSecret();
    if (configured === null) throw new Error("API_SECRET is not configured");
    const marker = await authorizationDerivationMarker(
      this.getOrCreateJwtSecret(),
      configured,
    );

    // Crypto yields the input gate. Re-read and conditionally patch each row
    // in one sync transaction so an admin edit made during derivation is never
    // replaced with an old whole-document snapshot.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rows = this.authorizationSubjectRows();
      if (rows.length > AUTHORIZATION_SUBJECT_LIMIT) return false;
      const storedMarker = this.ctx.storage.sql.exec<DbSecret>(
        "SELECT value FROM tenant_secrets WHERE name = 'authorization-subject-marker' LIMIT 1",
      ).toArray()[0]?.value;
      if (
        storedMarker === marker &&
        rows.every((row) => {
          const document = tryDocument(row);
          return document !== null &&
            this.authorizationSubjectCredentialShapeIsCurrent(document);
        })
      ) {
        return true;
      }

      const derived = await Promise.all(rows.map(async (row) => {
        const document = tryDocument(row);
        return {
          id: row.id,
          updatedAt: row.updated_at,
          name: document?.name,
          subject: document === null
            ? null
            : await this.deriveAuthorizationSubject(document),
        };
      }));
      if (
        derived.some((item) =>
          item.subject === null ||
          typeof item.name !== "string" ||
          !Number.isInteger(item.updatedAt)
        )
      ) {
        return false;
      }

      const stable = this.ctx.storage.transactionSync(() => {
        const currentRows = this.authorizationSubjectRows();
        if (currentRows.length !== rows.length) return false;
        for (let index = 0; index < rows.length; index += 1) {
          const before = rows[index]!;
          const current = currentRows[index]!;
          if (
            current.id !== before.id ||
            current.updated_at !== before.updated_at ||
            tryDocument(current)?.name !== tryDocument(before)?.name
          ) {
            return false;
          }
        }

        for (const item of derived) {
          const subject = item.subject!;
          const written = this.ctx.storage.sql.exec(
            `UPDATE documents
             SET body = json_set(
               body,
               '$.accessToken', ?,
               '$.accessTokenDigest', ?,
               '$.digest', ?
             )
             WHERE collection = 'subjects'
               AND id = ?
               AND updated_at = ?
               AND json_extract(body, '$.name') = ?`,
            subject.accessToken,
            subject.accessTokenDigest,
            subject.digest,
            item.id,
            item.updatedAt,
            item.name as string,
          ).rowsWritten;
          if (written !== 1) return false;
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO tenant_secrets (name, value, created_at)
           VALUES ('authorization-subject-marker', ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             value = excluded.value,
             created_at = excluded.created_at`,
          marker,
          Date.now(),
        );
        return true;
      });
      if (stable) return true;
    }
    return false;
  }

  async resolveAuthorizationSubject(candidatesJson: string): Promise<string | null> {
    if (candidatesJson.length > 16 * 1024) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidatesJson);
    } catch {
      return null;
    }
    if (
      !Array.isArray(parsed) ||
      !parsed.every((candidate) => typeof candidate === "string")
    ) {
      return null;
    }
    const candidates = boundedTokenCandidates(parsed as PresentedToken);
    if (candidates === null) return null;
    if (!await this.ensureAuthorizationSubjectsCurrent()) return null;
    const subjects = this.authorizationSubjectRows().map((row) =>
      toDocument(row) as JsonDocument & SubjectCredential
    );
    for (const candidate of candidates) {
      const suffix = candidate.split("-").at(-1) ?? "";
      if (suffix.length < 16) continue;
      const matches = await Promise.all(subjects.map(async (subject) =>
        typeof subject.accessToken === "string" &&
          typeof subject.accessTokenDigest === "string" &&
          typeof subject.digest === "string"
          ? subjectCredentialMatches(subject, candidate)
          : false
      ));
      const matchedIndex = matches.findIndex(Boolean);
      if (matchedIndex !== -1) {
        return JSON.stringify(publicAuthorizationSubject(subjects[matchedIndex]!));
      }
    }
    return null;
  }

  async listAuthorizationSubjects(): Promise<string | null> {
    const current = await this.ensureAuthorizationSubjectsCurrent();
    const rows = this.authorizationSubjectRows();
    if (rows.length > AUTHORIZATION_SUBJECT_LIMIT) return null;
    const subjects: JsonDocument[] = [];
    for (const row of rows) {
      const subject = tryDocument(row);
      if (subject === null) {
        // Never expose corrupt bytes. The stable id lets an API-secret admin
        // delete the row or replace it with a valid subject document.
        subjects.push({
          _id: row.id,
          name: `[invalid subject ${row.id}]`,
          roles: [],
        });
        continue;
      }
      if (current && typeof subject.accessToken !== "string") continue;
      subjects.push(publicAuthorizationSubject(subject));
    }
    return JSON.stringify(subjects);
  }

  async createAuthorizationSubjects(
    documentsJson: string,
  ): Promise<AuthorizationMutationResult> {
    try {
      return { ok: true, value: await this.createDocuments("subjects", documentsJson) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return {
        ok: false,
        error: message.startsWith("authorization subject limit ")
          ? message
          : "Authorization storage failure",
      };
    }
  }

  async saveAuthorizationSubjects(
    documentsJson: string,
  ): Promise<AuthorizationMutationResult> {
    try {
      return { ok: true, value: await this.saveDocuments("subjects", documentsJson) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return {
        ok: false,
        error: message.startsWith("authorization subject limit ")
          ? message
          : "Authorization storage failure",
      };
    }
  }

  private realtimeSnapshot(now: number): RealtimeSnapshot {
    const snapshot: RealtimeSnapshot = {
      devicestatus: [],
      sgvs: [],
      cals: [],
      profiles: [],
      mbgs: [],
      food: [],
      treatments: [],
      dbstats: {},
    };

    // Deterministic truncation priority: profiles, device status, SGVs,
    // treatments, then food. Each SQL cursor stops as soon as the shared
    // serialized output budget is exhausted; no large result is materialized
    // with toArray() before accounting.
    let budget = new RealtimeJsonBudget(snapshot);
    const profiles = this.realtimeDocuments(
      `SELECT id, body, sort_time
       FROM documents
       WHERE collection = 'profile'
       ORDER BY sort_time DESC, updated_at DESC
       LIMIT 10`,
      [],
      budget,
      (document) => document,
    );
    snapshot.profiles = filterRealtimePublicProfiles(profiles);
    budget = new RealtimeJsonBudget(snapshot, snapshot.profiles.length);

    const rawDeviceStatus = this.realtimeRawDeviceStatus(now, budget);
    snapshot.devicestatus = selectRealtimeRecentDeviceStatus(rawDeviceStatus, now);
    // recentDeviceStatus removes old-per-group and future records, so refund
    // those conservative raw reservations before lower-priority collections.
    budget = new RealtimeJsonBudget(
      snapshot,
      snapshot.profiles.length + snapshot.devicestatus.length,
    );

    for (const row of this.ctx.storage.sql.exec<DbDocument>(
      `SELECT id, body, sort_time
       FROM documents
       WHERE collection = 'entries'
         AND json_extract(body, '$.type') = 'sgv'
         AND json_type(body, '$.sgv') IN ('integer', 'real')
       ORDER BY json_extract(body, '$.date') DESC, id ASC
       LIMIT 1000`,
    )) {
      const entry = toPublicEntry(toDocument(row));
      if (typeof entry.sgv !== "number") continue;
      const sgv = {
        _id: entry._id,
        mgdl: entry.sgv,
        mills: entry.date,
        device: entry.device,
        direction: entry.direction,
        type: entry.type,
      };
      if (!budget.reserveArrayItem(sgv, snapshot.sgvs.length)) break;
      snapshot.sgvs.push(sgv);
    }
    snapshot.sgvs.reverse();

    snapshot.treatments = this.realtimeDocuments(
      `SELECT id, body, sort_time
       FROM documents
       WHERE collection = 'treatments'
       ORDER BY json_extract(body, '$.created_at') DESC, id ASC
       LIMIT 1000`,
      [],
      budget,
      normalizeRealtimeDocument,
    );
    snapshot.food = this.realtimeDocuments(
      `SELECT id, body, sort_time
       FROM documents
       WHERE collection = 'food'
       ORDER BY sort_time DESC, updated_at DESC
       LIMIT 5000`,
      [],
      budget,
      normalizeRealtimeDocument,
    );
    return snapshot;
  }

  private realtimeDocuments(
    statement: string,
    bindings: SqlStorageValue[],
    budget: RealtimeJsonBudget,
    normalize: (document: RealtimeDocument) => RealtimeDocument,
  ): RealtimeDocument[] {
    const documents: RealtimeDocument[] = [];
    for (const row of this.ctx.storage.sql.exec<DbDocument>(statement, ...bindings)) {
      if (!realtimeStoredBodyAllowed(row.body)) break;
      let parsed: RealtimeDocument;
      try {
        const value: unknown = toDocument(row);
        if (typeof value !== "object" || value === null || Array.isArray(value)) break;
        parsed = value as RealtimeDocument;
      } catch {
        break;
      }
      parsed._id = row.id;
      // Stored JSON is checked iteratively before clone-based runtime
      // normalization, so an over-deep body cannot reach JSON.stringify().
      if (!realtimeDocumentShapeAllowed(realtimeJsonMetrics(parsed, true))) break;
      const normalized = normalize(parsed);
      if (!budget.reserveArrayItem(normalized, documents.length)) break;
      documents.push(normalized);
    }
    return documents;
  }

  private realtimeRawDeviceStatus(
    now: number,
    budget: RealtimeJsonBudget,
  ): RealtimeDocument[] {
    return this.realtimeDocuments(
      `SELECT id, body, sort_time
       FROM documents
       WHERE collection = 'devicestatus' AND sort_time >= ?
       ORDER BY sort_time DESC, updated_at DESC`,
      [now - REALTIME_DEVICE_STATUS_WINDOW_MS],
      budget,
      normalizeRealtimeDeviceStatus,
    );
  }

  private realtimeRetroDeviceStatus(now: number): RealtimeDocument[] {
    const result: { devicestatus: RealtimeDocument[] } = { devicestatus: [] };
    const budget = new RealtimeJsonBudget(result);
    result.devicestatus = buildRealtimeRetroDeviceStatus(
      this.realtimeRawDeviceStatus(now, budget),
    );
    return result.devicestatus;
  }

  private authorizationFailureIp(ip: string): string | null {
    return ip.length > 0 && ip.length <= 256 ? ip : null;
  }

  private cleanupAuthorizationFailures(now: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM authorization_failures WHERE retry_at + ? < ?",
      AUTHORIZATION_FAILURE_AGE_MS,
      now,
    );
  }

  private authorizationFailureCleanupDeadline(): number | null {
    const retryAt = this.ctx.storage.sql.exec<{ retry_at: number | null }>(
      "SELECT MIN(retry_at) AS retry_at FROM authorization_failures",
    ).one().retry_at;
    return retryAt === null
      ? null
      : retryAt + AUTHORIZATION_FAILURE_AGE_MS + 1;
  }

  async authorizationDelay(ip: string, now = Date.now()): Promise<number> {
    const normalizedIp = this.authorizationFailureIp(ip);
    if (normalizedIp === null || !Number.isFinite(now)) return 0;
    const timestamp = Math.trunc(now);
    this.cleanupAuthorizationFailures(timestamp);
    const row = this.ctx.storage.sql.exec<{ retry_at: number }>(
      "SELECT retry_at FROM authorization_failures WHERE ip = ? LIMIT 1",
      normalizedIp,
    ).toArray()[0];
    const delay = row !== undefined && timestamp < row.retry_at
      ? row.retry_at - timestamp
      : 0;
    await this.synchronizeRealtimeAlarm();
    return Math.min(delay, AUTHORIZATION_FAILURE_MAX_DELAY_MS);
  }

  async authorizationFailed(ip: string, now: number, delayMs: number): Promise<void> {
    const normalizedIp = this.authorizationFailureIp(ip);
    if (
      normalizedIp === null ||
      !Number.isFinite(now) ||
      !Number.isFinite(delayMs)
    ) {
      return;
    }
    const timestamp = Math.trunc(now);
    const delay = Math.max(
      0,
      Math.min(AUTHORIZATION_FAILURE_MAX_DELAY_MS, Math.trunc(delayMs)),
    );
    this.ctx.storage.transactionSync(() => {
      this.cleanupAuthorizationFailures(timestamp);
      const existing = this.ctx.storage.sql.exec<{ retry_at: number }>(
        "SELECT retry_at FROM authorization_failures WHERE ip = ? LIMIT 1",
        normalizedIp,
      ).toArray()[0]?.retry_at;
      const retryAt = Math.min((existing === undefined || timestamp >= existing
        ? timestamp
        : existing) + delay, timestamp + AUTHORIZATION_FAILURE_MAX_DELAY_MS);
      this.ctx.storage.sql.exec(
        `INSERT INTO authorization_failures (ip, retry_at, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET
           retry_at = excluded.retry_at,
           updated_at = excluded.updated_at`,
        normalizedIp,
        retryAt,
        timestamp,
      );
      const count = this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM authorization_failures",
      ).one().count;
      const excess = count - AUTHORIZATION_FAILURE_LIMIT;
      if (excess > 0) {
        this.ctx.storage.sql.exec(
          `DELETE FROM authorization_failures
           WHERE ip IN (
             SELECT ip FROM authorization_failures
             ORDER BY updated_at ASC, ip ASC
             LIMIT ?
           )`,
          excess,
        );
      }
    });
    await this.synchronizeRealtimeAlarm();
  }

  async authorizationSucceeded(ip: string): Promise<void> {
    const normalizedIp = this.authorizationFailureIp(ip);
    if (normalizedIp === null) return;
    this.ctx.storage.sql.exec(
      "DELETE FROM authorization_failures WHERE ip = ?",
      normalizedIp,
    );
    await this.synchronizeRealtimeAlarm();
  }

  private async realtimePermissionGroups(subjectRoles: unknown): Promise<string[][]> {
    const roles = JSON.parse(await this.listDocuments("roles")) as JsonDocument[];
    return authorizationPermissionGroups(
      authorizationRoleNames(subjectRoles, this.env.AUTH_DEFAULT_ROLES),
      roles,
    );
  }

  private realtimeAuthorizationFromGroups(
    permissionGroups: string[][],
  ): RealtimeAuthorization {
    return {
      read: permissionGroupsAllow(permissionGroups, "api:*:read"),
      write: permissionGroupsAllow(
        permissionGroups,
        "api:*:create,update,delete",
      ),
      write_treatment: permissionGroupsAllow(
        permissionGroups,
        "api:treatments:create,update,delete",
      ),
    };
  }

  private async realtimeAuthorize(
    message: Record<string, unknown>,
  ): Promise<RealtimeAuthorization | null> {
    const rawSecret = message.secret === "null" ? null : message.secret;
    const rawToken = message.token;
    if (
      (rawSecret === undefined || rawSecret === null || rawSecret === "") &&
      (rawToken === undefined || rawToken === null || rawToken === "")
    ) {
      return this.realtimeAuthorizationFromGroups(
        await this.realtimePermissionGroups([]),
      );
    }

    const configured = this.configuredApiSecret();
    if (typeof rawSecret === "string" && rawSecret.length <= 4096) {
      if (await apiSecretDigestMatches(rawSecret, configured)) {
        return this.realtimeAuthorizationFromGroups([["*"]]);
      }
      if (configured !== null) {
        const subjectJson = await this.resolveAuthorizationSubject(
          JSON.stringify([rawSecret]),
        );
        if (subjectJson !== null) {
          const subject = JSON.parse(subjectJson) as JsonDocument;
          return this.realtimeAuthorizationFromGroups(
            await this.realtimePermissionGroups(subject.roles),
          );
        }
      }
    }

    if (typeof rawToken === "string" && rawToken.length <= 4096) {
      const claims = await validateJwt(this.getOrCreateJwtSecret(), rawToken);
      if (claims !== null && configured !== null) {
        const subjectJson = await this.resolveAuthorizationSubject(
          JSON.stringify([claims.accessToken]),
        );
        if (subjectJson !== null) {
          const subject = JSON.parse(subjectJson) as JsonDocument;
          return this.realtimeAuthorizationFromGroups(
            await this.realtimePermissionGroups(subject.roles),
          );
        }
      }
    }
    return null;
  }

  private async synchronizeRealtimeAlarm(): Promise<void> {
    // Cloudflare persists one alarm per Durable Object. Derive that alarm from
    // SQL after every state transition so eviction never makes in-memory timer
    // state authoritative.
    const realtimeDeadline = this.realtime.nextDeadline();
    const authorizationDeadline = this.authorizationFailureCleanupDeadline();
    const nextDeadline = realtimeDeadline === null
      ? authorizationDeadline
      : authorizationDeadline === null
        ? realtimeDeadline
        : Math.min(realtimeDeadline, authorizationDeadline);
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (nextDeadline === null) {
      if (currentAlarm !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    // A durable outbound frame records its FIFO creation time, which is often
    // already in the past by the time this turn yields. Cloudflare treats a
    // newly written past alarm as immediately due; scheduling one short turn
    // ahead keeps it observable/persistent while still prompting the next
    // bounded flush turn without a polling timer.
    const promptDeadline = Date.now() + 100;
    const isDue = nextDeadline <= promptDeadline;
    const scheduledDeadline = isDue ? promptDeadline : nextDeadline;
    // Do not postpone an already-prompt alarm on every busy WebSocket turn;
    // otherwise a steady input stream could starve durable pending output.
    const shouldReplace = isDue
      ? currentAlarm === null || currentAlarm > scheduledDeadline
      : currentAlarm !== scheduledDeadline;
    if (shouldReplace) {
      await this.ctx.storage.setAlarm(scheduledDeadline);
    }
  }

  private async realtimeScheduledResult<T>(
    operation: () => T | Promise<T>,
  ): Promise<RealtimeRpcResult<T>> {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      if (error instanceof RealtimeSessionError) {
        return {
          ok: false,
          error: { code: error.code, message: error.message },
        };
      }
      throw error;
    } finally {
      this.flushRealtimeWebSockets();
      await this.synchronizeRealtimeAlarm();
    }
  }

  override async alarm(_alarmInfo?: AlarmInvocationInfo): Promise<void> {
    // Alarm delivery is at-least-once. processAlarm commits every durable
    // transition transactionally before this derived schedule is replaced.
    this.cleanupAuthorizationFailures(Date.now());
    this.realtime.processAlarm();
    this.flushRealtimeWebSockets();
    await this.synchronizeRealtimeAlarm();
  }

  realtimeHandshake(): Promise<RealtimeRpcResult<{ sid: string; payload: string }>> {
    return this.realtimeScheduledResult(() => this.realtime.createHandshake());
  }

  realtimeValidateSession(sid: string): Promise<RealtimeRpcResult<null>> {
    return this.realtimeScheduledResult(() => {
      this.realtime.validateSession(sid);
      return null;
    });
  }

  realtimeBeginPost(sid: string): Promise<RealtimeRpcResult<string>> {
    return this.realtimeScheduledResult(() => this.realtime.beginPost(sid));
  }

  realtimeAbortPost(sid: string, token: string): Promise<RealtimeRpcResult<null>> {
    return this.realtimeScheduledResult(() => {
      this.realtime.abortPost(sid, token);
      return null;
    });
  }

  realtimeRejectPost(sid: string, token: string): Promise<RealtimeRpcResult<null>> {
    return this.realtimeScheduledResult(() => {
      this.realtime.rejectPost(sid, token);
      return null;
    });
  }

  realtimeSubmitPost(
    sid: string,
    token: string,
    payload: string,
  ): Promise<RealtimeRpcResult<null>> {
    return this.realtimeScheduledResult(async () => {
      await this.realtime.submitPost(sid, token, payload);
      return null;
    });
  }

  realtimePoll(sid: string): Promise<RealtimeRpcResult<string>> {
    return this.realtimeScheduledResult(() => this.realtime.poll(sid));
  }

  private getOrCreateJwtSecret(): string {
    const existing = this.ctx.storage.sql
      .exec<DbSecret>(
        "SELECT value FROM tenant_secrets WHERE name = 'authorization-jwt' LIMIT 1",
      )
      .toArray()[0];
    if (existing !== undefined && isJwtSecret(existing.value)) return existing.value;

    const value = createJwtSecret();
    this.ctx.storage.sql.exec(
      `INSERT INTO tenant_secrets (name, value, created_at)
       VALUES ('authorization-jwt', ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         value = excluded.value,
         created_at = excluded.created_at`,
      value,
      Date.now(),
    );
    return value;
  }

  async issueAccessJwt(accessToken: string): Promise<string> {
    if (accessToken.length === 0 || accessToken.length > 512) {
      throw new Error("invalid access token length");
    }
    return JSON.stringify(await signJwt(this.getOrCreateJwtSecret(), accessToken));
  }

  async verifyAccessJwt(token: string): Promise<string | null> {
    if (token.length === 0 || token.length > 4096) return null;
    const claims = await validateJwt(this.getOrCreateJwtSecret(), token);
    return claims === null ? null : JSON.stringify(claims);
  }

  async putEntries(entries: ValidatedEntry[]): Promise<WriteResult> {
    const mutations = this.documentRepository().upsertLegacyEntries(entries);
    return {
      inserted: mutations.filter((mutation) => mutation.created).length,
      duplicates: mutations.filter((mutation) => !mutation.created).length,
      entries: mutations.map((mutation) => toPublicEntry(mutation.document)),
    };
  }

  async getEntries(query: HistoryQuery): Promise<PublicEntry[]> {
    return this.documentRepository().queryLegacyEntries(query).map(toPublicEntry);
  }

  async getCurrent(): Promise<PublicEntry[]> {
    return this.documentRepository().currentLegacyEntries().map(toPublicEntry);
  }

  async deleteEntries(
    ids: string[],
    lte: number | null = null,
    gte: number | null = null,
  ): Promise<number> {
    return this.documentRepository().deleteLegacyEntries(ids, lte, gte);
  }

  async listDocuments(collection: DocumentCollection, limit = 5000): Promise<string> {
    if (collection === "subjects") return await this.listAuthorizationSubjects() ?? "[]";
    const boundedLimit = Math.max(1, Math.min(10000, Math.trunc(limit)));
    if (collection === "treatments") {
      return JSON.stringify(this.documentRepository().queryLegacyTreatments({ limit: boundedLimit }));
    }
    const documents = this.ctx.storage.sql
      .exec<DbDocument>(
        `SELECT id, body, sort_time
         FROM documents
         WHERE collection = ?
         ORDER BY sort_time DESC, updated_at DESC
         LIMIT ?`,
        collection,
        boundedLimit,
      )
      .toArray()
      .map(toDocument);
    return JSON.stringify(documents);
  }

  async createDocuments(
    collection: DocumentCollection,
    documentsJson: string,
  ): Promise<string> {
    let documents = JSON.parse(documentsJson) as JsonDocument[];
    if (collection === "treatments") {
      return JSON.stringify(
        documents.map((document) => this.documentRepository().upsertTreatment(document).document),
      );
    }
    if (collection === "devicestatus") {
      return JSON.stringify(
        documents.map((document) =>
          this.documentRepository().createLegacyDocument(collection, document).document),
      );
    }
    if (collection === "subjects" || collection === "roles") {
      documents = documents.map((document) =>
        Object.prototype.hasOwnProperty.call(document, "created_at")
          ? document
          : { ...document, created_at: new Date().toISOString() }
      );
    }
    if (collection === "subjects") {
      await this.ensureAuthorizationSubjectsCurrent();
      const derived: JsonDocument[] = [];
      for (const document of documents) {
        const id = typeof document._id === "string" ? document._id : randomObjectId();
        const subject = await this.deriveAuthorizationSubject({ ...document, _id: id });
        if (subject === null) throw new Error("cannot derive subject access token");
        derived.push(subject);
      }
      documents = derived;
      const now = Date.now();
      const stored = documents.map((document) => {
        const id = document._id as string;
        return { ...document, _id: id };
      });
      this.ctx.storage.transactionSync(() => {
        const currentCount = this.ctx.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM documents WHERE collection = 'subjects'",
        ).one().count;
        if (currentCount + stored.length > AUTHORIZATION_SUBJECT_LIMIT) {
          throw new Error(
            `authorization subject limit ${AUTHORIZATION_SUBJECT_LIMIT} exceeded`,
          );
        }
        for (const document of stored) {
          const id = document._id as string;
          this.ctx.storage.sql.exec(
            `INSERT INTO documents (collection, id, body, sort_time, created_at, updated_at)
             VALUES ('subjects', ?, ?, ?, ?, ?)`,
            id,
            JSON.stringify(document),
            documentSortTime(document),
            now,
            now,
          );
        }
        this.ctx.storage.sql.exec(
          "DELETE FROM tenant_secrets WHERE name = 'authorization-subject-marker'",
        );
      });
      return JSON.stringify(stored.map(publicAuthorizationSubjectMutation));
    }
    const now = Date.now();
    const stored: JsonDocument[] = [];
    for (const document of documents) {
      const id = typeof document._id === "string" ? document._id : randomObjectId();
      const normalized = { ...document, _id: id };
      this.ctx.storage.sql.exec(
        `INSERT INTO documents (collection, id, body, sort_time, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        collection,
        id,
        JSON.stringify(normalized),
        documentSortTime(normalized),
        now,
        now,
      );
      stored.push(normalized);
    }
    return JSON.stringify(stored);
  }

  async saveDocuments(
    collection: DocumentCollection,
    documentsJson: string,
  ): Promise<string> {
    let documents = JSON.parse(documentsJson) as JsonDocument[];
    if (collection === "treatments") {
      return JSON.stringify(
        documents.map((document) => this.documentRepository().upsertTreatment(document).document),
      );
    }
    if (collection === "devicestatus") {
      return JSON.stringify(
        documents.map((document) =>
          this.documentRepository().saveLegacyDocument(collection, document).document),
      );
    }
    if (collection === "subjects" || collection === "roles") {
      documents = documents.map((document) =>
        document.created_at
          ? document
          : { ...document, created_at: new Date().toISOString() }
      );
    }
    if (collection === "subjects") {
      await this.ensureAuthorizationSubjectsCurrent();
      const derived: JsonDocument[] = [];
      for (const document of documents) {
        const subject = await this.deriveAuthorizationSubject(document);
        if (subject === null) throw new Error("cannot derive subject access token");
        derived.push(subject);
      }
      documents = derived;
      const now = Date.now();
      this.ctx.storage.transactionSync(() => {
        const currentCount = this.ctx.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM documents WHERE collection = 'subjects'",
        ).one().count;
        const ids = Array.from(new Set(documents.map((document) => document._id as string)));
        let insertedByUpsert = 0;
        for (const id of ids) {
          const exists = this.ctx.storage.sql.exec<{ found: number }>(
            `SELECT 1 AS found FROM documents
             WHERE collection = 'subjects' AND id = ? LIMIT 1`,
            id,
          ).toArray()[0];
          if (exists === undefined) insertedByUpsert += 1;
        }
        if (currentCount + insertedByUpsert > AUTHORIZATION_SUBJECT_LIMIT) {
          throw new Error(
            `authorization subject limit ${AUTHORIZATION_SUBJECT_LIMIT} exceeded`,
          );
        }
        for (const document of documents) {
          const id = document._id as string;
          this.ctx.storage.sql.exec(
            `INSERT INTO documents (collection, id, body, sort_time, created_at, updated_at)
             VALUES ('subjects', ?, ?, ?, ?, ?)
             ON CONFLICT(collection, id) DO UPDATE SET
               body = excluded.body,
               sort_time = excluded.sort_time,
               updated_at = excluded.updated_at`,
            id,
            JSON.stringify(document),
            documentSortTime(document),
            now,
            now,
          );
        }
        this.ctx.storage.sql.exec(
          "DELETE FROM tenant_secrets WHERE name = 'authorization-subject-marker'",
        );
      });
      return JSON.stringify(documents.map(publicAuthorizationSubjectMutation));
    }
    const now = Date.now();
    for (const document of documents) {
      const id = document._id as string;
      this.ctx.storage.sql.exec(
        `INSERT INTO documents (collection, id, body, sort_time, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(collection, id) DO UPDATE SET
           body = excluded.body,
           sort_time = excluded.sort_time,
           updated_at = excluded.updated_at`,
        collection,
        id,
        JSON.stringify(document),
        documentSortTime(document),
        now,
        now,
      );
    }
    return JSON.stringify(documents);
  }

  async deleteDocuments(collection: DocumentCollection, ids: string[]): Promise<number> {
    if (collection === "treatments" || collection === "devicestatus") {
      let deleted = 0;
      for (const id of ids) {
        if (this.documentRepository().deleteDocumentById(collection, id)) deleted += 1;
      }
      return deleted;
    }
    let deleted = 0;
    for (const id of ids) {
      deleted += this.ctx.storage.sql
        .exec("DELETE FROM documents WHERE collection = ? AND id = ?", collection, id).rowsWritten;
    }
    return deleted;
  }

  async findDocumentByField(
    collection: DocumentCollection,
    field: string,
    expected: string,
  ): Promise<string | null> {
    if (collection === "treatments") {
      const found = field === "_id"
        ? this.documentRepository().findTreatmentById(expected)
        : field === "identifier"
          ? this.documentRepository().findTreatmentByIdentifier(expected)
          : this.documentRepository().queryTreatments({
            filters: [{ field, operator: "eq", value: expected }],
            limit: 1,
          })[0] ?? null;
      return found === null ? null : JSON.stringify(found);
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(field)) throw new Error("invalid document field");
    const row = field === "_id"
      ? this.ctx.storage.sql.exec<DbDocument>(
        `SELECT id, body, sort_time FROM documents
         WHERE collection = ? AND id = ? LIMIT 1`,
        collection,
        expected,
      ).toArray()[0]
      : this.ctx.storage.sql.exec<DbDocument>(
        `SELECT id, body, sort_time FROM documents
         WHERE collection = ? AND json_extract(body, ?) = ? LIMIT 1`,
        collection,
        `$.${field}`,
        expected,
      ).toArray()[0];
    const found = row === undefined ? undefined : toDocument(row);
    return found === undefined ? null : JSON.stringify(found);
  }

  async findTreatmentById(id: string, includeDeleted = false): Promise<string | null> {
    const document = this.documentRepository().findTreatmentById(id, includeDeleted);
    return document === null ? null : JSON.stringify(document);
  }

  async findTreatmentByIdentifier(
    identifier: string,
    includeDeleted = false,
  ): Promise<string | null> {
    const document = this.documentRepository().findTreatmentByIdentifier(identifier, includeDeleted);
    return document === null ? null : JSON.stringify(document);
  }

  async findTreatmentForApi3Read(
    identifier: string,
    fieldsJson: string,
  ): Promise<string | null> {
    return this.findApi3Document("treatments", identifier, fieldsJson);
  }

  async findTreatmentByFallback(
    createdAt: string | number,
    eventType: string | number,
    includeDeleted = false,
  ): Promise<string | null> {
    const document = this.documentRepository().findTreatmentByFallback(
      createdAt,
      eventType,
      includeDeleted,
    );
    return document === null ? null : JSON.stringify(document);
  }

  async queryTreatments(queryJson = "{}"): Promise<string> {
    const query = JSON.parse(queryJson) as DocumentQuery;
    return JSON.stringify(this.documentRepository().queryTreatments(query));
  }

  async findApi3Document(
    collection: Api3CollectionName,
    identifier: string,
    fieldsJson: string,
  ): Promise<string | null> {
    const parsed = JSON.parse(fieldsJson) as string[] | null;
    const document = this.documentRepository().findDocumentForApi3Read(
      collection,
      identifier,
      parsed ?? undefined,
    );
    return document === null ? null : JSON.stringify(document);
  }

  async api3QueryCollection(
    collection: Api3CollectionName,
    queryJson = "{}",
  ): Promise<string> {
    try {
      const query = JSON.parse(queryJson) as DocumentQuery;
      return JSON.stringify({
        ok: true,
        result: this.documentRepository().queryDocumentsForApi3(collection, query),
      });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async api3CreateDocument(
    collection: Api3CollectionName,
    documentJson: string,
    optionsJson: string,
  ): Promise<string> {
    const document = JSON.parse(documentJson) as JsonDocument;
    const options = JSON.parse(optionsJson) as Api3MutationOptions;
    try {
      return JSON.stringify(
        this.documentRepository().createDocumentForApi3(collection, document, options),
      );
    } catch (error) {
      return JSON.stringify({
        ok: false,
        reason: "operation-error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async api3ReplaceDocument(
    collection: Api3CollectionName,
    identity: string,
    documentJson: string,
    optionsJson: string,
  ): Promise<string> {
    const document = JSON.parse(documentJson) as JsonDocument;
    const options = JSON.parse(optionsJson) as Api3MutationOptions;
    try {
      return JSON.stringify(
        this.documentRepository().replaceDocumentForApi3(
          collection,
          identity,
          document,
          options,
        ),
      );
    } catch (error) {
      return JSON.stringify({
        ok: false,
        reason: "operation-error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async api3PatchDocument(
    collection: Api3CollectionName,
    identity: string,
    patchJson: string,
    optionsJson: string,
  ): Promise<string> {
    const patch = JSON.parse(patchJson) as JsonDocument;
    const options = JSON.parse(optionsJson) as Api3MutationOptions;
    try {
      return JSON.stringify(
        this.documentRepository().patchDocumentForApi3(
          collection,
          identity,
          patch,
          options,
        ),
      );
    } catch (error) {
      return JSON.stringify({
        ok: false,
        reason: "operation-error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async api3DeleteDocument(
    collection: Api3CollectionName,
    identity: string,
    permanent: boolean,
    actor: string | null,
  ): Promise<DocumentDeleteResult> {
    return this.documentRepository().deleteDocumentForApi3(
      collection,
      identity,
      permanent,
      actor,
    );
  }

  async api3CollectionLastModified(
    collection: Api3CollectionName,
  ): Promise<number | null> {
    return this.documentRepository().collectionLastModified(collection);
  }

  async api3CollectionHistory(
    collection: Api3CollectionName,
    queryJson: string,
  ): Promise<string> {
    const query = JSON.parse(queryJson) as DocumentHistoryQuery;
    return JSON.stringify(this.documentRepository().documentHistory(collection, query));
  }

  async api3QueryTreatments(queryJson = "{}"): Promise<string> {
    return this.api3QueryCollection("treatments", queryJson);
  }

  async queryLegacyTreatments(queryJson = "{}"): Promise<string> {
    const query = JSON.parse(queryJson) as DocumentQuery;
    return JSON.stringify(this.documentRepository().queryLegacyTreatments(query));
  }

  async upsertTreatment(documentJson: string): Promise<string> {
    const document = JSON.parse(documentJson) as JsonDocument;
    return JSON.stringify(this.documentRepository().upsertTreatment(document));
  }

  async createTreatment(documentJson: string): Promise<string> {
    const document = JSON.parse(documentJson) as JsonDocument;
    return JSON.stringify(this.documentRepository().createTreatment(document));
  }

  async api3CreateTreatment(
    documentJson: string,
    optionsJson: string,
  ): Promise<string> {
    return this.api3CreateDocument("treatments", documentJson, optionsJson);
  }

  async replaceTreatment(
    identity: string,
    documentJson: string,
  ): Promise<string> {
    const document = JSON.parse(documentJson) as JsonDocument;
    return JSON.stringify(this.documentRepository().replaceTreatment(identity, document));
  }

  async api3ReplaceTreatment(
    identity: string,
    documentJson: string,
    optionsJson: string,
  ): Promise<string> {
    return this.api3ReplaceDocument("treatments", identity, documentJson, optionsJson);
  }

  async patchTreatment(
    identity: string,
    patchJson: string,
  ): Promise<string | null> {
    const patch = JSON.parse(patchJson) as JsonDocument;
    const result = this.documentRepository().patchTreatment(identity, patch);
    return result === null ? null : JSON.stringify(result);
  }

  async api3PatchTreatment(
    identity: string,
    patchJson: string,
    optionsJson: string,
  ): Promise<string> {
    return this.api3PatchDocument("treatments", identity, patchJson, optionsJson);
  }

  async deleteTreatment(identity: string, permanent = false): Promise<DocumentDeleteResult> {
    return this.documentRepository().deleteTreatment(identity, permanent);
  }

  async api3DeleteTreatment(
    identity: string,
    permanent: boolean,
    actor: string | null,
  ): Promise<DocumentDeleteResult> {
    return this.api3DeleteDocument("treatments", identity, permanent, actor);
  }

  async deleteLegacyTreatment(identity: string): Promise<boolean> {
    return this.documentRepository().deleteLegacyTreatment(identity);
  }

  async treatmentsLastModified(): Promise<number | null> {
    return this.api3CollectionLastModified("treatments");
  }

  async treatmentHistory(queryJson: string): Promise<string> {
    return this.api3CollectionHistory("treatments", queryJson);
  }
}
