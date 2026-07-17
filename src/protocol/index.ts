export {
  DEFAULT_PROTOCOL_LIMITS,
  ProtocolError,
  type ProtocolLimitOverrides,
  type ProtocolLimits,
} from "./limits";

export {
  ENGINE_IO_V3_PROTOCOL,
  createEngineIoHandshakePacket,
  decodeEngineIoHandshake,
  decodeEngineIoPacket,
  decodeEngineIoPollingPayload,
  encodeEngineIoPacket,
  encodeEngineIoPollingPayload,
  type EngineIoHandshake,
  type EngineIoPacket,
  type EngineIoPacketType,
} from "./engine-io-v3";

export {
  SOCKET_IO_V4_PROTOCOL,
  decodeSocketIoPacket as decodeSocketIoV4Packet,
  encodeSocketIoPacket as encodeSocketIoV4Packet,
  unwrapSocketIoPacket as unwrapSocketIoV4Packet,
  wrapSocketIoPacket as wrapSocketIoV4Packet,
  type JsonObject as SocketIoV4JsonObject,
  type JsonPrimitive as SocketIoV4JsonPrimitive,
  type JsonValue as SocketIoV4JsonValue,
  type SocketIoAckPacket as SocketIoV4AckPacket,
  type SocketIoConnectPacket as SocketIoV4ConnectPacket,
  type SocketIoDisconnectPacket as SocketIoV4DisconnectPacket,
  type SocketIoErrorPacket as SocketIoV4ErrorPacket,
  type SocketIoEventPacket as SocketIoV4EventPacket,
  type SocketIoPacket as SocketIoV4Packet,
} from "./socket-io";

export {
  ENGINE_IO_V4_HEARTBEAT,
  ENGINE_IO_V4_POLLING_SEPARATOR,
  ENGINE_IO_V4_PROTOCOL,
  createEngineIoV4HandshakePacket,
  decodeEngineIoV4Handshake,
  decodeEngineIoV4Packet,
  decodeEngineIoV4PollingPayload,
  encodeEngineIoV4Packet,
  encodeEngineIoV4PollingPayload,
  type EngineIoV4Handshake,
  type EngineIoV4Packet,
  type EngineIoV4PacketType,
} from "./engine-io-v4";

export {
  SOCKET_IO_V5_PROTOCOL,
  createSocketIoV5ServerConnectPacket,
  decodeSocketIoV5Packet,
  encodeSocketIoV5Packet,
  unwrapSocketIoV5Packet,
  wrapSocketIoV5Packet,
  type SocketIoV5AckPacket,
  type SocketIoV5ConnectPacket,
  type SocketIoV5DisconnectPacket,
  type SocketIoV5ErrorPacket,
  type SocketIoV5EventPacket,
  type SocketIoV5JsonObject,
  type SocketIoV5JsonPrimitive,
  type SocketIoV5JsonValue,
  type SocketIoV5Packet,
} from "./socket-io-v5";

export {
  LEGACY_EIO3_SIO4_STACK,
  OFFICIAL_EIO4_SIO5_STACK,
  createEngineIoHandshakePacketForStack,
  decodeEngineIoHandshakeForStack,
  decodeEngineIoPacketForStack,
  decodeEngineIoPollingPayloadForStack,
  decodeSocketIoPacketForStack,
  encodeEngineIoPacketForStack,
  encodeEngineIoPollingPayloadForStack,
  encodeSocketIoPacketForStack,
  negotiateProtocolStack,
  type ProtocolStack,
  type SupportedEngineIoProtocol,
  type SupportedSocketIoProtocol,
} from "./protocol-stack";
