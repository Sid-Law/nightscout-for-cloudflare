# Complete Nightscout port execution plan

Last synchronized: 2026-07-22

## Goal and fixed scope

The goal is the cleanest practical port of official Nightscout v15.0.7 to
Cloudflare Workers Free, SQLite Durable Objects and Workers Static Assets.
Official UI, layout, charts, interactions, client/server plugins, translations,
calculations and version identifiers are preserved wherever the runtime allows.
NSCF code belongs at platform boundaries.

Fixed exclusions:

- no D1, R2, KV, Queues or custom domain;
- no real CGM, pump or medical credentials and no real health data;
- no replacement UI or downstream branding in the Nightscout surface;
- no new medical algorithm, dosing logic or treatment recommendation;
- live external bridge/push delivery remains disabled in the simulated-data
  lab; mocked internal mapping, validation, deduplication, cancellation and
  multi-key contracts remain required.

First-release onboarding is limited to fresh NSCF deployments for new-family
use. No external Nightscout/MongoDB history importer is delivered in that
release. Users who require existing history in the new instance must not
switch yet. This product-scope deferral does not weaken the requirement for
safe, forward-compatible upgrades of existing NSCF Durable Object data.

## Evidence standard

A module is complete only when:

1. its upstream v15.0.7 files and tests are mapped;
2. runtime conflicts and platform adaptations are explicitly separated;
3. request, response, storage, authorization, error and real-time contracts are
   represented by Workers-runtime tests;
4. the complete local suite and deployment dry-run pass before deployment;
5. remote API smoke and a real-browser workflow pass after deployment;
6. the compatibility matrix and deployment record match the code.

Opening a page or serving an official asset does not satisfy this standard.

## Workstreams and status

| Workstream | Status | Next acceptance checkpoint |
| --- | --- | --- |
| 0. Upstream lock and clean vendor | Complete | Keep v15.0.7 commit/archive hash immutable until an explicit upstream update. |
| 1. Compatibility inventory | Tooling complete | Keep the generated 161-route/111-test manifest current; update a file from unresolved only with whole-file or complete adapted evidence. |
| 2. Official browser assets/pages | Named daily workflows accepted; broader plugin/realtime closure partial | Versions 72–79 established the unchanged homepage/chart, Settings/About 15.0.7, Admin/clock, AR2, official Socket.IO polling and the opt-in lab feed. Version 80 authenticated Profile rename/save/reload/restore, Food create/read/delete, Admin role create/delete and Report generation (30 SVGs/eight canvases). All temporary records were restored or removed. A protected mutation observed through the pushed live page-update path remains. |
| 3. SQLite collection compatibility | In progress | All six official API3 collections share the generic repository; v1 Food shares its identity/history and older Food rows receive idempotent metadata repair. The complete 13-case concurrent-write contract proves five-way scalar/batch writes, unique IDs and 50-SMB/100-SGV/30-cross-collection recovery. The 26-case upstream storage-shape file is now adapted: scalar/one/many/20-document writes, Profile/Food/Activity save identity and created-at behavior, authorization replacement and explicit SQLite one/many batches are locked. Public invalid-ID checks remain strict while direct legacy saves retain upstream fresh-ObjectId fallback. `/storage` atomically queues bounded frames for current subscribers without consuming the unbounded `document_changes` snapshot journal. Close Mongo mixed-type/nested parity and define journal retention/pruning separately. Entries uses a deliberate fresh-only reset for an incompatible pre-1.0 narrow shadow; it is not a legacy importer. |
| 4. API v1 | In progress; 27 locked files plus shared query contract adapted | Entries adapts its complete locked upstream file plus deduplication, Entries UUID and partial-failure contracts. The locked `query.test.js` defaults, ID date-bypass and ObjectId behavior now use one Worker-safe adapter shared by live Entries parsing. Treatments additionally adapts complete UUID-handling, issue-6923, identity-matrix, GAP-TREAT-012, Loop carb/dose and ObjectIdCache files. The complete Loop SGV/DeviceStatus file locks directions, device metadata, replay behavior and nested Loop/pump payloads; DeviceStatus retains official prediction trimming. Root, Status, AndroidAPS, Alexa, unauthorized and Loop/Trio batch files are mapped. `/pebble` now adapts its full nine-case legacy endpoint contract with bounded request-local context. Status consumes the request-local Settings adapter. Complete non-Entries echo, bounded aggregation-pipeline parity, safe-attribute DOMPurify byte parity, wider Mongo query/document behavior and remaining v1 routes/test files. |
| 5. API v2 | Partial | JWT issuance/refresh, strict v2 Status, inherited v1 notification ACK/Treatments behavior, `/ddata/at`, property selection/pretty formatting and the summary SGV/treatment/target/temp-basal/profile mapper are deployed. Summary uses the complete 24-assertion `profile.test.js` adapter and receives opt-in official IOB/COB state. The complete locked `ddata`, `dataloader`, `dbsize`, `bgnow`, `direction`, `rawbg`, `upbat`, `ar2`, `basalprofileplugin`, `simplealarms`, `treatmentnotify`, `cannulaage`, `sensorage`, `insulinage`, `timeago`, `iob`, `cob`, `openaps`, `pump`, treatment-to-curve and five-case `loop` files are adapted. `/properties` runs the official default-enabled Basal and AR2 properties plus opt-in OpenAPS and Pump calculations through the same registry. Ddata publishes real SQLite bytes and applies official Treatment marker placement. Basal receives the current Profile plus bounded Temp Basal/Profile Switch/Combo Bolus treatments and meter-BG projection; AR2 maps official `ALARM_TYPES`/`AR2_CONE_FACTOR`, and IOB/COB preserve their upstream `ENABLE` gates and bounded Profile/Treatment inputs. The platform reports the one-GB ceiling as 953.67 MiB. One persisted task now evaluates eleven official producers: AR2, Simple Alarms, Pump, OpenAPS, Loop, CAGE, SAGE, IAGE, Treatment Notify, Timeago and opt-in DBSize. BWP and remaining plugin/summary fields, summary persistence, remaining task sources and v2-only `/notifications/loop` delivery remain; ddata uses a bounded two-day SGV window. |
| 6. API v3 | Locked 16-file test set adapted; platform hardening remains | Public `/version`, JWT-protected `/status`, all eight generic routes for each of the six official collections and six-collection `/lastModified` are implemented with locked JSON/CSV/XML rendering. All 16 locked `api3.*` files are completely represented by named Workers-runtime contracts, including create/update/patch/delete, shape handling, AAPS patterns, storage adapter/socket behavior, implicit HEAD and API CORS. Keep the hard 1,000-row Workers Free ceiling and configurable lower search/history limit explicit; finish large-response controls and broader Mongo mixed-type/nested/array differential parity. |
| 7. Authentication/admin | Core plus Admin notices adapted; named hardening retained | Tenant JWT keys, eight-hour HS256 tokens, derived access-token/prefix matching, body/query/header credential order, live subject/role lookup, persisted per-IP delay, Shiro matching and `verifyauth` are implemented. Schema v15 persists the official readable-site and failed-auth Admin notices, message aggregation, public-count/admin-body split, eight/twelve-hour windows and disable gate across DO eviction. The deployed platform configuration preserves dashboard variables across Wrangler deploys and audits that no plaintext credential is committed; encrypted Secrets remain preferred. A user-provided construction credential successfully authorized one 25-entry simulated SGV batch without recording its value. The Workers boundary caps enforced delay at 60 seconds, bounds transient Admin notices at 128 per tenant, and handles repeated/bracket `secret` arrays safely instead of reproducing the locked upstream unhandled rejection. |
| 8. Engine.IO/Socket.IO | Partial EIO4 polling + direct WebSocket; official browser uses polling | Strict EIO4 polling and direct Hibernatable EIO4 WebSocket are routed to tenant `EntryStore` DOs with persisted sessions/queues, heartbeat, SIO5 root CONNECT/read/write/treatment-write authorization, initial/retro data, server-originated deltas and the locked `dbAdd`/`dbUpdate`/`dbUpdateUnset`/`dbRemove` events, plus API3 `/storage` and `/alarm`. The byte-identical official Socket.IO 4.5.4 browser client now uses root polling and `/alarm`; the only browser adapter adds an optional test-tenant query. Add remaining plugin evaluation, profile-switch preprocessing, close the direct-send at-most-once crash window, then add polling upgrade/EIO3. |
| 9. Real-time storage updates | Root server/client mutations plus API3 `/storage` implemented | Successful HTTP API3 mutations atomically enqueue official collection-room frames and root deltas; implemented v1/v2 changes publish root deltas in a follow-up DO transaction. Schema-v11 baseline and schema-v12 write authority survive reconstruction. Authorized client root writes preserve exact ACK/error ordering and queue any delta after the ACK; unauthorized/read-only sessions stay unable to mutate. The official client now receives its initial root update remotely; add a credentialed pushed mutation observed in the page and profile/plugin preprocessing. Keep the unbounded `document_changes` journal and its future retention policy distinct from the bounded live transport queue. |
| 10. Alarms/background tasks | Generic SQLite scheduler + unified automatic notification task | Schema v14 stores logical tasks, due times, attempts and update times in SQLite. The DO's one Cloudflare alarm is derived from the minimum of persisted realtime, authorization-cleanup, task, schema-v16 debounce and optional schema-v17 lab-CGM deadlines. One `plugin-notifications` task evaluates eleven official producers in server order from a bounded SGV/MBG/DeviceStatus/Profile/Treatment/SQLite-stat context. The disabled-by-default lab CGM uses the same alarm, writes one current SGV per five-minute due turn and never backfills an unbounded outage. Mutations run the leading edge; rapid batches receive exactly one persisted trailing evaluation after one quiet second or at the five-second max wait. Failures persist two-second exponential retry capped at five minutes; early at-least-once delivery is a no-op. Add BWP/remaining plugin producers, summary/activity persistence and future maintenance/pruning. |
| 11. Server plugins/notifications | Static registry + eleven automatic producers + persisted core/Admin/push state | Stateless ports of the named official calculation plugins plus shared `times`, `units`, `levels`, Profile calculations and the complete public `lib/sandbox.js` surface now exist. Eleven producers are automatically evaluated by schema v14 under their official gates; schema v15 persists Admin notices and schema v16 persists data-update debounce. Version 81 completely maps the locked Maker, Pushover and Pushnotify files: schema v18 persists dedupe leases, receipts and Maker All Clear state, and v1/v2 expose the official receipt callback. The processor preserves priority, information/announcement handling, snooze arbitration and automatic all-clear. External Pushover/IFTTT send/cancel remains disabled until explicitly authorized and connected through a persisted outbox. BWP and remaining plugin alarm producers remain incomplete. |
| 12. Upstream regression suite | Tracked; 16 pass + 86 adapted files | Work through `docs/UPSTREAM_TEST_MANIFEST.md` in dependency order; all 16 API3 files, Pebble, Maker, Pushover, Pushnotify, the complete storage-shape and bootevent-debounce files and the named plugin/API/realtime foundations are adapted. Eleven complete client files run 42/42 unchanged after bundle byte equality. Twenty-one locked server/data-plugin files run unchanged as a reusable 143/143-test gate. The latest direct file is the eight-case Node/Mongo pool-option parser; it is source evidence, not a Worker Mongo-pool setting. Seven files remain unresolved and two are fixed-scope exclusions. |

## Generated dispatch map

`npm run upstream:audit` builds `upstream/contract-manifest.json` and
`docs/UPSTREAM_TEST_MANIFEST.md` from the locked route registration modules and
all 111 upstream test files. `npm run upstream:audit:check` is deterministic and
fails on duplicate routes, locked registration-source hash or static/dynamic
overlay drift, unknown auth/condition override targets, re-derived syntactic
mount-chain or exact source-anchor drift, count/status drift, unstable order,
or stale generated output. These anchors do not prove runtime reachability,
middleware order, execution, or coverage. Route/test links are heuristic
dispatch candidates; literal request paths are method-filtered when the method
is statically visible, while dynamic/textual/prefix/API3-filename cases still
require manual confirmation. `npm test` runs this check and the generator's own
Node tests before the Workers-runtime suite.

Dispatch upstream compatibility work in the generated numeric workstream order:

1. storage/query/identity foundations;
2. authorization;
3. API v1/v2;
4. plugins and calculations that can proceed on the collection contract;
5. API v3;
6. real-time transport;
7. background behavior and fixed-scope integrations;
8. UI and process-boundary workflows.

The manifest's two `excluded-fixed-scope` files cover only real-CGM bridges.
Tests that mock external notification delivery still specify required internal
mapping, validation, deduplication, cancellation and multi-key behavior.
Mongo-to-SQLite, Express-to-Worker, process-lifecycle, Socket.IO,
notification-state and browser adaptations remain required work and must not be
relabeled as scope exclusions.

## Current deployed increment

The deployed runtime candidate `ae88ba1` retains schema-v15 persisted Admin
notifications, the complete storage-shape adapter and schema-v16 durable
bootevent debounce while retaining the locked v1/v2 `experiments/test` permission
probe, named API security/verifyauth/API_SECRET mappings, Query/Language
adapters and one schema-v14
`plugin-notifications` task to the locked AR2, Simple Alarms, Pump, OpenAPS,
Loop, CAGE, SAGE, IAGE, Treatment Notify, Timeago, DBSize and notification-
processor modules. Mutations evaluate all eleven in official server order from
one bounded context. Notification state,
Treatment snooze arbitration, live `/alarm` delivery and task completion/
reschedule commit in one SQLite transaction. AR2 preserves its official
coefficients, six-point loss calculation, 13-step cone, threshold decisions,
messages, sounds, debug payload and `ALARM_TYPES`/`AR2_CONE_FACTOR` settings.
Simple Alarms preserves strict
warning/urgent thresholds and exact ten-minute expiry. Treatment Notify
preserves strict ten-minute/manual-event filtering, auto-snooze and its
synchronous upstream SHA-1 hash. Timeago preserves strict `>` warning/urgent
transitions by scheduling threshold plus one millisecond. Pump, OpenAPS and
Loop preserve strict warn/urgent threshold-plus-one-millisecond transitions,
source expiration and future DeviceStatus activation. OpenAPS Offline starts at
its future marker, suppresses Pump/OpenAPS deadlines while active and clears one
millisecond after its inclusive expiry. Pump quiet-night low-battery behavior
wakes at its next exact Profile-timezone boundary without minute polling.
Active notices repeat only at the official heartbeat. Pump, OpenAPS, Loop,
Treatment Notify and Timeago obey their official enable/alert gates, so all five
branches remain dormant under the public default settings. Failures use
persisted two-second exponential retry capped at five minutes. This is not a
public endpoint or external provider. Basal preserves
the scheduled-profile rate, active Temp Basal and Combo Bolus contributions,
the official property/pill, visualization and assistant response. It is
default-enabled by the locked feature set and consumes the current Profile,
bounded profile-related Treatments and meter-BG context without adding a dose
recommendation. Treatment Notify preserves its ten-minute selection window,
manual/automatic filtering, auto-snooze object, calibration/treatment/target/
announcement request shapes and SHA-1 hash. When officially enabled, those
requests and snoozes are now evaluated automatically; external delivery remains
unfinished.

Schema v17 adds a separate, NSCF-only lab-CGM state row. It is disabled by
default and changed only through the protected `/_nscf/simulated-cgm` platform
boundary. Enabling one tenant seeds twelve deterministic five-minute Entries,
then multiplexes its next deadline into the existing DO alarm. A late wake
emits one fresh reading instead of manufacturing an outage-sized backlog. All
rows use the official v1 Entries schema and root `dataUpdate`; this is test
infrastructure, not an upstream API, external CGM bridge or medical algorithm.

The automatic context is bounded to 64 SGVs, ten MBGs, up to 1,000 matching
current DeviceStatus rows plus the earliest future matching DeviceStatus, the
latest Profile and the newest 1,000 Treatments within the existing time window.
It shares the existing 900-KB/8,000-node/2,000-document transport budget.

The prior IOB, COB and treatment-to-curve calculations retain
DeviceStatus precedence, Treatment fallback, Profile inputs, recency, rounding,
display and assistant behavior; they remain opt-in through the official
`ENABLE` set and now feed enabled values into API v2 Summary. Ddata applies
the locked Treatment marker placement on the glucose curve, including explicit
unit handling and raw-BG fallback. No new dose recommendation is introduced.
The Durable Object projection now supplies the newest current Profile, the
official 2.5-day ordinary-Treatment window, the newest zero-duration Profile
Switch from one year and the existing 62-day age events. Ordinary Treatments
are capped at the newest 1,000 inside the existing 900-KB/8,000-node/2,000-
document transport budget; this is an explicit Workers Free adaptation.

All prior registry, ddata/database-size, age/timeago, Sandbox, Settings, Loop,
Profile, uploader, identity, root-write/delta, API3 `/storage`, `/alarm`,
authorization and notification-ACK contracts remain green. Cloudflare Worker
version `5f0c3898-7d92-4164-af78-55b64cc46517` (ordinal 81) is active;
deployment metadata was created at `2026-07-22T02:57:21.637Z`, and Wrangler
reported a 36 ms startup. It processes 250 Static Assets entries. The Wrangler
4.112.0 dry run reports 1209.27 KiB raw / 223.51 KiB gzip and exposes only `ENTRY_STORE` plus
`ASSETS`. The 66-file Workers-runtime suite passes 719/719, all four audit suites pass
22/22, eleven official client files pass 42/42 unchanged, twenty-one locked
server/data-plugin files pass 143/143 unchanged and TypeScript passes. The
manifest records sixteen direct passes, 86 adapted, seven unresolved and
two fixed-scope excluded files.

Version 81's 77-assertion credential-free API/Engine.IO/Pebble smoke passed on
isolated tenant `public-smoke-1784689061606`. Unknown v1/v2 Pushover receipts
returned the locked 500 response. The public simulator remained enabled and
the browser displayed fresh `121 mg/dL`, `+4` data without an alarm dialog or
console error. The prior version-78 real
official Socket.IO 4.5.4 client also connected root and `/alarm`, received the
initial `dataUpdate`, authorized read and subscribed for alarms. Its clean
browser profile loaded the content-addressed official client and tenant
adapter, used EIO4 polling and reported zero console errors or warnings. The
version-74 Settings/Save and version-73 26-dot AR2 gates remain historical
evidence for unchanged assets.
Credential-free v1/v2 experiments
probes fail closed for anonymous callers because the active runtime has a valid
`API_SECRET`. A credentialed 25-entry simulated SGV batch wrote and read back
successfully, and the homepage rendered the latest value and populated chart.
Those 25 intentionally idle simulator rows were removed by exact device/type
matching after stale-data verification. Version 79 explicitly enabled only the
public `demo` lab tenant's durable simulator; fresh and ordinary tenants remain
disabled and do not auto-generate glucose.
These remain subset facts, not a full-port claim. The configuration guard
preserves operator-managed dashboard variables across deploys; the credential
value is not committed or recorded in project documentation.

Current remote reads, API3 version and EIO4 polling pass. The reusable 72-case
acceptance run sent no API secret. A separate isolated-tenant remote mutation
created one simulated SGV and then deleted it using a genuinely bodyless
`DELETE`; version 78 returned HTTP 200, `deletedCount:1` and zero remaining
rows. The credential value was neither printed nor recorded.

The delta adapter preserves the locked SGV/MBG/calibration/device-status field
replacement rules, treatment add/update/remove classification, `mgdl`
suppression, profile replacement and `lastUpdated` semantics. The authoritative
previous snapshot lives in SQLite rather than process memory and survives DO
reconstruction. HTTP API3 writes enqueue `/storage` and root frames inside the
same SQLite mutation transaction. Implemented legacy v1/v2 writes publish in a
follow-up DO transaction after the successful mutation (and after an Entries
ordered-prefix partial failure), so that path is durable eventual delivery,
not a claim of one cross-operation atomic transaction. Food/activity changes
advance the baseline but correctly produce no delta because locked
`calcdelta.js` has no food/activity output field.

The root write adapter covers all six locked collection names, exact error and
permission order, treatment exact/fuzzy dedupe, device-status dedupe, AAPS
Profile replacement, custom string IDs and raw dotted set/unset/remove. It
uses own-property traversal for prototype-pollution safety, limits an event to
100 documents, and retains the existing document size/depth bounds. Those
controls intentionally do not claim unrestricted Mongo/BSON mixed-type,
numeric-ID or object-ID parity. Schema v12 defaults upgraded live sessions to
no write authority until they re-authorize, without discarding their rows or
stored documents.

The deployed pure adapters preserve every named time/unit/level assertion, the
official raw calibration/noise/assistant property contract and uploader
battery recency/device/minimum/severity/visual/assistant contract. The
dispatcher retains official server-plugin order and enable gates; `upbat` is
default enabled, while `rawbg`, IOB and COB remain opt-in. The bounded DO
projection now includes the official current Profile and Treatment windows for
IOB/COB while excluding long-range history and unrelated food. During the
first rollout an already-live old DO lacked the new RPC; the corrected release
falls back only for Cloudflare's exact missing-method error to the existing
snapshot RPC. Enabled IOB/COB Summary state is deployed; BWP, remaining plugin
state and persistence still require Milestone E.

The new v1 contracts preserve Loop, Trio and AndroidAPS ordered batch response
shapes and pump/uploader metadata. Entries now implements exact numeric-date,
exact `dateString` and open `dateString`-range deletion plus the locked
numeric-brace `times/echo`, `times` and `slice` fixtures. Pattern compilation is
deliberately limited to eight literal prefixes, 256 expansions, 10,000
candidates per prefix and a reviewed linear regex subset. These are Workers
Free controls, not a claim that arbitrary JavaScript RegExp/Mongo behavior is
portable.

Treatments now maps the complete locked test file: XSS-bearing strings are
sanitized before persistence, zoned timestamps and numeric fields normalize as
upstream, UUID `_id` values become client identifiers, explicit AAPS identifiers
deduplicate, and query/bulk-delete plus server-ID lifecycle behavior are locked.
The Worker sanitizer keeps a reviewed safe tag set but strips all attributes;
it matches the locked malicious IMG fixture while intentionally remaining
stricter than DOMPurify for otherwise-safe attributes. The prior `preBolus`
two-record transaction, v1/v2 notification ACK, API3 collections, `/storage`,
`/alarm`, authorization, official pages and transport slices remain green.
Alexa compatibility is the mocked local REST/Speechlet contract only and makes
no external Amazon call.

Entries deliberately follows a fresh-only pre-1.0 policy. If activation finds
the old narrow `entries` shadow structurally incompatible, it resets that
shadow instead of attempting a risky partial import. Canonical documents and
other collections, including profile, are preserved. At 2026-07-18 14:51 UTC,
a read-only pre-deployment check found zero Entries and one profile in the
public lab; post-deployment remote reads confirmed the same counts. There was
therefore no old simulated Entry row to migrate on that tenant, and its profile
was preserved without recording its contents. This policy is acceptable for
the pre-1.0 simulated lab, but it is not a general migration path for an
existing Nightscout database.
Fresh deployment is the planned release path for the initial new-user/new-family
audience; an external legacy-history importer is not provided in the first
release and has no claimed delivery date. It means initially creating a new
Worker/SQLite DO namespace or using an empty tenant. A code redeploy to the
same Worker preserves Durable
Object data; it is not a database reset, so the current lab keeps its canonical
profile and other documents. This does not authorize real CGM/uploader/closed-
loop use: the deployed increment remains simulated-data only.

The Entries bounds are explicit: v1 defaults to a four-day date window;
realtime/ddata reads use two days; `dateString` and other unindexed candidate
sets stop with controlled HTTP 413 above 10,000 rows; synchronous delete and
per-document revision deletion are capped at 128; and `$re` accepts only the
bounded, case-sensitive subset that can be safely compiled to SQLite `GLOB`.
The v1 uploader additionally caps bodies at 512 KiB and batches at 100 items.
Within that batch each SQLite item is atomic, successful items before the first
conflict remain committed, and the suffix is not attempted, matching Mongo's
ordered bulk prefix rather than pretending the full request is atomic. Preview
and persistence share recursive string sanitization; Workers entity-encodes
HTML-like input because the locked JSDOM/DOMPurify runtime is not portable, so
existing entities are preserved across read-then-reupload while active markup
still cannot be stored. Treatments uses a separate safe-tag/all-attributes-
stripped adapter that matches the locked XSS fixture. Exact safe-attribute
DOMPurify bytes remain incomplete.

The ordinary compact-SGV path retains a requested count up to 10,000. A single
request selecting thousands of records that each contain abnormally large
custom fields is still materialized for RPC, sort, representation and ETag
generation and can approach the Workers Free CPU/memory boundary. This
extreme-request hardening is explicitly deferred; it is not counted as a
normal-family blocker and is not claimed solved.

The aggregate count is separate from that result cap: a one-year indexed
range can be counted without returning roughly 105,000 five-minute SGV rows.
Ordinary detail reads still cap one response at 10,000 and therefore require
date-partitioned requests for long exports. The locked `times/echo`, `times`
and `slice` fixtures now provide bounded dateString partition helpers; arbitrary
regex syntax, more than eight expanded prefixes and more than 10,000 candidates
per prefix are controlled platform differences.

The deployed increment includes:

- the locked official v15.0.7 UI/pages/assets with no replacement UI;
- one tenant-sharded SQLite Durable Object and Workers Static Assets only;
- page-used entries, food, profile, treatments, device-status, activity,
  role/subject/token subsets and aggregate REST polling;
- adapted v1/v2 Entries single/array/extended-urlencoded uploads, preview,
  uploader-owned sync identity, ordered batch-prefix failures, bounded indexed
  query/sort, current/model/ID reads and JSON/plain/CSV/TSV conditional GET/HEAD;
- bounded Entries `echo` plus SQL aggregate count for entries, treatments and
  device status, inherited by API v2;
- bounded numeric-brace Entries `times/echo`, `times` and dateString `slice`,
  plus exact/dateString-range delete selectors;
- v2 `/ddata/at` with the complete named upstream ddata helper contract,
  `/properties/<comma-list>` selection and truthy `pretty`, official
  `bgnow`/four-bucket/interpolated-`delta`/`direction` calculations,
  default-enabled `upbat`, opt-in `rawbg`, and shared official
  `times`/`units`/`levels` foundations; plus `/summary/?hours=`
  SGV/treatment/target/temp-basal/current-profile mapping;
- locked Treatments POST `preBolus` two-record fan-out on both v1 and v2,
  atomic in SQLite, complete UUID/identifier/AAPS/query/delete contracts and a
  stricter fail-closed safe-tag sanitizer, with PUT retaining the one-record
  save contract;
- locked root version discovery, complete v1/v2 Status representations, local
  Alexa Speechlet requests, AndroidAPS metadata and Loop/Trio batch behavior;
- tenant-persisted eight-hour HS256 JWTs, live subject/role lookup, exact
  `shiro-trie` matching, `verifyauth`, API v3 `/version` and JWT-only `/status`;
- all eight generic API v3 routes for entries, treatments, device status,
  profile, food and settings,
  including branch-sensitive permissions, ordered search, conditional read,
  history, collection-specific legacy fallback/deduplication, lastModified,
  tombstones, permanent delete and atomic rollback; JSON/CSV/XML rendering uses
  the locked upstream dependency versions and Accept negotiation order;
- strict tenant-local EIO4 polling and direct Hibernatable WebSocket with
  persisted sessions/queues, heartbeat, SIO5 root CONNECT, permission-derived
  authorization/data snapshots and bounded resource handling; a SQL-derived
  Durable Object alarm survives eviction and drives ping, pong timeout,
  session/lease expiry, closure retry, client-count updates and schema-v14
  background tasks;
- a tenant-local API3 `/storage` namespace with subject access-token room
  authorization, persisted subscriptions and bounded create/update/delete
  delivery for successful API3 mutations only;
- a tenant-local API3 `/alarm` namespace with independent connection, native
  access-token and web secret/JWT/anonymous subscription branches, exact ACKs,
  persisted snooze state and bounded live delivery of the five locked alarm
  event names. The bounded internal processor can now select, persist and
  publish upstream notification requests atomically; the unified task now
  feeds AR2, Simple Alarms, Pump, OpenAPS, Loop, CAGE, SAGE, IAGE, officially
  enabled Treatment Notify, opt-in Timeago and opt-in DBSize alerts through that
  outlet, while BWP and remaining plugin task sources stay incomplete;
- inherited v1/v2 GET `/notifications/ack`, protected by
  `notifications:*:ack`, with exact `200 OK`, durable repeated suppression,
  Urgent-to-Warning snooze, Hibernation delivery and broken-recipient isolation.

Version 79's 72-assertion credential-free remote smoke returned HTTP 200 for
health, bounded v1
Entries and Treatments reads, fresh-tenant Profile/current and v2 Summary,
matching v1/v2 filtered Settings snapshots, API3 version, real ddata/database
stats, default-enabled `dbsize`, Basal and AR2, opt-in-disabled Loop/IOB/COB/OpenAPS/Pump/CAGE/SAGE/IAGE,
null disabled IOB/COB Summary state, absent property-only `timeago` and EIO4
polling; missing-token API3 Entries returned the expected 401. Tenant
`public-smoke-1784684130172` observed 270,336 SQLite bytes. No deployed
credential was read or sent, and no protected mutation was attempted. The same
version 78 browser pass loaded the official homepage through the locked
Socket.IO 4.5.4 client, received the initial update, authorized and subscribed
to alarms with zero console errors or warnings. The preceding version-74
Settings Save and version-73 AR2 gates remain valid. A separate authenticated
simulator batch proved v1 SGV write/read and the populated official chart; real
closed-loop/device testing remains deferred to the user's final environment.
Version 79 additionally enabled the opt-in lab feed only for tenant `demo`;
its status reported a 300,000-ms interval and the official page rendered the
new one-hour SGV curve without a reload-specific substitute UI. Alarms appended
the `01:40` and `01:45` readings, and the already-open official page advanced to
the latest value without a manual refresh. Version 80 also completed the
authenticated Profile/Food/Admin/Reports browser workflows with temporary
values restored or deleted; no real health data was used.
The immediately preceding compatible version's
root protocol returned `{read:true,write:false,write_treatment:false}` to a
fresh anonymous-readable session, rejected Food `dbAdd` with `Not permitted`,
and left storage unchanged. Successful root and uploader writes remain local
contract evidence; version 72 used the construction credential only for the
named simulated SGV batch.

The code is still not a full port: non-Entries echo, arbitrary aggregation,
large-response CSV/XML resource adaptation, broader Mongo query/type parity,
WebSocket upgrade, EIO3 HTTP, profile-switch status/plugin preprocessing before
deltas, automatic task adapters for the remaining server plugins, live external provider delivery,
remaining BWP/plugin summary fields and nine upstream test files (seven unresolved
plus two fixed-scope exclusions) remain incomplete.
The homepage now consumes the implemented EIO4 polling server through the
official Socket.IO client. Polling upgrade, EIO3 and pushed protected page
workflows remain incomplete.

The deployed polling slice is intentionally bounded to 256 sessions per tenant,
128 queued packets and one 1,000,000-byte polling payload per session. It uses
25-second server pings, 20-second pong timeouts, strict non-binary request
shapes and request-time opportunity cleanup in batches of 32. Its persisted
single DO alarm also processes due heartbeat/session/lease work across
eviction and retry. Anonymous-readable root authorization ACKs `write:false`
and `write_treatment:false`; credentialed subjects receive their tested
permission-derived flags. Initial
`dataUpdate` follows locked recent-device-status filtering, while `loadRetro`
uses the unfiltered runtime-normalized device-status loader over the same
one-day raw window. Cursor-based snapshot loading applies a shared deterministic
900,000-byte, 8,000-node, 2,000-document budget (and 24-level per-document
depth cap) in profiles/device-status/SGV/treatments/food priority order before
the Socket.IO frame is built. The fixed 100-status cutoff is gone, but reaching
that shared ceiling can still deterministically truncate the older cursor tail.
The websocket status shape is locked, but `apiEnabled:true`,
`careportalEnabled:true`, `boluscalcEnabled:false` and the absence of
`activeProfile` are current platform assumptions. Strict one-object
`authorize`/`loadRetro` validation is a named safety tightening.
Exact `application/octet-stream` POSTs close their SID and return a controlled
400/code-3 response. Small malformed UTF-8 follows replacement decode and
parser-close behavior; raw-byte versus replacement-expanded accounting at the
1,000,000-byte boundary remains a controlled P2 parity task.

Subsequent server-originated root updates now use the persisted full current
snapshot as their delta baseline and queue only non-empty locked
`data.calcdelta` output for authorized live sessions. The official page now
uses this EIO4 path. The credentialed simulator batch proved v1 SGV write/read;
local contracts prove API3 Treatment polling delivery, unauthorized
silence, baseline survival across service reconstruction and update
classification. Client `dbAdd`, `dbUpdate`, `dbUpdateUnset` and `dbRemove`
handlers now adapt the complete locked `websocket.shape-handling.test.js` file;
profile-switch/plugin preprocessing, the direct-send replay boundary,
polling-to-WebSocket upgrade and EIO3 remain the next realtime slices.

## Ordered implementation milestones

### Milestone A — collection contract

1. Define a neutral collection repository interface from upstream Mongo calls.
2. Add SQLite schemas/indexes for every enabled collection.
3. Port ObjectId/UUID, type conversion, nested query, projection, sort, limit,
   upsert, dedupe and failure semantics.
4. Add `srvCreated`, monotonic `srvModified`, soft-delete tombstones and history.
5. Persist a change event in the same mutation turn.

This milestone is the dependency for the rest of API v3 and real-time updates.

### Milestone B — authorization parity

1. Store a random tenant JWT signing key in SQLite; never expose it.
2. Make `/api/v2/authorization/request/<accessToken>` issue an upstream-shaped
   signed JWT.
3. Verify JWT expiry/signature and reconstruct Shiro permission groups.
4. Port default roles, admin semantics, failure delay-list and status contracts.
5. Keep API_SECRET only as the bootstrap/admin credential and never log it.

Items 1–4 are complete for the named compatibility surface. The deployed
adapter derives the upstream subject credential from API_SECRET/ObjectId,
preserves prefix lookup, extracts credentials from the locked query/header/body
precedence, and persists a bounded per-IP failure delay that shares the DO
alarm. Schema v15 now persists and aggregates the upstream failed-auth Admin
notice without retaining the presented credential. The enforced delay is capped
at 60 seconds and transient Admin messages at 128 per tenant as named Workers
boundary differences.
Token-bearing authorization paths are redacted from adapter error logs.

### Milestone C — API completion

1. Finish v1 entries and document routes from Express registration and Swagger.
2. Finish the remaining plugin-derived v2 properties/summary state and
   persistence, the v2-only notification loop and remaining authorization
   surfaces. The ddata helper file, aggregate route, property picker/pretty
   mode, `bgnow`/`direction`/`rawbg`/`upbat`/`loop` property contracts and core summary mapper are
   deployed; inherited v1/v2 notification ACK is complete for its named
   adapted contract.
3. **Complete for the locked 16-file API3 contract set:** generic
   search/create/read/update/patch/delete/history, six-collection lastModified
   and byte-compatible small/medium JSON/CSV/XML rendering, plus shape, AAPS,
   storage adapter/socket, HEAD/CORS and configured lower paging-limit
   behavior. All 16 locked `api3.*` files are adapted. Complete bounded
   large-response handling and broader Mongo mixed-type/nested/array
   differential semantics before claiming unrestricted platform parity.
4. Port upstream API tests in module order and record any fixed-scope exclusion.

### Milestone D — real-time transport

1. **Complete for the named slice:** route exact `/socket.io` and `/socket.io/`
   polling requests to the tenant DO without intercepting the static,
   byte-identical official `/socket.io/socket.io.js` client asset.
2. **Partial:** EIO4/SIO5 polling sessions and direct Hibernatable WebSocket,
   server-ping/client-pong, persisted queues, root CONNECT and a SQL-derived DO
   alarm for ping/pong/session/lease/closure deadlines are implemented. API3
   `/storage` CONNECT, access-token room authorization and live mutation events
   are implemented on both current EIO4 transports. API3 `/alarm` CONNECT,
   native/web subscription authorization, ACK/silence persistence and the live
   notification outlet are also implemented on both current transports;
   inherited v1/v2 HTTP ACK commits through the same SQLite core.
   EIO3/SIO4 remains codec-only and is deliberately rejected by the HTTP
   endpoint; polling advertises `upgrades: []`.
3. Add the Engine.IO polling-to-WebSocket upgrade path; direct WebSocket open
   is already implemented and tested across DO eviction.
4. **Complete for the named `/storage` and `/alarm` transport slices:** preserve
   the tested persisted namespace/room/subscription behavior, exact alarm ACKs,
   live-only delivery and tenant isolation. Automatic AR2, Simple Alarms, Pump,
   OpenAPS, Loop, CAGE, SAGE, IAGE, Treatment Notify, Timeago and DBSize now
   publish through the outlet; remaining upstream notification producers are
   Milestone E work.
5. **Complete for the locked root write-shape slice:** `dbAdd`, `dbUpdate`,
   `dbUpdateUnset` and `dbRemove` preserve mapped permission, mutation, ACK and
   broadcast order. Extend profile-switch/plugin preprocessing and broader
   Mongo/BSON behavior separately.
6. **Complete for HTTP API3 `/storage` events:** create/update/delete frames are
   enqueued in the same transaction for current authorized subscribers. The
   separate locked main-namespace database-update baseline is also persisted;
   v1 remains excluded from `/storage` by upstream contract.
7. **Complete for the official polling client switch:** the locked Socket.IO
   4.5.4 client is shipped byte-identically, a small platform adapter adds only
   the optional test-tenant query, and local/remote/client/browser protocol
   gates pass. Keep polling upgrade, EIO3 and pushed protected workflows as
   separate remaining transport work.

### Milestone E — background/server behavior

1. **Generic substrate complete; plugin coverage partial:** schema v14 persists
   the task table and shares one derived alarm with realtime/auth deadlines.
   AR2, Simple Alarms, Pump, OpenAPS, Loop, CAGE, SAGE, IAGE, officially enabled
   Treatment Notify, opt-in Timeago and opt-in DBSize alerts share one automatic
   task; add bounded producers for every remaining job.
2. Add API v3 auto-prune; failed-auth Admin notification emission and persisted
   failure-delay cleanup are complete.
3. Extend the deployed static official plugin registry only with locked
   descriptors and complete algorithm contracts.
4. Retain the adapted dataloader/Sandbox/database-size path and execute the
   remaining official plugin/notification modules through a persisted tenant context.
5. **Complete for AR2, Simple Alarms, Pump, OpenAPS, Loop, CAGE, SAGE, IAGE,
   Treatment Notify, Timeago and DBSize scheduling:** the engine consults persisted `/alarm`
   ACK/silence rows and commits state, live publication and task reschedule
   atomically with retry, eviction, activation/expiry and all-clear coverage.
   Reuse this path for remaining producers without inventing medical algorithms.
6. Keep external integrations disabled unless separately authorized and within
   the fixed simulated-data scope.

### Milestone F — page and upstream closure

1. **Complete in version 80:** browser-test authenticated Profile/Food/Admin
   mutations and report generation; temporary records were restored/deleted,
   and the deployed Split/clock render regressions remain preserved.
2. Verify homepage charts/plugins update from a pushed real-time event.
3. Classify every upstream test file and make every applicable contract green.
4. Rebuild from the clean vendor snapshot and verify asset provenance.
5. Run full local checks, dry-run, deploy, remote API smoke and browser checks.

## Free-plan controls

- Keep ordinary HTTP work bounded for the Workers Free CPU budget; move
  coordination and stateful work to the tenant DO.
- Use indexed SQLite queries and explicit request/body/result limits.
- Use WebSocket Hibernation, not a permanently active connection loop.
- Schedule alarms only when persisted work is due.
- Preserve one DO per tenant rather than one global application bottleneck.
- Monitor `SQLITE_FULL`, overloaded DO and CPU-limit outcomes explicitly.

Current limits are verified from
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and
[Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
before changing resource assumptions.

## Deployment gate

Every deployment must run, in this order:

```sh
npm run build
npm run check
npm test
npm run deploy:dry
npm run deploy
```

The checked-in Wrangler configuration supplies `keep_vars: true`; encrypted
Secrets are preserved independently and no credential value belongs in Git.

After deployment:

1. smoke public status, the newly changed routes and known unsupported routes;
2. perform only simulated-data authenticated CRUD when the user-provided secret
   is available to the caller—never read or print the configured value;
3. use a real browser to check official UI network/console state and the changed
   workflow;
4. update `docs/DEPLOYMENT.md` and this plan with exact observed results.

## Rollback

The footprint remains one Worker, Workers Static Assets and the `EntryStore`
SQLite Durable Object namespace. Wrangler version rollback can restore Worker
code and assets, but neither rollback nor redeployment clears or rolls back the
SQLite Durable Object. NSCF's own forward-compatible schema activation remains
a release requirement even though importing an external MongoDB history is
deferred; never use destructive schema rollback on user data. No
D1/R2/Queue/custom-domain cleanup is needed because those resources are not
created.
