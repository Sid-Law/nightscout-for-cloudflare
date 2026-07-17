import {
  ProtocolError,
  assertJsonTextDepth,
  assertJsonValue,
  assertUtf8Size,
  isPlainRecord,
  resolveProtocolLimits,
  type ProtocolLimitOverrides,
  type ProtocolLimits,
} from "./limits";
import {
  encodeEngineIoV4Packet,
  type EngineIoV4Packet,
} from "./engine-io-v4";

/** socket.io-parser@4.2.5 protocol number used by Socket.IO 4.5.4. */
export const SOCKET_IO_V5_PROTOCOL = 5;

export type SocketIoV5JsonPrimitive = string | number | boolean | null;
export type SocketIoV5JsonValue =
  | SocketIoV5JsonPrimitive
  | SocketIoV5JsonValue[]
  | { [key: string]: SocketIoV5JsonValue };
export type SocketIoV5JsonObject = { [key: string]: SocketIoV5JsonValue };

interface SocketIoV5BasePacket {
  namespace: string;
}

/** Client auth and server `{ sid }` are both protocol-5 CONNECT objects. */
export interface SocketIoV5ConnectPacket extends SocketIoV5BasePacket {
  type: "connect";
  data?: Record<string, unknown>;
}

export interface SocketIoV5DisconnectPacket extends SocketIoV5BasePacket {
  type: "disconnect";
}

export interface SocketIoV5EventPacket extends SocketIoV5BasePacket {
  type: "event";
  data: [string | number, ...unknown[]];
  id?: number;
}

export interface SocketIoV5AckPacket extends SocketIoV5BasePacket {
  type: "ack";
  data: unknown[];
  id?: number;
}

export interface SocketIoV5ErrorPacket extends SocketIoV5BasePacket {
  type: "error";
  data: string | Record<string, unknown>;
}

export type SocketIoV5Packet =
  | SocketIoV5ConnectPacket
  | SocketIoV5DisconnectPacket
  | SocketIoV5EventPacket
  | SocketIoV5AckPacket
  | SocketIoV5ErrorPacket;

const PACKET_CODES: Readonly<Record<SocketIoV5Packet["type"], string>> = Object.freeze({
  connect: "0",
  disconnect: "1",
  event: "2",
  ack: "3",
  error: "4",
});

const PACKET_TYPES: Readonly<Record<string, SocketIoV5Packet["type"]>> = Object.freeze({
  "0": "connect",
  "1": "disconnect",
  "2": "event",
  "3": "ack",
  "4": "error",
});

const RESERVED_EVENTS = new Set([
  "connect",
  "connect_error",
  "disconnect",
  "disconnecting",
  "newListener",
  "removeListener",
]);

function validateNamespace(namespace: unknown, limits: ProtocolLimits): string {
  if (
    typeof namespace !== "string" ||
    namespace.length === 0 ||
    namespace.length > limits.maxNamespaceCharacters ||
    namespace.charAt(0) !== "/" ||
    namespace.includes(",") ||
    /[\u0000-\u001f\u007f]/.test(namespace)
  ) {
    throw new ProtocolError("invalid_namespace", "Socket.IO namespace has an invalid format");
  }
  return namespace;
}

function validateAckId(id: unknown): number | undefined {
  if (id === undefined) return undefined;
  if (!Number.isSafeInteger(id) || (id as number) < 0) {
    throw new ProtocolError("invalid_ack_id", "Socket.IO ack id must be a non-negative safe integer");
  }
  return id as number;
}

function isSocketIoObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function validateEventData(value: unknown): asserts value is SocketIoV5EventPacket["data"] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProtocolError("invalid_socket_payload", "Socket.IO event payload must be a non-empty array");
  }
  const eventName = value[0];
  if (
    (typeof eventName !== "string" && typeof eventName !== "number") ||
    (typeof eventName === "number" && !Number.isFinite(eventName)) ||
    (typeof eventName === "string" && RESERVED_EVENTS.has(eventName))
  ) {
    throw new ProtocolError("invalid_event_name", "Socket.IO event name is invalid or reserved");
  }
}

function validateInputPacket(packet: SocketIoV5Packet, limits: ProtocolLimits): void {
  if (typeof packet !== "object" || packet === null) {
    throw new ProtocolError("invalid_socket_packet", "Socket.IO packet must be an object");
  }
  validateNamespace(packet.namespace, limits);
  const record = packet as unknown as Record<string, unknown>;

  switch (packet.type) {
    case "connect":
      if (record.id !== undefined) {
        throw new ProtocolError("invalid_ack_id", "connect packets cannot contain an ack id");
      }
      if (packet.data !== undefined && !isSocketIoObject(packet.data)) {
        throw new ProtocolError("invalid_socket_payload", "connect payload must be an object");
      }
      return;
    case "disconnect":
      if (record.id !== undefined || record.data !== undefined) {
        throw new ProtocolError("invalid_socket_payload", "disconnect packets cannot contain data or an ack id");
      }
      return;
    case "event":
      validateAckId(packet.id);
      validateEventData(packet.data);
      return;
    case "ack":
      validateAckId(packet.id);
      if (!Array.isArray(packet.data)) {
        throw new ProtocolError("invalid_socket_payload", "ack payload must be a JSON array");
      }
      return;
    case "error":
      if (record.id !== undefined) {
        throw new ProtocolError("invalid_ack_id", "error packets cannot contain an ack id");
      }
      if (typeof packet.data !== "string" && !isSocketIoObject(packet.data)) {
        throw new ProtocolError("invalid_socket_payload", "error payload must be a string or object");
      }
      return;
    default:
      throw new ProtocolError("unknown_socket_packet", "unknown Socket.IO packet type");
  }
}

function isBinaryValue(value: unknown): boolean {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
  return typeof Blob !== "undefined" && value instanceof Blob;
}

function isRawJsonValue(value: unknown): boolean {
  const isRawJson = Reflect.get(JSON, "isRawJSON");
  return typeof isRawJson === "function" && Reflect.apply(isRawJson, JSON, [value]) === true;
}

interface SerializationWorkItem {
  value: unknown;
  depth: number;
  allowToJson: boolean;
}

/**
 * Mirrors socket.io-parser's binary prewalk before JSON.stringify. This is
 * required because native stringify invokes `toJSON()` before its replacer,
 * which would otherwise let Buffer and typed-array JSON views hide binary
 * input from the rejection boundary.
 */
function assertNonBinarySerialization(value: unknown, limits: ProtocolLimits): void {
  const seenWithToJson = new WeakSet<object>();
  const seenWithoutToJson = new WeakSet<object>();
  const work: SerializationWorkItem[] = [{ value, depth: 0, allowToJson: true }];
  let nodes = 0;

  while (work.length > 0) {
    const item = work.pop();
    if (item === undefined) break;
    nodes += 1;
    if (nodes > limits.maxJsonNodes) {
      throw new ProtocolError("json_too_complex", `JSON exceeds ${limits.maxJsonNodes} nodes`);
    }
    if (item.depth > limits.maxJsonDepth) {
      throw new ProtocolError("json_too_deep", `JSON nesting exceeds ${limits.maxJsonDepth}`);
    }

    const current = item.value;
    if (isBinaryValue(current)) {
      throw new ProtocolError(
        "unsupported_binary_packet",
        "binary Socket.IO packets are not supported",
      );
    }
    if (isRawJsonValue(current)) {
      throw new ProtocolError(
        "invalid_json_value",
        "raw JSON values are outside the bounded Socket.IO JSON boundary",
      );
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
    if (typeof current !== "object" || current === null) continue;

    const seen = item.allowToJson ? seenWithToJson : seenWithoutToJson;
    if (seen.has(current)) continue;
    seen.add(current);

    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        work.push({ value: current[index], depth: item.depth + 1, allowToJson: true });
      }
      continue;
    }

    let toJson: unknown;
    try {
      toJson = Reflect.get(current, "toJSON");
    } catch {
      throw new ProtocolError("invalid_json_value", "Socket.IO payload is not JSON serializable");
    }
    if (item.allowToJson && typeof toJson === "function") {
      let replacement: unknown;
      try {
        replacement = Reflect.apply(toJson, current, []);
      } catch {
        throw new ProtocolError("invalid_json_value", "Socket.IO payload is not JSON serializable");
      }
      work.push({ value: replacement, depth: item.depth, allowToJson: false });
      continue;
    }

    const keys: string[] = [];
    for (const key in current) {
      if (Object.prototype.hasOwnProperty.call(current, key)) keys.push(key);
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
      let child: unknown;
      try {
        child = Reflect.get(current, key);
      } catch {
        throw new ProtocolError("invalid_json_value", "Socket.IO payload is not JSON serializable");
      }
      work.push({ value: child, depth: item.depth + 1, allowToJson: true });
    }
  }
}

interface SerializedPayload {
  json: string;
  normalized: unknown;
}

/**
 * Uses native JSON.stringify semantics, as socket.io-parser@4.2.5 does, while
 * aborting traversal at explicit depth/node/string budgets. `toJSON` is
 * intentionally honored; callers must provide deterministic, non-binary
 * implementations because binary attachment sequences are out of scope.
 */
function stringifyPayload(value: unknown, limits: ProtocolLimits): SerializedPayload {
  assertNonBinarySerialization(value, limits);
  const depths = new WeakMap<object, number>();
  let nodes = 0;
  let scalarCharacters = 0;
  let json: string | undefined;

  try {
    json = JSON.stringify(value, function boundedReplacer(key, current: unknown): unknown {
      nodes += 1;
      if (nodes > limits.maxJsonNodes) {
        throw new ProtocolError("json_too_complex", `JSON exceeds ${limits.maxJsonNodes} nodes`);
      }

      const parentDepth = typeof this === "object" && this !== null
        ? (depths.get(this) ?? -1)
        : -1;
      const depth = parentDepth + 1;
      if (depth > limits.maxJsonDepth) {
        throw new ProtocolError("json_too_deep", `JSON nesting exceeds ${limits.maxJsonDepth}`);
      }

      scalarCharacters += key.length;
      if (key.length > limits.maxJsonStringCharacters) {
        throw new ProtocolError(
          "json_string_too_large",
          `JSON object key exceeds ${limits.maxJsonStringCharacters} characters`,
        );
      }
      if (typeof current === "string") {
        scalarCharacters += current.length;
        if (current.length > limits.maxJsonStringCharacters) {
          throw new ProtocolError(
            "json_string_too_large",
            `JSON string exceeds ${limits.maxJsonStringCharacters} characters`,
          );
        }
      }
      if (current instanceof String) {
        const unboxed = current.valueOf();
        scalarCharacters += unboxed.length;
        if (unboxed.length > limits.maxJsonStringCharacters) {
          throw new ProtocolError(
            "json_string_too_large",
            `JSON string exceeds ${limits.maxJsonStringCharacters} characters`,
          );
        }
      }
      if (scalarCharacters > limits.maxPacketCharacters) {
        throw new ProtocolError(
          "socket_packet_too_large",
          `Socket.IO payload exceeds ${limits.maxPacketCharacters} characters`,
        );
      }

      if (isBinaryValue(current)) {
        throw new ProtocolError(
          "unsupported_binary_packet",
          "binary Socket.IO packets are not supported",
        );
      }
      if (isRawJsonValue(current)) {
        throw new ProtocolError(
          "invalid_json_value",
          "raw JSON values are outside the bounded Socket.IO JSON boundary",
        );
      }
      if (typeof current === "object" && current !== null) {
        depths.set(current, depth);
      }
      return current;
    });
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("invalid_json_value", "Socket.IO payload is not JSON serializable");
  }

  if (json === undefined) {
    throw new ProtocolError("invalid_json_value", "Socket.IO payload is not JSON serializable");
  }
  assertJsonTextDepth(json, limits.maxJsonDepth);
  assertUtf8Size(json, limits.maxPacketBytes, "socket_packet_too_large", "Socket.IO payload");

  const normalized = JSON.parse(json) as unknown;
  assertJsonValue(normalized, limits);
  return { json, normalized };
}

function validateNormalizedPayload(type: SocketIoV5Packet["type"], data: unknown): void {
  switch (type) {
    case "connect":
      if (!isPlainRecord(data)) {
        throw new ProtocolError("invalid_socket_payload", "connect payload must serialize to a JSON object");
      }
      return;
    case "event":
      validateEventData(data);
      return;
    case "ack":
      if (!Array.isArray(data)) {
        throw new ProtocolError("invalid_socket_payload", "ack payload must serialize to a JSON array");
      }
      return;
    case "error":
      if (typeof data !== "string" && !isPlainRecord(data)) {
        throw new ProtocolError("invalid_socket_payload", "error payload must serialize to a string or JSON object");
      }
      return;
    case "disconnect":
      throw new ProtocolError("invalid_socket_payload", "disconnect packets cannot contain data");
  }
}

export function encodeSocketIoV5Packet(
  packet: SocketIoV5Packet,
  overrides?: ProtocolLimitOverrides,
): string {
  const limits = resolveProtocolLimits(overrides);
  validateInputPacket(packet, limits);

  let encoded = PACKET_CODES[packet.type];
  if (packet.namespace !== "/") encoded += `${packet.namespace},`;
  if ((packet.type === "event" || packet.type === "ack") && packet.id !== undefined) {
    encoded += String(packet.id);
  }
  if (packet.type !== "disconnect" && packet.data !== undefined) {
    const payload = stringifyPayload(packet.data, limits);
    validateNormalizedPayload(packet.type, payload.normalized);
    encoded += payload.json;
  }

  if (encoded.length > limits.maxPacketCharacters) {
    throw new ProtocolError(
      "socket_packet_too_large",
      `Socket.IO packet exceeds ${limits.maxPacketCharacters} characters`,
    );
  }
  assertUtf8Size(encoded, limits.maxPacketBytes, "socket_packet_too_large", "Socket.IO packet");
  return encoded;
}

export function createSocketIoV5ServerConnectPacket(
  namespace: string,
  sid: string,
  overrides?: ProtocolLimitOverrides,
): SocketIoV5ConnectPacket {
  const limits = resolveProtocolLimits(overrides);
  validateNamespace(namespace, limits);
  if (
    typeof sid !== "string" ||
    sid.length === 0 ||
    sid.length > limits.maxSidCharacters
  ) {
    throw new ProtocolError("invalid_socket_sid", "Socket.IO sid must be a bounded non-empty string");
  }
  const packet: SocketIoV5ConnectPacket = { type: "connect", namespace, data: { sid } };
  encodeSocketIoV5Packet(packet, limits);
  return packet;
}

function parseAckId(frame: string, start: number): { id: number | undefined; payloadStart: number } {
  let cursor = start;
  while (cursor < frame.length) {
    const character = frame.charAt(cursor);
    if (character < "0" || character > "9") break;
    cursor += 1;
  }
  if (cursor === start) return { id: undefined, payloadStart: start };
  const id = Number(frame.slice(start, cursor));
  if (!Number.isSafeInteger(id)) {
    throw new ProtocolError("invalid_ack_id", "Socket.IO ack id exceeds the safe integer range");
  }
  return { id, payloadStart: cursor };
}

function parseJsonPayload(frame: string, start: number, limits: ProtocolLimits): unknown {
  if (start === frame.length) return undefined;
  const json = frame.slice(start);
  assertJsonTextDepth(json, limits.maxJsonDepth);
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    throw new ProtocolError("invalid_socket_payload", "Socket.IO packet contains invalid JSON");
  }
  assertJsonValue(value, limits);
  return value;
}

export function decodeSocketIoV5Packet(
  frame: string,
  overrides?: ProtocolLimitOverrides,
): SocketIoV5Packet {
  const limits = resolveProtocolLimits(overrides);
  if (typeof frame !== "string" || frame.length === 0) {
    throw new ProtocolError("invalid_socket_packet", "Socket.IO packet must be a non-empty string");
  }
  if (frame.length > limits.maxPacketCharacters) {
    throw new ProtocolError(
      "socket_packet_too_large",
      `Socket.IO packet exceeds ${limits.maxPacketCharacters} characters`,
    );
  }
  assertUtf8Size(frame, limits.maxPacketBytes, "socket_packet_too_large", "Socket.IO packet");

  const code = frame.charAt(0);
  if (code === "5" || code === "6") {
    throw new ProtocolError("unsupported_binary_packet", "binary Socket.IO packets are not supported");
  }
  const packetType = PACKET_TYPES[code];
  if (packetType === undefined) {
    throw new ProtocolError("unknown_socket_packet", "unknown Socket.IO packet type");
  }

  let cursor = 1;
  let namespace = "/";
  if (frame.charAt(cursor) === "/") {
    const comma = frame.indexOf(",", cursor);
    if (comma === -1) {
      throw new ProtocolError("invalid_namespace", "custom Socket.IO namespaces require a comma delimiter");
    }
    namespace = validateNamespace(frame.slice(cursor, comma), limits);
    cursor = comma + 1;
  }

  const parsedId = parseAckId(frame, cursor);
  cursor = parsedId.payloadStart;
  const data = parseJsonPayload(frame, cursor, limits);

  switch (packetType) {
    case "connect": {
      if (parsedId.id !== undefined || (data !== undefined && !isPlainRecord(data))) {
        throw new ProtocolError("invalid_socket_payload", "protocol-5 connect payload must be an object");
      }
      const packet: SocketIoV5ConnectPacket = { type: "connect", namespace };
      if (data !== undefined) packet.data = data;
      return packet;
    }
    case "disconnect":
      if (parsedId.id !== undefined || data !== undefined) {
        throw new ProtocolError("invalid_socket_payload", "disconnect packet cannot contain data or an ack id");
      }
      return { type: "disconnect", namespace };
    case "event": {
      validateEventData(data);
      const packet: SocketIoV5EventPacket = { type: "event", namespace, data };
      if (parsedId.id !== undefined) packet.id = parsedId.id;
      return packet;
    }
    case "ack": {
      if (!Array.isArray(data)) {
        throw new ProtocolError("invalid_socket_payload", "ack payload must be a JSON array");
      }
      const packet: SocketIoV5AckPacket = { type: "ack", namespace, data };
      if (parsedId.id !== undefined) packet.id = parsedId.id;
      return packet;
    }
    case "error":
      if (parsedId.id !== undefined || (typeof data !== "string" && !isPlainRecord(data))) {
        throw new ProtocolError("invalid_socket_payload", "error payload must be a string or JSON object");
      }
      return { type: "error", namespace, data };
  }
}

export function wrapSocketIoV5Packet(
  packet: SocketIoV5Packet,
  overrides?: ProtocolLimitOverrides,
): EngineIoV4Packet {
  const wrapped: EngineIoV4Packet = {
    type: "message",
    data: encodeSocketIoV5Packet(packet, overrides),
  };
  encodeEngineIoV4Packet(wrapped, overrides);
  return wrapped;
}

export function unwrapSocketIoV5Packet(
  packet: EngineIoV4Packet,
  overrides?: ProtocolLimitOverrides,
): SocketIoV5Packet {
  if (packet.type !== "message" || typeof packet.data !== "string") {
    throw new ProtocolError("invalid_socket_envelope", "Socket.IO packet requires Engine.IO message data");
  }
  encodeEngineIoV4Packet(packet, overrides);
  return decodeSocketIoV5Packet(packet.data, overrides);
}
