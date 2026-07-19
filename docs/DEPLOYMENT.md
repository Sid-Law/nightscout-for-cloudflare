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
- Deployed code candidate: `b1e7e31a0f4548b3d908e506ad9b87b78b4d4a9a`
- Git HEAD used by Wrangler: `b1e7e31a0f4548b3d908e506ad9b87b78b4d4a9a`
- Cloudflare Version ID: `7385728f-b498-4360-93f5-dbcdac5131c2`
- Version tag/message: `git-b1e7e31` /
  `git b1e7e31 api3 food settings collections`
- Version creation time: not printed by this Wrangler deployment; none is
  inferred
- Activation: direct `wrangler deploy` reported this as the Current Version;
  no separate activation timestamp was printed
- Worker startup: 23 ms
- Deployment ID: not printed by this Wrangler deployment; none is inferred
- Durable Object: class `EntryStore`, SQLite backend, Wrangler migration tag
  `v1`; internal schema includes the v6 Entries compatibility probe
- Static Assets: 248 official v15.0.7 entries; no asset bytes required an
  update in this deployment
- Upload: 884.71 KiB raw / 158.92 KiB gzip
- Provisioned product bindings: `ENTRY_STORE` Durable Object plus `ASSETS`
  only; the preserved `API_SECRET` application credential is not another
  storage/product binding

Deployment used `--keep-vars`, and no credential was supplied to a local or
remote smoke request. A post-deploy metadata inspection demonstrated why
`API_SECRET` must be a Worker **Secret**, not a plaintext variable: Wrangler can
render plaintext variable values. The value is intentionally absent from this
repository and document. The current lab credential should be rotated and
replaced with an encrypted Secret before non-lab use. Post-deployment
documentation changes are not part of the already active Worker version.

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
- the v1/v2 Entries `echo` query-debug envelope for the bounded Entries filter
  subset, including model and ObjectId parameter behavior;
- `/count/:storage/where` for entries, treatments and device status, using SQL
  `COUNT(*)` rather than result materialization and preserving the locked
  empty/group response, storage fallback, ignored result-count/sort and HEAD
  behavior; custom aggregation pipelines are rejected;
- strict v1/v2 Status contracts;
- derived subject credentials, body/query/header credential precedence and a
  persisted authorization-failure delay with a named 60-second Workers cap;
- generic API v3 entries, treatments, device-status, profile, food and settings
  verticals, including JSON/CSV/XML rendering and six-collection
  `lastModified`;
- v1/API3 shared Food identity and history, the locked `created_at`-only Food
  fallback, idempotent repair of pre-slice Food metadata across eviction, and
  the Settings no-fallback rule. Settings search/history require admin while
  single-resource read retains read permission;
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

The count route is not capped at 10,000 matching rows because it returns one
aggregate row and never crosses the DO RPC boundary with the selected
documents. This improves long-range history statistics; it does not remove the
10,000-row limit from ordinary Entries detail responses, which still require
bounded date partitions for long exports.

## Pre-deployment gate

The deployed candidate is
`b1e7e31a0f4548b3d908e506ad9b87b78b4d4a9a`. It adds API v3 Food and Settings,
six-collection `lastModified`, v1/API3 shared Food storage and idempotent Food
metadata repair while retaining the prior Entries, Profile, transport and
official-page work. The table below records the exact local gate completed
before deployment.

| Check | Result |
| --- | --- |
| Locked upstream | `nightscout/cgm-remote-monitor` v15.0.7, pinned commit and archive hash verified |
| Official UI build | Webpack production bundle completed with its three known size warnings |
| Static Assets | 248 official asset entries rebuilt |
| Upstream route/test audit | 161 registrations and 111 test files; generated outputs deterministic |
| Audit tool tests | 14/14 passed |
| Authorization audit tests | 6/6 passed |
| TypeScript | `tsc --noEmit` passed |
| Workers integration tests | 21 files, 239/239 passed |
| Dependency audit | 0 known vulnerabilities after using fixed `qs 6.15.3` |
| Worker dry run | 884.71 KiB raw / 158.92 KiB gzip |
| Dry-run bindings | `ENTRY_STORE` Durable Object and `ASSETS` only |
| Deployment variables | successful command used `--keep-vars`; no credential was supplied to tests or smoke requests |

The locked upstream contains 111 JavaScript test files; a static declaration
audit finds 883 active `it(...)` cases plus one skipped case. The 239 Workers
tests cover the implemented adapter subset; no whole upstream test file is
claimed green. Neither count proves complete compatibility.

## Post-deployment remote API evidence

Wrangler reports version `7385728f-b498-4360-93f5-dbcdac5131c2` as the Current
Version. These credential-free checks verified response content and protocol
markers, not only Wrangler command success.

| Check | Result |
| --- | --- |
| `/healthz` | HTTP 200 |
| `/api/v3/version` | HTTP 200; locked Nightscout version `15.0.7` |
| `/api/v3/food` without JWT | HTTP 401 with the locked missing/bad-token envelope |
| `/api/v3/settings` without JWT | HTTP 401 with the locked missing/bad-token envelope |
| `/api/v1/food/regular.json` | HTTP 200 `[]`; v1 Food read remains public under default permissions |

No credentialed write was attempted. Local tests cover all eight generic routes
for both new collections, Food JSON/CSV/XML, PUT/PATCH/delete/history,
lastModified, v1/v3 visibility and created-at fallback dedupe, plus the Settings
admin search/history exception, XML, resource read/update/delete and idempotent
Food repair across eviction. Prior Entries/JWT/transport evidence remains green
in the full suite but is not relabeled as a new remote smoke.

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

- the homepage rendered the official empty chart state and remained free of
  warning/error logs across a REST-shim polling interval; the public tenant has
  no Entries, so the displayed `---` is expected;
- the official Food Editor changed from `Not loaded` to `Database loaded`,
  populated its empty database controls and showed the expected anonymous
  read-only authentication state.

Profile load/Save-control and its inherited chartless-page warning remain
historical evidence from an earlier version; no authenticated Food/Profile
write was attempted in this release.

This does not prove longer-running stability, Profile Save, Food/Admin
mutation, report generation or every other protected page workflow.

## Known limitations

- External Nightscout/MongoDB history import is not provided; users who require
  it in the new instance must not migrate to this release.
- This remains a simulated-data lab. It must not be connected to a real CGM
  uploader, pump or closed-loop client.
- API v1 and v2 remain subsets. API v3 now routes all six official generic
  collections, but broad large-response resource handling, Mongo mixed-type/
  nested semantics and whole upstream API v3 test execution remain incomplete.
- Entries `times/echo`, `times` and `slice` remain missing. Echo supports
  Entries storage only; count rejects client-supplied aggregation pipelines;
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
`184448f5-bc5e-4766-b0a3-78405ddd3a54` (deployed code commit
`50ce2459306a04eb6be21a7398e381b92451517a`). It contains the prior Entries
count/echo increment but not the API v3 Food/Settings verticals.

Wrangler version rollback can restore Worker code and assets. Neither rollback
nor redeployment clears or rolls back SQLite Durable Object data, and rollback
must not attempt a destructive schema downgrade. Deleting the whole lab
requires deleting the Worker and then its Durable Object namespace. No
D1/R2/KV/Queue/custom-domain cleanup is needed.
