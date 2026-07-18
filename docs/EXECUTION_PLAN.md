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
| 2. Official browser assets/pages | Partial | Profile save/close is verified and Admin/Food/Report/color-clock render smokes pass; add their mutation/report workflows, split view and pushed live updates. |
| 3. SQLite collection compatibility | In progress | Treatments schema-v4/repository slice is implemented; extend the contract to every collection and replace the unbounded snapshot journal with a tested, bounded short-lived outbox. |
| 4. API v1 | In progress | Complete entries utilities/types/errors and all document routes; activity CRUD is the latest completed increment. |
| 5. API v2 | Partial | JWT issuance/refresh is implemented; complete body credentials, delay-list behavior, summary, notifications and full ddata/properties behavior. |
| 6. API v3 | Partial JSON treatments slice | Public `/version`, JWT-protected `/status`, the eight locked treatments routes and treatments-aware `/lastModified` are implemented for JSON; add locked CSV/XML renderer parity before generalizing to the other five collections. |
| 7. Authentication/admin | Partial | Tenant JWT keys, eight-hour HS256 tokens, live subject/role lookup, Shiro matching and `verifyauth` are implemented; port derived access-token and persistent IP delay-list behavior. |
| 8. Engine.IO/Socket.IO | Partial read-only polling slice | Strict EIO4 polling is routed to tenant `EntryStore` DOs with persisted sessions/queues, EIO4 heartbeat, SIO5 root CONNECT, read-only authorize ACK/dataUpdate, loadRetro and clients-count events. Complete the official-page switch only after `/alarm` and tenant propagation; WebSocket, EIO3 HTTP, `/storage`, writes and change broadcasts remain missing. |
| 9. Real-time storage updates | Storage foundation only | Treatments persist an atomic change snapshot, but no transport consumes it; define bounded outbox retention, cursors and reconnect/eviction tests before broadcasting. |
| 10. Alarms/background tasks | Not started | One-alarm SQLite task scheduler for heartbeat, cleanup, API v3 pruning and server-plugin evaluation. |
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

## Last deployed baseline and current local increment

Code commit `78502a01c624d3f8b38e207abd5b7c9d1cea50c8` is deployed as Worker
version `e3e9b197-bd1d-45b1-b2c8-a5b18b907e90`. Its gate passed the official
v15.0.7 Webpack build, type generation/typecheck, the deterministic 161-route /
111-test-file audit, 14/14 audit-tool tests, 75/75 Workers-runtime tests and the
Wrangler dry run.

The current baseline includes:

- the locked official v15.0.7 UI/pages/assets with no replacement UI;
- one tenant-sharded SQLite Durable Object and Workers Static Assets only;
- page-used entries, food, profile, treatments, device-status, activity,
  role/subject/token subsets and aggregate REST polling;
- the content-addressed polling adapter/service-worker cache fix;
- tenant-persisted eight-hour HS256 JWTs, live subject/role lookup, exact
  `shiro-trie` matching, `verifyauth`, API v3 `/version` and JWT-only `/status`;
- v1 activity CRUD and conditional request behavior;
- treatments schema-v4 migration and repository contracts for legacy/API3
  identity, query, mutation, monotonic timestamps, tombstones/history and
  atomic change snapshots;
- isolated, tested official EIO4/SIO5 and legacy EIO3/SIO4 protocol codecs.

The unreleased branch adds a treatments-only API v3 JSON HTTP vertical. It does
not change the deployed evidence above: no deployment, remote smoke or browser
claim has been made for these routes. The local contracts cover JWT-only
authentication, dynamic create/update permission branches, ordered sorting,
conditional read, both history cursors, lastModified, tombstones, permanent
delete and transaction rollback. Its local gate passed the official v15.0.7 UI
build, Wrangler type generation/TypeScript check, the 161-route/111-test-file
audit, 14/14 audit-tool tests, 99/99 Workers-runtime tests and deployment
dry-run. The dry-run created no deployment.

Post-deploy API smoke passed. A real existing Chrome session saved the official
Profile Editor, closed it to `/`, stayed there for six seconds and remained on
the homepage after reload with `BASAL 0.100U`; it did not reopen Profile Editor
or show a dialog. The same browser rendered Admin, Food, Report and color-clock
pages with no console errors. Their official chart-container warnings on
standalone pages are recorded in `DEPLOYMENT.md`.

That deployed version predates the current local real-time increment and still
returns 404 for a real EIO4 handshake. The current branch now routes
`/socket.io` and `/socket.io/` to the tenant DO and implements a bounded,
read-only EIO4/SIO5 polling root slice. It has not been deployed or browser-
switched in this increment. This is still not a full port: API v3 CSV/XML
renderers, five generic collections, broader Mongo query/type parity, WebSocket
upgrade, EIO3 HTTP, `/storage` and `/alarm`, root write handlers, change
broadcasts, alarms, server plugins, notifications and most upstream test files
remain incomplete.

The local polling slice is intentionally bounded to 256 sessions per tenant,
128 queued packets and one 1,000,000-byte polling payload per session. It uses
25-second server pings, 20-second pong timeouts, strict non-binary request
shapes and opportunity cleanup in batches of 32; it adds no DO alarm. Root
authorization always ACKs `write:false` and `write_treatment:false`. Initial
`dataUpdate` follows locked recent-device-status filtering, while `loadRetro`
uses the unfiltered runtime-normalized device-status loader but is limited by
this adapter's 100-document SQL query rather than upstream's one-day cache.
The websocket status shape is locked, but `apiEnabled:true`,
`careportalEnabled:true`, `boluscalcEnabled:false` and the absence of
`activeProfile` are current platform assumptions. Strict one-object
`authorize`/`loadRetro` validation is a named safety tightening.

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

Items 1–3 and the core of item 4 are complete. Remaining work is the upstream
API-secret-derived long-token format and prefix lookup, credentials carried in
request bodies, the persistent per-IP failure delay list, and its shared DO
alarm cleanup. Token-bearing authorization paths are redacted from adapter
error logs.

### Milestone C — API completion

1. Finish v1 entries and document routes from Express registration and Swagger.
2. Finish v2 properties, ddata, summary, notifications and authorization.
3. Extend the implemented treatments JSON search/create/read/update/patch/
   delete/history and lastModified slice to the other collections, then add
   byte-compatible locked CSV/XML renderers.
4. Port upstream API tests in module order and record any fixed-scope exclusion.

### Milestone D — real-time transport

1. **Complete for the named slice:** route exact `/socket.io` and `/socket.io/`
   polling requests to the tenant DO without intercepting the static
   `/socket.io/socket.io.js` shim asset.
2. **Partial:** EIO4/SIO5 polling sessions, server-ping/client-pong, persisted
   queues and root CONNECT are implemented. EIO3/SIO4 remains codec-only and
   is deliberately rejected by the HTTP endpoint; `upgrades` is empty.
3. Add hibernatable WebSocket upgrade and reconnect.
4. Extend beyond the read-only `/` subset to `/storage` and `/alarm`, including
   authorization, subscriptions and room behavior.
5. Extend the implemented root `authorize` and `loadRetro` reads with the
   locked write handlers only after storage/change-outbox contracts exist.
6. Broadcast persisted collection changes immediately after their transaction
   commits; current clients-count broadcasts are connection metadata only.
7. Replace the REST polling shim with the official client only after protocol
   tests, safe tenant propagation, `/alarm`, and real browser workflows pass.

### Milestone E — background/server behavior

1. Add a SQLite task table and one-alarm scheduler.
2. Port heartbeat, admin-notify cleanup and API v3 auto-prune.
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
code and assets. SQLite schema changes require forward-compatible migrations;
never use destructive schema rollback on user data. No D1/R2/Queue/custom-domain
cleanup is needed because those resources are not created.
