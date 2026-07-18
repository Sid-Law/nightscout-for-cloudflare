import { EntryStore } from "./entry-store";
import mime from "mime";
import type { DocumentCollection, JsonDocument } from "./entry-store";
import {
  filterDocuments,
  normalizeTreatmentNumbers,
  parseDocumentPayload,
  parseTreatmentQuery,
} from "./documents";
import { ApiError, parseEntryPayload, parseHistoryQuery } from "./model";
import type { PublicEntry } from "./model";
import { permissionGroupsAllow } from "./permissions";
import { handleSocketIoPolling } from "./realtime/http-adapter";
import { nightscoutStatus } from "./status";
import {
  handleApi3DeviceStatus,
  handleApi3Treatments,
  handleApi3TreatmentsLastModified,
  matchApi3DeviceStatusRoute,
  matchApi3TreatmentRoute,
  api3BodyParserFailure,
  splitApi3Extension,
  type Api3CollectionRoute,
} from "./api3/treatments";

export { EntryStore };

const MAX_BODY_BYTES = 512 * 1024;
const TENANT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTF8_CONTENT_TYPES = [
  "text/",
  "application/javascript",
  "application/json",
  "application/xml",
  "image/svg+xml",
];
const MIN_API_SECRET_LENGTH = 12;
const DEFAULT_ROLES: JsonDocument[] = [
  { name: "admin", permissions: ["*"] },
  { name: "denied", permissions: [] },
  { name: "status-only", permissions: ["api:status:read"] },
  { name: "readable", permissions: ["*:*:read"] },
  { name: "careportal", permissions: ["api:treatments:create"] },
  { name: "devicestatus-upload", permissions: ["api:devicestatus:create"] },
  { name: "activity", permissions: ["api:activity:create"] },
];

type AppEnv = Env & { API_SECRET?: string };

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, api-secret",
  };
}

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(corsHeaders())) headers.set(name, value);
  return new Response(JSON.stringify(data), { ...init, headers });
}

function javascript(source: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/javascript; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(corsHeaders())) headers.set(name, value);
  return new Response(source, { ...init, headers });
}

function withUtf8Charset(response: Response): Response {
  const contentType = response.headers.get("Content-Type");
  if (
    contentType === null ||
    /(?:^|;)\s*charset=/i.test(contentType) ||
    !UTF8_CONTENT_TYPES.some((prefix) => contentType.toLowerCase().startsWith(prefix))
  ) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("Content-Type", `${contentType}; charset=utf-8`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function assetAt(
  request: Request,
  env: AppEnv,
  pathname: string,
): Promise<Response> {
  const assetUrl = new URL(request.url);
  assetUrl.pathname = pathname;
  assetUrl.search = "";
  return env.ASSETS.fetch(
    new Request(assetUrl, {
      method: "GET",
      headers: request.headers,
    }),
  );
}

async function transformedHtml(
  response: Response,
  transform: (html: string) => string,
): Promise<Response> {
  if (!response.ok) return response;
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.delete("Content-Length");
  return new Response(transform(await response.text()), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function servePlatformPage(
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Response | null> {
  const staticPage = /^\/(admin|profile|food|report|split)\/?$/.exec(url.pathname);
  if (staticPage !== null) {
    return withUtf8Charset(
      await assetAt(request, env, `/${staticPage[1]}/index.html`),
    );
  }

  const clock = /^\/clock\/([a-z0-9-]{1,100})\/?$/.exec(url.pathname);
  if (clock !== null && clock[1] !== "template") {
    return transformedHtml(
      await assetAt(request, env, "/clock/template.html"),
      (html) => html.replaceAll("__CLOCK_FACE__", clock[1]!),
    );
  }
  if (url.pathname === "/clock/template.html") {
    return new Response(null, { status: 404 });
  }

  if (url.pathname === "/api-docs" || url.pathname === "/api-docs/") {
    return withUtf8Charset(await assetAt(request, env, "/api-docs/index.html"));
  }
  if (url.pathname === "/api3-docs" || url.pathname === "/api3-docs/") {
    return transformedHtml(
      await assetAt(request, env, "/api-docs/index.html"),
      (html) => html.replace('url: "/swagger.json"', 'url: "/api3-swagger.json"'),
    );
  }
  const docsAsset = /^\/api3?-docs\/swagger-ui-dist\/(.+)$/.exec(url.pathname);
  if (docsAsset !== null) {
    return withUtf8Charset(
      await assetAt(request, env, `/swagger-ui-dist/${docsAsset[1]}`),
    );
  }
  return null;
}

function resolveTenant(_request: Request, url: URL): string {
  const tenant = url.searchParams.get("tenant") ?? "demo";
  if (!TENANT.test(tenant)) {
    throw new ApiError(400, "invalid_tenant", "tenant must match [a-z0-9][a-z0-9_-]{0,63}");
  }
  return tenant;
}

function apiSecretCredential(request: Request, url: URL): string | null {
  return request.headers.get("api-secret") ?? url.searchParams.get("secret");
}

function safeLogPath(pathname: string): string {
  const authorizationRequest = "/api/v2/authorization/request/";
  return pathname.startsWith(authorizationRequest)
    ? `${authorizationRequest}[redacted]`
    : pathname;
}

async function digestHex(algorithm: "SHA-1" | "SHA-512", value: string): Promise<string> {
  const digest = await crypto.subtle.digest(algorithm, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function timingSafeTextEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (
      leftValue: ArrayBuffer | ArrayBufferView,
      rightValue: ArrayBuffer | ArrayBufferView,
    ) => boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(leftDigest, rightDigest);
  }

  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return difference === 0;
}

function configuredApiSecret(env: AppEnv): string | null {
  const secret = env.API_SECRET;
  return secret !== undefined && secret.length >= MIN_API_SECRET_LENGTH ? secret : null;
}

async function hasWriteAccess(request: Request, env: AppEnv, url: URL): Promise<boolean> {
  const secret = configuredApiSecret(env);
  const provided = apiSecretCredential(request, url)?.toLowerCase();
  if (secret === null || provided === undefined || provided === null) return false;

  const [sha1, sha512] = await Promise.all([
    digestHex("SHA-1", secret),
    digestHex("SHA-512", secret),
  ]);
  const [matchesSha1, matchesSha512] = await Promise.all([
    timingSafeTextEqual(provided, sha1),
    timingSafeTextEqual(provided, sha512),
  ]);
  return matchesSha1 || matchesSha512;
}

interface AuthorizedSubject {
  token: string;
  sub: string;
  permissionGroups: string[][];
  iat: number;
  exp: number;
}

interface AccessJwtClaims {
  accessToken: string;
  iat: number;
  exp: number;
}

interface PresentedCredential extends AccessJwtClaims {
  token: string | null;
}

const API3_COLLECTIONS = [
  "devicestatus",
  "entries",
  "food",
  "profile",
  "settings",
  "treatments",
] as const;

function bearerToken(request: Request, caseInsensitive = false): string | null {
  const authorization = request.headers.get("Authorization");
  if (authorization === null) return null;
  const parts = authorization.split(" ");
  const scheme = parts[0];
  const token = parts[1];
  if (
    parts.length !== 2 ||
    token === undefined ||
    token.length === 0 ||
    (caseInsensitive
      ? scheme?.toLowerCase() !== "bearer"
      : scheme !== "Bearer")
  ) {
    return null;
  }
  return token;
}

function rolePermissions(name: string, storedRoles: JsonDocument[]): string[] {
  const role =
    storedRoles.find((candidate) => candidate.name === name) ??
    DEFAULT_ROLES.find((candidate) => candidate.name === name);
  return Array.isArray(role?.permissions)
    ? role.permissions.filter((permission): permission is string => typeof permission === "string")
    : [];
}

function parseDocuments(value: string): JsonDocument[] {
  return JSON.parse(value) as JsonDocument[];
}

function parseDocument(value: string): JsonDocument {
  return JSON.parse(value) as JsonDocument;
}

function parseAccessJwtClaims(value: string): AccessJwtClaims {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).accessToken !== "string" ||
    !Number.isInteger((parsed as Record<string, unknown>).iat) ||
    !Number.isInteger((parsed as Record<string, unknown>).exp)
  ) {
    throw new Error("Durable Object returned invalid JWT claims");
  }
  return parsed as AccessJwtClaims;
}

function parseAuthorizedSubject(value: string): AuthorizedSubject {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).token !== "string" ||
    typeof (parsed as Record<string, unknown>).accessToken !== "string" ||
    !Number.isInteger((parsed as Record<string, unknown>).iat) ||
    !Number.isInteger((parsed as Record<string, unknown>).exp)
  ) {
    throw new Error("Durable Object returned an invalid issued JWT");
  }
  const issued = parsed as AccessJwtClaims & { token: string };
  return {
    token: issued.token,
    sub: "",
    permissionGroups: [],
    iat: issued.iat,
    exp: issued.exp,
  };
}

async function credentialFromRequest(
  request: Request,
  url: URL,
  store: DurableObjectStub<EntryStore>,
): Promise<PresentedCredential | null> {
  const bearer = bearerToken(request);
  if (bearer !== null) {
    const claimsJson = await store.verifyAccessJwt(bearer);
    if (claimsJson === null) return null;
    return { ...parseAccessJwtClaims(claimsJson), token: bearer };
  }

  const presented = url.searchParams.get("token") ?? apiSecretCredential(request, url);
  if (!presented) return null;
  const claimsJson = await store.verifyAccessJwt(presented);
  return claimsJson === null
    ? { accessToken: presented, token: null, iat: 0, exp: 0 }
    : { ...parseAccessJwtClaims(claimsJson), token: presented };
}

async function authorizeCredential(
  store: DurableObjectStub<EntryStore>,
  credential: PresentedCredential,
  refreshJwt = false,
): Promise<AuthorizedSubject | null> {
  const subjectJson = await store.findDocumentByField(
    "subjects",
    "accessToken",
    credential.accessToken,
  );
  if (subjectJson === null) return null;
  const subject = parseDocument(subjectJson);
  if (typeof subject.name !== "string") return null;
  const storedRoles = parseDocuments(await store.listDocuments("roles"));
  const names = Array.isArray(subject.roles)
    ? subject.roles.filter((role): role is string => typeof role === "string")
    : [];
  if (!names.includes("readable")) names.push("readable");

  let authorization: AuthorizedSubject;
  if (credential.token !== null && !refreshJwt) {
    authorization = {
      token: credential.token,
      sub: subject.name,
      permissionGroups: [],
      iat: credential.iat,
      exp: credential.exp,
    };
  } else {
    authorization = parseAuthorizedSubject(
      await store.issueAccessJwt(credential.accessToken),
    );
    authorization.sub = subject.name;
  }
  authorization.permissionGroups = names.map((name) =>
    rolePermissions(name, storedRoles),
  );
  return authorization;
}

async function authorizeSubject(
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<AuthorizedSubject | null> {
  const tenant = resolveTenant(request, url);
  const store = env.ENTRY_STORE.getByName(tenant);
  const credential = await credentialFromRequest(request, url, store);
  return credential === null ? null : authorizeCredential(store, credential);
}

async function requirePermission(
  request: Request,
  env: AppEnv,
  url: URL,
  permission: string,
): Promise<void> {
  if (await hasWriteAccess(request, env, url)) return;
  if (env.ENTRY_STORE === undefined) {
    if (configuredApiSecret(env) === null) {
      throw new ApiError(
        503,
        "api_secret_not_configured",
        "API_SECRET must be configured as a Cloudflare variable before writes are enabled",
      );
    }
    throw new ApiError(
      503,
      "entry_store_not_configured",
      "ENTRY_STORE must be configured before writes are enabled",
    );
  }
  const authorized = await authorizeSubject(request, env, url);
  if (authorized !== null && permissionGroupsAllow(authorized.permissionGroups, permission)) {
    return;
  }
  if (configuredApiSecret(env) === null) {
    throw new ApiError(
      503,
      "api_secret_not_configured",
      "API_SECRET must be configured as a Cloudflare variable before writes are enabled",
    );
  }
  throw new ApiError(401, "unauthorized", `permission ${permission} is required`);
}

function formBody(text: string): JsonDocument {
  const document: JsonDocument = {};
  for (const [rawName, value] of new URLSearchParams(text)) {
    const name = rawName.endsWith("[]") ? rawName.slice(0, -2) : rawName;
    const previous = document[name];
    if (rawName.endsWith("[]") || previous !== undefined) {
      document[name] = Array.isArray(previous)
        ? [...previous, value]
        : previous === undefined
          ? [value]
          : [previous, value];
    } else {
      document[name] = value;
    }
  }
  return document;
}

async function readBoundedBody(request: Request): Promise<unknown> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    throw new ApiError(413, "body_too_large", "request body exceeds 512 KiB");
  }
  if (request.body === null) {
    throw new ApiError(400, "invalid_json", "request body is required");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new ApiError(413, "body_too_large", "request body exceeds 512 KiB");
    }
    chunks.push(result.value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(body);
  if (request.headers.get("Content-Type")?.toLowerCase().includes("application/x-www-form-urlencoded")) {
    return formBody(text);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "request body is not valid JSON");
  }
}

function toClockProperties(entries: PublicEntry[]): Record<string, unknown> {
  const current = entries[0];
  if (current === undefined) {
    return { bgnow: { sgvs: [] }, delta: null };
  }

  const sgv = {
    _id: current._id,
    mgdl: current.sgv,
    scaled: current.sgv,
    mills: current.date,
    direction: current.direction,
    device: current.device,
    type: current.type,
  };
  const previous = entries[1];
  const deltaValue = previous === undefined ? null : current.sgv - previous.sgv;
  return {
    bgnow: { sgvs: [sgv] },
    delta:
      deltaValue === null
        ? null
        : {
            mgdl: deltaValue,
            scaled: deltaValue,
            display: `${deltaValue >= 0 ? "+" : ""}${deltaValue}`,
          },
  };
}

async function statusForRequest(request: Request, env: AppEnv, url: URL): Promise<Record<string, unknown>> {
  const status = nightscoutStatus();
  const authorized = await authorizeSubject(request, env, url);
  if (authorized !== null) status.authorized = authorized;
  return status;
}

function entryDeleteBoundary(url: URL, name: string): number | null {
  const value = url.searchParams.get(name);
  if (value === null || value === "") return null;
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) ? numeric : Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ApiError(400, "invalid_query", `${name} must be epoch milliseconds or ISO time`);
  }
  return Math.trunc(parsed);
}

function latestDocumentTime(documents: JsonDocument[]): number | null {
  let latest: number | null = null;
  for (const document of documents) {
    const value = document.created_at ?? document.timestamp;
    const timestamp =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Date.parse(value)
          : Number.NaN;
    if (Number.isFinite(timestamp) && (latest === null || timestamp > latest)) {
      latest = timestamp;
    }
  }
  return latest;
}

function notModified(lastModified: number): Response {
  const headers = new Headers(corsHeaders());
  headers.set("Cache-Control", "no-store");
  headers.set("Last-Modified", new Date(lastModified).toUTCString());
  return new Response(null, { status: 304, headers });
}

function hasFindQuery(url: URL): boolean {
  return Array.from(url.searchParams.keys()).some((name) => name.startsWith("find["));
}

async function handleEntriesApi(
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Response | null> {
  if (
    request.method === "GET" &&
    /^\/api\/v[12]\/entries\/current(?:\.json)?\/?$/.test(url.pathname)
  ) {
    const tenant = resolveTenant(request, url);
    return json(await env.ENTRY_STORE.getByName(tenant).getCurrent());
  }

  // API v2 mounts the complete v1 router at `/` before registering its
  // additional v2-only endpoints (locked upstream lib/api2/index.js:14-19).
  const match = /^\/api\/v[12]\/entries(?:\.json)?(?:\/([^/]+))?\/?$/.exec(url.pathname);
  if (match === null) return null;
  const tenant = resolveTenant(request, url);
  const id = match[1];

  if (request.method === "POST" && id === undefined) {
    await requirePermission(request, env, url, "api:entries:create");
    const store = env.ENTRY_STORE.getByName(tenant);
    const entries = parseEntryPayload(await readBoundedBody(request));
    await store.putEntries(entries);
    return json([], { status: 200 });
  }

  if (request.method === "GET") {
    const store = env.ENTRY_STORE.getByName(tenant);
    const entries = await store.getEntries(parseHistoryQuery(url));
    if (id === undefined) return json(entries);
    const selected = entries.find((entry) => entry._id === id);
    return selected === undefined
      ? json({ error: { code: "not_found", message: "entry not found" } }, { status: 404 })
      : json(selected);
  }

  if (request.method === "DELETE") {
    await requirePermission(request, env, url, "api:entries:delete");
    const store = env.ENTRY_STORE.getByName(tenant);
    if (id !== undefined && id !== "*" && !OBJECT_ID.test(id)) {
      throw new ApiError(400, "invalid_entry", "entry id must be a 24-character hexadecimal string");
    }
    const lte = entryDeleteBoundary(url, "find[date][$lte]");
    const gte = entryDeleteBoundary(url, "find[date][$gte]");
    if ((id === undefined || id === "*") && lte === null && gte === null) {
      throw new ApiError(400, "invalid_query", "a bounded date query is required for bulk entry deletion");
    }
    const deleted = await store.deleteEntries(id && id !== "*" ? [id] : [], lte, gte);
    return json({ n: deleted, ok: 1 });
  }

  return null;
}

interface CollectionRoute {
  collection: DocumentCollection;
  segment: string | undefined;
}

function collectionRoute(pathname: string): CollectionRoute | null {
  // API v2 inherits these v1 collection routers unchanged; only the mount
  // prefix differs (locked upstream lib/api2/index.js:14).
  const match = /^\/api\/v[12]\/(activity|food|profile|profiles|treatments|devicestatus)(?:\.json)?(?:\/([^/]+))?\/?$/.exec(
    pathname,
  );
  if (match === null) return null;
  const requested = match[1];
  return {
    collection: requested === "profiles" ? "profile" : (requested as DocumentCollection),
    segment: match[2]?.replace(/\.json$/, ""),
  };
}

function defaultDocumentCount(collection: DocumentCollection, url: URL): number {
  if (collection === "activity") return 5000;
  if (collection === "food") return 5000;
  if (collection === "profile") return 10;
  if (collection === "treatments") return hasFindQuery(url) ? 1000 : 100;
  return 10;
}

async function handleCollectionApi(
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Response | null> {
  const route = collectionRoute(url.pathname);
  if (route === null) return null;
  const { collection, segment } = route;
  const store = env.ENTRY_STORE.getByName(resolveTenant(request, url));

  if (request.method === "GET") {
    const all = collection === "treatments"
      ? normalizeTreatmentNumbers(parseDocuments(await store.queryLegacyTreatments(
        JSON.stringify(parseTreatmentQuery(url, defaultDocumentCount(collection, url))),
      )))
      : parseDocuments(await store.listDocuments(collection));
    if (collection === "profile" && segment === "current") return json(all[0] ?? null);
    const requiredType =
      collection === "food" && segment === "quickpicks"
        ? "quickpick"
        : collection === "food" && segment === "regular"
          ? "food"
          : undefined;
    const filtered = collection === "treatments"
      ? all
      : filterDocuments(all, url, defaultDocumentCount(collection, url), requiredType);
    if (collection === "activity" || collection === "treatments") {
      const lastModified = latestDocumentTime(filtered);
      if (lastModified !== null) {
        const ifModifiedSince = request.headers.get("If-Modified-Since");
        if (
          ifModifiedSince !== null &&
          Number.isFinite(Date.parse(ifModifiedSince)) &&
          lastModified <= Date.parse(ifModifiedSince)
        ) {
          return notModified(lastModified);
        }
        return json(filtered, {
          headers: { "Last-Modified": new Date(lastModified).toUTCString() },
        });
      }
    }
    return json(filtered);
  }

  if (request.method === "POST" && segment === undefined) {
    await requirePermission(request, env, url, `api:${collection}:create`);
    const payload = await readBoundedBody(request);
    if (
      (collection === "activity" || collection === "treatments")
      && Array.isArray(payload)
      && payload.length === 0
    ) {
      return json([]);
    }
    const parsed = parseDocumentPayload(payload, collection, false);
    return json(parseDocuments(await store.createDocuments(collection, JSON.stringify(parsed.documents))));
  }

  if (request.method === "PUT" && segment === undefined) {
    await requirePermission(request, env, url, `api:${collection}:update`);
    const parsed = parseDocumentPayload(
      await readBoundedBody(request),
      collection,
      collection !== "activity" && collection !== "profile" && collection !== "treatments",
    );
    const existing = parsed.documents.filter((document) => typeof document._id === "string");
    const fresh = parsed.documents.filter((document) => typeof document._id !== "string");
    const saved = [
      ...(existing.length === 0
        ? []
        : parseDocuments(await store.saveDocuments(collection, JSON.stringify(existing)))),
      ...(fresh.length === 0
        ? []
        : parseDocuments(await store.createDocuments(collection, JSON.stringify(fresh)))),
    ];
    return json(parsed.inputWasArray || collection === "food" ? saved : saved[0]);
  }

  if (request.method === "DELETE") {
    await requirePermission(request, env, url, `api:${collection}:delete`);
    let selected: JsonDocument[];
    if (segment !== undefined && segment !== "*") {
      if (collection === "treatments" && (OBJECT_ID.test(segment) || UUID.test(segment))) {
        const deleted = await store.deleteLegacyTreatment(segment);
        return json({ n: deleted ? 1 : 0, ok: 1 });
      }
      if (!OBJECT_ID.test(segment)) {
        throw new ApiError(400, "invalid_document", "document id must be a 24-character hexadecimal string");
      }
      selected = [{ _id: segment }];
    } else {
      if (segment !== "*" && !hasFindQuery(url)) {
        throw new ApiError(400, "invalid_query", "a find query is required for bulk deletion");
      }
      selected = segment === "*" ? parseDocuments(await store.listDocuments(collection)) : filterDocuments(
        parseDocuments(await store.listDocuments(collection)),
        url,
        5000,
      );
    }
    const ids = selected
      .map((document) => document._id)
      .filter((id): id is string => typeof id === "string" && OBJECT_ID.test(id));
    const deleted = await store.deleteDocuments(collection, ids);
    if (collection === "activity") return json({});
    return json({ n: deleted, ok: 1 });
  }

  return null;
}

async function mergedRoles(store: DurableObjectStub<EntryStore>): Promise<JsonDocument[]> {
  const stored = parseDocuments(await store.listDocuments("roles"));
  const names = new Set(stored.map((role) => role.name).filter((name): name is string => typeof name === "string"));
  return [...stored, ...DEFAULT_ROLES.filter((role) => !names.has(role.name as string))].sort((left, right) =>
    String(left.name).localeCompare(String(right.name)),
  );
}

async function handleAuthorizationApi(
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Response | null> {
  const prefix = "/api/v2/authorization/";
  if (!url.pathname.startsWith(prefix)) return null;
  const path = url.pathname.slice(prefix.length).replace(/\/$/, "");
  const store = env.ENTRY_STORE.getByName(resolveTenant(request, url));

  if (request.method === "GET" && path.startsWith("request/")) {
    const presented = decodeURIComponent(path.slice("request/".length));
    const claimsJson = await store.verifyAccessJwt(presented);
    const credential: PresentedCredential = claimsJson === null
      ? { accessToken: presented, token: null, iat: 0, exp: 0 }
      : { ...parseAccessJwtClaims(claimsJson), token: presented };
    const authorized = await authorizeCredential(store, credential, true);
    return authorized === null
      ? json(
          { status: 401, message: "Unauthorized", description: "Invalid/Missing" },
          { status: 401 },
        )
      : json(authorized);
  }

  if (path === "permissions" || path === "permissions/trie") {
    await requirePermission(request, env, url, "admin:api:permissions:read");
    const permissions = Array.from(
      new Set((await mergedRoles(store)).flatMap((role) =>
        Array.isArray(role.permissions) ? role.permissions.filter((item): item is string => typeof item === "string") : [],
      )),
    );
    return json(path.endsWith("/trie") ? { permissions } : permissions);
  }

  const match = /^(subjects|roles)(?:\/([^/]+))?$/.exec(path);
  if (match === null) return null;
  const collection = match[1] as "subjects" | "roles";
  const id = match[2];
  const permissionAction = request.method === "GET" && collection === "roles" ? "list" :
    request.method === "GET" ? "read" :
      request.method === "POST" ? "create" :
        request.method === "PUT" ? "update" : "delete";
  await requirePermission(request, env, url, `admin:api:${collection}:${permissionAction}`);

  if (request.method === "GET") {
    return json(
      collection === "roles"
        ? await mergedRoles(store)
        : parseDocuments(await store.listDocuments(collection)),
    );
  }
  if (request.method === "POST" && id === undefined) {
    const parsed = parseDocumentPayload(await readBoundedBody(request), collection, false);
    const created = parseDocuments(
      await store.createDocuments(collection, JSON.stringify(parsed.documents)),
    );
    return json(parsed.inputWasArray ? created : created[0]);
  }
  if (request.method === "PUT" && id === undefined) {
    const parsed = parseDocumentPayload(await readBoundedBody(request), collection, true);
    const saved = parseDocuments(
      await store.saveDocuments(collection, JSON.stringify(parsed.documents)),
    );
    return json(parsed.inputWasArray ? saved : saved[0]);
  }
  if (request.method === "DELETE" && id !== undefined) {
    if (!OBJECT_ID.test(id)) throw new ApiError(400, "invalid_document", "invalid document id");
    await store.deleteDocuments(collection, [id]);
    return json({});
  }
  return null;
}

function api3VersionInfo(): Record<string, unknown> {
  return {
    version: "15.0.7",
    apiVersion: "3.0.3-alpha",
    srvDate: Date.now(),
    storage: {
      storage: "sqlite-durable-object",
      version: "managed",
    },
  };
}

function api3Error(status: number, message: string): Response {
  return json(
    { status, message },
    { status, ...(status === 406 ? { headers: { Vary: "Accept" } } : {}) },
  );
}

async function handleApi3Status(
  authorized: AuthorizedSubject,
): Promise<Response> {
  let permissions = "";
  for (const [action, abbreviation] of [
    ["create", "c"],
    ["read", "r"],
    ["update", "u"],
    ["delete", "d"],
  ] as const) {
    if (
      permissionGroupsAllow(
        authorized.permissionGroups,
        `api:undefined:${action}`,
      )
    ) {
      permissions += abbreviation;
    }
  }

  const apiPermissions: Record<string, string> = {};
  if (permissions !== "") {
    for (const collection of API3_COLLECTIONS) {
      apiPermissions[collection] = permissions;
    }
  }

  return json({
    status: 200,
    result: {
      ...api3VersionInfo(),
      // Upstream v15.0.7 passes the property name from `for...in` to
      // permsForCol instead of the collection descriptor. Its permission
      // check therefore uses the literal `api:undefined:<action>` for every
      // collection. Preserve that locked-release behavior instead of silently
      // substituting the intended per-collection check from the Swagger.
      apiPermissions,
    },
  });
}

type Api3Authentication =
  | {
    ok: true;
    authorized: AuthorizedSubject;
    store: DurableObjectStub<EntryStore>;
  }
  | { ok: false; response: Response };

async function authenticateApi3(
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Api3Authentication> {
  const bearer = bearerToken(request, true);
  if (bearer === null) {
    return { ok: false, response: api3Error(401, "Missing or bad access token or JWT") };
  }

  const store = env.ENTRY_STORE.getByName(resolveTenant(request, url));
  const claimsJson = await store.verifyAccessJwt(bearer);
  if (claimsJson === null) {
    return { ok: false, response: api3Error(401, "Bad access token or JWT") };
  }
  const claims = parseAccessJwtClaims(claimsJson);
  const authorized = await authorizeCredential(store, { ...claims, token: bearer });
  return authorized === null
    ? { ok: false, response: api3Error(401, "Bad access token or JWT") }
    : { ok: true, authorized, store };
}

async function handleApi(request: Request, env: AppEnv, url: URL): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

  const isApi3 = url.pathname === "/api/v3" || url.pathname.startsWith("/api/v3/");
  let api3Pathname = url.pathname;
  let api3ExtensionMimeType: string | undefined;
  if (isApi3) {
    const parserFailure = await api3BodyParserFailure(request.clone());
    if (parserFailure !== null) return parserFailure;
    const split = splitApi3Extension(url.pathname);
    api3Pathname = split.pathname;
    if (split.extension !== undefined) {
      const extensionMimeType = mime.getType(split.extension);
      if (extensionMimeType === null) {
        return api3Error(406, "Unsupported output format requested");
      }
      api3ExtensionMimeType = extensionMimeType;
    }
  }

  if (
    request.method === "GET" &&
    /^\/api\/v[12]\/status(?:\.json)?\/?$/.test(url.pathname)
  ) {
    return json(await statusForRequest(request, env, url));
  }

  if (request.method === "GET" && /^\/api\/v[12]\/status\.js\/?$/.test(url.pathname)) {
    return javascript(`this.serverSettings = ${JSON.stringify(await statusForRequest(request, env, url))};`);
  }

  if (request.method === "GET" && url.pathname === "/api/versions") {
    return json([
      { version: "1.0.0", url: "/api/v1" },
      { version: "2.0.0", url: "/api/v2" },
      { version: "3.0.3-alpha", url: "/api/v3" },
    ]);
  }

  if (request.method === "GET" && api3Pathname === "/api/v3/version") {
    resolveTenant(request, url);
    return json({
      status: 200,
      result: api3VersionInfo(),
    });
  }

  if (request.method === "GET" && api3Pathname === "/api/v3/status") {
    const authentication = await authenticateApi3(request, env, url);
    return authentication.ok
      ? handleApi3Status(authentication.authorized)
      : authentication.response;
  }

  if (request.method === "GET" && api3Pathname === "/api/v3/lastModified") {
    const authentication = await authenticateApi3(request, env, url);
    return authentication.ok
      ? handleApi3TreatmentsLastModified(authentication.store, authentication.authorized)
      : authentication.response;
  }

  const matchedTreatmentRoute = matchApi3TreatmentRoute(request.method, api3Pathname);
  const matchedDeviceStatusRoute = matchApi3DeviceStatusRoute(request.method, api3Pathname);
  const matchedApi3Route = matchedTreatmentRoute === null
    ? matchedDeviceStatusRoute === null
      ? null
      : { route: matchedDeviceStatusRoute, collection: "devicestatus" as const }
    : { route: matchedTreatmentRoute, collection: "treatments" as const };
  const api3CollectionRoute: Api3CollectionRoute | null =
    matchedApi3Route === null || api3ExtensionMimeType === undefined
      ? matchedApi3Route?.route ?? null
      : { ...matchedApi3Route.route, extension: api3ExtensionMimeType };
  if (matchedApi3Route !== null && api3CollectionRoute !== null) {
    const authentication = await authenticateApi3(request, env, url);
    if (!authentication.ok) return authentication.response;
    return matchedApi3Route.collection === "treatments"
      ? handleApi3Treatments(
        request,
        url,
        authentication.store,
        authentication.authorized,
        api3CollectionRoute,
      )
      : handleApi3DeviceStatus(
        request,
        url,
        authentication.store,
        authentication.authorized,
        api3CollectionRoute,
      );
  }

  if (isApi3) return api3Error(404, "Bad operation or collection");

  if (
    request.method === "GET" &&
    /^\/api\/v2\/ddata\/at(?:\/[^/]+)?\/?$/.test(url.pathname)
  ) {
    const store = env.ENTRY_STORE.getByName(resolveTenant(request, url));
    const [entries, treatmentsJson, foodJson, profilesJson, deviceStatusJson] =
      await Promise.all([
        store.getEntries({
          count: 1000,
          gt: null,
          gte: null,
          lt: null,
          lte: null,
        }),
        store.listDocuments("treatments"),
        store.listDocuments("food"),
        store.listDocuments("profile"),
        store.listDocuments("devicestatus"),
      ]);
    const sgvs = entries
      .map((entry) => ({
        _id: entry._id,
        mgdl: entry.sgv,
        mills: entry.date,
        device: entry.device,
        direction: entry.direction,
        type: entry.type,
      }))
      .sort((left, right) => left.mills - right.mills);
    return json({
      lastUpdated: Date.now(),
      sgvs,
      mbgs: [],
      cals: [],
      treatments: parseDocuments(treatmentsJson),
      food: parseDocuments(foodJson),
      profiles: parseDocuments(profilesJson),
      devicestatus: parseDocuments(deviceStatusJson),
      dbstats: {},
    });
  }

  if (request.method === "GET" && url.pathname === "/api/v2/properties") {
    const tenant = resolveTenant(request, url);
    const entries = await env.ENTRY_STORE.getByName(tenant).getEntries({
      count: 4,
      gt: null,
      gte: null,
      lt: null,
      lte: null,
    });
    return json(toClockProperties(entries));
  }

  if (request.method === "GET" && /^\/api\/v[12]\/verifyauth\/?$/.test(url.pathname)) {
    const admin = await hasWriteAccess(request, env, url);
    const credentialAttempted =
      bearerToken(request) !== null ||
      url.searchParams.has("token") ||
      apiSecretCredential(request, url) !== null;
    const authorized = admin ? null : await authorizeSubject(request, env, url);
    const permissionGroups = admin
      ? [["*"]]
      : authorized?.permissionGroups ??
        (credentialAttempted ? [] : [rolePermissions("readable", [])]);
    const canRead = permissionGroupsAllow(permissionGroups, "*:*:read");
    const canWrite = permissionGroupsAllow(permissionGroups, "*:*:write");
    const isAdmin = permissionGroupsAllow(permissionGroups, "*:*:admin");
    const defaults = !credentialAttempted;
    return json({
      status: 200,
      message: {
        canRead,
        canWrite,
        isAdmin,
        permissions: defaults ? "DEFAULT" : "ROLE",
        rolefound: authorized === null ? "NOTFOUND" : "FOUND",
        message: canRead && !defaults ? "OK" : "UNAUTHORIZED",
      },
    });
  }

  if (request.method === "GET" && /^\/api\/v[12]\/adminnotifies\/?$/.test(url.pathname)) {
    return json({ message: { notifies: [], notifyCount: 0 } });
  }

  const entriesResponse = await handleEntriesApi(request, env, url);
  if (entriesResponse !== null) return entriesResponse;

  const collectionResponse = await handleCollectionApi(request, env, url);
  if (collectionResponse !== null) return collectionResponse;

  const authorizationResponse = await handleAuthorizationApi(request, env, url);
  if (authorizationResponse !== null) return authorizationResponse;

  return json(
    {
      error: {
        code: "not_found",
        message: "API route not implemented by the current compatibility adapter",
      },
    },
    { status: 404 },
  );
}

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/healthz") {
        return json({ status: "ok", upstream: "v15.0.7", storage: "sqlite-durable-object" });
      }
      if (url.pathname === "/socket.io" || url.pathname === "/socket.io/") {
        const tenant = resolveTenant(request, url);
        return await handleSocketIoPolling(
          request,
          url,
          env.ENTRY_STORE.getByName(tenant),
        );
      }
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env, url);
      }
      const platformPage = await servePlatformPage(request, env, url);
      if (platformPage !== null) return platformPage;
      return withUtf8Charset(await env.ASSETS.fetch(request));
    } catch (error) {
      if (error instanceof ApiError) {
        return json({ error: { code: error.code, message: error.message } }, { status: error.status });
      }
      console.error(
        JSON.stringify({
          message: "unhandled request error",
          path: safeLogPath(url.pathname),
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return json({ error: { code: "internal_error", message: "Internal server error" } }, { status: 500 });
    }
  },
} satisfies ExportedHandler<AppEnv>;
