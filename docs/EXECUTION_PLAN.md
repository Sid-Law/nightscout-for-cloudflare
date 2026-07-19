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
| 2. Official browser assets/pages | Partial | The deployed version has homepage polling, stable Settings close, loaded Profile Values, Admin/Food/Report/clock/Swagger renders and a real Split/multiframe HTML check. The current homepage and Food Editor load successfully; Food reached `Database loaded` anonymously. The locked chart module logs its known missing-`#chartContainer` warning on the non-chart Food page, but no console error occurred. Protected mutation/report and pushed-live-update workflows remain. |
| 3. SQLite collection compatibility | In progress | All six official API3 collections share the generic repository; v1 Food shares its identity/history and older Food rows receive idempotent metadata repair. `/storage` now atomically queues bounded frames for current subscribers without consuming the unbounded `document_changes` snapshot journal. Close Mongo mixed-type/nested parity and define journal retention/pruning separately. Entries uses a deliberate fresh-only reset for an incompatible pre-1.0 narrow shadow; it is not a legacy importer. |
| 4. API v1 | In progress | Entries now adapts ordered batch-prefix failure, preview and idempotent conservative recursive sanitization, single/array/extended-urlencoded uploads, non-ObjectId uploader identity, a bounded numeric/string query-and-sort subset with controlled SQL-limit errors, current/model/ID reads, JSON/plain/CSV/TSV, runtime-SGV/result IMS, validators and HEAD. Bounded Entries echo plus direct SQLite count for entries/treatments/device status are deployed; Activity CRUD, authenticated GET `/notifications/ack`, and Treatments POST `preBolus` fan-out are implemented. Complete times/echo, times, slice, non-Entries echo, bounded aggregation-pipeline parity, exact DOMPurify output, the wider Mongo query/document surface and the remaining routes. |
| 5. API v2 | Partial | JWT issuance/refresh, strict v2 Status, inherited v1 notification ACK and inherited Treatments `preBolus` create behavior are implemented; complete summary, the v2-only `/notifications/loop` external integration contract and full ddata/properties behavior. Ddata/realtime entry reads use a separate two-day window, while v1 Entries keeps the locked four-day default. |
| 6. API v3 | Partial; six upstream files adapted | Public `/version`, JWT-protected `/status`, all eight generic routes for each of the six official collections and six-collection `/lastModified` are implemented with locked JSON/CSV/XML rendering. `basic`, `generic.workflow`, `read`, `renderer`, `search` and `security` are completely represented by named Workers-runtime contracts, alongside implicit HEAD, API CORS and configurable lower search/history limits under a hard 1,000-row Free-plan ceiling. Ten `api3.*` files remain unresolved; add create/update/patch/delete/shape/storage/AAPS/socket whole-file evidence, large-response controls and broader mixed-type/nested parity. |
| 7. Authentication/admin | Core adapted; named gaps/hardening | Tenant JWT keys, eight-hour HS256 tokens, derived access-token/prefix matching, body/query/header credential order, live subject/role lookup, persisted per-IP delay, Shiro matching and `verifyauth` are implemented. The Workers boundary caps enforced delay at 60 seconds, failed-auth admin notification emission is missing, and repeated/bracket `secret` arrays are handled safely instead of reproducing the locked upstream unhandled rejection. |
| 8. Engine.IO/Socket.IO | Partial EIO4 polling + direct WebSocket | Strict EIO4 polling and direct Hibernatable EIO4 WebSocket are routed to tenant `EntryStore` DOs with persisted sessions/queues, heartbeat, SIO5 root CONNECT/read-only data events and the API3 `/storage` and `/alarm` namespaces. `/alarm` has locked subscription/auth/ACK behavior and a trusted notification outlet, but the server-side notification engine is missing. Complete the official-page switch only after safe tenant propagation and notification integration; close the direct-send at-most-once crash window, then add polling-to-WebSocket upgrade, EIO3 HTTP and root writes. |
| 9. Real-time storage updates | API3 `/storage` named slice implemented | Successful HTTP API3 mutations atomically enqueue official create/update/delete frames for authorized collection rooms; subscription/queue state survives DO eviction, v1 changes do not broadcast, and overflow/failure drops only the broken subscriber. Add main-namespace database updates and browser/credentialed remote workflows; keep the unbounded `document_changes` journal and its future retention policy distinct from the bounded live transport queue. |
| 10. Alarms/background tasks | Realtime/auth plus notification-ACK foundation | The DO's single Cloudflare alarm is derived from persisted realtime deadlines and authorization-failure cleanup and is idempotent across eviction/retry. Stale already-due platform alarms are replaced so a queued delivery cannot erase the only SQL wakeup. Socket.IO and inherited v1/v2 HTTP ACK share the same durable group/level transaction. Add a persisted multi-kind task table before API v3 pruning and server-plugin evaluation share the scheduler. |
| 11. Server plugins/notifications | ACK/outlet only | `/alarm` can publish trusted, already-computed notification objects; Socket and HTTP ACK persist the same snooze state and exact all-clear broadcast. Build the official registry and tenant platform context, then port upstream plugin/data/notification calculation and persistence tests without rewriting formulas. |
| 12. Upstream regression suite | Tracked; seven adapted files | Work through `docs/UPSTREAM_TEST_MANIFEST.md` in dependency order; six API3 files plus `notifications-api.test.js` are adapted, 102 files remain unresolved and two are fixed-scope exclusions. |

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
`cda832688bb9a85c0feb93c0618d8932baa3e5a5` adapts the complete locked API3
generic workflow, read, renderer and security files on top of the prior
basic/search, Treatments, notification ACK, `/alarm`, `/storage`,
six-collection API3, Entries, authorization and EIO4 slices. It also keeps
read-only DELETE validation inside a typed Durable Object RPC result rather
than allowing a known application error to cross the RPC boundary. Cloudflare
Worker version `04c8e103-4f0a-434a-87f0-7ed0e9900c33` was reported as the
Current Version, created at `2026-07-19T18:01:10.388448Z`, with a 25 ms startup.
Wrangler processed
248 official asset entries with no asset-byte uploads; deployment and the final
dry run reported 914.88 KiB raw / 164.21 KiB gzip, and the dry run exposed only
`ENTRY_STORE` plus `ASSETS`. Deployment used `--keep-vars`, version tag
`git-cda832688bb9` and a matching Git message; no deployed credential was
supplied to remote smoke requests. The 24-file Workers-runtime suite passed 265/265,
both audit suites passed 20/20, the dependency audit reported zero known
vulnerabilities, and TypeScript plus the official UI build completed before
deployment. A plaintext API credential can be rendered by metadata tooling;
the lab credential must be rotated and converted to a Worker Secret before
non-lab use. Its value is absent from repository documentation. These remain
subset facts, not a full-port claim.

This increment reproduces the official Treatments create split: every truthy
nonzero normalized `preBolus` creates the time-shifted carb record. Truthy
carbs move off the primary; missing or zero carbs retains the locked empty
string on the child. V2 inherits the same v1 route; PUT remains the
official one-record save path. NSCF commits both POST records in one synchronous
SQLite transaction, a deliberate platform strengthening over a possible
partial two-write failure, and retransmission deduplicates both records. It
retains the official v1 `/notifications/ack` route on both v1 and v2 mounts,
the repaired stale already-due DO alarm behavior, `/alarm` subscription
authority, the trusted live notification outlet, the `/storage` namespace,
its authorized room subscriptions and API3-only mutation events, plus all
eight generic
API v3 routes for Food and Settings, six-collection `lastModified` and v1 Food
writes on the same repository/history contract. Food uses the locked
`created_at`-only fallback; Settings has no fallback identity, and its search/
history permission is the locked admin exception while resource read remains
read-protected. Activation repairs older Food metadata/fallback/history
idempotently across eviction without rewriting document bodies. It retains the
upstream-shaped Entries query debugger and direct SQLite count from the prior
release. Client-controlled Mongo aggregation pipelines remain rejected rather
than treated as executable SQLite input. It also retains the audited uploader
edges: every non-ObjectId client `_id` is retained as `identifier` when the
supplied identifier is falsy; recursive string adaptation is idempotent;
extended URL-encoded nested/array
fields use the locked qs-style parser; SQLite binding/statement limits return a
controlled client error; and exact base `/entries` restores the upstream
runtime-SGV IMS precheck. It retains ordered batch-prefix commits, preview,
bounded query/sort, current/model/ID reads, JSON/plain/CSV/TSV, validators and
HEAD, plus API v3 Profile, AAPS create/retry/new-version behavior, v1/API3
shared storage, idempotent
legacy metadata repair and the official HTML/cache boundary fixes.

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
still cannot be stored. Exact safe-HTML DOMPurify bytes remain incomplete.

The ordinary compact-SGV path retains a requested count up to 10,000. A single
request selecting thousands of records that each contain abnormally large
custom fields is still materialized for RPC, sort, representation and ETag
generation and can approach the Workers Free CPU/memory boundary. This
extreme-request hardening is explicitly deferred; it is not counted as a
normal-family blocker and is not claimed solved.

The aggregate count is separate from that result cap: a one-year indexed
range can be counted without returning roughly 105,000 five-minute SGV rows.
Ordinary detail reads still cap one response at 10,000 and therefore require
date-partitioned requests for long exports. Transparent partitioning and the
locked `times/echo`, `times` and `slice` routes remain deliberately deferred
behind ordinary-family and closed-loop-critical work.

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
- locked Treatments POST `preBolus` two-record fan-out on both v1 and v2,
  atomic in SQLite, with PUT retaining the one-record save contract;
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

Final credential-free remote smoke returned HTTP 200 for health and the locked
v15.0.7/API 3.0.3-alpha version envelope. GET and HEAD version behavior, API
OPTIONS, anonymous collection GET/HEAD and unknown-route HEAD matched the new
contracts; no deployed credential was read or sent. A real browser reloaded
the current deployment and loaded the official homepage, Admin, Food, Profile
and `clock-color` pages without console errors or a protected write. Food
reached `Database loaded` and Profile reached `Values loaded.` before the
browser was returned to the homepage.

The code is still not a full port: Entries times/echo/times/slice and
non-Entries echo, large-response CSV/XML
resource adaptation, broader Mongo query/type parity,
WebSocket upgrade, EIO3 HTTP, root writes, main-namespace persisted change
broadcasts, the shared background-task scheduler, server plugins, notification
generation/processing and most upstream test files remain incomplete.
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
2. Finish v2 properties, ddata, summary, the v2-only notification loop and
   remaining authorization surfaces. Inherited v1/v2 notification ACK is
   complete for its named adapted contract.
3. **Complete for the named six-collection vertical slices:** generic
   search/create/read/update/patch/delete/history, six-collection lastModified
   and byte-compatible small/medium JSON/CSV/XML rendering. The complete
   `api3.basic`, `generic.workflow`, `read`, `renderer`, `search` and `security`
   files are adapted, alongside HEAD/CORS and configured lower paging limits.
   Complete bounded large-response handling, broader Mongo mixed-type/nested
   semantics and the remaining 10 upstream API3 test files before calling API
   v3 complete.
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
