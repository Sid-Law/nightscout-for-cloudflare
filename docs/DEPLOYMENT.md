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

Newer local integration commit
`d8e406d13b87b2e304b1db4dc075af18ae463022` is **not deployed** at the time of
this record. It adds strict v1/v2 Status, the derived/body-credential and
persisted-delay authorization increment, direct Hibernatable EIO4 WebSocket and
API v3 Entries. Do not attribute those additions or its 215/215 local tests to
the Cloudflare Version ID above.

## Cloudflare footprint

The project uses exactly:

1. one Worker;
2. one Workers Static Assets deployment;
3. one SQLite Durable Object namespace.

It does not create or use D1, R2, KV, Queues, a custom domain or a zone route.
The public instance is for simulated data only and must not receive real health
data or CGM credentials.

## Pending local candidate

The 18-file Workers-runtime suite at local commit
`d8e406d13b87b2e304b1db4dc075af18ae463022` passes 215/215. Final build,
Wrangler dry-run also passed: the official v15.0.7 build emitted only its three
known size warnings, Wrangler read 248 assets, measured 764.00 KiB raw / 135.65
KiB gzip, and listed only `ENTRY_STORE` plus `ASSETS`. Deployment, remote
API/direct-WebSocket smoke and real-browser workflows are still pending and
must be appended here with the actual new Cloudflare IDs. No version or
deployment result is predicted in advance.
Direct WebSocket also retains a named at-most-once crash window between durable
queue removal and `send()`; the local tests do not turn that into an exactly-
once delivery claim.

Its Entries storage policy is fresh-only for the pre-1.0 simulated lab. An
incompatible narrow `entries` shadow is reset instead of imported; canonical
documents and other collections, including profile, are retained. At
2026-07-18 14:51 UTC, read-only remote checks returned `[]` (zero records) from
`/api/v1/entries.json?count=10000` and a one-element array from
`/api/v1/profile.json`. No profile content was copied. Therefore this particular
lab has no old simulated Entry row to lose while the existing profile remains
in the preserved collection. This is not a migration guarantee for an existing
Nightscout installation.

Wrangler deployment does not clear the existing SQLite Durable Object. The
planned initial family onboarding model is a newly created Worker/SQLite DO
namespace or other empty NSCF tenant, not an import of an external MongoDB
history. This release upgrades the existing public Worker in place, so its
canonical profile and other documents remain. A truly empty reset would require
a separate namespace or an explicitly destructive deletion.

The candidate keeps v1 Entries' four-day default window and uses a two-day
canonical Entries window for realtime/ddata. Unindexed or `dateString`
candidate sets above 10,000 return controlled 413, synchronous deletion and
revision cleanup are capped at 128, and only a bounded safe `$re` subset is
compiled to SQLite `GLOB`. Realtime and authorization-delay cleanup share the
one alarm available to each DO; failed-auth admin notification remains missing,
and enforced authorization delay is capped at 60 seconds.

## Deployed release pre-deployment gate

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
| `/api/v1/profile.json?count=20` | HTTP 200 JSON; stored simulated profile returned |
| `/api/v1/food.json` | HTTP 200 JSON array |
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
- Profile Editor and Food Editor rendered their official controls. The
  immediate snapshot still showed the initial `Not loaded` text and their
  authentication state was `Unauthorized`;
- Admin rendered its official authentication state; Report rendered its report
  selector and filters; color clock rendered the upstream empty-data state;
- no console error was observed; the only messages were three locked-upstream
  `Unable to find element for #chartContainer` warnings on standalone pages.

This confirms that the Settings close/reopen regression is not reproducing, but
it does not close the Profile/Food save contract. Direct requests made after
the browser run returned HTTP 200 for both page-data endpoints, including the
stored simulated profile. Therefore the browser's initial `Not loaded` text is
not classified as a backend API failure; the credentialed save workflow simply
was not re-exercised in this release.

## Known limitations

- Public reads and the tenant selector are not a private-health-data security
  boundary; simulated data only. Neither the deployed version nor the local
  candidate may be connected to a real CGM uploader, pump or closed-loop
  client.
- The deployed release has persisted EIO4 polling/read-only-root only. The
  local candidate adds direct Hibernatable EIO4 WebSocket, but neither version
  switches the homepage from the REST shim. Polling-to-WebSocket upgrade, EIO3
  HTTP, `/storage`, `/alarm`, root writes and database-change broadcasts remain
  missing.
- At the 1,000,000-byte malformed-UTF-8 edge, NSCF admission counts streamed
  raw bytes while locked Node can count replacement-expanded text differently.
- API v1 and v2 remain subsets. The deployed API v3 has public version, JWT
  status, treatments and device status. The local candidate adds Entries as the
  third generic collection and strict v1/v2 Status. Food, profile, settings and
  large-response renderer resource controls remain missing.
- JWT signing, expiry and Shiro permission matching are deployed. The local
  candidate adds access-token derivation/prefix behavior, request-body
  credentials and the persisted per-IP delay list. Failed-auth admin
  notification emission is still missing, and the enforced delay has a named
  60-second platform cap.
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
changes through version 5 are additive; neither rollback nor redeployment
clears or rolls back SQLite, and rollback must not attempt a destructive
downgrade. Deleting the whole lab requires deleting the Worker and then its
Durable Object namespace. No D1/R2/KV/Queue/custom-domain cleanup is needed.
