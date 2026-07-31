import { describe, expect, it } from "vitest";
import * as protocol from "../src/protocol";

const FORBIDDEN_UNVERSIONED_EIO3_VALUES = [
  "createEngineIoHandshakePacket",
  "decodeEngineIoHandshake",
  "decodeEngineIoPacket",
  "decodeEngineIoPollingPayload",
  "encodeEngineIoPacket",
  "encodeEngineIoPollingPayload",
] as const;

const REQUIRED_VERSIONED_CODECS = [
  "createEngineIoV3HandshakePacket",
  "decodeEngineIoV3Handshake",
  "decodeEngineIoV3Packet",
  "decodeEngineIoV3PollingPayload",
  "encodeEngineIoV3Packet",
  "encodeEngineIoV3PollingPayload",
  "createEngineIoV4HandshakePacket",
  "decodeEngineIoV4Handshake",
  "decodeEngineIoV4Packet",
  "decodeEngineIoV4PollingPayload",
  "encodeEngineIoV4Packet",
  "encodeEngineIoV4PollingPayload",
] as const;

describe("public realtime protocol barrel", () => {
  it("does not expose legacy EIO3 codecs under unversioned names", () => {
    for (const exportName of FORBIDDEN_UNVERSIONED_EIO3_VALUES) {
      expect(protocol, exportName).not.toHaveProperty(exportName);
    }
  });

  it("exposes both Engine.IO revisions only through explicit versioned names", () => {
    for (const exportName of REQUIRED_VERSIONED_CODECS) {
      expect(protocol[exportName], exportName).toBeTypeOf("function");
    }
    expect(protocol.ENGINE_IO_V3_PROTOCOL).toBe(3);
    expect(protocol.ENGINE_IO_V4_PROTOCOL).toBe(4);
    expect(protocol.LEGACY_EIO3_SIO4_STACK).toMatchObject({
      compatibility: "legacy",
      engineIoProtocol: 3,
      socketIoProtocol: 4,
    });
    expect(protocol.OFFICIAL_EIO4_SIO5_STACK).toMatchObject({
      compatibility: "official",
      engineIoProtocol: 4,
      socketIoProtocol: 5,
    });
  });
});
