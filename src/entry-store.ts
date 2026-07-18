import { DurableObject } from "cloudflare:workers";
import {
  createJwtSecret,
  issueJwt as signJwt,
  verifyJwt as validateJwt,
} from "./jwt";
import {
  migrateDocumentsV4,
  SqliteDocumentRepository,
  type Api3CollectionName,
  type Api3MutationOptions,
  type DocumentDeleteResult,
  type DocumentHistoryQuery,
  type DocumentQuery,
} from "./document-repository";
import type { HistoryQuery, PublicEntry, ValidatedEntry } from "./model";
import { migrateRealtimeSessions } from "./realtime/session-repository";
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
  REALTIME_SNAPSHOT_MAX_BYTES,
  REALTIME_SNAPSHOT_MAX_DOCUMENT_DEPTH,
  REALTIME_SNAPSHOT_MAX_DOCUMENTS,
  REALTIME_SNAPSHOT_MAX_NODES,
  REALTIME_SNAPSHOT_MAX_STRING_CHARACTERS,
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

interface DbEntry {
  [key: string]: SqlStorageValue;
  id: string;
  identifier: string | null;
  dedupe_key: string;
  sgv: number;
  date: number;
  date_string: string;
  direction: string;
  device: string;
  type: "sgv";
}

interface DbDocument {
  [key: string]: SqlStorageValue;
  id: string;
  body: string;
  sort_time: number;
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

type EntryStoreEnv = Env & { API_SECRET?: string };

function randomObjectId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toPublicEntry(row: DbEntry): PublicEntry {
  const entry: PublicEntry = {
    _id: row.id,
    sgv: row.sgv,
    date: row.date,
    dateString: row.date_string,
    direction: row.direction,
    device: row.device,
    type: "sgv",
  };
  if (row.identifier !== null) entry.identifier = row.identifier;
  return entry;
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

const realtimeJsonEncoder = new TextEncoder();

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

  constructor(ctx: DurableObjectState, env: EntryStoreEnv) {
    super(ctx, env);
    this.realtime = new RealtimeSessionService(ctx.storage, {
      snapshot: (now) => this.realtimeSnapshot(now),
      retroDeviceStatus: (now) => this.realtimeRetroDeviceStatus(now),
      status: (now) => nightscoutWebsocketStatus(new Date(now)),
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
            identifier TEXT UNIQUE,
            dedupe_key TEXT NOT NULL UNIQUE,
            sgv INTEGER NOT NULL CHECK (sgv >= 20 AND sgv <= 600),
            date INTEGER NOT NULL,
            date_string TEXT NOT NULL,
            direction TEXT NOT NULL,
            device TEXT NOT NULL,
            type TEXT NOT NULL CHECK (type = 'sgv'),
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
    });
  }

  private documentRepository(): SqliteDocumentRepository {
    return new SqliteDocumentRepository(this.ctx.storage);
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

    for (const row of this.ctx.storage.sql.exec<DbEntry>(
      `SELECT id, identifier, dedupe_key, sgv, date, date_string, direction, device, type
       FROM entries ORDER BY date DESC LIMIT 1000`,
    )) {
      const entry = toPublicEntry(row);
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

  private async realtimeAuthorize(
    message: Record<string, unknown>,
  ): Promise<RealtimeAuthorization | null> {
    const rawSecret = message.secret === "null" ? null : message.secret;
    const rawToken = message.token;
    if (
      (rawSecret === undefined || rawSecret === null || rawSecret === "") &&
      (rawToken === undefined || rawToken === null || rawToken === "")
    ) {
      return { read: true, write: false, write_treatment: false };
    }

    if (typeof rawSecret === "string" && rawSecret.length <= 4096) {
      const configured = this.env.API_SECRET;
      if (configured !== undefined && configured.length >= 12) {
        const encoder = new TextEncoder();
        const [sha1, sha512] = await Promise.all([
          crypto.subtle.digest("SHA-1", encoder.encode(configured)),
          crypto.subtle.digest("SHA-512", encoder.encode(configured)),
        ]);
        const hex = (value: ArrayBuffer): string =>
          Array.from(
            new Uint8Array(value),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join("");
        const presented = rawSecret.toLowerCase();
        if (
          await this.timingSafeRealtimeCredential(presented, hex(sha1)) ||
          await this.timingSafeRealtimeCredential(presented, hex(sha512))
        ) {
          return { read: true, write: false, write_treatment: false };
        }
      }

      const subject = await this.findDocumentByField("subjects", "accessToken", rawSecret);
      if (subject !== null) {
        return { read: true, write: false, write_treatment: false };
      }
    }

    if (typeof rawToken === "string" && rawToken.length <= 4096) {
      const claims = await validateJwt(this.getOrCreateJwtSecret(), rawToken);
      if (claims !== null) {
        const subject = await this.findDocumentByField(
          "subjects",
          "accessToken",
          claims.accessToken,
        );
        if (subject !== null) {
          return { read: true, write: false, write_treatment: false };
        }
      }
    }
    return null;
  }

  private async timingSafeRealtimeCredential(left: string, right: string): Promise<boolean> {
    const encoder = new TextEncoder();
    const [leftDigest, rightDigest] = await Promise.all([
      crypto.subtle.digest("SHA-256", encoder.encode(left)),
      crypto.subtle.digest("SHA-256", encoder.encode(right)),
    ]);
    const leftBytes = new Uint8Array(leftDigest);
    const rightBytes = new Uint8Array(rightDigest);
    let difference = 0;
    for (let index = 0; index < leftBytes.length; index += 1) {
      difference |= leftBytes[index]! ^ rightBytes[index]!;
    }
    return difference === 0;
  }

  private async synchronizeRealtimeAlarm(): Promise<void> {
    // Cloudflare persists one alarm per Durable Object. Derive that alarm from
    // SQL after every state transition so eviction never makes in-memory timer
    // state authoritative.
    const nextDeadline = this.realtime.nextDeadline();
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (nextDeadline === null) {
      if (currentAlarm !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    if (currentAlarm !== nextDeadline) {
      await this.ctx.storage.setAlarm(nextDeadline);
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
      await this.synchronizeRealtimeAlarm();
    }
  }

  override async alarm(_alarmInfo?: AlarmInvocationInfo): Promise<void> {
    // Alarm delivery is at-least-once. processAlarm commits every durable
    // transition transactionally before this derived schedule is replaced.
    this.realtime.processAlarm();
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
    if (existing !== undefined) return existing.value;

    const value = createJwtSecret();
    this.ctx.storage.sql.exec(
      "INSERT INTO tenant_secrets (name, value, created_at) VALUES ('authorization-jwt', ?, ?)",
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
    let inserted = 0;
    let duplicates = 0;
    const stored: PublicEntry[] = [];

    for (const entry of entries) {
      const id = entry.requestedId ?? randomObjectId();
      const existing = this.ctx.storage.sql
        .exec<DbEntry>(
          `SELECT id, identifier, dedupe_key, sgv, date, date_string, direction, device, type
           FROM entries
           WHERE dedupe_key = ? OR id = ? OR identifier = ?
           LIMIT 1`,
          entry.dedupeKey,
          id,
          entry.identifier,
        )
        .toArray()[0];

      if (existing !== undefined) {
        duplicates += 1;
        stored.push(toPublicEntry(existing));
        continue;
      }

      this.ctx.storage.sql.exec(
        `INSERT INTO entries
          (id, identifier, dedupe_key, sgv, date, date_string, direction, device, type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sgv', ?)`,
        id,
        entry.identifier,
        entry.dedupeKey,
        entry.sgv,
        entry.date,
        entry.dateString,
        entry.direction,
        entry.device,
        Date.now(),
      );
      inserted += 1;
      stored.push(
        toPublicEntry({
          id,
          identifier: entry.identifier,
          dedupe_key: entry.dedupeKey,
          sgv: entry.sgv,
          date: entry.date,
          date_string: entry.dateString,
          direction: entry.direction,
          device: entry.device,
          type: "sgv",
        }),
      );
    }

    return { inserted, duplicates, entries: stored };
  }

  async getEntries(query: HistoryQuery): Promise<PublicEntry[]> {
    const conditions: string[] = [];
    const bindings: number[] = [];
    const add = (operator: string, value: number | null): void => {
      if (value !== null) {
        conditions.push(`date ${operator} ?`);
        bindings.push(value);
      }
    };
    add(">", query.gt);
    add(">=", query.gte);
    add("<", query.lt);
    add("<=", query.lte);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.ctx.storage.sql
      .exec<DbEntry>(
        `SELECT id, identifier, dedupe_key, sgv, date, date_string, direction, device, type
         FROM entries ${where}
         ORDER BY date DESC
         LIMIT ?`,
        ...bindings,
        query.count,
      )
      .toArray();
    return rows.map(toPublicEntry);
  }

  async getCurrent(): Promise<PublicEntry[]> {
    const row = this.ctx.storage.sql
      .exec<DbEntry>(
        `SELECT id, identifier, dedupe_key, sgv, date, date_string, direction, device, type
         FROM entries
         ORDER BY date DESC
         LIMIT 1`,
      )
      .toArray()[0];
    return row === undefined ? [] : [toPublicEntry(row)];
  }

  async deleteEntries(
    ids: string[],
    lte: number | null = null,
    gte: number | null = null,
  ): Promise<number> {
    let deleted = 0;
    for (const id of ids) {
      deleted += this.ctx.storage.sql.exec("DELETE FROM entries WHERE id = ?", id).rowsWritten;
    }
    if (ids.length === 0 && (lte !== null || gte !== null)) {
      const conditions: string[] = [];
      const bindings: number[] = [];
      if (lte !== null) {
        conditions.push("date <= ?");
        bindings.push(lte);
      }
      if (gte !== null) {
        conditions.push("date >= ?");
        bindings.push(gte);
      }
      deleted += this.ctx.storage.sql
        .exec(`DELETE FROM entries WHERE ${conditions.join(" AND ")}`, ...bindings).rowsWritten;
    }
    return deleted;
  }

  async listDocuments(collection: DocumentCollection, limit = 5000): Promise<string> {
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
    const documents = JSON.parse(documentsJson) as JsonDocument[];
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
    const documents = JSON.parse(documentsJson) as JsonDocument[];
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
