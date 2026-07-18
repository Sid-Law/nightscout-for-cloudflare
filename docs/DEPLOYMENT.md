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
- Deployed code commit: `0319a8d5e78fc77c4c53c0a94724b706d7ec8255`
- Cloudflare Version ID: `e8e7970b-65bb-412f-ba74-193ce14575c5`
- Traffic: 100%
- Activated: 2026-07-18 08:13:13 UTC
- Deployment ID: `61198de0-8045-4276-b2ee-d21e12907f04`
- Durable Object: class `EntryStore`, SQLite backend, Wrangler migration tag
  `v1`; internal additive schema is current through version 5
- Static Assets: 248 Wrangler asset entries from the official v15.0.7 build
- Worker startup: Cloudflare reported 22 ms
- Observability and invocation logs: enabled

This release deploys the treatments and device-status API v3 generic verticals
with locked JSON/CSV/XML rendering, plus the bounded persisted read-only
EIO4/SIO5 polling-root slice and its SQL-derived DO alarm. The official
homepage still uses the REST polling shim; deploying the server endpoint is not
a homepage transport switch. Wrangler retained existing dashboard variables
with `--keep-vars`. The configured `API_SECRET` value was never read or printed.

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
| Workers integration tests | 12 files, 141/141 passed |
| Worker dry run | 651.05 KiB raw / 113.32 KiB gzip |
| Dry-run bindings | `ENTRY_STORE` Durable Object and `ASSETS` only |
| Git state | clean at deployed code commit |

The locked upstream contains 111 JavaScript test files and approximately 873
test cases. The 141 Workers tests cover the implemented adapter subset; no
whole upstream test file is claimed green. Neither count proves complete
compatibility.

## Post-deployment remote evidence

Cloudflare reports version `e8e7970b-65bb-412f-ba74-193ce14575c5` at 100%
traffic from 2026-07-18 08:13:13 UTC. The smoke checks response content and
protocol markers, not only Wrangler command success.

| Check | Result |
| --- | --- |
| `/` | HTTP 200, official HTML |
| `/admin`, `/profile`, `/food`, `/report`, `/clock/clock-color` | HTTP 200 |
| `/api/v1/entries.json?count=1` | HTTP 200 JSON |
| `/api/v3/version` | HTTP 200; Nightscout `15.0.7`, API `3.0.3-alpha`, SQLite Durable Object adapter metadata |
| `/api/v3/status` without JWT | HTTP 401 JSON |
| `/api/v3/treatments` without JWT | HTTP 401 JSON |
| `/api/v3/devicestatus` without JWT | HTTP 401 JSON |
| `/api/v3/devicestatus.nscf-unknown` | HTTP 406 |
| EIO4 polling open | HTTP 200; 20-character SID, `upgrades: []`, 25 s ping, 20 s timeout, 1,000,000-byte maximum |
| SIO5 root CONNECT | POST 200 `ok`; next poll contained CONNECT |
| Read-only authorize | POST 200 `ok`; next poll contained `dataUpdate`, `status`, read true/write false ACK |
| Alarm-driven heartbeat | after a 26 s hold the next poll contained Engine.IO ping; pong and close returned HTTP 200 |

The test process did not inspect or use the configured `API_SECRET`, so this
release does not claim a fabricated authenticated remote treatment mutation.
JWT, permission, API3 CRUD/history, rollback, expiry, tamper, eviction and
cross-tenant cases are covered by the local Workers/SQLite gate.

## Real-browser evidence

A real in-app browser session exercised the deployed official UI without
reading credential storage or submitting protected mutations:

- the homepage rendered Nightscout, the official chart, `BASAL 0.100U` and the
  About-panel version `15.0.7`;
- opening and closing Settings left the panel closed after repeated delayed
  checks; no save was attempted;
- Profile Editor and Food Editor rendered their official controls but reported
  `Not loaded`; their authentication state was `Unauthorized`;
- Admin rendered its official authentication state; Report rendered its report
  selector and filters; color clock rendered the upstream empty-data state;
- no console error was observed; the only messages were three locked-upstream
  `Unable to find element for #chartContainer` warnings on standalone pages.

This confirms that the Settings close/reopen regression is not reproducing, but
it does not close the Profile/Food save contract. Their current
`Not loaded`/`Unauthorized` states are an explicit remaining API/auth gap, not
a successful workflow claim.

## Known limitations

- Public reads and the tenant selector are not a private-health-data security
  boundary; simulated data only.
- A deployed persisted EIO4 polling/read-only-root subset exists, but the
  homepage still uses the REST shim. WebSocket, EIO3 HTTP, `/storage`, `/alarm`,
  root writes and database-change broadcasts remain missing.
- At the 1,000,000-byte malformed-UTF-8 edge, NSCF admission counts streamed
  raw bytes while locked Node can count replacement-expanded text differently.
- API v1 and v2 remain subsets. API v3 implements public version, JWT status,
  treatment and device-status generic search/CRUD/history, both collections in
  `lastModified`, and locked small/medium JSON/CSV/XML rendering. Entries,
  food, profile and settings plus large-response renderer resource controls
  remain missing.
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

The immediate prior version is
`6cffd451-08e1-4dd5-b582-df7e5e6cbb6e` (code commit
`08b2970b129104a2bdbb293502abd9aa025a19a5`). It contains the official UI,
cache fix, treatments API v3 JSON vertical and read-only EIO4 polling root, but
not device-status API v3, locked CSV/XML rendering or persistent realtime alarm.

Wrangler version rollback can restore Worker code and assets. SQLite schema
changes through version 5 are additive; rollback must not attempt a destructive
SQLite downgrade. Deleting the whole lab requires deleting the Worker and then
its Durable Object namespace. No D1/R2/KV/Queue/custom-domain cleanup is needed.
