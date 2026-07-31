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
import { encodeEngineIoPacket, type EngineIoPacket } from "./engine-io-v3";

/** Socket.IO protocol 4, retained only for the EIO3 legacy stack. */
export const SOCKET_IO_V4_PROTOCOL = 4;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

interface SocketIoBasePacket {
  namespace: string;
}

export interface SocketIoConnectPacket extends SocketIoBasePacket {
  type: "connect";
  data?: JsonObject;
}

export interface SocketIoDisconnectPacket extends SocketIoBasePacket {
  type: "disconnect";
}

export interface SocketIoEventPacket extends SocketIoBasePacket {
  type: "event";
  data: [string | number, ...JsonValue[]];
  id?: number;
}

export interface SocketIoAckPacket extends SocketIoBasePacket {
  type: "ack";
  data: JsonValue[];
  id?: number;
}

export interface SocketIoErrorPacket extends SocketIoBasePacket {
  type: "error";
  data: string | JsonObject;
}

export type SocketIoPacket =
  | SocketIoConnectPacket
  | SocketIoDisconnectPacket
  | SocketIoEventPacket
  | SocketIoAckPacket
  | SocketIoErrorPacket;

const PACKET_CODES: Readonly<Record<SocketIoPacket["type"], string>> = Object.freeze({
  connect: "0",
  disconnect: "1",
  event: "2",
  ack: "3",
  error: "4",
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

function validateEventData(value: unknown, limits: ProtocolLimits): asserts value is SocketIoEventPacket["data"] {
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
  assertJsonValue(value, limits);
}

function validatePacket(packet: SocketIoPacket, limits: ProtocolLimits): void {
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
      if (packet.data !== undefined) {
        if (!isPlainRecord(packet.data)) {
          throw new ProtocolError("invalid_socket_payload", "connect payload must be a JSON object");
        }
        assertJsonValue(packet.data, limits);
      }
      return;
    case "disconnect":
      if (record.id !== undefined || record.data !== undefined) {
        throw new ProtocolError("invalid_socket_payload", "disconnect packets cannot contain data or an ack id");
      }
      return;
    case "event":
      validateAckId(packet.id);
      validateEventData(packet.data, limits);
      return;
    case "ack":
      validateAckId(packet.id);
      if (!Array.isArray(packet.data)) {
        throw new ProtocolError("invalid_socket_payload", "ack payload must be a JSON array");
      }
      assertJsonValue(packet.data, limits);
      return;
    case "error":
      if (record.id !== undefined) {
        throw new ProtocolError("invalid_ack_id", "error packets cannot contain an ack id");
      }
      if (typeof packet.data !== "string" && !isPlainRecord(packet.data)) {
        throw new ProtocolError("invalid_socket_payload", "error payload must be a string or JSON object");
      }
      assertJsonValue(packet.data, limits);
      return;
    default:
      throw new ProtocolError("unknown_socket_packet", "unknown Socket.IO packet type");
  }
}

function stringifyPayload(value: JsonValue, limits: ProtocolLimits): string {
  assertJsonValue(value, limits);
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new ProtocolError("invalid_json_value", "Socket.IO payload is not JSON serializable");
  }
  return encoded;
}

export function encodeSocketIoPacket(
  packet: SocketIoPacket,
  overrides?: ProtocolLimitOverrides,
): string {
  const limits = resolveProtocolLimits(overrides);
  validatePacket(packet, limits);

  let encoded = PACKET_CODES[packet.type];
  if (packet.namespace !== "/") encoded += `${packet.namespace},`;
  if ((packet.type === "event" || packet.type === "ack") && packet.id !== undefined) {
    encoded += String(packet.id);
  }
  if (packet.type !== "disconnect" && packet.data !== undefined) {
    encoded += stringifyPayload(packet.data, limits);
  }

  assertUtf8Size(encoded, limits.maxPacketBytes, "socket_packet_too_large", "Socket.IO packet");
  return encoded;
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

export function decodeSocketIoPacket(
  frame: string,
  overrides?: ProtocolLimitOverrides,
): SocketIoPacket {
  const limits = resolveProtocolLimits(overrides);
  if (typeof frame !== "string" || frame.length === 0) {
    throw new ProtocolError("invalid_socket_packet", "Socket.IO packet must be a non-empty string");
  }
  assertUtf8Size(frame, limits.maxPacketBytes, "socket_packet_too_large", "Socket.IO packet");

  const code = frame.charAt(0);
  if (code === "5" || code === "6") {
    throw new ProtocolError("unsupported_binary_packet", "binary Socket.IO packets are not supported");
  }
  const packetType = Object.entries(PACKET_CODES).find(([, value]) => value === code)?.[0] as
    | SocketIoPacket["type"]
    | undefined;
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
        throw new ProtocolError("invalid_socket_payload", "connect packet has an invalid payload");
      }
      const packet: SocketIoConnectPacket = { type: "connect", namespace };
      if (data !== undefined) packet.data = data as JsonObject;
      validatePacket(packet, limits);
      return packet;
    }
    case "disconnect": {
      if (parsedId.id !== undefined || data !== undefined) {
        throw new ProtocolError("invalid_socket_payload", "disconnect packet cannot contain data or an ack id");
      }
      return { type: "disconnect", namespace };
    }
    case "event": {
      validateEventData(data, limits);
      const packet: SocketIoEventPacket = { type: "event", namespace, data };
      if (parsedId.id !== undefined) packet.id = parsedId.id;
      return packet;
    }
    case "ack": {
      if (!Array.isArray(data)) {
        throw new ProtocolError("invalid_socket_payload", "ack payload must be a JSON array");
      }
      const packet: SocketIoAckPacket = {
        type: "ack",
        namespace,
        data: data as JsonValue[],
      };
      if (parsedId.id !== undefined) packet.id = parsedId.id;
      validatePacket(packet, limits);
      return packet;
    }
    case "error": {
      if (
        parsedId.id !== undefined ||
        (typeof data !== "string" && !isPlainRecord(data))
      ) {
        throw new ProtocolError("invalid_socket_payload", "error payload must be a string or JSON object");
      }
      const packet: SocketIoErrorPacket = {
        type: "error",
        namespace,
        data: data as string | JsonObject,
      };
      validatePacket(packet, limits);
      return packet;
    }
  }
}

export function wrapSocketIoPacket(
  packet: SocketIoPacket,
  overrides?: ProtocolLimitOverrides,
): EngineIoPacket {
  const wrapped: EngineIoPacket = {
    type: "message",
    data: encodeSocketIoPacket(packet, overrides),
  };
  encodeEngineIoPacket(wrapped, overrides);
  return wrapped;
}

export function unwrapSocketIoPacket(
  packet: EngineIoPacket,
  overrides?: ProtocolLimitOverrides,
): SocketIoPacket {
  if (packet.type !== "message" || typeof packet.data !== "string") {
    throw new ProtocolError("invalid_socket_envelope", "Socket.IO packet requires Engine.IO message data");
  }
  encodeEngineIoPacket(packet, overrides);
  return decodeSocketIoPacket(packet.data, overrides);
}
