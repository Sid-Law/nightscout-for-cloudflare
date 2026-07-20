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
- Deployed evidence candidate: `f78631cac0071f4f7fb4f4eb839c161e2f8aa73d`
- Runtime source candidate: `f78631cac0071f4f7fb4f4eb839c161e2f8aa73d`
- Git HEAD used by Wrangler: `cd702a79ecd3d124ca97f916bfb2685eb87283ae`
- Cloudflare Version ID: `719c2b34-95a9-49d4-b22e-147092eee4fc`
- Cloudflare ordinal version number: `52`
- Version tag/message: none printed or present in the deployment-list metadata
- Version creation time: `2026-07-20T01:56:51.124251Z`
- Activation: deployment `00d45bd3-52e3-4e20-840e-133d57884660` created
  `2026-07-20T01:56:52.173529Z`; Wrangler reports
  this version at 100%
- Worker startup: 24 ms
- Deployment ID: `00d45bd3-52e3-4e20-840e-133d57884660`
- Durable Object: class `EntryStore`, SQLite backend, Wrangler migration tag
  `v1`; internal schema includes the v6 Entries compatibility probe and the v9
  persisted API3 storage-namespace tables plus the v10 alarm connection and
  silence tables, the v11 root-delta baseline and the v12 persisted root-write
  authority columns
- Static Assets: 248 official v15.0.7 entries; no asset bytes required an
  update in this deployment
- Upload: 1010.05 KiB raw / 184.58 KiB gzip
- Provisioned product bindings: `ENTRY_STORE` Durable Object plus `ASSETS`
  only

No credential was read or supplied to a local or remote smoke request. Current
Secret inventory is empty and no local deployment credential is available, so
the public lab's API-secret write paths fail closed with 503. Before writable
acceptance testing, an operator must explicitly configure `API_SECRET` as an
encrypted Worker Secret. The port must not generate or silently replace a
family credential. Post-deployment documentation changes are not part of the
already active Worker version.

## Cloudflare footprint

The project uses exactly:

1. one Worker;
2. one Workers Static Assets deployment;
3. one SQLite Durable Object namespace.

It does not create or use D1, R2, KV, Queues, a custom domain or a zone route.
The public instance is for simulated data only and must not receive real health
data, CGM credentials, pump credentials or closed-loop traffic.

## Release content

The current deployed increment adds the complete locked Loop plugin contract:

- all five named `loop.test.js` cases pass in the Workers runtime as well as in
  the locked original suite;
- enabled Loop DeviceStatus feeds `/api/v2/properties` with the official
  enacted/error/`received=false` display, six-point forecast and stale-status
  level, plus the locked notification-request and virtual-assistant outputs;
- the adapter only interprets uploader-provided Loop data. It adds no dosing
  calculation or medical recommendation, and the persisted background
  notification runner remains incomplete.

The immediately preceding evidence increment added the complete
concurrent-uploader contract without changing its then-current Worker runtime:

- all 13 locked `concurrent-writes.test.js` cases cross the Worker HTTP boundary
  into one tenant Durable Object;
- simultaneous scalar and batch writes preserve response cardinality and
  unique server-generated ObjectIds across Entries, Treatments and
  DeviceStatus;
- bounded offline-recovery cases preserve 50 AAPS SMB records, 100 AndroidAPS
  SGVs and 30 mixed-collection records without lost writes.

The deployed runtime also includes the preceding Profile calculation
increment:

- all 24 locked `profile.test.js` assertions cover legacy/store conversion,
  schedules, units, timezone handling, profile switches and historical
  selection;
- API v2 Summary selects and evaluates the current Profile through that
  Workers-safe adapter rather than a partial hand-written substitute.

Earlier Treatment identity work remains deployed:

- complete named Workers-runtime mapping for locked
  `uuid-handling.test.js`, `issue-6923-legacy-uuid.test.js` and
  `identity-matrix.test.js`, adding 30 passing contracts;
- exact true-by-default `UUID_HANDLING` parsing and enabled/disabled
  promotion, GET, PUT, dedupe and DELETE behavior. Modern identifier rows and
  pre-fix raw UUID `_id` rows are both handled when enabled; issue-6923 PUT
  updates in place without duplication;
- the locked MongoDB 5.9 Treatment delete response
  `{acknowledged:true,deletedCount:N}`. A versioned UUID-aware DO RPC permits
  default-true rolling fallback only for Cloudflare's exact missing-method
  error; explicit false fails closed rather than silently applying true.

The immediately preceding legacy-uploader increment remains deployed and
includes the complete `api.deduplication`, Entries UUID and partial-failure
files, collection-specific selectors, and DeviceStatus prediction trimming.

The immediately preceding main-namespace increment remains deployed and
includes the complete named `websocket.shape-handling.test.js` mapping,
schema-v12 persisted write/treatment-write authority, `dbAdd`, `dbUpdate`,
`dbUpdateUnset` and `dbRemove` for all six locked collection names, and exact
ACK-before-`dataUpdate` behavior through polling and direct Hibernatable
WebSocket.

The immediately preceding root-delta increment remains deployed and includes
the complete named `data.calcdelta.test.js` mapping, schema-v11
`realtime_root_state`, and bounded server-originated `dataUpdate` queueing for
implemented v1/v2 and HTTP API3 mutations. API3 root and `/storage` frames
share the mutation transaction; legacy root publication is a follow-up DO
transaction, including the committed prefix after an ordered Entries failure.
Profile-switch status injection and plugin processing before comparison remain
unimplemented.

The immediately preceding v2 property/plugin increment remains deployed and
includes:

- complete named Workers-runtime mappings for locked `times.test.js`,
  `units.test.js`, `levels.test.js`, `rawbg.test.js` and `upbat.test.js`;
- official raw-calibration/noise/assistant behavior and recent per-device
  uploader-battery minima, severity, pill hiding/classes and assistant intents;
- an enabled-plugin dispatcher in official server order: `upbat` is live by
  default and `rawbg` remains opt-in through `ENABLE`;
- a bounded DO property projection of at most 64 SGVs, the latest calibration
  and recent device status, avoiding unrelated food/treatment/profile reads;
- rolling-deployment compatibility: only Cloudflare's exact missing-new-RPC
  error falls back to the existing snapshot RPC while an old DO isolate drains.

The immediately preceding v2 increment remains deployed and includes:

- the complete named Workers-runtime mapping for locked `ddata.test.js`:
  official empty buckets/deep clone, runtime mills/duration/endmills
  normalization and prefer-new `_id`/`identifier` merging;
- `/api/v2/properties` wildcard/comma selection and truthy `pretty` formatting;
- official `bgnow`, `delta`, `buckets` and `direction` calculations from the
  immediately preceding release remain deployed;
- `/api/v2/summary/` with locked hour filtering, SGV/noise, carb/insulin,
  temporary-target, temp-basal schedule and current-profile mapping. It does
  not fabricate server-plugin values: IOB/COB/BWP are `null`, and the
  summary age/battery properties are absent until those official plugins feed
  the summary mapper;

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

The deployed evidence candidate is
`f78631cac0071f4f7fb4f4eb839c161e2f8aa73d`. It adds the complete five-case
Loop plugin mapping and opt-in v2 property dispatch while retaining the
complete 13-case concurrent uploader and 24-assertion Profile calculation
mappings, as well as
GAP-TREAT-012, Loop carb/dose, ObjectIdCache, SGV/DeviceStatus,
UUID-handling, issue-6923, identity-matrix, legacy uploader/DeviceStatus work,
schema-v12 root-write
authority and all prior property, v1, API3, authorization, realtime,
notification ACK and official-page work.
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
| Workers integration tests | 43 files, 490/490 passed |
| Worker dry run | 1010.05 KiB raw / 184.58 KiB gzip |
| Dry-run bindings | `ENTRY_STORE` Durable Object and `ASSETS` only |
| Deployment variables | Secret inventory empty; no credential was read, supplied, generated or replaced |

The locked upstream contains 111 JavaScript test files; a static declaration
audit finds 883 active `it(...)` cases plus one skipped case. The 490 Workers
tests cover the implemented adapter subset; all 16 API3 files,
`notifications-api.test.js`, `ddata.test.js`, `bgnow.test.js`,
`direction.test.js`, `levels.test.js`, `rawbg.test.js`, `times.test.js`,
`units.test.js`, `upbat.test.js`, `data.calcdelta.test.js`,
`websocket.shape-handling.test.js`, `profile.test.js`,
`concurrent-writes.test.js`, `loop.test.js` and 25 v1 client/API files are
classified as fully `adapted`, 54 remain unresolved and two bridge files are
fixed-scope exclusions.
Neither count proves complete compatibility.

## Post-deployment remote API evidence

Wrangler reports version `719c2b34-95a9-49d4-b22e-147092eee4fc` at 100%.
These credential-free checks verified response content and protocol markers,
not only Wrangler command success.

| Check | Result |
| --- | --- |
| GET `/api/v3/version` | HTTP 200 with Nightscout `15.0.7`, API3 `3.0.3-alpha` and SQLite Durable Object marker |
| GET `/api/v3/entries?limit=1` without JWT | Expected HTTP 401 `Missing or bad access token or JWT` |
| GET `/healthz` and `/api/v1/entries.json?count=1` | HTTP 200; healthy SQLite DO marker and empty simulated-data Entries array |
| GET `/api/v1/treatments.json?count=1` | HTTP 200 with an empty fresh-tenant simulated-data Treatment array |
| GET `/api/v1/profile/current` | HTTP 200 with `null` for the fresh tenant |
| GET `/api/v2/summary/?hours=6` | HTTP 200 with empty SGV/treatment arrays, `{}` Profile and the locked null plugin-state fields |
| GET `/api/v2/properties/loop` | HTTP 200 with `{}` because Loop is opt-in and the deployed `ENABLE` setting does not enable it; no synthetic property was fabricated |
| POST simulated Treatment without a configured secret | Expected HTTP 503 `api_secret_not_configured`; follow-up GET remained empty |

No deployed credential was read or sent. The failed write was deliberately
credential-free and could not mutate storage. Every checked API response
carried the complete CORS policy. The
full local suite covers authenticated search, ordering, skip, projections,
limits, srvModified filters and error shapes in addition to inherited mutation
and transport contracts. Credentialed remote mutation requires an operator to
configure the missing encrypted `API_SECRET` first.

An earlier property-plugin increment first attempted version
`e24bfdec-233c-4dab-a462-142337b14118` (deployment
`917e2c7e-c0c6-4d79-9cc4-ac24569f00bf`). Remote smoke caught HTTP 500 on
`/api/v2/properties`; a temporary Worker tail showed that a still-live old DO
did not implement the newly added RPC. No storage corruption occurred. The
current version adds a narrowly matched rolling-upgrade fallback, and the same
old DO returned HTTP 200 immediately after redeploy. This failed intermediate
version is retained only as incident evidence and is not a rollback target.

## Post-deployment real-time evidence

This release adds the complete Loop property calculation contract and retains
the concurrent uploader, Profile, Loop client and client/server root transport
runtime. The current version repeated a fresh
credential-free EIO4 polling-open check. Because the Worker has no
`API_SECRET`, no credentialed remote mutation could be attempted; successful
write/change delivery is proved by local integration contracts rather than
claimed from the public tenant. The read-only root and `/alarm` checks below
remain evidence from the immediately preceding compatible version.

| Check | Result |
| --- | --- |
| Current EIO4 polling open | HTTP 200 and a parseable Engine.IO 4 SID |
| Local Loop property contract | five locked enacted/error/received/stale-alert/assistant cases, including six forecast points and opt-in property dispatch |
| Prior-version anonymous-readable root authorize | exact `{read:true,write:false,write_treatment:false}` authority |
| Prior-version read-only Food `dbAdd` | exact `{result:"Not permitted"}` ACK; follow-up Food read returned no row |
| Local Treatment identity contract | 30 locked UUID flag, legacy issue-6923 and client identity cases, including MongoDB 5 delete results |
| Local Loop client upload contract | 47 locked GAP-TREAT-012, carb/dose, ObjectIdCache and SGV/DeviceStatus cases, including ordered server-ID mapping and client-cache-miss duplicate behavior |
| Local root write contract | six collections and all four events preserve locked validation/permission/ACK order, dedupe and ACK-before-delta behavior |
| Local v1 SGV root update | an authorized live polling session receives the locked root `dataUpdate`; an unauthorized session remains silent |
| Local API3 Treatment root update | root and `/storage` delivery share the successful API3 mutation path |
| Local reconstruction | schema-v11 baseline and schema-v12 write/treatment-write authority survive service reconstruction; a Treatment change remains `action:update` |
| Prior `/alarm` CONNECT | independent SIO5 namespace connection returned a namespace SID |
| Prior `/alarm` anonymous web subscribe | ACK exactly `{success:true,message:"Subscribed for alarms",read:true,ack:false}` |

Local tests additionally prove the exact locked `data.calcdelta` and
`websocket.shape-handling` cases,
non-empty-only root queueing, connection/read/live filtering, collection filtering/default order, the
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
polling upgrade, EIO3, profile-switch/plugin preprocessing or the server-side plugin/notification
generation pipeline.

## Real-browser evidence

A real Chromium session exercised Cloudflare version 52's official UI without reading
credential storage or submitting protected mutations:

- the homepage rendered its official chart region and loaded locked
  `bundle.app.js`; the
  public tenant has no Entries, so `---` is expected;
- Admin Tools, Food Editor, Profile Editor and `clock-color` loaded from the
  official bundle with their expected headings/forms. Food reached `Database
  loaded` and Profile reached `Values loaded.` in the unauthorized read-only
  state. The stored simulated profile and `Asia/Shanghai` timezone were present,
  and the empty-data clock rendered `-?-`; no protected Save was attempted;
- the agent-created verification tab was closed without disturbing the user's
  existing tabs, and the isolated browser process was closed;
- console inspection found zero JavaScript errors. The homepage and clock had
  no warnings. Admin, Food and Profile repeatedly emitted the locked
  `bundle.app.js` warning `Unable to find element for #chartContainer` because
  those official non-chart pages have no chart container. This nonfatal warning
  is now tracked explicitly and is not misreported as a zero-warning pass.

This pass asserted rendered DOM, status text, official-script presence and a
fresh console trace for Cloudflare version
`719c2b34-95a9-49d4-b22e-147092eee4fc`. It reused the same 248 unchanged
official assets. Version 52 has therefore passed credential-free remote API,
Engine.IO and real-browser acceptance.

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
- API v1 and v2 remain subsets. Their inherited notification ACK, ddata helper,
  `bgnow`/`direction`/`rawbg`/`upbat` properties and core summary mapper are
  adapted, but the remaining plugin-derived properties and summary
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
- Polling-to-WebSocket upgrade and EIO3 HTTP remain missing. The main namespace
  now emits server-originated deltas from a schema-v11 persisted baseline and
  implements the locked client root write shape contract with schema-v12
  authority, but profile-switch status injection, server-plugin preprocessing
  and a pushed official-page workflow remain incomplete. Broader Mongo/BSON
  numeric, object-ID and mixed-type behavior is not implied by the named write
  contract. `/storage` and `/alarm` currently
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
- Server plugin jobs, notification generation/processing, remaining
  plugin-derived properties, general sandbox/registry and summary state/persistence
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

The immediately preceding known-good rollback Worker version is
`f4909749-a807-4f10-9794-5eaa471da4d9` (version 51). It has its own remote API,
Engine.IO and browser acceptance and lacks only this release's Loop property
adapter. Version 50 (`4f89e2fc-ac35-499b-ac39-ffbd61f18e66`) remains an older
compatible fallback.
The older
failed property rollout
`e24bfdec-233c-4dab-a462-142337b14118` remains an incident record and must not
be selected as a rollback target.

Wrangler version rollback can restore Worker code and assets. Neither rollback
nor redeployment clears or rolls back SQLite Durable Object data, and rollback
must not attempt a destructive schema downgrade. Deleting the whole lab
requires deleting the Worker and then its Durable Object namespace. No
D1/R2/KV/Queue/custom-domain cleanup is needed.
