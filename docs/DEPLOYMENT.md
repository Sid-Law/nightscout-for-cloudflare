# Phase 1 deployment record

Last synchronized: 2026-07-17

## Current status

Phase 1 is deployed and the local and remote closure tests pass.

- Public URL: <https://nscf-phase1.nscf-lab-20260717.workers.dev/>
- Account ID: `fad59c859cb78943d97441581dfcab78`
- Account workers.dev subdomain: `nscf-lab-20260717`
- Worker: `nscf-phase1`
- Final deployment ID: `fec355cd8ae2490aafa91b18a544e876`
- Final Worker ETag: `0b940d3d8381b4e023a55975b00be24eb8fe493b8ecc04653caa26a9ebc94d60`
- Worker bundle SHA-256:
  `ba9d15d1cb4e5f177726085e269d91591c5fbdf822f04eb989ead0ee3f384c57`
- Durable Object namespace: `nscf-phase1_EntryStore`
- Durable Object namespace ID: `65a3ccc862724ddaaf1e3d8efdc0ef8b`
- Durable Object class/backend: `EntryStore`, SQLite, migration tag `v1`
- Script route: enabled; preview URLs disabled
- Observability and invocation logs: enabled at sampling rate 1

The public URL is a synthetic-data lab. It is intentionally unauthenticated and
must not receive real health data.

## Created Cloudflare footprint

The task created exactly one Worker, its Workers Static Assets deployment, one
SQLite-backed Durable Object namespace, and the account workers.dev subdomain.
The final API inventory reports one Worker and one Durable Object namespace.
D1 remains empty. No R2, KV, Queues, custom domain, zone route, or other product
resource was created.

The deployment uploaded 177 asset files represented by 169 unique content
hashes and 14,851,506 unique bytes. Wrangler reports 201 directory entries when
walking `public/`. The official main bundle is 2,173,390 bytes; its local and
remote SHA-256 are both
`d85c03e4a30b789e35f34f6a86a33f93b684ac1993f7a8b7066c3d0f48db9d99`.

A temporary, unguessable relay path on the same final Worker/DO was used only to
bridge local asset bytes to the authorized API session. It created no extra
Cloudflare resource. Its SQLite transfer table contained zero rows/bytes before
the Worker was replaced with the final code.

## Local verification evidence

| Check | Result |
| --- | --- |
| TypeScript | `wrangler types` and `tsc --noEmit` passed |
| Workers integration tests | 1 file, 8/8 tests passed |
| Official UI build | Nightscout v15.0.7 Webpack build passed |
| Vendor integrity | 655 files identical to the re-hashed official release archive |
| Static Assets dry run | 201 entries read from `public/` |
| Final Worker dry run | 16.98 KiB raw / 5.40 KiB gzip |
| Local page closure | 12 simulated SGVs persisted; official page title/chart rendered |
| UTF-8 platform adapter | HTML and JS charset assertions pass without changing upstream bytes |

Local browser evidence is `outputs/local-official-nightscout.png`.

## Remote smoke evidence

The remote smoke test used simulated SGVs only.

| Check | Result | Client-observed wall time |
| --- | --- | ---: |
| Batch POST | HTTP 200; 12 inserted, 0 duplicates | 23,917.7 ms |
| Idempotent retry | HTTP 200; 0 inserted, 1 duplicate | recorded |
| Status | HTTP 200; `Nightscout` / `15.0.7-nscf.1` / `loaded` | 1,255.6 ms |
| Health | HTTP 200; SQLite Durable Object | 258.7 ms |
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

Workers Observability reported the following over 129 phase-one invocations in
the two-hour deployment/smoke window (including the temporary same-Worker asset
relay traffic):

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

- Public writes and tenant selection are unauthenticated; synthetic data only.
- Only the documented phase-one v1 SGV/status/auth startup subset exists.
- The transport adapter uses 15-second REST polling, not full Engine.IO or
  WebSocket semantics.
- No treatments, profiles, devicestatus, API v2/v3, write roles, alarms or
  production admin flows are implemented.
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
