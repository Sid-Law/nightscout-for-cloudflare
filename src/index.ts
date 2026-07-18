import { EntryStore } from "./entry-store";
import mime from "mime";
import type { DocumentCollection, JsonDocument } from "./entry-store";
import {
  apiSecretDigestMatches,
  authorizationDefaultRoleNames,
  authorizationPermissionGroups,
  authorizationRoleNames,
  boundedTokenCandidates,
  BUILTIN_AUTHORIZATION_ROLES,
  extractRequestCredentials,
  type PresentedToken,
  type RequestCredentials,
} from "./authorization";
import { newTrie } from "shiro-trie";
import {
  filterDocuments,
  normalizeTreatmentNumbers,
  parseDocumentPayload,
  parseTreatmentQuery,
} from "./documents";
import {
  ApiError,
  parseEntryPayload,
  parseEntryTypeFilter,
  parseHistoryQuery,
} from "./model";
import type { PublicEntry } from "./model";
import { permissionGroupsAllow } from "./permissions";
import { handleSocketIo } from "./realtime/http-adapter";
import { normalizePlatformAuthFailDelay } from "./status";
import {
  handleApi3DeviceStatus,
  handleApi3Entries,
  handleApi3Profile,
  handleApi3Treatments,
  handleApi3TreatmentsLastModified,
  matchApi3DeviceStatusRoute,
  matchApi3EntriesRoute,
  matchApi3ProfileRoute,
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
const MAX_AUTH_FAIL_DELAY_MS = 60_000;
const SEEN_PERMISSIONS = [
  "admin:api:permissions:read",
  "admin:api:roles:create",
  "admin:api:roles:delete",
  "admin:api:roles:list",
  "admin:api:roles:update",
  "admin:api:subjects:create",
  "admin:api:subjects:delete",
  "admin:api:subjects:read",
  "admin:api:subjects:update",
  "api:*:read",
  "api:activity:create",
  "api:activity:delete",
  "api:activity:read",
  "api:activity:update",
  "api:devicestatus:create",
  "api:devicestatus:delete",
  "api:devicestatus:read",
  "api:entries:create",
  "api:entries:delete",
  "api:entries:read",
  "api:food:create",
  "api:food:delete",
  "api:food:read",
  "api:food:update",
  "api:pebble,entries:read",
  "api:profile:create",
  "api:profile:delete",
  "api:profile:read",
  "api:profile:update",
  "api:status:read",
  "api:treatments:create",
  "api:treatments:delete",
  "api:treatments:read",
  "api:treatments:update",
  "authorization:debug:test",
  "notifications:*:ack",
  "notifications:loop:push",
] as const;

type AppEnv = Env & {
  API_SECRET?: string;
  AUTH_DEFAULT_ROLES?: string;
  AUTH_FAIL_DELAY?: string;
};

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

function resolveTenantFromUrl(url: URL): string {
  const tenant = url.searchParams.get("tenant") ?? "demo";
  if (!TENANT.test(tenant)) {
    throw new ApiError(400, "invalid_tenant", "tenant must match [a-z0-9][a-z0-9_-]{0,63}");
  }
  return tenant;
}

function resolveTenant(_request: Request, url: URL): string {
  return resolveTenantFromUrl(url);
}

function safeLogPath(pathname: string): string {
  const authorizationRequest = "/api/v2/authorization/request/";
  return pathname.startsWith(authorizationRequest)
    ? `${authorizationRequest}[redacted]`
    : pathname;
}

function configuredApiSecret(env: AppEnv): string | null {
  const secret = env.API_SECRET;
  return secret !== undefined && secret.length >= MIN_API_SECRET_LENGTH ? secret : null;
}

function configuredAuthDefaultRoles(env: AppEnv): string {
  return env.AUTH_DEFAULT_ROLES ?? "readable";
}

function configuredAuthFailDelay(env: AppEnv): number {
  return normalizePlatformAuthFailDelay(env.AUTH_FAIL_DELAY);
}

function requestRemoteIp(request: Request): string {
  const cloudflareIp = request.headers.get("CF-Connecting-IP");
  if (cloudflareIp !== null && cloudflareIp.length > 0) {
    return cloudflareIp.slice(0, 256);
  }
  const forwarded = request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim();
  return forwarded !== undefined && forwarded.length > 0
    ? forwarded.slice(0, 256)
    : "unknown";
}

async function waitForAuthorizationDelay(
  store: DurableObjectStub<EntryStore>,
  ip: string,
): Promise<void> {
  const delay = await store.authorizationDelay(ip, Date.now());
  if (delay <= 0) return;
  await new Promise<void>((resolve) =>
    setTimeout(resolve, Math.min(delay, MAX_AUTH_FAIL_DELAY_MS))
  );
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

async function authorizeCredential(
  store: DurableObjectStub<EntryStore>,
  accessTokens: PresentedToken,
  configuredDefaultRoles: string | undefined,
  credential: PresentedCredential | null = null,
  refreshJwt = false,
): Promise<AuthorizedSubject | null> {
  const candidates = boundedTokenCandidates(accessTokens);
  if (candidates === null) return null;
  const subjectJson = await store.resolveAuthorizationSubject(JSON.stringify(candidates));
  if (subjectJson === null) return null;
  const subject = parseDocument(subjectJson);
  if (typeof subject.name !== "string" || typeof subject.accessToken !== "string") return null;
  const storedRoles = parseDocuments(await store.listDocuments("roles"));
  const names = authorizationRoleNames(subject.roles, configuredDefaultRoles);

  let authorization: AuthorizedSubject;
  if (credential !== null && credential.token !== null && !refreshJwt) {
    authorization = {
      token: credential.token,
      sub: subject.name,
      permissionGroups: [],
      iat: credential.iat,
      exp: credential.exp,
    };
  } else {
    authorization = parseAuthorizedSubject(
      await store.issueAccessJwt(subject.accessToken),
    );
    authorization.sub = subject.name;
  }
  authorization.permissionGroups = authorizationPermissionGroups(names, storedRoles);
  return authorization;
}

interface AuthorizationResolution {
  admin: boolean;
  authorized: AuthorizedSubject | null;
  defaults: boolean;
}

async function resolveTokenCredential(
  store: DurableObjectStub<EntryStore>,
  credentials: RequestCredentials,
  configuredDefaultRoles: string | undefined,
): Promise<{ authorized: AuthorizedSubject | null; attempted: boolean }> {
  if (credentials.token === null || credentials.tokenSource === null) {
    return { authorized: null, attempted: false };
  }
  const candidates = boundedTokenCandidates(credentials.token);
  if (candidates === null) {
    return {
      authorized: null,
      attempted: credentials.tokenSource === "bearer",
    };
  }

  if (credentials.tokenSource === "bearer") {
    const bearer = candidates.length === 1 ? candidates[0]! : null;
    if (bearer === null) return { authorized: null, attempted: true };
    const claimsJson = await store.verifyAccessJwt(bearer);
    if (claimsJson === null) return { authorized: null, attempted: true };
    const claims = parseAccessJwtClaims(claimsJson);
    return {
      authorized: await authorizeCredential(
        store,
        claims.accessToken,
        configuredDefaultRoles,
        { ...claims, token: bearer },
      ),
      attempted: true,
    };
  }

  if (candidates.length === 1) {
    const candidate = candidates[0]!;
    const claimsJson = await store.verifyAccessJwt(candidate);
    if (claimsJson !== null) {
      const claims = parseAccessJwtClaims(claimsJson);
      const authorized = await authorizeCredential(
        store,
        claims.accessToken,
        configuredDefaultRoles,
        null,
        true,
      );
      return { authorized, attempted: authorized !== null };
    }
  }
  const authorized = await authorizeCredential(
    store,
    candidates,
    configuredDefaultRoles,
    null,
    true,
  );
  // Locked extractJWTfromRequest converts only a valid query/body access token
  // into a JWT. An invalid opaque token therefore falls back to defaults.
  return { authorized, attempted: authorized !== null };
}

async function resolveRequestAuthorization(
  request: Request,
  env: AppEnv,
  url: URL,
  body?: unknown,
): Promise<AuthorizationResolution> {
  const credentials = extractRequestCredentials(request, url, body);
  const configured = configuredApiSecret(env);
  // Locked v15.0.7 passes query-string secret arrays into
  // enclave.isApiKey(), whose scalar-only toLowerCase() throws before the
  // storage layer can perform its documented ordered subject lookup. Treat
  // arrays as subject candidates but never as an admin API secret: this keeps
  // valid access-token arrays useful and makes invalid explicit credentials
  // fail closed instead of falling back to anonymous defaults.
  const scalarApiSecret = typeof credentials.apiSecret === "string"
    ? credentials.apiSecret
    : null;

  if (env.ENTRY_STORE === undefined) {
    if (await apiSecretDigestMatches(scalarApiSecret, configured)) {
      return { admin: true, authorized: null, defaults: false };
    }
    return {
      admin: false,
      authorized: null,
      defaults: credentials.apiSecret === null && credentials.tokenSource !== "bearer",
    };
  }
  const store = env.ENTRY_STORE.getByName(resolveTenant(request, url));
  const ip = requestRemoteIp(request);
  await waitForAuthorizationDelay(store, ip);
  if (await apiSecretDigestMatches(scalarApiSecret, configured)) {
    await store.authorizationSucceeded(ip);
    return { admin: true, authorized: null, defaults: false };
  }
  const token = await resolveTokenCredential(
    store,
    credentials,
    env.AUTH_DEFAULT_ROLES,
  );
  if (token.authorized !== null) {
    await store.authorizationSucceeded(ip);
    return { admin: false, authorized: token.authorized, defaults: false };
  }

  if (credentials.apiSecret !== null) {
    const secretSubject = await authorizeCredential(
      store,
      credentials.apiSecret,
      env.AUTH_DEFAULT_ROLES,
      null,
      true,
    );
    if (secretSubject !== null) await store.authorizationSucceeded(ip);
    else await store.authorizationFailed(ip, Date.now(), configuredAuthFailDelay(env));
    return {
      admin: false,
      authorized: secretSubject,
      defaults: false,
    };
  }
  if (token.attempted) {
    await store.authorizationFailed(ip, Date.now(), configuredAuthFailDelay(env));
  }
  return {
    admin: false,
    authorized: null,
    defaults: !token.attempted,
  };
}

async function permissionGroupsForResolution(
  resolution: AuthorizationResolution,
  store: DurableObjectStub<EntryStore>,
  env: AppEnv,
): Promise<string[][]> {
  if (resolution.admin) return [["*"]];
  if (resolution.authorized !== null) return resolution.authorized.permissionGroups;
  if (!resolution.defaults) return [];
  const storedRoles = parseDocuments(await store.listDocuments("roles"));
  return authorizationPermissionGroups(
    authorizationDefaultRoleNames(configuredAuthDefaultRoles(env)),
    storedRoles,
  );
}

async function requirePermissions(
  request: Request,
  env: AppEnv,
  url: URL,
  permissions: readonly string[],
  body?: unknown,
): Promise<AuthorizationResolution> {
  const resolution = await resolveRequestAuthorization(request, env, url, body);
  if (resolution.admin) return resolution;
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
  const store = env.ENTRY_STORE.getByName(resolveTenant(request, url));
  const permissionGroups = await permissionGroupsForResolution(resolution, store, env);
  if (permissions.every((permission) =>
    permissionGroupsAllow(permissionGroups, permission)
  )) {
    return resolution;
  }
  if (configuredApiSecret(env) === null) {
    throw new ApiError(
      503,
      "api_secret_not_configured",
      "API_SECRET must be configured as a Cloudflare variable before writes are enabled",
    );
  }
  throw new ApiError(
    401,
    "unauthorized",
    `permissions ${permissions.join(", ")} are required`,
  );
}

async function requirePermission(
  request: Request,
  env: AppEnv,
  url: URL,
  permission: string,
  body?: unknown,
): Promise<AuthorizationResolution> {
  return requirePermissions(request, env, url, [permission], body);
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

function runtimeMeasurement(value: unknown): number | null {
  if (!value) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function runtimeSgv(entry: PublicEntry): number | null {
  return entry.mbg ? null : runtimeMeasurement(entry.sgv);
}

function toClockProperties(entries: PublicEntry[]): Record<string, unknown> {
  const sgvs = entries.flatMap((entry) => {
    const sgv = runtimeSgv(entry);
    return sgv === null ? [] : [{ ...entry, sgv, type: "sgv" }];
  });
  const current = sgvs[0];
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
  const previous = sgvs[1];
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

function statusQueryCredential(url: URL, name: "token" | "secret"): PresentedToken | null {
  const values: string[] = [];
  let arraySyntax = false;
  for (const [key, value] of url.searchParams) {
    if (key === name) values.push(value);
    if (key === `${name}[]`) {
      arraySyntax = true;
      values.push(value);
    }
  }
  if (values.length === 0) return null;
  return arraySyntax || values.length > 1 ? values : values[0]!;
}

function selectedStatusQueryCredential(url: URL): PresentedToken | null {
  const token = statusQueryCredential(url, "token");
  const secret = statusQueryCredential(url, "secret");
  const selected = token !== null && (Array.isArray(token) || token)
    ? token
    : secret !== null && (Array.isArray(secret) || secret)
      ? secret
      : null;
  return selected;
}

async function statusQueryAuthorization(
  store: DurableObjectStub<EntryStore>,
  url: URL,
  configuredDefaultRoles: string | undefined,
): Promise<AuthorizedSubject | null> {
  const presented = selectedStatusQueryCredential(url);
  if (presented === null || boundedTokenCandidates(presented) === null) return null;
  // Locked authorization.authorize() asks the enclave to verify only a scalar
  // JWT. Repeated/[] query values remain an array, and storage.findSubject()
  // checks those access-token prefixes in their presented order.
  if (Array.isArray(presented)) {
    return authorizeCredential(store, presented, configuredDefaultRoles);
  }
  const claimsJson = await store.verifyAccessJwt(presented);
  const accessToken = claimsJson === null
    ? presented
    : parseAccessJwtClaims(claimsJson).accessToken;
  return authorizeCredential(store, accessToken, configuredDefaultRoles);
}

async function statusForRequest(
  env: AppEnv,
  url: URL,
): Promise<Record<string, unknown>> {
  const store = env.ENTRY_STORE.getByName(resolveTenantFromUrl(url));
  const status = JSON.parse(await store.nightscoutHttpStatus(Date.now())) as Record<string, unknown>;
  // Locked status.js does not reuse the authorization middleware result. It
  // independently calls authorization.authorize(query.token || query.secret)
  // and therefore ignores Bearer and api-secret headers for this field.
  status.authorized = await statusQueryAuthorization(
    store,
    url,
    env.AUTH_DEFAULT_ROLES,
  );
  return status;
}

type StatusFormat = "html" | "png" | "svg" | "js" | "text" | "json";

interface ParsedMediaRange {
  type: string;
  subtype: string;
  params: Record<string, string | undefined>;
  quality: number;
  order: number;
}

interface MediaPriority {
  quality: number;
  specificity: number;
  acceptOrder: number;
  providedOrder: number;
}

function splitQuoted(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '"') quoted = !quoted;
    if (!quoted && value[index] === delimiter) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function parsedMediaRange(value: string, order: number): ParsedMediaRange | null {
  const match = /^\s*([^\s/;]+)\/([^;\s]+)\s*(?:;(.*))?$/.exec(value);
  if (match === null) return null;
  const params: Record<string, string | undefined> = {};
  let quality = 1;
  if (match[3] !== undefined) {
    for (const rawParameter of splitQuoted(match[3], ";")) {
      const parameter = rawParameter.trim();
      const equals = parameter.indexOf("=");
      const key = (equals < 0 ? parameter : parameter.slice(0, equals)).toLowerCase();
      const rawValue = equals < 0 ? undefined : parameter.slice(equals + 1);
      const parsed = rawValue?.startsWith('"') && rawValue.endsWith('"')
        ? rawValue.slice(1, -1)
        : rawValue;
      if (key === "q") {
        quality = Number.parseFloat(parsed ?? "");
        break;
      }
      params[key] = parsed;
    }
  }
  return {
    type: match[1]!,
    subtype: match[2]!,
    params,
    quality,
    order,
  };
}

function priorityForMediaType(
  mediaType: string,
  accepted: ParsedMediaRange[],
  providedOrder: number,
): MediaPriority {
  const provided = parsedMediaRange(mediaType, providedOrder);
  let priority: MediaPriority = {
    acceptOrder: -1,
    quality: 0,
    specificity: 0,
    providedOrder,
  };
  if (provided === null) return priority;

  for (const range of accepted) {
    let specificity = 0;
    if (range.type.toLowerCase() === provided.type.toLowerCase()) specificity |= 4;
    else if (range.type !== "*") continue;
    if (range.subtype.toLowerCase() === provided.subtype.toLowerCase()) specificity |= 2;
    else if (range.subtype !== "*") continue;
    const parameterKeys = Object.keys(range.params);
    if (!parameterKeys.every((key) =>
      range.params[key] === "*"
      || (range.params[key] ?? "").toLowerCase()
        === (provided.params[key] ?? "").toLowerCase()
    )) {
      continue;
    }
    if (parameterKeys.length > 0) specificity |= 1;
    const candidate: MediaPriority = {
      acceptOrder: range.order,
      quality: range.quality,
      specificity,
      providedOrder,
    };
    // Exact negotiator priority: first choose the most-specific Accept range
    // for each offered type, then its q value and header order.
    if (
      candidate.specificity > priority.specificity
      || (
        candidate.specificity === priority.specificity
        && candidate.quality > priority.quality
      )
      || (
        candidate.specificity === priority.specificity
        && candidate.quality === priority.quality
        && candidate.acceptOrder > priority.acceptOrder
      )
    ) {
      priority = candidate;
    }
  }
  return priority;
}

function negotiatedFormat<Format extends string>(
  request: Request,
  offered: ReadonlyArray<readonly [Format, string]>,
): Format | null {
  const accept = request.headers.get("Accept") ?? "*/*";
  const accepted = splitQuoted(accept, ",")
    .map((value, order) => parsedMediaRange(value.trim(), order))
    .filter((value): value is ParsedMediaRange => value !== null);
  const priorities = offered.map(([format, mediaType], providedOrder) => ({
    format,
    priority: priorityForMediaType(mediaType, accepted, providedOrder),
  })).filter(({ priority }) => priority.quality > 0);
  priorities.sort((left, right) =>
    right.priority.quality - left.priority.quality
    || right.priority.specificity - left.priority.specificity
    || left.priority.acceptOrder - right.priority.acceptOrder
    || left.priority.providedOrder - right.priority.providedOrder
  );
  return priorities[0]?.format ?? null;
}

function negotiatedStatusFormat(request: Request): StatusFormat | null {
  const offered = [
    ["html", "text/html"],
    ["png", "image/png"],
    ["svg", "image/svg+xml"],
    ["js", "application/javascript"],
    ["text", "text/plain"],
    ["json", "application/json"],
  ] as const;
  return negotiatedFormat(request, offered);
}

function statusText(
  body: string,
  contentType: string,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(corsHeaders())) headers.set(name, value);
  headers.set("Content-Type", `${contentType}; charset=utf-8`);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Length", String(new TextEncoder().encode(body).byteLength));
  headers.set("Vary", "Accept");
  return new Response(body, { ...init, headers });
}

function statusRedirect(
  request: Request,
  extension: "png" | "svg",
  explicitExtension: boolean,
): Response {
  const headers = new Headers(corsHeaders());
  const location = `http://img.shields.io/badge/Nightscout-OK-green.${extension}`;
  headers.set("Location", location);
  let body = "";
  let contentType = extension === "png" ? "image/png" : "image/svg+xml";
  // Express first chooses png/svg in the route's res.format(), then
  // res.redirect() negotiates text/html a second time. An explicit extension
  // has already replaced Accept with its image MIME type, so it keeps the
  // outer image Content-Type and the redirect body remains empty.
  const redirectFormat = explicitExtension
    ? null
    : negotiatedFormat(request, [
      ["text", "text/plain"],
      ["html", "text/html"],
    ] as const);
  if (redirectFormat === "text") {
    contentType = "text/plain; charset=utf-8";
    body = `Found. Redirecting to ${location}`;
  } else if (redirectFormat === "html") {
    contentType = "text/html; charset=utf-8";
    body = `<p>Found. Redirecting to <a href="${location}">${location}</a></p>`;
  }
  headers.set("Content-Type", contentType);
  headers.set("Content-Length", String(new TextEncoder().encode(body).byteLength));
  headers.set("Cache-Control", "no-store");
  headers.set("Vary", "Accept");
  return new Response(body, { status: 302, headers });
}

function statusNotAcceptable(request: Request): Response {
  // res.format() forwards this error to the production app's errorhandler(),
  // which falls back to a plain-text stack for an unacceptable Accept value.
  const error = new Error("Not Acceptable");
  const body = error.stack ?? error.toString();
  const encodedBody = new TextEncoder().encode(body);
  const headers = new Headers(corsHeaders());
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Vary", "Accept");
  headers.set("X-Content-Type-Options", "nosniff");
  if (request.method !== "HEAD") {
    headers.set("Content-Length", String(encodedBody.byteLength));
  }
  // A TypedArray is a fixed-length Workers response source. Unlike a manual
  // Content-Length on a generic stream, the runtime can preserve its length
  // on the actual HTTP boundary.
  return new Response(request.method === "HEAD" ? null : encodedBody, {
    status: 406,
    headers,
  });
}

function renderStatus(
  request: Request,
  status: Record<string, unknown>,
  format: StatusFormat,
  explicitExtension: boolean,
): Response {
  switch (format) {
    case "html":
      return statusText("<h1>STATUS OK</h1>", "text/html");
    case "png":
    case "svg":
      return statusRedirect(request, format, explicitExtension);
    case "js":
      return statusText(
        `this.serverSettings = ${JSON.stringify(status)} ;`,
        "application/javascript",
      );
    case "text":
      return statusText("STATUS OK", "text/plain");
    case "json":
      return statusText(JSON.stringify(status), "application/json");
  }
}

function withoutBodyForHead(request: Request, response: Response): Response {
  if (request.method !== "HEAD") return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function escapeFinalhandlerMessage(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("\n", "<br>")
    .replaceAll("  ", " &nbsp;");
}

function expressFinalNotFound(request: Request, url: URL): Response {
  const message = escapeFinalhandlerMessage(
    `Cannot ${request.method} ${url.pathname}`,
  );
  const body = "<!DOCTYPE html>\n"
    + '<html lang="en">\n'
    + "<head>\n"
    + '<meta charset="utf-8">\n'
    + "<title>Error</title>\n"
    + "</head>\n"
    + "<body>\n"
    + `<pre>${message}</pre>\n`
    + "</body>\n"
    + "</html>\n";
  const encodedBody = new TextEncoder().encode(body);
  const headers = new Headers(corsHeaders());
  headers.set("Content-Security-Policy", "default-src 'none'");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Length", String(encodedBody.byteLength));
  // Keep a fixed-length source even for HEAD. The HTTP layer suppresses a
  // HEAD body while retaining the representation length where the Workers
  // transport permits it, matching Express's method-specific response.
  return new Response(encodedBody, {
    status: 404,
    headers,
  });
}

function isStatusFinalhandlerPath(pathname: string): boolean {
  return /^\/api\/(?:v[12]\/)?status/i.test(pathname);
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

function assertSupportedEntryDeleteFilters(url: URL): void {
  const supported = new Set([
    "find[date][$gte]",
    "find[date][$lte]",
    "find[type]",
    "find[type][$eq]",
  ]);
  for (const name of url.searchParams.keys()) {
    if (name.startsWith("find[") && !supported.has(name)) {
      throw new ApiError(
        400,
        "unsupported_delete_filter",
        `entry deletion does not safely support ${name}`,
      );
    }
  }
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
    /^\/api\/v[12]\/entries\/current\/?(?:\.json)?\/?$/.test(url.pathname)
  ) {
    await requirePermission(request, env, url, "api:entries:read");
    const tenant = resolveTenant(request, url);
    return json(await env.ENTRY_STORE.getByName(tenant).getCurrent());
  }

  // API v2 mounts the complete v1 router at `/` before registering its
  // additional v2-only endpoints (locked upstream lib/api2/index.js:14-19).
  const match = /^\/api\/v[12]\/entries(?:\/([^/.]+))?\/?(?:\.json)?\/?$/.exec(url.pathname);
  if (match === null) return null;
  const tenant = resolveTenant(request, url);
  const spec = match[1];

  if (request.method === "POST" && spec === undefined) {
    const payload = await readBoundedBody(request);
    await requirePermissions(
      request,
      env,
      url,
      ["api:entries:read", "api:entries:create"],
      payload,
    );
    const store = env.ENTRY_STORE.getByName(tenant);
    const entries = parseEntryPayload(payload);
    const saved = await store.putEntries(entries);
    return json(JSON.parse(saved.entriesJson), { status: 200 });
  }

  if (request.method === "GET") {
    await requirePermission(request, env, url, "api:entries:read");
    const store = env.ENTRY_STORE.getByName(tenant);
    if (spec !== undefined && OBJECT_ID.test(spec)) {
      // Locked getEntry() bypasses the default count/date window and the
      // formatter always emits an array, even for this single-record route.
      const entries = await store.getEntryById(spec.toLowerCase());
      if (entries.length === 0) {
        return json({
          status: 500,
          message: "Mongo Error",
          description: `No such id: '${spec}'`,
        }, { status: 500 });
      }
      return json(entries);
    }
    const query = parseHistoryQuery(url);
    if (spec !== undefined) query.type = spec;
    const decision = JSON.parse(await store.getEntriesJson(query)) as
      | { ok: true; result: PublicEntry[] }
      | { ok: false; status?: number; message: string };
    if (!decision.ok) {
      if (decision.status === 413) {
        throw new ApiError(413, "entry_query_limit", decision.message);
      }
      throw new Error(decision.message);
    }
    return json(decision.result);
  }

  if (request.method === "DELETE") {
    const payload = request.body === null ? undefined : await readBoundedBody(request);
    await requirePermissions(
      request,
      env,
      url,
      ["api:entries:read", "api:entries:delete"],
      payload,
    );
    const store = env.ENTRY_STORE.getByName(tenant);
    const id = spec !== undefined && OBJECT_ID.test(spec);
    const model = spec !== undefined && spec !== "*" && !id
      ? spec
      : null;
    if (model !== null && !/^[A-Za-z0-9_-]{1,32}$/.test(model)) {
      throw new ApiError(400, "invalid_entry", "entry model has an invalid format");
    }
    if (!id) assertSupportedEntryDeleteFilters(url);
    const lte = id ? null : entryDeleteBoundary(url, "find[date][$lte]");
    const gte = id ? null : entryDeleteBoundary(url, "find[date][$gte]");
    if (!id && lte === null && gte === null) {
      throw new ApiError(400, "invalid_query", "a bounded date query is required for bulk entry deletion");
    }
    const type = id || spec === "*"
      ? null
      : model ?? parseEntryTypeFilter(url);
    const deleted = await store.deleteEntries(
      id ? [spec.toLowerCase()] : [],
      lte,
      gte,
      type,
    );
    if (deleted < 0) {
      throw new ApiError(
        413,
        "entry_delete_limit",
        "entry deletion exceeds 128 records or stored revisions; narrow the request",
      );
    }
    return json({ acknowledged: true, deletedCount: deleted });
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
    await requirePermission(request, env, url, `api:${collection}:read`);
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
    const payload = await readBoundedBody(request);
    await requirePermissions(
      request,
      env,
      url,
      [`api:${collection}:read`, `api:${collection}:create`],
      payload,
    );
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
    const payload = await readBoundedBody(request);
    await requirePermissions(
      request,
      env,
      url,
      [`api:${collection}:read`, `api:${collection}:update`],
      payload,
    );
    const parsed = parseDocumentPayload(
      payload,
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
    const payload = request.body === null ? undefined : await readBoundedBody(request);
    await requirePermissions(
      request,
      env,
      url,
      [`api:${collection}:read`, `api:${collection}:delete`],
      payload,
    );
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
  const builtins: JsonDocument[] = BUILTIN_AUTHORIZATION_ROLES.map((role) => ({
    name: role.name,
    permissions: [...role.permissions],
  }));
  return [...stored, ...builtins.filter((role) => !names.has(role.name as string))].sort((left, right) =>
    String(left.name).localeCompare(String(right.name)),
  );
}

function publicAuthorizationSubjectMutation(subject: JsonDocument): JsonDocument {
  const result = { ...subject };
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

function authorizationMongoError(description: string): Response {
  return json(
    { status: 500, message: "Mongo Error", description },
    { status: 500 },
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
    const presentedAllowed = boundedTokenCandidates(presented) !== null;
    const claimsJson = presentedAllowed
      ? await store.verifyAccessJwt(presented)
      : null;
    const credential: PresentedCredential | null = claimsJson === null
      ? null
      : { ...parseAccessJwtClaims(claimsJson), token: presented };
    const authorized = presentedAllowed
      ? await authorizeCredential(
          store,
          credential?.accessToken ?? presented,
          env.AUTH_DEFAULT_ROLES,
          credential,
          true,
        )
      : null;
    return authorized === null
      ? json(
          { status: 401, message: "Unauthorized", description: "Invalid/Missing" },
          { status: 401 },
        )
      : json(authorized);
  }

  if (path === "permissions" || path === "permissions/trie") {
    await requirePermission(request, env, url, "admin:api:permissions:read");
    if (!path.endsWith("/trie")) return json(SEEN_PERMISSIONS);
    const permissions = newTrie();
    permissions.add(...SEEN_PERMISSIONS);
    return json(permissions);
  }

  const match = /^(subjects|roles)(?:\/([^/]+))?$/.exec(path);
  if (match === null) return null;
  const collection = match[1] as "subjects" | "roles";
  const id = match[2];
  const permissionAction = request.method === "GET" && collection === "roles" ? "list" :
    request.method === "GET" ? "read" :
      request.method === "POST" ? "create" :
        request.method === "PUT" ? "update" : "delete";
  const payload = request.method === "POST" || request.method === "PUT"
    ? await readBoundedBody(request)
    : request.method === "DELETE" && request.body !== null
      ? await readBoundedBody(request)
      : undefined;
  await requirePermission(
    request,
    env,
    url,
    `admin:api:${collection}:${permissionAction}`,
    payload,
  );

  if (request.method === "GET") {
    const subjectsJson = collection === "subjects"
      ? await store.listAuthorizationSubjects()
      : null;
    if (collection === "subjects" && subjectsJson === null) {
      throw new Error("authorization subject limit exceeded");
    }
    return json(
      collection === "roles"
        ? await mergedRoles(store)
        : parseDocuments(subjectsJson!),
    );
  }
  if (request.method === "POST" && id === undefined) {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return authorizationMongoError("Authorization document must be a single object");
    }
    const parsed = parseDocumentPayload(payload, collection, false);
    const serialized = JSON.stringify(parsed.documents);
    const subjectMutation = collection === "subjects"
      ? await store.createAuthorizationSubjects(serialized)
      : null;
    if (subjectMutation !== null && !subjectMutation.ok) {
      return authorizationMongoError(subjectMutation.error);
    }
    const created = parseDocuments(subjectMutation?.value ??
      await store.createDocuments(collection, serialized));
    const response = collection === "subjects"
      ? created.map(publicAuthorizationSubjectMutation)
      : created;
    return json(parsed.inputWasArray ? response : response[0]);
  }
  if (request.method === "PUT" && id === undefined) {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return authorizationMongoError("Missing _id for update");
    }
    const rawId = (payload as Record<string, unknown>)._id;
    if (rawId === undefined || rawId === null || rawId === "") {
      return authorizationMongoError("Missing _id for update");
    }
    if (typeof rawId !== "string" || !OBJECT_ID.test(rawId)) {
      return authorizationMongoError(`Invalid _id format: ${String(rawId)}`);
    }
    const parsed = parseDocumentPayload(payload, collection, true);
    const serialized = JSON.stringify(parsed.documents);
    const subjectMutation = collection === "subjects"
      ? await store.saveAuthorizationSubjects(serialized)
      : null;
    if (subjectMutation !== null && !subjectMutation.ok) {
      return authorizationMongoError(subjectMutation.error);
    }
    const saved = parseDocuments(subjectMutation?.value ??
      await store.saveDocuments(collection, serialized));
    const response = collection === "subjects"
      ? saved.map(publicAuthorizationSubjectMutation)
      : saved;
    return json(parsed.inputWasArray ? response : response[0]);
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
  const ip = requestRemoteIp(request);
  await waitForAuthorizationDelay(store, ip);
  if (boundedTokenCandidates(bearer) === null) {
    await store.authorizationFailed(ip, Date.now(), configuredAuthFailDelay(env));
    return { ok: false, response: api3Error(401, "Bad access token or JWT") };
  }

  const claimsJson = await store.verifyAccessJwt(bearer);
  if (claimsJson === null) {
    await store.authorizationFailed(ip, Date.now(), configuredAuthFailDelay(env));
    return { ok: false, response: api3Error(401, "Bad access token or JWT") };
  }
  const claims = parseAccessJwtClaims(claimsJson);
  const authorized = await authorizeCredential(
    store,
    claims.accessToken,
    env.AUTH_DEFAULT_ROLES,
    { ...claims, token: bearer },
  );
  if (authorized === null) {
    await store.authorizationFailed(ip, Date.now(), configuredAuthFailDelay(env));
    return { ok: false, response: api3Error(401, "Bad access token or JWT") };
  }
  await store.authorizationSucceeded(ip);
  return { ok: true, authorized, store };
}

async function handleApi(request: Request, env: AppEnv, url: URL): Promise<Response> {
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

  const statusMatch = /^\/api\/v[12]\/status(?:\/|\.(json|html|txt|png|svg|js|csv|tsv))?$/i.exec(
    url.pathname,
  );
  const statusExtension = statusMatch?.[1];
  const statusExtensionHasLockedCase = statusExtension === undefined
    || statusExtension === "json"
    || statusExtension === "html"
    || statusExtension === "txt"
    || statusExtension === "png"
    || statusExtension === "svg"
    || statusExtension === "js"
    || statusExtension === "csv"
    || statusExtension === "tsv";
  if (
    (request.method === "GET" || request.method === "HEAD")
    && statusMatch !== null
    && statusExtensionHasLockedCase
  ) {
    await requirePermission(
      request,
      env,
      url,
      "api:status:read",
    );
    const extension = statusExtension;
    if (extension === "csv" || extension === "tsv") {
      return statusNotAcceptable(request);
    }
    const format: StatusFormat | null = extension === undefined
      ? negotiatedStatusFormat(request)
      : extension === "txt"
        ? "text"
        : extension as StatusFormat;
    if (format === null) {
      return statusNotAcceptable(request);
    }
    const status = await statusForRequest(env, url);
    return withoutBodyForHead(
      request,
      renderStatus(request, status, format, extension !== undefined),
    );
  }

  if (isStatusFinalhandlerPath(url.pathname)) {
    if (/^\/api\/v[12]\/status/i.test(url.pathname)) {
      await requirePermission(request, env, url, "api:status:read");
    }
    return expressFinalNotFound(request, url);
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
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
  const matchedEntriesRoute = matchApi3EntriesRoute(request.method, api3Pathname);
  const matchedProfileRoute = matchApi3ProfileRoute(request.method, api3Pathname);
  const matchedApi3Route = matchedTreatmentRoute === null
    ? matchedDeviceStatusRoute === null
      ? matchedEntriesRoute === null
        ? matchedProfileRoute === null
          ? null
          : { route: matchedProfileRoute, collection: "profile" as const }
        : { route: matchedEntriesRoute, collection: "entries" as const }
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
      : matchedApi3Route.collection === "devicestatus"
        ? handleApi3DeviceStatus(
          request,
          url,
          authentication.store,
          authentication.authorized,
          api3CollectionRoute,
        )
        : matchedApi3Route.collection === "entries"
          ? handleApi3Entries(
            request,
            url,
            authentication.store,
            authentication.authorized,
            api3CollectionRoute,
          )
          : handleApi3Profile(
            request,
            url,
            authentication.store,
            authentication.authorized,
            api3CollectionRoute,
          );
  }

  if (isApi3) return api3Error(404, "Bad operation or collection");

  const ddataRoute = /^\/api\/v2\/ddata\/at(?:\/([^/]+))?\/?$/.exec(url.pathname);
  if (request.method === "GET" && ddataRoute !== null) {
    await requirePermissions(
      request,
      env,
      url,
      ["api:entries:read", "api:treatments:read"],
    );
    const store = env.ENTRY_STORE.getByName(resolveTenant(request, url));
    const now = Date.now();
    let at = now;
    if (ddataRoute[1] !== undefined) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(ddataRoute[1]);
      } catch {
        throw new ApiError(400, "invalid_query", "ddata frame time is invalid");
      }
      const numeric = Number(decoded);
      at = Number.isFinite(numeric) ? numeric : Date.parse(decoded);
      if (!Number.isFinite(at)) {
        throw new ApiError(400, "invalid_query", "ddata frame time is invalid");
      }
    }
    // Locked ddata_at reuses the live cache inside five minutes; older/future
    // explicit frames run a two-day bounded load ending at the requested time.
    const frame = ddataRoute[1] !== undefined && Math.abs(at - now) >= 5 * 60_000;
    return json(JSON.parse(await store.getDdataSnapshotJson(at, frame)));
  }

  if (request.method === "GET" && url.pathname === "/api/v2/properties") {
    await requirePermissions(
      request,
      env,
      url,
      ["api:entries:read", "api:treatments:read"],
    );
    const tenant = resolveTenant(request, url);
    // The upstream sandbox properties are derived from the runtime SGV bucket,
    // whose mbg-first/truthy-sgv classification is not equivalent to type=sgv.
    const entries = await env.ENTRY_STORE.getByName(tenant).getSgvEntries(4);
    return json(toClockProperties(entries));
  }

  if (request.method === "GET" && /^\/api\/v[12]\/verifyauth\/?$/.test(url.pathname)) {
    const resolution = await resolveRequestAuthorization(request, env, url);
    const permissionGroups = env.ENTRY_STORE === undefined
      ? resolution.admin ? [["*"]] : []
      : await permissionGroupsForResolution(
        resolution,
        env.ENTRY_STORE.getByName(resolveTenant(request, url)),
        env,
      );
    const canRead = permissionGroupsAllow(permissionGroups, "*:*:read");
    const canWrite = permissionGroupsAllow(permissionGroups, "*:*:write");
    const isAdmin = permissionGroupsAllow(permissionGroups, "*:*:admin");
    return json({
      status: 200,
      message: {
        canRead,
        canWrite,
        isAdmin,
        permissions: resolution.defaults ? "DEFAULT" : "ROLE",
        rolefound: resolution.authorized === null ? "NOTFOUND" : "FOUND",
        message: canRead && !resolution.defaults ? "OK" : "UNAUTHORIZED",
      },
    });
  }

  if (request.method === "GET" && /^\/api\/v[12]\/adminnotifies\/?$/.test(url.pathname)) {
    // Locked adminnotifies is public but still resolves credentials so a bad
    // explicit secret participates in the shared failure delay-list.
    await resolveRequestAuthorization(request, env, url);
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
        return await handleSocketIo(
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
        if (error.status === 401 && error.code === "unauthorized") {
          return json(
            { status: 401, message: "Unauthorized", description: "Invalid/Missing" },
            { status: 401 },
          );
        }
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
