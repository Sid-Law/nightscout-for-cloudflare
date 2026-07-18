# Current deployment record

Last synchronized: 2026-07-18 (Asia/Shanghai)

## Status

The public Worker is deployed and healthy, but it is **not a complete
Nightscout port**. It serves the locked official v15.0.7 browser assets and the
named compatibility subset in `UPSTREAM_COMPATIBILITY.md`. Page availability
is not counted as API, plugin or real-time compatibility.

- Public URL: <https://nscf-phase1.nscf-lab-20260717.workers.dev/>
- Account ID: `fad59c859cb78943d97441581dfcab78`
- Worker: `nscf-phase1`
- Deployed code commit: `08b2970b129104a2bdbb293502abd9aa025a19a5`
- Cloudflare Version ID: `6cffd451-08e1-4dd5-b582-df7e5e6cbb6e`
- Traffic: 100%
- Activated: 2026-07-18 06:15:46 UTC
- Separate Deployment ID: not emitted by Wrangler 4.111.0; the Version ID is
  the recorded rollback handle
- Durable Object: class `EntryStore`, SQLite backend, Wrangler migration tag
  `v1`; internal additive schema is current through version 5
- Static Assets: 248 Wrangler asset entries from the official v15.0.7 build
- Worker startup: Cloudflare reported 6 ms
- Observability and invocation logs: enabled

This release deploys the treatments-only API v3 JSON vertical and the bounded,
persisted, read-only EIO4/SIO5 polling-root slice. The official homepage still
uses the REST polling shim; deploying the server endpoint is not a homepage
transport switch. Wrangler retained existing dashboard variables with
`--keep-vars`. The configured `API_SECRET` value was never read or printed.

## Cloudflare footprint

The project uses exactly:

1. one Worker;
2. one Workers Static Assets deployment;
3. one SQLite Durable Object namespace.

It does not create or use D1, R2, KV, Queues, a custom domain or a zone route.
The public instance is for simulated data only and must not receive real health
data or CGM credentials.

## Pre-deployment gate

| Check | Result |
| --- | --- |
| Locked upstream | `nightscout/cgm-remote-monitor` v15.0.7, pinned commit and archive hash verified |
| Root adapter dependency install | `npm ci` completed; 0 reported vulnerabilities |
| Official UI build | Upstream Webpack production bundle completed; only its three existing size warnings |
| Static Assets | 248 entries rebuilt |
| Upstream route/test audit | 161 registrations and 111 test files; generated outputs deterministic |
| Audit tool tests | 14/14 Node tests passed |
| Type generation | `wrangler types` completed |
| TypeScript | `tsc --noEmit` passed |
| Workers integration tests | 10 files, 130/130 passed |
| Worker dry run | 287.80 KiB raw / 62.47 KiB gzip |
| Dry-run bindings | `ENTRY_STORE` Durable Object and `ASSETS` only |
| Git state | clean at deployed code commit |

The locked upstream contains 111 JavaScript test files and approximately 873
test cases. The 130 Workers tests cover the implemented adapter subset; no
whole upstream test file is claimed green. Neither count proves complete
compatibility.

## Post-deployment remote evidence

Cloudflare reports version `6cffd451-08e1-4dd5-b582-df7e5e6cbb6e` at 100%
traffic from 2026-07-18 06:15:46 UTC. The smoke checks response content and
protocol markers, not only Wrangler command success.

| Check | Result |
| --- | --- |
| `/` | HTTP 200, official HTML |
| `/admin`, `/profile`, `/food`, `/report`, `/clock/clock-color` | HTTP 200 |
| `/api/v1/entries.json?count=1` | HTTP 200 JSON |
| `/api/v3/version` | HTTP 200; Nightscout `15.0.7`, API `3.0.3-alpha`, SQLite Durable Object adapter metadata |
| `/api/v3/status` without JWT | HTTP 401 JSON |
| `/api/v3/treatments` without JWT | HTTP 401 JSON |
| EIO4 polling open | HTTP 200; 20-character SID, `upgrades: []`, 25 s ping, 20 s timeout, 1,000,000-byte maximum |
| SIO5 root CONNECT | POST 200 `ok`; next poll contained CONNECT |
| Read-only authorize | POST 200 `ok`; next poll contained `dataUpdate`, `status`, read true/write false ACK |

The test process did not inspect or use the configured `API_SECRET`, so this
release does not claim a fabricated authenticated remote treatment mutation.
JWT, permission, API3 CRUD/history, rollback, expiry, tamper, eviction and
cross-tenant cases are covered by the local Workers/SQLite gate.

## Real-browser evidence

A fresh, isolated headed Chromium session exercised the deployed official UI:

- the homepage rendered Nightscout, the official chart, `BASAL 0.100U` and the
  About-panel version `15.0.7`;
- opening Settings, changing the client-only title and pressing Save closed the
  panel; a fresh navigation did not reopen it. The title was restored to
  `Nightscout`;
- Profile Editor reported `Values loaded`, selected the persisted simulated
  profile and showed `Asia/Shanghai`;
- Food Editor reported `Database loaded` and rendered its official controls;
- Admin rendered its official authentication state; Report rendered its report
  selector and filters; color clock rendered the upstream empty-data state;
- homepage and color clock had zero console errors or warnings;
- Admin, Report, Profile and Food had zero console errors and only the locked
  upstream `Unable to find element for #chartContainer` warning caused by
  standalone pages not containing the homepage chart.

The browser session did not inspect credential storage or use a server-side
secret. An earlier deployed version completed an authenticated Profile Editor
save and introduced the content-addressed service-worker/shim cache fix after
reproducing the original post-save redirect loop. The current release loading
that persisted simulated profile is regression context, not a new credentialed
mutation claim.

## Known limitations

- Public reads and the tenant selector are not a private-health-data security
  boundary; simulated data only.
- A deployed persisted EIO4 polling/read-only-root subset exists, but the
  homepage still uses the REST shim. WebSocket, EIO3 HTTP, `/storage`, `/alarm`,
  root writes and database-change broadcasts remain missing.
- At the 1,000,000-byte malformed-UTF-8 edge, NSCF admission counts streamed
  raw bytes while locked Node can count replacement-expanded text differently.
- API v1 and v2 remain subsets. API v3 implements public version, JWT status,
  treatments-only JSON search/CRUD/history and treatments-aware
  `lastModified`; CSV/XML and the other five generic collections are missing.
- JWT signing, expiry and Shiro permission matching are implemented, but the
  upstream access-token derivation/prefix behavior, request-body credentials
  and persistent per-IP failure delay list are missing.
- MongoDB query, BSON ObjectId, index and update semantics are only partially
  mapped to SQLite.
- `document_changes` is still an unbounded full-body journal. No transport
  consumes it; bounded outbox retention, cursors and alarm pruning are pending.
- Server plugin jobs, real-time database broadcasts, notifications, summary
  persistence and alarm-driven background work remain incomplete.
- Official pages are present, but not every mutation, report, plugin and
  real-time workflow has an upstream-derived browser contract.
- No medical algorithm or dosing advice was added.

See `UPSTREAM_COMPATIBILITY.md` for the evidence matrix and
`EXECUTION_PLAN.md` for the delivery order.

## Rollback

The immediate prior known version is
`e3e9b197-bd1d-45b1-b2c8-a5b18b907e90` (code commit
`78502a01c624d3f8b38e207abd5b7c9d1cea50c8`). It contains the official UI,
cache fix, JWT/API status, activity and treatments storage foundation, but not
the deployed treatments JSON HTTP routes or routed EIO4 session server.

Wrangler version rollback can restore Worker code and assets. SQLite schema
changes through version 5 are additive; rollback must not attempt a destructive
SQLite downgrade. Deleting the whole lab requires deleting the Worker and then
its Durable Object namespace. No D1/R2/KV/Queue/custom-domain cleanup is needed.
