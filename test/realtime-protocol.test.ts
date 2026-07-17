import { describe, expect, it } from "vitest";
import {
  ENGINE_IO_V3_PROTOCOL,
  SOCKET_IO_V4_PROTOCOL,
  ProtocolError,
  createEngineIoHandshakePacket,
  decodeEngineIoHandshake,
  decodeEngineIoPacket,
  decodeEngineIoPollingPayload,
  decodeSocketIoV4Packet,
  encodeEngineIoPacket,
  encodeEngineIoPollingPayload,
  encodeSocketIoV4Packet,
  unwrapSocketIoV4Packet,
  wrapSocketIoV4Packet,
  type EngineIoHandshake,
  type EngineIoPacket,
  type SocketIoV4Packet,
} from "../src/protocol";

function expectProtocolError(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error(`expected ProtocolError(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(code);
  }
}

const HANDSHAKE: EngineIoHandshake = {
  sid: "abc123",
  upgrades: ["websocket"],
  pingInterval: 25_000,
  pingTimeout: 20_000,
  maxPayload: 1_000_000,
};

describe("Engine.IO 3 packet codec", () => {
  it("uses the locked protocol version and packet type bytes", () => {
    expect(ENGINE_IO_V3_PROTOCOL).toBe(3);
    const cases: Array<[EngineIoPacket, string]> = [
      [{ type: "open", data: "{}" }, "0{}"],
      [{ type: "close" }, "1"],
      [{ type: "ping" }, "2"],
      [{ type: "ping", data: "probe" }, "2probe"],
      [{ type: "pong", data: "probe" }, "3probe"],
      [{ type: "message", data: "0" }, "40"],
      [{ type: "upgrade" }, "5"],
      [{ type: "noop" }, "6"],
    ];

    for (const [packet, encoded] of cases) {
      expect(encodeEngineIoPacket(packet)).toBe(encoded);
      expect(decodeEngineIoPacket(encoded)).toEqual(packet);
    }
  });

  it("encodes the EIO3 polling handshake and root Socket.IO connect sequence", () => {
    const payload = encodeEngineIoPollingPayload([
      createEngineIoHandshakePacket(HANDSHAKE),
      wrapSocketIoV4Packet({ type: "connect", namespace: "/" }),
    ]);

    expect(payload).toBe(
      "104:0{\"sid\":\"abc123\",\"upgrades\":[\"websocket\"],\"pingInterval\":25000," +
      "\"pingTimeout\":20000,\"maxPayload\":1000000}2:40",
    );

    const packets = decodeEngineIoPollingPayload(payload);
    expect(packets).toHaveLength(2);
    expect(decodeEngineIoHandshake(packets[0] as EngineIoPacket)).toEqual(HANDSHAKE);
    expect(unwrapSocketIoV4Packet(packets[1] as EngineIoPacket)).toEqual({
      type: "connect",
      namespace: "/",
    });
  });

  it("matches the EIO3 client-ping/server-pong polling exchange", () => {
    expect(encodeEngineIoPollingPayload([{ type: "ping" }])).toBe("1:2");
    expect(decodeEngineIoPollingPayload("1:2")).toEqual([{ type: "ping" }]);
    expect(encodeEngineIoPollingPayload([{ type: "pong" }])).toBe("1:3");
    expect(decodeEngineIoPollingPayload("1:3")).toEqual([{ type: "pong" }]);
  });

  it("matches an upstream polling event with an acknowledgement id", () => {
    const event = wrapSocketIoV4Packet({
      type: "event",
      namespace: "/",
      id: 0,
      data: ["subscribe", { collections: ["entries"] }],
    });
    expect(encodeEngineIoPollingPayload([event])).toBe(
      '44:420["subscribe",{"collections":["entries"]}]',
    );
    const [decoded] = decodeEngineIoPollingPayload(
      '44:420["subscribe",{"collections":["entries"]}]',
    );
    expect(unwrapSocketIoV4Packet(decoded as EngineIoPacket)).toEqual({
      type: "event",
      namespace: "/",
      id: 0,
      data: ["subscribe", { collections: ["entries"] }],
    });
  });

  it("counts EIO3 polling lengths in JavaScript UTF-16 code units", () => {
    expect(encodeEngineIoPollingPayload([{ type: "message", data: "🙂" }])).toBe("3:4🙂");
    expect(decodeEngineIoPollingPayload("3:4🙂")).toEqual([
      { type: "message", data: "🙂" },
    ]);
  });

  it("round-trips Unicode and multiple packets in one polling payload", () => {
    const packets: EngineIoPacket[] = [
      { type: "ping" },
      wrapSocketIoV4Packet({
        type: "event",
        namespace: "/",
        data: ["dataUpdate", { message: "血糖🙂" }],
      }),
      { type: "close" },
    ];
    const payload = encodeEngineIoPollingPayload(packets);
    expect(payload).toBe('1:235:42["dataUpdate",{"message":"血糖🙂"}]1:1');
    expect(decodeEngineIoPollingPayload(payload)).toEqual(packets);
  });

  it("represents an empty polling batch with the canonical 0: payload", () => {
    expect(encodeEngineIoPollingPayload([])).toBe("0:");
    expect(decodeEngineIoPollingPayload("0:")).toEqual([]);
    expectProtocolError(
      () => encodeEngineIoPollingPayload([], { maxPayloadBytes: 1 }),
      "engine_payload_too_large",
    );
  });

  it("rejects malformed, binary, unknown and truncated Engine.IO frames", () => {
    expectProtocolError(() => decodeEngineIoPacket(""), "invalid_engine_packet");
    expectProtocolError(() => decodeEngineIoPacket("7bad"), "unknown_engine_packet");
    expectProtocolError(() => decodeEngineIoPacket("b4AAAA"), "unsupported_binary_packet");
    expectProtocolError(() => decodeEngineIoPollingPayload("x:4"), "invalid_length_header");
    expectProtocolError(() => decodeEngineIoPollingPayload("2:4"), "truncated_engine_packet");
    expectProtocolError(() => decodeEngineIoPollingPayload("1:7"), "unknown_engine_packet");
    expectProtocolError(() => decodeEngineIoPollingPayload("0:1:4"), "empty_engine_packet");
    expectProtocolError(
      () => decodeEngineIoPollingPayload("00000000001:4"),
      "length_header_too_large",
    );
  });

  it("enforces explicit payload, packet and packet-count limits", () => {
    expectProtocolError(
      () => encodeEngineIoPacket({ type: "message", data: "abcd" }, { maxPacketBytes: 4 }),
      "engine_packet_too_large",
    );
    expectProtocolError(
      () => decodeEngineIoPollingPayload("3:4🙂", { maxPayloadBytes: 6 }),
      "engine_payload_too_large",
    );
    expectProtocolError(
      () => decodeEngineIoPollingPayload("1:21:31:4", { maxPacketsPerPayload: 2 }),
      "too_many_engine_packets",
    );
  });
});

describe("Engine.IO 3 handshake contract", () => {
  it("requires sid, upgrades, pingInterval and pingTimeout", () => {
    const packet = createEngineIoHandshakePacket({
      sid: "session_123",
      upgrades: [],
      pingInterval: 25_000,
      pingTimeout: 20_000,
    });
    expect(decodeEngineIoHandshake(packet)).toEqual({
      sid: "session_123",
      upgrades: [],
      pingInterval: 25_000,
      pingTimeout: 20_000,
    });
  });

  it("accepts the locked Engine.IO maxPayload extension", () => {
    expect(decodeEngineIoHandshake(createEngineIoHandshakePacket(HANDSHAKE))).toEqual(HANDSHAKE);
  });

  it("rejects invalid JSON, shape, session ids, transports and timers", () => {
    expectProtocolError(
      () => decodeEngineIoHandshake({ type: "message", data: "{}" }),
      "invalid_handshake",
    );
    expectProtocolError(
      () => decodeEngineIoHandshake({ type: "open", data: "{" }),
      "invalid_handshake",
    );
    expectProtocolError(
      () => decodeEngineIoHandshake({ type: "open", data: '{"sid":"x"}' }),
      "invalid_handshake",
    );
    expectProtocolError(
      () => createEngineIoHandshakePacket({ ...HANDSHAKE, sid: "bad sid" }),
      "invalid_handshake",
    );
    expectProtocolError(
      () => createEngineIoHandshakePacket({ ...HANDSHAKE, upgrades: ["websocket", "websocket"] }),
      "invalid_handshake",
    );
    expectProtocolError(
      () => createEngineIoHandshakePacket({ ...HANDSHAKE, pingTimeout: 0 }),
      "invalid_handshake",
    );
    expectProtocolError(
      () => decodeEngineIoHandshake({
        type: "open",
        data: '{"sid":"x","upgrades":[],"pingInterval":1,"pingTimeout":1,"extra":true}',
      }),
      "invalid_handshake",
    );
  });
});

describe("legacy Socket.IO protocol 4 codec", () => {
  it("uses the EIO3-compatible parser protocol number", () => {
    expect(SOCKET_IO_V4_PROTOCOL).toBe(4);
  });

  it("encodes connect, event, ack, error and disconnect packets exactly", () => {
    const cases: Array<[SocketIoV4Packet, string]> = [
      [{ type: "connect", namespace: "/" }, "0"],
      [{ type: "connect", namespace: "/alarm" }, "0/alarm,"],
      [{ type: "connect", namespace: "/storage?token=test" }, "0/storage?token=test,"],
      [
        { type: "event", namespace: "/", data: ["dataUpdate", { value: "血糖🙂" }] },
        '2["dataUpdate",{"value":"血糖🙂"}]',
      ],
      [
        { type: "event", namespace: "/alarm", id: 7, data: ["ack", 1, "default", 60_000] },
        '2/alarm,7["ack",1,"default",60000]',
      ],
      [
        { type: "ack", namespace: "/alarm", id: 7, data: [{ result: "success" }] },
        '3/alarm,7[{"result":"success"}]',
      ],
      [{ type: "error", namespace: "/alarm", data: "denied" }, '4/alarm,"denied"'],
      [{ type: "disconnect", namespace: "/alarm" }, "1/alarm,"],
    ];

    for (const [packet, encoded] of cases) {
      expect(encodeSocketIoV4Packet(packet)).toBe(encoded);
      expect(decodeSocketIoV4Packet(encoded)).toEqual(packet);
    }
  });

  it("round-trips namespace, ack id and nested JSON payloads", () => {
    const packet: SocketIoV4Packet = {
      type: "event",
      namespace: "/storage",
      id: Number.MAX_SAFE_INTEGER,
      data: [
        12,
        {
          nested: [true, false, null, { unicode: "東京🙂" }],
          count: 3,
        },
      ],
    };
    expect(decodeSocketIoV4Packet(encodeSocketIoV4Packet(packet))).toEqual(packet);
    expect(unwrapSocketIoV4Packet(wrapSocketIoV4Packet(packet))).toEqual(packet);
  });

  it("rejects unknown, binary and structurally invalid Socket.IO frames", () => {
    expectProtocolError(() => decodeSocketIoV4Packet(""), "invalid_socket_packet");
    expectProtocolError(() => decodeSocketIoV4Packet("9"), "unknown_socket_packet");
    expectProtocolError(() => decodeSocketIoV4Packet('51-["event",{"_placeholder":true,"num":0}]'), "unsupported_binary_packet");
    expectProtocolError(() => decodeSocketIoV4Packet("0/admin"), "invalid_namespace");
    expectProtocolError(() => decodeSocketIoV4Packet('2["connect"]'), "invalid_event_name");
    expectProtocolError(() => decodeSocketIoV4Packet("2[]"), "invalid_socket_payload");
    expectProtocolError(() => decodeSocketIoV4Packet('2{"event":"x"}'), "invalid_socket_payload");
    expectProtocolError(() => decodeSocketIoV4Packet("3{}"), "invalid_socket_payload");
    expectProtocolError(() => decodeSocketIoV4Packet("4[]"), "invalid_socket_payload");
    expectProtocolError(() => decodeSocketIoV4Packet('1["unexpected"]'), "invalid_socket_payload");
    expectProtocolError(() => decodeSocketIoV4Packet("0[]"), "invalid_socket_payload");
    expectProtocolError(() => decodeSocketIoV4Packet('2["event",]'), "invalid_socket_payload");
    expectProtocolError(
      () => decodeSocketIoV4Packet('29007199254740992["event"]'),
      "invalid_ack_id",
    );
  });

  it("rejects invalid encoder inputs instead of lossy JSON coercion", () => {
    expectProtocolError(
      () => encodeSocketIoV4Packet({
        type: "event",
        namespace: "/",
        data: ["event", Number.NaN],
      }),
      "invalid_json_value",
    );
    expectProtocolError(
      () => encodeSocketIoV4Packet({
        type: "event",
        namespace: "/",
        data: ["event", undefined],
      } as unknown as SocketIoV4Packet),
      "invalid_json_value",
    );
    expectProtocolError(
      () => encodeSocketIoV4Packet({
        type: "event",
        namespace: "/",
        data: ["event", 1n],
      } as unknown as SocketIoV4Packet),
      "invalid_json_value",
    );

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expectProtocolError(
      () => encodeSocketIoV4Packet({
        type: "event",
        namespace: "/",
        data: ["event", circular],
      } as unknown as SocketIoV4Packet),
      "circular_json",
    );

    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 });
    expectProtocolError(
      () => encodeSocketIoV4Packet({
        type: "event",
        namespace: "/",
        data: ["event", accessor],
      } as unknown as SocketIoV4Packet),
      "invalid_json_value",
    );

    const hidden = Object.defineProperty({}, "value", { enumerable: false, value: 1 });
    expectProtocolError(
      () => encodeSocketIoV4Packet({
        type: "event",
        namespace: "/",
        data: ["event", hidden],
      } as unknown as SocketIoV4Packet),
      "invalid_json_value",
    );
  });

  it("enforces namespace, ack, byte, JSON depth and complexity limits", () => {
    expectProtocolError(
      () => encodeSocketIoV4Packet({ type: "connect", namespace: "alarm" }),
      "invalid_namespace",
    );
    expectProtocolError(
      () => encodeSocketIoV4Packet({ type: "connect", namespace: "/bad,name" }),
      "invalid_namespace",
    );
    expectProtocolError(
      () => encodeSocketIoV4Packet({
        type: "event",
        namespace: "/",
        id: -1,
        data: ["event"],
      }),
      "invalid_ack_id",
    );
    expectProtocolError(
      () => decodeSocketIoV4Packet('2["event",[[[]]]]', { maxJsonDepth: 2 }),
      "json_too_deep",
    );
    expectProtocolError(
      () => decodeSocketIoV4Packet('2["x",1,2]', { maxJsonNodes: 3 }),
      "json_too_complex",
    );
    expectProtocolError(
      () => encodeSocketIoV4Packet(
        { type: "event", namespace: "/", data: ["x", "12345"] },
        { maxJsonStringCharacters: 4 },
      ),
      "json_string_too_large",
    );
    expectProtocolError(
      () => encodeSocketIoV4Packet(
        { type: "event", namespace: "/", data: ["event", "payload"] },
        { maxPacketBytes: 12 },
      ),
      "socket_packet_too_large",
    );
  });

  it("requires an Engine.IO message envelope", () => {
    expectProtocolError(() => unwrapSocketIoV4Packet({ type: "ping" }), "invalid_socket_envelope");
    expectProtocolError(
      () => unwrapSocketIoV4Packet({ type: "message" }),
      "invalid_socket_envelope",
    );
  });
});
