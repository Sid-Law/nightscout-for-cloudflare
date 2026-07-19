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
- Deployed code candidate: `f872343a6851198f3d18d6cf80108cdf05c13ede`
- Git HEAD used by Wrangler: `f872343a6851198f3d18d6cf80108cdf05c13ede`
- Cloudflare Version ID: `9e4ce398-8035-4d57-be1d-ab85373d3782`
- Version tag/message: `git-f872343` /
  `git f872343 api3 alarm socket`
- Version creation time: not printed by this Wrangler deployment; none is
  inferred
- Activation: direct `wrangler deploy` reported this as the Current Version;
  no separate activation timestamp was printed
- Worker startup: 22 ms
- Deployment ID: not printed by this Wrangler deployment; none is inferred
- Durable Object: class `EntryStore`, SQLite backend, Wrangler migration tag
  `v1`; internal schema includes the v6 Entries compatibility probe and the v9
  persisted API3 storage-namespace tables plus the v10 alarm connection and
  silence tables
- Static Assets: 248 official v15.0.7 entries; no asset bytes required an
  update in this deployment
- Upload: 907.72 KiB raw / 162.85 KiB gzip
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
- the EIO4/SIO5 API v3 `/storage` namespace with subject access-token
  authorization, official room filtering and Settings-admin exception;
  namespace connection/subscription state and bounded outbound packets persist
  across Durable Object eviction, and only successful API3 mutations emit the
  locked `create`, `update` or `delete` event;
- the EIO4/SIO5 API v3 `/alarm` namespace with independent connection, locked
  native access-token and web secret/JWT/anonymous subscription branches,
  exact response envelopes, persisted ACK/silence authority and a trusted
  tenant-local notification outlet. It classifies and broadcasts the five
  locked event names live to current namespace connections, with exact
  all-clear ACK payloads and Urgent-to-Warning snooze behavior. Server plugins
  and the notification engine do not yet produce those events;
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
`f872343a6851198f3d18d6cf80108cdf05c13ede`. It adds the persisted API v3
`/alarm` transport/auth/ACK/notification-outlet slice while retaining the
prior `/storage`, six-collection API3, Entries, Profile, transport and
official-page work.
The table below records the exact local gate completed before deployment.

| Check | Result |
| --- | --- |
| Locked upstream | `nightscout/cgm-remote-monitor` v15.0.7, pinned commit and archive hash verified |
| Official UI build | Webpack production bundle completed with its three known size warnings |
| Static Assets | 248 official asset entries rebuilt |
| Upstream route/test audit | 161 registrations and 111 test files; generated outputs deterministic |
| Audit tool tests | 14/14 passed |
| Authorization audit tests | 6/6 passed |
| TypeScript | `tsc --noEmit` passed |
| Workers integration tests | 23 files, 251/251 passed |
| Dependency audit | 0 known vulnerabilities after using fixed `qs 6.15.3` |
| Worker dry run | 907.72 KiB raw / 162.85 KiB gzip |
| Dry-run bindings | `ENTRY_STORE` Durable Object and `ASSETS` only |
| Deployment variables | successful command used `--keep-vars`; no credential was supplied to tests or smoke requests |

The locked upstream contains 111 JavaScript test files; a static declaration
audit finds 883 active `it(...)` cases plus one skipped case. The 251 Workers
tests cover the implemented adapter subset; no whole upstream test file is
claimed green. Neither count proves complete compatibility.

## Post-deployment remote API evidence

Wrangler reports version `9e4ce398-8035-4d57-be1d-ab85373d3782` as the Current
Version. These credential-free checks verified response content and protocol
markers, not only Wrangler command success.

| Check | Result |
| --- | --- |
| `/healthz` | HTTP 200 |
| `/api/v3/version` | HTTP 200; locked Nightscout version `15.0.7` |
| `/api/v3/food` without JWT | HTTP 401 with the locked missing/bad-token envelope |
| `/api/v3/settings` without JWT | HTTP 401 with the locked missing/bad-token envelope |
| `/api/v1/food/regular.json` | HTTP 200 `[]`; v1 Food read remains public under default permissions |

No credentialed write was attempted. The full local suite keeps all eight
generic routes for Food and Settings, their renderer/dedupe/permission behavior
and the prior Entries/JWT contracts green. The new protected `/storage` event
evidence is kept in the real-time section below rather than inferred from these
public API responses.

## Post-deployment real-time evidence

This release changes the real-time server. Credential-free remote checks used
fresh tenant-local EIO4 polling sessions and verified the named public protocol
boundary without reading or sending the deployed credential.

| Check | Result |
| --- | --- |
| EIO4 polling open | `upgrades: []`, 25 s ping interval, 20 s timeout, 1,000,000-byte maximum |
| `/storage` CONNECT | independent SIO5 namespace connection returned a namespace SID |
| `/storage` missing subscription token | ACK exactly `{success:false,message:"Missing or bad accessToken"}` |
| `/alarm` CONNECT | independent SIO5 namespace connection returned a namespace SID |
| `/alarm` anonymous web subscribe | ACK exactly `{success:true,message:"Subscribed for alarms",read:true,ack:false}` |
| `/alarm` invalid truthy access token | ACK exactly `{success:false,message:"Missing or bad accessToken"}` |

Local tests additionally prove collection filtering/default order, the
Settings-admin exception, persisted subscriptions across eviction, API3
create/deduplicated update/PUT/PATCH/soft/permanent delete events, v1 exclusion,
tenant/room isolation, hibernated-WebSocket delivery, broken-subscriber
containment and v8-to-v9 schema repair. No credentialed remote mutation was
attempted. Separate `/alarm` contracts prove native/web authorization priority,
all five event classifications, broadcast to current unsubscribed connections,
tenant isolation, no disconnected replay, exact ACK/all-clear behavior,
Urgent-to-Warning snooze, eviction/Hibernation persistence, broken-recipient
containment and idempotent v10 schema repair. The remote pass did not use a
credential, publish a trusted notification or perform an alarm ACK. Neither
layer proves polling upgrade, EIO3, root write handlers or the server-side
plugin/notification generation pipeline.

## Real-browser evidence

A real browser session exercised the deployed official UI without reading
credential storage or submitting protected mutations:

- the homepage rendered the official empty chart state without warning/error
  logs; the public tenant has
  no Entries, so the displayed `---` is expected;
- the official Food Editor reached `Database loaded`, populated its empty
  database controls and showed the expected anonymous
  read-only authentication state. The current pass recorded no console warning
  or error.

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
- Polling-to-WebSocket upgrade, EIO3 HTTP, root writes and the main namespace's
  database-update broadcasts remain missing. `/storage` and `/alarm` currently
  support EIO4/SIO5 polling and direct WebSocket only. Direct WebSocket retains
  a named at-most-once crash window between durable dequeue and `send()`.
  `/alarm` is only a live transport/auth/ACK outlet: server-side plugins and
  notification calculations do not yet feed it, and credentialed remote event
  delivery has not been exercised.
- `document_changes` is still an unbounded full-body journal. No transport
  consumes it; `/storage` instead atomically queues bounded frames only for
  currently subscribed live sessions. Journal retention and pruning are still
  pending, and a disconnected client receives no replay (matching upstream's
  live-notification model).
- Failed-auth admin notification emission is missing; enforced delay has a
  named 60-second platform cap. Repeated/bracket secret arrays are deliberately
  handled safely instead of reproducing the locked upstream unhandled
  rejection.
- Server plugin jobs, notification generation/processing, summary persistence
  and the general alarm-driven background scheduler remain incomplete. Alarm
  ACK/silence state itself is persisted in schema v10 and must be consumed by
  that future notification engine.
- Official pages are present, but not every mutation, report, plugin and
  real-time workflow has an upstream-derived browser contract.
- No medical algorithm or dosing advice was added.

See `UPSTREAM_COMPATIBILITY.md` for the evidence matrix and
`EXECUTION_PLAN.md` for the delivery order.

## Rollback

The immediate prior Cloudflare version is
`00ecdd3a-240c-4fc1-a984-ad6449bb0b84` (deployed code commit
`121db7ca5a0b45784713a5ac909a5bcbb3c1f499`). It contains the persisted
`/storage` namespace but not the `/alarm` namespace introduced by this release.

Wrangler version rollback can restore Worker code and assets. Neither rollback
nor redeployment clears or rolls back SQLite Durable Object data, and rollback
must not attempt a destructive schema downgrade. Deleting the whole lab
requires deleting the Worker and then its Durable Object namespace. No
D1/R2/KV/Queue/custom-domain cleanup is needed.
