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

/** engine.io-parser@5.0.7 protocol number. */
export const ENGINE_IO_V4_PROTOCOL = 4;

/** ASCII Record Separator used by Engine.IO 4 HTTP polling payloads. */
export const ENGINE_IO_V4_POLLING_SEPARATOR = "\u001e";

/**
 * Engine.IO 4 reverses the Engine.IO 3 heartbeat direction: the server sends
 * ping and the client answers with pong.
 */
export const ENGINE_IO_V4_HEARTBEAT = Object.freeze({
  initiator: "server",
  pingSender: "server",
  pongSender: "client",
  pingPacketType: "ping",
  pongPacketType: "pong",
} as const);

export type EngineIoV4PacketType =
  | "open"
  | "close"
  | "ping"
  | "pong"
  | "message"
  | "upgrade"
  | "noop";

export interface EngineIoV4Packet {
  type: EngineIoV4PacketType;
  data?: string;
}

/** Shape of the Engine.IO 4 open packet JSON. */
export interface EngineIoV4Handshake {
  sid: string;
  upgrades: string[];
  pingInterval: number;
  pingTimeout: number;
  maxPayload: number;
}

const PACKET_CODES: Readonly<Record<EngineIoV4PacketType, string>> = Object.freeze({
  open: "0",
  close: "1",
  ping: "2",
  pong: "3",
  message: "4",
  upgrade: "5",
  noop: "6",
});

const PACKET_TYPES: Readonly<Record<string, EngineIoV4PacketType>> = Object.freeze({
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

function validatePacket(packet: EngineIoV4Packet): void {
  if (typeof packet !== "object" || packet === null || PACKET_CODES[packet.type] === undefined) {
    throw new ProtocolError("unknown_engine_packet", "unknown Engine.IO 4 packet type");
  }
  if (packet.data !== undefined && typeof packet.data !== "string") {
    throw new ProtocolError(
      "invalid_engine_packet",
      "Engine.IO 4 packet data must be a string",
    );
  }
}

export function encodeEngineIoV4Packet(
  packet: EngineIoV4Packet,
  overrides?: ProtocolLimitOverrides,
): string {
  const limits = resolveProtocolLimits(overrides);
  validatePacket(packet);
  const encoded = `${PACKET_CODES[packet.type]}${packet.data ?? ""}`;
  if (encoded.length > limits.maxPacketCharacters) {
    throw new ProtocolError(
      "engine_packet_too_large",
      `Engine.IO 4 packet exceeds ${limits.maxPacketCharacters} characters`,
    );
  }
  assertUtf8Size(
    encoded,
    limits.maxPacketBytes,
    "engine_packet_too_large",
    "Engine.IO 4 packet",
  );
  return encoded;
}

export function decodeEngineIoV4Packet(
  frame: string,
  overrides?: ProtocolLimitOverrides,
): EngineIoV4Packet {
  const limits = resolveProtocolLimits(overrides);
  if (typeof frame !== "string" || frame.length === 0) {
    throw new ProtocolError(
      "invalid_engine_packet",
      "Engine.IO 4 packet must be a non-empty string",
    );
  }
  if (frame.length > limits.maxPacketCharacters) {
    throw new ProtocolError(
      "engine_packet_too_large",
      `Engine.IO 4 packet exceeds ${limits.maxPacketCharacters} characters`,
    );
  }
  assertUtf8Size(
    frame,
    limits.maxPacketBytes,
    "engine_packet_too_large",
    "Engine.IO 4 packet",
  );

  if (frame.charAt(0) === "b") {
    throw new ProtocolError(
      "unsupported_binary_packet",
      "binary Engine.IO 4 packets are not supported",
    );
  }
  const type = PACKET_TYPES[frame.charAt(0)];
  if (type === undefined) {
    throw new ProtocolError("unknown_engine_packet", "unknown Engine.IO 4 packet type");
  }
  return frame.length === 1 ? { type } : { type, data: frame.slice(1) };
}

export function encodeEngineIoV4PollingPayload(
  packets: readonly EngineIoV4Packet[],
  overrides?: ProtocolLimitOverrides,
): string {
  const limits = resolveProtocolLimits(overrides);
  if (!Array.isArray(packets) || packets.length === 0) {
    throw new ProtocolError(
      "invalid_engine_payload",
      "Engine.IO 4 polling payload must contain at least one packet",
    );
  }
  if (packets.length > limits.maxPacketsPerPayload) {
    throw new ProtocolError(
      "too_many_engine_packets",
      `polling payload exceeds ${limits.maxPacketsPerPayload} packets`,
    );
  }

  const frames: string[] = [];
  let payloadBytes = 0;
  for (const packet of packets) {
    const frame = encodeEngineIoV4Packet(packet, limits);
    // engine.io-parser@5.0.7 does not escape its polling separator. Rejecting
    // it here prevents a caller from accidentally producing extra packets.
    if (frame.includes(ENGINE_IO_V4_POLLING_SEPARATOR)) {
      throw new ProtocolError(
        "invalid_engine_packet",
        "Engine.IO 4 polling packet contains the record separator",
      );
    }
    const frameBytes = assertUtf8Size(
      frame,
      limits.maxPacketBytes,
      "engine_packet_too_large",
      "Engine.IO 4 packet",
    );
    payloadBytes += frameBytes + (frames.length === 0 ? 0 : 1);
    if (payloadBytes > limits.maxPayloadBytes) {
      throw new ProtocolError(
        "engine_payload_too_large",
        `Engine.IO 4 polling payload exceeds ${limits.maxPayloadBytes} UTF-8 bytes`,
      );
    }
    frames.push(frame);
  }

  const payload = frames.join(ENGINE_IO_V4_POLLING_SEPARATOR);
  assertUtf8Size(
    payload,
    limits.maxPayloadBytes,
    "engine_payload_too_large",
    "Engine.IO 4 polling payload",
  );
  return payload;
}

export function decodeEngineIoV4PollingPayload(
  payload: string,
  overrides?: ProtocolLimitOverrides,
): EngineIoV4Packet[] {
  const limits = resolveProtocolLimits(overrides);
  if (typeof payload !== "string" || payload.length === 0) {
    throw new ProtocolError(
      "invalid_engine_payload",
      "Engine.IO 4 polling payload must be a non-empty string",
    );
  }
  assertUtf8Size(
    payload,
    limits.maxPayloadBytes,
    "engine_payload_too_large",
    "Engine.IO 4 polling payload",
  );

  const packets: EngineIoV4Packet[] = [];
  let frameStart = 0;
  while (frameStart <= payload.length) {
    if (packets.length >= limits.maxPacketsPerPayload) {
      throw new ProtocolError(
        "too_many_engine_packets",
        `polling payload exceeds ${limits.maxPacketsPerPayload} packets`,
      );
    }

    const separator = payload.indexOf(ENGINE_IO_V4_POLLING_SEPARATOR, frameStart);
    const frameEnd = separator === -1 ? payload.length : separator;
    if (frameEnd === frameStart) {
      throw new ProtocolError(
        "empty_engine_packet",
        "Engine.IO 4 polling payload contains an empty packet",
      );
    }
    const frame = payload.slice(frameStart, frameEnd);
    packets.push(decodeEngineIoV4Packet(frame, limits));

    if (separator === -1) break;
    frameStart = separator + ENGINE_IO_V4_POLLING_SEPARATOR.length;
  }
  return packets;
}

function requiredPositiveInteger(value: unknown, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new ProtocolError("invalid_handshake", `${name} must be a positive integer`);
  }
  return value as number;
}

function normalizeHandshake(value: unknown, limits: ProtocolLimits): EngineIoV4Handshake {
  if (!isPlainRecord(value)) {
    throw new ProtocolError("invalid_handshake", "Engine.IO 4 handshake must be a JSON object");
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

  return {
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
    maxPayload: requiredPositiveInteger(value.maxPayload, "maxPayload", Number.MAX_SAFE_INTEGER),
  };
}

export function createEngineIoV4HandshakePacket(
  handshake: EngineIoV4Handshake,
  overrides?: ProtocolLimitOverrides,
): EngineIoV4Packet {
  const limits = resolveProtocolLimits(overrides);
  const normalized = normalizeHandshake(handshake, limits);
  const data = JSON.stringify(normalized);
  assertUtf8Size(
    data,
    limits.maxPacketBytes - 1,
    "engine_packet_too_large",
    "Engine.IO 4 handshake JSON",
  );
  return { type: "open", data };
}

export function decodeEngineIoV4Handshake(
  packet: EngineIoV4Packet,
  overrides?: ProtocolLimitOverrides,
): EngineIoV4Handshake {
  const limits = resolveProtocolLimits(overrides);
  if (packet.type !== "open" || typeof packet.data !== "string") {
    throw new ProtocolError(
      "invalid_handshake",
      "handshake must be an Engine.IO 4 open packet",
    );
  }
  assertUtf8Size(
    packet.data,
    limits.maxPacketBytes - 1,
    "engine_packet_too_large",
    "Engine.IO 4 handshake JSON",
  );
  assertJsonTextDepth(packet.data, limits.maxJsonDepth);
  let parsed: unknown;
  try {
    parsed = JSON.parse(packet.data) as unknown;
  } catch {
    throw new ProtocolError("invalid_handshake", "handshake contains invalid JSON");
  }
  return normalizeHandshake(parsed, limits);
}
