import {
  createEngineIoHandshakePacket,
  decodeEngineIoHandshake,
  decodeEngineIoPacket,
  decodeEngineIoPollingPayload,
  encodeEngineIoPacket,
  encodeEngineIoPollingPayload,
  type EngineIoHandshake,
  type EngineIoPacket,
} from "./engine-io-v3";
import {
  createEngineIoV4HandshakePacket,
  decodeEngineIoV4Handshake,
  decodeEngineIoV4Packet,
  decodeEngineIoV4PollingPayload,
  encodeEngineIoV4Packet,
  encodeEngineIoV4PollingPayload,
  type EngineIoV4Handshake,
  type EngineIoV4Packet,
} from "./engine-io-v4";
import { ProtocolError, type ProtocolLimitOverrides } from "./limits";
import {
  decodeSocketIoPacket,
  encodeSocketIoPacket,
  type SocketIoPacket,
} from "./socket-io";
import {
  decodeSocketIoV5Packet,
  encodeSocketIoV5Packet,
  type SocketIoV5Packet,
} from "./socket-io-v5";

export const LEGACY_EIO3_SIO4_STACK = Object.freeze({
  name: "legacy-eio3-sio4",
  compatibility: "legacy",
  engineIoProtocol: 3,
  socketIoProtocol: 4,
  pollingPayloadFraming: "length-prefixed",
  heartbeat: Object.freeze({
    pingSender: "client",
    pongSender: "server",
  }),
} as const);

export const OFFICIAL_EIO4_SIO5_STACK = Object.freeze({
  name: "official-eio4-sio5",
  compatibility: "official",
  engineIoProtocol: 4,
  socketIoProtocol: 5,
  pollingPayloadFraming: "record-separator",
  heartbeat: Object.freeze({
    pingSender: "server",
    pongSender: "client",
  }),
} as const);

export type ProtocolStack =
  | typeof LEGACY_EIO3_SIO4_STACK
  | typeof OFFICIAL_EIO4_SIO5_STACK;

export type SupportedEngineIoProtocol = ProtocolStack["engineIoProtocol"];
export type SupportedSocketIoProtocol = ProtocolStack["socketIoProtocol"];

/**
 * Negotiates the complete compatible stack from the exact `EIO` query value.
 * Missing, coerced (for example `4.0`), and future versions are rejected so a
 * caller cannot silently bind a Socket.IO 5 packet stream to the legacy codec.
 */
export function negotiateProtocolStack(eioQueryValue: unknown): ProtocolStack {
  if (eioQueryValue === "3" || eioQueryValue === 3) return LEGACY_EIO3_SIO4_STACK;
  if (eioQueryValue === "4" || eioQueryValue === 4) return OFFICIAL_EIO4_SIO5_STACK;
  if (eioQueryValue === null || eioQueryValue === undefined || eioQueryValue === "") {
    throw new ProtocolError("missing_engine_protocol", "the EIO query parameter is required");
  }
  throw new ProtocolError(
    "unsupported_engine_protocol",
    "only EIO=3 and EIO=4 are supported",
  );
}

function assertSupportedStack(stack: ProtocolStack): SupportedEngineIoProtocol {
  if (
    typeof stack === "object" &&
    stack !== null &&
    stack.engineIoProtocol === 3 &&
    stack.socketIoProtocol === 4
  ) {
    return 3;
  }
  if (
    typeof stack === "object" &&
    stack !== null &&
    stack.engineIoProtocol === 4 &&
    stack.socketIoProtocol === 5
  ) {
    return 4;
  }
  throw new ProtocolError(
    "unsupported_engine_protocol",
    "only EIO=3 and EIO=4 are supported",
  );
}

export function encodeEngineIoPacketForStack(
  stack: ProtocolStack,
  packet: EngineIoPacket | EngineIoV4Packet,
  overrides?: ProtocolLimitOverrides,
): string {
  return assertSupportedStack(stack) === 3
    ? encodeEngineIoPacket(packet, overrides)
    : encodeEngineIoV4Packet(packet, overrides);
}

export function decodeEngineIoPacketForStack(
  stack: ProtocolStack,
  frame: string,
  overrides?: ProtocolLimitOverrides,
): EngineIoPacket | EngineIoV4Packet {
  return assertSupportedStack(stack) === 3
    ? decodeEngineIoPacket(frame, overrides)
    : decodeEngineIoV4Packet(frame, overrides);
}

export function encodeEngineIoPollingPayloadForStack(
  stack: ProtocolStack,
  packets: readonly (EngineIoPacket | EngineIoV4Packet)[],
  overrides?: ProtocolLimitOverrides,
): string {
  return assertSupportedStack(stack) === 3
    ? encodeEngineIoPollingPayload(packets, overrides)
    : encodeEngineIoV4PollingPayload(packets, overrides);
}

export function decodeEngineIoPollingPayloadForStack(
  stack: ProtocolStack,
  payload: string,
  overrides?: ProtocolLimitOverrides,
): EngineIoPacket[] | EngineIoV4Packet[] {
  return assertSupportedStack(stack) === 3
    ? decodeEngineIoPollingPayload(payload, overrides)
    : decodeEngineIoV4PollingPayload(payload, overrides);
}

export function createEngineIoHandshakePacketForStack(
  stack: ProtocolStack,
  handshake: EngineIoHandshake | EngineIoV4Handshake,
  overrides?: ProtocolLimitOverrides,
): EngineIoPacket | EngineIoV4Packet {
  return assertSupportedStack(stack) === 3
    ? createEngineIoHandshakePacket(handshake, overrides)
    : createEngineIoV4HandshakePacket(handshake as EngineIoV4Handshake, overrides);
}

export function decodeEngineIoHandshakeForStack(
  stack: ProtocolStack,
  packet: EngineIoPacket | EngineIoV4Packet,
  overrides?: ProtocolLimitOverrides,
): EngineIoHandshake | EngineIoV4Handshake {
  return assertSupportedStack(stack) === 3
    ? decodeEngineIoHandshake(packet, overrides)
    : decodeEngineIoV4Handshake(packet, overrides);
}

export function encodeSocketIoPacketForStack(
  stack: typeof LEGACY_EIO3_SIO4_STACK,
  packet: SocketIoPacket,
  overrides?: ProtocolLimitOverrides,
): string;
export function encodeSocketIoPacketForStack(
  stack: typeof OFFICIAL_EIO4_SIO5_STACK,
  packet: SocketIoV5Packet,
  overrides?: ProtocolLimitOverrides,
): string;
export function encodeSocketIoPacketForStack(
  stack: ProtocolStack,
  packet: SocketIoPacket | SocketIoV5Packet,
  overrides?: ProtocolLimitOverrides,
): string {
  return assertSupportedStack(stack) === 3
    ? encodeSocketIoPacket(packet as SocketIoPacket, overrides)
    : encodeSocketIoV5Packet(packet, overrides);
}

export function decodeSocketIoPacketForStack(
  stack: typeof LEGACY_EIO3_SIO4_STACK,
  frame: string,
  overrides?: ProtocolLimitOverrides,
): SocketIoPacket;
export function decodeSocketIoPacketForStack(
  stack: typeof OFFICIAL_EIO4_SIO5_STACK,
  frame: string,
  overrides?: ProtocolLimitOverrides,
): SocketIoV5Packet;
export function decodeSocketIoPacketForStack(
  stack: ProtocolStack,
  frame: string,
  overrides?: ProtocolLimitOverrides,
): SocketIoPacket | SocketIoV5Packet {
  return assertSupportedStack(stack) === 3
    ? decodeSocketIoPacket(frame, overrides)
    : decodeSocketIoV5Packet(frame, overrides);
}
