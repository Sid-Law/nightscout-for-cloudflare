export interface ProtocolLimits {
  maxPayloadBytes: number;
  maxPacketBytes: number;
  maxPacketCharacters: number;
  maxPacketsPerPayload: number;
  maxLengthHeaderDigits: number;
  maxNamespaceCharacters: number;
  maxSidCharacters: number;
  maxUpgrades: number;
  maxUpgradeCharacters: number;
  maxJsonDepth: number;
  maxJsonNodes: number;
  maxJsonStringCharacters: number;
  maxTimerMilliseconds: number;
}

export type ProtocolLimitOverrides = Partial<ProtocolLimits>;

export const DEFAULT_PROTOCOL_LIMITS: Readonly<ProtocolLimits> = Object.freeze({
  maxPayloadBytes: 1_000_000,
  maxPacketBytes: 1_000_000,
  maxPacketCharacters: 1_000_000,
  maxPacketsPerPayload: 128,
  maxLengthHeaderDigits: 10,
  maxNamespaceCharacters: 256,
  maxSidCharacters: 128,
  maxUpgrades: 8,
  maxUpgradeCharacters: 32,
  maxJsonDepth: 32,
  maxJsonNodes: 10_000,
  maxJsonStringCharacters: 262_144,
  maxTimerMilliseconds: 86_400_000,
});

export class ProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

const encoder = new TextEncoder();

export function resolveProtocolLimits(overrides?: ProtocolLimitOverrides): ProtocolLimits {
  const limits = { ...DEFAULT_PROTOCOL_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ProtocolError("invalid_limits", `${name} must be a positive safe integer`);
    }
  }
  return limits;
}

export function assertUtf8Size(
  value: string,
  maximumBytes: number,
  code: string,
  label: string,
): number {
  if (value.length > maximumBytes) {
    throw new ProtocolError(code, `${label} exceeds ${maximumBytes} UTF-8 bytes`);
  }
  const byteLength = encoder.encode(value).byteLength;
  if (byteLength > maximumBytes) {
    throw new ProtocolError(code, `${label} exceeds ${maximumBytes} UTF-8 bytes`);
  }
  return byteLength;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

export function assertJsonTextDepth(json: string, maximumDepth: number): void {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < json.length; index += 1) {
    const character = json.charAt(index);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "[" || character === "{") {
      depth += 1;
      if (depth > maximumDepth) {
        throw new ProtocolError("json_too_deep", `JSON nesting exceeds ${maximumDepth}`);
      }
    } else if (character === "]" || character === "}") {
      depth -= 1;
    }
  }
}

type JsonWorkItem =
  | { kind: "value"; value: unknown; depth: number }
  | { kind: "exit"; value: object };

export function assertJsonValue(value: unknown, limits: ProtocolLimits): void {
  const activeContainers = new WeakSet<object>();
  const work: JsonWorkItem[] = [{ kind: "value", value, depth: 0 }];
  let nodes = 0;

  while (work.length > 0) {
    const item = work.pop();
    if (item === undefined) break;
    if (item.kind === "exit") {
      activeContainers.delete(item.value);
      continue;
    }

    nodes += 1;
    if (nodes > limits.maxJsonNodes) {
      throw new ProtocolError("json_too_complex", `JSON exceeds ${limits.maxJsonNodes} nodes`);
    }
    if (item.depth > limits.maxJsonDepth) {
      throw new ProtocolError("json_too_deep", `JSON nesting exceeds ${limits.maxJsonDepth}`);
    }

    const current = item.value;
    if (current === null || typeof current === "boolean") continue;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new ProtocolError("invalid_json_value", "JSON numbers must be finite");
      }
      continue;
    }
    if (typeof current === "string") {
      if (current.length > limits.maxJsonStringCharacters) {
        throw new ProtocolError(
          "json_string_too_large",
          `JSON string exceeds ${limits.maxJsonStringCharacters} characters`,
        );
      }
      continue;
    }
    if (typeof current !== "object") {
      throw new ProtocolError("invalid_json_value", "payload contains a non-JSON value");
    }

    if (item.depth + 1 > limits.maxJsonDepth) {
      throw new ProtocolError("json_too_deep", `JSON nesting exceeds ${limits.maxJsonDepth}`);
    }

    if (activeContainers.has(current)) {
      throw new ProtocolError("circular_json", "payload contains a circular reference");
    }
    activeContainers.add(current);
    work.push({ kind: "exit", value: current });

    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        work.push({ kind: "value", value: current[index], depth: item.depth + 1 });
      }
      continue;
    }

    if (!isPlainRecord(current)) {
      throw new ProtocolError("invalid_json_value", "payload objects must be plain objects");
    }
    if (Object.getOwnPropertySymbols(current).length > 0) {
      throw new ProtocolError("invalid_json_value", "payload objects cannot contain symbol keys");
    }

    const keys = Object.keys(current);
    if (Object.getOwnPropertyNames(current).length !== keys.length) {
      throw new ProtocolError(
        "invalid_json_value",
        "payload objects cannot contain non-enumerable properties",
      );
    }
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (key === undefined) continue;
      if (key.length > limits.maxJsonStringCharacters) {
        throw new ProtocolError(
          "json_string_too_large",
          `JSON object key exceeds ${limits.maxJsonStringCharacters} characters`,
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new ProtocolError("invalid_json_value", "payload objects cannot contain accessors");
      }
      work.push({ kind: "value", value: descriptor.value, depth: item.depth + 1 });
    }
  }
}
