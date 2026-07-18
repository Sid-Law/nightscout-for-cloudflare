import * as protocol from "../src/protocol";

// This file is included by `tsc --noEmit` but not by the Vitest file pattern.
// Each expected error becomes an unused directive (and fails the check) if an
// ambiguous EIO3 value or type is ever re-exported from the public barrel.

// @ts-expect-error unversioned legacy EIO3 export is forbidden
void protocol.createEngineIoHandshakePacket;
// @ts-expect-error unversioned legacy EIO3 export is forbidden
void protocol.decodeEngineIoHandshake;
// @ts-expect-error unversioned legacy EIO3 export is forbidden
void protocol.decodeEngineIoPacket;
// @ts-expect-error unversioned legacy EIO3 export is forbidden
void protocol.decodeEngineIoPollingPayload;
// @ts-expect-error unversioned legacy EIO3 export is forbidden
void protocol.encodeEngineIoPacket;
// @ts-expect-error unversioned legacy EIO3 export is forbidden
void protocol.encodeEngineIoPollingPayload;

// @ts-expect-error unversioned legacy EIO3 type is forbidden
export type ForbiddenEngineIoHandshake = protocol.EngineIoHandshake;
// @ts-expect-error unversioned legacy EIO3 type is forbidden
export type ForbiddenEngineIoPacket = protocol.EngineIoPacket;
// @ts-expect-error unversioned legacy EIO3 type is forbidden
export type ForbiddenEngineIoPacketType = protocol.EngineIoPacketType;

export type RequiredVersionedEio3Types = [
  protocol.EngineIoV3Handshake,
  protocol.EngineIoV3Packet,
  protocol.EngineIoV3PacketType,
];
