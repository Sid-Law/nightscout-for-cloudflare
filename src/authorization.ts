export type PresentedToken = string | string[];

export interface RequestCredentials {
  apiSecret: string | null;
  token: PresentedToken | null;
  tokenSource: "bearer" | "access-token" | null;
}

export interface SubjectCredential {
  accessToken: string;
  accessTokenDigest: string;
  digest: string;
}

export interface AuthorizationRoleDocument {
  name?: unknown;
  permissions?: unknown;
}

export const BUILTIN_AUTHORIZATION_ROLES: ReadonlyArray<{
  name: string;
  permissions: readonly string[];
}> = [
  { name: "admin", permissions: ["*"] },
  { name: "denied", permissions: [] },
  { name: "status-only", permissions: ["api:status:read"] },
  { name: "readable", permissions: ["*:*:read"] },
  { name: "careportal", permissions: ["api:treatments:create"] },
  { name: "devicestatus-upload", permissions: ["api:devicestatus:create"] },
  { name: "activity", permissions: ["api:activity:create"] },
];

/** Locked settings.js defaults to readable; index.js splits on any one delimiter. */
export function authorizationDefaultRoleNames(configured?: string): string[] {
  return (configured ?? "readable").split(/[, :]/);
}

export function authorizationRoleNames(
  subjectRoles: unknown,
  configuredDefaults?: string,
): string[] {
  const names = Array.isArray(subjectRoles)
    ? subjectRoles.filter((role): role is string => typeof role === "string")
    : [];
  return Array.from(new Set([
    ...names,
    ...authorizationDefaultRoleNames(configuredDefaults),
  ]));
}

export function authorizationPermissionGroups(
  roleNames: readonly string[],
  storedRoles: readonly AuthorizationRoleDocument[],
): string[][] {
  return roleNames.map((name) => {
    const role = storedRoles.find((candidate) => candidate.name === name) ??
      BUILTIN_AUTHORIZATION_ROLES.find((candidate) => candidate.name === name);
    if (typeof role?.permissions === "string") return [role.permissions];
    return Array.isArray(role?.permissions)
      ? role.permissions.filter(
        (permission): permission is string => typeof permission === "string",
      )
      : [];
  });
}

const encoder = new TextEncoder();
const MAX_CREDENTIAL_CHARACTERS = 4096;
const MAX_TOKEN_CANDIDATES = 32;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function queryCredential(url: URL, name: string): PresentedToken | null {
  const values = url.searchParams.getAll(name);
  if (values.length === 0) return null;
  return values.length === 1 ? values[0]! : values;
}

function bodyCredential(body: unknown, name: "secret" | "token"): unknown {
  const source = Array.isArray(body) ? record(body[0]) : record(body);
  if (source === null || !source[name]) return null;
  const value = source[name];
  delete source[name];
  return value;
}

function truthyCredential(value: PresentedToken | null): boolean {
  return Array.isArray(value) || Boolean(value);
}

/**
 * Mirrors locked Nightscout v15.0.7's two independent extractors. The API
 * secret extractor runs first and uses query -> header -> first body object.
 * The token extractor then uses exact-case Bearer -> query -> first body
 * object. A selected body credential is deleted before the route sees it.
 */
export function extractRequestCredentials(
  request: Request,
  url: URL,
  body?: unknown,
): RequestCredentials {
  const querySecret = queryCredential(url, "secret");
  const headerSecret = request.headers.get("api-secret");
  let rawSecret: unknown = truthyCredential(querySecret)
    ? querySecret
    : headerSecret;
  if (!rawSecret) rawSecret = bodyCredential(body, "secret");
  const apiSecret = typeof rawSecret === "string" && rawSecret !== "null"
    ? rawSecret
    : null;

  const authorization = request.headers.get("Authorization");
  if (authorization !== null) {
    const parts = authorization.split(" ");
    if (parts.length === 2 && parts[0] === "Bearer" && parts[1]) {
      return {
        apiSecret,
        token: parts[1],
        tokenSource: "bearer",
      };
    }
  }

  const queryToken = queryCredential(url, "token");
  let rawToken: unknown = truthyCredential(queryToken)
    ? queryToken
    : bodyCredential(body, "token");
  if (
    typeof rawToken !== "string" &&
    !(Array.isArray(rawToken) && rawToken.every((value) => typeof value === "string"))
  ) {
    rawToken = null;
  }
  return {
    apiSecret,
    token: rawToken as PresentedToken | null,
    tokenSource: rawToken === null ? null : "access-token",
  };
}

export function boundedTokenCandidates(value: PresentedToken): string[] | null {
  const values = Array.isArray(value) ? value : [value];
  if (
    values.length === 0 ||
    values.length > MAX_TOKEN_CANDIDATES ||
    values.some((candidate) => candidate.length > MAX_CREDENTIAL_CHARACTERS)
  ) {
    return null;
  }
  return values;
}

async function digestHex(
  algorithm: "SHA-1" | "SHA-256" | "SHA-512",
  value: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(algorithm, encoder.encode(value));
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function timingSafeTextEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  // Workers exposes timingSafeEqual on SubtleCrypto. Keep the narrow cast
  // until the generated runtime declaration and the WebWorker lib agree on
  // the augmented method in every supported TypeScript configuration.
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(
      first: ArrayBuffer | ArrayBufferView,
      second: ArrayBuffer | ArrayBufferView,
    ): boolean;
  };
  return subtle.timingSafeEqual(leftDigest, rightDigest);
}

async function timingSafePrefixEqual(full: string, prefix: string): Promise<boolean> {
  if (prefix.length > full.length) return false;
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(
      first: ArrayBuffer | ArrayBufferView,
      second: ArrayBuffer | ArrayBufferView,
    ): boolean;
  };
  return subtle.timingSafeEqual(
    encoder.encode(full.slice(0, prefix.length)),
    encoder.encode(prefix),
  );
}

/** SHA-1 is case-insensitive upstream; SHA-512 is deliberately case-sensitive. */
export async function apiSecretDigestMatches(
  provided: string | null,
  configured: string | null,
): Promise<boolean> {
  if (
    provided === null ||
    configured === null ||
    provided.length > MAX_CREDENTIAL_CHARACTERS
  ) {
    return false;
  }
  const [sha1, sha512] = await Promise.all([
    digestHex("SHA-1", configured),
    digestHex("SHA-512", configured),
  ]);
  const [matchesSha1, matchesSha512] = await Promise.all([
    timingSafeTextEqual(provided.toLowerCase(), sha1),
    timingSafeTextEqual(provided, sha512),
  ]);
  return matchesSha1 || matchesSha512;
}

/**
 * Locked storage.js derives SHA1(SHA1(API_SECRET) + subject ObjectId), then
 * exposes the first 16 digest characters with a cosmetic subject-name prefix.
 */
export async function deriveSubjectCredential(
  configured: string,
  subjectId: string,
  subjectName: string,
): Promise<SubjectCredential> {
  const apiSecretDigest = await digestHex("SHA-1", configured);
  const digest = await digestHex("SHA-1", `${apiSecretDigest}${subjectId}`);
  const abbreviation = subjectName
    .toLowerCase()
    .replace(/\W/g, "")
    .slice(0, 10);
  const accessToken = `${abbreviation}-${digest.slice(0, 16)}`;
  return {
    accessToken,
    accessTokenDigest: await digestHex("SHA-1", accessToken),
    digest,
  };
}

/**
 * Detects API_SECRET rotation without persisting an accepted Nightscout
 * digest. The per-tenant random key is already protected auth state; this
 * marker is only an invalidation tag and is never accepted as a credential.
 */
export function authorizationDerivationMarker(
  tenantKey: string,
  configured: string,
): Promise<string> {
  return digestHex("SHA-256", `${tenantKey}\u0000${configured}`);
}

/**
 * Preserve v15.0.7's prefix behavior, including its cosmetic-prefix ambiguity:
 * only the final dash-delimited suffix participates in the subject digest
 * comparison, while a SHA-1(accessToken) prefix is also accepted.
 */
export async function subjectCredentialMatches(
  subject: SubjectCredential,
  presented: string,
): Promise<boolean> {
  if (
    presented.length === 0 ||
    presented.length > MAX_CREDENTIAL_CHARACTERS
  ) {
    return false;
  }
  const suffix = presented.split("-").at(-1) ?? "";
  if (suffix.length < 16) return false;
  const [accessTokenDigestMatches, subjectDigestMatches] = await Promise.all([
    timingSafePrefixEqual(subject.accessTokenDigest, presented),
    timingSafePrefixEqual(subject.digest, suffix),
  ]);
  return accessTokenDigestMatches || subjectDigestMatches;
}
