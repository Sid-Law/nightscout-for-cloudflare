# NSCF architecture

Last audited: 2026-07-18

This document distinguishes the adapter that exists today from the target
architecture required for a complete Nightscout v15.0.7 port. The current
system is a compatible subset, not a full server.

## Current request and data flow

```text
Official Nightscout v15.0.7 pages and browser bundle / compatible uploader
        |
        | static HTML/CSS/JS, v1/v2 page API, transport polling
        v
Cloudflare Worker (nscf-phase1) + Workers Static Assets
  - official upstream pages/assets/Swagger specifications
  - API_SECRET, subject access-token and signed-JWT authorization
  - bounded parsing, upstream query subset and tenant routing
  - Socket.IO client-surface polling adapter
        |
        | ENTRY_STORE.getByName(tenant), typed RPC
        v
EntryStore Durable Object (one logical instance per tenant)
        |
        | synchronous SQL API
        v
Embedded SQLite
  - narrow SGV entries table
  - unique server id / upstream-style date+type dedupe
  - descending date index
  - generic documents table keyed by collection + id
  - food, profile, treatments, devicestatus, activity, roles and subjects
  - per-collection sort and lookup indexes
  - tenant-local JWT signing material
  - local schema migration table
```

Workers Static Assets serves EJS-rendered upstream index, Admin Tools, Profile
Editor, Food Editor, Reporting, Split/multiframe and clock views; the official
Webpack bundle, Swagger UIs/specifications, `static/**`, `translations/**`, and
the upstream service worker are copied from the locked release. Dynamic clock
face names are inserted into the upstream clock template at request time. NSCF
contains no alternative page, chart, component, CSS theme, plugin
implementation, translation, or medical calculation.

Nightscout's Express server supplies UTF-8 in response headers, while the
upstream homepage itself has no `<meta charset>`. Cloudflare Static Assets
normalizes stored HTML and JavaScript media types without that charset. Text
asset paths therefore run through the Worker first; it streams the unchanged
asset response and appends `charset=utf-8` to text, JavaScript, JSON, XML and SVG
media types. Binary assets continue to use the direct Static Assets path. This
is a platform response-header adaptation, not a source or UI fork.

The official client expects Socket.IO and consumes a `dataUpdate` runtime shape
rather than loading entries directly. At `/socket.io/socket.io.js`, a thin
transport adapter implements only the page-used `connect`, `authorize`,
`subscribe`, `loadRetro`, and `dataUpdate` surface. It polls
`/api/v2/ddata/at` every 15 seconds, receives SGVs, treatments, food, profiles
and device status in one aggregate response, and hands control to the untouched
upstream client/chart/plugin code. This replaces the long-lived Node Socket.IO
server for the current subset; it is not a Socket.IO or Engine.IO server.
The adapter dispatches the first `dataUpdate` before completing `authorize`, as
the upstream `lib/server/websocket.js` path does, so profile-dependent plugins
can initialize from the first payload.

The official v15.0.7 service worker uses a cache-first list that includes
`/socket.io/socket.io.js`. A cache key derived only from the upstream release
would therefore retain an earlier Cloudflare adapter even after the adapter
changed. The build layer hashes the adapter bytes, adds that hash to the
generated script URL and service-worker registration URL, disables HTTP-cache
reuse for service-worker updates, and removes the unversioned adapter from the
precache list. This is transport/cache adaptation only; upstream UI and medical
logic remain unchanged. The content-addressed script URL also bypasses an
already-active old worker on the first refreshed page, without asking the user
to clear browser storage.

Before an API-secret write can reach storage, the Worker requires `API_SECRET`
to be present as a Cloudflare environment binding and at least 12 characters
long. It hashes the configured raw passphrase with SHA-1 and SHA-512 through
Web Crypto and compares the supplied `api-secret` header (or `secret` query
parameter) with the hexadecimal digests. Each comparison first hashes both
inputs to a fixed 32-byte value; it uses the runtime's native
`timingSafeEqual` when available and a fixed-length XOR fallback otherwise.
Raw passphrases on the request wire are rejected. Missing configuration fails
closed. Admin-created subjects, roles, permissions and random access tokens are
stored in the same tenant's SQLite documents table; authorized subject tokens
may be used according to their persisted permissions.

`/api/v2/authorization/request/<accessToken>` now signs an upstream-shaped
HS256 JWT whose payload contains `accessToken`, `iat` and `exp`, with the
official eight-hour default lifetime. A random 256-bit signing key is stored in
the tenant's private `tenant_secrets` SQLite table, so signatures survive DO
eviction while remaining isolated between tenants. Verification uses Workers
Web Crypto; after signature and expiry validation, every request re-reads the
subject and roles, so deletion or permission changes immediately affect an
existing JWT. Permission checks use the same `shiro-trie` 0.4.10 resolved by
the locked upstream release, including suffix, wildcard and comma semantics.
Token-bearing authorization paths are redacted from unhandled-error logs.

This remains a partial authorization port. The current subject access token is
a stored random value rather than the upstream API-secret/ObjectId-derived
format, and body-carried credentials, historical prefix matching and the
per-source-IP failure delay list are not yet implemented. Current GET routes
remain public except API v3 `/status`, which follows the upstream Bearer-JWT
requirement.

The Worker is otherwise stateless. An optional `tenant` query parameter is
validated and passed to `ENTRY_STORE.getByName()`. The default is `demo`. A
deterministic name always routes one tenant to the same strongly
consistent DO; different names route to separate DO instances and separate
SQLite databases. This is isolation by storage shard, not authentication.

`EntryStore` uses RPC rather than an internal HTTP hop. JSON strings cross the
RPC boundary to avoid recursive generic values unsupported by the generated
Cloudflare RPC types. Its constructor uses `blockConcurrencyWhile()` only for
idempotent schema setup. Critical data is written synchronously before
returning. The upstream v15.0.7 rule of one SGV per normalized timestamp/type
is represented by a unique dedupe key; client UUIDs are preserved as
`identifier`, while valid 24-hex IDs may be retained as `_id`. Generic document
records store bounded JSON plus normalized sort/create/update timestamps.

## Target complete-port architecture

```text
Official Nightscout v15.0.7 browser code and compatible clients
        |
        | HTTP / Engine.IO polling / WebSocket
        v
Cloudflare Worker request adapter + Workers Static Assets
  - official immutable pages, bundle, translations and Swagger
  - upstream-compatible routing, content negotiation and errors
  - API_SECRET/JWT verification and tenant resolution
        |
        | typed RPC or WebSocket upgrade
        v
Tenant Durable Object
  - SQLite collection compatibility layer
  - mutation transaction + persisted change event
  - Engine.IO/Socket.IO sessions and namespaces
  - hibernatable WebSockets and polling queues
  - one persisted alarm scheduler for tick/prune/plugin work
        |
        +--> official server data/plugin modules through a platform context
```

The Worker remains stateless. Every request that reads or changes tenant state
is routed with `ENTRY_STORE.getByName(tenant)`. The DO is the coordination atom
for that tenant: it serializes mutations, owns SQLite, accepts hibernatable
WebSockets and multiplexes scheduled tasks through its one alarm.

This shape follows Cloudflare's current platform model:

- [SQLite-backed Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
  provides private, strongly consistent storage per object.
- [WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
  lets connections remain attached while the object is evicted; authoritative
  subscription/session data must therefore be reconstructible.
- [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
  are at-least-once and only one alarm is scheduled per object, so a task table
  must hold every due tick, prune and plugin job.
- [Workers Static Assets routing](https://developers.cloudflare.com/workers/static-assets/binding/)
  keeps binary assets on the fast path while API and text-header adaptations
  run Worker-first.

## Runtime adapter boundaries

### Node and Express

Workers now supports Node HTTP server APIs and an Express adapter, so Express is
not itself a blocker. The incompatible part of
`vendor/nightscout/lib/server/server.js` is the permanent process lifecycle:
one Mongo connection pool, one in-memory event bus, one timer set and one
Socket.IO server. Reuse decisions are made router-by-router; NSCF will not boot
the whole process and pretend its global state is durable.

The same distinction applies to `node:fs`: Workers' virtual file system can
read bundled files, but runtime host paths and mutable local persistence are not
portable. UI files and translations therefore remain deterministic build
artifacts.

### Mongo collection compatibility

The finished adapter must expose collection behavior rather than merely store
JSON. Required behavior includes:

- ObjectId/UUID identity normalization and immutable identifiers;
- collection-specific unique indexes and fallback dedupe;
- nested queries, type conversion, projections, ordering and limits;
- insert/replace/update/upsert/delete result shapes;
- API v3 `srvCreated`, `srvModified`, tombstones and history;
- atomic mutation plus a persisted real-time change event.

SQLite tables and indexes may differ internally from MongoDB, but observable
Nightscout behavior must be fixed by upstream-derived contract tests.

### Real-time transport

`platform/socket-io-polling-shim.js` currently creates browser-side `connect`,
`authorize`, `subscribe`, `loadRetro` and `dataUpdate` events and polls every
15 seconds. It deliberately does not implement:

- Engine.IO handshake, ping/pong, session IDs or polling queues;
- WebSocket upgrade and reconnect;
- Socket.IO acknowledgements, rooms or namespaces;
- `dbAdd`, `dbUpdate`, `dbUpdateUnset` and `dbRemove`;
- `/storage` and `/alarm` namespaces;
- immediate write broadcasts.

The target transport persists a change record in the same DO turn as each
mutation, then broadcasts only after the write succeeds. Hibernated sessions
restore their tenant, namespace, authorization and subscription information
from WebSocket attachments and SQLite.

### Background work and server plugins

The upstream heartbeat (`lib/bus.js`) and plugin engines use process timers.
The target adapter stores jobs with `kind`, `due_at`, retry state and an
idempotency key. The alarm loads all due jobs, invokes the official server
module through a tenant-scoped platform context, records results, and schedules
the next due time.

Official plugin formulas and medical calculations are not rewritten. A
build-time registry lists the locked server plugins so bundling is deterministic;
platform code supplies storage, time, settings, notifications and logging.
External bridge/push integrations remain disabled in the simulated-data scope.

## Why no D1 or R2

D1 would centralize cross-tenant relational queries, but NSCF needs the
opposite property: strongly consistent per-tenant state with the smallest
possible operational footprint. Each DO already contains SQLite, so D1 would
duplicate storage and add an unnecessary resource.

R2 is intended for objects and large blobs. SGV records are small structured
rows and need range ordering and uniqueness. Official browser files are served
by Workers Static Assets, so R2 is also unnecessary for the UI.

Queues, KV and custom domains are intentionally absent from `wrangler.jsonc`.

## Runtime and safety boundaries

- Maximum request body: 512 KiB; maximum POST batch: 100 records.
- SGV range accepted by this prototype: integer 20–600 mg/dL.
- History count defaults to 10 and is capped at 10,000.
- Official UI and calculations are not changed; no NSCF dosing logic exists.
- `API_SECRET` is the bootstrap application credential; subject access tokens
  and role documents are tenant-local SQLite records. The API_SECRET value is a
  Cloudflare binding, never a committed Wrangler variable; the current lab uses
  a plain-text dashboard variable at the owner's request.
- The polling shim is transport-only, runs every 15 seconds and has no medical or
  display logic.
- Text asset responses are streamed rather than buffered when UTF-8 headers are
  adapted, keeping the extra Worker CPU and memory work constant.
