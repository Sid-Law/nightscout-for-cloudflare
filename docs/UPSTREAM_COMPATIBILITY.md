# Upstream compatibility matrix

Last audited: 2026-07-19

## Baseline and completion rule

NSCF is an independent, unofficial Cloudflare port of
`nightscout/cgm-remote-monitor`. The locked baseline is official Nightscout
`v15.0.7` at commit
`7e0e77f88fc113a76fe363504125f5b36b8a3fe3`; provenance and the release archive
SHA-256 are recorded in `upstream/manifest.json`. The 655 files under
`vendor/nightscout` are an unmodified release snapshot.

NSCF is **not a complete Nightscout port yet**. A route returning HTTP 200, an
official page opening, or the official browser bundle loading is not sufficient
evidence. A component is complete only when its upstream request/response,
storage, authorization, real-time, persistence and error contracts are covered
by Workers-runtime tests and post-deploy smoke tests.

Deployed integration commit and Git HEAD used by Wrangler
`121db7ca5a0b45784713a5ac909a5bcbb3c1f499` pass 245/245 tests across 22
Workers-runtime files plus 20/20 audit tests. The suite includes focused
EIO4 polling/direct-Hibernatable-WebSocket protocol, persisted session,
HTTP-boundary, eviction, authorization, tenant-isolation and resource-cap
contracts, plus API3 `/storage` namespace/room/change-event contracts, in
addition to strict v1/v2 Status, API v3
entries/treatments/device-status/profile/food/settings, storage and
official-page tests. This is not full-port evidence. The code is deployed as
Cloudflare version
`00ecdd3a-240c-4fc1-a984-ad6449bb0b84`; exact release evidence is recorded in
`DEPLOYMENT.md`. The locked upstream has 111 `*.test.js` files; a static
declaration audit finds 883 active
`it(...)` cases plus one skipped case. Those sets are not directly comparable,
and the local suite does not prove full compatibility.

The final Wrangler dry-run reports 248 official assets, 895.01 KiB raw /
160.79 KiB gzip and only `ENTRY_STORE` plus `ASSETS`. Post-deployment API and
browser evidence below is kept distinct from those local gates.

## Generated route and test inventory

`upstream/contract-manifest.json` is the version-controlled source of truth for
the route/test audit. It is generated from the locked Express/API v1/v2
registration modules, the API v3 registration code, and every
`vendor/nightscout/tests/**/*.test.js` file. The generated
`docs/UPSTREAM_TEST_MANIFEST.md` presents the same 111-file status set in
dependency order for dispatch.

The current manifest contains 161 HTTP registrations: one API version-discovery
route, 45 v1 routes, 62 v2 routes (including the upstream v1 router inherited by
v2), and 53 v3 routes. API v3 accounts for the only reviewed dynamic expansion:
six names read from the locked `enabledCollections` setting multiplied by eight
generic route templates in `lib/api3/generic/collection.js`, plus four specific
API routes and the documentation prefix redirect. The collection/template
expansion and its source files remain explicit in
`upstream/contract-overrides.json`; it is not presented as a fully general
JavaScript static analysis result.

Run the generator after changing the vendor lock or a manual dynamic override,
and run its check in CI and before commits:

```sh
npm run upstream:audit
npm run upstream:audit:check
npm run test:upstream-audit
```

The checker enforces stable ordering, unique API-version/method/path keys,
locked registration-source hashes, exact static/dynamic overlay agreement with
the locked registrations, exact auth/condition override targets, re-derived
syntactic `mount_chain` entries, exact registration/handler source anchors,
exactly 111 upstream test files, known status values, non-empty reasons, and
byte-for-byte freshness of both generated outputs. A mount chain is not a full
runtime provenance or call-graph proof: it does not prove reachability,
middleware order, handler execution, or test coverage, and API v3 dynamic
chains intentionally stop at the locked `genericSetup` call. The
default test-file status is `unresolved`. At this audit point, 109 files are
`unresolved`, two real-CGM bridge files are `excluded-fixed-scope`, and
zero files are claimed as `pass` or `adapted`.

Route/test associations remain dispatch heuristics. Direct literal HTTP calls
are filtered by their path-local method when that method can be statically
seen; dynamic paths, plain-text references, prefix ambiguity, and API v3
operation-filename hints still require manual confirmation and are not coverage
evidence. The locked API v3 settings search and both settings-history forms are
recorded as the explicit `api:settings:admin` exception shown by
`lib/api3/generic/search/operation.js:20-24` and
`lib/api3/generic/history/operation.js:131-135`. Ordinary collection
search/history (including tombstones; history fixes `onlyValid = false` at line
24) remains read-protected, as does the single-record settings read route.

The two exclusions are limited to the real-CGM bridge modules (`bridge`,
`mmconnect`). The `maker`, `pushnotify`, and `pushover` tests replace their
external requests and exercise internal mapping, validation, deduplication,
all-clear/cancel, and multi-key behavior, so they remain `unresolved`. Storage,
simulated entry ingestion, notification state, authorization, API behavior,
server calculations, real-time transport, and browser workflows also remain
required and unresolved.

## What cannot run unchanged, and what only needs adaptation

| Upstream dependency | Evidence in v15.0.7 | Classification | Cloudflare path |
| --- | --- | --- | --- |
| Node HTTP server and Express | `lib/server/server.js:41-75` creates a Node server, calls `listen()`, attaches Socket.IO and starts a process-lifetime timer. | **Partly reusable, not an absolute blocker.** Current Workers support Node HTTP servers and an Express adapter, but this exact process bootstrap still assumes one permanent process. | Reuse upstream Express routers where they do not depend on process-global state; expose them through a Worker request handler or reproduce only their platform boundary. [Cloudflare Node HTTP](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/) and [Express tutorial](https://developers.cloudflare.com/workers/tutorials/deploy-an-express-app/). |
| File system and localization/assets | `lib/server/server.js:29-34`, `lib/language.js:149`, and `lib/server/app.js:129,254-255` read bundled files. | **Adaptable.** `node:fs` is now available through Workers' virtual file system. Runtime mutation and arbitrary host paths remain unsuitable. | Prefer build-time asset discovery and Static Assets; use bundled virtual files only where it reduces divergence. [Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) and [Static Assets binding](https://developers.cloudflare.com/workers/static-assets/binding/). |
| MongoDB connection and collections | `lib/storage/mongo-storage.js:105-221` creates a connection pool, retries forever, exposes `db.collection()` and creates indexes. | **Cannot run unchanged within the fixed platform scope.** This project deliberately has no Mongo service and must use SQLite Durable Objects. | Implement a Mongo-compatible repository contract over DO SQLite, including query conversion, indexes, collection behavior and migration tests. [SQLite-backed DO storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/). |
| Mongo ObjectId and query semantics | `lib/server/query.js:28-175`, `lib/server/entries.js`, `lib/server/treatments.js` and `lib/authorization/storage.js` depend on ObjectId, nested Mongo operators, sort, projection and upsert behavior. | **Engineering adaptation.** ObjectId formatting is easy; behavioral parity is not. | Preserve 24-hex identity and UUID fallback rules, then port operators and collection-specific dedupe as contract-tested SQL/JSON operations. |
| Process-global bus and mutable caches | `lib/bus.js:4-36`, `lib/server/bootevent.js:271-330`, `lib/notifications.js` and `lib/adminnotifies.js` keep timers, listeners and alarm state in memory. | **Runtime lifecycle conflict.** Workers and DOs may be evicted and reconstructed. | Persist authoritative state in SQLite, rebuild caches on activation, and make mutations idempotent. |
| Socket.IO / Engine.IO | `lib/server/websocket.js:87-164` attaches Socket.IO with polling and WebSocket transports. The official 4.5.4 browser bundle uses EIO4/SIO5; `allowEIO3` retains EIO3/SIO4 legacy clients. Later handlers implement authorization and database mutations. | **Partial platform adaptation.** Deployed persisted EIO4 polling and direct Hibernatable WebSocket slices run on the tenant DO, separately from the homepage REST shim. The read-only root and API3 `/storage` namespaces are named compatible subsets; this is not a polling upgrade, EIO3, `/alarm`, root-write or homepage-switch completion. | Add the page-required `/alarm` and tenant behavior before switching the static client; implement polling-to-WebSocket upgrade, EIO3 if retained, root writes and the direct-send replay boundary. [DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/). |
| `setInterval` and periodic work | `lib/bus.js:35`, `lib/plugins/bridge.js:116` and `lib/plugins/mmconnect.js:25` assume a permanent event loop. | **Runtime conflict.** Intervals cannot be the durable scheduler. | Store a task schedule in SQLite and multiplex it through the DO's single alarm. Alarms are at-least-once and must be idempotent. [DO alarms](https://developers.cloudflare.com/durable-objects/api/alarms/). |
| Server plugin registration | `lib/plugins/index.js:25-80` statically requires the official plugin set; `lib/server/bootevent.js:209-246` creates server plugins from runtime settings. | **Mostly build/runtime adaptation.** Static requires can bundle; process-global contexts and plugin state cannot be trusted. | Generate a build-time registry from the locked tree and give each server plugin a persisted, tenant-scoped execution context. Do not rewrite official calculations. |

Cloudflare therefore does not make a full port impossible. The earlier scope
was conservative: it stopped after official page assets and page-used APIs.
The remaining work is substantial platform adaptation, not a fundamental
platform prohibition.

## Module-by-module status

Legend: **Compatible** means the claimed contract has tests; **Partial** means
only a named subset exists; **Missing** means no runtime implementation exists.

| Area | Upstream source of truth | Current status | Required acceptance evidence |
| --- | --- | --- | --- |
| Upstream identity and UI bytes | `package.json`, `webpack/webpack.config.js`, `views/**`, `static/**`, `translations/**` | **Compatible for built assets.** v15.0.7 is pinned; official pages and bundle are served without a replacement UI. | Rebuild from clean vendor snapshot; byte/provenance assertions; browser rendering on every deploy. |
| Express boot model | `lib/server/server.js`, `lib/server/app.js`, `lib/server/bootevent.js` | **Partial.** Routes are currently hand-dispatched by `src/index.ts`; upstream Express boot is not running. | Decide router-by-router reuse versus adapter; contract-test middleware order, content negotiation and error handling. |
| Collections and indexes | `lib/storage/mongo-storage.js`, server storage modules | **Partial.** SQLite generic documents cover all six official collections with indexed metadata, an API3 allocation clock and atomic change snapshots. Profile and Food v1 writes share the repository; older Profile/Food rows receive idempotent metadata/fallback repair. Settings preserves the upstream no-fallback rule. Entries has date/dateString/type indexes plus a narrow compatibility shadow. Its v6 probe resets only an incompatible pre-1.0 shadow and preserves canonical documents/profile; it is deliberately not a legacy importer. Healthy activation is a read-only probe. This does not import an external Nightscout/MongoDB database. | Prove in-place activation from every supported NSCF schema while preserving canonical data, and complete mixed-type/index/query differential behavior. Keep external Nightscout/MongoDB history import as separately scoped future work; make no first-release import claim. |
| ObjectId, UUID and dedupe | `lib/server/query.js`, `lib/server/treatments.js`, `lib/api3/storage/mongoCollection/utils.js` | **Partial six-collection slice.** Generated IDs are random 24-hex strings. V1 Entries now matches locked default `UUID_HANDLING` behavior: every non-ObjectId string `_id` is copied to `identifier` when the supplied identifier is missing/null/empty, then removed before server allocation; a non-empty identifier wins. Valid ObjectIds are retained and an ordered batch commits only the successful prefix before duplicate/immutable-ID failure. Treatments/profile/food and API3 retain their tested collection selectors; Food uses `created_at` only and Settings has no fallback. IDs are not BSON ObjectIds. | Extend duplicate/partial-failure fixtures to every collection; the atomic two-document `preBolus` fan-out remains unported and carbs are retained until it exists. The 4,096-character identity and 100-item v1 batch caps are Free-plan controls. |
| Mongo query behavior | `lib/server/query.js`, `lib/api3/storage/mongoCollection/**` | **Partial.** V1 Entries supports equality/comparison for numeric date/SGV/filter/RSSI/noise/MBG fields and bounded string ID/dateString/device/direction/identifier/sysTime fields, supported-field sort-before-limit and final time ordering; it keeps the four-day default and distinct string `dateString`. Legal shapes that exceed SQLite binding/statement limits now fail as controlled 400 rather than internal 500. V1 treatments retain their named subset. API3 implemented collections support locked scalar operators, safe nested/unknown fields, projection/paging, ordered sort chains and a bounded case-sensitive `$re` subset compiled to GLOB. SQLite/Mongo operators, mixed types, arrays, projections and collation remain incomplete. | Add `$in`/`$nin`/regex/exists and nested/array/mixed-type differential coverage before widening the v1 allowlist or calling generic search compatible. Other v1 collections still use limited filtering. |
| API v1 entries | `lib/api/entries/index.js`, `lib/server/entries.js` | **Substantial adapted partial slice.** Create/list/current/model/ID/delete now include single/array/extended-urlencoded uploads, preview, server-owned/uploader-sync identity, ordered-prefix failures, idempotent fail-closed sanitization, the bounded query/sort subset, four-day reads, JSON/plain/CSV/TSV, result plus exact base-route runtime-SGV Last-Modified/IMS, weak ETag/INM and HEAD. Entries `echo` exposes a bounded query-debug envelope, and `count/:storage/where` performs direct SQLite aggregation for entries, treatments and device status; V2 inherits both. `times/echo`, `times`, `slice`, non-Entries echo, arbitrary aggregation pipelines, exact DOMPurify output, large-detail materialization control, wider Mongo/document semantics and some historical errors remain incomplete. | Port the remaining Entries utilities and whole-file shape/error contracts; retain the explicit Free-plan and sanitizer adaptations and the fresh-only pre-1.0 reset. |
| API v1 document CRUD | food/profile/treatments/devicestatus modules | **Partial.** Page-used JSON CRUD exists with bounded filters. Treatments keep legacy materialization and mutation rules: `isValid:false` remains visible, `srv*` is not synthesized, read-only flags do not block v1 PUT/DELETE, numeric values, conditional GET and empty-array POST follow the locked shapes, and `/api/v2/ddata` keeps its raw legacy body. | Port every remaining route, content type, batch, validation and error variant; implement the atomic `preBolus` fan-out. |
| API v1 activity | `lib/api/activity/index.js`, `lib/server/activity.js`, `tests/api.activity.test.js` | **Compatible subset deployed.** Create/list/filter/conditional GET/update/delete and empty-array create now follow the upstream shapes. | Remote authenticated create/read/update/delete smoke when a credential is explicitly supplied; expand remaining upstream shape tests. |
| Remaining API v1 | notifications, Alexa, Google Home and entries utility routes | **Missing or partial.** `adminnotifies` is a hard-coded empty response. | Route inventory from Express registration plus contract tests for each enabled/scope-allowed route. External integrations remain disabled in the simulated-data deployment. |
| API v2 properties and ddata | `lib/api2/index.js`, `lib/data/endpoints.js`, `lib/api2/properties.js` | **Partial.** Clock properties and one aggregate page payload exist; canonical Entry loading uses a bounded two-day realtime/ddata window, distinct from v1's four-day default. The complete data transformation/delta contract does not. | Compare official client fixtures and all ddata/property fields, retro behavior and errors. |
| API v1/v2 Status | `lib/api/status.js`, v1/v2 router mounting and final error chain | **Strict named surface deployed, with one transport P2.** Locked extension/Accept negotiation, txt/json/js/png/svg paths, redirects, uppercase/trailing-path bugs, GET/HEAD representation lengths, method finalhandler behavior, query-only `authorized` derivation and production 406/404 bodies are contract-tested. Remote text/Accept forms returned 200 and an unknown extension returned 404. Cloudflare strips `Content-Length` from dynamic responses, including HEAD; status code, `Content-Type`, `Vary` and empty-body semantics are correct. | Preserve this P2 as an explicit platform difference and expand public smoke to every locked representation; do not infer other v1/v2 route compatibility. |
| API v2 authorization | `lib/authorization/**`, `lib/api/verifyauth.js` | **Core adapted with named differences/hardening.** Role/subject CRUD, per-tenant signing keys, eight-hour HS256 issuance/refresh, derived access tokens and prefix matching, body/query/header precedence, signature/expiry verification, live role lookup, persisted per-IP failure delay, Shiro 0.4.10 and `verifyauth` are implemented. Enforced delay is capped at 60 seconds, a failed attempt does not yet emit the upstream admin notification, and repeated/bracket `secret` arrays are safely resolved or rejected instead of reproducing the locked unhandled rejection. | Add admin-notify emission/cleanup contracts; preserve the 60-second platform cap and array hardening as explicit differences and repeat remote auth smoke. |
| API v2 summary/notifications | `lib/api2/summary/**`, `lib/api2/notifications-v2.js` | **Missing.** | Reuse upstream processors without adding medical logic; add notification acknowledgement/persistence tests. |
| API v3 version/status | `lib/api3/specific/version.js`, `specific/status.js`, `security.js`, `tests/api3.basic.test.js` | **Compatible named subset.** `/version` is public; `/status` requires a valid tenant JWT and returns the locked v15.0.7 error/envelope shapes. Its permission-loop bug is preserved: every collection is evaluated against `api:undefined:<action>`, so a readable JWT reports `r` for all six registry keys. | Local valid/missing/bad/eviction/cross-tenant JWT contracts plus remote missing/bad-token smoke; do not infer generic API support from this endpoint. |
| API v3 generic collections/lastModified/history | `lib/api3/generic/**`, `specific/lastModified.js`, `shared/renderer.js` | **Partial six-collection vertical.** All eight generic routes are wired for entries, treatments, device status, profile, food and settings, and all six participate independently in `/lastModified`. JWT auth, conditional headers, transactional permission selection, collection-specific dedupe, soft/permanent delete, ordered sort, both history cursors and locked JSON/CSV/XML are wired. Profile covers AAPS create/retry/new-version; Food shares v1 identity/history and `created_at` fallback; Settings has no fallback and retains admin-only search/history versus read-protected resource GET. Entries supplies controlled 10,000-candidate/128-delete bounds and the safe `$re` subset. | Implement large-result CPU/memory adaptation, broader mixed-type/nested/regex parity and whole-file upstream API3 execution. Do not mark any complete `api3.*` test file adapted from these named verticals alone. |
| Main Socket.IO namespace | `lib/server/websocket.js` | **Partial read-only EIO4 polling + direct WebSocket slice.** Exact `/socket.io` and `/socket.io/` requests route to tenant DOs. Persisted sessions/queues, heartbeat, SIO5 root CONNECT, `clients`, read-only authorize/dataUpdate/ACK and loadRetro are tested across polling, direct Hibernatable WebSocket, eviction and tenant boundaries. A SQL-derived alarm persists ping/pong/session/poll/POST/closure deadlines. The official page still loads the REST shim; polling upgrade is not implemented, root write/database-update behavior is missing, and a crash between durable dequeue and direct `send()` can lose one frame. | Switch the page only after safe tenant propagation and `/alarm`; close the at-most-once crash window, then add polling-to-WebSocket upgrade, EIO3 HTTP if retained, root writes and browser workflows. |
| API v3 storage/alarm namespaces | `lib/api3/storageSocket.js`, `lib/api3/alarmSocket.js` | **`/storage` named slice implemented; `/alarm` missing.** EIO4/SIO5 polling and direct WebSocket can connect `/storage` independently. Subject access-token authorization, official default collection order, unknown-name filtering, duplicate response behavior, per-room read checks and the Settings-admin exception are locked. Namespace/room state and bounded frames survive DO eviction. Successful HTTP API3 POST/upsert, PUT, PATCH and soft/permanent DELETE mutations emit official payloads; v1/direct changes do not. | Add EIO3/SIO4 compatibility if retained, credentialed remote/browser delivery evidence and `/alarm` lifecycle/notification contracts. Preserve upstream's live-only/no-replay semantics. |
| Real-time database updates | `lib/server/bootevent.js:271-330`, websocket and API3 storage socket | **Partial: API3 storage channel implemented.** Each implemented document mutation persists `document_changes` atomically with its current document. Separately, successful HTTP API3 mutations enqueue bounded `/storage` frames for current authorized subscribers inside that transaction; eviction, tenant/room isolation, hibernated delivery and broken-subscriber containment are tested. V1 Entries ordered batches still commit successful prefixes and do not broadcast on `/storage`. The homepage/root database-update path remains REST polling. | Implement locked main-namespace database updates and browser workflows. Define retention/pruning for the unbounded `document_changes` journal separately; it is not the live transport queue and upstream `/storage` provides no disconnected replay. |
| Background tick and pruning | `lib/bus.js`, `lib/api3/generic/collection.js:127-163` | **Realtime/auth alarm foundation only.** The DO single alarm derives transport heartbeat/session/lease/closure work and authorization-failure cleanup from SQLite and is retry-idempotent. API3 pruning and plugin ticks are not scheduled. | Add a persisted multi-kind task table that shares the one alarm, with retry/idempotency and bounded Free-plan scheduling tests. |
| Server plugins and calculations | `lib/plugins/index.js`, `lib/sandbox.js`, `lib/data/dataloader.js` | **Missing server execution.** Official client plugins/calculations are bundled, but server plugin properties/notifications are not computed. | Run official modules through a platform context; port upstream plugin/data tests without inventing algorithms. |
| Notifications/admin state | `lib/notifications.js`, `lib/adminnotifies.js`, push modules | **Missing persistence and processing.** | SQLite state model, alarm/ack/snooze tests, eviction tests and scope review for external push providers. |
| Official page workflows | `views/**`, browser client/admin/report modules | **Partial.** An earlier deployed increment provided authenticated Profile Save/close regression evidence. The current browser pass rendered the homepage empty chart state without warning/error, then loaded the official Food Editor to `Database loaded` with the expected anonymous read-only state. Its official bundle emitted two non-fatal missing-chart-container warnings on that chartless page, with no script errors. The public tenant has no Entries, so `---` is expected. Mutations/report generation and pushed live updates are not complete. | Re-run authenticated Profile Save/Food mutation when a credential is explicitly supplied, then add profile delete, admin mutations, report generation and pushed live updates with console/network assertions. |
| Upstream test tracking | `tests/**`, `upstream/contract-manifest.json`, `scripts/audit-upstream-contracts.mjs` | **Inventory complete; compatibility unresolved.** All 111 files are tracked with a strict status/reason and heuristic candidate route associations, but no whole upstream file is yet claimed green against the DO adapter. | Manually confirm route links. Update status only with whole-file upstream execution (`pass`) or complete named Workers-runtime contract coverage (`adapted`); keep generator/check green. |

## Locked-upstream discrepancy decisions

Nightscout v15.0.7 `lib/api3/specific/status.js:43-46` iterates the collection
registry with `for...in` but passes the string property name to a helper that
expects a collection descriptor with `colName`. The permission checked for
every collection is consequently `api:undefined:<action>`. With the official
read role, the wildcard permission matches `read`, so all six registry keys
report `r`; a collection-specific create role does not add `c`. Swagger and
the tutorial show the intended per-collection `crud` matrix. NSCF preserves
the locked release's actual check and records the contradiction; it does not
silently repair upstream behavior and then claim byte-for-byte compatibility.

The same evidence rule applies to future contradictions: actual locked source
and tests take priority unless a deliberate compatibility fix is named,
documented and contract-tested.

### API v1 Entries adapted differences

The implemented Entries slice is contract-tested but not whole-router
compatibility. Its controlled differences and remaining gaps are:

- request bodies are capped at 512 KiB and persistent batches at 100 items;
  locked `body-parser` permits 50 MiB and the Mongo adapter has no equivalent
  item cap;
- repeated query parameters, unsupported fields/operators and counts outside
  1–10,000 fail closed. Locked Express/Mongo accepts a wider and sometimes
  ambiguous surface;
- URL-encoded bodies use the maintained `qs 6.15.3` parser with the locked
  body-parser extended shape, depth 32 and 50,000-parameter contract. The fixed
  dependency is newer than upstream's vulnerable transitive version but keeps
  the tested parse behavior;
- non-ObjectId string `_id` values now follow the executable locked predicate
  rather than its misleading UUID-only comment; missing/null/empty
  `identifier` is replaced, while a non-empty identifier is preserved. NSCF
  adds a 4,096-character identity bound;
- missing array dates and numeric-string/urlencoded dates are normalized into
  an indexed numeric `date` for SQLite. The locked code can leave the public
  date missing/string while using a separate current-time or invalid `sysTime`;
- canonical records still receive compatibility defaults for missing `type`,
  `direction` and `device`; this makes fresh-family data queryable but is not
  the locked response shape and can affect identity for malformed multi-item
  batches;
- the locked recursive purifier is DOMPurify 2.5.8 over JSDOM 11.11.0. Workers
  has no DOM at this boundary, so NSCF recursively entity-encodes HTML-like or
  entity-bearing nonnumeric strings before preview/persistence. Existing
  entities are preserved so read-then-reupload is idempotent. Active markup is
  not stored, but safe markup upstream would retain is returned as text;
- Mongo ordered bulk failure preserves the successful prefix. SQLite matches
  that boundary with one `transactionSync()` per item, then exposes the stable
  500 `{status,message,description:{}}` envelope rather than serializing
  driver-specific enumerable error properties;
- the locked source's `format_post_response` returns preview success with the
  default HTTP 200, while `tests/api.unauthorized.test.js` contains a stale 201
  assertion. NSCF follows the executable locked source and records the
  contradiction instead of changing the route to satisfy that assertion;
- Entries `echo` is implemented for the bounded query subset and returns the
  locked `query`, `input`, `params` and `storage` envelope. It strips tenant and
  credential transport parameters from reflected input. Echo for other storage
  modules remains unsupported with a controlled 400.
- `count/:storage/where` performs direct SQL `COUNT(*)` aggregation for entries,
  treatments and device status. Like the locked `$match` plus `$group` utility,
  result `count` and `sort[...]` options do not affect the aggregate; zero rows
  return `[]`, and a nonzero total returns `[{"_id":null,"count":N}]`. Unknown
  storage names inherit the locked entries fallback. The adapter accepts only
  the bounded filter subset and rejects client-supplied aggregation pipelines
  with controlled 400 instead of executing arbitrary stages.
- Aggregate count does not materialize matching documents and is not capped by
  the ordinary 10,000-row response limit. This does not remove the limit from
  detailed Entries reads or exports: long histories still require date-bounded
  partitions.
- `times/echo`, `times` and `slice` remain missing. Their brace-list and regular-
  expression route grammar requires a bounded protocol compiler before
  exposure.
- the ordinary compact-SGV path retains `count=10000`, but an artificial
  selection of thousands of documents containing abnormally large custom
  fields is still materialized across DO RPC, sorting, formatting and ETag
  hashing. A total-result budget or streaming redesign is deferred as
  extreme-request hardening.

The GET/HEAD representation subset is tighter: differential probes lock
extensionless plain text by default, JSON/CSV/TSV/TXT bytes, lowercase
extension override and uppercase-extension fallthrough, result-derived
Last-Modified, the exact base-route runtime-SGV IMS precheck/fallback header,
Express weak ETags, ordinary result IMS and normal INM 304 behavior, and
sort-before-limit followed by formatter time ordering. Workers adds the common
`no-store`/CORS headers; Cloudflare may strip dynamic `Content-Length` at the
public boundary.

### API v3 implemented-collection controlled differences

The entries/treatments/device-status/profile verticals keep the route, JWT,
permission-branch, validation, tombstone, history and renderer contracts named
above. They are not complete generic API v3 compatibility. The remaining or
deliberate differences are:

- request JSON is capped at 512 KiB; locked `body-parser` is configured for
  50 MiB;
- top-level JSON primitives return the treatments 400 envelope; the locked
  strict body-parser/error-middleware path returns 500;
- multiple operators for one field now match the locked object-overwrite
  behavior: the later query item replaces the earlier operator object, and the
  adapter-owned valid-row condition replaces caller `isValid`;
- a parsed zero limit, including `limit=0x10`, is capped at 1,000 rows instead
  of using Mongo's unlimited `cursor.limit(0)` behavior;
- JSON/CSV/XML small and medium responses have locked differential fixtures,
  but CSV/XML still buffer the complete result; Free-plan CPU and 128 MB memory
  behavior for worst-case 1,000-row/nested results is not closed;
- `$re` accepts a bounded, case-sensitive, linear subset compiled to SQLite
  `GLOB`; unsupported constructs, patterns above 128 UTF-8 bytes and compiled
  GLOBs above 50 bytes return controlled 400;
- unsafe field syntax and SQLite's 100-binding/100,000-byte statement limits
  return controlled 400 responses;
- non-negative `skip` values through JavaScript's maximum safe integer are
  accepted; larger parsed offsets return controlled 400 instead of reaching an
  unsafe SQLite integer binding;
- comparisons, ordering and projection across mixed JSON types, arrays and
  nested values have not completed a Mongo differential matrix;
- a final server-ID sort key makes exact ties deterministic on SQLite;
- `srvModified` allocation is strictly monotonic across same-millisecond writes
  and DO eviction, an intentional platform enhancement over upstream's direct
  clock value;
- `/lastModified` evaluates all six official generic collections; Settings is
  included only when its read permission is present and uses no created-at
  fallback.

Extension middleware is not collapsed into renderer support. The adapter uses
the locked `mime` 2.6.0 table: malformed JSON fails before extension handling;
unknown MIME extensions return 406 before route authentication; known MIME
extensions are stripped and can reach JSON write handlers. Resolved
`application/json` aliases, including `.map` and `.JSON`, use the JSON renderer.
Known unsupported read formats authenticate/query first and then return the
controlled renderer 406. Negotiated responses and renderer-generated 406
responses vary on `Accept`. The 512 KiB and query-limit errors are platform
controls, not upstream claims.

## Current deployed integration evidence

Code candidate and Git HEAD used by Wrangler
`121db7ca5a0b45784713a5ac909a5bcbb3c1f499` pass 245/245 tests in 22
Workers-runtime files plus 20/20 audit tests. They combine the adapted v1/v2
Entries count/echo and uploader/query/read-protocol slices with strict Status,
authorization, direct Hibernatable EIO4 WebSocket and API v3
entries/treatments/device-status/profile/food/settings plus `/storage` slices.
Cloudflare version `00ecdd3a-240c-4fc1-a984-ad6449bb0b84` was reported as the
Current Version by the direct Wrangler deployment, which reported a 22 ms
startup. Wrangler processed 248 unchanged official asset entries, reported
895.01 KiB raw / 160.79 KiB gzip, and listed only `ENTRY_STORE` and `ASSETS`.
Deployment used `--keep-vars`, tag
`git-121db7c` and a matching Git message. Wrangler did not print a separate
creation/activation timestamp or Deployment ID, so none is inferred here.

No credential was supplied to local tests, remote API smoke or browser smoke,
and no credential value is stored in the repository or these documents.
Metadata inspection did reveal that the current lab `API_SECRET` is configured
as a plaintext Worker variable and that Wrangler can render such values. Its
value is deliberately omitted. It must be rotated and converted to an
encrypted Worker Secret before non-lab use; this release did not rotate it
because changing an existing credential would break clients without an
explicit cutover.

Entries is fresh-only for the pre-1.0 lab. An incompatible old narrow
`entries` shadow is reset without importing its rows, while canonical documents
and profile remain untouched. At 2026-07-18 14:51 UTC, read-only checks against
the public instance returned an empty array from
`/api/v1/entries.json?count=10000` and a one-element array from
`/api/v1/profile.json`. Post-deployment reads confirmed zero Entries and one
profile. Thus this deployment had no simulated Entry row to lose and preserved
its profile. Remote evidence recorded only collection counts/status and the
browser load state; no profile values are copied into this record.
The deferred work is importing an external legacy Nightscout/MongoDB history.
It does not defer correctness of NSCF's own forward-only SQLite schema
activation. Redeploying the current Worker preserves that namespace; the
planned fresh-family path instead starts with a new Worker/DO namespace or an
empty tenant.
The first release therefore applies only to fresh deployments. A user who
requires existing Nightscout history in the new instance should not switch to
this release.

The deployed adapter uses the one-alarm-per-DO design for both realtime
deadlines and authorization-delay cleanup. On Workers Free, SQLite row reads,
row writes and index maintenance remain account-wide daily resources, and each
`setAlarm()` call counts as a write. The adapter therefore bounds unindexed
Entries candidates at 10,000 with controlled 413, synchronous deletion/history
cleanup at 128, and `$re` to the safe GLOB-compilable subset.

The deployed polling and direct-WebSocket slices remain separate from the
homepage REST shim. Their current bounds and named differences are:

- strict `EIO=4`, `transport=polling`, non-binary payloads and `upgrades: []`;
- exact `application/octet-stream` POSTs close the SID with a controlled
  400/code-3 response; malformed UTF-8 uses replacement decoding, while
  raw-versus-replacement accounting at the 1,000,000-byte edge remains P2;
- 256 sessions per tenant, 128 outbound packets and a 1,000,000-byte whole
  queue/body limit. Request-time opportunity cleanup remains bounded to 32,
  while the SQL-derived single DO alarm independently handles all due
  heartbeat/session/lease work and reschedules idempotently across eviction;
- tenant-local anonymous/API-secret-digest/access-token/JWT reads, with ACKs
  always fixed to `{read:true, write:false, write_treatment:false}`;
- invalid authorization disconnects only `/`; unknown namespaces such as
  `/alarm` return `CONNECT_ERROR`, while root `subscribe` and every root write
  event remain unhandled;
- `/storage` connects independently, authorizes a subject access token into
  collection rooms, persists those rooms across eviction and sends bounded
  create/update/delete frames only for successful HTTP API3 changes;
- initial `dataUpdate` uses the locked recent-device-status shape. `loadRetro`
  uses raw normalized statuses from the same one-day SQL window; initial
  filtering keeps the most recent 10 rows per device/type without a blind
  100-row limit;
- initial/retro SQL cursors are bounded before large arrays are materialized by
  a shared 900,000-byte, 8,000-node, 2,000-document budget and a 24-level
  stored-document depth cap; this may deterministically truncate the older
  cursor tail, so removing the fixed 100-row limit is not an all-groups claim;
- polling status keeps the locked field set/order; API/careportal enabled,
  boluscalc disabled, and no active profile remain platform assumptions in this
  deployed slice;
- requiring exactly one object for `authorize` and `loadRetro` is a deliberate
  safety/resource tightening.


Final credential-free remote checks returned HTTP 200 for health, API v3
version and empty v1 Food JSON. API v3 Food and Settings returned the locked
HTTP 401 missing/bad-token envelope without a JWT. Protected generic CRUD/
history/rendering behavior remains locally covered. No protected remote
mutation or credentialed upload was attempted.

A fresh remote EIO4 polling session connected `/storage` independently and an
empty subscription received the exact locked missing-accessToken ACK. A second
fresh SID confirmed `/alarm` remains `Invalid namespace`. Local contracts cover
authorized rooms and event delivery on polling and hibernated WebSocket; the
remote pass does not claim credentialed event delivery or a homepage switch.

A real browser run rendered the official homepage and empty chart state without
warning/error. It then loaded the official Food Editor to `Database loaded`
with the expected anonymous read-only state.
The chartless Food page emitted two non-fatal official-bundle
`#chartContainer` warnings and no script errors. The public tenant has no
Entries, so the homepage's `---` value is expected. No authenticated Save or
protected mutation was attempted.

An earlier deployed version completed an authenticated Profile Editor save and
introduced the content-addressed shim/service-worker cache fix after reproducing
the original post-save redirect loop. This release did not repeat an
authenticated mutation, so the earlier result remains
historical regression context rather than evidence that the current protected
Profile/Food workflows are complete.

These observations prove only the named increment. They are not a full-port
completion claim.

## Contract-testing and delivery order

1. Use the generated route/test manifest as the dispatch list; manually confirm
   its heuristic route/test links and keep its locked-source-checked static and
   dynamic overlays current as implementation lands.
2. Build one SQLite collection contract that covers ObjectId/UUID, indexes,
   query operators, upsert, tombstones and last-modified fields.
3. Keep the adapted JWT/derived-credential/delay contracts green while adding
   failed-auth admin notification emission.
4. Port v1, then v2, then v3 modules in dependency order, reusing upstream
   calculation code rather than translating it by hand.
5. Replace the polling shim only after the implemented Engine.IO polling and
   direct-WebSocket root are joined by safe tenant propagation, polling upgrade
   if required by the official client, the page-used alarm namespace and real-
   browser tests.
6. Move tick/prune/plugin jobs to a persisted alarm task table.
7. Run the applicable upstream tests through the adapter, then execute local
   Workers tests, deployment dry-run, remote API smoke and real-browser flows.

No real CGM data, medical credentials, new medical algorithms or dosing advice
are permitted. The deployment remains simulated-data only.
