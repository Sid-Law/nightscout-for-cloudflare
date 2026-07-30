# Engine.IO / Socket.IO protocol core

Last audited: 2026-07-30

Status: tenant-routed, SQLite-backed Engine.IO 3/4 and Socket.IO 4/5
compatibility layer for Nightscout v15.0.7. It supports XHR and JSONP polling,
direct hibernatable WebSockets, polling-to-WebSocket upgrades, persisted
sessions and outbound queues, root authorization and database mutation events,
`dataUpdate` / `retroUpdate`, and the API v3 `/storage` and `/alarm`
namespaces.

Binary Engine.IO packets and Socket.IO binary attachments are not implemented.

For the complete current architecture, see
[Architecture — Real-time transport](ARCHITECTURE.md#real-time-transport).
This document focuses on protocol framing, persistence and resource limits.

## Supported stacks

| Role | Engine.IO | Socket.IO parser | Polling framing | Heartbeat | Runtime status |
| --- | ---: | ---: | --- | --- | --- |
| Locked official Nightscout v15.0.7 path | 4 | 5 | XHR/JSONP; raw RS (`0x1e`) between packets | server ping, client pong | Polling, direct WebSocket and polling upgrade |
| Legacy compatibility (`allowEIO3`) | 3 | 4 | XHR/JSONP; `<UTF-16 length>:<packet>` | client ping, server pong | Polling, direct WebSocket and polling upgrade |

`negotiateProtocolStack()` accepts only an exact `EIO=3` or `EIO=4` value and
binds it to the matching complete stack. Missing, coerced, and unknown versions
are rejected. Raw public codec and type names are always versioned:

- the official path uses `encodeEngineIoV4*`, `EngineIoV4*`, and
  `encodeSocketIoV5*` APIs;
- the legacy path is available only through explicit `encodeEngineIoV3*`,
  `EngineIoV3*`, and `encodeSocketIoV4*` APIs;
- the generic `*ForStack` dispatchers require a negotiated stack argument.

The former ambiguous `SOCKET_IO_PROTOCOL` and unversioned EIO3 barrel exports
do not exist. Public constants are `SOCKET_IO_V4_PROTOCOL` and
`SOCKET_IO_V5_PROTOCOL`; runtime and compile-only barrel contract tests prevent
the legacy names from being reintroduced. This makes EIO4/SIO5 the visible
Nightscout default and prevents accidental selection of EIO3/SIO4.

## Locked evidence

The source baseline is Nightscout v15.0.7 /
`7e0e77f88fc113a76fe363504125f5b36b8a3fe3`:

- `vendor/nightscout/views/index.html` loads `/socket.io/socket.io.js`. The
  installed `socket.io/client-dist/socket.io.js` banner identifies Socket.IO
  4.5.4, sets the Engine.IO protocol to 4, writes that value to the `EIO`
  transport query, and declares Socket.IO parser protocol 5.
- `vendor/nightscout/lib/server/websocket.js` enables polling and WebSocket and
  sets `allowEIO3: true`. That flag is the legacy compatibility path; it does
  not make EIO3 the official browser default.
- `vendor/nightscout/package-lock.json` resolves server `socket.io` 4.5.4,
  `engine.io` 6.2.1, `engine.io-parser` 5.0.7, and `socket.io-parser` 4.2.5.
  The separately declared `socket.io-client ^4.5.4` currently resolves to
  4.8.3, so the upstream websocket test also uses EIO4/SIO5 but must not be
  mislabeled as the official 4.5.4 static browser bundle.
- `engine.io-parser` 5.0.7 joins and splits EIO4 polling frames with raw ASCII
  Record Separator. Engine.IO 6.2.1 sends the EIO4 ping from the server and
  expects the client's pong.
- `socket.io-parser` 4.2.5 encodes non-binary data as packet type, optional
  namespace plus comma, optional decimal ack id, then `JSON.stringify(data)`.
  Socket.IO 4.5.4 sends an EIO4 namespace CONNECT reply with `{ "sid": ... }`;
  only its EIO3 branch sends the legacy payload-free reply.
- `vendor/nightscout/tests/websocket.shape-handling.test.js` supplies event and
  acknowledgement shape evidence and does not force EIO3.

The exact reference package bytes were measured locally from those locked
dependencies. The production core has no runtime dependency on them and uses
Web-standard APIs only.

## Official EIO4 / SIO5 wire contract

The initial polling exchange is directional; open and client CONNECT are not
pretended to be one server payload:

1. server polling GET response: `0{"sid":"engine123",...}`;
2. client polling POST: `40` (root SIO5 CONNECT without auth);
3. server polling GET response: `40{"sid":"socket123"}`;
4. later server heartbeat payload: `2`;
5. client heartbeat POST: `3`.

Multiple packets sent in the same direction use a raw `\x1e` separator. JSON
stringification escapes a U+001E inside event data as the six printable
characters `\\u001e`, so it cannot become a polling delimiter. Raw RS in an
arbitrary Engine.IO packet is rejected to preserve a one-to-one packet round
trip and prevent separator injection.

## Tenant-routed transports and namespaces

Exact `/socket.io` and `/socket.io/` requests resolve the explicit/default
tenant and address the existing tenant `EntryStore` Durable Object. EIO3 and
EIO4 both support XHR and JSONP polling, direct WebSocket connections and the
locked polling-to-WebSocket upgrade. Polling handshakes advertise
`upgrades:["websocket"]`; a direct WebSocket handshake advertises no further
upgrade. The handshake fixes `pingInterval=25000`, `pingTimeout=20000`, and
`maxPayload=1000000`. Polling GET returns `text/plain; charset=UTF-8`;
successful polling POST returns locked `text/html` / `ok`. Unknown SID/query
errors, overlapping GET/POST leases, oversized bodies, malformed protocol close
behavior and tenant crossing have Workers-runtime tests.

Only the exact `Content-Type: application/octet-stream` value selects the
unsupported binary path. It closes the leased SID and returns the adapter's
controlled JSON 400/code-3 response; every other content type is decoded as
text, matching the locked Engine.IO branch selection. Malformed UTF-8 uses
replacement decoding, then enters the normal parser: the tested malformed
packet is ACKed with HTTP 200 and closes its SID. Near the 1,000,000-byte edge,
parity between raw-body admission and replacement-expanded text accounting is a
controlled P2 follow-up; the adapter always enforces the raw streamed byte cap
before decoding.

SQLite schema v5 introduced the Engine.IO SID, current Socket.IO SID, root
connection and authorization flags, heartbeat deadlines, GET/POST leases,
queue counters and ordered outbound packets. Later idempotent migrations add
write authorization, WebSocket upgrade and hibernation state, `/storage`,
`/alarm`, the persisted root delta baseline, JSONP state and background-task
deadlines. The only memory-only polling item is the resolver for a currently
waiting GET. Eviction tests prove that sessions, namespace subscriptions and
queued output resume in a reconstructed Durable Object. One SQL-derived Durable
Object alarm coordinates realtime, authorization-delay and task deadlines.

The root namespace preserves the locked Nightscout behavior:

- root CONNECT reply precedes the locked `clients` event; disconnect and
  queue-overflow/transport closure correct the remaining client count;
- `authorize` emits `connected`, optional initial `dataUpdate`, then an ACK;
  the ACK preserves `read`, `write` and `write_treatment`;
- invalid authorization emits root DISCONNECT without ACK while keeping the
  Engine.IO transport available for namespace reconnect;
- `dbAdd`, `dbUpdate`, `dbUpdateUnset` and `dbRemove` validate collection,
  authorization, identity and bounded payloads, return the locked ACK shape and
  publish a resulting root `dataUpdate`;
- `loadRetro` ACKs before `retroUpdate`, or emits only `retroUpdate` if there is
  no ACK id;
- root `subscribe` intentionally has no listener or ACK, matching the locked
  upstream namespace.

The API v3 `/storage` namespace persists authorized collection subscriptions
and emits API3-shaped mutation events after successful v1, v2 or v3 writes. The
`/alarm` namespace persists subscription and ACK/snooze authority and provides
the trusted live notification outlet. Both namespaces work over polling and
WebSocket and survive Durable Object eviction.

Initial data matches locked `dataWithRecentStatuses()` field order and recent
device-status filtering. The EntryStore cursor-walks the same one-day raw
device-status window for both paths: initial data keeps the most recent 10 rows
per device/type and `loadRetro` returns the raw runtime-normalized window. This
avoids the former blind 100-row SQL limit, which could omit an entire device
group even when the response budget had room. This is not an all-groups
guarantee: the shared resource ceiling below can still deterministically stop
the time-descending cursor before older groups. The websocket status object has
the locked field set/order; fixed API/careportal enabled and boluscalc disabled
remain named platform assumptions. When present, the latest eligible Profile
Switch supplies `status.activeProfile`. Requiring exactly one object argument
for `authorize` and `loadRetro` is a deliberate safety/resource tightening.

Initial and retro loaders share deterministic resource accounting while their
SQLite cursors are consumed; they do not materialize the 1,000-entry,
1,000-treatment, or 5,000-food query ceilings before applying the budget.
Initial truncation priority is profiles, device status, SGVs, treatments, then
food. The snapshot ceiling is 900,000 serialized UTF-8 bytes, 8,000 JSON nodes,
2,000 documents, and 24 levels inside any stored document. These values leave
headroom for the Socket.IO wrapper, optional status object, ACK, and the codec's
10,000-node/1,000,000-byte packet boundary.

`src/protocol/engine-io-v4.ts` provides:

- open, close, ping, pong, message, upgrade, and noop packet codecs;
- RS-framed HTTP polling payload codecs;
- a required EIO4 handshake shape containing `sid`, `upgrades`,
  `pingInterval`, `pingTimeout`, and `maxPayload`;
- an explicit server-ping/client-pong heartbeat descriptor.

`src/protocol/socket-io-v5.ts` provides non-binary CONNECT, DISCONNECT, EVENT,
ACK, CONNECT_ERROR, namespace, and ack-id codecs. Client CONNECT auth and the
server `{ "sid": ... }` reply are both represented; the server helper makes
the sid-bearing reply explicit.

Binary Engine.IO frames and Socket.IO binary event/ack attachment sequences
are rejected. Supporting them requires a separate attachment state machine and
aggregate byte accounting.

## JSON compatibility boundary

The SIO5 encoder deliberately follows the locked parser's native
`JSON.stringify` behavior:

- `Date` becomes its ISO string;
- deterministic `toJSON()` is honored;
- `NaN` and infinities become `null`;
- `undefined` in an array becomes `null`;
- an object property whose value is `undefined` is omitted;
- bigint, circular graphs, and binary values are rejected with stable protocol
  errors.

A bounded parser-style prewalk detects ArrayBuffer/view/Blob binary values
before `toJSON()` can disguise them. The native stringify traversal then
applies explicit depth, node, string, aggregate, and final-frame character
budgets, and the normalized JSON is parsed and shape-validated before the frame
is returned. `JSON.rawJSON()` values are rejected because their contents bypass
replacer traversal. Because binary attachment handling is not implemented,
`toJSON()` must be deterministic and return non-binary data; its call count is
not an application API. This boundary produces the same non-binary broadcast
bytes as the official parser without accepting an unbounded object graph.

The legacy SIO4 codec retains its stricter pre-existing JSON-value boundary.
It is not the codec to use for official Nightscout browser broadcasts.

## Resource limits and rejection rules

These are project codec defaults, not Cloudflare platform quotas:

| Boundary | Default |
| --- | ---: |
| Polling payload | 1,000,000 UTF-8 bytes |
| Individual Engine.IO or Socket.IO packet | 1,000,000 UTF-8 bytes |
| Packet text | 1,000,000 UTF-16 code units |
| Packets per polling payload | 128 |
| EIO3 length-prefix digits | 10 |
| Namespace | 256 UTF-16 code units |
| Session id | 128 UTF-16 code units |
| JSON nesting | 32 levels |
| JSON traversal | 10,000 nodes |
| Individual JSON string/key | 262,144 UTF-16 code units |
| Initial/retro data body | 900,000 serialized UTF-8 bytes |
| Initial/retro data traversal | 8,000 JSON nodes |
| Initial/retro stored documents | 2,000 documents |
| Individual stored-document nesting | 24 levels |

Decoders reject empty or malformed payload segments, truncated EIO3 frames,
unknown packet types, raw/binary frames outside the supported subset, invalid
namespace delimiters, unsafe ack ids, malformed JSON, reserved event names,
wrong payload shapes, and excessive size/depth/complexity.

The routed HTTP adapter checks `Content-Length` when present and always streams/
counts the body before decoding, so it never obtains an already-unbounded
`request.text()` value. Runtime caps add 256 sessions per tenant, 128 queued
packets per session, a 1,000,000-byte whole framed queue, the snapshot limits
above, and cleanup batches of 32. Cloudflare's current Workers memory limit
remains 128 MB per isolate.

## Deliberate limits

- Binary Engine.IO packets and Socket.IO binary event/ACK attachment sequences
  are rejected.
- Root `subscribe` intentionally has no handler or ACK, matching locked
  Nightscout v15.0.7 behavior.
- Session, queue, payload, JSON-depth and snapshot limits are bounded for the
  Cloudflare Workers runtime.
- Disconnected `/alarm` clients receive no replay; durable alarm state is ACK
  and snooze authority rather than a notification-history queue.
- Compatibility claims apply to the locked Nightscout v15.0.7 contracts and
  named tests. They do not imply support for arbitrary third-party Socket.IO
  extensions.
