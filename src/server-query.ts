const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const LEGACY_QUERY_DEFAULT_WINDOW_MS = 4 * 24 * 60 * 60 * 1_000;

export class LegacyObjectId {
  readonly value: string;

  constructor(value: string) {
    if (!OBJECT_ID_HEX.test(value)) throw new TypeError("ObjectId must be a 24-character hex string");
    this.value = value.toLowerCase();
  }

  toString(): string {
    return this.value;
  }
}

export type LegacyQueryValue = unknown;
export type LegacyQueryObject = Record<string, LegacyQueryValue>;
export type LegacyQueryTyper = (value: unknown) => unknown;

export interface LegacyQueryOptions {
  deltaAgo?: number;
  dateField?: string;
  walker?: Record<string, LegacyQueryTyper>;
  useEpoch?: boolean;
  noDateFilter?: boolean;
  uuidHandling?: boolean;
}

export interface NormalizedLegacyId {
  value: unknown;
  searchByIdentifier: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function legacyParseInt(value: unknown): number {
  return Number.parseInt(String(value));
}

/** Worker-safe equivalent of locked v15.0.7 lib/server/query.js defaults. */
export function legacyQueryDefaultOptions(
  supplied: LegacyQueryOptions = {},
): Required<Pick<LegacyQueryOptions, "deltaAgo" | "dateField" | "walker">>
  & LegacyQueryOptions {
  const options = supplied;
  if (!Object.prototype.hasOwnProperty.call(options, "deltaAgo")) {
    options.deltaAgo = LEGACY_QUERY_DEFAULT_WINDOW_MS;
  }
  if (!Object.prototype.hasOwnProperty.call(options, "walker")) {
    options.walker = { date: legacyParseInt, sgv: legacyParseInt };
  }
  options.dateField ||= "date";
  return options as Required<Pick<LegacyQueryOptions, "deltaAgo" | "dateField" | "walker">>
    & LegacyQueryOptions;
}

export function legacyDateMinimum(
  now = Date.now(),
  deltaAgo = LEGACY_QUERY_DEFAULT_WINDOW_MS,
): number {
  return now - deltaAgo;
}

/** Preserve the locked date-filter rewrite while replacing moment with platform Date. */
export function enforceLegacyDateFilter(
  query: LegacyQueryObject,
  options: Required<Pick<LegacyQueryOptions, "deltaAgo" | "dateField">> & LegacyQueryOptions,
): void {
  const dateValue = query[options.dateField];
  if (isObject(dateValue)) {
    for (const key of Object.keys(dateValue)) {
      const candidate = dateValue[key];
      if (!Number.isNaN(Number(candidate))) continue;
      if (typeof candidate !== "string") {
        throw new Error(`Cannot parse ${String(candidate)} as a valid ISO-8601 date`);
      }
      const repaired = candidate.replace(" ", "+");
      const parsed = Date.parse(repaired);
      if (!Number.isFinite(parsed)) {
        throw new Error(`Cannot parse ${repaired} as a valid ISO-8601 date`);
      }
      dateValue[key] = new Date(parsed).toISOString();
    }
  }

  if (!dateValue && !query.dateString && options.noDateFilter !== true) {
    const minimum = legacyDateMinimum(Date.now(), options.deltaAgo);
    query[options.dateField] = {
      $gte: options.useEpoch === true ? minimum : new Date(minimum).toISOString(),
    };
  }
}

export function normalizeLegacyIdValue(
  value: unknown,
  options: LegacyQueryOptions = {},
): NormalizedLegacyId {
  if (typeof value === "string" && OBJECT_ID_HEX.test(value)) {
    return { value: new LegacyObjectId(value), searchByIdentifier: false };
  }
  if (typeof value === "string" && UUID.test(value) && options.uuidHandling === true) {
    return { value, searchByIdentifier: true };
  }
  return { value, searchByIdentifier: false };
}

function mapLeaves(value: unknown, mapper: LegacyQueryTyper): unknown {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = mapLeaves(value[index], mapper);
    }
    return value;
  }
  if (isObject(value)) {
    for (const key of Object.keys(value)) value[key] = mapLeaves(value[key], mapper);
    return value;
  }
  return mapper(value);
}

function updateLegacyIdQuery(query: LegacyQueryObject, options: LegacyQueryOptions): void {
  if (!Object.prototype.hasOwnProperty.call(query, "_id")) return;
  if (typeof query._id === "string") {
    const normalized = normalizeLegacyIdValue(query._id, options);
    if (normalized.searchByIdentifier) {
      query.$or = [
        { identifier: normalized.value },
        { _id: normalized.value },
      ];
      delete query._id;
    } else {
      query._id = normalized.value;
    }
    return;
  }
  if (isObject(query._id)) {
    query._id = mapLeaves(
      query._id,
      (value) => normalizeLegacyIdValue(value, options).value,
    );
  }
}

export function legacyWalkProperty(
  property: string,
  typer: LegacyQueryTyper,
): (parameters: LegacyQueryObject) => LegacyQueryObject {
  return (parameters): LegacyQueryObject => {
    const find = parameters.find;
    if (!isObject(find) || !find[property]) return parameters;
    find[property] = typeof find[property] === "string"
      ? typer(find[property])
      : mapLeaves(find[property], typer);
    return parameters;
  };
}

/** Like upstream, a configured walker consumes its mapping queue on first use. */
export function createLegacyQueryWalker(
  specification: Record<string, LegacyQueryTyper>,
): (parameters: LegacyQueryObject) => LegacyQueryObject {
  const queue = Object.entries(specification)
    .map(([property, typer]) => legacyWalkProperty(property, typer));
  return (parameters): LegacyQueryObject => {
    let result = parameters;
    while (queue.length > 0) result = queue.shift()!(result);
    return result;
  };
}

/** Build the Mongo-shaped query consumed by the SQLite translation boundary. */
export function createLegacyMongoQuery(
  parameters: LegacyQueryObject = {},
  suppliedOptions: LegacyQueryOptions = {},
): LegacyQueryObject {
  const options = legacyQueryDefaultOptions(suppliedOptions);
  const walked = createLegacyQueryWalker(options.walker)(parameters);
  const query = isObject(walked.find) ? walked.find : {};
  if (!query._id) enforceLegacyDateFilter(query, options);
  updateLegacyIdQuery(query, options);
  return query;
}

export function parseLegacyRegularExpression(value: string): string | RegExp {
  const match = /\/(.*)\/(.*)/.exec(value);
  return match === null ? value : new RegExp(match[1]!, match[2]!);
}
