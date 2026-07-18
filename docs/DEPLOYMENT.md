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
- Deployed code candidate: `d8e406d13b87b2e304b1db4dc075af18ae463022`
- Git HEAD used by Wrangler: `ac0947dc6139d16e424cc212e3757dde0c7c088b`
- Cloudflare Version ID: `65db0a2f-9f4e-4c41-8edf-de85bb49c31d`
- Version created: 2026-07-18T15:13:42.034Z
- Activated: 2026-07-18T15:13:42.775Z
- Traffic: 100%
- Worker startup: 20 ms
- Deployment ID: not displayed by this Wrangler deployment output; none is
  inferred
- Durable Object: class `EntryStore`, SQLite backend, Wrangler migration tag
  `v1`; internal schema includes the v6 Entries compatibility probe
- Static Assets: 248 official v15.0.7 entries; no asset bytes required an
  update in this deployment
- Upload: 764.00 KiB raw / 135.65 KiB gzip
- Bindings: `ENTRY_STORE` Durable Object plus `ASSETS` only

Deployment used `--keep-vars`. The configured `API_SECRET` value was never read,
printed or copied. Post-deployment documentation changes are expected not to be
part of the already active Worker version.

## Cloudflare footprint

The project uses exactly:

1. one Worker;
2. one Workers Static Assets deployment;
3. one SQLite Durable Object namespace.

It does not create or use D1, R2, KV, Queues, a custom domain or a zone route.
The public instance is for simulated data only and must not receive real health
data, CGM credentials, pump credentials or closed-loop traffic.

## Release content

This increment deploys:

- strict v1/v2 Status contracts;
- derived subject credentials, body/query/header credential precedence and a
  persisted authorization-failure delay with a named 60-second Workers cap;
- generic API v3 entries, treatments and device-status verticals, including
  JSON/CSV/XML rendering and three-collection `lastModified`;
- persisted EIO4 polling and direct Hibernatable WebSocket read-only-root
  slices with SIO5 CONNECT, clients count, authorization, `dataUpdate`, ACK and
  one SQL-derived Durable Object alarm;
- the locked official v15.0.7 UI and the existing REST polling shim.

The homepage still uses the REST shim; deploying the separate EIO4 server does
not switch the official browser bundle to that transport.

## Fresh-family and storage policy

Entries uses a deliberate fresh-only policy for the incompatible pre-1.0 lab
shadow table. Activation resets only that narrow shadow; canonical documents
and other collections, including profile, are preserved. A read-only check at
2026-07-18 14:51 UTC found zero Entries and one profile. Post-deployment reads
again returned zero Entries and one profile, without inspecting or recording
the profile contents. This lab therefore had no simulated Entry row to lose.

This is not a migration guarantee for an existing Nightscout/MongoDB database.
The initial release path for new families is a fresh Worker/SQLite Durable
Object namespace or an empty tenant. Importing years of external history is an
optional later tool and is not a first-release blocker.

An ordinary Wrangler redeploy updates code and Static Assets but preserves the
existing Durable Object namespace. It does not reset stored profile or document
data. A truly empty reset would require a new namespace or an explicitly
destructive deletion.

V1 Entries keeps the locked four-day default window; realtime/ddata uses a
two-day window. Unindexed or `dateString` candidate sets above 10,000 return a
controlled 413, synchronous deletion/revision cleanup is capped at 128, and
only the bounded safe `$re` subset is compiled to SQLite `GLOB`.

## Pre-deployment gate

| Check | Result |
| --- | --- |
| Locked upstream | `nightscout/cgm-remote-monitor` v15.0.7, pinned commit and archive hash verified |
| Official UI build | Webpack production bundle completed with its three known size warnings |
| Static Assets | 248 official asset entries rebuilt |
| Upstream route/test audit | 161 registrations and 111 test files; generated outputs deterministic |
| Audit tool tests | 14/14 passed |
| TypeScript | `tsc --noEmit` passed |
| Workers integration tests | 18 files, 215/215 passed |
| Worker dry run | 764.00 KiB raw / 135.65 KiB gzip |
| Dry-run bindings | `ENTRY_STORE` Durable Object and `ASSETS` only |
| Deployment variables | `--keep-vars`; configured secret neither read nor printed |

The locked upstream contains 111 JavaScript test files and approximately 873
test cases. The 215 Workers tests cover the implemented adapter subset; no
whole upstream test file is claimed green. Neither count proves complete
compatibility.

## Post-deployment remote API evidence

Cloudflare reports version `65db0a2f-9f4e-4c41-8edf-de85bb49c31d` at 100%
traffic. These checks verified response content and protocol markers, not only
Wrangler command success.

| Check | Result |
| --- | --- |
| `/healthz` | HTTP 200 |
| `/api/v3/version` | HTTP 200 |
| `/api/v1/entries.json?count=1` | HTTP 200 JSON array, length 0 |
| `/api/v1/profile.json` | HTTP 200 JSON array, length 1; contents not recorded |
| v1/v2 Status text forms | HTTP 200 for `.txt` and `Accept: text/plain` |
| unknown Status extension | HTTP 404 |
| `/api/v2/ddata/at` | HTTP 200 |
| `/api/v3/entries` without Bearer token | HTTP 401 |

No credentialed write was attempted because the test process did not read or
use the configured secret. Local JWT, permission, API v3 CRUD/history,
rollback, expiry, tamper, eviction and cross-tenant cases remain covered by the
Workers/SQLite test gate.

## Post-deployment real-time evidence

| Check | Result |
| --- | --- |
| EIO4 polling open | `upgrades: []`, 25 s ping interval, 20 s timeout, 1,000,000-byte maximum |
| Polling SIO5 flow | CONNECT, `clients`, read-only authorize, `dataUpdate` and ACK completed |
| Direct WebSocket flow | open, CONNECT, `clients`, connected authorization, `dataUpdate` and ACK completed |

These checks prove the named read-only-root slices. They do not prove polling
upgrade, EIO3, namespaces, writes or change broadcasts.

## Real-browser evidence

A real Playwright session exercised the deployed official UI without reading
credential storage or submitting protected mutations:

- the homepage rendered the official Nightscout chart and About version
  `15.0.7`;
- after closing Settings, it remained closed across multiple 15-second
  `dataUpdate` rounds instead of reopening;
- Profile Values loaded; no authenticated Save was attempted;
- Admin, Food, Report and `/clock/clock-color` rendered their official controls;
- there were zero console errors; only known upstream/browser warnings were
  observed.

This closes the observed Settings rebound regression for the tested release.
It does not prove Profile Save, Food/Admin mutation, report generation or every
other protected page workflow.

## Known limitations

- This remains a simulated-data lab. It must not be connected to a real CGM
  uploader, pump or closed-loop client.
- API v1 and v2 remain subsets. API v3 has version, JWT status and the generic
  entries/treatments/device-status verticals; food, profile, settings and broad
  large-response resource parity remain missing.
- MongoDB query, BSON ObjectId, index, mixed-type, array and update semantics
  are only partially mapped to SQLite.
- Cloudflare strips `Content-Length` from dynamic responses, including HEAD.
  Status code, `Content-Type`, `Vary` and empty-body semantics remain correct;
  this is a non-blocking P2 platform difference.
- Polling-to-WebSocket upgrade, EIO3 HTTP, `/storage`, `/alarm`, root writes and
  database-change broadcasts remain missing. Direct WebSocket retains a named
  at-most-once crash window between durable dequeue and `send()`.
- `document_changes` is still an unbounded full-body journal. No transport
  consumes it; bounded outbox retention, cursors and alarm pruning are pending.
- Failed-auth admin notification emission is missing; enforced delay has a
  named 60-second platform cap. Repeated/bracket secret arrays are deliberately
  handled safely instead of reproducing the locked upstream unhandled
  rejection.
- Server plugin jobs, notifications, summary persistence and the general
  alarm-driven background scheduler remain incomplete.
- Official pages are present, but not every mutation, report, plugin and
  real-time workflow has an upstream-derived browser contract.
- No medical algorithm or dosing advice was added.

See `UPSTREAM_COMPATIBILITY.md` for the evidence matrix and
`EXECUTION_PLAN.md` for the delivery order.

## Rollback

The immediate prior Cloudflare version is
`e8e7970b-65bb-412f-ba74-193ce14575c5` (code commit
`0319a8d5e78fc77c4c53c0a94724b706d7ec8255`). It lacks this increment's strict
Status, expanded authorization, direct Hibernatable WebSocket and API v3
Entries work.

Wrangler version rollback can restore Worker code and assets. Neither rollback
nor redeployment clears or rolls back SQLite Durable Object data, and rollback
must not attempt a destructive schema downgrade. Deleting the whole lab
requires deleting the Worker and then its Durable Object namespace. No
D1/R2/KV/Queue/custom-domain cleanup is needed.
