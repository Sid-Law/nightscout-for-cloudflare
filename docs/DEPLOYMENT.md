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
- Deployed code candidate: `a732524271e9a282ad50d7b86817a10ad8a250a3`
- Git HEAD used by Wrangler: `a732524271e9a282ad50d7b86817a10ad8a250a3`
- Cloudflare Version ID: `be7b9bee-7c9a-43d2-a26c-66b58ed196ad`
- Version tag/message: `git-a732524` /
  `git a732524 v1 entries uploader contract fixes`
- Version creation time: 2026-07-19T02:25:08.249Z
- Activated: 2026-07-19T02:25:09.076Z
- Traffic: 100%
- Worker startup: 21 ms
- Deployment ID: `3351aacc-0020-4f62-8ba8-f9b08d0ae70b`
- Durable Object: class `EntryStore`, SQLite backend, Wrangler migration tag
  `v1`; internal schema includes the v6 Entries compatibility probe
- Static Assets: 248 official v15.0.7 entries; no asset bytes required an
  update in this deployment
- Upload: 874.79 KiB raw / 157.16 KiB gzip
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

- an adapted v1/v2 Entries vertical: single/array/extended-urlencoded uploads,
  preview, body-credential removal precedence, ordered batch-prefix commits,
  all non-ObjectId uploader sync IDs preserved as `identifier`, bounded scalar
  query/sort with controlled SQL-limit errors, indexed `dateString`,
  current/model/ID reads, JSON/plain/CSV/TSV, weak ETags, conditional GET and
  HEAD, including the exact base-`/entries` runtime-SGV IMS precheck;
- idempotent fail-closed string sanitization, so read-then-reupload does not
  grow `&amp;` into `&amp;amp;`;
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
two-day window. Broad `dateString` ranges and unindexed candidate sets above
10,000 return a controlled 413; indexed sparse `dateString` matches remain
bounded. Request bodies are capped at 512 KiB, batches at 100, synchronous
deletion/revision cleanup at 128, and only the bounded safe `$re` subset is
compiled to SQLite `GLOB`.

## Pre-deployment gate

The deployed candidate is
`a732524271e9a282ad50d7b86817a10ad8a250a3`. It includes the adapted v1/v2
Entries uploader/query/read-protocol slice and retains the prior API v3 Profile,
v1/API3 shared storage and official-page work. The table below records the
exact local gate completed before deployment.

| Check | Result |
| --- | --- |
| Locked upstream | `nightscout/cgm-remote-monitor` v15.0.7, pinned commit and archive hash verified |
| Official UI build | Webpack production bundle completed with its three known size warnings |
| Static Assets | 248 official asset entries rebuilt |
| Upstream route/test audit | 161 registrations and 111 test files; generated outputs deterministic |
| Audit tool tests | 14/14 passed |
| Authorization audit tests | 6/6 passed |
| TypeScript | `tsc --noEmit` passed |
| Workers integration tests | 20 files, 232/232 passed |
| Dependency audit | 0 known vulnerabilities after using fixed `qs 6.15.3` |
| Worker dry run | 874.79 KiB raw / 157.16 KiB gzip |
| Dry-run bindings | `ENTRY_STORE` Durable Object and `ASSETS` only |
| Deployment variables | successful command used `--keep-vars`; configured secret was not read or printed |

The locked upstream contains 111 JavaScript test files; a static declaration
audit finds 883 active `it(...)` cases plus one skipped case. The 232 Workers
tests cover the implemented adapter subset; no whole upstream test file is
claimed green. Neither count proves complete compatibility.

## Post-deployment remote API evidence

Cloudflare reports version `be7b9bee-7c9a-43d2-a26c-66b58ed196ad` at 100%
traffic. These checks verified response content and protocol markers, not only
Wrangler command success.

| Check | Result |
| --- | --- |
| `/healthz` | HTTP 200 |
| `/api/v3/version` | HTTP 200; locked Nightscout version `15.0.7` |
| `/` | HTTP 200, `text/html; charset=utf-8` |
| `/split/` | HTTP 200, `text/html; charset=utf-8` |
| `/api/v1/entries.json?count=1` | HTTP 200 `[]`; JSON type, `Vary: Accept`, 2-byte length and weak ETag |
| Extensionless Entries and `.txt` | HTTP 200 empty `text/plain` with zero-byte length and weak ETag |
| Entries `.csv` and `.tsv` | HTTP 200 empty selected text representation with zero-byte length and weak ETag |
| Entries `.html` and unsupported Accept | HTTP 200 JSON fallback `[]` |
| Entries uppercase `.JSON` | HTTP 404, preserving the locked extension fallthrough |
| Entries CSV HEAD | HTTP 200, no body; content type, zero-byte length, `Vary` and weak ETag preserved |
| Entries `If-None-Match` | curl received HTTP 304 with no body, emitted weak ETag and `Vary: Accept` |
| Legal filter above SQLite's binding budget | HTTP 400 `invalid_query`, not an internal 500 |
| v2 Entries current/model JSON | HTTP 200 `[]`, proving inherited read routing |
| `/api/v1/count/entries/where` | HTTP 404; the unported utility was not exposed accidentally |
| `/api/v1/profile/current` | HTTP 200 JSON object; contents not recorded in the remote smoke |
| Final collection counts | zero Entries and one profile; no profile values recorded |

No credentialed write was attempted because the test process did not read or
use the configured secret. Local JWT, permission, API v3 CRUD/history,
Entries upload/batch/query/Last-Modified, rollback, expiry, tamper, eviction and
cross-tenant cases remain covered by the Workers/SQLite test gate. The empty
public Entries collection cannot prove non-empty sorting or Last-Modified.

## Post-deployment real-time evidence

This release changed no real-time transport code, so its credential-free
polling/direct-WebSocket protocol smokes were not repeated. The table below
records historical remote evidence retained from the immediately preceding
deployed transport increment.

| Check | Result |
| --- | --- |
| Historical EIO4 polling open | `upgrades: []`, 25 s ping interval, 20 s timeout, 1,000,000-byte maximum |
| Historical polling SIO5 flow | root CONNECT and `clients` packet completed |
| Historical wider flow | polling/direct-WebSocket authorize, `dataUpdate` and ACK |

These checks prove the named read-only-root slices. They do not prove polling
upgrade, EIO3, namespaces, writes or change broadcasts.

## Real-browser evidence

A real browser session exercised the deployed official UI without reading
credential storage or submitting protected mutations:

- the homepage rendered the official Nightscout chart and received repeated
  15-second REST-shim `dataUpdate` events without a warning/error;
- Profile reported `Values loaded.` and exposed the official Save control; no
  authenticated Save was attempted;
- the locked upstream bundle emitted two known
  `Unable to find element for #chartContainer` warnings on Profile, which
  intentionally has no chart container; no browser error was observed.

This does not prove longer-running stability, Profile Save, Food/Admin
mutation, report generation or every other protected page workflow.

## Known limitations

- External Nightscout/MongoDB history import is not provided; users who require
  it in the new instance must not migrate to this release.
- This remains a simulated-data lab. It must not be connected to a real CGM
  uploader, pump or closed-loop client.
- API v1 and v2 remain subsets. The deployed API v3 has version, JWT status and
  the generic entries/treatments/device-status/profile verticals. Food,
  settings and broad large-response resource parity remain missing.
- Entries `echo`, `times/echo`, `times`, `count` and `slice` remain missing;
  exact DOMPurify output, wider Mongo query/mixed-type behavior and the locked
  malformed-uploader response shapes remain adapted or incomplete.
- An Entries request selecting thousands of documents with abnormally large
  custom fields is still materialized for sorting/formatting/ETag generation
  and can approach Workers Free CPU/memory limits. The ordinary compact-SGV
  path retains `count=10000`; a total-result budget or streaming redesign is
  deliberately deferred as an extreme-request hardening task.
- MongoDB query, BSON ObjectId, index, mixed-type, array and update semantics
  are only partially mapped to SQLite.
- Cloudflare can strip `Content-Length` from some dynamic Status/finalhandler
  responses. This release's Entries GET/HEAD smoke retained its exact length;
  the remaining transport difference stays scoped and non-blocking.
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
`8bd1a80c-a3a8-405e-bde1-10c16d74f5b9` (deployed code commit
`e2526c3fca53f4891564088127cf38a066571bbd`). It contains the prior Entries
uploader/query/read increment but not the uploader-identity, idempotent
sanitizer, extended-form, controlled-query-error or runtime-SGV IMS fixes.

Wrangler version rollback can restore Worker code and assets. Neither rollback
nor redeployment clears or rolls back SQLite Durable Object data, and rollback
must not attempt a destructive schema downgrade. Deleting the whole lab
requires deleting the Worker and then its Durable Object namespace. No
D1/R2/KV/Queue/custom-domain cleanup is needed.
