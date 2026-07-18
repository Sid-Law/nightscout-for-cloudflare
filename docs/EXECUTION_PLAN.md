# Complete Nightscout port execution plan

Last synchronized: 2026-07-18

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
| 2. Official browser assets/pages | Partial | An earlier deployed increment supplied authenticated Profile save/close regression evidence, and the current deployed version has Admin/Food/Report/color-clock render smokes. The present candidate still needs post-deployment protected-save retesting; add the remaining mutation/report workflows, split view and pushed live updates. |
| 3. SQLite collection compatibility | In progress | Entries, treatments and device status share the generic API3 repository. Extend it to food/profile/settings, close Mongo mixed-type/nested parity and replace the unbounded snapshot journal with a tested, bounded short-lived outbox. Entries uses a deliberate fresh-only reset for an incompatible pre-1.0 narrow shadow; it is not a legacy importer. |
| 4. API v1 | In progress | The Entries create/list/current/model/delete slice now covers locked identity, type, date/dateString and bounded failure behavior; Activity CRUD is implemented. Complete preview/echo/times/count/slice/formats and the remaining document routes. |
| 5. API v2 | Partial | JWT issuance/refresh and strict v2 Status are implemented; complete summary, notifications and full ddata/properties behavior. Ddata/realtime entry reads use a separate two-day window, while v1 Entries keeps the locked four-day default. |
| 6. API v3 | Partial three-collection slice | Public `/version`, JWT-protected `/status`, the generic routes for entries/treatments/device-status and three-collection `/lastModified` are implemented with locked JSON/CSV/XML rendering. Add food, profile and settings plus large-response resource controls and broader mixed-type query parity. |
| 7. Authentication/admin | Core adapted; named gaps/hardening | Tenant JWT keys, eight-hour HS256 tokens, derived access-token/prefix matching, body/query/header credential order, live subject/role lookup, persisted per-IP delay, Shiro matching and `verifyauth` are implemented. The Workers boundary caps enforced delay at 60 seconds, failed-auth admin notification emission is missing, and repeated/bracket `secret` arrays are handled safely instead of reproducing the locked upstream unhandled rejection. |
| 8. Engine.IO/Socket.IO | Partial read-only polling + direct WebSocket | Strict EIO4 polling and direct Hibernatable EIO4 WebSocket are routed to tenant `EntryStore` DOs with persisted sessions/queues, heartbeat, SIO5 root CONNECT, read-only authorize ACK/dataUpdate, loadRetro and clients-count events. One derived alarm survives eviction. Complete the official-page switch only after `/alarm` and tenant propagation; close the direct-send at-most-once crash window, then add polling-to-WebSocket upgrade, EIO3 HTTP, `/storage`, root writes and change broadcasts. |
| 9. Real-time storage updates | Storage foundation only | Implemented generic mutations persist atomic change snapshots, but no transport consumes them; define bounded outbox retention, cursors and reconnect/eviction tests before broadcasting. |
| 10. Alarms/background tasks | Realtime/auth foundation only | The DO's single alarm is derived from persisted realtime deadlines and authorization-failure cleanup and is idempotent across eviction/retry. Add a persisted multi-kind task table before API v3 pruning and server-plugin evaluation share it. |
| 11. Server plugins/notifications | Not started | Build-time official registry and platform context; port upstream plugin/data/notification tests without rewriting formulas. |
| 12. Upstream regression suite | Tracked, execution not started | Work through `docs/UPSTREAM_TEST_MANIFEST.md` in dependency order; 109 files remain unresolved and two are fixed-scope exclusions. |

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

## Current local candidate (not deployed)

Integration commit `d8e406d13b87b2e304b1db4dc075af18ae463022`
combines the strict v1/v2 Status contracts, derived/body credential and
persisted-delay authorization work, direct Hibernatable EIO4 WebSocket, and API
v3 Entries as the third generic collection. The 18-file Workers-runtime suite
passes 215/215 locally. That number is local integration evidence only; the
official v15.0.7 build has also passed with its three known Webpack size
warnings. Wrangler dry-run read 248 assets, reported 764.00 KiB raw / 135.65 KiB
gzip, and exposed only `ENTRY_STORE` plus `ASSETS`. The public deployment
version, remote API/direct-WS smoke and browser workflows still need to be
executed and recorded before this candidate is called deployed.

Entries deliberately follows a fresh-only pre-1.0 policy. If activation finds
the old narrow `entries` shadow structurally incompatible, it resets that
shadow instead of attempting a risky partial import. Canonical documents and
other collections, including profile, are preserved. At 2026-07-18 14:51 UTC,
a read-only pre-deployment check found zero Entries and one profile in the
public lab;
there is therefore no old simulated Entry row to migrate on that specific
tenant. This policy is acceptable for the pre-1.0 simulated lab, but it is not
a general migration path for an existing Nightscout database.
Fresh deployment is the planned release path for the initial new-user/new-family
audience; an external legacy-history importer is explicitly deferred and is not
a launch gate. It means initially creating a new Worker/SQLite DO namespace or
using an empty tenant. A code redeploy to the same Worker preserves Durable
Object data; it is not a database reset, so the current lab keeps its canonical
profile and other documents. This does not authorize real CGM/uploader/closed-
loop use: the candidate remains simulated-data only.

The Entries bounds are explicit: v1 defaults to a four-day date window;
realtime/ddata reads use two days; `dateString` and other unindexed candidate
sets stop with controlled HTTP 413 above 10,000 rows; synchronous delete and
per-document revision deletion are capped at 128; and `$re` accepts only the
bounded, case-sensitive subset that can be safely compiled to SQLite `GLOB`.

## Current deployed increment

The following section intentionally describes the older code that is still
live. It must not be used as deployment evidence for the local candidate above.

Code commit `0319a8d5e78fc77c4c53c0a94724b706d7ec8255` is deployed at 100%
traffic as Cloudflare Worker version
`e8e7970b-65bb-412f-ba74-193ce14575c5` (2026-07-18 08:13:13 UTC). The release
gate passed the official v15.0.7 Webpack build with 248 asset entries, Wrangler
type generation and TypeScript, the deterministic 161-route/111-test-file
audit, 14/14 audit-tool tests, 141/141 Workers-runtime tests and a 651.05 KiB
(113.32 KiB gzip) dry run. The dry run declared only the `ENTRY_STORE` Durable
Object and `ASSETS` binding. Deployment used `--keep-vars`; the existing
`API_SECRET` value was neither read nor printed.

The deployed increment includes:

- the locked official v15.0.7 UI/pages/assets with no replacement UI;
- one tenant-sharded SQLite Durable Object and Workers Static Assets only;
- page-used entries, food, profile, treatments, device-status, activity,
  role/subject/token subsets and aggregate REST polling;
- tenant-persisted eight-hour HS256 JWTs, live subject/role lookup, exact
  `shiro-trie` matching, `verifyauth`, API v3 `/version` and JWT-only `/status`;
- all eight generic API v3 routes for both treatments and device status,
  including branch-sensitive permissions, ordered search, conditional read,
  history, collection-specific legacy fallback/deduplication, lastModified,
  tombstones, permanent delete and atomic rollback; JSON/CSV/XML rendering uses
  the locked upstream dependency versions and Accept negotiation order;
- strict tenant-local EIO4 polling with persisted sessions/queues, heartbeat,
  SIO5 root CONNECT, read-only authorization/data snapshots and bounded
  resource handling; a SQL-derived Durable Object alarm now survives eviction
  and drives ping, pong timeout, session/lease expiry and client-count updates.

Remote smoke verified public v3 version metadata, v1 entries, missing-JWT 401
responses for v3 status, treatments and device status, an unknown-format 406,
official page HTTP responses, and the
full EIO4 open -> SIO5 CONNECT -> authorize -> dataUpdate/status/read-only ACK
sequence. After 26 seconds without an HTTP cleanup opportunity the next poll
received the alarm-driven Engine.IO ping; pong and close both succeeded. The
in-app browser rendered the homepage/chart and About version 15.0.7, and
Settings stayed closed for several seconds without rebounding. Profile and Food
rendered the official editors; the immediate snapshot still showed their
initial `Not loaded` text and an `Unauthorized` authentication state. Direct
remote reads of `/api/v1/profile.json?count=20` and `/api/v1/food.json` both
returned HTTP 200, including the stored simulated profile, so the snapshot is
not treated as an API failure. No credentialed browser save was attempted, and
that protected workflow remains unproven for this release. Admin, Report and
color clock rendered their official empty/unauthorized states. No console error
was observed; standalone pages emitted only the known
missing-`#chartContainer` warning.

The deployed code is still not a full port: API v3 entries, food, profile and settings,
large-response CSV/XML resource adaptation, broader Mongo query/type parity,
WebSocket upgrade, EIO3 HTTP, `/storage` and `/alarm`, root writes, persisted
change broadcasts, the shared background-task scheduler, server plugins,
notifications and most upstream test files remain incomplete.
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

Items 1–3 and the request-enforcement core of item 4 are complete. The local
candidate derives the upstream subject credential from API_SECRET/ObjectId,
preserves prefix lookup, extracts credentials from the locked query/header/body
precedence, and persists a bounded per-IP failure delay that shares the DO
alarm. Remaining work is failed-auth admin notification emission. The enforced
delay is capped at 60 seconds as a named Workers boundary difference.
Token-bearing authorization paths are redacted from adapter error logs.

### Milestone C — API completion

1. Finish v1 entries and document routes from Express registration and Swagger.
2. Finish v2 properties, ddata, summary, notifications and authorization.
3. **Complete for the named entries, treatments and device-status slices:**
   generic search/create/read/update/patch/delete/history, three-collection
   lastModified and byte-compatible JSON/CSV/XML rendering. Extend the same
   upstream contract to food, profile and settings, including bounded
   large-response handling.
4. Port upstream API tests in module order and record any fixed-scope exclusion.

### Milestone D — real-time transport

1. **Complete for the named slice:** route exact `/socket.io` and `/socket.io/`
   polling requests to the tenant DO without intercepting the static
   `/socket.io/socket.io.js` shim asset.
2. **Partial:** EIO4/SIO5 polling sessions and direct Hibernatable WebSocket,
   server-ping/client-pong, persisted queues, root CONNECT and a SQL-derived DO
   alarm for ping/pong/session/lease/closure deadlines are implemented.
   EIO3/SIO4 remains codec-only and is deliberately rejected by the HTTP
   endpoint; polling advertises `upgrades: []`.
3. Add the Engine.IO polling-to-WebSocket upgrade path; direct WebSocket open
   is already implemented and tested across DO eviction.
4. Extend beyond the read-only `/` subset to `/storage` and `/alarm`, including
   authorization, subscriptions and room behavior.
5. Extend the implemented root `authorize` and `loadRetro` reads with the
   locked write handlers only after storage/change-outbox contracts exist.
6. Broadcast persisted collection changes immediately after their transaction
   commits; current clients-count broadcasts are connection metadata only.
7. Replace the REST polling shim with the official client only after protocol
   tests, safe tenant propagation, `/alarm`, and real browser workflows pass.

### Milestone E — background/server behavior

1. Extend the existing realtime/auth-owned single alarm with a persisted SQLite
   task table so every job kind participates in one derived schedule.
2. Port failed-auth admin-notify emission and API v3 auto-prune; persisted
   failure-delay cleanup already shares the alarm.
3. Generate the official server plugin registry at build time.
4. Execute official dataloader/sandbox/plugin/notification modules through a
   persisted tenant context.
5. Keep external integrations disabled unless separately authorized and within
   the fixed simulated-data scope.

### Milestone F — page and upstream closure

1. Browser-test profile, food, admin, report, split and clock workflows.
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
