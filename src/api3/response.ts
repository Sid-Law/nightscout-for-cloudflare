import accepts from "accepts";
import csvStringifySync from "csv-stringify/lib/sync.js";
import EasyXml from "easyxml";
import { API3_MESSAGES, Api3InputError } from "./input";

export type Api3Format = "json" | "csv" | "xml";

export class Api3RenderError extends Error {
  readonly responseHeaders: Headers;

  constructor(cause: unknown, responseHeaders: Headers) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "Api3RenderError";
    this.responseHeaders = new Headers(responseHeaders);
  }
}

// Express' locked res.format() order is JSON, CSV, then XML.
const NEGOTIABLE_FORMATS = ["json", "csv", "xml"] as const;

function negotiateFormat(accept: string | null): Api3Format | null {
  // This is the exact package and offered-format order used by the locked
  // Nightscout Express response helper. Keep it instead of a local parser.
  const request = accept === null
    ? { headers: {} }
    : { headers: { accept } };
  const selected = accepts(request).types([...NEGOTIABLE_FORMATS]);
  return selected === false ? null : selected;
}

function varyOnAccept(headers: Headers): void {
  const existing = headers.get("Vary");
  if (existing === null || existing.trim() === "") {
    headers.set("Vary", "Accept");
    return;
  }
  if (!existing.split(",").some((value) => value.trim().toLowerCase() === "accept")) {
    headers.set("Vary", `${existing}, Accept`);
  }
}

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

export function api3Status(
  status: number,
  message?: string,
  description?: string,
  initHeaders?: HeadersInit,
): Response {
  const body: Record<string, unknown> = { status };
  if (message !== undefined) body.message = message;
  if (description !== undefined) body.description = description;
  const headers = responseHeaders(initHeaders);
  if (status === 406) varyOnAccept(headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function api3Result(result: unknown, initHeaders?: HeadersInit): Response {
  return api3Json({ status: 200, result }, 200, initHeaders);
}

export function renderApi3(format: Api3Format, data: unknown, initHeaders?: HeadersInit): Response {
  const headers = new Headers(initHeaders);
  varyOnAccept(headers);
  if (format === "json") return api3Result(data, headers);

  const renderedHeaders = responseHeaders(headers);
  if (format === "csv") {
    renderedHeaders.set("Content-Type", "text/csv; charset=utf-8");
    const source = Array.isArray(data) ? data : [data];
    try {
      return new Response(csvStringifySync(source, { header: true }), {
        status: 200,
        headers: renderedHeaders,
      });
    } catch (error) {
      throw new Api3RenderError(error, renderedHeaders);
    }
  }

  renderedHeaders.set("Content-Type", "application/xml; charset=utf-8");
  const serializer = new EasyXml({
    rootElement: "item",
    dateFormat: "ISO",
    manifest: true,
  });
  try {
    return new Response(serializer.render(data), { status: 200, headers: renderedHeaders });
  } catch (error) {
    throw new Api3RenderError(error, renderedHeaders);
  }
}

export function api3FormatFromRequest(request: Request, extensionMimeType?: string): Api3Format {
  if (extensionMimeType !== undefined) {
    const normalized = extensionMimeType.toLowerCase();
    if (normalized === "json" || normalized === "application/json") return "json";
    if (normalized === "csv" || normalized === "text/csv") return "csv";
    if (normalized === "xml" || normalized === "application/xml") return "xml";
    throw new Api3InputError(406, API3_MESSAGES.unsupportedFormat, true);
  }

  const negotiated = negotiateFormat(request.headers.get("Accept"));
  if (negotiated !== null) return negotiated;
  throw new Api3InputError(406, API3_MESSAGES.unsupportedFormat, true);
}
