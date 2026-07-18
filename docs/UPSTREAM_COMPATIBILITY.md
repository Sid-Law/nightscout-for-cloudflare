# Upstream compatibility matrix

Last audited: 2026-07-18

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

Local integration commit `d8e406d13b87b2e304b1db4dc075af18ae463022`
passes 215/215 tests across 18 Workers-runtime files. The suite includes focused
EIO4 polling/direct-Hibernatable-WebSocket protocol, persisted session,
HTTP-boundary, eviction, authorization, tenant-isolation and resource-cap
contracts in addition to strict v1/v2 Status, API v3
entries/treatments/device-status, storage and official-page tests. This is not
deployment evidence; the public Worker still runs the older commit recorded in
`DEPLOYMENT.md`. The locked
upstream has 111 `*.test.js` files and approximately 873 `it(...)` cases. Those
sets are not directly comparable, and the local suite does not prove full
compatibility.

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
| Socket.IO / Engine.IO | `lib/server/websocket.js:87-164` attaches Socket.IO with polling and WebSocket transports. The official 4.5.4 browser bundle uses EIO4/SIO5; `allowEIO3` retains EIO3/SIO4 legacy clients. Later handlers implement authorization and database mutations. | **Partial platform adaptation.** Persisted EIO4 polling and direct Hibernatable WebSocket read-only-root slices run on the tenant DO in the local candidate, separately from the homepage REST shim. This is not a polling-upgrade, namespace/write or broadcast completion. | Add the page-required namespace/tenant behavior before switching the static client; implement polling-to-WebSocket upgrade, EIO3 if retained and persisted change delivery. [DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/). |
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
| Collections and indexes | `lib/storage/mongo-storage.js`, server storage modules | **Partial.** SQLite generic documents cover entries, treatments and device status with indexed collection metadata, an API3 allocation clock and atomic change snapshots. Entries has date/dateString/type indexes plus a narrow compatibility shadow. Its v6 probe resets only an incompatible pre-1.0 shadow and preserves canonical documents/profile; it is deliberately not a legacy importer. Healthy activation is a read-only probe. | Extend the repository and migration/failure fixtures to food/profile/settings; define a real import path separately if post-1.0 compatibility ever requires it. |
| ObjectId, UUID and dedupe | `lib/server/query.js`, `lib/server/treatments.js`, `lib/api3/storage/mongoCollection/utils.js` | **Partial three-collection slice.** Generated IDs are random 24-hex strings. V1 Entries and treatments preserve their locked identifier/ObjectId/type-specific selector order; UUID and identifier/fallback retransmits preserve the server ID. API v3 fallback requires identifier-field absence where the locked collection does. Arbitrary body `_id` is not an overwrite selector, and exact 24-hex collisions fail without replacing an existing row. IDs are not BSON ObjectIds. | Add duplicate-row, batch/partial-failure and every-collection fixtures; the atomic two-document `preBolus` fan-out remains unported and carbs are retained until it exists. |
| Mongo query behavior | `lib/server/query.js`, `lib/api3/storage/mongoCollection/**` | **Partial.** V1 Entries/treatments push their supported date/type/scalar filters, ordering and limits into SQLite; Entries keeps the four-day default and distinct string `dateString`. API3 implemented collections support locked scalar operators, safe nested/unknown fields, projection/paging, ordered sort chains and a bounded case-sensitive `$re` subset compiled to GLOB. Unsupported regex constructs and unsafe/over-limit SQL fail closed. SQLite/Mongo mixed-type, array, projection and collation parity remains unproven. | Build a broader regex and mixed-type/array differential matrix before calling generic search compatible. Other v1 collections still use limited filtering. |
| API v1 entries | `lib/api/entries/index.js`, `lib/server/entries.js` | **Substantial partial slice.** Create/list/current/model/delete cover SGV/MBG/other types, locked ID and date/dateString behavior, four-day default reads, controlled 10,000-candidate failures and 128-row/revision delete bounds. Preview, echo, times, count, slice, all formats and some historical errors remain incomplete. | Port the remaining upstream Entries utilities and whole-file shape/error contracts; keep the fresh-only pre-1.0 reset explicit. |
| API v1 document CRUD | food/profile/treatments/devicestatus modules | **Partial.** Page-used JSON CRUD exists with bounded filters. Treatments keep legacy materialization and mutation rules: `isValid:false` remains visible, `srv*` is not synthesized, read-only flags do not block v1 PUT/DELETE, numeric values, conditional GET and empty-array POST follow the locked shapes, and `/api/v2/ddata` keeps its raw legacy body. | Port every remaining route, content type, batch, validation and error variant; implement the atomic `preBolus` fan-out. |
| API v1 activity | `lib/api/activity/index.js`, `lib/server/activity.js`, `tests/api.activity.test.js` | **Compatible subset implemented locally.** Create/list/filter/conditional GET/update/delete and empty-array create now follow the upstream shapes. | Remote authenticated create/read/update/delete smoke after deployment; expand remaining upstream shape tests. |
| Remaining API v1 | notifications, Alexa, Google Home and entries utility routes | **Missing or partial.** `adminnotifies` is a hard-coded empty response. | Route inventory from Express registration plus contract tests for each enabled/scope-allowed route. External integrations remain disabled in the simulated-data deployment. |
| API v2 properties and ddata | `lib/api2/index.js`, `lib/data/endpoints.js`, `lib/api2/properties.js` | **Partial.** Clock properties and one aggregate page payload exist; canonical Entry loading uses a bounded two-day realtime/ddata window, distinct from v1's four-day default. The complete data transformation/delta contract does not. | Compare official client fixtures and all ddata/property fields, retro behavior and errors. |
| API v1/v2 Status | `lib/api/status.js`, v1/v2 router mounting and final error chain | **Strict named surface locally, with one transport P2.** Locked extension/Accept negotiation, txt/json/js/png/svg paths, redirects, uppercase/trailing-path bugs, GET/HEAD representation lengths, method finalhandler behavior, query-only `authorized` derivation and production 406/404 bodies are contract-tested. Local Wrangler preserved the 406 `Content-Length`; its network adapter may still send the HTML finalhandler 404 chunked. | Repeat public format/error smoke after deployment, including the HTML 404 transfer boundary; do not infer other v1/v2 route compatibility. |
| API v2 authorization | `lib/authorization/**`, `lib/api/verifyauth.js` | **Core adapted with named differences/hardening.** Role/subject CRUD, per-tenant signing keys, eight-hour HS256 issuance/refresh, derived access tokens and prefix matching, body/query/header precedence, signature/expiry verification, live role lookup, persisted per-IP failure delay, Shiro 0.4.10 and `verifyauth` are implemented. Enforced delay is capped at 60 seconds, a failed attempt does not yet emit the upstream admin notification, and repeated/bracket `secret` arrays are safely resolved or rejected instead of reproducing the locked unhandled rejection. | Add admin-notify emission/cleanup contracts; preserve the 60-second platform cap and array hardening as explicit differences and repeat remote auth smoke. |
| API v2 summary/notifications | `lib/api2/summary/**`, `lib/api2/notifications-v2.js` | **Missing.** | Reuse upstream processors without adding medical logic; add notification acknowledgement/persistence tests. |
| API v3 version/status | `lib/api3/specific/version.js`, `specific/status.js`, `security.js`, `tests/api3.basic.test.js` | **Compatible named subset.** `/version` is public; `/status` requires a valid tenant JWT and returns the locked v15.0.7 error/envelope shapes. Its permission-loop bug is preserved: every collection is evaluated against `api:undefined:<action>`, so a readable JWT reports `r` for all six registry keys. | Local valid/missing/bad/eviction/cross-tenant JWT contracts plus remote missing/bad-token smoke; do not infer generic API support from this endpoint. |
| API v3 generic collections/lastModified/history | `lib/api3/generic/**`, `specific/lastModified.js`, `shared/renderer.js` | **Partial three-collection vertical.** Entries joins the 16 treatments/device-status routes, and all three contribute independently to `/lastModified`. JWT auth, conditional headers, transactional permission selection, collection-specific dedupe, soft/permanent delete, ordered sort, both history cursors and locked JSON/CSV/XML are wired. Entries also supplies controlled 10,000-candidate/128-delete bounds and the safe `$re` subset. | Add food, profile and settings; implement large-result CPU/memory adaptation, broader mixed-type/nested/regex parity and whole-file upstream API3 execution. Do not mark any complete `api3.*` test file adapted from this named slice alone. |
| Main Socket.IO namespace | `lib/server/websocket.js` | **Partial read-only EIO4 polling + direct WebSocket slice.** Exact `/socket.io` and `/socket.io/` requests route to tenant DOs. Persisted sessions/queues, heartbeat, SIO5 root CONNECT, `clients`, read-only authorize/dataUpdate/ACK and loadRetro are tested across polling, direct Hibernatable WebSocket, eviction and tenant boundaries. A SQL-derived alarm persists ping/pong/session/poll/POST/closure deadlines. The official page still loads the REST shim; polling upgrade is not implemented, and a crash between durable dequeue and direct `send()` can lose one frame. | Switch the page only after safe tenant propagation and `/alarm`; close the at-most-once crash window, then add polling-to-WebSocket upgrade, EIO3 HTTP if retained, root writes, persisted-change broadcasts and browser workflows. |
| API v3 storage/alarm namespaces | `lib/api3/storageSocket.js`, `lib/api3/alarmSocket.js` | **Missing.** | Namespace authorization, room subscription, create/update/delete events and alarm lifecycle tests. |
| Real-time database updates | `lib/server/bootevent.js:271-330`, websocket and API3 storage socket | **Partial persistence only.** Implemented generic mutations persist `document_changes` atomically with the current document, including rollback-on-change-failure coverage. No transport consumes or broadcasts those rows; the browser still polls. | Define cursors/retention and broadcast only after commit; test eviction, reconnect and multi-client delivery. |
| Background tick and pruning | `lib/bus.js`, `lib/api3/generic/collection.js:127-163` | **Realtime/auth alarm foundation only.** The DO single alarm derives transport heartbeat/session/lease/closure work and authorization-failure cleanup from SQLite and is retry-idempotent. API3 pruning and plugin ticks are not scheduled. | Add a persisted multi-kind task table that shares the one alarm, with retry/idempotency and bounded Free-plan scheduling tests. |
| Server plugins and calculations | `lib/plugins/index.js`, `lib/sandbox.js`, `lib/data/dataloader.js` | **Missing server execution.** Official client plugins/calculations are bundled, but server plugin properties/notifications are not computed. | Run official modules through a platform context; port upstream plugin/data tests without inventing algorithms. |
| Notifications/admin state | `lib/notifications.js`, `lib/adminnotifies.js`, push modules | **Missing persistence and processing.** | SQLite state model, alarm/ack/snooze tests, eviction tests and scope review for external push providers. |
| Official page workflows | `views/**`, browser client/admin/report modules | **Partial.** An earlier deployed increment provided authenticated Profile Save/close regression evidence. The currently deployed version renders Profile, Admin, Food, Report and the color clock, but its latest browser pass did not authenticate or repeat a protected Save; their mutations/report generation and live-update workflows are not complete. The polling adapter is content-addressed so the upstream service worker cannot retain an older payload contract. | Re-run authenticated Profile Save on the current candidate, then add profile delete, food/admin mutations, report generation, split/clock updates and pushed live updates with console/network assertions. |
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

### API v3 implemented-collection controlled differences

The entries/treatments/device-status verticals keep the route, JWT,
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
- `/lastModified` exposes entries, treatments and device status; food, profile
  and settings are not implemented through generic API v3.

Extension middleware is not collapsed into renderer support. The adapter uses
the locked `mime` 2.6.0 table: malformed JSON fails before extension handling;
unknown MIME extensions return 406 before route authentication; known MIME
extensions are stripped and can reach JSON write handlers. Resolved
`application/json` aliases, including `.map` and `.JSON`, use the JSON renderer.
Known unsupported read formats authenticate/query first and then return the
controlled renderer 406. Negotiated responses and renderer-generated 406
responses vary on `Accept`. The 512 KiB and query-limit errors are platform
controls, not upstream claims.

## Current local integration evidence (not deployed)

Commit `d8e406d13b87b2e304b1db4dc075af18ae463022` passes 215/215 tests in
18 Workers-runtime files. It combines the strict v1/v2 Status contract,
derived/body credential and persisted-delay authorization work, direct
Hibernatable EIO4 WebSocket, and API v3 Entries as the third collection. Final
official build and Wrangler dry-run passed: 248 assets, 764.00 KiB raw / 135.65
KiB gzip, and only the `ENTRY_STORE` and `ASSETS` bindings. A new Cloudflare
version, remote API/direct-WS smoke and browser workflows remain release gates;
none is inferred from the local count.

Entries is fresh-only for the pre-1.0 lab. An incompatible old narrow
`entries` shadow is reset without importing its rows, while canonical documents
and profile remain untouched. At 2026-07-18 14:51 UTC, read-only checks against
the public instance returned an empty array from
`/api/v1/entries.json?count=10000` and a one-element array from
`/api/v1/profile.json`. Thus this specific deployment has no simulated Entry
row to lose and has one profile to preserve; no profile content was inspected
or copied into this record.
The deferred work is importing an external legacy Nightscout/MongoDB history.
It does not defer correctness of NSCF's own forward-only SQLite schema
activation. Redeploying the current Worker preserves that namespace; the
planned fresh-family path instead starts with a new Worker/DO namespace or an
empty tenant.

The local candidate uses the one-alarm-per-DO design for both realtime
deadlines and authorization-delay cleanup. On Workers Free, SQLite row reads,
row writes and index maintenance remain account-wide daily resources, and each
`setAlarm()` call counts as a write. The candidate therefore bounds unindexed
Entries candidates at 10,000 with controlled 413, synchronous deletion/history
cleanup at 128, and `$re` to the safe GLOB-compilable subset.

## Current deployed evidence

The read-only EIO4 polling server described above is deployed in code commit
`0319a8d5e78fc77c4c53c0a94724b706d7ec8255`, Cloudflare Worker version
`e8e7970b-65bb-412f-ba74-193ce14575c5`. It remains separate from the homepage
REST shim. Its current bounds and named differences are:

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
  `/alarm` return `CONNECT_ERROR`, while root `subscribe` and every write event
  remain unhandled;
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

The public deployment at
`https://nscf-phase1.nscf-lab-20260717.workers.dev/` reached 100% traffic at
2026-07-18 08:13:13 UTC. Its gate completed the official v15.0.7 build with
248 asset entries, the 161-route/111-test-file audit, 14/14 audit-tool tests,
141/141 integrated Workers tests, and a 651.05 KiB raw / 113.32 KiB gzip dry
run declaring only `ENTRY_STORE` and `ASSETS`.

- `/`, `/admin`, `/profile`, `/food`, `/report` and `/clock/clock-color`
  returned HTTP 200 and rendered official Nightscout surfaces.
- `/api/v1/entries.json` returned HTTP 200. `/api/v3/version` returned the
  v15.0.7/API 3.0.3-alpha envelope and SQLite DO adapter metadata.
- Missing-JWT `/api/v3/status`, `/api/v3/treatments` and
  `/api/v3/devicestatus` returned HTTP 401; an unknown device-status extension
  returned HTTP 406.
  Valid JWT, permission, mutation, expiry, tamper, eviction and cross-tenant
  contracts remain covered locally; this smoke did not invent an authenticated
  remote mutation.
- A real EIO4 polling handshake advertised no upgrades, a 25-second ping
  interval, 20-second timeout and 1,000,000-byte maximum. SIO5 root CONNECT and
  read-only authorize completed, and the following poll contained
  `dataUpdate`, `status` and an ACK with read true/write false. A subsequent
  poll held for 26 seconds received the alarm-driven ping; pong and close
  completed with HTTP 200.
- The in-app browser rendered the official homepage/chart and version 15.0.7;
  closing Settings did not rebound. Admin, Report and color clock rendered.
  Profile and Food rendered their official editors; the immediate snapshot
  showed initial `Not loaded` text while authentication was `Unauthorized`.
  Direct remote reads of both page-data endpoints returned HTTP 200, including
  the stored simulated profile, so this is an unverified credentialed-save
  workflow rather than evidence of a failed read API.
- The homepage data connection still came from the REST polling shim; the new
  EIO4 endpoint was exercised separately.
- The existing `API_SECRET` was retained unchanged with `--keep-vars`; its
  value and browser credential storage were never inspected or printed.

An earlier deployed version completed an authenticated Profile Editor save and
introduced the content-addressed shim/service-worker cache fix after reproducing
the original post-save redirect loop. The current release was not authenticated
in the browser and did not repeat that mutation, so the earlier result remains
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
