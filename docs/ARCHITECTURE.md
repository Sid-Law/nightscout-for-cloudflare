# NSCF architecture

Last audited: 2026-07-18

This document distinguishes the adapter that exists today from the target
architecture required for a complete Nightscout v15.0.7 port. The current
system is a compatible subset, not a full server.

## Current request and data flow

```text
Official Nightscout v15.0.7 pages and browser bundle / compatible uploader
        |
        | static HTML/CSS/JS, v1/v2 page API, REST shim polling
        | or independent EIO4 polling clients
        v
Cloudflare Worker (nscf-phase1) + Workers Static Assets
  - official upstream pages/assets/Swagger specifications
  - API_SECRET, subject access-token and signed-JWT authorization
  - bounded parsing, upstream query subset and tenant routing
  - Socket.IO client-surface polling adapter
  - strict `/socket.io/` EIO4 polling HTTP adapter
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
  - persisted EIO4 sessions and bounded outbound packet queues
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

Separately, exact `/socket.io` and `/socket.io/` requests can now reach a real
tenant-local Engine.IO 4 polling endpoint. It implements the official open
shape with `upgrades: []`, 25-second server ping / 20-second client-pong
heartbeat, RS payload framing, SIO5 root CONNECT, `clients`, read-only
`authorize`, initial `dataUpdate`, and `loadRetro`. Sessions, root authorization
and ordered outbound frames are stored in the existing tenant `EntryStore`
SQLite database, while only an in-flight long-poll waiter is ephemeral. DO
eviction therefore does not lose protocol authority or queued packets. This
endpoint is independently tested but is not loaded by the official homepage;
the built `/socket.io/socket.io.js` remains the REST shim described above.

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
per-source-IP failure delay list are not yet implemented. Most current GET
routes remain public. API v3 `/status`, `/lastModified` and all treatments
routes accept only a verified Bearer JWT; API secrets and query tokens are not
API v3 credentials.

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

The first treatments-focused vertical slice is now implemented in the tenant
`EntryStore` Durable Object. Internal SQL schema version 4 extends `documents`
with `identifier`, `identifier_present`, `srv_created`, `srv_modified`,
`is_valid`, `fallback_key`, `revision` and `srv_metadata_version`; adds
`collection_clocks` and `document_changes`; and adds non-unique lookup/history
indexes. The nullable `srv_*` metadata mirrors fields actually persisted in the
body. It is not an upload-time surrogate for legacy documents.
`identifier_present` preserves the Mongo distinction between a missing field
and an explicitly stored `null` or empty string. API v3 fallback dedupe may
therefore require a genuinely absent identifier without conflating those
three states. `identifier` and the treatments fallback identity are
deliberately **not** unique because the locked Mongo adapter only creates
ordinary indexes and resolves legacy duplicates at lookup time.

The v4 migration runs in `DurableObjectStorage.transactionSync()`. It leaves the
legacy `body` and `_id` untouched, derives indexed metadata and snapshots each
old document once. The migration record, metadata backfill and new tables
commit together. Every activation checks structural completeness even when
marker 4 exists, so an older v4 installation receives `identifier_present`,
nullable change timestamps and the srv-metadata marker safely. Old hidden
upload-time values are rebuilt from the preserved body; a legacy body without
srv fields therefore migrates to SQL `NULL`. Existing clock high-water marks
are retained conservatively, but a legacy-only migration does not invent one.
Complete rows and existing change revisions are not replayed. The regression
fixture reconstructs the exact six-column v3 `documents` DDL with no v4 tables
or indexes, migrates it, then repeats activation to prove idempotence. A
separate older-v4 fixture proves structural repair with marker 4 already
present and recomputes legacy offset-bearing fallback keys without rewriting
their preserved bodies.

Treatments now have an internal SQLite repository and DO RPC boundary for:

- lookup by server `_id`, client `identifier`, or `created_at + eventType`;
- v1 treatments upsert selector priority (`identifier`, then `_id`, then
  `created_at + eventType`) after the locked `prepareData` time normalization,
  numeric coercion and cleanup, plus API v3 create dedupe against genuinely
  identifier-absent legacy documents;
- create/upsert, replace, patch, soft delete and permanent delete;
- strictly increasing API v3 server modification-time allocation persisted
  across eviction; v1 writes do not advance that clock. Observable
  last-modified is recalculated from current documents and falls back after
  permanent deletion. The strict monotonic allocator is a platform enhancement
  over locked upstream's direct `Date.now()` assignment, which can collide;
- ascending, field-projected history with tombstones;
- live v1 treatments filtering in SQL before sort/limit rather than loading
  5,000 documents first. Scalar equality/comparison, `$in` and `$exists` are
  pushed down with the locked four-day default window and `created_at` order.
  Regex, nested and unsupported operator forms return a stable HTTP 400 rather
  than being approximated or silently truncated.

Legacy and API v3 policies are separate. API v1 mutations store and return the
locked legacy body (including normalized `created_at`, `utcOffset`, and removed
`eventTime`), accept UUID/identifier/fallback PUT identity, and do not
synthesize `srvCreated`/`srvModified`; they also do not hide `isValid:false` or
enforce API v3 read-only rules. API v3 repository methods
materialize server metadata, hide tombstones in ordinary reads, enforce the 11
locked immutable fields and preserve the identifier-only dedupe and tombstone
resurrection exceptions. API v3 READ and unfiltered SEARCH virtually resolve a
legacy document's missing `srvCreated`/`srvModified` from `created_at` only
after SQL filtering, exactly as locked `resolveDates()` does. Such a document
therefore does not match an srv-field SEARCH and is not in HISTORY. API v3
materialization also maps a missing/falsy identifier to the server ID and
removes Mongo `_id`. `/api/v2/ddata` consumes the same legacy treatment shape
as v1.

The locked v1 two-document `preBolus` carb fan-out is not implemented in this
slice. Until that operation can be atomic, the adapter deliberately retains
carbs on the original treatment instead of applying only the destructive half
of upstream `prepareData`.

Every create, replace, patch and soft delete writes its current document and a
`document_changes` snapshot in one synchronous storage transaction. Generic
API v3 history is a current-collection view: it reads current documents with a
real persisted numeric `srvModified`, orders them ascending and includes soft
delete tombstones. It does not use audit timestamps or virtual `created_at`
fallbacks. Permanent deletion removes the document and its snapshots together,
matching upstream history behavior for `permanent=true`.

### API v3 treatments JSON boundary

The HTTP adapter now exposes exactly the eight locked treatments routes: GET
and POST on `/api/v3/treatments`; GET on both history forms; and GET, PUT,
PATCH and DELETE on an identifier. GET `/api/v3/lastModified` reports the
treatments collection when the subject can read it. Unmatched API v3 routes use
the locked `{status,message}` 404 envelope rather than falling into the older
adapter error shape.

The public request still accepts only one `sort` or `sort$desc` value. Internally
it preserves the locked ordered chain—requested field, `identifier`,
`created_at`, then `date`—instead of collapsing it into an object or SQL
expression. Repeated query values retain Express/JavaScript key coercion, so
two `sort` parameters select the comma-containing field name. Nested and
unknown safe field names are passed to SQLite JSON paths. A final server-ID
tie-break makes otherwise equal SQLite results deterministic; upstream Mongo
does not promise that additional tie-break.

POST dedupe and PUT conditional-upsert choose create versus update permission
inside the same `transactionSync()` that performs candidate lookup and the
write. PATCH permission, existence, tombstone, precondition, immutable/common
validation and actor injection follow the locked order in that transaction.
Soft delete stores `modifiedBy`; permanent delete removes current and change
rows. Mutation and change-row failure rolls back the document, history and
monotonic clock together.

Only the JSON renderer is implemented in this vertical slice. CSV and XML
requests return controlled 406 responses until locked `csv-stringify` and
`easyxml` byte-level fixtures are ported. The upstream `mime` 2.6.0 extension
middleware is preserved separately: an unknown extension is rejected after
JSON parsing but before routing/authentication, while a known MIME extension is
stripped and may reach a write handler (whose upstream response is JSON). A
known but unsupported read format reaches authentication/querying and then
returns 406.

Other deliberate or unresolved platform differences are explicit:

- JSON bodies are bounded at 512 KiB rather than upstream's 50 MiB;
- API v3 `$re` is rejected with 400 instead of silently approximating Mongo
  regular expressions with SQLite `LIKE`;
- unsafe JSON-path field syntax and queries beyond SQLite binding/statement
  limits return controlled 400 responses;
- SQLite/Mongo comparison and ordering across mixed JSON types, nested
  projection behavior and array semantics are not yet claimed compatible;
- only treatments is represented by API v3 `lastModified`; the other five
  generic collections remain unimplemented.

The locked history projection quirk is retained: when `fields` excludes
`srvModified`, the response body excludes it and Last-Modified/ETag are derived
from the always-projected treatments `created_at` fallback. Legacy documents
can be read with virtual srv fields but do not match raw srv filters or HISTORY.
This is a treatments JSON vertical slice, not completion of generic API v3 or
of any whole upstream `api3.*` test file.

### SQLite limits and change-retention risk

Repository queries enforce the current Durable Objects SQLite limits of 100
bound parameters per query and a 50-byte final `LIKE`/`GLOB` pattern; final SQL
statement size is also checked against exactly 100,000 bytes. These checks use
final binding counts and UTF-8 bytes, including JSON paths, sort expressions,
limit and offset. See [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/).
These bounds do not prove Mongo-compatible mixed-type comparison or sort
collation; that differential matrix remains open.

The current Free-plan allowances include 100,000 Durable Object requests,
5,000,000 SQL rows read and 100,000 SQL rows written per day, plus 5 GB of
SQLite data across the account; exhausted daily categories fail until their
UTC reset. Index maintenance also counts toward row writes. See
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).
The idempotent activation repair and clock seeding still scan current document
metadata, so frequent eviction can consume rows-read allowance even when no
row needs repair and the guarded clock upsert performs no write.

`document_changes` currently retains a complete JSON body for migration,
atomic audit evidence and every create, replace, patch and soft delete. API v3
HISTORY reads current documents rather than this journal. Full-body snapshots
still create unbounded write/storage amplification proportional to body size
times revision count, with additional index cost. There is no history retention
or pruning policy yet; only permanent deletion removes all snapshots for that
document. This slice must therefore
not be described as suitable for indefinite Free-plan retention until a
locked-compatible history cursor and pruning policy are defined and tested.

The selected resolution stays inside the fixed SQLite-DO footprint: this table
will become a bounded, short-lived real-time delivery outbox rather than a
second permanent history store. API v3 HISTORY continues to use the current
documents/tombstones required by upstream. Before any transport consumes the
outbox, the adapter must add per-tenant age/count bounds, an acknowledged
cursor, alarm-driven pruning and a reconnect fallback that reloads current
state when a cursor has expired. This policy is a design decision, not current
runtime behavior; the present unbounded snapshots remain a known limitation.
R2 is not required for this transient coordination data and is outside the
fixed deployment footprint.

### Real-time transport

`platform/socket-io-polling-shim.js` currently creates browser-side `connect`,
`authorize`, `subscribe`, `loadRetro` and `dataUpdate` events and polls every
15 seconds. It still supplies the official page and does not use the new
server endpoint. The separate endpoint now implements strict EIO4 HTTP polling
with persisted session/queue state, root namespace CONNECT, read-only
authorization ACKs, initial/retro data and connection-count broadcasts.

The current server boundary is explicit:

- EIO4 polling only; EIO3 HTTP, WebSocket upgrades and binary packets are
  rejected, and the handshake advertises `upgrades: []`;
- 256 sessions per tenant, 128 queued packets and a 1,000,000-byte whole
  polling payload per session; incoming POST bodies are counted while streamed;
- 32-session opportunity cleanup on normal requests, with no new alarm;
- `/storage` and `/alarm` return SIO5 `CONNECT_ERROR` and do not terminate an
  already connected root namespace;
- root `subscribe` and all write events have no handler or ACK, matching the
  locked root's lack of `subscribe` while deliberately exposing no mutation;
- no `document_changes` row is consumed and no database mutation is broadcast.

Initial authorization data mirrors `dataWithRecentStatuses()`. `loadRetro`
correctly uses a separate unfiltered device-status loader, but the current SQL
adapter loads at most 100 statuses rather than the locked one-day `lastData`
window. Websocket status preserves the locked key set/order, with fixed
platform assumptions for API/careportal/boluscalc enablement and no active
profile. `authorize` and `loadRetro` require exactly one object payload; this is
a resource/safety tightening over permissive upstream JavaScript call shapes.

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
Live external bridge/push delivery remains disabled in the simulated-data
scope; mocked internal mapping, validation, deduplication, cancellation and
multi-key contracts remain required.

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
- EIO4 polling POST body/advertised payload: 1,000,000 UTF-8 bytes; maximum 128
  queued packets and 256 persisted sessions per tenant.
- SGV range accepted by this prototype: integer 20–600 mg/dL.
- History count defaults to 10 and is capped at 10,000.
- Official UI and calculations are not changed; no NSCF dosing logic exists.
- `API_SECRET` is the bootstrap application credential; subject access tokens
  and role documents are tenant-local SQLite records. The API_SECRET value is a
  Cloudflare binding, never a committed Wrangler variable; the current lab uses
  a plain-text dashboard variable at the owner's request.
- The homepage polling shim is transport-only, runs every 15 seconds and has no
  medical or display logic. The separately routed EIO4 server is read-only and
  is not yet the homepage transport.
- Text asset responses are streamed rather than buffered when UTF-8 headers are
  adapted, keeping the extra Worker CPU and memory work constant.
