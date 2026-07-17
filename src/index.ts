import { EntryStore } from "./entry-store";
import { ApiError, parseEntryPayload, parseHistoryQuery } from "./model";
import { nightscoutStatus } from "./status";

export { EntryStore };

const MAX_BODY_BYTES = 64 * 1024;
const TENANT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const API_PATHS = new Set(["/api/v1/entries", "/api/v1/entries.json"]);

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, api-secret, X-NSCF-Tenant",
  };
}

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(corsHeaders())) headers.set(name, value);
  return new Response(JSON.stringify(data), { ...init, headers });
}

function resolveTenant(request: Request, url: URL): string {
  const tenant = request.headers.get("X-NSCF-Tenant") ?? url.searchParams.get("tenant") ?? "demo";
  if (!TENANT.test(tenant)) {
    throw new ApiError(400, "invalid_tenant", "tenant must match [a-z0-9][a-z0-9_-]{0,63}");
  }
  return tenant;
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    throw new ApiError(413, "body_too_large", "request body exceeds 64 KiB");
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
      throw new ApiError(413, "body_too_large", "request body exceeds 64 KiB");
    }
    chunks.push(result.value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new ApiError(400, "invalid_json", "request body is not valid JSON");
  }
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

  if (request.method === "GET" && url.pathname === "/api/v1/status.json") {
    return json(nightscoutStatus());
  }

  if (request.method === "GET" && url.pathname === "/api/v1/verifyauth") {
    return json({
      message: {
        canRead: true,
        canWrite: false,
        isAdmin: false,
        permissions: "READABLE",
        rolefound: "NOTFOUND",
        message: "Reads enabled in default permissions",
      },
    });
  }

  if (request.method === "GET" && url.pathname === "/api/v1/adminnotifies") {
    return json({ message: { notifies: [], notifyCount: 0 } });
  }

  if (API_PATHS.has(url.pathname)) {
    const tenant = resolveTenant(request, url);
    const store = env.ENTRY_STORE.getByName(tenant);

    if (request.method === "POST") {
      const entries = parseEntryPayload(await readBoundedJson(request));
      const result = await store.putEntries(entries);
      return json([], {
        status: 200,
        headers: {
          "X-NSCF-Inserted": String(result.inserted),
          "X-NSCF-Duplicates": String(result.duplicates),
        },
      });
    }

    if (request.method === "GET") {
      return json(await store.getEntries(parseHistoryQuery(url)));
    }
  }

  if (request.method === "GET" && url.pathname === "/api/v1/entries/current.json") {
    const tenant = resolveTenant(request, url);
    return json(await env.ENTRY_STORE.getByName(tenant).getCurrent());
  }

  return json({ error: { code: "not_found", message: "API route not implemented in phase 1" } }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/healthz") {
        return json({ status: "ok", upstream: "v15.0.7", storage: "sqlite-durable-object" });
      }
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env, url);
      }
      return await env.ASSETS.fetch(request);
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
} satisfies ExportedHandler<Env>;
