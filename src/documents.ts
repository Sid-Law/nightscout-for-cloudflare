import type { DocumentCollection, JsonDocument } from "./entry-store";
import type { DocumentFilter, DocumentQuery } from "./document-repository";
import { ApiError } from "./model";

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIND_PARAMETER = /^find\[([A-Za-z0-9_.-]+)\](?:\[(\$gt|\$gte|\$lt|\$lte|\$ne|\$exists|\$in)\])?$/;
const SORT_PARAMETER = /^sort\[([A-Za-z0-9_.-]+)\]$/;
const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_DOCUMENTS = 100;
const MAX_DEPTH = 16;
const MAX_STRING_LENGTH = 64 * 1024;
const SQLITE_MAX_BINDINGS = 100;
const FOUR_DAYS_MS = 4 * 24 * 60 * 60 * 1000;
const TREATMENT_NUMERIC_QUERY_FIELDS = new Set(["insulin", "carbs", "glucose"]);

function assertJsonValue(value: unknown, depth = 0): void {
  if (depth > MAX_DEPTH) {
    throw new ApiError(400, "invalid_document", "document nesting is too deep");
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ApiError(400, "invalid_document", "document contains a non-finite number");
    }
    return;
  }
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) {
      throw new ApiError(400, "invalid_document", "document contains an oversized string");
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 5000) {
      throw new ApiError(400, "invalid_document", "document contains an oversized array");
    }
    for (const item of value) assertJsonValue(item, depth + 1);
    return;
  }
  if (typeof value !== "object") {
    throw new ApiError(400, "invalid_document", "document contains a non-JSON value");
  }
  for (const [key, item] of Object.entries(value)) {
    if (RESERVED_KEYS.has(key) || key.startsWith("$")) {
      throw new ApiError(400, "invalid_document", `document key ${key} is not allowed`);
    }
    assertJsonValue(item, depth + 1);
  }
}

function normalizeDocument(
  value: unknown,
  collection: DocumentCollection,
  requireId: boolean,
): JsonDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(400, "invalid_document", "each document must be a JSON object");
  }
  assertJsonValue(value);
  const document = { ...(value as JsonDocument) };
  if (document._id !== undefined && document._id !== "") {
    if (typeof document._id !== "string") {
      throw new ApiError(400, "invalid_document", "_id must be a string");
    }
    if (collection !== "treatments" && !OBJECT_ID.test(document._id)) {
      throw new ApiError(400, "invalid_document", "_id must be a 24-character hexadecimal string");
    }
    if (OBJECT_ID.test(document._id)) document._id = document._id.toLowerCase();
  } else {
    delete document._id;
    if (requireId) {
      throw new ApiError(400, "invalid_document", "_id is required for an update");
    }
  }

  if ((collection === "activity" || collection === "treatments") && !document.created_at) {
    document.created_at = new Date().toISOString();
  }
  if (collection === "subjects" && !document.accessToken) {
    document.accessToken = crypto.randomUUID().replaceAll("-", "");
  }
  return document;
}

export function parseDocumentPayload(
  value: unknown,
  collection: DocumentCollection,
  requireId: boolean,
): { documents: JsonDocument[]; inputWasArray: boolean } {
  const inputWasArray = Array.isArray(value);
  const values = inputWasArray ? value : [value];
  if (values.length === 0 || values.length > MAX_DOCUMENTS) {
    throw new ApiError(400, "invalid_batch", `batch must contain 1-${MAX_DOCUMENTS} documents`);
  }
  return {
    documents: values.map((item) => normalizeDocument(item, collection, requireId)),
    inputWasArray,
  };
}

function properties(value: unknown, segments: string[]): unknown[] {
  if (segments.length === 0) return [value];
  if (Array.isArray(value)) return value.flatMap((item) => properties(item, segments));
  if (typeof value !== "object" || value === null) return [];
  const [head, ...tail] = segments;
  return properties((value as JsonDocument)[head!], tail);
}

function comparable(value: unknown): number | string | boolean | null {
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "string") return value === null ? null : JSON.stringify(value);
  const numeric = Number(value);
  if (value.trim() !== "" && Number.isFinite(numeric)) return numeric;
  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp) && /[-T:]/.test(value)) return timestamp;
  return value;
}

function matches(actual: unknown, operator: string | undefined, expectedText: string): boolean {
  if (operator === "$exists") return (actual !== undefined) === (expectedText !== "false" && expectedText !== "0");
  if (operator === "$in") {
    const choices = expectedText.split(",").map((value) => comparable(value.trim()));
    return choices.some((choice) => comparable(actual) === choice);
  }

  const left = comparable(actual);
  const right = comparable(expectedText);
  if (operator === "$ne") return left !== right;
  if (actual === undefined) return false;
  if (operator === undefined && expectedText.startsWith("/") && expectedText.lastIndexOf("/") > 0) {
    const lastSlash = expectedText.lastIndexOf("/");
    const needle = expectedText.slice(1, lastSlash);
    const flags = expectedText.slice(lastSlash + 1);
    if (typeof actual !== "string") return false;
    return flags.includes("i")
      ? actual.toLowerCase().includes(needle.toLowerCase())
      : actual.includes(needle);
  }
  if (operator === "$gt") return left! > right!;
  if (operator === "$gte") return left! >= right!;
  if (operator === "$lt") return left! < right!;
  if (operator === "$lte") return left! <= right!;
  return left === right;
}

export function filterDocuments(
  documents: JsonDocument[],
  url: URL,
  defaultCount: number,
  requiredType?: string,
): JsonDocument[] {
  const rawCount = url.searchParams.get("count") ?? String(defaultCount);
  const count = Number(rawCount);
  if (!Number.isInteger(count) || count < 1 || count > 10000) {
    throw new ApiError(400, "invalid_query", "count must be an integer from 1 to 10000");
  }

  const predicates: Array<{ field: string; operator: string | undefined; expected: string }> = [];
  let sort: { field: string; direction: 1 | -1 } | null = null;
  for (const [name, expected] of url.searchParams) {
    const match = FIND_PARAMETER.exec(name);
    if (match) predicates.push({ field: match[1]!, operator: match[2], expected });
    const sortMatch = SORT_PARAMETER.exec(name);
    if (sortMatch && (expected === "1" || expected === "-1")) {
      sort = { field: sortMatch[1]!, direction: expected === "1" ? 1 : -1 };
    }
  }

  const filtered = documents
    .filter((document) => requiredType === undefined || document.type === requiredType)
    .filter((document) =>
      predicates.every(({ field, operator, expected }) => {
        const actualValues = properties(document, field.split("."));
        if (operator === "$ne") return actualValues.every((actual) => matches(actual, operator, expected));
        return actualValues.some((actual) => matches(actual, operator, expected));
      }),
    );
  if (sort !== null) {
    const selectedSort = sort;
    filtered.sort((left, right) => {
      const leftValue = comparable(properties(left, selectedSort.field.split("."))[0]);
      const rightValue = comparable(properties(right, selectedSort.field.split("."))[0]);
      if (leftValue === rightValue) return 0;
      if (leftValue === undefined) return 1;
      if (rightValue === undefined) return -1;
      return (leftValue! < rightValue! ? -1 : 1) * selectedSort.direction;
    });
  }
  return normalizeTreatmentNumbers(filtered.slice(0, count));
}

export function normalizeTreatmentNumbers(documents: JsonDocument[]): JsonDocument[] {
  return documents.map((document) => {
    const normalized = { ...document };
    normalized.carbs = Number(document.carbs);
    normalized.insulin = Number(document.insulin);
    return normalized;
  });
}

function treatmentQueryScalar(field: string, value: string): string | number {
  if (TREATMENT_NUMERIC_QUERY_FIELDS.has(field)) {
    const numeric = Number.parseInt(value, 10);
    if (!Number.isFinite(numeric)) {
      throw new ApiError(400, "invalid_query", `find[${field}] must be numeric`);
    }
    return numeric;
  }
  if (field === "created_at" && /[-T:]/.test(value)) {
    const parsed = Date.parse(value.replace(" ", "+"));
    if (!Number.isFinite(parsed)) {
      throw new ApiError(400, "invalid_query", `find[${field}] must be a valid ISO-8601 date`);
    }
    return new Date(parsed).toISOString();
  }
  if (field === "_id" && OBJECT_ID.test(value)) return value.toLowerCase();
  return value;
}

function legacyExpressionBindings(field: string): number {
  return field === "_id" || field === "identifier" ? 0 : 1;
}

function assertTreatmentQueryBindings(query: DocumentQuery): void {
  let bindings = 3; // collection + LIMIT + OFFSET
  for (const filter of query.filters ?? []) {
    if (
      filter.field === "_id"
      && filter.operator === "eq"
      && typeof filter.value === "string"
      && UUID.test(filter.value)
    ) {
      bindings += 2;
      continue;
    }
    const expression = legacyExpressionBindings(filter.field);
    switch (filter.operator) {
      case "eq":
        bindings += expression + (filter.value === null ? 0 : 1);
        break;
      case "ne":
        bindings += filter.value === null ? expression : expression * 2 + 1;
        break;
      case "in":
      case "nin":
        bindings += expression + (Array.isArray(filter.value) ? filter.value.length : 1);
        break;
      case "exists":
        bindings += filter.field === "identifier" || filter.field === "_id" ? 0 : 1;
        break;
      default:
        bindings += expression + 1;
    }
  }
  if (query.sort !== undefined) {
    const sorts = Array.isArray(query.sort) ? query.sort : [query.sort];
    for (const sort of sorts) bindings += legacyExpressionBindings(sort.field);
  }
  if (bindings > SQLITE_MAX_BINDINGS) {
    throw new ApiError(
      400,
      "invalid_query",
      `treatments query exceeds SQLite's ${SQLITE_MAX_BINDINGS} bound-parameter limit`,
    );
  }
}

/** Translate the currently supported v1 treatments query surface before LIMIT. */
export function parseTreatmentQuery(url: URL, defaultCount: number): DocumentQuery {
  const rawCount = url.searchParams.get("count") ?? String(defaultCount);
  const count = Number(rawCount);
  if (!Number.isInteger(count) || count < 1 || count > 10000) {
    throw new ApiError(400, "invalid_query", "count must be an integer from 1 to 10000");
  }

  const filters: DocumentFilter[] = [];
  let sort: DocumentQuery["sort"];
  for (const [name, expected] of url.searchParams) {
    const match = FIND_PARAMETER.exec(name);
    if (name.startsWith("find[") && match === null) {
      throw new ApiError(400, "invalid_query", `unsupported treatments query operator in ${name}`);
    }
    if (match !== null) {
      const field = match[1]!;
      const operator = match[2];
      if (field.includes(".")) {
        throw new ApiError(
          400,
          "invalid_query",
          `nested treatments query field ${field} is not yet supported by the SQLite adapter`,
        );
      }
      if (operator === "$exists") {
        filters.push({
          field,
          operator: "exists",
          value: expected !== "false" && expected !== "0",
        });
      } else if (operator === "$in") {
        filters.push({
          field,
          operator: "in",
          value: expected.split(",").map((value) => treatmentQueryScalar(field, value.trim())),
        });
      } else if (operator !== undefined) {
        const mapped = {
          $gt: "gt",
          $gte: "gte",
          $lt: "lt",
          $lte: "lte",
          $ne: "ne",
        } as const;
        filters.push({
          field,
          operator: mapped[operator as keyof typeof mapped],
          value: treatmentQueryScalar(field, expected),
        });
      } else if (expected.startsWith("/") && expected.lastIndexOf("/") > 0) {
        throw new ApiError(
          400,
          "invalid_query",
          `regex treatments query for find[${field}] is not supported by the SQLite adapter`,
        );
      } else {
        filters.push({ field, operator: "eq", value: treatmentQueryScalar(field, expected) });
      }
    }

    const sortMatch = SORT_PARAMETER.exec(name);
    if (sortMatch !== null && (expected === "1" || expected === "-1")) {
      const field = sortMatch[1]!;
      if (field.includes(".")) {
        throw new ApiError(
          400,
          "invalid_query",
          `nested treatments sort field ${field} is not yet supported by the SQLite adapter`,
        );
      }
      sort = { field, direction: expected === "1" ? "asc" : "desc" };
    }
  }

  const skipsDefaultDateWindow = filters.some(
    (filter) => filter.field === "_id" || filter.field === "created_at" || filter.field === "dateString",
  );
  if (!skipsDefaultDateWindow) {
    filters.push({
      field: "created_at",
      operator: "gte",
      value: new Date(Date.now() - FOUR_DAYS_MS).toISOString(),
    });
  }

  const query: DocumentQuery = { filters, limit: count, includeDeleted: true };
  if (sort !== undefined) query.sort = sort;
  assertTreatmentQueryBindings(query);
  return query;
}
