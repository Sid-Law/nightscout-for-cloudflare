import type {
  EntryStore,
  RealtimeRpcResult,
} from "../entry-store";
import { REALTIME_MAX_PAYLOAD_BYTES } from "./constants";

const ENGINE_ERROR_MESSAGES = {
  0: "Transport unknown",
  1: "Session ID unknown",
  2: "Bad handshake method",
  3: "Bad request",
  5: "Unsupported protocol version",
} as const;

type EngineErrorCode = keyof typeof ENGINE_ERROR_MESSAGES;
type RealtimeRpcError = Extract<RealtimeRpcResult<unknown>, { ok: false }>["error"];

function pollingHeaders(contentType?: string): Headers {
  const headers = new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  });
  if (contentType !== undefined) headers.set("Content-Type", contentType);
  return headers;
}

function engineError(code: EngineErrorCode, status = 400): Response {
  return new Response(JSON.stringify({ code, message: ENGINE_ERROR_MESSAGES[code] }), {
    status,
    headers: pollingHeaders("application/json; charset=UTF-8"),
  });
}

function empty(status: number): Response {
  return new Response(null, { status, headers: pollingHeaders() });
}

function postOk(): Response {
  return new Response("ok", {
    status: 200,
    headers: pollingHeaders("text/html"),
  });
}

function rpcFailure(error: RealtimeRpcError): Response {
  if (error.code === "overlap") return empty(500);
  if (error.code === "unknown_sid" || error.code === "invalid_post_lease") {
    return engineError(1);
  }
  if (error.code === "capacity") return engineError(3, 503);
  return engineError(3);
}

function pollingPostContentType(request: Request): boolean {
  const raw = request.headers.get("Content-Type");
  if (raw === null || raw.trim() === "") return true;
  return raw.split(";", 1)[0]?.trim().toLowerCase() === "text/plain";
}

async function readPollingBody(request: Request): Promise<string | null> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0) return null;
    if (length > REALTIME_MAX_PAYLOAD_BYTES) throw new RangeError("payload too large");
  }

  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > REALTIME_MAX_PAYLOAD_BYTES) {
      await reader.cancel();
      throw new RangeError("payload too large");
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
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
}

/**
 * Engine.IO 4 HTTP long-polling adapter for the tenant EntryStore Durable Object.
 * WebSocket upgrades, EIO3, JSONP polling, and binary polling are intentionally
 * outside this slice and are never advertised in the open packet.
 */
export async function handleSocketIoPolling(
  request: Request,
  url: URL,
  store: DurableObjectStub<EntryStore>,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: pollingHeaders() });
  }

  if (url.searchParams.get("transport") !== "polling") return engineError(0);
  if (url.searchParams.get("EIO") !== "4") return engineError(5);
  if (url.searchParams.has("j")) return engineError(3);

  const rawSid = url.searchParams.get("sid");
  const sid = rawSid === null || rawSid === "" ? null : rawSid;
  if (sid === null) {
    if (request.method !== "GET") return engineError(2);
    const opened = await store.realtimeHandshake();
    if (!opened.ok) return rpcFailure(opened.error);
    return new Response(opened.value.payload, {
      status: 200,
      headers: pollingHeaders("text/plain; charset=UTF-8"),
    });
  }

  if (request.method === "GET") {
    const polled = await store.realtimePoll(sid);
    if (!polled.ok) return rpcFailure(polled.error);
    return new Response(polled.value, {
      status: 200,
      headers: pollingHeaders("text/plain; charset=UTF-8"),
    });
  }
  if (request.method !== "POST") return empty(500);

  const lease = await store.realtimeBeginPost(sid);
  if (!lease.ok) return rpcFailure(lease.error);
  if (!pollingPostContentType(request)) {
    await store.realtimeAbortPost(sid, lease.value);
    return engineError(3);
  }

  let payload: string | null;
  try {
    payload = await readPollingBody(request);
  } catch (error) {
    await store.realtimeAbortPost(sid, lease.value);
    if (error instanceof RangeError) return empty(413);
    throw error;
  }
  if (payload === null) {
    await store.realtimeAbortPost(sid, lease.value);
    return engineError(3);
  }

  const submitted = await store.realtimeSubmitPost(sid, lease.value, payload);
  if (submitted.ok) return postOk();
  // Locked engine.io 6.2.1 acknowledges the polling POST before its parser
  // error closes the socket. Preserve that observable HTTP response.
  if (submitted.error.code === "bad_packet" || submitted.error.code === "queue_overflow") {
    return postOk();
  }
  return rpcFailure(submitted.error);
}
