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

The current local suite has 17 Workers-runtime integration tests. The locked
upstream has 111 `*.test.js` files and approximately 873 `it(...)` cases. Those
numbers are not directly comparable, but they make clear why the current suite
does not prove full compatibility.

## What cannot run unchanged, and what only needs adaptation

| Upstream dependency | Evidence in v15.0.7 | Classification | Cloudflare path |
| --- | --- | --- | --- |
| Node HTTP server and Express | `lib/server/server.js:41-75` creates a Node server, calls `listen()`, attaches Socket.IO and starts a process-lifetime timer. | **Partly reusable, not an absolute blocker.** Current Workers support Node HTTP servers and an Express adapter, but this exact process bootstrap still assumes one permanent process. | Reuse upstream Express routers where they do not depend on process-global state; expose them through a Worker request handler or reproduce only their platform boundary. [Cloudflare Node HTTP](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/) and [Express tutorial](https://developers.cloudflare.com/workers/tutorials/deploy-an-express-app/). |
| File system and localization/assets | `lib/server/server.js:29-34`, `lib/language.js:149`, and `lib/server/app.js:129,254-255` read bundled files. | **Adaptable.** `node:fs` is now available through Workers' virtual file system. Runtime mutation and arbitrary host paths remain unsuitable. | Prefer build-time asset discovery and Static Assets; use bundled virtual files only where it reduces divergence. [Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) and [Static Assets binding](https://developers.cloudflare.com/workers/static-assets/binding/). |
| MongoDB connection and collections | `lib/storage/mongo-storage.js:105-221` creates a connection pool, retries forever, exposes `db.collection()` and creates indexes. | **Cannot run unchanged within the fixed platform scope.** This project deliberately has no Mongo service and must use SQLite Durable Objects. | Implement a Mongo-compatible repository contract over DO SQLite, including query conversion, indexes, collection behavior and migration tests. [SQLite-backed DO storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/). |
| Mongo ObjectId and query semantics | `lib/server/query.js:28-175`, `lib/server/entries.js`, `lib/server/treatments.js` and `lib/authorization/storage.js` depend on ObjectId, nested Mongo operators, sort, projection and upsert behavior. | **Engineering adaptation.** ObjectId formatting is easy; behavioral parity is not. | Preserve 24-hex identity and UUID fallback rules, then port operators and collection-specific dedupe as contract-tested SQL/JSON operations. |
| Process-global bus and mutable caches | `lib/bus.js:4-36`, `lib/server/bootevent.js:271-330`, `lib/notifications.js` and `lib/adminnotifies.js` keep timers, listeners and alarm state in memory. | **Runtime lifecycle conflict.** Workers and DOs may be evicted and reconstructed. | Persist authoritative state in SQLite, rebuild caches on activation, and make mutations idempotent. |
| Socket.IO / Engine.IO | `lib/server/websocket.js:87-164` attaches Socket.IO to the Node server with EIO3, polling and WebSocket transports; later handlers implement authorization and database mutations. | **Server-model conflict, but solvable.** The current polling shim is not a Socket.IO server. | Implement Engine.IO/Socket.IO framing and namespaces on a tenant DO using the WebSocket Hibernation API, plus polling compatibility and mutation broadcasts. [DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/). |
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
| Collections and indexes | `lib/storage/mongo-storage.js`, server storage modules | **Partial.** SQLite tables cover SGV entries plus generic documents for food, profile, treatments, devicestatus, activity, roles and subjects. | Explicit schema/index map for every upstream collection; migration, concurrency and failure tests. |
| ObjectId, UUID and dedupe | `lib/server/query.js`, entries/treatments/activity storage modules | **Partial.** Generated IDs are random 24-hex strings; entry UUID fallback and timestamp/type dedupe exist. They are not BSON ObjectIds. | Fixtures for all upstream ID, upsert, immutable `_id`, duplicate and partial-failure cases. |
| Mongo query behavior | `lib/server/query.js`, `lib/api3/storage/mongoCollection/**` | **Partial.** Equality, nested fields, `$gt/$gte/$lt/$lte/$ne/$exists/$in` and one sort are supported for generic documents. | Operator/type/projection/regex/logical-query matrix against upstream fixtures; SQL index plan and bounded-cost checks. |
| API v1 entries | `lib/api/entries/index.js`, `lib/server/entries.js` | **Partial.** SGV create/list/current/delete and a date filter subset exist. Other entry types, preview, echo, times, count, slice, formats and historical errors do not. | Port upstream entries API tests and shape/ID/flakiness cases. |
| API v1 document CRUD | food/profile/treatments/devicestatus modules | **Partial.** Page-used JSON CRUD exists with bounded filters. | Port every route, content type, batch, conditional request, validation and error variant. |
| API v1 activity | `lib/api/activity/index.js`, `lib/server/activity.js`, `tests/api.activity.test.js` | **Compatible subset implemented locally.** Create/list/filter/conditional GET/update/delete and empty-array create now follow the upstream shapes. | Remote authenticated create/read/update/delete smoke after deployment; expand remaining upstream shape tests. |
| Remaining API v1 | notifications, Alexa, Google Home and entries utility routes | **Missing or partial.** `adminnotifies` is a hard-coded empty response. | Route inventory from Express registration plus contract tests for each enabled/scope-allowed route. External integrations remain disabled in the simulated-data deployment. |
| API v2 properties and ddata | `lib/api2/index.js`, `lib/data/endpoints.js`, `lib/api2/properties.js` | **Partial.** Clock properties and one aggregate page payload exist; the complete data transformation/delta contract does not. | Compare official client fixtures and all ddata/property fields, retro behavior and errors. |
| API v2 authorization | `lib/authorization/**` | **Partial and not JWT-compatible.** Role/subject CRUD and opaque access tokens exist, but `/authorization/request` does not yet issue upstream JWTs and historical permission/delay-list behavior is absent. | Deterministic tenant signing-key storage, JWT issue/verify/expiry tests, complete Shiro permission and failure-delay fixtures. |
| API v2 summary/notifications | `lib/api2/summary/**`, `lib/api2/notifications-v2.js` | **Missing.** | Reuse upstream processors without adding medical logic; add notification acknowledgement/persistence tests. |
| API v3 version | `lib/api3/specific/version.js`, `lib/api3/shared/storageTools.js`, `tests/api3.basic.test.js` | **Compatible envelope implemented locally.** Returns Nightscout/API version, server time and SQLite adapter metadata. | Remote GET smoke after deployment. |
| API v3 generic/status/history | `lib/api3/generic/**`, `specific/status.js`, `specific/lastModified.js` | **Missing.** Swagger is present but runtime CRUD, patch, history, tombstones, formats, JWT security and conditional headers are not. | Port all upstream `api3.*.test.js` workflows before claiming v3 support. |
| Main Socket.IO namespace | `lib/server/websocket.js` | **Missing.** `platform/socket-io-polling-shim.js` only polls REST every 15 seconds and fabricates client events. A real EIO3 polling handshake currently returns 404. | Engine.IO polling/WebSocket handshake, authorize/loadRetro/dbAdd/dbUpdate/dbRemove, acknowledgements, reconnect and multi-client broadcast tests. |
| API v3 storage/alarm namespaces | `lib/api3/storageSocket.js`, `lib/api3/alarmSocket.js` | **Missing.** | Namespace authorization, room subscription, create/update/delete events and alarm lifecycle tests. |
| Real-time database updates | `lib/server/bootevent.js:271-330`, websocket and API3 storage socket | **Missing.** Writes persist but do not push real-time deltas; the browser discovers them on the next poll. | Persist-then-broadcast transaction design and tests across DO eviction/reconnect. |
| Background tick and pruning | `lib/bus.js`, `lib/api3/generic/collection.js:127-163` | **Missing.** | One-alarm task table, retry/idempotency tests and bounded Free-plan scheduling. |
| Server plugins and calculations | `lib/plugins/index.js`, `lib/sandbox.js`, `lib/data/dataloader.js` | **Missing server execution.** Official client plugins/calculations are bundled, but server plugin properties/notifications are not computed. | Run official modules through a platform context; port upstream plugin/data tests without inventing algorithms. |
| Notifications/admin state | `lib/notifications.js`, `lib/adminnotifies.js`, push modules | **Missing persistence and processing.** | SQLite state model, alarm/ack/snooze tests, eviction tests and scope review for external push providers. |
| Official page workflows | `views/**`, browser client/admin/report modules | **Partial.** Profile Editor loads, its authenticated Save persists a current profile, and closing it returns to a homepage that consumes that profile without the basal missing-profile redirect. The polling adapter is content-addressed so the upstream service worker cannot retain an older payload contract. The remaining page workflows are not proven by HTTP 200. | Browser scenarios for profile delete, food, admin, report, clock, split and live updates, with console/network assertions. |
| Upstream test tracking | `tests/**`, `package.json` test scripts | **Partial.** 17 adapter tests pass; the upstream Mongo-backed suite has not been made green against the DO adapter. | Maintain a test manifest: pass, adapted pass, intentionally excluded by fixed scope, or unresolved—with a reason for every upstream test file. |

## Current deployed evidence

The public deployment at
`https://nscf-phase1.nscf-lab-20260717.workers.dev/` was rechecked on
2026-07-18 after version `87b53ac1-ded3-4afa-8b45-ea6b9830a673` reached
100% traffic:

- `/`, `/admin/`, `/profile/`, `/food/`, `/report/` and
  `/clock/clock-color/` returned HTTP 200.
- `/api/v1/status.json`, `/api/v1/entries.json`, `/api/v2/properties` and
  `/api/v2/ddata/at` returned HTTP 200.
- `/api/v3/version` returned HTTP 200 with the v15.0.7/API 3.0.3-alpha
  envelope and SQLite DO adapter metadata.
- `/api/v1/activity?count=2` returned HTTP 200 and an empty list for the
  simulated default tenant.
- A real `/socket.io/?EIO=3&transport=polling` handshake still returned HTTP
  404, as the matrix requires until Engine.IO is implemented.
- A real Chrome session loaded the official Profile Editor from `Not loaded`
  to `Values loaded`. Its already-authorized browser session completed a real
  profile Save, and the current-profile API confirmed persistence.
- The same existing browser originally reproduced a post-save loop: the
  upstream service worker still served an old adapter that omitted `profiles`,
  so the official basal plugin warned that no treatment profile existed and
  redirected back to `/profile`. The deployed content-addressed adapter
  bypassed that old cache without manual clearing. Repeating the exact
  `/profile` → `X` workflow stayed at `/`, showed no dialog or redirect, and
  rendered `BASAL 0.100U` from the saved profile.
- Its data connection still came from the polling shim, not a Socket.IO server.
- The existing `API_SECRET` was retained with `--keep-vars` and used only by
  the official browser's existing authentication state; its value was never
  inspected or printed. Credentialed activity CRUD remains a local contract
  test rather than a fabricated remote result.

These observations prove only the named increment. They are not a full-port
completion claim.

## Contract-testing and delivery order

1. Inventory every upstream Express and API v3 route and map it to a fixture.
2. Build one SQLite collection contract that covers ObjectId/UUID, indexes,
   query operators, upsert, tombstones and last-modified fields.
3. Complete JWT authorization before secured API v3 operations.
4. Port v1, then v2, then v3 modules in dependency order, reusing upstream
   calculation code rather than translating it by hand.
5. Replace the polling shim only after Engine.IO polling, WebSocket and
   namespaces pass protocol tests on a tenant DO.
6. Move tick/prune/plugin jobs to a persisted alarm task table.
7. Run the applicable upstream tests through the adapter, then execute local
   Workers tests, deployment dry-run, remote API smoke and real-browser flows.

No real CGM data, medical credentials, new medical algorithms or dosing advice
are permitted. The deployment remains simulated-data only.
