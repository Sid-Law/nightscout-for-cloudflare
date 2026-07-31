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

export const ENGINE_IO_V3_PROTOCOL = 3;

export type EngineIoPacketType =
  | "open"
  | "close"
  | "ping"
  | "pong"
  | "message"
  | "upgrade"
  | "noop";

export interface EngineIoPacket {
  type: EngineIoPacketType;
  data?: string;
}

export interface EngineIoHandshake {
  sid: string;
  upgrades: string[];
  pingInterval: number;
  pingTimeout: number;
  maxPayload?: number;
}

const PACKET_CODES: Readonly<Record<EngineIoPacketType, string>> = Object.freeze({
  open: "0",
  close: "1",
  ping: "2",
  pong: "3",
  message: "4",
  upgrade: "5",
  noop: "6",
});

const PACKET_TYPES: Readonly<Record<string, EngineIoPacketType>> = Object.freeze({
  "0": "open",
  "1": "close",
  "2": "ping",
  "3": "pong",
  "4": "message",
  "5": "upgrade",
  "6": "noop",
});

const SID = /^[A-Za-z0-9_-]+$/;
const UPGRADE = /^[A-Za-z0-9_-]+$/;

function validatePacket(packet: EngineIoPacket): void {
  if (PACKET_CODES[packet.type] === undefined) {
    throw new ProtocolError("unknown_engine_packet", "unknown Engine.IO packet type");
  }
  if (packet.data !== undefined && typeof packet.data !== "string") {
    throw new ProtocolError("invalid_engine_packet", "Engine.IO packet data must be a string");
  }
}

export function encodeEngineIoPacket(
  packet: EngineIoPacket,
  overrides?: ProtocolLimitOverrides,
): string {
  const limits = resolveProtocolLimits(overrides);
  validatePacket(packet);
  const encoded = `${PACKET_CODES[packet.type]}${packet.data ?? ""}`;
  if (encoded.length > limits.maxPacketCharacters) {
    throw new ProtocolError(
      "engine_packet_too_large",
      `Engine.IO packet exceeds ${limits.maxPacketCharacters} characters`,
    );
  }
  assertUtf8Size(encoded, limits.maxPacketBytes, "engine_packet_too_large", "Engine.IO packet");
  return encoded;
}

export function decodeEngineIoPacket(
  frame: string,
  overrides?: ProtocolLimitOverrides,
): EngineIoPacket {
  const limits = resolveProtocolLimits(overrides);
  if (typeof frame !== "string" || frame.length === 0) {
    throw new ProtocolError("invalid_engine_packet", "Engine.IO packet must be a non-empty string");
  }
  if (frame.length > limits.maxPacketCharacters) {
    throw new ProtocolError(
      "engine_packet_too_large",
      `Engine.IO packet exceeds ${limits.maxPacketCharacters} characters`,
    );
  }
  assertUtf8Size(frame, limits.maxPacketBytes, "engine_packet_too_large", "Engine.IO packet");

  if (frame.charAt(0) === "b") {
    throw new ProtocolError("unsupported_binary_packet", "binary Engine.IO packets are not supported");
  }
  const type = PACKET_TYPES[frame.charAt(0)];
  if (type === undefined) {
    throw new ProtocolError("unknown_engine_packet", "unknown Engine.IO packet type");
  }
  return frame.length === 1 ? { type } : { type, data: frame.slice(1) };
}

export function encodeEngineIoPollingPayload(
  packets: readonly EngineIoPacket[],
  overrides?: ProtocolLimitOverrides,
): string {
  const limits = resolveProtocolLimits(overrides);
  if (packets.length > limits.maxPacketsPerPayload) {
    throw new ProtocolError(
      "too_many_engine_packets",
      `polling payload exceeds ${limits.maxPacketsPerPayload} packets`,
    );
  }
  if (packets.length === 0) {
    const emptyPayload = "0:";
    assertUtf8Size(
      emptyPayload,
      limits.maxPayloadBytes,
      "engine_payload_too_large",
      "polling payload",
    );
    return emptyPayload;
  }

  const parts: string[] = [];
  for (const packet of packets) {
    const frame = encodeEngineIoPacket(packet, limits);
    const header = String(frame.length);
    if (header.length > limits.maxLengthHeaderDigits) {
      throw new ProtocolError("length_header_too_large", "polling length header is too large");
    }
    parts.push(`${header}:${frame}`);
  }
  const payload = parts.join("");
  assertUtf8Size(payload, limits.maxPayloadBytes, "engine_payload_too_large", "polling payload");
  return payload;
}

function readLength(
  payload: string,
  start: number,
  limits: ProtocolLimits,
): { length: number; frameStart: number } {
  let cursor = start;
  let digits = 0;
  let length = 0;

  while (cursor < payload.length && payload.charAt(cursor) !== ":") {
    const character = payload.charAt(cursor);
    if (character < "0" || character > "9") {
      throw new ProtocolError("invalid_length_header", "polling length header must be decimal");
    }
    digits += 1;
    if (digits > limits.maxLengthHeaderDigits) {
      throw new ProtocolError("length_header_too_large", "polling length header is too large");
    }
    length = (length * 10) + Number(character);
    if (!Number.isSafeInteger(length) || length > limits.maxPacketCharacters) {
      throw new ProtocolError("engine_packet_too_large", "declared Engine.IO packet is too large");
    }
    cursor += 1;
  }

  if (digits === 0 || payload.charAt(cursor) !== ":") {
    throw new ProtocolError("invalid_length_header", "polling payload is missing a length header");
  }
  return { length, frameStart: cursor + 1 };
}

export function decodeEngineIoPollingPayload(
  payload: string,
  overrides?: ProtocolLimitOverrides,
): EngineIoPacket[] {
  const limits = resolveProtocolLimits(overrides);
  if (typeof payload !== "string" || payload.length === 0) {
    throw new ProtocolError("invalid_engine_payload", "polling payload must be a non-empty string");
  }
  assertUtf8Size(payload, limits.maxPayloadBytes, "engine_payload_too_large", "polling payload");
  if (payload === "0:") return [];

  const packets: EngineIoPacket[] = [];
  let cursor = 0;
  while (cursor < payload.length) {
    if (packets.length >= limits.maxPacketsPerPayload) {
      throw new ProtocolError(
        "too_many_engine_packets",
        `polling payload exceeds ${limits.maxPacketsPerPayload} packets`,
      );
    }

    const header = readLength(payload, cursor, limits);
    if (header.length === 0) {
      throw new ProtocolError("empty_engine_packet", "empty Engine.IO packets are not allowed");
    }
    const frameEnd = header.frameStart + header.length;
    if (frameEnd > payload.length) {
      throw new ProtocolError("truncated_engine_packet", "polling packet is shorter than declared");
    }
    const frame = payload.slice(header.frameStart, frameEnd);
    packets.push(decodeEngineIoPacket(frame, limits));
    cursor = frameEnd;
  }
  return packets;
}

function requiredPositiveInteger(
  value: unknown,
  name: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new ProtocolError("invalid_handshake", `${name} must be a positive integer`);
  }
  return value as number;
}

function normalizeHandshake(value: unknown, limits: ProtocolLimits): EngineIoHandshake {
  if (!isPlainRecord(value)) {
    throw new ProtocolError("invalid_handshake", "Engine.IO handshake must be a JSON object");
  }
  assertJsonValue(value, limits);
  const knownKeys = new Set(["sid", "upgrades", "pingInterval", "pingTimeout", "maxPayload"]);
  for (const key of Object.keys(value)) {
    if (!knownKeys.has(key)) {
      throw new ProtocolError("invalid_handshake", `unexpected handshake field: ${key}`);
    }
  }
  if (
    typeof value.sid !== "string" ||
    value.sid.length === 0 ||
    value.sid.length > limits.maxSidCharacters ||
    !SID.test(value.sid)
  ) {
    throw new ProtocolError("invalid_handshake", "sid has an invalid format");
  }
  if (!Array.isArray(value.upgrades) || value.upgrades.length > limits.maxUpgrades) {
    throw new ProtocolError("invalid_handshake", "upgrades must be a bounded string array");
  }

  const upgrades: string[] = [];
  const seen = new Set<string>();
  for (const upgrade of value.upgrades) {
    if (
      typeof upgrade !== "string" ||
      upgrade.length === 0 ||
      upgrade.length > limits.maxUpgradeCharacters ||
      !UPGRADE.test(upgrade) ||
      seen.has(upgrade)
    ) {
      throw new ProtocolError("invalid_handshake", "upgrades contains an invalid transport");
    }
    seen.add(upgrade);
    upgrades.push(upgrade);
  }

  const handshake: EngineIoHandshake = {
    sid: value.sid,
    upgrades,
    pingInterval: requiredPositiveInteger(
      value.pingInterval,
      "pingInterval",
      limits.maxTimerMilliseconds,
    ),
    pingTimeout: requiredPositiveInteger(
      value.pingTimeout,
      "pingTimeout",
      limits.maxTimerMilliseconds,
    ),
  };
  if (value.maxPayload !== undefined) {
    handshake.maxPayload = requiredPositiveInteger(
      value.maxPayload,
      "maxPayload",
      Number.MAX_SAFE_INTEGER,
    );
  }
  return handshake;
}

export function createEngineIoHandshakePacket(
  handshake: EngineIoHandshake,
  overrides?: ProtocolLimitOverrides,
): EngineIoPacket {
  const limits = resolveProtocolLimits(overrides);
  const normalized = normalizeHandshake(handshake, limits);
  const data = JSON.stringify(normalized);
  assertUtf8Size(data, limits.maxPacketBytes - 1, "engine_packet_too_large", "handshake JSON");
  return { type: "open", data };
}

export function decodeEngineIoHandshake(
  packet: EngineIoPacket,
  overrides?: ProtocolLimitOverrides,
): EngineIoHandshake {
  const limits = resolveProtocolLimits(overrides);
  if (packet.type !== "open" || typeof packet.data !== "string") {
    throw new ProtocolError("invalid_handshake", "handshake must be an Engine.IO open packet");
  }
  assertUtf8Size(packet.data, limits.maxPacketBytes - 1, "engine_packet_too_large", "handshake JSON");
  assertJsonTextDepth(packet.data, limits.maxJsonDepth);
  let parsed: unknown;
  try {
    parsed = JSON.parse(packet.data) as unknown;
  } catch {
    throw new ProtocolError("invalid_handshake", "handshake contains invalid JSON");
  }
  return normalizeHandshake(parsed, limits);
}
