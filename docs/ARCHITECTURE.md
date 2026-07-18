# NSCF architecture

Last audited: 2026-07-18

This document distinguishes the adapter that exists today from the target
architecture required for a complete Nightscout v15.0.7 port. The current
system is a compatible subset, not a full server.

“Current” below describes deployed code candidate
`d8e406d13b87b2e304b1db4dc075af18ae463022`. Deployment ran from repository
HEAD `ac0947dc6139d16e424cc212e3757dde0c7c088b` and produced Cloudflare version
`65db0a2f-9f4e-4c41-8edf-de85bb49c31d`, active at 100% traffic since
2026-07-18T15:13:42.775Z. Its 18-file Workers-runtime suite passes 215/215.
Wrangler processed 248 unchanged official asset entries, reported 764.00 KiB
raw / 135.65 KiB gzip, and declared only the `ENTRY_STORE` Durable Object and
`ASSETS` bindings. Cloudflare reported a 20 ms startup. These are release
facts for the named subset, not evidence of a complete port.

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
  - strict `/socket.io/` EIO4 polling and direct-WebSocket adapters
        |
        | ENTRY_STORE.getByName(tenant), typed RPC
        v
EntryStore Durable Object (one logical instance per tenant)
        |
        | synchronous SQL API
        v
Embedded SQLite
  - narrow Entries compatibility shadow (fresh-only pre-1.0 reset policy)
  - generic documents table keyed by collection + id, including canonical Entries
  - indexed Entries date/dateString/type fields and upstream-style identity
  - food, profile, treatments, devicestatus, activity, roles and subjects
  - per-collection sort and lookup indexes
  - tenant-local JWT signing material
  - persisted EIO4 sessions and bounded outbound packet queues
  - hibernatable WebSocket attachments backed by persisted session authority
  - persisted authorization-failure delays
  - one SQL-derived Durable Object alarm for realtime/auth deadlines
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

Separately, exact `/socket.io` and `/socket.io/` requests can now reach real
tenant-local Engine.IO 4 polling and direct-WebSocket endpoints. Polling
implements the official open
shape with `upgrades: []`, 25-second server ping / 20-second client-pong
heartbeat, RS payload framing, SIO5 root CONNECT, `clients`, read-only
`authorize`, initial `dataUpdate`, and `loadRetro`. Sessions, root authorization
and ordered outbound frames are stored in the existing tenant `EntryStore`
SQLite database, while only an in-flight long-poll waiter is ephemeral. DO
eviction therefore does not lose protocol authority or queued packets. This
endpoint is independently tested but is not loaded by the official homepage;
the built `/socket.io/socket.io.js` remains the REST shim described above.
Direct WebSocket opens with `EIO=4&transport=websocket`, is accepted by the DO
through WebSocket Hibernation, and restores its tenant/SID authority from a
validated attachment plus SQLite state after eviction. It is not an Engine.IO
upgrade from an existing polling SID: polling continues to advertise no
upgrade.
Server ping, pong timeout, session expiry and abandoned poll/POST lease
deadlines, bounded WebSocket close retries and stale authorization-failure
cleanup are multiplexed through the DO's single persistent alarm. The handler
is transactional and idempotent under at-least-once delivery;
process-lifetime timers are not authoritative.

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
`timingSafeEqual` for the comparison.
Raw passphrases on the request wire are rejected. Missing configuration fails
closed. Admin-created subjects, roles, permissions and derived access-token
metadata are stored in the same tenant's SQLite documents table; authorized
subject tokens may be used according to their persisted permissions.

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

The deployed adapter derives each subject access token from the
API-secret/ObjectId contract, preserves the locked suffix/digest-prefix lookup,
and implements the independent secret/token extraction order across query,
header and the first request-body object. Explicit failures are recorded per
source IP in SQLite, delay subsequent checks, and are cleaned through the same
DO alarm. Locked v15.0.7 sends repeated/bracket `secret` arrays into
`enclave.isApiKey().toLowerCase()`, producing an unhandled asynchronous
rejection rather than a normal response. NSCF deliberately hardens that edge:
an array can never grant admin, its bounded values are tried as ordered subject
credentials, and an invalid/oversized array returns 401 and records the
failure. Two other differences remain named: the Workers request boundary caps
the actually enforced delay at 60 seconds, and a failed attempt does not yet
emit the upstream admin notification. Most current GET routes remain public. API v3
`/status`, `/lastModified` and all entries, treatments and device-status routes
accept only a verified Bearer JWT; API secrets and query tokens are not API v3
credentials.

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

The v1/v2 Status adapter is a deliberately narrow Express-contract boundary.
It handles the locked txt/json/js/png/svg forms, extensionless Accept
negotiation, redirects, v2 inheritance, GET-to-HEAD behavior, method fallthrough
and final 404/406 production shapes before the Worker's general API/CORS path.
The response body's `authorized` field is independently derived only from query
`token` and then query `secret`, including Express-style repeated/bracket array
values; an Authorization header does not populate that field. Local
Workers-runtime tests lock representation bytes and lengths. A real local
Wrangler check confirmed fixed `Content-Length` for the production 406, while
the platform HTTP boundary may still transfer the HTML finalhandler 404 as
chunked; that transport-level P2 remains a post-deploy smoke item.

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

The first three generic vertical slices—entries, treatments and device status—are now
implemented in the tenant `EntryStore` Durable Object. Internal SQL schema
version 4 extends `documents`
with `identifier`, `identifier_present`, `srv_created`, `srv_modified`,
`is_valid`, `fallback_key`, `revision` and `srv_metadata_version`; adds
`collection_clocks` and `document_changes`; and adds non-unique lookup/history
indexes. The nullable `srv_*` metadata mirrors fields actually persisted in the
body. It is not an upload-time surrogate for legacy documents.
`identifier_present` preserves the Mongo distinction between a missing field
and an explicitly stored `null` or empty string. API v3 fallback dedupe may
therefore require a genuinely absent identifier without conflating those
three states. `identifier` and each collection's fallback identity are
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

Entries adds indexed canonical documents plus a narrow compatibility shadow.
The v6 activation probe is deliberately fresh-only: when it finds an
incompatible pre-1.0 `entries` table, it drops and recreates only that shadow
instead of guessing how to import the earlier simulated schema. It does not
drop canonical documents, profiles or any other collection. Compatible healthy
activation performs a read-only structural/index probe, so ordinary DO
eviction does not repeat schema writes. The public lab was checked before this
deployment and contained zero Entries and one profile; post-deployment reads
confirmed both counts. This specific reset therefore had no old simulated
Entry row to lose and preserved the profile without recording its contents,
but the policy is not a general legacy Nightscout migration guarantee.
Deployment to the existing public Worker activates this schema in place and
retains canonical/profile data. A new family's planned fresh path starts with a
new Worker/SQLite DO namespace or empty tenant; an ordinary code deployment
does not replace or clear an existing namespace. Correct NSCF-internal schema
activation remains mandatory even though external Mongo history import is
deferred.

V1 Entries preserves the locked four-day default date window and keeps
`dateString` as a distinct string field rather than folding it into numeric
`date`. Realtime/ddata loading uses a separate two-day canonical-document
window. Indexed date/type searches stay in SQLite. A `dateString` scan or other
unindexed candidate set that would cross 10,000 rows fails closed with HTTP
413; synchronous delete and per-document revision cleanup are capped at 128.
These are explicit Free-plan controls rather than claims that SQLite and Mongo
have identical unbounded behavior.

Treatments and device status now share an internal SQLite repository and DO RPC
boundary for:

- lookup by server `_id`, client `identifier`, or collection fallback
  (`created_at + eventType` for treatments and `created_at + device` for device
  status);
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

PUT/PATCH deliberately use the locked `identifyingFilter()` distinction rather
than the broader READ/DELETE lookup: a 24-hex `_id` fallback may mutate only a
legacy row whose `identifier` field is genuinely absent. A modern API3 row
cannot be updated through its internal storage ID. This differs from READ and
DELETE, whose upstream `filterForOne()` still permits that ObjectId fallback.

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

### API v3 entries, treatments and device-status boundary

The HTTP adapter now exposes exactly the eight locked generic routes for each
of entries, treatments and device status: GET/POST on the collection, GET on both
history forms, and GET/PUT/PATCH/DELETE on an identifier. GET
`/api/v3/lastModified` reports all three collections independently when the
subject can read it. Unmatched API v3 routes use the locked `{status,message}`
404 envelope rather than falling into the older adapter error shape.

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

The read boundary uses the same locked renderer dependencies as Nightscout:
`accepts@1.3.8`/`negotiator@0.6.3` select JSON, CSV or XML in Express order;
`csv-stringify@5.6.5` and `easyxml@2.0.1` produce the response bytes. JSON keeps
the `{status:200,result}` envelope while CSV/XML return raw bodies and all
negotiated responses set `Vary: Accept`. Serializer failures preserve the
already-selected media type just as Express does. The upstream `mime` 2.6.0
extension middleware is preserved separately: an unknown extension is rejected
after JSON parsing but before routing/authentication, while a known MIME
extension is stripped and may reach a write handler (whose upstream response is
JSON). The resolved MIME type, rather than the literal suffix, drives reads, so
aliases such as `.map` and case variants such as `.JSON` use JSON. A known but
unsupported read format reaches authentication/querying and then returns 406.

Other deliberate or unresolved platform differences are explicit:

- JSON bodies are bounded at 512 KiB rather than upstream's 50 MiB;
- top-level JSON primitives return the stable treatments 400 envelope, while
  locked `body-parser` passes them into the upstream 500 error middleware;
- multiple operators for the same field preserve the locked object-overwrite
  behavior: the later query item replaces the earlier operator object, and the
  server's `isValid != false` condition replaces any caller `isValid` filter;
- a parsed API v3 limit of zero (for example, from `limit=0x10`) is capped at
  1,000 rows; locked Mongo treats `cursor.limit(0)` as unlimited;
- API v3 `$re` accepts only a bounded, case-sensitive, linear subset compiled
  to SQLite `GLOB`; unsupported constructs, patterns above 128 UTF-8 bytes or a
  compiled GLOB above SQLite's 50-byte limit return controlled 400;
- unsafe JSON-path field syntax and queries beyond SQLite binding/statement
  limits return controlled 400 responses;
- non-negative `skip` values through JavaScript's maximum safe integer reach
  SQLite; larger parsed offsets return controlled 400 rather than an unsafe
  integer binding;
- SQLite/Mongo comparison and ordering across mixed JSON types, nested
  projection behavior and array semantics are not yet claimed compatible;
- entries, treatments and device status are represented by API v3
  `lastModified`; food, profile and settings remain unimplemented there.

The locked history projection quirk is retained: when `fields` excludes
`srvModified`, the response body excludes it and Last-Modified/ETag are derived
from the always-projected collection `created_at` fallback. Legacy documents
can be read with virtual srv fields but do not match raw srv filters or HISTORY.
These are three generic collection vertical slices, not completion of API v3 or
of any whole upstream `api3.*` test file. CSV/XML currently serialize an entire
bounded result in memory; large-result CPU and 128 MB memory adaptation remains
open even though byte-level small/medium contracts are green.

### SQLite limits and change-retention risk

Repository queries enforce the current Durable Objects SQLite limits of 100
bound parameters per query and a 50-byte final `LIKE`/`GLOB` pattern; final SQL
statement size is also checked against exactly 100,000 bytes. These checks use
final binding counts and UTF-8 bytes, including JSON paths, sort expressions,
limit and offset. See [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/).
These bounds do not prove Mongo-compatible mixed-type comparison or sort
collation; that differential matrix remains open.

The current Free-plan SQLite allowances include 5,000,000 rows read and 100,000
rows written per day, plus 5 GB of SQLite data across the account; exhausted
daily categories fail until their UTC reset. Index maintenance counts toward
row writes, and each `setAlarm()` call is billed as one row written. See
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
and direct Hibernatable WebSocket with persisted session/queue state, root
namespace CONNECT, read-only authorization ACKs, initial/retro data and
connection-count broadcasts.

The current server boundary is explicit:

- EIO4 polling and direct WebSocket only; an Engine.IO upgrade from an existing
  polling SID, EIO3 HTTP and binary packets are rejected, and the polling
  handshake advertises `upgrades: []`; an exact
  `application/octet-stream` POST closes its leased SID and receives a
  controlled 400/code-3 response;
- 256 sessions per tenant, 128 queued packets and a 1,000,000-byte whole
  polling payload per session; incoming POST bodies are counted while streamed;
- 32-session opportunity cleanup on normal requests plus a persistent alarm
  derived from the earliest ping, pong, expiry, poll or POST deadline;
- direct-WebSocket queue delivery is currently at-most-once across an isolate
  crash: a failure between durable dequeue and `server.send()` can lose that
  frame. Closing this P2 requires an acknowledgement/replay contract;
- `/storage` and `/alarm` return SIO5 `CONNECT_ERROR` and do not terminate an
  already connected root namespace;
- root `subscribe` and all write events have no handler or ACK, matching the
  locked root's lack of `subscribe` while deliberately exposing no mutation;
- no `document_changes` row is consumed and no database mutation is broadcast.

Every realtime or authorization-delay state transition recomputes the single
persisted alarm from SQL.
The handler cleans all due sessions/leases, enqueues due pings, handles queue
overflow and broadcasts the surviving client count inside one synchronous
SQLite transaction, then schedules the next derived deadline. Repeated delivery
does not duplicate pings or deletions because `pong_deadline` and row removal
are durable idempotency state. WebSocket closure tombstones and authorization
failure rows add their own due times to the same derived minimum. API3 pruning
and server-plugin jobs still need a shared persisted task table before using
the same one-alarm slot.

Initial authorization data mirrors `dataWithRecentStatuses()`. `loadRetro`
uses a separate unfiltered device-status view over the same one-day raw SQL
window. Initial filtering then keeps the newest 10 rows per device/type, so a
fixed 100-row cutoff no longer hides a group when budget remains. Snapshot
cursors share a deterministic 900,000-byte, 8,000-node, 2,000-document budget
plus a 24-level per-document depth cap; collection priority is profiles, device
status, SGVs, treatments, then food. Reaching that budget still retains only a
deterministic time-descending cursor prefix and may omit older groups. Websocket
status preserves the locked key set/order, with fixed platform assumptions for
API/careportal/boluscalc enablement and no active profile. `authorize` and
`loadRetro` require exactly one object payload; this is a resource/safety
tightening over permissive upstream JavaScript call shapes.

Both polling and direct Hibernatable WebSocket are live in Cloudflare version
`65db0a2f-9f4e-4c41-8edf-de85bb49c31d`. Remote polling smoke completed EIO4
open, SIO5 root CONNECT, `clients`, read-only `authorize`, `dataUpdate` and ACK.
Direct WebSocket completed open, CONNECT, `clients`, connected authorization,
`dataUpdate` and ACK. The polling open retained `upgrades: []`, a 25-second
ping interval, 20-second timeout and 1,000,000-byte maximum. The at-most-once
dequeue/send crash window described above remains open. The official homepage
intentionally still uses the REST polling shim, so these transport smokes prove
the separate server slice rather than a page transport switch. The named
polling HTTP edge difference is admission at the
1,000,000-byte boundary for malformed UTF-8: NSCF counts streamed raw bytes,
while locked Node can count the replacement-decoded text differently.

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
- EIO4 polling/direct-WebSocket payload controls: 1,000,000-byte advertised
  polling maximum, 128 queued packets and 256 persisted sessions per tenant.
- SGV range accepted by this prototype: integer 20–600 mg/dL.
- History count defaults to 10 and is capped at 10,000.
- Entries unindexed/dateString candidates are capped at 10,000 with controlled
  HTTP 413; synchronous deletion and stored-revision cleanup are capped at 128.
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
