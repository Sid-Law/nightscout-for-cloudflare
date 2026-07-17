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
- external bridge/push integrations remain disabled in the simulated-data lab.

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
| 1. Compatibility inventory | In progress | Map every v1/v2/v3 route and all 111 upstream test files to pass/adapt/exclude/unresolved. |
| 2. Official browser assets/pages | Partial | Profile save/close is now verified; add food, admin, report, clock, split and live-update workflows. |
| 3. SQLite collection compatibility | In progress | General collection contract for ObjectId/UUID, indexes, query operators, upsert, API v3 timestamps/tombstones and atomic change events. |
| 4. API v1 | In progress | Complete entries utilities/types/errors and all document routes; activity CRUD is the latest completed increment. |
| 5. API v2 | Partial | Complete authorization/JWT, summary, notifications and full ddata/properties behavior. |
| 6. API v3 | Started | Public `/version` is implemented; generic CRUD, status, lastModified, history, formats and security remain. |
| 7. Authentication/admin | Partial | Persist tenant JWT signing material and port authorization, Shiro permissions, expiry and delay-list tests. |
| 8. Engine.IO/Socket.IO | Not started | EIO3 polling handshake, WebSocket upgrade, namespaces, authorization, acknowledgements and database mutation messages on a tenant DO. |
| 9. Real-time storage updates | Not started | Persist-then-broadcast mutation log and reconnect/eviction tests. |
| 10. Alarms/background tasks | Not started | One-alarm SQLite task scheduler for heartbeat, cleanup, API v3 pruning and server-plugin evaluation. |
| 11. Server plugins/notifications | Not started | Build-time official registry and platform context; port upstream plugin/data/notification tests without rewriting formulas. |
| 12. Upstream regression suite | Not started | Run or adapt each applicable upstream suite against the DO repository and Worker transport. |

## Current verified baseline

Repository baseline before this increment:

- official v15.0.7 Webpack/UI build and secondary pages;
- one tenant-sharded SQLite Durable Object;
- page-used SGV/document CRUD, API-secret and opaque subject-token subset;
- aggregate REST polling through a browser-side Socket.IO-shaped shim;
- 15 Workers integration tests.

The 2026-07-18 audit established:

- upstream Express and `node:fs` are no longer automatic blockers on current
  Workers; the permanent Node process model remains incompatible;
- the remote deployment returned 404 for API v3 version, activity and a real
  Engine.IO polling handshake;
- the official Profile Editor loaded in a real browser with no JavaScript
  errors, after the empty-data homepage redirected there;
- the shim's “connected” event was synthetic and not Socket.IO evidence.

This increment is deployed and verified:

- v1 activity create/list/filter/conditional GET/update/delete, including the
  upstream empty-array create behavior;
- the public API v3 `/version` envelope with SQLite adapter metadata;
- two new Workers integration tests, bringing the local suite to 17;
- remote public API smoke and a real-browser Profile Editor save;
- a Profile/homepage compatibility fix: the first aggregate `dataUpdate`
  follows upstream authorization ordering, and the Cloudflare adapter uses a
  content-addressed URL that cannot be shadowed by the old upstream
  service-worker cache;
- a real Chrome save/close workflow that remained on the official homepage,
  had no JavaScript dialog or redirect, and rendered the persisted basal value.

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

### Milestone C — API completion

1. Finish v1 entries and document routes from Express registration and Swagger.
2. Finish v2 properties, ddata, summary, notifications and authorization.
3. Implement API v3 generic search/create/read/update/patch/delete/history,
   version/status/lastModified, conditional headers and JSON/CSV/XML formats.
4. Port upstream API tests in module order and record any fixed-scope exclusion.

### Milestone D — real-time transport

1. Route `/socket.io/` requests to the tenant DO.
2. Implement EIO3 polling sessions and ping/pong.
3. Add hibernatable WebSocket upgrade and reconnect.
4. Implement Socket.IO packets, acknowledgements, rooms and `/`, `/storage`,
   `/alarm` namespaces.
5. Implement authorize/loadRetro/dbAdd/dbUpdate/dbUpdateUnset/dbRemove.
6. Broadcast persisted collection changes immediately.
7. Remove the browser polling shim only after official client protocol tests and
   browser workflows pass.

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
