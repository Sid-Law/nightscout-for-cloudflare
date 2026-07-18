import { env } from "cloudflare:workers";
import { SELF, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EntryStore } from "../src/entry-store";
import {
  decodeEngineIoV4Handshake,
  decodeEngineIoV4Packet,
  decodeEngineIoV4PollingPayload,
  encodeEngineIoV4Packet,
  encodeEngineIoV4PollingPayload,
  unwrapSocketIoV5Packet,
  wrapSocketIoV5Packet,
  type SocketIoV5Packet,
} from "../src/protocol";

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function pollingEndpoint(tenantName: string, sid?: string): string {
  return `https://example.test/socket.io/?EIO=4&transport=polling&tenant=${tenantName}`
    + (sid === undefined ? "" : `&sid=${sid}`);
}

function websocketEndpoint(tenantName: string): string {
  return `https://example.test/socket.io/?EIO=4&transport=websocket&tenant=${tenantName}`;
}

function clientPayload(packet: SocketIoV5Packet): string {
  return encodeEngineIoV4PollingPayload([wrapSocketIoV5Packet(packet)]);
}

function clientFrame(packet: SocketIoV5Packet): string {
  return encodeEngineIoV4Packet(wrapSocketIoV5Packet(packet));
}

function dataUpdateStatus(packets: SocketIoV5Packet[]): Record<string, unknown> {
  const update = packets.find((packet) =>
    packet.type === "event" && packet.data[0] === "dataUpdate"
  );
  if (update === undefined || update.type !== "event") {
    throw new Error("missing dataUpdate event");
  }
  const data = update.data[1] as Record<string, unknown>;
  return data.status as Record<string, unknown>;
}

async function pollingStatus(tenantName: string): Promise<Record<string, unknown>> {
  const opened = await SELF.fetch(pollingEndpoint(tenantName));
  expect(opened.status).toBe(200);
  const openPackets = decodeEngineIoV4PollingPayload(await opened.text());
  const sid = decodeEngineIoV4Handshake(openPackets[0]!).sid;

  expect((await SELF.fetch(pollingEndpoint(tenantName, sid), {
    method: "POST",
    body: clientPayload({ type: "connect", namespace: "/" }),
  })).status).toBe(200);
  await (await SELF.fetch(pollingEndpoint(tenantName, sid))).text();

  expect((await SELF.fetch(pollingEndpoint(tenantName, sid), {
    method: "POST",
    body: clientPayload({
      type: "event",
      namespace: "/",
      id: 91,
      data: ["authorize", { client: "status-contract", status: true }],
    }),
  })).status).toBe(200);
  const authorized = decodeEngineIoV4PollingPayload(
    await (await SELF.fetch(pollingEndpoint(tenantName, sid))).text(),
  ).map((packet) => unwrapSocketIoV5Packet(packet));
  return dataUpdateStatus(authorized);
}

class SocketInbox {
  private readonly queued: string[] = [];
  private readonly waiters: Array<(value: string) => void> = [];

  constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const waiter = this.waiters.shift();
      if (waiter === undefined) this.queued.push(event.data);
      else waiter(event.data);
    });
  }

  next(timeoutMs = 2_000): Promise<string> {
    const queued = this.queued.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for status frame")), timeoutMs);
      this.waiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }
}

async function directWebSocketStatus(tenantName: string): Promise<Record<string, unknown>> {
  const response = await SELF.fetch(websocketEndpoint(tenantName), {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (socket === null) throw new Error("WebSocket upgrade did not return a socket");
  const inbox = new SocketInbox(socket);
  socket.accept();
  decodeEngineIoV4Handshake(decodeEngineIoV4Packet(await inbox.next()));

  socket.send(clientFrame({ type: "connect", namespace: "/" }));
  await inbox.next();
  await inbox.next();
  socket.send(clientFrame({
    type: "event",
    namespace: "/",
    id: 92,
    data: ["authorize", { client: "status-contract", status: true }],
  }));
  const authorized: SocketIoV5Packet[] = [];
  for (let index = 0; index < 3; index += 1) {
    authorized.push(unwrapSocketIoV5Packet(decodeEngineIoV4Packet(await inbox.next())));
  }
  socket.close(1000, "status contract complete");
  return dataUpdateStatus(authorized);
}

function settings(status: Record<string, unknown>): Record<string, unknown> {
  return status.settings as Record<string, unknown>;
}

async function httpStatus(tenantName: string): Promise<Record<string, unknown>> {
  const response = await SELF.fetch(
    `https://example.test/api/v1/status.json?tenant=${tenantName}`,
  );
  expect(response.status).toBe(200);
  return response.json<Record<string, unknown>>();
}

async function createProfile(tenantName: string, units: string): Promise<void> {
  await env.ENTRY_STORE.getByName(tenantName).createDocuments("profile", JSON.stringify([{
    defaultProfile: "Default",
    startDate: new Date().toISOString(),
    units,
    store: { Default: { units, timezone: "UTC" } },
  }]));
}

describe("tenant status settings are shared by HTTP and realtime", () => {
  it("keeps two tenants isolated across HTTP, polling and direct WebSocket", async () => {
    const mmolTenant = tenant("status-shared-mmol");
    const mgdlTenant = tenant("status-shared-mgdl");
    await createProfile(mmolTenant, "mmol/L");
    await createProfile(mgdlTenant, "mg/dL");

    for (const [tenantName, expectedUnits] of [
      [mmolTenant, "mmol"],
      [mgdlTenant, "mg/dl"],
    ] as const) {
      const http = await httpStatus(tenantName);
      const polling = await pollingStatus(tenantName);
      const websocket = await directWebSocketStatus(tenantName);
      expect(settings(http).units).toBe(expectedUnits);
      expect(settings(polling)).toEqual(settings(http));
      expect(settings(websocket)).toEqual(settings(http));
    }
  });

  it("survives malformed profile JSON and rejects unknown profile unit substrings", async () => {
    const malformedTenant = tenant("status-shared-malformed");
    const unknownTenant = tenant("status-shared-unknown");
    const malformedStub = env.ENTRY_STORE.getByName(malformedTenant);
    await runInDurableObject(malformedStub, async (_instance: EntryStore, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        `INSERT INTO documents (collection, id, body, sort_time, created_at, updated_at)
         VALUES ('profile', '999999999999999999999999', '{not-json', ?, ?, ?)`,
        now,
        now,
        now,
      );
    });
    await createProfile(unknownTenant, "notmmol");

    for (const tenantName of [malformedTenant, unknownTenant]) {
      const http = await httpStatus(tenantName);
      const polling = await pollingStatus(tenantName);
      const websocket = await directWebSocketStatus(tenantName);
      expect(settings(http).units).toBe("mg/dl");
      expect(settings(polling)).toEqual(settings(http));
      expect(settings(websocket)).toEqual(settings(http));
    }
  });
});
