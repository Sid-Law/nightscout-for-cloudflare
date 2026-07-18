const MIN_DATE = Date.UTC(2000, 0, 1);
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;
const MAX_BATCH_SIZE = 100;
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;
const DIRECTIONS = [
  "TripleUp",
  "DoubleUp",
  "SingleUp",
  "FortyFiveUp",
  "Flat",
  "FortyFiveDown",
  "SingleDown",
  "DoubleDown",
  "TripleDown",
  "NOT COMPUTABLE",
  "RATE OUT OF RANGE",
  "NONE",
] as const;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type EntryJsonValue =
  | string
  | number
  | boolean
  | null
  | EntryJsonValue[]
  | { [key: string]: EntryJsonValue };

export interface EntryJsonDocument {
  [key: string]: EntryJsonValue;
}

export interface ValidatedEntry {
  documentJson: string;
  requestedId: string | null;
  identifier: string | null;
  identifierPresent: boolean;
  dedupeKey: string;
  sysTime: string;
  date: number;
  direction: string;
  device: string;
  type: string;
}

export interface PublicEntry {
  _id: string;
  identifier?: string | null;
  sgv?: number;
  mbg?: number;
  date: number;
  dateString?: string;
  direction?: string;
  device?: string;
  type: string;
}

export interface HistoryQuery {
  count: number;
  gt: number | null;
  gte: number | null;
  lt: number | null;
  lte: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  field: string,
  defaultValue: string,
  maxLength: number,
): string {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (typeof value !== "string") {
    throw new ApiError(400, "invalid_entry", `${field} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new ApiError(400, "invalid_entry", `${field} has an invalid length`);
  }
  return normalized;
}

function parseDate(entry: Record<string, unknown>): number {
  let date: number;
  if (typeof entry.date === "number" && Number.isFinite(entry.date)) {
    date = Math.trunc(entry.date);
  } else if (typeof entry.dateString === "string") {
    date = Date.parse(entry.dateString);
  } else {
    throw new ApiError(400, "invalid_entry", "date or dateString is required");
  }

  if (!Number.isFinite(date) || date < MIN_DATE || date > Date.now() + MAX_FUTURE_MS) {
    throw new ApiError(400, "invalid_entry", "date is outside the accepted range");
  }
  return date;
}

function parseIdentity(entry: Record<string, unknown>): {
  requestedId: string | null;
  identifier: string | null;
  identifierPresent: boolean;
} {
  let requestedId: string | null = null;
  let identifier: string | null = null;
  // JSON.stringify omits an own property whose value is undefined. Treat the
  // same in direct RPC/unit-test callers so identity semantics do not depend
  // on whether the payload crossed an HTTP JSON boundary first.
  let identifierPresent = Object.prototype.hasOwnProperty.call(entry, "identifier")
    && entry.identifier !== undefined;

  if (identifierPresent && entry.identifier !== null) {
    if (typeof entry.identifier !== "string" || !SAFE_IDENTIFIER.test(entry.identifier)) {
      throw new ApiError(400, "invalid_entry", "identifier has an invalid format");
    }
    identifier = entry.identifier;
  }

  if (entry._id !== undefined && entry._id !== null && entry._id !== "") {
    if (typeof entry._id !== "string") {
      throw new ApiError(400, "invalid_entry", "_id must be a string");
    }
    if (OBJECT_ID.test(entry._id)) {
      requestedId = entry._id.toLowerCase();
    } else if (UUID.test(entry._id)) {
      identifier ??= entry._id;
      identifierPresent = true;
    } else {
      throw new ApiError(400, "invalid_entry", "_id must be a 24-hex ObjectId or UUID");
    }
  }

  return { requestedId, identifier, identifierPresent };
}

function parsedZoneOffset(value: string): number {
  if (/[zZ]$/.test(value)) return 0;
  const match = /([+-])(\d{2}):?(\d{2})$/.exec(value);
  if (match === null) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

function validateEntry(value: unknown): ValidatedEntry {
  if (!isRecord(value)) {
    throw new ApiError(400, "invalid_entry", "each entry must be a JSON object");
  }

  const date = parseDate(value);
  const type = boundedString(value.type, "type", "sgv", 32);
  if (!/^[A-Za-z0-9_-]+$/.test(type)) {
    throw new ApiError(400, "invalid_entry", "type has an invalid format");
  }
  const measurementField = type === "mbg" ? "mbg" : type === "sgv" ? "sgv" : null;
  if (measurementField !== null) {
    const measurement = value[measurementField];
    if (typeof measurement !== "number" || !Number.isInteger(measurement)) {
      throw new ApiError(400, "invalid_entry", `${measurementField} must be an integer`);
    }
    if (measurement < 20 || measurement > 600) {
      throw new ApiError(
        400,
        "invalid_entry",
        `${measurementField} must be between 20 and 600 mg/dL`,
      );
    }
  }
  const direction = boundedString(value.direction, "direction", "NONE", 32);
  if (type === "sgv" && !DIRECTIONS.includes(direction as (typeof DIRECTIONS)[number])) {
    throw new ApiError(400, "invalid_entry", "direction is not a known Nightscout direction");
  }
  const device = boundedString(value.device, "device", "unknown", 80);
  const identity = parseIdentity(value);
  const sourceDateString = typeof value.dateString === "string" && value.dateString.length > 0
    ? value.dateString
    : null;
  const sysTimeMillis = sourceDateString === null ? date : Date.parse(sourceDateString);
  if (!Number.isFinite(sysTimeMillis)) {
    throw new ApiError(400, "invalid_entry", "dateString is not a valid timestamp");
  }
  const sysTime = new Date(sysTimeMillis).toISOString();
  const document = { ...value } as EntryJsonDocument;
  delete document._id;
  if (identity.requestedId !== null) document._id = identity.requestedId;
  if (identity.identifierPresent) document.identifier = identity.identifier;
  else delete document.identifier;
  document.date = date;
  // Locked v15.0.7 lib/server/entries.js uses moment.parseZone: sysTime is
  // always normalized to UTC, utcOffset preserves the supplied zone, and a
  // date-only payload does not acquire a dateString field.
  if (sourceDateString === null) delete document.dateString;
  else document.dateString = sysTime;
  document.sysTime = sysTime;
  document.utcOffset = sourceDateString === null ? 0 : parsedZoneOffset(sourceDateString);
  document.type = type;
  document.direction = direction;
  document.device = device;

  return {
    ...identity,
    documentJson: JSON.stringify(document),
    // Locked v15.0.7 lib/server/entries.js always upserts v1 entries by
    // normalized sysTime + type, independently of identifier or device.
    dedupeKey: JSON.stringify([sysTime, type]),
    sysTime,
    date,
    direction,
    device,
    type,
  };
}

export function parseEntryPayload(value: unknown): ValidatedEntry[] {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0 || values.length > MAX_BATCH_SIZE) {
    throw new ApiError(400, "invalid_batch", `batch must contain 1-${MAX_BATCH_SIZE} entries`);
  }
  return values.map(validateEntry);
}

function parseTime(value: string | null, name: string): number | null {
  if (value === null || value === "") return null;
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) ? numeric : Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ApiError(400, "invalid_query", `${name} must be epoch milliseconds or ISO time`);
  }
  return Math.trunc(parsed);
}

export function parseHistoryQuery(url: URL): HistoryQuery {
  const rawCount = url.searchParams.get("count") ?? "10";
  const count = Number(rawCount);
  if (!Number.isInteger(count) || count < 1 || count > 10000) {
    throw new ApiError(400, "invalid_query", "count must be an integer from 1 to 10000");
  }

  return {
    count,
    gt: parseTime(url.searchParams.get("find[date][$gt]"), "find[date][$gt]"),
    gte: parseTime(
      url.searchParams.get("find[date][$gte]") ?? url.searchParams.get("from"),
      "find[date][$gte]",
    ),
    lt: parseTime(url.searchParams.get("find[date][$lt]"), "find[date][$lt]"),
    lte: parseTime(
      url.searchParams.get("find[date][$lte]") ?? url.searchParams.get("to"),
      "find[date][$lte]",
    ),
  };
}
