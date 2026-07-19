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
- Deployed code candidate: `79ddf4985bd93510a07444e40bf61972120aa9b6`
- Git HEAD used by Wrangler: `79ddf4985bd93510a07444e40bf61972120aa9b6`
- Cloudflare Version ID: `be2ed773-9148-43df-bbfb-d438bb24fe6f`
- Cloudflare ordinal version number: not printed by Wrangler; the Version ID is
  authoritative
- Version tag/message: none printed or present in the deployment-list metadata
- Version creation time: not separately printed; none is inferred
- Activation: deployment `6d9e7df3-439c-44a4-a206-123a2ded391c` created
  `2026-07-19T20:16:32.660015Z`; Wrangler reports
  this version at 100%
- Worker startup: 31 ms
- Deployment ID: `6d9e7df3-439c-44a4-a206-123a2ded391c`
- Durable Object: class `EntryStore`, SQLite backend, Wrangler migration tag
  `v1`; internal schema includes the v6 Entries compatibility probe and the v9
  persisted API3 storage-namespace tables plus the v10 alarm connection and
  silence tables
- Static Assets: 248 official v15.0.7 entries; no asset bytes required an
  update in this deployment
- Upload: 942.98 KiB raw / 170.71 KiB gzip
- Provisioned product bindings: `ENTRY_STORE` Durable Object plus `ASSETS`
  only; the preserved `API_SECRET` application credential is not another
  storage/product binding

The ordinary Wrangler deployment preserved the existing configuration; no
credential was read or supplied to a local or remote smoke request. A prior
metadata inspection demonstrated why
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

The current deployed build contains the prior adapted slices plus this
increment's following v2 additions:

- the complete named Workers-runtime mapping for locked `ddata.test.js`:
  official empty buckets/deep clone, runtime mills/duration/endmills
  normalization and prefer-new `_id`/`identifier` merging;
- `/api/v2/properties`, wildcard/comma selection and truthy `pretty`
  formatting for the currently available `bgnow`/`delta` properties;
- `/api/v2/summary/` with locked hour filtering, SGV/noise, carb/insulin,
  temporary-target, temp-basal schedule and current-profile mapping. It does
  not fabricate server-plugin values: IOB/COB/BWP are `null`, and the
  age/battery properties are absent until those official plugins run;

The immediately preceding v1 increment remains deployed and includes:

- complete named Workers-runtime mappings for the locked
  `api.aaps-client.test.js`, `api.alexa.test.js`, `api.entries.test.js`,
  `api.root.test.js`, `api.status.test.js`, `api.treatments.test.js`,
  `api.unauthorized.test.js` and `api.v1-batch-operations.test.js` files;
- bounded numeric-brace `/times/echo`, `/times` and dateString `/slice`
  utilities, with at most eight expanded prefixes, 256 patterns and 10,000
  candidates per prefix; arbitrary regex syntax and other slice fields remain
  controlled differences;
- exact numeric-date, exact `dateString` and open dateString-range Entries
  deletion, still subject to the 128-document synchronous delete/revision cap;
- the complete locked Treatments XSS/time/numeric/query/delete and UUID/AAPS
  identity contracts. Its Worker safe-tag sanitizer strips every attribute,
  matching the locked malicious fixture while remaining stricter than
  DOMPurify for otherwise-safe attributes;
- local Alexa LaunchRequest, unknown-intent and SessionEndedRequest Speechlet
  envelopes without external Amazon calls, plus root version discovery,
  complete v1/v2 Status representations and AndroidAPS/Loop/Trio client shapes;

The cumulative deployed surface also includes:

- complete named Workers-runtime adaptations for four more locked upstream
  files: `api3.generic.workflow.test.js`, `api3.read.test.js`,
  `api3.renderer.test.js` and `api3.security.test.js`. They cover initial
  status/lastModified clocks, missing and complete CRUD/history lifecycle,
  read-only mutations, v1-created reads, projection/conditional reads,
  missing/invalid/denied/allowed JWT branches, and extension-versus-Accept
  JSON/CSV/XML behavior;
- a typed API3 DELETE Durable Object RPC error result. Known read-only
  validation now returns the locked 422 response without an uncaught exception
  escaping the DO boundary; unknown errors remain a generic storage 500;
- complete named Workers-runtime adaptations for the locked
  `api3.basic.test.js` and `api3.search.test.js` contracts: API-wide OPTIONS
  returns the upstream `OK` boundary with
  `GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS`, complete authorization/content/
  conditional-request headers, and CORS; implicit HEAD preserves GET status and
  headers with an empty body for API3 version, status, lastModified and every
  generic route; search/history share a configurable lower `API3_MAX_LIMIT`
  with invalid values falling back to and larger values capped at the
  1,000-row Workers Free boundary;
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
`79ddf4985bd93510a07444e40bf61972120aa9b6`. It adds the complete named
`ddata.test.js` mapping, selected/pretty properties and the core summary mapper
while retaining all prior v1, API3, authorization, realtime, notification ACK
and official-page work.
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
| Workers integration tests | 31 files, 303/303 passed |
| Worker dry run | 942.98 KiB raw / 170.71 KiB gzip |
| Dry-run bindings | `ENTRY_STORE` Durable Object and `ASSETS` only |
| Deployment variables | existing configuration was preserved; no credential was read or supplied to tests or smoke requests |

The locked upstream contains 111 JavaScript test files; a static declaration
audit finds 883 active `it(...)` cases plus one skipped case. The 303 Workers
tests cover the implemented adapter subset; all 16 API3 files,
`notifications-api.test.js`, `ddata.test.js` and 15 v1 client/API files are
classified as fully `adapted`, 76 remain unresolved and two bridge files are
fixed-scope exclusions.
Neither count proves complete compatibility.

## Post-deployment remote API evidence

Wrangler reports version `be2ed773-9148-43df-bbfb-d438bb24fe6f` at 100%.
These credential-free checks verified response content and protocol markers,
not only Wrangler command success.

| Check | Result |
| --- | --- |
| GET `/api/v2/properties/bgnow,delta?pretty=1` | HTTP 200, selected keys only and two-space JSON indentation |
| GET `/api/v2/summary/?hours=6` | HTTP 200 with SGV/treatment/profile/state envelope; current profile preserved and unavailable plugin state explicit as null/absent |
| GET `/api/v2/ddata/at` | HTTP 200 with every aggregate bucket and current profile |
| GET `/api/v3/version` | HTTP 200 with Nightscout `15.0.7`, API3 `3.0.3-alpha` and SQLite Durable Object marker |
| GET `/api/v1/status.json` | HTTP 200; `Nightscout` `15.0.7`, readable defaults and official settings envelope |

No deployed credential was read or sent and no credentialed write was
attempted. Every checked API response carried the complete CORS policy. The
full local suite covers authenticated search, ordering, skip, projections,
limits, srvModified filters and error shapes in addition to inherited mutation
and transport contracts.

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

- the homepage rendered its official chart region without console errors; the
  public tenant has no Entries, so `---` is expected;
- Admin Tools, Food Editor, Profile Editor and `clock-color` loaded from the
  official bundle with their expected headings/forms/scripts. Profile reached
  `Values loaded.` and Food reached `Database loaded` without entering a
  credential;
- the browser was restored to the homepage and retained there for the user.

The browser console recorded zero errors on every checked page; warning-level
logs were not used as a release assertion in this pass. This browser run reloaded Cloudflare version
`be2ed773-9148-43df-bbfb-d438bb24fe6f` after deployment. Wrangler reported no
changed asset upload for the same 248 official browser assets.

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
- API v1 and v2 remain subsets. Their inherited notification ACK, ddata helper
  contract and core summary mapper are adapted, but plugin-derived summary
  state/persistence, v2 notification-loop and other routes remain incomplete. API v3
  routes all six official generic collections and all 16 locked upstream API3
  test files have named Workers-runtime adaptations. Broad large-response
  resource handling and Mongo mixed-type/nested/array semantics remain
  controlled platform differences beyond that locked test-file evidence.
- Entries `times/echo`, `times` and dateString `slice` implement the locked
  numeric-brace fixtures, but intentionally reject arbitrary regex syntax,
  more than eight prefixes, more than 256 expansions, other storage/field
  combinations and candidate sets above 10,000 per prefix. Echo supports
  Entries storage only and count rejects client-supplied aggregation pipelines.
  Treatment safe attributes are stripped, so general DOMPurify byte parity and
  wider Mongo query/mixed-type behavior remain incomplete.
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
- Server plugin jobs, notification generation/processing, plugin-derived summary state/persistence
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
`936fcc1c-b6d8-4572-9a11-a50e1f507bb6` (deployed code commit
`cac4a8671ef8238570ef8a1a25c5ce98b3f4cba2`). It contains the complete prior
v1 client-contract increment but not this release's ddata contract,
property-selection/pretty behavior or v2 summary endpoint.

Wrangler version rollback can restore Worker code and assets. Neither rollback
nor redeployment clears or rolls back SQLite Durable Object data, and rollback
must not attempt a destructive schema downgrade. Deleting the whole lab
requires deleting the Worker and then its Durable Object namespace. No
D1/R2/KV/Queue/custom-domain cleanup is needed.
