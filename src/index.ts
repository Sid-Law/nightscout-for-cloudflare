import { EntryStore } from "./entry-store";
import type { DocumentCollection, JsonDocument } from "./entry-store";
import { filterDocuments, parseDocumentPayload } from "./documents";
import { ApiError, parseEntryPayload, parseHistoryQuery } from "./model";
import type { PublicEntry } from "./model";
import { nightscoutStatus } from "./status";

export { EntryStore };

const MAX_BODY_BYTES = 512 * 1024;
const TENANT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OBJECT_ID = /^[0-9a-f]{24}$/i;
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

async function digestHex(algorithm: "SHA-1" | "SHA-512", value: string): Promise<string> {
  const digest = await crypto.subtle.digest(algorithm, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
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
  return timingSafeHexEqual(provided, sha1) || timingSafeHexEqual(provided, sha512);
}

interface AuthorizedSubject {
  token: string;
  sub: string;
  permissionGroups: string[][];
  iat: number;
  exp: number;
}

function bearerToken(request: Request, url: URL): string | null {
  const authorization = request.headers.get("Authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim();
  return url.searchParams.get("token");
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

async function authorizeSubject(
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<AuthorizedSubject | null> {
  const token = bearerToken(request, url);
  if (!token) return null;
  const tenant = resolveTenant(request, url);
  const store = env.ENTRY_STORE.getByName(tenant);
  const subjectJson = await store.findDocumentByField("subjects", "accessToken", token);
  if (subjectJson === null) return null;
  const subject = parseDocument(subjectJson);
  if (typeof subject.name !== "string") return null;
  const storedRoles = parseDocuments(await store.listDocuments("roles"));
  const names = Array.isArray(subject.roles)
    ? subject.roles.filter((role): role is string => typeof role === "string")
    : [];
  if (!names.includes("readable")) names.push("readable");
  const now = Math.floor(Date.now() / 1000);
  return {
    token,
    sub: subject.name,
    permissionGroups: names.map((name) => rolePermissions(name, storedRoles)),
    iat: now,
    exp: now + 24 * 60 * 60,
  };
}

function permissionMatches(granted: string, required: string): boolean {
  if (granted === "*") return true;
  const grant = granted.split(":");
  const need = required.split(":");
  if (grant.length !== need.length) return false;
  return grant.every((segment, index) => segment === "*" || segment === need[index]);
}

async function requirePermission(
  request: Request,
  env: AppEnv,
  url: URL,
  permission: string,
): Promise<void> {
  if (await hasWriteAccess(request, env, url)) return;
  const authorized = await authorizeSubject(request, env, url);
  if (
    authorized?.permissionGroups.some((group) =>
      group.some((granted) => permissionMatches(granted, permission)),
    )
  ) {
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

function hasFindQuery(url: URL): boolean {
  return Array.from(url.searchParams.keys()).some((name) => name.startsWith("find["));
}

async function handleEntriesApi(
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Response | null> {
  if (request.method === "GET" && url.pathname === "/api/v1/entries/current.json") {
    const tenant = resolveTenant(request, url);
    return json(await env.ENTRY_STORE.getByName(tenant).getCurrent());
  }

  const match = /^\/api\/v1\/entries(?:\.json)?(?:\/([^/]+))?\/?$/.exec(url.pathname);
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
  const match = /^\/api\/v1\/(food|profile|profiles|treatments|devicestatus)(?:\.json)?(?:\/([^/]+))?\/?$/.exec(
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
    const all = parseDocuments(await store.listDocuments(collection));
    if (collection === "profile" && segment === "current") return json(all[0] ?? null);
    const requiredType =
      collection === "food" && segment === "quickpicks"
        ? "quickpick"
        : collection === "food" && segment === "regular"
          ? "food"
          : undefined;
    return json(filterDocuments(all, url, defaultDocumentCount(collection, url), requiredType));
  }

  if (request.method === "POST" && segment === undefined) {
    await requirePermission(request, env, url, `api:${collection}:create`);
    const parsed = parseDocumentPayload(await readBoundedBody(request), collection, false);
    return json(parseDocuments(await store.createDocuments(collection, JSON.stringify(parsed.documents))));
  }

  if (request.method === "PUT" && segment === undefined) {
    await requirePermission(request, env, url, `api:${collection}:update`);
    const parsed = parseDocumentPayload(
      await readBoundedBody(request),
      collection,
      collection !== "profile",
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
    const token = decodeURIComponent(path.slice("request/".length));
    const requestUrl = new URL(url);
    requestUrl.searchParams.set("token", token);
    const authorized = await authorizeSubject(request, env, requestUrl);
    return authorized === null
      ? json({ status: 401, message: "Unauthorized", type: "Invalid/Missing" }, { status: 401 })
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

async function handleApi(request: Request, env: AppEnv, url: URL): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

  if (request.method === "GET" && ["/api/v1/status", "/api/v1/status.json"].includes(url.pathname)) {
    return json(await statusForRequest(request, env, url));
  }

  if (request.method === "GET" && url.pathname === "/api/v1/status.js") {
    return javascript(`this.serverSettings = ${JSON.stringify(await statusForRequest(request, env, url))};`);
  }

  if (request.method === "GET" && url.pathname === "/api/versions") {
    return json([
      { version: "1.0.0", url: "/api/v1" },
      { version: "2.0.0", url: "/api/v2" },
      { version: "3.0.3-alpha", url: "/api/v3" },
    ]);
  }

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

  if (request.method === "GET" && url.pathname === "/api/v1/verifyauth") {
    const canWrite = await hasWriteAccess(request, env, url);
    const authorized = canWrite ? null : await authorizeSubject(request, env, url);
    const tokenAuthenticated = authorized !== null;
    return json({
      message: {
        canRead: true,
        canWrite: canWrite || tokenAuthenticated,
        isAdmin:
          canWrite ||
          authorized?.permissionGroups.some((group) => group.includes("*")) === true,
        permissions: canWrite || tokenAuthenticated ? "ROLE" : "DEFAULT",
        rolefound: tokenAuthenticated ? "FOUND" : "NOTFOUND",
        message: canWrite || tokenAuthenticated ? "OK" : "UNAUTHORIZED",
      },
    });
  }

  if (request.method === "GET" && url.pathname === "/api/v1/adminnotifies") {
    return json({ message: { notifies: [], notifyCount: 0 } });
  }

  const entriesResponse = await handleEntriesApi(request, env, url);
  if (entriesResponse !== null) return entriesResponse;

  const collectionResponse = await handleCollectionApi(request, env, url);
  if (collectionResponse !== null) return collectionResponse;

  const authorizationResponse = await handleAuthorizationApi(request, env, url);
  if (authorizationResponse !== null) return authorizationResponse;

  return json({ error: { code: "not_found", message: "API route not implemented in phase 1" } }, { status: 404 });
}

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/healthz") {
        return json({ status: "ok", upstream: "v15.0.7", storage: "sqlite-durable-object" });
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
          path: url.pathname,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return json({ error: { code: "internal_error", message: "Internal server error" } }, { status: 500 });
    }
  },
} satisfies ExportedHandler<AppEnv>;
