import { API3_MESSAGES, Api3InputError } from "./input";

export type Api3Format = "json";

function responseHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  headers.set("Cache-Control", "no-store");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, Last-Modified, If-Modified-Since, If-Unmodified-Since");
  return headers;
}

export function api3Json(data: unknown, status = 200, initHeaders?: HeadersInit): Response {
  const headers = responseHeaders(initHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers });
}

export function api3Status(status: number, message?: string, description?: string): Response {
  const body: Record<string, unknown> = { status };
  if (message !== undefined) body.message = message;
  if (description !== undefined) body.description = description;
  return api3Json(body, status);
}

export function api3Result(result: unknown, initHeaders?: HeadersInit): Response {
  return api3Json({ status: 200, result }, 200, initHeaders);
}

export function renderApi3(_format: Api3Format, data: unknown, initHeaders?: HeadersInit): Response {
  const headers = new Headers(initHeaders);
  headers.set("Vary", "Accept");
  return api3Result(data, headers);
}

export function api3FormatFromRequest(request: Request, extension?: string): Api3Format {
  if (extension !== undefined) {
    if (extension === "json") return "json";
    throw new Api3InputError(406, API3_MESSAGES.unsupportedFormat, true);
  }

  const accept = request.headers.get("Accept");
  if (accept === null || accept.trim() === "" || accept.includes("*/*") || accept.includes("application/json")) {
    return "json";
  }
  throw new Api3InputError(406, API3_MESSAGES.unsupportedFormat, true);
}
