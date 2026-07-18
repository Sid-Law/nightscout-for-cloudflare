import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  decodeEngineIoV4Handshake,
  decodeEngineIoV4PollingPayload,
  encodeEngineIoV4PollingPayload,
  unwrapSocketIoV5Packet,
  wrapSocketIoV5Packet,
  type SocketIoV5Packet,
} from "../src/protocol";

const TEST_API_SECRET = "nscf-test-secret-20260717";

type JsonObject = Record<string, unknown>;

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

async function secretDigest(): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(TEST_API_SECRET),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function adminWrite(
  tenantName: string,
  path: string,
  payload: unknown,
): Promise<Response> {
  return SELF.fetch(`https://example.test${path}?tenant=${tenantName}`, {
    method: "POST",
    headers: {
      "api-secret": await secretDigest(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

async function issueTreatmentCreator(tenantName: string): Promise<string> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const roleName = `integration-role-${suffix}`;
  expect((await adminWrite(tenantName, "/api/v2/authorization/roles", {
    name: roleName,
    permissions: ["api:treatments:create"],
  })).status).toBe(200);
  const subjectResponse = await adminWrite(
    tenantName,
    "/api/v2/authorization/subjects",
    { name: `Integration creator ${suffix}`, roles: [roleName] },
  );
  expect(subjectResponse.status).toBe(200);
  const created = await subjectResponse.json<JsonObject>();
  const subjectsResponse = await SELF.fetch(
    `https://example.test/api/v2/authorization/subjects?tenant=${tenantName}`,
    { headers: { "api-secret": await secretDigest() } },
  );
  expect(subjectsResponse.status).toBe(200);
  const subject = (await subjectsResponse.json<JsonObject[]>()).find(
    (candidate) => candidate._id === created._id,
  );
  if (subject === undefined) throw new Error("created integration subject was not listed");
  const authorization = await SELF.fetch(
    `https://example.test/api/v2/authorization/request/${encodeURIComponent(String(subject.accessToken))}?tenant=${tenantName}`,
  );
  expect(authorization.status).toBe(200);
  return String((await authorization.json<JsonObject>()).token);
}

function socketEndpoint(tenantName: string, sid?: string): string {
  const suffix = sid === undefined ? "" : `&sid=${encodeURIComponent(sid)}`;
  return `https://example.test/socket.io/?EIO=4&transport=polling&tenant=${tenantName}${suffix}`;
}

function clientPayload(packet: SocketIoV5Packet): string {
  return encodeEngineIoV4PollingPayload([wrapSocketIoV5Packet(packet)]);
}

async function openAndAuthorize(tenantName: string): Promise<SocketIoV5Packet[]> {
  const handshake = await SELF.fetch(socketEndpoint(tenantName));
  expect(handshake.status).toBe(200);
  const [openPacket] = decodeEngineIoV4PollingPayload(await handshake.text());
  const sid = decodeEngineIoV4Handshake(openPacket!).sid;

  const send = (packet: SocketIoV5Packet): Promise<Response> =>
    SELF.fetch(socketEndpoint(tenantName, sid), {
      method: "POST",
      body: clientPayload(packet),
    });
  const poll = async (): Promise<SocketIoV5Packet[]> =>
    decodeEngineIoV4PollingPayload(
      await (await SELF.fetch(socketEndpoint(tenantName, sid))).text(),
    ).map((packet) => unwrapSocketIoV5Packet(packet));

  expect((await send({ type: "connect", namespace: "/" })).status).toBe(200);
  await poll();
  expect((await send({
    type: "event",
    namespace: "/",
    id: 9,
    data: ["authorize", { client: "web" }],
  })).status).toBe(200);
  return poll();
}

function snapshotFrom(packets: SocketIoV5Packet[]): JsonObject {
  const update = packets.find((packet) =>
    packet.type === "event"
    && packet.namespace === "/"
    && packet.data[0] === "dataUpdate"
  );
  expect(update).toBeDefined();
  return (update as Extract<SocketIoV5Packet, { type: "event" }>).data[1] as JsonObject;
}

describe("API3 and realtime integrated tenant contract", () => {
  it("exposes an API3-created treatment in the same tenant snapshot without leaking it", async () => {
    const alpha = tenant("api3-realtime-alpha");
    const beta = tenant("api3-realtime-beta");
    const jwt = await issueTreatmentCreator(alpha);
    const identifier = `integration-treatment-${crypto.randomUUID()}`;
    const createdAt = "2026-07-18T04:00:00.000Z";
    const created = await SELF.fetch(
      `https://example.test/api/v3/treatments?tenant=${alpha}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          identifier,
          date: Date.parse(createdAt),
          utcOffset: 0,
          app: "nscf-integration-test",
          device: "simulated",
          eventType: "Note",
          created_at: createdAt,
          notes: "API3 to realtime integration",
        }),
      },
    );
    expect(created.status).toBe(201);

    const alphaPackets = await openAndAuthorize(alpha);
    const betaPackets = await openAndAuthorize(beta);
    const alphaTreatments = snapshotFrom(alphaPackets).treatments as JsonObject[];
    const betaTreatments = snapshotFrom(betaPackets).treatments as JsonObject[];

    expect(alphaTreatments).toContainEqual(expect.objectContaining({ identifier }));
    expect(betaTreatments).not.toContainEqual(expect.objectContaining({ identifier }));
    expect(alphaPackets.at(-1)).toEqual({
      type: "ack",
      namespace: "/",
      id: 9,
      data: [{ read: true, write: false, write_treatment: false }],
    });
  });
});
