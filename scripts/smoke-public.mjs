import assert from "node:assert/strict";

const DEFAULT_ORIGIN = "https://nscf-phase1.nscf-lab-20260717.workers.dev";
const origin = (process.argv[2] ?? DEFAULT_ORIGIN).replace(/\/$/, "");
const tenant = `public-smoke-${Date.now()}`;
let assertions = 0;

function checked(condition, message) {
  assertions += 1;
  assert.ok(condition, message);
}

function equal(actual, expected, message) {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
}

function endpoint(path, scoped = true) {
  const url = new URL(path, `${origin}/`);
  if (scoped) url.searchParams.set("tenant", tenant);
  return url;
}

async function request(path, init = {}, scoped = true) {
  const response = await fetch(endpoint(path, scoped), init);
  checked(response.headers.get("Access-Control-Allow-Origin") === "*", `${path} CORS`);
  return response;
}

const healthResponse = await request("/healthz", {}, false);
checked(healthResponse.status === 200, "health status");
equal(await healthResponse.json(), {
  status: "ok",
  upstream: "v15.0.7",
  storage: "sqlite-durable-object",
}, "health body");

const versionResponse = await request("/api/v3/version");
checked(versionResponse.status === 200, "API3 version status");
const version = await versionResponse.json();
checked(version.result?.version === "15.0.7", "Nightscout version");
checked(version.result?.apiVersion === "3.0.3-alpha", "API3 version");

const statusV1Response = await request("/api/v1/status.json");
const statusV2Response = await request("/api/v2/status.json");
checked(statusV1Response.status === 200 && statusV2Response.status === 200, "v1/v2 status");
const statusV1 = await statusV1Response.json();
const statusV2 = await statusV2Response.json();
equal(statusV1.settings, statusV2.settings, "v1/v2 settings parity");
equal(statusV1.extendedSettings, statusV2.extendedSettings, "v1/v2 extended settings parity");
checked(
  statusV1.extendedSettings?.dbsize?.max === 1_000_000_000 / (1024 * 1024),
  "Workers Free database quota mapping",
);

for (const [path, expected] of [
  ["/api/v1/entries.json?count=1", []],
  ["/api/v1/treatments.json?count=1", []],
  ["/api/v1/profile/current", null],
]) {
  const response = await request(path);
  checked(response.status === 200, `${path} status`);
  equal(await response.json(), expected, `${path} empty tenant`);
}

const pebbleResponse = await request("/pebble?count=2");
checked(pebbleResponse.status === 200, "Pebble status");
const pebble = await pebbleResponse.json();
checked(Array.isArray(pebble.status) && typeof pebble.status[0]?.now === "number", "Pebble clock");
equal(pebble.bgs, [], "Pebble empty-tenant SGVs");
equal(pebble.cals, [], "Pebble empty-tenant calibrations");

const ddataResponse = await request("/api/v2/ddata/at");
checked(ddataResponse.status === 200, "v2 ddata status");
const ddata = await ddataResponse.json();
checked(ddata.dbstats?.dataSize > 0, "SQLite databaseSize is published");
checked(ddata.dbstats?.indexSize === 0, "SQLite total is not double-counted");

const propertiesResponse = await request("/api/v2/properties/dbsize");
checked(propertiesResponse.status === 200, "dbsize property status");
const properties = await propertiesResponse.json();
checked(properties.dbsize?.details?.maxSize === 953.67, "dbsize MiB ceiling");
checked(properties.dbsize?.details?.dataSize > 0, "dbsize current bytes");
checked(properties.dbsize?.display === "0%", "dbsize display");
checked(properties.dbsize?.status === "current", "dbsize level");

const loopResponse = await request("/api/v2/properties/loop");
checked(loopResponse.status === 200, "disabled Loop property status");
equal(await loopResponse.json(), {}, "Loop remains opt-in");

const insulinCarbResponse = await request("/api/v2/properties/iob,cob");
checked(insulinCarbResponse.status === 200, "IOB/COB property status");
const insulinCarbProperties = await insulinCarbResponse.json();

const openApsPumpResponse = await request("/api/v2/properties/openaps,pump");
checked(openApsPumpResponse.status === 200, "OpenAPS/Pump property status");
const openApsPumpProperties = await openApsPumpResponse.json();

const ageResponse = await request("/api/v2/properties/cage,sage,iage,timeago");
checked(ageResponse.status === 200, "age property status");
const ageProperties = await ageResponse.json();
const basalResponse = await request("/api/v2/properties/basal");
checked(basalResponse.status === 200, "basal property status");
const basalProperties = await basalResponse.json();
const enabledPlugins = Array.isArray(statusV1.settings?.enable)
  ? statusV1.settings.enable
  : [];
checked(enabledPlugins.includes("basal"), "basal remains default-enabled");
equal(basalProperties, {}, "basal does not fabricate a property without a Profile");
checked(!enabledPlugins.includes("treatmentnotify"), "treatmentnotify remains opt-in by default");
for (const plugin of ["iob", "cob"]) {
  checked(
    Object.hasOwn(insulinCarbProperties, plugin) === enabledPlugins.includes(plugin),
    `${plugin} enabled gate`,
  );
}
for (const plugin of ["openaps", "pump"]) {
  checked(
    Object.hasOwn(openApsPumpProperties, plugin) === enabledPlugins.includes(plugin),
    `${plugin} enabled gate`,
  );
}
for (const plugin of ["cage", "sage", "iage"]) {
  checked(
    Object.hasOwn(ageProperties, plugin) === enabledPlugins.includes(plugin),
    `${plugin} enabled gate`,
  );
}
checked(!Object.hasOwn(ageProperties, "timeago"), "timeago remains a client/notification plugin");

const summaryResponse = await request("/api/v2/summary");
checked(summaryResponse.status === 200, "v2 summary status");
const summary = await summaryResponse.json();
checked(Array.isArray(summary.sgvs) && summary.sgvs.length === 0, "empty summary SGVs");
checked(summary.profile && Object.keys(summary.profile).length === 0, "empty summary profile");
checked(summary.state?.iob === null, "disabled IOB remains null in summary");
checked(summary.state?.cob === null, "disabled COB remains null in summary");

const api3Unauthorized = await request("/api/v3/entries");
checked(api3Unauthorized.status === 401, "API3 missing JWT");

const treatmentWrite = await request("/api/v1/treatments", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    eventType: "Note",
    notes: "NSCF public deployment smoke only",
    created_at: new Date().toISOString(),
  }),
});
checked(
  treatmentWrite.status === 401 || treatmentWrite.status === 503,
  "anonymous mutation fails closed with or without a configured API_SECRET",
);
const treatmentError = await treatmentWrite.json();
checked(
  treatmentWrite.status === 503
    ? treatmentError.error?.code === "api_secret_not_configured"
    : treatmentError.message === "Unauthorized",
  "anonymous mutation exposes the matching failure-closed response",
);
const treatmentRead = await request("/api/v1/treatments.json?count=1");
equal(await treatmentRead.json(), [], "failed write did not persist");

const eioResponse = await request("/socket.io/?EIO=4&transport=polling");
checked(eioResponse.status === 200, "EIO4 handshake status");
const eioText = await eioResponse.text();
checked(eioText.startsWith("0"), "EIO4 open packet");
const eio = JSON.parse(eioText.slice(1));
checked(/^[A-Za-z0-9_-]{20}$/.test(eio.sid), "EIO4 SID");
equal([eio.pingInterval, eio.pingTimeout], [25_000, 20_000], "EIO4 heartbeat");

process.stdout.write(`${JSON.stringify({
  origin,
  tenant,
  assertions,
  databaseBytes: ddata.dbstats.dataSize,
  dbsize: properties.dbsize,
  eio: {
    sidLength: eio.sid.length,
    pingInterval: eio.pingInterval,
    pingTimeout: eio.pingTimeout,
  },
})}\n`);
