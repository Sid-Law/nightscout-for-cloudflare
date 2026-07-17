# Engine.IO / Socket.IO protocol core

Status: protocol codecs, explicit version negotiation, and contract tests only.
Nothing in this module is connected to `src/index.ts`; it does not replace the
existing polling shim, modify `EntryStore`, implement a session lifecycle,
upgrade a connection, persist namespace membership, or broadcast live data.

## Supported stacks

| Role | Engine.IO | Socket.IO parser | Polling framing | Heartbeat |
| --- | ---: | ---: | --- | --- |
| Official Nightscout v15.0.7 browser path | 4 | 5 | raw RS (`0x1e`) between packets | server ping, client pong |
| Legacy compatibility (`allowEIO3`) | 3 | 4 | `<UTF-16 length>:<packet>` | client ping, server pong |

`negotiateProtocolStack()` accepts only an exact `EIO=3` or `EIO=4` value and
binds it to the matching complete stack. Missing, coerced, and unknown versions
are rejected. The former ambiguous `SOCKET_IO_PROTOCOL` export no longer
exists; the public constants are `SOCKET_IO_V4_PROTOCOL` and
`SOCKET_IO_V5_PROTOCOL`, and stack-aware dispatchers prevent a caller from
silently pairing EIO4 with the legacy Socket.IO codec.

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

Decoders reject empty or malformed payload segments, truncated EIO3 frames,
unknown packet types, raw/binary frames outside the supported subset, invalid
namespace delimiters, unsafe ack ids, malformed JSON, reserved event names,
wrong payload shapes, and excessive size/depth/complexity.

Cloudflare's current Workers limit is 128 MB memory per isolate. A future HTTP
adapter must therefore establish a body-size maximum before buffering, check
`Content-Length` when present, and stream/count when it is absent. Passing an
already-unbounded `request.text()` result into a bounded codec is not safe.

## Future tenant Durable Object integration (not implemented)

The tenant remains the coordination atom: a stateless Worker can resolve the
tenant and address one deterministic tenant Durable Object. A later increment
should add dedicated session and queue storage rather than modifying the
existing `EntryStore` schema implicitly.

Suggested authoritative records include:

- Engine.IO session: sid, negotiated stack, transport, state, timestamps,
  heartbeat deadline, and monotonic inbound/outbound sequence numbers;
- bounded outbound polling queue: sid, sequence, encoded packet, byte length,
  and expiry;
- namespace membership and authorization state keyed by sid and namespace.

For WebSockets, use the Durable Objects WebSocket Hibernation API:

1. create a `WebSocketPair` and call `this.ctx.acceptWebSocket(server)`;
2. put only a small connection locator in `serializeAttachment()` (for
   example sid, protocol version, and a SQLite storage key);
3. rebuild live indexes from `this.ctx.getWebSockets()` and
   `deserializeAttachment()` after constructor re-entry;
4. keep authoritative session, queue, namespace, and authorization state in
   Durable Object SQLite storage. Cloudflare's current documented maximum for
   a serialized attachment is **2,048 bytes**, and the attachment disappears
   when its WebSocket closes;
5. keep Engine.IO text-frame heartbeat separate from WebSocket control
   ping/pong and prove hibernation through eviction tests before enabling an
   upgrade path.

Cloudflare numerical facts above were rechecked on 2026-07-18 against:

- <https://developers.cloudflare.com/durable-objects/best-practices/websockets/#websocketserializeattachment>
- <https://developers.cloudflare.com/workers/platform/limits/#memory>

This remains a handoff design, not a lifecycle completion claim. Routing, HTTP
body handling, persisted sessions and queues, polling concurrency, WebSocket
Hibernation, runtime authorization and namespace membership, upgrades, and
real-time broadcasts are all still unimplemented.
