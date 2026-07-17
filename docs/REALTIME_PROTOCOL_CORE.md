# Engine.IO 3 / Socket.IO protocol core

Status: protocol codec and contract tests only. This module is not connected to
`src/index.ts`, does not replace the polling shim, and does not implement a
session lifecycle, WebSocket upgrade, namespace membership, or broadcasts.

## Locked evidence

The implementation is based on the repository's immutable Nightscout
v15.0.7 / `7e0e77f88fc113a76fe363504125f5b36b8a3fe3` snapshot and the dependency
versions resolved by that snapshot:

- `vendor/nightscout/lib/server/websocket.js` creates Socket.IO with
  `allowEIO3: true` and enables both `polling` and `websocket` transports.
- `vendor/nightscout/lib/client/index.js` opens the root namespace and
  `/alarm` with `transports: ["polling"]`.
- `vendor/nightscout/package-lock.json` resolves server `socket.io` 4.5.4,
  `engine.io` 6.2.1, `engine.io-parser` 5.0.7, and `socket.io-parser` 4.2.5.
- Engine.IO 6.2.1 contains its own `build/parser-v3`, imported from the
  `engine.io-parser` 2.2.x branch. It defines protocol 3 packet codes and the
  HTTP polling format as `<packet string length>:<packet>`. The length is
  JavaScript string length (UTF-16 code units), not UTF-8 byte length.
- Engine.IO 6.2.1 selects that parser for `EIO=3`. Its v3 heartbeat branch
  expects the client to send an Engine.IO ping and the server to answer with a
  pong. This differs from the EIO4 heartbeat direction.
- Socket.IO 4.5.4 checks `conn.protocol === 3`: a successful namespace
  connection is encoded without the newer `{ "sid": ... }` Socket.IO connect
  payload, and namespace query parameters are taken from the namespace string.
- The compatible Socket.IO 2.5 client line uses `engine.io-client` 3.5.x,
  `engine.io-parser` 2.2.x and `socket.io-parser` 3.3.x (Socket.IO protocol 4).
  Its polling transport passes packet arrays to the EIO3 payload encoder, and
  event acknowledgements are decimal ids between namespace and JSON payload.
- `vendor/nightscout/tests/websocket.shape-handling.test.js` supplies the
  upstream event/ack usage evidence. The new local tests deliberately use only
  synthetic protocol values, not real health data or credentials.

The dependency sources were inspected at the exact versions above. No runtime
dependency on those Node packages was added; the Cloudflare-compatible core is
pure TypeScript and uses Web-standard APIs only.

## Module boundary

`src/protocol/engine-io-v3.ts` provides:

- Engine.IO packet encode/decode for open, close, ping, pong, message, upgrade,
  and noop packet types;
- EIO3 HTTP polling payload encode/decode with the v3 length-prefix format;
- typed handshake creation/validation for required `sid`, `upgrades`,
  `pingInterval`, and `pingTimeout` fields;
- optional `maxPayload`, because locked Engine.IO 6.2.1 includes it in the
  open packet even when serving an EIO3 connection.

`src/protocol/socket-io.ts` provides non-binary Socket.IO protocol-4
connect, disconnect, event, ack, and error packet encode/decode, including
custom namespaces, namespace query strings, ack ids, and JSON payloads. Wrapper
helpers explicitly place Socket.IO packets inside Engine.IO message packets.

Binary Engine.IO packets and Socket.IO binary event/ack attachment sequences
are rejected. They are outside this increment and cannot be safely accepted
without an attachment state machine and aggregate size accounting.

## Resource limits and rejection rules

All entry points apply `DEFAULT_PROTOCOL_LIMITS`, and tests can lower any limit
through an override. Defaults are:

| Boundary | Default |
| --- | ---: |
| Polling payload | 1,000,000 UTF-8 bytes |
| Individual Engine.IO or Socket.IO packet | 1,000,000 UTF-8 bytes |
| EIO3 packet length | 1,000,000 UTF-16 code units |
| Packets per polling payload | 128 |
| Length-prefix digits | 10 |
| Namespace | 256 UTF-16 code units |
| Session id | 128 UTF-16 code units |
| JSON nesting | 32 levels |
| JSON value graph | 10,000 nodes |
| Individual JSON string/key | 262,144 UTF-16 code units |

The decoder rejects empty packets, non-decimal or oversized polling length
headers, truncated frames, unknown packet types, missing custom-namespace comma
delimiters, unsafe ack ids, malformed JSON, reserved event names, wrong payload
shapes, excessive nesting/complexity, and binary frames. The encoder rejects
values that JSON would silently coerce or drop, including `undefined`,
non-finite numbers, bigint, accessors, class instances, symbols, and cycles.

These limits protect the future Worker/DO adapter in addition to Cloudflare's
outer request limits. Cloudflare's current Workers guidance requires a maximum
before consuming a body that will be buffered, because an isolate has a shared
128 MB memory limit. A future HTTP adapter must therefore check `Content-Length`
when present, stream/count when absent, and only then pass a bounded string to
this codec. The codec alone cannot make an already-unbounded `request.text()`
safe.

## Future tenant Durable Object integration (not implemented)

The tenant remains the coordination atom: resolve the tenant in the stateless
Worker and use one deterministic tenant DO. A later, separately reviewed
increment should add a dedicated session/queue schema rather than modifying the
existing `EntryStore` schema implicitly.

Suggested persisted records:

- Engine.IO session: `sid`, protocol version, transport, state, creation and
  expiry timestamps, heartbeat deadline, and monotonic inbound/outbound
  sequence numbers;
- outbound polling queue: `sid`, sequence, encoded packet, byte length, and
  expiry, with both per-session bytes and packet counts bounded;
- namespace membership: `sid`, namespace, authorization state, and any room
  membership required by the locked Nightscout server contract.

State-changing input should be validated, persisted, and assigned a sequence
before an acknowledgement or broadcast is queued. In-memory maps may cache
state but are not authoritative across eviction. Poll GET/POST handling needs
an explicit session state machine, single outstanding poll policy, retry and
expiry behavior, and tests for duplicate/reordered requests.

For WebSockets, use the Durable Objects Hibernation API, not `ws.accept()`:

1. create a `WebSocketPair` and call `this.ctx.acceptWebSocket(server)`;
2. store only a small bounded connection locator in `serializeAttachment`
   (for example `sid`, protocol version, and a storage key);
3. reconstruct live connection indexes from `this.ctx.getWebSockets()` and
   `deserializeAttachment()` after constructor re-entry;
4. keep durable session, queue, namespace, and authorization state in DO
   storage because attachments disappear when the WebSocket closes and are
   limited to 16,384 bytes;
5. handle Engine.IO data-frame heartbeat separately from WebSocket control
   ping/pong. Cloudflare handles WebSocket control frames automatically, but
   EIO3 uses text data packets `2` and `3`; upgrade probing also uses dynamic
   `2probe` / `3probe` packets;
6. prove hibernation with eviction tests before enabling an upgrade path.

Current Cloudflare references:

- <https://developers.cloudflare.com/durable-objects/best-practices/websockets/>
- <https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/>
- <https://developers.cloudflare.com/durable-objects/api/state/>
- <https://developers.cloudflare.com/workers/best-practices/workers-best-practices/>

This document is a handoff design, not a completion claim. Routing, HTTP body
handling, session persistence, polling concurrency, WebSocket Hibernation,
authorization, namespaces at runtime, and real-time broadcasts remain undone.
