import { env } from "cloudflare:workers";
import { SELF, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EntryStore } from "../src/entry-store";
import {
  decodeEngineIoV4Handshake,
  decodeEngineIoV4PollingPayload,
  encodeEngineIoV4PollingPayload,
  unwrapSocketIoV5Packet,
  wrapSocketIoV5Packet,
  type SocketIoV5Packet,
} from "../src/protocol";

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function endpoint(tenantName: string, query = ""): string {
  return `https://example.test/socket.io/?EIO=4&transport=polling&tenant=${tenantName}${query}`;
}

function clientPayload(packet: SocketIoV5Packet): string {
  return encodeEngineIoV4PollingPayload([wrapSocketIoV5Packet(packet)]);
}

async function open(tenantName: string): Promise<{ sid: string; response: Response }> {
  const response = await SELF.fetch(endpoint(tenantName));
  const packets = decodeEngineIoV4PollingPayload(await response.clone().text());
  const handshake = decodeEngineIoV4Handshake(packets[0]!);
  return { sid: handshake.sid, response };
}

async function send(
  tenantName: string,
  sid: string,
  payload: string,
  headers?: HeadersInit,
): Promise<Response> {
  return SELF.fetch(endpoint(tenantName, `&sid=${sid}`), {
    method: "POST",
    ...(headers === undefined ? {} : { headers }),
    body: payload,
  });
}

async function poll(tenantName: string, sid: string): Promise<Response> {
  return SELF.fetch(endpoint(tenantName, `&sid=${sid}`));
}

describe("Engine.IO 4 polling HTTP adapter", () => {
  it("leaves the versioned homepage transport asset on the static asset path", async () => {
    const response = await SELF.fetch(
      "https://example.test/socket.io/socket.io.js?cachebuster-test",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^(?:text|application)\/javascript/);
    expect(await response.text()).toContain("function installCloudflareTransport(global)");
  });

  it("serves the exact polling open contract and Engine.IO query errors", async () => {
    const name = tenant("eio-open");
    const { sid, response } = await open(name);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=UTF-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe(
      `0{"sid":"${sid}","upgrades":[],"pingInterval":25000,` +
        `"pingTimeout":20000,"maxPayload":1000000}`,
    );

    const withoutTrailingSlash = await SELF.fetch(
      `https://example.test/socket.io?EIO=4&transport=polling&tenant=${name}`,
    );
    expect(withoutTrailingSlash.status).toBe(200);
    expect(await withoutTrailingSlash.text()).toMatch(/^0\{"sid":"[A-Za-z0-9_-]{20}"/);

    const unsupported = await SELF.fetch(
      `https://example.test/socket.io/?EIO=3&transport=polling&tenant=${name}`,
    );
    expect(unsupported.status).toBe(400);
    expect(unsupported.headers.get("Content-Type")).toBe("application/json");
    expect(await unsupported.json()).toEqual({
      code: 5,
      message: "Unsupported protocol version",
    });

    const unknownTransport = await SELF.fetch(
      `https://example.test/socket.io/?EIO=4&transport=websocket&tenant=${name}`,
    );
    expect(unknownTransport.status).toBe(400);
    expect(await unknownTransport.json()).toEqual({ code: 0, message: "Transport unknown" });

    const badHandshake = await SELF.fetch(endpoint(name), { method: "POST", body: "" });
    expect(badHandshake.status).toBe(400);
    expect(await badHandshake.json()).toEqual({ code: 2, message: "Bad handshake method" });

    const wrongMethod = await SELF.fetch(endpoint(name, `&sid=${sid}`), { method: "PUT" });
    expect(wrongMethod.status).toBe(500);
    expect(await wrongMethod.text()).toBe("");

    const unknownWrongMethod = await SELF.fetch(endpoint(name, "&sid=unknown-sid"), {
      method: "PUT",
    });
    expect(unknownWrongMethod.status).toBe(400);
    expect(unknownWrongMethod.headers.get("Content-Type")).toBe("application/json");
    expect(await unknownWrongMethod.json()).toEqual({
      code: 1,
      message: "Session ID unknown",
    });

    const options = await SELF.fetch(endpoint(name), { method: "OPTIONS" });
    expect(options.status).toBe(204);
  });

  it("round-trips root CONNECT and read-only authorize in locked packet order", async () => {
    const name = tenant("eio-root");
    const { sid } = await open(name);

    const connected = await send(
      name,
      sid,
      clientPayload({ type: "connect", namespace: "/" }),
    );
    expect(connected.status).toBe(200);
    expect(connected.headers.get("Content-Type")).toBe("text/html");
    expect(await connected.text()).toBe("ok");

    const connectPackets = decodeEngineIoV4PollingPayload(await (await poll(name, sid)).text())
      .map((packet) => unwrapSocketIoV5Packet(packet));
    expect(connectPackets).toHaveLength(2);
    expect(connectPackets[0]).toMatchObject({
      type: "connect",
      namespace: "/",
      data: { sid: expect.stringMatching(/^[A-Za-z0-9_-]{20}$/) },
    });
    expect(connectPackets[1]).toEqual({
      type: "event",
      namespace: "/",
      data: ["clients", 1],
    });

    expect((await send(name, sid, clientPayload({
      type: "event",
      namespace: "/",
      id: 4,
      data: ["authorize", { client: "web", status: true }],
    }))).status).toBe(200);
    const authorized = decodeEngineIoV4PollingPayload(await (await poll(name, sid)).text())
      .map((packet) => unwrapSocketIoV5Packet(packet));
    expect(authorized[0]).toEqual({
      type: "event",
      namespace: "/",
      data: ["connected"],
    });
    expect(authorized[1]).toMatchObject({
      type: "event",
      namespace: "/",
      data: ["dataUpdate", {
        devicestatus: [],
        sgvs: [],
        cals: [],
        profiles: [],
        mbgs: [],
        food: [],
        treatments: [],
        dbstats: {},
        status: {
          status: "ok",
          version: "15.0.7",
          versionNum: 150007,
        },
      }],
    });
    expect(authorized[2]).toEqual({
      type: "ack",
      namespace: "/",
      id: 4,
      data: [{ read: true, write: false, write_treatment: false }],
    });
  });

  it("keeps SIDs tenant-local and rejects invalid tenant names", async () => {
    const alpha = tenant("eio-alpha");
    const beta = tenant("eio-beta");
    const { sid } = await open(alpha);

    const crossed = await poll(beta, sid);
    expect(crossed.status).toBe(400);
    expect(await crossed.json()).toEqual({ code: 1, message: "Session ID unknown" });

    await send(alpha, sid, clientPayload({ type: "connect", namespace: "/" }));
    expect((await poll(alpha, sid)).status).toBe(200);

    const invalid = await SELF.fetch(
      "https://example.test/socket.io/?EIO=4&transport=polling&tenant=Not%20Safe",
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: "invalid_tenant" },
    });
  });

  it("bounds POST bodies, rejects binary polling, and releases the POST lease", async () => {
    const contentTypeTenant = tenant("eio-content-type");
    const contentTypeSid = (await open(contentTypeTenant)).sid;
    const binary = await send(
      contentTypeTenant,
      contentTypeSid,
      "4binary",
      { "Content-Type": "application/octet-stream" },
    );
    expect(binary.status).toBe(400);
    expect(await binary.json()).toEqual({ code: 3, message: "Bad request" });

    const binaryClosed = await poll(contentTypeTenant, contentTypeSid);
    expect(binaryClosed.status).toBe(400);
    expect(await binaryClosed.json()).toEqual({
      code: 1,
      message: "Session ID unknown",
    });
    const unknownBinary = await send(
      contentTypeTenant,
      "unknown-sid",
      "4binary",
      { "Content-Type": "application/octet-stream" },
    );
    expect(unknownBinary.status).toBe(400);
    expect(await unknownBinary.json()).toEqual({
      code: 1,
      message: "Session ID unknown",
    });

    const textTenant = tenant("eio-content-type-text");
    const textSid = (await open(textTenant)).sid;
    await send(
      textTenant,
      textSid,
      clientPayload({ type: "connect", namespace: "/" }),
      { "Content-Type": "application/json" },
    );
    expect((await poll(textTenant, textSid)).status).toBe(200);

    const parameterTenant = tenant("eio-content-type-parameter");
    const parameterSid = (await open(parameterTenant)).sid;
    expect((await send(
      parameterTenant,
      parameterSid,
      clientPayload({ type: "connect", namespace: "/" }),
      { "Content-Type": "application/octet-stream; charset=UTF-8" },
    )).status).toBe(200);
    expect((await poll(parameterTenant, parameterSid)).status).toBe(200);

    const largeTenant = tenant("eio-large");
    const largeSid = (await open(largeTenant)).sid;
    const oversized = await send(largeTenant, largeSid, "4" + "a".repeat(1_000_000));
    expect(oversized.status).toBe(413);
    expect(await oversized.text()).toBe("");
    await send(largeTenant, largeSid, clientPayload({ type: "connect", namespace: "/" }));
    expect((await poll(largeTenant, largeSid)).status).toBe(200);

    const utf8Tenant = tenant("eio-utf8");
    const utf8Sid = (await open(utf8Tenant)).sid;
    const invalidUtf8 = await SELF.fetch(endpoint(utf8Tenant, `&sid=${utf8Sid}`), {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: new Uint8Array([0xff]),
    });
    expect(invalidUtf8.status).toBe(200);
    expect(invalidUtf8.headers.get("Content-Type")).toBe("text/html");
    expect(await invalidUtf8.text()).toBe("ok");
    const invalidUtf8Closed = await poll(utf8Tenant, utf8Sid);
    expect(invalidUtf8Closed.status).toBe(400);
    expect(await invalidUtf8Closed.json()).toEqual({
      code: 1,
      message: "Session ID unknown",
    });
  });

  it("returns 200 ok for a malformed protocol POST, then makes the closed SID unknown", async () => {
    const name = tenant("eio-malformed");
    const { sid } = await open(name);
    const malformed = await send(name, sid, "4not-socket-io");
    expect(malformed.status).toBe(200);
    expect(malformed.headers.get("Content-Type")).toBe("text/html");
    expect(await malformed.text()).toBe("ok");

    const closed = await poll(name, sid);
    expect(closed.status).toBe(400);
    expect(await closed.json()).toEqual({ code: 1, message: "Session ID unknown" });
  });

  it("returns empty 500 responses for active GET and POST lease overlap", async () => {
    const pollTenant = tenant("eio-get-overlap");
    const pollSid = (await open(pollTenant)).sid;
    const pollStub = env.ENTRY_STORE.getByName(pollTenant) as DurableObjectStub<EntryStore>;
    await runInDurableObject(pollStub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE realtime_sessions SET poll_token = 'active', poll_deadline = ? WHERE sid = ?",
        Date.now() + 30_000,
        pollSid,
      );
    });
    const getOverlap = await poll(pollTenant, pollSid);
    expect(getOverlap.status).toBe(500);
    expect(await getOverlap.text()).toBe("");

    const postTenant = tenant("eio-post-overlap");
    const postSid = (await open(postTenant)).sid;
    const postStub = env.ENTRY_STORE.getByName(postTenant) as DurableObjectStub<EntryStore>;
    const activeLease = await postStub.realtimeBeginPost(postSid);
    expect(activeLease.ok).toBe(true);
    const postOverlap = await send(postTenant, postSid, "3");
    expect(postOverlap.status).toBe(500);
    expect(await postOverlap.text()).toBe("");
  });

  it("emits a due server ping, accepts pong data, and rejects expired SIDs", async () => {
    const name = tenant("eio-heartbeat");
    const { sid } = await open(name);
    const stub = env.ENTRY_STORE.getByName(name) as DurableObjectStub<EntryStore>;
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE realtime_sessions SET next_ping_at = ? WHERE sid = ?",
        Date.now() - 1,
        sid,
      );
    });
    const ping = await poll(name, sid);
    expect(ping.status).toBe(200);
    expect(await ping.text()).toBe("2");

    const pong = await send(
      name,
      sid,
      encodeEngineIoV4PollingPayload([{ type: "pong", data: "probe" }]),
    );
    expect(pong.status).toBe(200);

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE realtime_sessions SET expires_at = 0 WHERE sid = ?",
        sid,
      );
    });
    const expired = await poll(name, sid);
    expect(expired.status).toBe(400);
    expect(await expired.json()).toEqual({ code: 1, message: "Session ID unknown" });
  });
});
