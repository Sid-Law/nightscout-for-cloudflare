export interface JwtClaims {
  accessToken: string;
  iat: number;
  exp: number;
}

export interface IssuedJwt extends JwtClaims {
  token: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const JWT_LIFETIME_SECONDS = 8 * 60 * 60;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    value.length + ((4 - (value.length % 4)) % 4),
    "=",
  );
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function encodeJson(value: object): string {
  return base64UrlEncode(encoder.encode(JSON.stringify(value)));
}

function parseJsonPart(value: string): Record<string, unknown> | null {
  const bytes = base64UrlDecode(value);
  if (bytes === null) return null;
  try {
    const parsed: unknown = JSON.parse(decoder.decode(bytes));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey | null> {
  const bytes = base64UrlDecode(secret);
  if (bytes === null || bytes.byteLength < 32) return null;
  return crypto.subtle.importKey(
    "raw",
    bytesToArrayBuffer(bytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usage,
  );
}

export function createJwtSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export function isJwtSecret(value: string): boolean {
  return base64UrlDecode(value)?.byteLength === 32;
}

export async function issueJwt(
  secret: string,
  accessToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<IssuedJwt> {
  const key = await hmacKey(secret, ["sign"]);
  if (key === null) throw new Error("invalid JWT signing key");
  const claims: JwtClaims = {
    accessToken,
    iat: nowSeconds,
    exp: nowSeconds + JWT_LIFETIME_SECONDS,
  };
  const signingInput = `${encodeJson({ alg: "HS256", typ: "JWT" })}.${encodeJson(claims)}`;
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
  return {
    token: `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`,
    ...claims,
  };
}

export async function verifyJwt(
  secret: string,
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<JwtClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    encodedSignature === undefined
  ) {
    return null;
  }

  const header = parseJsonPart(encodedHeader);
  const payload = parseJsonPart(encodedPayload);
  const signature = base64UrlDecode(encodedSignature);
  if (
    header?.alg !== "HS256" ||
    header.typ !== "JWT" ||
    payload === null ||
    signature === null ||
    typeof payload.accessToken !== "string" ||
    payload.accessToken.length === 0 ||
    !Number.isInteger(payload.iat) ||
    !Number.isInteger(payload.exp) ||
    (payload.iat as number) > nowSeconds ||
    (payload.exp as number) <= nowSeconds
  ) {
    return null;
  }

  const key = await hmacKey(secret, ["verify"]);
  if (key === null) return null;
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    bytesToArrayBuffer(signature),
    encoder.encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!valid) return null;
  return {
    accessToken: payload.accessToken,
    iat: payload.iat as number,
    exp: payload.exp as number,
  };
}
