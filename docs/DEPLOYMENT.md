# Current deployment record

Last synchronized: 2026-07-20 (Asia/Shanghai)

## Status

The public Worker is deployed and healthy, but it is **not a complete
Nightscout port**. It serves the locked official v15.0.7 browser assets and the
named compatibility subset in `UPSTREAM_COMPATIBILITY.md`. Page availability
is not counted as API, plugin or real-time compatibility.

- Public URL: <https://nscf-phase1.nscf-lab-20260717.workers.dev/>
- Account ID: `fad59c859cb78943d97441581dfcab78`
- Worker: `nscf-phase1`
- Deployed code candidate: `94c3816ef58931362f2f576b181891f7188ae430`
- Git HEAD used by Wrangler: `94c3816ef58931362f2f576b181891f7188ae430`
- Cloudflare Version ID: `59bac3ab-c448-4c9b-a360-db2179e62f74`
- Version tag/message: `git-94c3816ef589` /
  `git 94c3816ef589 exact v1 v2 treatment prebolus`
- Version creation time: not printed by this Wrangler deployment; none is
  inferred
- Activation: direct `wrangler deploy` reported this as the Current Version;
  no separate activation timestamp was printed
- Worker startup: 26 ms
- Deployment ID: not printed by this Wrangler deployment; none is inferred
- Durable Object: class `EntryStore`, SQLite backend, Wrangler migration tag
  `v1`; internal schema includes the v6 Entries compatibility probe and the v9
  persisted API3 storage-namespace tables plus the v10 alarm connection and
  silence tables
- Static Assets: 248 official v15.0.7 entries; no asset bytes required an
  update in this deployment
- Upload: 912.74 KiB raw / 163.95 KiB gzip
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

- the locked v1 Treatments POST `preBolus` fan-out, inherited by v2: every
  truthy normalized value creates the time-shifted child, truthy carbs move off
  the primary, and a missing/zero carbs value retains upstream's empty-string
  child field. Response ordering and retransmission identity match upstream,
  and both records commit in one SQLite transaction. PUT retains the upstream
  one-record save behavior;
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
- the official v1 GET `/notifications/ack` route on both v1 and inherited v2
  mounts. It requires `notifications:*:ack`, returns the exact Express `OK`
  body, and commits through the same durable ACK/all-clear transaction as the
  Socket.IO namespace. The release also repairs a stale-past DO alarm race so
  queued delivery cannot erase the only remaining SQL wakeup;
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
`94c3816ef58931362f2f576b181891f7188ae430`. It adds the locked v1/v2
Treatments POST `preBolus` fan-out while retaining notification ACK, the
stale-past DO alarm scheduling repair, persisted API v3 `/alarm`, prior
`/storage`, six-collection API3, Entries, Profile, transport and official-page
work.
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
| Workers integration tests | 24 files, 258/258 passed |
| Dependency audit | 0 known vulnerabilities after using fixed `qs 6.15.3` |
| Worker dry run | 912.74 KiB raw / 163.95 KiB gzip |
| Dry-run bindings | `ENTRY_STORE` Durable Object and `ASSETS` only |
| Deployment variables | successful command used `--keep-vars`; no credential was supplied to tests or smoke requests |

The locked upstream contains 111 JavaScript test files; a static declaration
audit finds 883 active `it(...)` cases plus one skipped case. The 258 Workers
tests cover the implemented adapter subset; `notifications-api.test.js` is the
first file classified as fully `adapted`, 108 remain unresolved and two bridge
files are fixed-scope exclusions. The new named Treatments contracts do not
make the whole `api.treatments.test.js` adapted. Neither count proves complete
compatibility.

## Post-deployment remote API evidence

Wrangler reports version `59bac3ab-c448-4c9b-a360-db2179e62f74` as the Current
Version. These credential-free checks verified response content and protocol
markers, not only Wrangler command success.

| Check | Result |
| --- | --- |
| `/healthz` | HTTP 200 |
| `/api/v1/status.json` | HTTP 200; locked Nightscout version `15.0.7` and `runtimeState:loaded` |
| anonymous `/api/v1/treatments.json?count=1` | HTTP 200 and `[]` |
| anonymous `/api/v2/treatments.json?count=1` | HTTP 200 and `[]` |
| anonymous v1 Treatments POST | HTTP 401 with the locked `Invalid/Missing` envelope |
| anonymous v2 Treatments POST | HTTP 401 with the same inherited envelope |
| follow-up Treatments read | still `[]`; rejected writes did not persist |

No deployed credential was read or sent and no credentialed write was
attempted. The full local suite covers exact primary/child fields and ordering,
v2 inheritance, stable replay IDs, ddata visibility, ordered batches and
rollback when the shifted child cannot be represented.

## Post-deployment real-time evidence

This release does not change the real-time server. Its inherited local
contracts all remained green. The immediately preceding public release used
fresh tenant-local EIO4 polling sessions for the following credential-free
protocol checks; they were not repeated as current-version remote evidence.

| Check | Result |
| --- | --- |
| EIO4 polling open | HTTP 200 and a parseable Engine.IO 4 SID |
| `/alarm` CONNECT | independent SIO5 namespace connection returned a namespace SID |
| `/alarm` anonymous web subscribe | ACK exactly `{success:true,message:"Subscribed for alarms",read:true,ack:false}` |

Local tests additionally prove collection filtering/default order, the
Settings-admin exception, persisted subscriptions across eviction, API3
create/deduplicated update/PUT/PATCH/soft/permanent delete events, v1 exclusion,
tenant/room isolation, hibernated-WebSocket delivery, broken-subscriber
containment and v8-to-v9 schema repair. No credentialed remote mutation was
attempted. Separate `/alarm` contracts prove native/web authorization priority,
all five event classifications, broadcast to current unsubscribed connections,
tenant isolation, no disconnected replay, exact ACK/all-clear behavior,
Urgent-to-Warning snooze, eviction/Hibernation persistence, broken-recipient
containment and idempotent v10 schema repair. HTTP v1/v2 and Socket ACK now
share that tested durable transaction. The remote pass did not use a credential,
publish a trusted notification or perform an alarm ACK. Neither layer proves
polling upgrade, EIO3, root write handlers or the server-side plugin/notification
generation pipeline.

## Real-browser evidence

A real browser session exercised the deployed official UI without reading
credential storage or submitting protected mutations:

- the homepage rendered, its `Connecting to server` indicator cleared, and the
  official empty chart state remained without console errors; the public
  tenant has no Entries, so `---` is expected;
- Admin Tools, Food Editor, Profile Editor and `clock-color` loaded from the
  official bundle; Food and Profile left their initial `Not loaded` state;
- the browser was restored to the homepage and retained there for the user.

This browser run used the immediately preceding deployment in the same
increment. The final `94c3816` correction changed only the Treatments POST
empty-carb repository edge, and Wrangler reported no changed asset upload for
the same 248 official browser assets. Final-version remote API smoke was
repeated after that correction; a second browser reload was not recorded as
separate evidence.

Authenticated Profile Save remains historical evidence from an earlier
version; the current load is recorded above, but no authenticated Food/Profile
write was attempted in this release.

This does not prove longer-running stability, Profile Save, Food/Admin
mutation, report generation or every other protected page workflow.

## Known limitations

- External Nightscout/MongoDB history import is not provided; users who require
  it in the new instance must not migrate to this release.
- This remains a simulated-data lab. It must not be connected to a real CGM
  uploader, pump or closed-loop client.
- API v1 and v2 remain subsets. Their inherited notification ACK is adapted,
  but summary, v2 notification-loop and other routes remain incomplete. API v3
  now routes all six official generic collections, but broad large-response
  resource handling, Mongo mixed-type/nested semantics and whole upstream API
  v3 test execution remain incomplete.
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
  `/alarm` is only a live transport/auth/ACK outlet: inherited v1/v2 HTTP ACK
  now shares its durable state, but server-side plugins and notification
  calculations do not yet feed it, and credentialed remote event delivery has
  not been exercised.
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
  that future notification engine. The existing realtime/auth alarm scheduler
  now repairs stale-past wakeups, but it is not yet the multi-kind plugin task
  scheduler.
- Official pages are present, but not every mutation, report, plugin and
  real-time workflow has an upstream-derived browser contract.
- No medical algorithm or dosing advice was added.

See `UPSTREAM_COMPATIBILITY.md` for the evidence matrix and
`EXECUTION_PLAN.md` for the delivery order.

## Rollback

The immediate prior Cloudflare version is
`979afaaf-af26-4e9a-82a7-9c2018d29c6c` (deployed code commit
`d2033c31b94a8a3e1d23eef25899030b433d1397`). It contains the primary
Treatments `preBolus` fan-out, inherited v1/v2 HTTP ACK route and stale-past DO
alarm repair, but not the exact empty-child-carbs edge added by the current
version.

Wrangler version rollback can restore Worker code and assets. Neither rollback
nor redeployment clears or rolls back SQLite Durable Object data, and rollback
must not attempt a destructive schema downgrade. Deleting the whole lab
requires deleting the Worker and then its Durable Object namespace. No
D1/R2/KV/Queue/custom-domain cleanup is needed.
