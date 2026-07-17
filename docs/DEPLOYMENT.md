# Phase 1 deployment record

Last synchronized: 2026-07-17

## Current status

The expanded phase-one port is deployed. Local Workers/SQLite closure tests and
final remote page/read smoke tests pass. The final remote credentialed CRUD
rerun received HTTP 401 because the current dashboard `API_SECRET` no longer
matches the earlier test value; the binding is present and was not inspected or
replaced.

- Public URL: <https://nscf-phase1.nscf-lab-20260717.workers.dev/>
- Account ID: `fad59c859cb78943d97441581dfcab78`
- Account workers.dev subdomain: `nscf-lab-20260717`
- Worker: `nscf-phase1`
- Final deployment ID: `40627e717e124e368ffe0f9af51ae19a`
- Final Worker ETag: `ee33c9f1099f7ad1e95d0b9f98480da034d72366e51cf17272c73ee1d14af69b`
- Worker bundle SHA-256:
  `5b737eab3ba8ad520f4741ddaf6c501b65d2263e28c23e48c80f4faa56546cf6`
- Durable Object namespace: `nscf-phase1_EntryStore`
- Durable Object namespace ID: `65a3ccc862724ddaaf1e3d8efdc0ef8b`
- Durable Object class/backend: `EntryStore`, SQLite, migration tag `v1`
- Script route: enabled; preview URLs disabled
- Observability and invocation logs: enabled at sampling rate 1

The public URL is a synthetic-data lab. Writes require a Nightscout-compatible
`API_SECRET`; reads remain public, so it must not receive real health data.

## Created Cloudflare footprint

The task created exactly one Worker, its Workers Static Assets deployment, one
SQLite-backed Durable Object namespace, and the account workers.dev subdomain.
The final API inventory reports one Worker and one Durable Object namespace.
D1 remains empty. No R2, KV, Queues, custom domain, zone route, or other product
resource was created.

The deployment contains 214 asset files represented by 205 unique content
hashes and 23,877,522 bytes before content deduplication. Wrangler reports 248
entries when walking `public/`. The official main bundle is 2,173,390 bytes;
its local and remote SHA-256 are both
`d85c03e4a30b789e35f34f6a86a33f93b684ac1993f7a8b7066c3d0f48db9d99`.

## Local verification evidence

| Check | Result |
| --- | --- |
| TypeScript | `wrangler types` and `tsc --noEmit` passed |
| Workers integration tests | 1 file, 15/15 tests passed |
| Official UI build | Nightscout v15.0.7 Webpack build passed |
| Vendor integrity | 655 files identical to the re-hashed official release archive |
| Static Assets dry run | 248 entries read from `public/` |
| Final Worker dry run | 47.84 KiB raw / 11.90 KiB gzip |
| Page routes | Index, Admin, Profile, Food, Report, Split, dynamic clocks and Swagger |
| SQLite page CRUD | Entries, food, profile, treatments, device status, roles and subjects |
| Authorization | API_SECRET fail-closed, roles/subjects and access tokens |
| Local page closure | 12 simulated SGVs persisted; official page title/chart rendered |
| UTF-8 platform adapter | HTML and JS charset assertions pass without changing upstream bytes |

Local browser evidence is `outputs/local-official-nightscout.png`.

## Remote smoke evidence

All remote checks used simulated data only. The earlier closure run verified
authorized Worker-to-Durable-Object writes and official chart rendering. The
final deployment added the expanded page CRUD and reran every page/read route;
credentialed writes were rejected before storage because the dashboard secret
had changed.

| Check | Result | Client-observed wall time |
| --- | --- | ---: |
| Batch POST | HTTP 200; 12 inserted, 0 duplicates | 23,917.7 ms |
| Idempotent retry | HTTP 200; 0 inserted, 1 duplicate | recorded |
| Status | HTTP 200; exact upstream `Nightscout` / `15.0.7` / `loaded` | 1,255.6 ms |
| Health | HTTP 200; SQLite Durable Object | 258.7 ms |
| API_SECRET browser auth | HTTP 200; `canWrite: true`, `isAdmin: true`, upstream `message: OK` | passed |
| Current | HTTP 200; one row, SGV 124, `Flat` | 226.8 ms |
| History | HTTP 200; 12 rows, newest 124, oldest 108 | 223.2 ms |
| Date/count filter | HTTP 200; two expected rows | 652.2 ms |
| Tenant isolation | isolated values 101 and 202 | passed |
| Invalid SGV | HTTP 400 `invalid_entry` | passed |
| Official homepage | HTTP 200; upstream markers present | 366.7 ms |
| Official bundle | HTTP 200; 2,173,390 bytes | passed |
| Socket.IO polling shim | HTTP 200 | passed |
| Provenance | v15.0.7 and locked commit match | passed |

The first batch includes new-account Worker/DO cold initialization and network
time; it is not CPU time. Subsequent remote reads were about 0.22–0.65 seconds
wall time from the test client.

### Final deployment page/read smoke

| Check | Result | Client-observed wall time |
| --- | --- | ---: |
| `/` | HTTP 200, official Nightscout | 880 ms |
| `/admin` | HTTP 200, official Admin Tools | 785 ms |
| `/food` | HTTP 200, official Food Editor | 219 ms |
| `/profile` | HTTP 200, official Profile Editor | 258 ms |
| `/report` | HTTP 200, official Reporting | 222 ms |
| `/split` and `/split/` | HTTP 200 for both forms | 375 / 232 ms |
| `/clock/clock-color` | HTTP 200 | 239 ms |
| arbitrary `/clock/cy10-sg35` | HTTP 200 | 210 ms |
| `/api-docs`, `/api3-docs` | HTTP 200 | 246 / 220 ms |
| `/api/v1/status.json` | HTTP 200; exact version `15.0.7`; no downstream object | passed |
| clean isolated tenant | entries and aggregate collections empty | passed |
| invalid credential | HTTP 401, proving binding is present rather than fail-closed 503 | passed |
| removed public downstream artifact | `/nscf-upstream.json` HTTP 404 | passed |

The credentialed CRUD rerun did not write anything: entries, food, profile,
treatments and device-status POST/PUT requests all stopped at HTTP 401, and the
isolated aggregate remained empty. To repeat that one remote step, enter the
current raw `API_SECRET` in the official authentication dialog or deliberately
replace the dashboard variable with a new value of at least 12 characters.

## Remote official-page closure and UTF-8 adaptation

The first remote browser load exposed a Cloudflare-specific encoding coupling.
The upstream homepage has no `<meta charset>` because the official Express
server normally supplies UTF-8 in HTTP headers. Static Assets returned
`text/html` and `application/javascript` without a charset. In a Chinese-locale
Chrome session, a curly quote in the unchanged bundle was decoded with a legacy
encoding, producing an invalid regular expression and stopping client startup.

The adapter fix routes text asset paths through the Worker, streams the Static
Assets response, and appends `charset=utf-8`. It does not change upstream asset
bytes. After redeployment:

- `/` returns `text/html; charset=utf-8`.
- `bundle.app.js` and `js/client.js` return
  `application/javascript; charset=utf-8`.
- The loading overlay disappears.
- The official page title updates to `124 +0 →` during verification.
- The official chart contains an SVG with three paths and 50 circles.

Remote browser evidence is `outputs/remote-official-nightscout.png`.

## Workers Free CPU assessment

Cloudflare Free rejected explicit upload metadata `limits.cpu_ms: 10` with API
error `100328`: custom CPU limits are not supported on the Free plan. The field
was removed from `wrangler.jsonc`; the Free plan's platform limit remains in
force.

Workers Observability reported the following over 129 invocations in the
initial phase-one deployment/smoke window:

| Metric | CPU time |
| --- | ---: |
| Minimum | 1 ms |
| Average | 1.14 ms |
| Median | 1 ms |
| p95 | 2 ms |
| Maximum | 4 ms |

Every observed invocation remained below 10 ms. Wall time is separately affected
by network, static asset delivery, DO placement and first-use initialization.

## Known limitations

- Writes require API_SECRET, but reads and tenant selection remain public;
  synthetic data only.
- Every official page route is shipped, but this does not mean every historical
  Nightscout server/API/plugin behavior is implemented.
- The transport adapter uses 15-second REST polling, not full Engine.IO or
  WebSocket semantics.
- Page-used entries, treatments, profiles, food, device status and
  roles/subjects are implemented. Generic API v3 runtime, summary/activity
  persistence, notifications, plugin background jobs and alarms are not.
- The pinned upstream dependency tree reports 66 inherited audit findings (9
  low, 18 moderate, 37 high, 2 critical). It is not silently auto-upgraded.
- No medical algorithms were added or changed, and this prototype is not for
  diagnosis, dosing or medical decisions.

## Rollback

1. Delete Worker `nscf-phase1` to remove the public route and Static Assets
   deployment.
2. If Cloudflare retains it, delete Durable Object namespace
   `65a3ccc862724ddaaf1e3d8efdc0ef8b`.
3. Optionally delete account subdomain `nscf-lab-20260717`.

No D1/R2/KV/Queue/custom-domain cleanup is required.
