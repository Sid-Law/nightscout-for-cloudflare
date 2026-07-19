# Complete Nightscout port execution plan

Last synchronized: 2026-07-20

## Goal and fixed scope

The goal is the cleanest practical port of official Nightscout v15.0.7 to
Cloudflare Workers Free, SQLite Durable Objects and Workers Static Assets.
Official UI, layout, charts, interactions, client/server plugins, translations,
calculations and version identifiers are preserved wherever the runtime allows.
NSCF code belongs at platform boundaries.

Fixed exclusions:

- no D1, R2, KV, Queues or custom domain;
- no real CGM, pump or medical credentials and no real health data;
- no replacement UI or downstream branding in the Nightscout surface;
- no new medical algorithm, dosing logic or treatment recommendation;
- live external bridge/push delivery remains disabled in the simulated-data
  lab; mocked internal mapping, validation, deduplication, cancellation and
  multi-key contracts remain required.

First-release onboarding is limited to fresh NSCF deployments for new-family
use. No external Nightscout/MongoDB history importer is delivered in that
release. Users who require existing history in the new instance must not
switch yet. This product-scope deferral does not weaken the requirement for
safe, forward-compatible upgrades of existing NSCF Durable Object data.

## Evidence standard

A module is complete only when:

1. its upstream v15.0.7 files and tests are mapped;
2. runtime conflicts and platform adaptations are explicitly separated;
3. request, response, storage, authorization, error and real-time contracts are
   represented by Workers-runtime tests;
4. the complete local suite and deployment dry-run pass before deployment;
5. remote API smoke and a real-browser workflow pass after deployment;
6. the compatibility matrix and deployment record match the code.

Opening a page or serving an official asset does not satisfy this standard.

## Workstreams and status

| Workstream | Status | Next acceptance checkpoint |
| --- | --- | --- |
| 0. Upstream lock and clean vendor | Complete | Keep v15.0.7 commit/archive hash immutable until an explicit upstream update. |
| 1. Compatibility inventory | Tooling complete | Keep the generated 161-route/111-test manifest current; update a file from unresolved only with whole-file or complete adapted evidence. |
| 2. Official browser assets/pages | Partial | The deployed version has homepage polling, stable Settings close, prior authenticated Profile Save evidence, Admin/Food/Report/clock/Swagger renders and a real Split/multiframe HTML check. The current credential-free browser pass rendered homepage, Admin, Food, Profile and `clock-color`; Profile reached `Values loaded.`, Food reached `Database loaded`, and the locked app/clock bundles were present. Protected mutation/report and pushed-live-update workflows remain. |
| 3. SQLite collection compatibility | In progress | All six official API3 collections share the generic repository; v1 Food shares its identity/history and older Food rows receive idempotent metadata repair. `/storage` now atomically queues bounded frames for current subscribers without consuming the unbounded `document_changes` snapshot journal. Close Mongo mixed-type/nested parity and define journal retention/pruning separately. Entries uses a deliberate fresh-only reset for an incompatible pre-1.0 narrow shadow; it is not a legacy importer. |
| 4. API v1 | In progress; 15 locked files adapted | Entries now adapts its complete locked upstream file: ordered batch-prefix failure, preview, single/array/extended-urlencoded uploads, uploader identity, bounded query/sort, current/model/ID reads, representations/validators/HEAD, exact and dateString-range deletion, numeric-brace `times/echo`, `times` and `slice` fixtures. The complete locked Treatments file is mapped with fail-closed HTML sanitization, time/numeric normalization, UUID/identifier and AAPS dedupe behavior. Root, Status, AndroidAPS, Alexa, unauthorized and Loop/Trio batch files are also mapped. Complete non-Entries echo, bounded aggregation-pipeline parity, safe-attribute DOMPurify byte parity, the wider Mongo query/document surface and remaining v1 routes/test files. |
| 5. API v2 | Partial | JWT issuance/refresh, strict v2 Status, inherited v1 notification ACK/Treatments behavior, `/ddata/at`, property selection/pretty formatting and the summary SGV/treatment/target/temp-basal/profile mapper are deployed. The complete locked `ddata.test.js`, `bgnow.test.js` and `direction.test.js` files are adapted; `/properties` now uses the official four-bucket, interpolation, mmol-rounding and current-direction logic. The remaining plugin-derived properties and summary state (IOB/COB/BWP/ages/battery), summary persistence and the v2-only `/notifications/loop` integration remain; ddata uses a bounded two-day SGV window. |
| 6. API v3 | Locked 16-file test set adapted; platform hardening remains | Public `/version`, JWT-protected `/status`, all eight generic routes for each of the six official collections and six-collection `/lastModified` are implemented with locked JSON/CSV/XML rendering. All 16 locked `api3.*` files are completely represented by named Workers-runtime contracts, including create/update/patch/delete, shape handling, AAPS patterns, storage adapter/socket behavior, implicit HEAD and API CORS. Keep the hard 1,000-row Workers Free ceiling and configurable lower search/history limit explicit; finish large-response controls and broader Mongo mixed-type/nested/array differential parity. |
| 7. Authentication/admin | Core adapted; named gaps/hardening | Tenant JWT keys, eight-hour HS256 tokens, derived access-token/prefix matching, body/query/header credential order, live subject/role lookup, persisted per-IP delay, Shiro matching and `verifyauth` are implemented. The Workers boundary caps enforced delay at 60 seconds, failed-auth admin notification emission is missing, and repeated/bracket `secret` arrays are handled safely instead of reproducing the locked upstream unhandled rejection. |
| 8. Engine.IO/Socket.IO | Partial EIO4 polling + direct WebSocket | Strict EIO4 polling and direct Hibernatable EIO4 WebSocket are routed to tenant `EntryStore` DOs with persisted sessions/queues, heartbeat, SIO5 root CONNECT/read-only data events and the API3 `/storage` and `/alarm` namespaces. `/alarm` has locked subscription/auth/ACK behavior and a trusted notification outlet, but the server-side notification engine is missing. Complete the official-page switch only after safe tenant propagation and notification integration; close the direct-send at-most-once crash window, then add polling-to-WebSocket upgrade, EIO3 HTTP and root writes. |
| 9. Real-time storage updates | API3 `/storage` named slice implemented | Successful HTTP API3 mutations atomically enqueue official create/update/delete frames for authorized collection rooms; subscription/queue state survives DO eviction, v1 changes do not broadcast, and overflow/failure drops only the broken subscriber. Add main-namespace database updates and browser/credentialed remote workflows; keep the unbounded `document_changes` journal and its future retention policy distinct from the bounded live transport queue. |
| 10. Alarms/background tasks | Realtime/auth plus notification-ACK foundation | The DO's single Cloudflare alarm is derived from persisted realtime deadlines and authorization-failure cleanup and is idempotent across eviction/retry. Stale already-due platform alarms are replaced so a queued delivery cannot erase the only SQL wakeup. Socket.IO and inherited v1/v2 HTTP ACK share the same durable group/level transaction. Add a persisted multi-kind task table before API v3 pruning and server-plugin evaluation share the scheduler. |
| 11. Server plugins/notifications | Property foundation plus ACK/outlet | Stateless ports of the official `bgnow` and `direction` properties now feed v2; `/alarm` can publish trusted, already-computed notification objects, and Socket/HTTP ACK persist the same snooze state and exact all-clear broadcast. Build the official registry and tenant platform context, then port the remaining upstream plugin/data/notification calculation and persistence tests without rewriting formulas. |
| 12. Upstream regression suite | Tracked; 35 adapted files | Work through `docs/UPSTREAM_TEST_MANIFEST.md` in dependency order; all 16 API3 files, `notifications-api.test.js`, `ddata.test.js`, `bgnow.test.js`, `direction.test.js` and 15 v1 client/API files are adapted, 74 files remain unresolved and two are fixed-scope exclusions. |

## Generated dispatch map

`npm run upstream:audit` builds `upstream/contract-manifest.json` and
`docs/UPSTREAM_TEST_MANIFEST.md` from the locked route registration modules and
all 111 upstream test files. `npm run upstream:audit:check` is deterministic and
fails on duplicate routes, locked registration-source hash or static/dynamic
overlay drift, unknown auth/condition override targets, re-derived syntactic
mount-chain or exact source-anchor drift, count/status drift, unstable order,
or stale generated output. These anchors do not prove runtime reachability,
middleware order, execution, or coverage. Route/test links are heuristic
dispatch candidates; literal request paths are method-filtered when the method
is statically visible, while dynamic/textual/prefix/API3-filename cases still
require manual confirmation. `npm test` runs this check and the generator's own
Node tests before the Workers-runtime suite.

Dispatch upstream compatibility work in the generated numeric workstream order:

1. storage/query/identity foundations;
2. authorization;
3. API v1/v2;
4. plugins and calculations that can proceed on the collection contract;
5. API v3;
6. real-time transport;
7. background behavior and fixed-scope integrations;
8. UI and process-boundary workflows.

The manifest's two `excluded-fixed-scope` files cover only real-CGM bridges.
Tests that mock external notification delivery still specify required internal
mapping, validation, deduplication, cancellation and multi-key behavior.
Mongo-to-SQLite, Express-to-Worker, process-lifecycle, Socket.IO,
notification-state and browser adaptations remain required work and must not be
relabeled as scope exclusions.

## Current deployed increment

Integration commit and Git HEAD used by Wrangler
`094bdd9a206431e70f2c1ca1ff55ee768d11f4ac` ports the locked `bgnow` and
`direction` property-plugin contracts and wires them into v2 properties.
All prior v1, API3, authorization, realtime and notification-ACK contracts
remain green. Cloudflare Worker version
`c7237a55-e657-4648-b8de-78d434606f1b` is active at 100%; deployment
`254b8589-22cb-4ecc-b3c3-3383ed9815ad` was created at
`2026-07-19T20:38:27.40458Z` and Wrangler reported a 38 ms startup. It
processed 248 unchanged official asset entries; deployment and dry run
reported 948.79 KiB raw / 172.37 KiB gzip, and the dry run exposed only
`ENTRY_STORE` plus `ASSETS`. No deployed credential was read or supplied to
remote smoke. The 32-file Workers-runtime suite passed 308/308, both audit
suites passed 20/20, and TypeScript plus the official UI build completed
before deployment. The manifest now records 35 adapted, 74 unresolved and two
fixed-scope excluded files. These remain subset facts, not a full-port claim.

The new pure adapters reproduce the locked four five-minute buckets, per-bucket
mean/last/error fields, ordinary and over-nine-minute interpolated deltas,
mg/dl/mmol scaling and every tested direction character/entity. They preserve
the upstream current-data guard and do not introduce a Worker-global plugin
singleton. The prior property picker/pretty and summary mapper remain. IOB,
COB and BWP still serialize as `null`, while cage/sage/iage/bage/battery remain
absent until their official plugins are adapted; plugin state persistence is
still Milestone E work.

The new v1 contracts preserve Loop, Trio and AndroidAPS ordered batch response
shapes and pump/uploader metadata. Entries now implements exact numeric-date,
exact `dateString` and open `dateString`-range deletion plus the locked
numeric-brace `times/echo`, `times` and `slice` fixtures. Pattern compilation is
deliberately limited to eight literal prefixes, 256 expansions, 10,000
candidates per prefix and a reviewed linear regex subset. These are Workers
Free controls, not a claim that arbitrary JavaScript RegExp/Mongo behavior is
portable.

Treatments now maps the complete locked test file: XSS-bearing strings are
sanitized before persistence, zoned timestamps and numeric fields normalize as
upstream, UUID `_id` values become client identifiers, explicit AAPS identifiers
deduplicate, and query/bulk-delete plus server-ID lifecycle behavior are locked.
The Worker sanitizer keeps a reviewed safe tag set but strips all attributes;
it matches the locked malicious IMG fixture while intentionally remaining
stricter than DOMPurify for otherwise-safe attributes. The prior `preBolus`
two-record transaction, v1/v2 notification ACK, API3 collections, `/storage`,
`/alarm`, authorization, official pages and transport slices remain green.
Alexa compatibility is the mocked local REST/Speechlet contract only and makes
no external Amazon call.

Entries deliberately follows a fresh-only pre-1.0 policy. If activation finds
the old narrow `entries` shadow structurally incompatible, it resets that
shadow instead of attempting a risky partial import. Canonical documents and
other collections, including profile, are preserved. At 2026-07-18 14:51 UTC,
a read-only pre-deployment check found zero Entries and one profile in the
public lab; post-deployment remote reads confirmed the same counts. There was
therefore no old simulated Entry row to migrate on that tenant, and its profile
was preserved without recording its contents. This policy is acceptable for
the pre-1.0 simulated lab, but it is not a general migration path for an
existing Nightscout database.
Fresh deployment is the planned release path for the initial new-user/new-family
audience; an external legacy-history importer is not provided in the first
release and has no claimed delivery date. It means initially creating a new
Worker/SQLite DO namespace or using an empty tenant. A code redeploy to the
same Worker preserves Durable
Object data; it is not a database reset, so the current lab keeps its canonical
profile and other documents. This does not authorize real CGM/uploader/closed-
loop use: the deployed increment remains simulated-data only.

The Entries bounds are explicit: v1 defaults to a four-day date window;
realtime/ddata reads use two days; `dateString` and other unindexed candidate
sets stop with controlled HTTP 413 above 10,000 rows; synchronous delete and
per-document revision deletion are capped at 128; and `$re` accepts only the
bounded, case-sensitive subset that can be safely compiled to SQLite `GLOB`.
The v1 uploader additionally caps bodies at 512 KiB and batches at 100 items.
Within that batch each SQLite item is atomic, successful items before the first
conflict remain committed, and the suffix is not attempted, matching Mongo's
ordered bulk prefix rather than pretending the full request is atomic. Preview
and persistence share recursive string sanitization; Workers entity-encodes
HTML-like input because the locked JSDOM/DOMPurify runtime is not portable, so
existing entities are preserved across read-then-reupload while active markup
still cannot be stored. Treatments uses a separate safe-tag/all-attributes-
stripped adapter that matches the locked XSS fixture. Exact safe-attribute
DOMPurify bytes remain incomplete.

The ordinary compact-SGV path retains a requested count up to 10,000. A single
request selecting thousands of records that each contain abnormally large
custom fields is still materialized for RPC, sort, representation and ETag
generation and can approach the Workers Free CPU/memory boundary. This
extreme-request hardening is explicitly deferred; it is not counted as a
normal-family blocker and is not claimed solved.

The aggregate count is separate from that result cap: a one-year indexed
range can be counted without returning roughly 105,000 five-minute SGV rows.
Ordinary detail reads still cap one response at 10,000 and therefore require
date-partitioned requests for long exports. The locked `times/echo`, `times`
and `slice` fixtures now provide bounded dateString partition helpers; arbitrary
regex syntax, more than eight expanded prefixes and more than 10,000 candidates
per prefix are controlled platform differences.

The deployed increment includes:

- the locked official v15.0.7 UI/pages/assets with no replacement UI;
- one tenant-sharded SQLite Durable Object and Workers Static Assets only;
- page-used entries, food, profile, treatments, device-status, activity,
  role/subject/token subsets and aggregate REST polling;
- adapted v1/v2 Entries single/array/extended-urlencoded uploads, preview,
  uploader-owned sync identity, ordered batch-prefix failures, bounded indexed
  query/sort, current/model/ID reads and JSON/plain/CSV/TSV conditional GET/HEAD;
- bounded Entries `echo` plus SQL aggregate count for entries, treatments and
  device status, inherited by API v2;
- bounded numeric-brace Entries `times/echo`, `times` and dateString `slice`,
  plus exact/dateString-range delete selectors;
- v2 `/ddata/at` with the complete named upstream ddata helper contract,
  `/properties/<comma-list>` selection and truthy `pretty`, official
  `bgnow`/four-bucket/interpolated-`delta`/`direction` calculations, and
  `/summary/?hours=` SGV/treatment/target/temp-basal/current-profile mapping;
- locked Treatments POST `preBolus` two-record fan-out on both v1 and v2,
  atomic in SQLite, complete UUID/identifier/AAPS/query/delete contracts and a
  stricter fail-closed safe-tag sanitizer, with PUT retaining the one-record
  save contract;
- locked root version discovery, complete v1/v2 Status representations, local
  Alexa Speechlet requests, AndroidAPS metadata and Loop/Trio batch behavior;
- tenant-persisted eight-hour HS256 JWTs, live subject/role lookup, exact
  `shiro-trie` matching, `verifyauth`, API v3 `/version` and JWT-only `/status`;
- all eight generic API v3 routes for entries, treatments, device status,
  profile, food and settings,
  including branch-sensitive permissions, ordered search, conditional read,
  history, collection-specific legacy fallback/deduplication, lastModified,
  tombstones, permanent delete and atomic rollback; JSON/CSV/XML rendering uses
  the locked upstream dependency versions and Accept negotiation order;
- strict tenant-local EIO4 polling and direct Hibernatable WebSocket with
  persisted sessions/queues, heartbeat, SIO5 root CONNECT, read-only
  authorization/data snapshots and bounded resource handling; a SQL-derived
  Durable Object alarm survives eviction and drives ping, pong timeout,
  session/lease expiry, closure retry and client-count updates;
- a tenant-local API3 `/storage` namespace with subject access-token room
  authorization, persisted subscriptions and bounded create/update/delete
  delivery for successful API3 mutations only;
- a tenant-local API3 `/alarm` namespace with independent connection, native
  access-token and web secret/JWT/anonymous subscription branches, exact ACKs,
  persisted snooze state and bounded live delivery of the five locked alarm
  event names. The trusted publisher accepts precomputed notification objects;
  upstream plugin/notification generation is not part of this slice;
- inherited v1/v2 GET `/notifications/ack`, protected by
  `notifications:*:ack`, with exact `200 OK`, durable repeated suppression,
  Urgent-to-Warning snooze, Hibernation delivery and broken-recipient isolation.

Final credential-free remote smoke returned HTTP 200 for v2 selected/pretty
properties, v2 summary, API3 version, v1 Status and EIO4 polling. The public
tenant had no recent SGVs, so properties returned the expected empty shape; the
non-empty calculation paths are covered locally. No deployed
credential was read or sent. A real browser reloaded the current deployment
and loaded the official homepage, Admin, Food, Profile and `clock-color` pages
without protected writes. Profile reached `Values loaded.`, Food reached
`Database loaded`, and the official app/clock bundles were present before the
browser was returned home.

The code is still not a full port: non-Entries echo, arbitrary aggregation,
large-response CSV/XML resource adaptation, broader Mongo query/type parity,
WebSocket upgrade, EIO3 HTTP, root writes, main-namespace persisted change
broadcasts, the shared background-task scheduler, server plugins, notification
generation/processing, plugin-derived summary state and most upstream test
files remain incomplete.
The homepage still consumes the REST polling shim and does not yet use the
separate EIO4 server.

The deployed polling slice is intentionally bounded to 256 sessions per tenant,
128 queued packets and one 1,000,000-byte polling payload per session. It uses
25-second server pings, 20-second pong timeouts, strict non-binary request
shapes and request-time opportunity cleanup in batches of 32. Its persisted
single DO alarm also processes due heartbeat/session/lease work across
eviction and retry. Root authorization always ACKs `write:false` and
`write_treatment:false`. Initial
`dataUpdate` follows locked recent-device-status filtering, while `loadRetro`
uses the unfiltered runtime-normalized device-status loader over the same
one-day raw window. Cursor-based snapshot loading applies a shared deterministic
900,000-byte, 8,000-node, 2,000-document budget (and 24-level per-document
depth cap) in profiles/device-status/SGV/treatments/food priority order before
the Socket.IO frame is built. The fixed 100-status cutoff is gone, but reaching
that shared ceiling can still deterministically truncate the older cursor tail.
The websocket status shape is locked, but `apiEnabled:true`,
`careportalEnabled:true`, `boluscalcEnabled:false` and the absence of
`activeProfile` are current platform assumptions. Strict one-object
`authorize`/`loadRetro` validation is a named safety tightening.
Exact `application/octet-stream` POSTs close their SID and return a controlled
400/code-3 response. Small malformed UTF-8 follows replacement decode and
parser-close behavior; raw-byte versus replacement-expanded accounting at the
1,000,000-byte boundary remains a controlled P2 parity task.

## Ordered implementation milestones

### Milestone A — collection contract

1. Define a neutral collection repository interface from upstream Mongo calls.
2. Add SQLite schemas/indexes for every enabled collection.
3. Port ObjectId/UUID, type conversion, nested query, projection, sort, limit,
   upsert, dedupe and failure semantics.
4. Add `srvCreated`, monotonic `srvModified`, soft-delete tombstones and history.
5. Persist a change event in the same mutation turn.

This milestone is the dependency for the rest of API v3 and real-time updates.

### Milestone B — authorization parity

1. Store a random tenant JWT signing key in SQLite; never expose it.
2. Make `/api/v2/authorization/request/<accessToken>` issue an upstream-shaped
   signed JWT.
3. Verify JWT expiry/signature and reconstruct Shiro permission groups.
4. Port default roles, admin semantics, failure delay-list and status contracts.
5. Keep API_SECRET only as the bootstrap/admin credential and never log it.

Items 1–3 and the request-enforcement core of item 4 are complete. The deployed
adapter derives the upstream subject credential from API_SECRET/ObjectId,
preserves prefix lookup, extracts credentials from the locked query/header/body
precedence, and persists a bounded per-IP failure delay that shares the DO
alarm. Remaining work is failed-auth admin notification emission. The enforced
delay is capped at 60 seconds as a named Workers boundary difference.
Token-bearing authorization paths are redacted from adapter error logs.

### Milestone C — API completion

1. Finish v1 entries and document routes from Express registration and Swagger.
2. Finish the remaining plugin-derived v2 properties/summary state and
   persistence, the v2-only notification loop and remaining authorization
   surfaces. The ddata helper file, aggregate route, property picker/pretty
   mode, `bgnow`/`direction` property contracts and core summary mapper are
   deployed; inherited v1/v2 notification ACK is complete for its named
   adapted contract.
3. **Complete for the locked 16-file API3 contract set:** generic
   search/create/read/update/patch/delete/history, six-collection lastModified
   and byte-compatible small/medium JSON/CSV/XML rendering, plus shape, AAPS,
   storage adapter/socket, HEAD/CORS and configured lower paging-limit
   behavior. All 16 locked `api3.*` files are adapted. Complete bounded
   large-response handling and broader Mongo mixed-type/nested/array
   differential semantics before claiming unrestricted platform parity.
4. Port upstream API tests in module order and record any fixed-scope exclusion.

### Milestone D — real-time transport

1. **Complete for the named slice:** route exact `/socket.io` and `/socket.io/`
   polling requests to the tenant DO without intercepting the static
   `/socket.io/socket.io.js` shim asset.
2. **Partial:** EIO4/SIO5 polling sessions and direct Hibernatable WebSocket,
   server-ping/client-pong, persisted queues, root CONNECT and a SQL-derived DO
   alarm for ping/pong/session/lease/closure deadlines are implemented. API3
   `/storage` CONNECT, access-token room authorization and live mutation events
   are implemented on both current EIO4 transports. API3 `/alarm` CONNECT,
   native/web subscription authorization, ACK/silence persistence and the live
   notification outlet are also implemented on both current transports;
   inherited v1/v2 HTTP ACK commits through the same SQLite core.
   EIO3/SIO4 remains codec-only and is deliberately rejected by the HTTP
   endpoint; polling advertises `upgrades: []`.
3. Add the Engine.IO polling-to-WebSocket upgrade path; direct WebSocket open
   is already implemented and tested across DO eviction.
4. **Complete for the named `/storage` and `/alarm` transport slices:** preserve
   the tested persisted namespace/room/subscription behavior, exact alarm ACKs,
   live-only delivery and tenant isolation. The upstream notification producer
   remains Milestone E work; this transport milestone does not compute alarms.
5. Extend the implemented root `authorize` and `loadRetro` reads with the
   locked write handlers only after their exact permission, mutation and
   broadcast contracts are mapped.
6. **Complete for HTTP API3 `/storage` events:** create/update/delete frames are
   enqueued in the same transaction for current authorized subscribers. Add the
   separate locked main-namespace database-update behavior; v1 remains excluded
   from `/storage` by upstream contract.
7. Replace the REST polling shim with the official client only after protocol
   tests, safe tenant propagation, notification integration and real browser
   workflows pass.

### Milestone E — background/server behavior

1. Extend the existing realtime/auth-owned single alarm with a persisted SQLite
   task table so every job kind participates in one derived schedule.
2. Port failed-auth admin-notify emission and API v3 auto-prune; persisted
   failure-delay cleanup already shares the alarm.
3. Generate the official server plugin registry at build time.
4. Execute official dataloader/sandbox/plugin/notification modules through a
   persisted tenant context.
5. Make that engine consult the persisted `/alarm` ACK/silence rows before
   publishing through the existing trusted outlet; cover retry, eviction and
   all-clear behavior without inventing medical algorithms.
6. Keep external integrations disabled unless separately authorized and within
   the fixed simulated-data scope.

### Milestone F — page and upstream closure

1. Browser-test authenticated profile/food/admin mutations and report
   generation; preserve the deployed Split/clock render regressions.
2. Verify homepage charts/plugins update from a pushed real-time event.
3. Classify every upstream test file and make every applicable contract green.
4. Rebuild from the clean vendor snapshot and verify asset provenance.
5. Run full local checks, dry-run, deploy, remote API smoke and browser checks.

## Free-plan controls

- Keep ordinary HTTP work bounded for the Workers Free CPU budget; move
  coordination and stateful work to the tenant DO.
- Use indexed SQLite queries and explicit request/body/result limits.
- Use WebSocket Hibernation, not a permanently active connection loop.
- Schedule alarms only when persisted work is due.
- Preserve one DO per tenant rather than one global application bottleneck.
- Monitor `SQLITE_FULL`, overloaded DO and CPU-limit outcomes explicitly.

Current limits are verified from
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and
[Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
before changing resource assumptions.

## Deployment gate

Every deployment must run, in this order:

```sh
npm run build
npm run check
npm test
npm run deploy:dry
npm run deploy -- --keep-vars
```

After deployment:

1. smoke public status, the newly changed routes and known unsupported routes;
2. perform only simulated-data authenticated CRUD when the user-provided secret
   is available to the caller—never read or print the configured value;
3. use a real browser to check official UI network/console state and the changed
   workflow;
4. update `docs/DEPLOYMENT.md` and this plan with exact observed results.

## Rollback

The footprint remains one Worker, Workers Static Assets and the `EntryStore`
SQLite Durable Object namespace. Wrangler version rollback can restore Worker
code and assets, but neither rollback nor redeployment clears or rolls back the
SQLite Durable Object. NSCF's own forward-compatible schema activation remains
a release requirement even though importing an external MongoDB history is
deferred; never use destructive schema rollback on user data. No
D1/R2/Queue/custom-domain cleanup is needed because those resources are not
created.
