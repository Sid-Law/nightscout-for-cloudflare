import type { EntryStore, JsonDocument } from "../entry-store";
import type {
  Api3MutationDecision,
  Api3MutationOptions,
  DocumentMutationResult,
  DocumentQuery,
} from "../document-repository";
import { permissionGroupsAllow } from "../permissions";
import {
  API3_MESSAGES,
  Api3InputError,
  ifUnmodifiedSince,
  normalizeApi3Date,
  parseApi3Document,
  parseApi3Fields,
  parseApi3History,
  parseApi3Search,
  resolveApi3Identifier,
} from "./input";
import {
  api3FormatFromRequest,
  api3Json,
  api3Result,
  api3Status,
  renderApi3,
} from "./response";

const MAX_BODY_BYTES = 512 * 1_024;
const STORAGE_ERROR = "Database error";

export interface Api3Authorization {
  sub: string;
  permissionGroups: string[][];
}

export type Api3TreatmentRoute =
  | { kind: "collection"; extension?: string }
  | { kind: "resource"; identifier: string; extension?: string }
  | { kind: "history"; lastModified?: string; extension?: string };

export function splitApi3Extension(pathname: string): { pathname: string; extension?: string } {
  const slash = pathname.lastIndexOf("/");
  const segment = pathname.slice(slash + 1);
  const dot = segment.indexOf(".");
  if (dot < 0) return { pathname };
  const extension = segment.slice(dot + 1);
  return {
    pathname: `${pathname.slice(0, slash + 1)}${segment.slice(0, dot)}`,
    ...(extension.length === 0 ? {} : { extension }),
  };
}

function decodedPathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function matchApi3TreatmentRoute(method: string, pathname: string): Api3TreatmentRoute | null {
  const trailingTrimmed = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  const split = splitApi3Extension(trailingTrimmed);
  if (
    split.pathname === "/api/v3/treatments"
    && (method === "GET" || method === "POST")
  ) {
    return { kind: "collection", ...(split.extension === undefined ? {} : { extension: split.extension }) };
  }

  if (method === "GET") {
    const history = /^\/api\/v3\/treatments\/history(?:\/([^/]+))?$/.exec(split.pathname);
    if (history !== null) {
      const lastModified = history[1] === undefined ? undefined : decodedPathSegment(history[1]);
      if (lastModified === null) return null;
      return {
        kind: "history",
        ...(lastModified === undefined ? {} : { lastModified }),
        ...(split.extension === undefined ? {} : { extension: split.extension }),
      };
    }
  }

  if (!["GET", "PUT", "PATCH", "DELETE"].includes(method)) return null;
  const resource = /^\/api\/v3\/treatments\/([^/]+)$/.exec(split.pathname);
  if (resource === null) return null;
  const identifier = decodedPathSegment(resource[1]!);
  if (identifier === null) return null;
  return {
    kind: "resource",
    identifier,
    ...(split.extension === undefined ? {} : { extension: split.extension }),
  };
}

function allowed(authorization: Api3Authorization, action: string): boolean {
  return permissionGroupsAllow(
    authorization.permissionGroups,
    `api:treatments:${action}`,
  );
}

function forbidden(action: string): Response {
  return api3Status(403, `Missing permission api:treatments:${action}`);
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("Content-Type")?.toLowerCase();
  if (contentType === undefined || (!contentType.includes("application/json") && !contentType.includes("+json"))) {
    throw new Api3InputError(400, API3_MESSAGES.badBody);
  }
  if (request.body === null) throw new Api3InputError(400, API3_MESSAGES.badBody);
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    throw new Api3InputError(413, "Request body exceeds the Workers adapter limit", true);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Api3InputError(413, "Request body exceeds the Workers adapter limit", true);
    }
    chunks.push(part.value);
  }
  if (total === 0) throw new Api3InputError(400, API3_MESSAGES.badBody);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    // The locked body-parser error middleware uses API3's 500 envelope.
    throw new Api3InputError(500, "Internal Server Error");
  }
}

/** Mirrors the global JSON parser's position before extension and route handling. */
export async function api3BodyParserFailure(request: {
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}): Promise<Response | null> {
  const contentType = request.headers.get("Content-Type")?.toLowerCase();
  if (contentType === undefined || (!contentType.includes("application/json") && !contentType.includes("+json"))) {
    return null;
  }
  if (request.body === null) return null;
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    return api3Status(413, "Request body exceeds the Workers adapter limit");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return api3Status(413, "Request body exceeds the Workers adapter limit");
    }
    chunks.push(part.value);
  }
  if (total === 0) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    JSON.parse(new TextDecoder().decode(bytes));
    return null;
  } catch {
    return api3Status(500, "Internal Server Error");
  }
}

function parseDecision(value: string): Api3MutationDecision {
  return JSON.parse(value) as Api3MutationDecision;
}

function mutationOptions(
  authorization: Api3Authorization,
  request: Request,
): Api3MutationOptions {
  return {
    canCreate: allowed(authorization, "create"),
    canUpdate: allowed(authorization, "update"),
    actor: authorization.sub || null,
    ifUnmodifiedSince: ifUnmodifiedSince(request),
    validate: true,
  };
}

function mutationFailure(decision: Extract<Api3MutationDecision, { ok: false }>): Response {
  switch (decision.reason) {
    case "operation-error":
      return operationError(new Error(decision.message)) ?? api3Status(500, STORAGE_ERROR);
    case "missing-create-permission":
      return forbidden("create");
    case "missing-update-permission":
      return forbidden("update");
    case "not-found":
      return api3Status(404);
    case "gone":
      return api3Status(410);
    case "precondition-failed":
      return api3Status(412);
  }
}

function lastModifiedHeaders(modified: number | null): Headers {
  const headers = new Headers();
  if (modified !== null) headers.set("Last-Modified", new Date(modified).toUTCString());
  return headers;
}

function mutationIdentifier(mutation: DocumentMutationResult): string {
  const identifier = mutation.document.identifier;
  if (typeof identifier !== "string" || identifier.length === 0) {
    throw new Error("API3 treatment mutation returned no identifier");
  }
  return identifier;
}

function project(document: JsonDocument, fields: string[] | undefined): JsonDocument {
  if (fields === undefined) return document;
  const projected: JsonDocument = {};
  for (const field of fields) {
    const value = document[field];
    if (value !== undefined) projected[field] = value;
  }
  return projected;
}

function documentModified(document: JsonDocument): number | null {
  const value = document.srvModified;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
}

function conditionallyNotModified(request: Request, modified: number | null): boolean {
  if (modified === null) return false;
  const value = request.headers.get("If-Modified-Since");
  if (value === null) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    && Math.floor(modified / 1_000) * 1_000 <= Math.floor(parsed / 1_000) * 1_000;
}

function permanentDeleteRequested(url: URL): boolean {
  const values = url.searchParams.getAll("permanent");
  return values.length === 1 && values[0] === "true";
}

function operationError(error: unknown): Response | null {
  if (error instanceof Api3InputError) return api3Status(error.status, error.message);
  const message = error instanceof Error ? error.message : String(error);
  if (message === "Trying to modify read-only document") return api3Status(422, message);
  const validationMessages: readonly string[] = [
    API3_MESSAGES.badDate,
    API3_MESSAGES.badUtcOffset,
    API3_MESSAGES.badApp,
    API3_MESSAGES.badIdentifier,
  ];
  if (validationMessages.includes(message)) {
    return api3Status(400, message);
  }
  if (message.startsWith("Field ") && message.endsWith(" cannot be modified by the client")) {
    return api3Status(400, message);
  }
  if (
    message.startsWith("invalid query field")
    || message.startsWith("invalid document sort")
    || message.startsWith("document query exceeds SQLite")
    || message.startsWith("LIKE pattern exceeds SQLite")
  ) {
    return api3Status(400, message);
  }
  return null;
}

async function createTreatment(
  request: Request,
  store: DurableObjectStub<EntryStore>,
  authorization: Api3Authorization,
): Promise<Response> {
  const document = parseApi3Document(await readJsonBody(request));
  normalizeApi3Date(document);
  await resolveApi3Identifier(document);
  const decision = parseDecision(await store.api3CreateTreatment(
    JSON.stringify(document),
    JSON.stringify(mutationOptions(authorization, request)),
  ));
  if (!decision.ok) return mutationFailure(decision);

  const identifier = mutationIdentifier(decision.mutation);
  const modified = decision.mutation.srvModified;
  const headers = lastModifiedHeaders(modified);
  headers.set("Location", `/api/v3/treatments/${identifier}`);
  if (decision.mutation.created) {
    return api3Json({ status: 201, identifier, lastModified: modified }, 201, headers);
  }
  const body: Record<string, unknown> = {
    status: 200,
    identifier,
    lastModified: modified,
    isDeduplication: true,
  };
  if (decision.mutation.deduplicatedIdentifier !== undefined) {
    body.deduplicatedIdentifier = decision.mutation.deduplicatedIdentifier;
  }
  return api3Json(body, 200, headers);
}

async function replaceTreatment(
  request: Request,
  store: DurableObjectStub<EntryStore>,
  authorization: Api3Authorization,
  identifier: string,
): Promise<Response> {
  const document = parseApi3Document(await readJsonBody(request));
  normalizeApi3Date(document);
  await resolveApi3Identifier(document);
  document.identifier = identifier;
  const decision = parseDecision(await store.api3ReplaceTreatment(
    identifier,
    JSON.stringify(document),
    JSON.stringify(mutationOptions(authorization, request)),
  ));
  if (!decision.ok) return mutationFailure(decision);

  const modified = decision.mutation.srvModified;
  const headers = lastModifiedHeaders(modified);
  if (decision.mutation.created) {
    const actualIdentifier = mutationIdentifier(decision.mutation);
    // insert() joins req.path and identifier even for PUT in the locked handler.
    headers.set("Location", `/api/v3/treatments/${identifier}/${actualIdentifier}`);
    return api3Json(
      { status: 201, identifier: actualIdentifier, lastModified: modified },
      201,
      headers,
    );
  }
  return api3Json({ status: 200, lastModified: modified }, 200, headers);
}

async function patchTreatment(
  request: Request,
  store: DurableObjectStub<EntryStore>,
  authorization: Api3Authorization,
  identifier: string,
): Promise<Response> {
  const patch = parseApi3Document(await readJsonBody(request));
  const decision = parseDecision(await store.api3PatchTreatment(
    identifier,
    JSON.stringify(patch),
    JSON.stringify(mutationOptions(authorization, request)),
  ));
  if (!decision.ok) return mutationFailure(decision);
  return api3Json(
    { status: 200 },
    200,
    lastModifiedHeaders(decision.mutation.srvModified),
  );
}

async function deleteTreatment(
  store: DurableObjectStub<EntryStore>,
  authorization: Api3Authorization,
  identifier: string,
  permanent: boolean,
): Promise<Response> {
  if (!allowed(authorization, "delete")) return forbidden("delete");
  const result = await store.api3DeleteTreatment(identifier, permanent, authorization.sub || null);
  return result.deleted ? api3Status(200) : api3Status(404);
}

async function readTreatment(
  request: Request,
  url: URL,
  store: DurableObjectStub<EntryStore>,
  authorization: Api3Authorization,
  route: Extract<Api3TreatmentRoute, { kind: "resource" }>,
): Promise<Response> {
  if (!allowed(authorization, "read")) return forbidden("read");
  const fields = parseApi3Fields(url);
  const value = await store.findTreatmentForApi3Read(
    route.identifier,
    JSON.stringify(fields ?? null),
  );
  if (value === null) return api3Status(404);
  const document = JSON.parse(value) as JsonDocument;
  if (document.isValid === false) return api3Status(410);
  const modified = documentModified(document);
  const headers = lastModifiedHeaders(modified);
  if (conditionallyNotModified(request, modified)) {
    return new Response(null, { status: 304, headers });
  }
  const format = api3FormatFromRequest(request, route.extension);
  return renderApi3(format, project(document, fields), headers);
}

async function searchTreatments(
  request: Request,
  url: URL,
  store: DurableObjectStub<EntryStore>,
  authorization: Api3Authorization,
  extension: string | undefined,
): Promise<Response> {
  if (!allowed(authorization, "read")) return forbidden("read");
  const input = parseApi3Search(url);
  const query: DocumentQuery = {
    filters: input.filters,
    sort: input.sort,
    limit: input.limit,
    skip: input.skip,
    includeDeleted: false,
  };
  if (input.fields !== undefined) query.fields = input.fields;
  const decision = JSON.parse(await store.api3QueryTreatments(JSON.stringify(query))) as
    | { ok: true; result: JsonDocument[] }
    | { ok: false; message: string };
  if (!decision.ok) throw new Error(decision.message);
  const result = decision.result;
  return renderApi3(api3FormatFromRequest(request, extension), result);
}

async function historyTreatments(
  request: Request,
  url: URL,
  store: DurableObjectStub<EntryStore>,
  authorization: Api3Authorization,
  route: Extract<Api3TreatmentRoute, { kind: "history" }>,
): Promise<Response> {
  if (!allowed(authorization, "read")) return forbidden("read");
  const input = parseApi3History(
    url,
    route.lastModified,
    request.headers.get("Last-Modified"),
  );
  const requestedFields = input.fields;
  const storageInput = { ...input };
  if (requestedFields !== undefined) {
    storageInput.fields = Array.from(new Set([
      ...requestedFields,
      "identifier",
      "srvCreated",
      "created_at",
      "date",
    ]));
  }
  const result = JSON.parse(
    await store.treatmentHistory(JSON.stringify(storageInput)),
  ) as JsonDocument[];
  const headers = new Headers();
  if (result.length > 0) {
    const maximum = Math.max(...result.map((document) => {
      const modified = documentModified(document);
      if (modified !== null) return modified;
      const createdAt = document.created_at;
      const parsed = typeof createdAt === "number"
        ? createdAt
        : typeof createdAt === "string"
          ? Date.parse(createdAt)
          : Number.NaN;
      return Number.isFinite(parsed) ? Math.trunc(parsed) : Number.NaN;
    }));
    if (Number.isFinite(maximum)) {
      headers.set("Last-Modified", new Date(maximum).toUTCString());
      headers.set("ETag", `W/"${maximum}"`);
    }
  }
  const rendered = requestedFields === undefined
    ? result
    : result.map((document) => project(document, requestedFields));
  return renderApi3(api3FormatFromRequest(request, route.extension), rendered, headers);
}

export async function handleApi3Treatments(
  request: Request,
  url: URL,
  store: DurableObjectStub<EntryStore>,
  authorization: Api3Authorization,
  route: Api3TreatmentRoute,
): Promise<Response> {
  try {
    if (route.kind === "collection") {
      if (request.method === "GET") {
        return await searchTreatments(request, url, store, authorization, route.extension);
      }
      if (request.method === "POST") return await createTreatment(request, store, authorization);
      return api3Status(404, "Bad operation or collection");
    }
    if (route.kind === "history") {
      return request.method === "GET"
        ? await historyTreatments(request, url, store, authorization, route)
        : api3Status(404, "Bad operation or collection");
    }
    if (request.method === "GET") {
      return await readTreatment(request, url, store, authorization, route);
    }
    if (request.method === "PUT") {
      return await replaceTreatment(request, store, authorization, route.identifier);
    }
    if (request.method === "PATCH") {
      return await patchTreatment(request, store, authorization, route.identifier);
    }
    if (request.method === "DELETE") {
      return await deleteTreatment(
        store,
        authorization,
        route.identifier,
        permanentDeleteRequested(url),
      );
    }
    return api3Status(404, "Bad operation or collection");
  } catch (error) {
    const response = operationError(error);
    if (response !== null) return response;
    console.error(JSON.stringify({ message: "API3 treatments operation failed", error: error instanceof Error ? error.message : String(error) }));
    return api3Status(500, STORAGE_ERROR);
  }
}

export async function handleApi3TreatmentsLastModified(
  store: DurableObjectStub<EntryStore>,
  authorization: Api3Authorization,
): Promise<Response> {
  const collections: Record<string, number> = {};
  if (allowed(authorization, "read")) {
    const modified = await store.treatmentsLastModified();
    if (modified !== null) collections.treatments = modified;
  }
  return api3Result({ srvDate: Date.now(), collections });
}
