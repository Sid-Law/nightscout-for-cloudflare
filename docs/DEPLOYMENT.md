# Current deployment record

Last synchronized: 2026-07-19 (Asia/Shanghai)

## Status

The public Worker is deployed and healthy, but it is **not a complete
Nightscout port**. It serves the locked official v15.0.7 browser assets and the
named compatibility subset in `UPSTREAM_COMPATIBILITY.md`. Page availability
is not counted as API, plugin or real-time compatibility.

- Public URL: <https://nscf-phase1.nscf-lab-20260717.workers.dev/>
- Account ID: `fad59c859cb78943d97441581dfcab78`
- Worker: `nscf-phase1`
- Deployed code candidate: `39761161590977570a46a64976f9e59bc99d84f4`
- Git HEAD used by Wrangler: `39761161590977570a46a64976f9e59bc99d84f4`
- Cloudflare Version ID: `6336334e-002c-4ccf-9e9f-ddb7f2191b10`
- Version creation time: not separately displayed by the successful Wrangler
  command; none is inferred
- Activated: 2026-07-18T17:00:31.552157Z
- Traffic: 100%
- Worker startup: 21 ms
- Deployment ID: not displayed by this Wrangler deployment output; none is
  inferred
- Durable Object: class `EntryStore`, SQLite backend, Wrangler migration tag
  `v1`; internal schema includes the v6 Entries compatibility probe
- Static Assets: 248 official v15.0.7 entries; no asset bytes required an
  update in this deployment
- Upload: 766.80 KiB raw / 136.08 KiB gzip
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
- generic API v3 entries, treatments, device-status and profile verticals,
  including JSON/CSV/XML rendering and four-collection `lastModified`;
- v1/API3 shared Profile identity, AAPS create/retry/new-version behavior,
  idempotent legacy metadata repair and common current-profile ordering;
- an HTML response-boundary correction for official secondary pages. Split
  specifically discards stale asset validators and returns `no-store`, so
  a browser replaces an earlier Cloudflare `text/plain` representation with
  the unchanged official HTML bytes;
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

The first release does not provide external Nightscout/MongoDB history import.
It is intended only for a fresh Worker/SQLite Durable Object namespace or an
empty tenant. A family that needs its existing history to remain available in
the new instance should keep the existing Nightscout deployment and should not
switch yet.

An ordinary Wrangler redeploy updates code and Static Assets but preserves the
existing Durable Object namespace; it is not a reset. Every supported NSCF
schema upgrade must remain forward-compatible, idempotent and data-preserving.
Deferring external history import does not permit dropping existing NSCF data.
A truly empty reset requires a new namespace or an explicitly destructive
operation.

V1 Entries keeps the locked four-day default window; realtime/ddata uses a
two-day window. Unindexed or `dateString` candidate sets above 10,000 return a
controlled 413, synchronous deletion/revision cleanup is capped at 128, and
only the bounded safe `$re` subset is compiled to SQLite `GLOB`.

## Pre-deployment gate

The deployed candidate is
`39761161590977570a46a64976f9e59bc99d84f4`. It includes API v3 Profile,
v1/API3 shared Profile storage and the Split HTML/cache repair. The table below
records the exact local gate completed before the final deployment.

| Check | Result |
| --- | --- |
| Locked upstream | `nightscout/cgm-remote-monitor` v15.0.7, pinned commit and archive hash verified |
| Official UI build | Webpack production bundle completed with its three known size warnings |
| Static Assets | 248 official asset entries rebuilt |
| Upstream route/test audit | 161 registrations and 111 test files; generated outputs deterministic |
| Audit tool tests | 14/14 passed |
| Authorization audit tests | 6/6 passed |
| TypeScript | `tsc --noEmit` passed |
| Workers integration tests | 19 files, 224/224 passed |
| Worker dry run | 766.80 KiB raw / 136.08 KiB gzip |
| Dry-run bindings | `ENTRY_STORE` Durable Object and `ASSETS` only |
| Planned deployment variables | command uses `--keep-vars`; configured secret will not be read or printed |

The locked upstream contains 111 JavaScript test files and approximately 873
test cases. The 224 Workers tests cover the implemented adapter subset; no
whole upstream test file is claimed green. Neither count proves complete
compatibility.

## Post-deployment remote API evidence

Cloudflare reports version `6336334e-002c-4ccf-9e9f-ddb7f2191b10` at 100%
traffic. These checks verified response content and protocol markers, not only
Wrangler command success.

| Check | Result |
| --- | --- |
| `/healthz` | HTTP 200 |
| `/` | HTTP 200, `text/html; charset=utf-8` |
| `/split/` | HTTP 200, `text/html; charset=utf-8` |
| `/api/v1/entries.json?count=1` | HTTP 200 JSON array, length 0 |
| `/api/v1/profile/current` | HTTP 200 JSON object; contents not recorded in the remote smoke |
| `/api/v2/ddata/at` | HTTP 200 |
| `/api/v3/profile` without Bearer token | HTTP 401 |

No credentialed write was attempted because the test process did not read or
use the configured secret. Local JWT, permission, API v3 CRUD/history,
rollback, expiry, tamper, eviction and cross-tenant cases remain covered by the
Workers/SQLite test gate.

## Post-deployment real-time evidence

The realtime implementation was last remotely exercised after the API v3
Profile deployment. The later Split-only response/cache commits did not change
the EIO4/DO code, but the complete protocol smoke was not repeated after the
final HTML deployment; the final homepage did complete one REST-shim polling
interval without a new warning/error.

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
- Settings remained closed through a complete 17-second polling interval, with
  no new console warning/error;
- Profile reported `Values loaded.` and exposed the official Save control; no
  authenticated Save was attempted;
- Admin, Food, Report, both clock views and both Swagger pages rendered their
  official controls;
- the browser reproduced an old cached Split `text/plain`/`PRE` response, then
  returned through the homepage and verified the original `/split/` URL as
  `text/html`, title `Nightscout multiframe view`, a table root and no literal
  HTML source. Secondary pages retain the upstream bundle's known missing
  `#chartContainer` warning.

The Settings rebound did not recur during this 17-second observation. This does
not prove longer-running stability, Profile Save, Food/Admin mutation, report
generation or every other protected page workflow.

## Known limitations

- External Nightscout/MongoDB history import is not provided; users who require
  it in the new instance must not migrate to this release.
- This remains a simulated-data lab. It must not be connected to a real CGM
  uploader, pump or closed-loop client.
- API v1 and v2 remain subsets. The deployed API v3 has version, JWT status and
  the generic entries/treatments/device-status/profile verticals. Food,
  settings and broad large-response resource parity remain missing.
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
`ffeb6e18-a0b0-486c-8eec-80fc9c13fa6f` (code commit
`98fafb6d0842447b2d990f2483019092116fe4e6`). It contains API v3 Profile and
the first Split MIME correction, but not the final stale-validator/no-store
recovery for an already cached `text/plain` representation.

Wrangler version rollback can restore Worker code and assets. Neither rollback
nor redeployment clears or rolls back SQLite Durable Object data, and rollback
must not attempt a destructive schema downgrade. Deleting the whole lab
requires deleting the Worker and then its Durable Object namespace. No
D1/R2/KV/Queue/custom-domain cleanup is needed.
