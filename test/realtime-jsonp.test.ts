import { env } from "cloudflare:workers";
import { SELF, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EntryStore } from "../src/entry-store";
import {
  decodeEngineIoV3Handshake,
  decodeEngineIoV3PollingPayload,
  decodeEngineIoV4Handshake,
  decodeEngineIoV4PollingPayload,
  encodeEngineIoV3PollingPayload,
  encodeEngineIoV4PollingPayload,
  unwrapSocketIoV4Packet,
  unwrapSocketIoV5Packet,
  wrapSocketIoV5Packet,
} from "../src/protocol";
import {
  decodeJsonpPollingPost,
  encodeJsonpPollingPayload,
} from "../src/realtime/http-adapter";

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function endpoint(
  tenantName: string,
  engineProtocol: 3 | 4,
  query = "",
): string {
  return `https://example.test/socket.io/?EIO=${engineProtocol}` +
    `&transport=polling&tenant=${tenantName}${query}`;
}

function unwrapJsonp(body: string, index: string): string {
  const head = `___eio[${index}](`;
  expect(body.startsWith(head)).toBe(true);
  expect(body.endsWith(");")).toBe(true);
  return JSON.parse(body.slice(head.length, -2)) as string;
}

function rootConnectPayload(): string {
  return encodeEngineIoV4PollingPayload([wrapSocketIoV5Packet({
    type: "connect",
    namespace: "/",
  })]);
}

describe("locked Engine.IO JSONP polling transport", () => {
  it("matches the locked response and form/newline codecs", () => {
    expect(encodeJsonpPollingPayload("line\u2028next\u2029end", "12")).toBe(
      '___eio[12]("line\\u2028next\\u2029end");',
    );
    expect(decodeJsonpPollingPost("d=hello%5Cnworld")).toBe("hello\nworld");
    expect(decodeJsonpPollingPost("d=hello%5C%5Cnworld")).toBe("hello\\nworld");
    expect(decodeJsonpPollingPost("x=ignored")).toBeNull();
    expect(decodeJsonpPollingPost("d=first&d=second")).toBeNull();
  });

  it("persists an EIO4 JSONP callback across DO eviction and ignores later j values", async () => {
    const name = tenant("eio4-jsonp");
    const opened = await SELF.fetch(endpoint(name, 4, "&j=x1y2"));
    expect(opened.status).toBe(200);
    expect(opened.headers.get("Content-Type")).toBe("text/plain; charset=UTF-8");
    const openPayload = unwrapJsonp(await opened.text(), "12");
    const [openPacket] = decodeEngineIoV4PollingPayload(openPayload);
    const handshake = decodeEngineIoV4Handshake(openPacket!);

    const stub = env.ENTRY_STORE.getByName(name) as DurableObjectStub<EntryStore>;
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ id: number }>("SELECT id FROM _sql_schema_migrations WHERE id = 21")
          .one().id,
      ).toBe(21);
      expect(
        state.storage.sql
          .exec<{ jsonp_index: string | null }>(
            "SELECT jsonp_index FROM realtime_sessions WHERE sid = ?",
            handshake.sid,
          )
          .one().jsonp_index,
      ).toBe("12");
    });

    const posted = await SELF.fetch(
      endpoint(name, 4, `&sid=${handshake.sid}&j=999`),
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ d: rootConnectPayload() }).toString(),
      },
    );
    expect(posted.status).toBe(200);
    expect(await posted.text()).toBe("ok");

    const polled = await SELF.fetch(endpoint(name, 4, `&sid=${handshake.sid}`));
    const packets = decodeEngineIoV4PollingPayload(unwrapJsonp(await polled.text(), "12"))
      .map((packet) => unwrapSocketIoV5Packet(packet));
    expect(packets).toHaveLength(2);
    expect(packets[0]).toMatchObject({
      type: "connect",
      namespace: "/",
      data: { sid: expect.stringMatching(/^[A-Za-z0-9_-]{20}$/) },
    });
    expect(packets[1]).toEqual({
      type: "event",
      namespace: "/",
      data: ["clients", 1],
    });
  });

  it("uses the same persisted JSONP envelope for legacy EIO3/SIO4 polling", async () => {
    const name = tenant("eio3-jsonp");
    const opened = await SELF.fetch(endpoint(name, 3, "&j=7"));
    const openPayload = unwrapJsonp(await opened.text(), "7");
    const [openPacket] = decodeEngineIoV3PollingPayload(openPayload);
    const handshake = decodeEngineIoV3Handshake(openPacket!);
    expect(handshake).toMatchObject({
      upgrades: ["websocket"],
      pingInterval: 25_000,
      pingTimeout: 20_000,
    });

    const next = await SELF.fetch(endpoint(name, 3, `&sid=${handshake.sid}&j=321`));
    const packets = decodeEngineIoV3PollingPayload(unwrapJsonp(await next.text(), "7"))
      .map((packet) => unwrapSocketIoV4Packet(packet));
    expect(packets).toEqual([
      { type: "connect", namespace: "/" },
      { type: "event", namespace: "/", data: ["clients", 1] },
    ]);

    const ping = encodeEngineIoV3PollingPayload([{ type: "ping", data: "probe" }]);
    const posted = await SELF.fetch(endpoint(name, 3, `&sid=${handshake.sid}`), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ d: ping }).toString(),
    });
    expect(posted.status).toBe(200);
    expect(await posted.text()).toBe("ok");
    const pong = await SELF.fetch(endpoint(name, 3, `&sid=${handshake.sid}`));
    expect(decodeEngineIoV3PollingPayload(unwrapJsonp(await pong.text(), "7"))).toEqual([
      { type: "pong" },
    ]);
  });

  it("keeps an XHR SID on plain polling even when later requests add j", async () => {
    const name = tenant("eio-xhr-fixed");
    const opened = await SELF.fetch(endpoint(name, 4));
    const [openPacket] = decodeEngineIoV4PollingPayload(await opened.text());
    const sid = decodeEngineIoV4Handshake(openPacket!).sid;

    const posted = await SELF.fetch(endpoint(name, 4, `&sid=${sid}&j=8`), {
      method: "POST",
      body: rootConnectPayload(),
    });
    expect(posted.status).toBe(200);
    const polled = await SELF.fetch(endpoint(name, 4, `&sid=${sid}&j=8`));
    const body = await polled.text();
    expect(body.startsWith("___eio[")).toBe(false);
    expect(
      decodeEngineIoV4PollingPayload(body).map((packet) => unwrapSocketIoV5Packet(packet)),
    ).toHaveLength(2);

    const repeated = await SELF.fetch(endpoint(tenant("eio-repeated-j"), 4, "&j=1&j=2"));
    expect((await repeated.text()).startsWith("___eio[")).toBe(false);
  });

  it("ACKs an absent or duplicate JSONP d field without closing the SID", async () => {
    const name = tenant("eio-jsonp-empty-post");
    const opened = await SELF.fetch(endpoint(name, 4, "&j=5"));
    const [openPacket] = decodeEngineIoV4PollingPayload(
      unwrapJsonp(await opened.text(), "5"),
    );
    const sid = decodeEngineIoV4Handshake(openPacket!).sid;

    for (const body of ["x=ignored", "d=first&d=second"]) {
      const response = await SELF.fetch(endpoint(name, 4, `&sid=${sid}`), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
    }

    const stub = env.ENTRY_STORE.getByName(name) as DurableObjectStub<EntryStore>;
    expect(await stub.realtimeValidateSession(sid, 4)).toEqual({ ok: true, value: null });
  });
});
