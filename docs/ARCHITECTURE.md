# NSCF architecture

Last audited: 2026-07-20

This document distinguishes the adapter that exists today from the target
architecture required for a complete Nightscout v15.0.7 port. The current
system is a compatible subset, not a full server.

“Current” below describes deployed adapter candidate
`c07d52fc68db976d20b1ced9d3f9d0088ab1a0a8` and Cloudflare version
`4f89e2fc-ac35-499b-ac39-ffbd61f18e66`, reported as 100% active. The
candidate's 41-file Workers-runtime suite
passes 472/472 plus 20/20 audit tests. Wrangler processed 248 unchanged official
asset entries; its dry run reported 1005.41 KiB raw / 183.59 KiB gzip and only
the `ENTRY_STORE` Durable Object and `ASSETS` product bindings. Version 50
reported a 23 ms startup and passed credential-free API, EIO4 and real-browser
gates.
These are release facts for the named subset, not
evidence of a complete port.

## Current request and data flow

```text
Official Nightscout v15.0.7 pages and browser bundle / compatible uploader
        |
        | static HTML/CSS/JS, v1/v2 page API, REST shim polling
        | or independent EIO4 polling/direct-WebSocket clients
        v
Cloudflare Worker (nscf-phase1) + Workers Static Assets
  - official upstream pages/assets/Swagger specifications
  - API_SECRET, subject access-token and signed-JWT authorization
  - bounded parsing, upstream query subset and tenant routing
  - v2 ddata/properties/summary stateless response adaptation
  - inherited v1/v2 notification ACK authorization and HTTP adaptation
  - Socket.IO client-surface polling adapter
  - strict `/socket.io/` EIO4 polling and direct-WebSocket adapters
  - SIO5 root plus API3 `/storage` and `/alarm` namespace protocol adaptation
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
  - persisted root `dataUpdate` baseline for server-originated deltas
  - persisted `/storage` namespace connections and collection subscriptions
  - persisted `/alarm` connections, shared HTTP/Socket ACK authority and snoozes
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
contains no alternative page, chart, component, CSS theme, translation or
downstream-invented medical calculation. The request-scoped summary processor
described below is ported from the locked upstream source.

Nightscout's Express server supplies UTF-8 in response headers, while the
upstream homepage itself has no `<meta charset>`. Cloudflare Static Assets
normalizes stored HTML and JavaScript media types without that charset. Text
asset paths therefore run through the Worker first; it streams the unchanged
asset response and appends `charset=utf-8` to text, JavaScript, JSON, XML and SVG
media types. Known secondary HTML routes are explicitly marked
`text/html; charset=utf-8`. Cloudflare initially classified the upstream Split
frame as `text/plain`; because Static Assets uses a content-hash ETag, changing
only the Worker MIME could leave an old representation behind a 304. The Split
route therefore removes incoming conditional validators before its internal
asset fetch, returns a 200 HTML representation and marks it `no-store`. Binary
assets continue to use the direct Static Assets path. These are platform
response/cache adaptations; the upstream HTML bytes and UI are unchanged.
The default cache and ETag behavior is documented in Cloudflare's
[Static Assets response headers](https://developers.cloudflare.com/workers/static-assets/headers/).

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

The same aggregate snapshot feeds the wider v2 REST adapters without introducing a
process-global `ctx.ddata`. `src/realtime/ddata-snapshot.ts` represents the
locked ddata singleton's empty buckets, clone, runtime normalization and
prefer-new merge operations as pure functions; tenant state remains inside the
SQLite Durable Object. `src/plugins/bgnow.ts`, `direction.ts`, `rawbg.ts` and
`upbat.ts`, supported by request-safe `runtime/{times,units,levels}.ts`, are
ports of their locked property modules. They build the same
four five-minute buckets around the last non-future SGV, preserve the
over-nine-minute interpolation rule and mmol rounding, expose the official
direction character/entity only for current data, reproduce raw calibration
and noise behavior, and analyze recent per-uploader battery minima/severity.
`src/plugins/properties.ts` executes them in locked server-plugin order and
respects `settings.enable`: `upbat` is enabled by default and `rawbg` stays
opt-in. `/api/v2/properties` applies those values plus the upstream comma
picker and truthy `pretty` serialization.

Property polling uses `getPluginPropertyContextJson()`, a bounded DO projection
of at most 64 SGVs, the newest calibration and recent device status. It avoids
materializing unrelated food, treatment and profile collections. Cloudflare
can route a newly deployed Worker to an older still-live DO isolate during a
rolling release. The first plugin deployment exposed this when the old isolate
did not implement the new RPC. `loadPluginPropertyContext()` catches only that
precise missing-method error and temporarily uses the already-deployed
`getDdataSnapshotJson()` RPC; all storage and parse failures still propagate.
Once the DO isolate updates, requests automatically return to the small
projection.
`src/api2/summary.ts` is a direct stateless port
of the locked SGV/treatment/profile and basal-data processors. It receives one
bounded snapshot and a request clock, so it neither shares request state nor
creates timers. Unadapted server-plugin properties are intentionally not
synthesized: IOB/COB/BWP become JSON `null` and summary age/battery fields are
omitted until the remaining official registry and tenant execution context are
available.

Separately, exact `/socket.io` and `/socket.io/` requests can now reach real
tenant-local Engine.IO 4 polling and direct-WebSocket endpoints. Polling
implements the official open
shape with `upgrades: []`, 25-second server ping / 20-second client-pong
heartbeat, RS payload framing, SIO5 root CONNECT, `clients`, read-only
`authorize`, initial and subsequent server-originated `dataUpdate`, and
`loadRetro`. Sessions, root authorization
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

`src/realtime/calcdelta.ts` ports the locked `lib/data/calcdelta.js` comparison
semantics without keeping Node process state. Schema v11 stores one complete
tenant baseline in `realtime_root_state`. After successful implemented v1/v2
or HTTP API3 changes, the DO loads the current database snapshot, calculates
SGV/MBG/calibration/device-status replacement fields, treatment
add/update/remove actions and profile replacement, advances the baseline and
queues a non-empty root `dataUpdate` only for connected, authorized,
read-allowed live sessions. API3 queues its root frame and `/storage` frames in
the document mutation transaction; legacy paths publish in a follow-up DO
transaction. Existing polling and Hibernatable-WebSocket flush paths deliver
the same durable queue. Food and activity still advance the baseline but emit
no delta because the locked calculator exposes neither field. Upstream
profile-switch status injection and server-plugin preprocessing before the
comparison remain unadapted.

Schema v12 extends each persisted root session with `write_allowed` and
`treatment_write_allowed`. A successful `authorize` therefore retains all
three upstream authority branches across Durable Object reconstruction and
Hibernatable-WebSocket eviction. The main namespace accepts the locked
`dbAdd`, `dbUpdate`, `dbUpdateUnset` and `dbRemove` events for treatments,
entries, device status, profile, food and activity. Collection validation and
permission checks retain upstream error order; the acknowledged mutation runs
through the shared repository, and a changed snapshot queues the later root
`dataUpdate` only after the ACK packet. Treatment exact/plus-or-minus-two-second
dedupe, device-status dedupe, AAPS Profile replacement, custom string `_id`,
dotted set/unset and prototype-safe field traversal are named contracts. A
100-document event cap, document-depth/size limits and string-ID bounds are
Free-plan controls; unrestricted Mongo/BSON numeric, object and mixed-type ID
semantics remain outside this slice.

The same transports expose the API v3 `/storage` namespace independently of
the root namespace. A `subscribe` event resolves only the subject access token,
checks the locked collection read permission (Settings requires admin), and
stores granted rooms in SQLite. Successful HTTP API3 creates/upserts/PUTs/
PATCHes/deletes enqueue the official SIO5 `create`, `update` or `delete` frame
for each current subscriber inside the document mutation transaction. A failed
or saturated subscriber is removed without rolling back the document. V1 and
direct repository mutations do not emit this channel, matching upstream.
The transports also expose `/alarm` independently. A truthy native
`accessToken` branch has priority and accepts a valid subject without requiring
notification roles, matching the locked listener behavior. The web branch
accepts the API secret, JWT or current anonymous default and returns separate
read/ACK authority. Connection and accumulated ACK authority persist in SQLite.
A trusted internal RPC accepts only an already-computed notification object,
classifies it as `clear_alarm`, `alarm`, `urgent_alarm`, `announcement` or
`notification`, and broadcasts it live to every current tenant-local `/alarm`
connection; no disconnected replay is stored. Authorized `ack` events persist
the group/level snooze, mirror Urgent to Warning and broadcast the exact
all-clear object. The official v1 `/notifications/ack` route and its inherited
v2 mount use the same SQLite transaction and live broadcast path, require
`notifications:*:ack`, and return Express's exact `200 OK` text body. The
adapter bounds state to 256 distinct group names of at most 256 characters. It
does not yet run `lib/notifications.js` or server plugins, so ACK compatibility
is not notification-generation readiness.
Server ping, pong timeout, session expiry and abandoned poll/POST lease
deadlines, bounded WebSocket close retries and stale authorization-failure
cleanup are multiplexed through the DO's single persistent alarm. The handler
is transactional and idempotent under at-least-once delivery. A still-future
earlier prompt is retained, while a stale past platform alarm is replaced so
queued delivery cannot clear the only remaining SQL wakeup;
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
emit the upstream admin notification. Most current GET routes remain public.
API v3 `/status`, `/lastModified` and all entries, treatments, device-status,
profile, food and settings routes accept only a verified Bearer JWT; API
secrets and query tokens are not API v3 credentials.

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
is represented by a unique dedupe key; every non-ObjectId uploader `_id` is
preserved as `identifier` when the supplied identifier is falsy, while valid
24-hex IDs may be retained as `_id`. Generic document
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

V1/v2 Entries now has its own bounded Worker boundary. The Worker extracts the
locked lowercase extension forms, negotiates JSON/plain/CSV/TSV, compiles the
supported query fields/operators and request sort, then calls typed `EntryStore`
RPC. Extended URL-encoded bodies use maintained `qs` with the locked
body-parser depth/parameter/array shape; legal queries above SQLite's
binding/statement budget return a controlled client error. SQLite applies the
requested sort and limit first; the response formatter
then reorders only that selected set by `mills`/`date` descending, preserving
the locked upstream quirk. JSON and the three text representations share
result-derived Last-Modified, weak Express-style ETags, IMS/INM freshness and
HEAD metadata. Exact base `/entries` first checks the latest bounded runtime
SGV, matching upstream `ifModifiedSinceCTX`; that time remains the fallback
Last-Modified header when the requested result is empty.
Cloudflare can remove a dynamic response's `Content-Length` at the public HTTP
boundary even though Workers-runtime responses retain it, the same transport
P2 already recorded for Status.

The inherited `/count/:storage/where` utility has a separate execution path.
The Worker parses the bounded find subset, selects entries, treatments or
device status with the locked unknown-storage fallback, then asks the tenant DO
for SQL `COUNT(*)`. Only the integer crosses RPC, so a long indexed range does
not allocate the matching document bodies and is not subject to the ordinary
10,000-row response limit. Zero matches serialize as `[]`; nonzero matches use
Mongo's `[{"_id":null,"count":N}]` group shape. Count/sort result options are
ignored as upstream does, while client-supplied aggregation pipelines are
rejected rather than translated into executable SQL. The bounded Entries
`echo` adapter renders the supported Mongo query shape plus input/params/storage
debug envelope without reflecting Cloudflare tenant or credential parameters.
`times/echo`, `times` and `slice` expand the locked numeric-brace fixtures into
at most 256 linear patterns and eight literal dateString prefixes. Each prefix
becomes an indexed SQLite range read capped at 10,000 candidates; merged results
are deduplicated and time-sorted before the requested count is applied.
Arbitrary JavaScript regex syntax, other slice storage/field combinations and
non-Entries echo remain outside this slice.

Entries upload and preview share one recursive sanitizer before normalization
or persistence. The locked server uses DOMPurify with JSDOM; neither DOM runtime
is available at this Worker boundary. NSCF therefore entity-encodes HTML-like
and entity-bearing nonnumeric Entry strings while preserving existing named/
numeric entities to make read-then-reupload idempotent. Legacy Treatment POST
uses a separate safe-tag serializer: active blocks are removed, reviewed tags
are lowercased and retained, and every attribute is stripped. It matches the
locked malicious IMG fixture but is deliberately stricter than DOMPurify for
otherwise-safe attributes, so general byte-equivalent output remains open.
Persistent batches cross the RPC boundary as validated values. Each item runs
in its own synchronous SQLite transaction that atomically updates the canonical
document, narrow Entries shadow and change snapshot. A conflict rolls back that
item, retains the already committed ordered prefix, and prevents the suffix
from running, matching `bulkWrite({ordered:true})` rather than request-wide
atomicity.

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

The runtime adapter represented by candidate
`c07d52fc68db976d20b1ced9d3f9d0088ab1a0a8` implements all six official generic
vertical slices—entries, treatments, device status, profile, food and
settings—in the tenant
`EntryStore` Durable Object. Internal SQL schema version 4 extends `documents`
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

Profile uses the locked API v3 `created_at`-only fallback identity. V1 Profile
create/save/delete now pass through the same repository, so API v3 and the
official Profile Editor observe one row identity and one atomic change history.
Activation backfills older Profile rows without rewriting their JSON bodies and
records the migration snapshot once across repeated Durable Object eviction.
The locked `{startDate:-1,_id:-1}` current-Profile order is shared by v1
`/profile/current`, Status settings and the realtime dataloader; the latter
returns one Profile just like upstream `ctx.profile.last()`.

`src/profile-functions.ts` ports the official Profile calculation surface used
by the API v2 Summary path. It retains legacy on-the-fly conversion, store and
historical-record selection, active Profile switches, DIA, carbohydrate
absorption/ratio, insulin sensitivity, low/high targets, basal schedules,
units, IANA-timezone lookup, Circadian Percentage Profile coercion and
temp/combo-basal helpers. Node-specific lodash, memory-cache and
moment-timezone mechanics become native arrays, an instance-local five-second
`Map` cache and `Intl.DateTimeFormat`; keeping the previous-temp-basal pointer
inside the instance prevents cross-tenant isolate state. The complete 24-case
locked `profile.test.js` file is represented by Workers-runtime tests. This
foundation does not imply that every plugin consuming Profile data is ported.

Food uses the locked API v3 `created_at`-only fallback identity. V1 Food create
forces a new server `created_at` like upstream, while save preserves an existing
value or supplies one when absent; both now use the generic repository so v1
and API v3 observe the same `_id`, metadata and change history. Activation
repairs older Food metadata, fallback keys and missing migration snapshots once
without rewriting preserved JSON bodies, and repeated activation/DO eviction is
idempotent.

The v1 collection boundary deliberately translates legacy Mongo/Express
contracts rather than leaking SQLite internals. The shared ID helper accepts
missing, `null` and 24-hex ObjectId values, rejects UUID and numeric values, and
reports the first invalid item with the locked 400 JSON envelope. Activity,
Food, Profile, DeviceStatus and Treatments accept an empty POST array as a
successful empty result; Food also accepts an empty PUT array and creates on a
missing-ID PUT. DeviceStatus converts offset-bearing `created_at` to UTC ISO,
stores `utcOffset`, and combines wildcard deletion with any other supplied
filters. On v1/v2 create, its document adapter clones the request and truncates
only IOB/COB/UAM/ZT arrays beneath `openaps.suggested.predBGs` and
`openaps.enacted.predBGs`: 288 values by default, a configured positive
`PREDICTIONS_MAX_SIZE`, or no prediction trimming when the value is `0`.
Existing body/document size caps still apply. Its upstream module has no
generic PUT route, so the adapter no longer exposes one. Activity, Food and
Profile deletes return the locked empty object
instead of a storage-engine mutation count. Named Workers-runtime contracts
cover the complete locked Activity, DeviceStatus, Food, Profile, ID-validation,
ObjectId-validation, cross-collection shape, deduplication, Entries UUID and
partial-failure test files. Entries uniqueness remains `sysTime` plus `type`;
Treatments use `identifier`/`_id` first and then `created_at` plus `eventType`.
The adapter does not turn descriptive fixture fields such as `pump`, `sync` or
generic `id` into unique indexes that upstream never created.

Treatment identity is controlled by the same locked `UUID_HANDLING` flag as
Nightscout v15.0.7. Missing, non-string and values other than case-insensitive
`on`/`true`/`off`/`false` use the upstream default `true`; whitespace is not
trimmed. When enabled, every non-ObjectId string `_id` is removed from the
replacement and copied to a missing/falsy `identifier`, while GET/DELETE by a
valid UUID searches both `identifier` and a pre-fix raw UUID storage ID. PUT
prefers `identifier`, then the matching raw legacy ID, then
`created_at + eventType`, so issue-6923 rows update in place. When disabled,
the invalid `_id` is still stripped but is not promoted, identifier upserts do
not fall back to raw IDs, and UUID GET/DELETE addresses only a genuinely raw
storage ID. Treatment delete responses use MongoDB 5.9's
`{acknowledged:true,deletedCount:N}` shape rather than the older
`{n:N,ok:1}` result.

The Loop ObjectId cache contract remains client-driven. A successful Treatment
POST returns a server-owned 24-hex `_id` in the same order as the uploaded
batch; later PUT and DELETE use that cached ID. `syncIdentifier` is preserved
byte-for-byte, including hexadecimal pump-event values, but is not promoted to
a database uniqueness key. Re-uploading it with a different `created_at`
therefore creates a second Treatment, matching the locked upstream cache-miss
and app-restart behavior. Loop SGV writes keep direction and device metadata
and use the same locked Entries `sysTime + type` selector. DeviceStatus remains
a general nested JSON document, so Loop IOB/COB, predictions, enacted temp
basals, overrides and pump/Omnipod fields pass through unchanged subject to the
separate official prediction-array limit.

The Worker-to-DO call is versioned for rolling deployment. Default-true
requests may fall back to the previous RPC only when Cloudflare reports the
exact missing-new-method error. Explicit false cannot be represented by the
old method, so it fails closed with a bounded 503 while an old isolate drains
instead of silently executing true semantics. All other RPC/storage errors
remain errors.

Settings deliberately has no legacy fallback identity and does not synthesize a
virtual `created_at` for generic reads. Its collection search and both history
forms use the locked `api:settings:admin` permission, while single-resource read
uses `api:settings:read`. Settings `lastModified` therefore comes only from a
real persisted `srvModified`, matching the upstream no-fallback setup.

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

External Nightscout/MongoDB import and NSCF-internal schema activation are
separate contracts. The former is absent from the first release; the latter
must be forward-compatible and idempotent for every supported prior NSCF
schema. A fresh-family onboarding policy must never justify destructive
activation of an existing supported Durable Object. The only `fresh-only`
repair currently described here is the incompatible pre-1.0 narrow Entries
shadow above, not the database as a whole.

V1 Entries preserves the locked four-day default date window and keeps
`dateString` as a distinct string field rather than folding it into numeric
`date`. Realtime/ddata loading uses a separate two-day canonical-document
window. Indexed date/type searches stay in SQLite. The adapted query surface
accepts equality/comparison over numeric `date`, `sgv`, `filtered`,
`unfiltered`, `rssi`, `noise` and `mbg`, plus bounded string `_id`,
`dateString`, `device`, `direction`, `identifier` and `sysTime` fields; it
supports ordered sorts over those fields and type. Unsupported operators,
nested/array/mixed-type behavior and unsafe fields fail closed rather than
being silently ignored. A `dateString` scan or other unindexed candidate set
that would cross 10,000 rows fails closed with HTTP 413; synchronous delete and
per-document revision cleanup are capped at 128. Bodies are capped at 512 KiB
and upload batches at 100. These are explicit Free-plan controls rather than
claims that SQLite and Mongo have identical unbounded behavior.

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

The locked v1 Treatments POST path now implements the complete two-document
`preBolus` create behavior. `prepareData` normalizes the primary treatment and
moves truthy carbs off it. Every truthy normalized `preBolus` creates a second
record at
`created_at + preBolus * 60,000` containing the event type, carbs and optional
notes; when carbs are missing or zero, the child preserves the upstream empty
string initialized by `prepareData`. API v2 inherits that v1 route. Retransmissions use the same
`created_at + eventType` fallback for each record, so both IDs remain stable.
The PUT path intentionally calls the one-record upstream save behavior: it
normalizes and removes the moved carbs but does not fan out a child.

NSCF wraps the two POST upserts in one synchronous SQLite transaction. This is
a named Cloudflare strengthening: if the shifted timestamp or second write is
invalid, neither record persists, instead of exposing a possible half-created
meal across two Mongo writes. It does not change the treatment calculation or
add a dosing algorithm.

Every create, replace, patch and soft delete writes its current document and a
`document_changes` snapshot in one synchronous storage transaction. Generic
API v3 history is a current-collection view: it reads current documents with a
real persisted numeric `srvModified`, orders them ascending and includes soft
delete tombstones. It does not use audit timestamps or virtual `created_at`
fallbacks. Permanent deletion removes the document and its snapshots together,
matching upstream history behavior for `permanent=true`.
This transaction guarantee is per document except for one official logical
bundle: a Treatments `preBolus` POST commits its primary and carb child
together. V1 Entries deliberately uses one transaction per ordered batch item,
so a later error does not roll back a successful prefix.

### Deployed generic slice: all six official API v3 collections

The deployed adapter exposes exactly the eight locked generic routes for each
of entries, treatments, device status, profile, food and settings: GET/POST on
the collection, GET on both history forms, and GET/PUT/PATCH/DELETE on an
identifier. GET `/api/v3/lastModified` evaluates all six collections
independently when the subject has the required read permission; Settings is
omitted when that permission is absent. Unmatched API v3 routes use the locked
`{status,message}` 404 envelope rather than falling into the older adapter
error shape.

The Worker boundary uses one API-wide CORS policy matching the locked Express
middleware: preflight returns `OK`, advertises
`GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS`, and allows content, authorization,
Nightscout secret and conditional-request headers. Express implicitly serves
HEAD through GET; the adapter therefore evaluates the same API3 route and
authorization path, preserves its status and headers, and strips the response
body. This covers version, status, lastModified and all generic collection,
history and resource routes.

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

Durable Object RPC methods return application failures as typed results. POST,
PUT and PATCH already used `Api3MutationDecision`; DELETE now follows the same
boundary for known validation/storage failures. In particular, attempting to
delete a read-only document returns the locked HTTP 422 envelope without an
uncaught exception escaping the DO RPC. Unknown failures remain a generic
storage 500 and do not expose internal messages.

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
- a finite positive `API3_MAX_LIMIT` below 1,000 lowers both search and history
  limits; invalid settings fall back to 1,000 and larger values stay capped at
  1,000 for Workers Free;
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
- all six official generic collections are represented by API v3
  `lastModified`, subject to each collection's read permission.

The locked history projection quirk is retained: when `fields` excludes
`srvModified`, the response body excludes it and Last-Modified/ETag are derived
from the always-projected collection `created_at` fallback. Legacy documents
can be read with virtual srv fields but do not match raw srv filters or HISTORY.
All 16 locked upstream `api3.*` test files are adapted by named
Workers-runtime contracts. Besides the prior basic, generic-workflow, read,
renderer, search and security set, the suite now covers create, update, patch,
patch-operation, delete, shape handling, AAPS patterns, storage socket,
storage find and storage modify. This is complete evidence for the locked API3
test-file set, not a claim that SQLite and MongoDB have unrestricted parity for
behaviors absent from those tests or deliberately bounded by Workers Free.
CSV/XML currently serialize an entire bounded result in memory; large-result
CPU and 128 MB memory adaptation remains open even though byte-level
small/medium contracts are green.

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
HISTORY reads current documents rather than this journal, and `/storage` does
not consume it. Full-body snapshots still create unbounded write/storage
amplification proportional to body size times revision count, with additional
index cost. There is no history retention or pruning policy yet; only permanent
deletion removes all snapshots for that document. This slice must therefore not
be described as suitable for indefinite Free-plan retention until a tested
retention policy is defined.

Live delivery instead reuses the bounded `realtime_outbound_packets` queue for
each currently subscribed session. The frame and document mutation share one
SQLite transaction; accepted frames therefore survive Durable Object eviction,
while a broken or over-capacity subscriber is removed without blocking the
write. There is intentionally no disconnected-client replay because upstream's
`/storage` socket is a live notification channel; a reconnecting client must
reload current state over REST. The queue is not a second permanent history
store and does not solve `document_changes` retention. R2 is unnecessary for
either contract and remains outside the fixed deployment footprint.

### Real-time transport

`platform/socket-io-polling-shim.js` currently creates browser-side `connect`,
`authorize`, `subscribe`, `loadRetro` and `dataUpdate` events and polls every
15 seconds. It still supplies the official page and does not use the new
server endpoint. The separate endpoint now implements strict EIO4 HTTP polling
and direct Hibernatable WebSocket with persisted session/queue state, root
namespace CONNECT, read/write/treatment-write authorization ACKs, initial/retro data and
connection-count broadcasts. It also implements the API v3 `/storage`
namespace, persisted authorized collection rooms and API3-only mutation events,
plus the API v3 `/alarm` namespace's persisted subscription/ACK/snooze slice
and trusted live notification outlet.

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
- `/storage` can connect without the root namespace. Its subscription accepts a
  subject access token, defaults to the six official collections in locked
  order, ignores unknown collection names, requires `api:settings:admin` for
  Settings and the collection read permission otherwise, and persists granted
  rooms across eviction;
- `/alarm` can connect without root or `/storage`. A truthy native access token
  takes branch priority; web subscription accepts secret, JWT or the current
  anonymous-readable default and returns separate read/ACK flags. Repeated
  successful subscriptions accumulate ACK authority as upstream's listeners
  do. Authorized ACKs persist one of at most 256 bounded alarm groups, default
  a falsy silence time to 30 minutes, mirror Urgent to Warning, and broadcast
  the exact live `clear_alarm` payload;
- v1 and inherited v2 GET `/notifications/ack` require
  `notifications:*:ack`, return the exact `OK` body, and enqueue the same
  `clear_alarm` frame in the same SQLite transaction as the snooze. Repeated
  ACKs remain no-ops across eviction; malformed authenticated input remains a
  bounded 200 no-op;
- trusted alarm publication broadcasts one of the five locked event names to
  all currently connected tenant-local `/alarm` sockets, subscribed or not.
  Broken/overflow recipients are dropped independently and disconnected
  clients receive no replay. Actual notification/plugin computation remains
  missing;
- root `subscribe` has no handler or ACK, matching the locked root. The four
  locked client-originated mutation events validate collection, authority,
  required `_id` and bounded payloads in upstream order, then return the exact
  ACK shapes before any resulting root `dataUpdate`. Server-originated
  implemented v1/v2/API3 changes use the same persisted delta baseline;
- HTTP API3 create/upsert/PUT/PATCH/soft-delete/permanent-delete emits the
  locked `/storage` payload only after a successful mutation decision; v1 and
  direct database changes do not broadcast. `document_changes` is not consumed.

Every realtime or authorization-delay state transition recomputes the single
persisted alarm from SQL.
The handler cleans all due sessions/leases, enqueues due pings, handles queue
overflow and broadcasts the surviving client count inside one synchronous
SQLite transaction, then schedules the next derived deadline. Repeated delivery
does not duplicate pings or deletions because `pong_deadline` and row removal
are durable idempotency state. A stale already-due platform alarm is replaced
with a short prompt rather than being allowed to disappear after the current
RPC; a still-future earlier prompt is preserved to avoid starvation. WebSocket
closure tombstones and authorization failure rows add their own due times to
the same derived minimum. API3 pruning and server-plugin jobs still need a
shared persisted task table before using the same one-alarm slot.

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

Both polling and direct Hibernatable WebSocket remain live in Cloudflare version
`4f89e2fc-ac35-499b-ac39-ffbd61f18e66`. Current credential-free remote smoke
returned 200 for health, bounded v1 Entries and Treatments reads, fresh-tenant
Profile/current and v2 Summary, API3 version and an EIO4 polling open packet;
API3 Entries without a token returned the
expected 401. The current public Worker has no `API_SECRET` Secret binding, so
a simulated Treatment POST returned the expected 503
`api_secret_not_configured` and a follow-up read remained empty. Successful
protected uploader and realtime mutation behavior remains covered locally
rather than by a credentialed remote mutation. The at-most-once dequeue/send
crash window described above remains open for direct WebSocket. The official homepage
intentionally still uses the REST polling shim. The inherited local transport
contracts and the prior public EIO4 smoke prove only the separate server slice,
not a page transport switch. The named
polling HTTP edge difference is admission at the
1,000,000-byte boundary for malformed UTF-8: NSCF counts streamed raw bytes,
while locked Node can count the replacement-decoded text differently.

The current API3 `/storage` adapter persists each accepted subscriber frame in
the same SQLite transaction as its mutation, then wakes polling waiters or
hibernated WebSockets after commit. Hibernated sessions restore tenant and SID
authority from WebSocket attachments plus SQLite; namespace connection and room
subscriptions come from SQLite schema v9. `/alarm` connection/subscription
authority and silence rows come from idempotently repaired schema v10. Root
delta baseline and the last full comparison snapshot come from schema v11;
root write and treatment-write authority come from idempotently repaired schema
v12. Pre-v12 live sessions default those new flags to false and must
re-authorize after rollout, while their rows and data remain intact.
The remaining transport work is profile-switch status/plugin preprocessing,
EIO3, polling upgrade
and the direct-send replay/acknowledgement boundary; server-side notification
generation remains background/plugin work.

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

The deployed summary basal processor and pure
`bgnow`/`direction`/`rawbg`/`upbat` adapters are reused server
calculation/property slices, but they are request-scoped rather than a
background plugin engine. They do not calculate insulin
recommendations, IOB or COB. Future summary state
must come from the locked plugin modules through the persisted scheduler above;
platform code must not fill those fields with downstream formulas.

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
- `/alarm` silence state is bounded to 256 distinct group names, each at most
  256 characters; it is durable ACK state, not a notification history queue.
- The narrow realtime shadow stores numeric SGV/MBG only in its historical
  20–600 columns; the canonical v1 document no longer rejects an upstream
  uploader value solely for falling outside that range.
- Ordinary Entries detail count defaults to 10 and is capped at 10,000. The
  separate aggregate count returns one SQL-derived result and is not subject
  to that result cap; long detail exports still require date partitioning.
- Entries unindexed/dateString candidates are capped at 10,000 with controlled
  HTTP 413; synchronous deletion and stored-revision cleanup are capped at 128.
- Entries pattern utilities accept at most eight expanded dateString prefixes,
  256 numeric-brace expansions and 10,000 candidates per prefix, using only the
  locked fixture's reviewed linear regex subset.
- A selected Entries set is currently materialized across DO RPC, final sort,
  representation and ETag hashing. Compact SGV records at ordinary client
  counts are the supported path; thousands of abnormally large custom
  documents can approach Workers Free CPU/memory limits. A total-result budget
  or streaming redesign is deferred rather than hidden.
- Official UI and calculations are not changed; no NSCF dosing logic exists.
- `API_SECRET` is the bootstrap application credential; subject access tokens
  and role documents are tenant-local SQLite records. The value is never
  committed to Wrangler config or repository docs. Cloudflare metadata tooling
  can display a plaintext dashboard variable, so the lab credential must be
  rotated and converted to an encrypted Worker Secret before non-lab use.
- The homepage polling shim is transport-only, runs every 15 seconds and has no
  medical or display logic. The separately routed EIO4 root is read-only;
  `/alarm` can persist only its bounded ACK/silence state. This server is not
  yet the homepage transport.
- Text asset responses are streamed rather than buffered when UTF-8 headers are
  adapted, keeping the extra Worker CPU and memory work constant.
