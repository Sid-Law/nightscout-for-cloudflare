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

export interface ValidatedEntry {
  requestedId: string | null;
  identifier: string | null;
  dedupeKey: string;
  sgv: number;
  date: number;
  dateString: string;
  direction: string;
  device: string;
  type: "sgv";
}

export interface PublicEntry {
  _id: string;
  identifier?: string;
  sgv: number;
  date: number;
  dateString: string;
  direction: string;
  device: string;
  type: "sgv";
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
} {
  let requestedId: string | null = null;
  let identifier: string | null = null;

  if (entry.identifier !== undefined) {
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
    } else {
      throw new ApiError(400, "invalid_entry", "_id must be a 24-hex ObjectId or UUID");
    }
  }

  return { requestedId, identifier };
}

function validateEntry(value: unknown): ValidatedEntry {
  if (!isRecord(value)) {
    throw new ApiError(400, "invalid_entry", "each entry must be a JSON object");
  }
  if (typeof value.sgv !== "number" || !Number.isInteger(value.sgv)) {
    throw new ApiError(400, "invalid_entry", "sgv must be an integer");
  }
  if (value.sgv < 20 || value.sgv > 600) {
    throw new ApiError(400, "invalid_entry", "sgv must be between 20 and 600 mg/dL");
  }

  const date = parseDate(value);
  const type = boundedString(value.type, "type", "sgv", 16);
  if (type !== "sgv") {
    throw new ApiError(400, "invalid_entry", "phase 1 accepts only type=sgv");
  }
  const direction = boundedString(value.direction, "direction", "NONE", 32);
  if (!DIRECTIONS.includes(direction as (typeof DIRECTIONS)[number])) {
    throw new ApiError(400, "invalid_entry", "direction is not a known Nightscout direction");
  }
  const device = boundedString(value.device, "device", "nscf-simulator", 80);
  const identity = parseIdentity(value);

  return {
    ...identity,
    dedupeKey: `${date}:sgv`,
    sgv: value.sgv,
    date,
    dateString: new Date(date).toISOString(),
    direction,
    device,
    type: "sgv",
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
  if (!Number.isInteger(count) || count < 1 || count > 1000) {
    throw new ApiError(400, "invalid_query", "count must be an integer from 1 to 1000");
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
