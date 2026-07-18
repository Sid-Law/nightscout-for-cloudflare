import csvStringifySync from "csv-stringify/lib/sync.js";
import EasyXml from "easyxml";
import { API3_MESSAGES, Api3InputError } from "./input";

export type Api3Format = "json" | "csv" | "xml";

type NegotiatedFormat = Api3Format;

interface MediaRange {
  type: string;
  subtype: string;
  params: Map<string, string>;
  quality: number;
  order: number;
}

interface FormatPriority {
  format: NegotiatedFormat;
  quality: number;
  specificity: number;
  acceptOrder: number;
  formatOrder: number;
}

// Express' locked res.format() order is JSON, CSV, then XML.
const NEGOTIABLE_FORMATS: ReadonlyArray<{
  format: NegotiatedFormat;
  type: string;
  subtype: string;
}> = [
  { format: "json", type: "application", subtype: "json" },
  { format: "csv", type: "text", subtype: "csv" },
  { format: "xml", type: "application", subtype: "xml" },
];

function splitQuoted(value: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quoted) {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (character === separator && !quoted) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function parseMediaRange(value: string, order: number): MediaRange | null {
  const match = /^\s*([^\s/;]+)\/([^;\s]+)\s*(?:;(.*))?$/.exec(value);
  if (match === null) return null;
  const params = new Map<string, string>();
  let quality = 1;
  for (const parameter of splitQuoted(match[3] ?? "", ";")) {
    if (parameter.trim() === "") continue;
    const equals = parameter.indexOf("=");
    const key = (equals < 0 ? parameter : parameter.slice(0, equals)).trim().toLowerCase();
    const raw = equals < 0 ? "" : parameter.slice(equals + 1).trim();
    const parsed = unquote(raw);
    if (key === "q") {
      quality = Number.parseFloat(parsed);
      break;
    }
    params.set(key, parsed);
  }
  return {
    type: match[1]!.toLowerCase(),
    subtype: match[2]!.toLowerCase(),
    params,
    quality,
    order,
  };
}

function mediaRanges(accept: string | null): MediaRange[] {
  const source = accept === null || accept.trim() === "" ? "*/*" : accept;
  const ranges: MediaRange[] = [];
  for (const [order, value] of splitQuoted(source, ",").entries()) {
    const parsed = parseMediaRange(value, order);
    if (parsed !== null) ranges.push(parsed);
  }
  return ranges;
}

function priorityForFormat(
  format: (typeof NEGOTIABLE_FORMATS)[number],
  formatOrder: number,
  ranges: MediaRange[],
): FormatPriority {
  let priority: FormatPriority = {
    format: format.format,
    quality: 0,
    specificity: 0,
    acceptOrder: -1,
    formatOrder,
  };
  for (const range of ranges) {
    let specificity = 0;
    if (range.type === format.type) specificity |= 4;
    else if (range.type !== "*") continue;
    if (range.subtype === format.subtype) specificity |= 2;
    else if (range.subtype !== "*") continue;
    if (range.params.size > 0) {
      if (![...range.params.values()].every((value) => value === "*")) continue;
      specificity |= 1;
    }
    const candidate: FormatPriority = {
      format: format.format,
      quality: range.quality,
      specificity,
      acceptOrder: range.order,
      formatOrder,
    };
    if (
      priority.specificity < candidate.specificity
      || (
        priority.specificity === candidate.specificity
        && (
          priority.quality < candidate.quality
          || (
            priority.quality === candidate.quality
            && priority.acceptOrder < candidate.acceptOrder
          )
        )
      )
    ) {
      priority = candidate;
    }
  }
  return priority;
}

function negotiateFormat(accept: string | null): NegotiatedFormat | null {
  const ranges = mediaRanges(accept);
  const priorities = NEGOTIABLE_FORMATS
    .map((format, index) => priorityForFormat(format, index, ranges))
    .filter((priority) => priority.quality > 0)
    .sort((left, right) => (
      right.quality - left.quality
      || right.specificity - left.specificity
      || left.acceptOrder - right.acceptOrder
      || left.formatOrder - right.formatOrder
    ));
  return priorities[0]?.format ?? null;
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

export function api3Status(status: number, message?: string, description?: string): Response {
  const body: Record<string, unknown> = { status };
  if (message !== undefined) body.message = message;
  if (description !== undefined) body.description = description;
  const headers = new Headers();
  if (status === 406) varyOnAccept(headers);
  return api3Json(body, status, headers);
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
    return new Response(csvStringifySync(source, { header: true }), {
      status: 200,
      headers: renderedHeaders,
    });
  }

  renderedHeaders.set("Content-Type", "application/xml; charset=utf-8");
  const serializer = new EasyXml({
    rootElement: "item",
    dateFormat: "ISO",
    manifest: true,
  });
  return new Response(serializer.render(data), { status: 200, headers: renderedHeaders });
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
