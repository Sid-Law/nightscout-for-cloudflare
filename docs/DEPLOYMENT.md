# Current deployment record

Last synchronized: 2026-07-22 (Asia/Shanghai)

## Status

The public Worker is deployed and healthy, but it is **not a complete
Nightscout port**. It serves the locked official v15.0.7 browser assets and the
named compatibility subset in `UPSTREAM_COMPATIBILITY.md`. Page availability
is not counted as API, plugin or real-time compatibility.

- Public URL: <https://nscf-phase1.nscf-lab-20260717.workers.dev/>
- Account ID: `fad59c859cb78943d97441581dfcab78`
- Worker: `nscf-phase1`
- Deployed runtime candidate: `7298f45`
- Runtime source candidate: `7298f45`
- Git commit matching the deployed runtime worktree: `7298f45`
- Cloudflare Version ID: `0dd4cdd5-09d2-428e-b12e-d6d66e6905e3`
- Cloudflare ordinal version number: `88`
- Version tag/message: none printed or present in the deployment-list metadata
- Version creation time: `2026-07-22T06:03:08.425Z`
- Activation: `wrangler deploy` completed Worker upload and trigger deployment;
  the current-version list reports this version last
- Worker startup: 28 ms
- Durable Object: class `EntryStore`, SQLite backend, Wrangler migration tag
  `v1`; internal schema includes the v6 Entries compatibility probe and the v9
  persisted API3 storage-namespace tables plus the v10 alarm connection and
  silence tables, the v11 root-delta baseline and the v12 persisted root-write
  authority columns, the v13 notification last-emission column, the v14
  persisted background-task table/index, the v15 Admin-notification table and
  the v16 persisted data-update debounce table/index and the v17 optional
  simulated-CGM scheduling row, the v18 push dedupe/receipt/Maker state and the
  v19 persisted EIO3/EIO4 session-protocol authority
- Static Assets: 250 entries. Version 75 uploaded the official Socket.IO client,
  the platform tenant-query adapter and six rebuilt page/service-worker files;
  versions 76–88 reused them unchanged
- Upload: 1256.42 KiB raw / 230.69 KiB gzip
- Provisioned product bindings: `ENTRY_STORE` Durable Object plus `ASSETS`
  only

The user supplied a construction `API_SECRET`. The 25-entry
`simulator://nscf-demo` seed created under version 72 was removed on 2026-07-22
by exact device/type matching after its idle timestamps triggered the official
stale-data alarm; the Profile and nonmatching collections were not deleted.
The value is not committed or recorded in this document. Anonymous probes
still fail closed. Version 79 explicitly enables the disabled-by-default
schema-v17 simulator only for the public `demo` lab tenant; ordinary and fresh
tenants do not auto-generate glucose.
Cloudflare's current Wrangler documentation states that dashboard text
variables are overwritten by a normal deployment unless `keep_vars` is true,
while encrypted Secrets are not deleted by ordinary deployments. The current
deployment includes that preservation guard. Credential lifecycle remains an
operator action outside this evidence run.

## Cloudflare footprint

The project uses exactly:

1. one Worker;
2. one Workers Static Assets deployment;
3. one SQLite Durable Object namespace.

It does not create or use D1, R2, KV, Queues, a custom domain or a zone route.
The public instance is for simulated data only and must not receive real health
data, CGM credentials, pump credentials or closed-loop traffic.

## Version 79 lab-feed increment

- `/_nscf/simulated-cgm` is an NSCF platform endpoint, not an upstream
  Nightscout route. GET uses the ordinary Entries read permission; POST
  requires Entries create permission to enable and delete permission to stop.
- The switch is persisted independently per tenant and defaults to disabled.
  Enabling seeds twelve deterministic SGVs at five-minute spacing, then adds
  its next deadline to the existing Durable Object alarm multiplexer.
- A due turn writes one current official v1 Entry, publishes the normal root
  `dataUpdate`, advances the sequence and schedules five minutes later.
  Repeated delivery after a committed turn is a no-op; eviction retains the
  state and a long suspension produces one current reading rather than a
  fabricated historical backlog. A crash in the small test-only gap between
  the Entry commit and schedule advance can add one extra sample, not an
  unbounded replay; closing that gap is deferred with the direct-send crash
  boundary rather than delaying ordinary-family testing.
- The public `demo` tenant was explicitly enabled after deployment at
  `2026-07-22T01:35:00Z`; status returned `intervalMs:300000`, twelve seed rows
  appeared in the official chart, and isolated smoke tenants remained empty.
  Durable alarms then appended `116` at `01:40:00Z` and `114` at `01:45:00Z`;
  the already-open official page changed to `114`, `-2`, one minute ago without
  a manual reload and the next deadline advanced to `01:50:00Z`.
- This mechanism contains no real CGM bridge, dose recommendation, user-facing
  substitute UI or new medical calculation. Disabling stops future writes but
  does not secretly delete ordinary Entries.

## Version 80 Pebble and official-page acceptance increment

- `/pebble` and `/pebble/` adapt the locked v15.0.7
  `lib/server/pebble.js` endpoint. They preserve newest-first count handling,
  mg/dL/mmol display, trend/direction, delta, uploader battery, raw/calibration
  and IOB/COB display fields. The Cloudflare adapter caps one request at 1,000
  Entries and uses request-local bounded plugin context.
- The version-80 local Workers gate was 64 files / 700 tests. Its manifest was
  15 direct pass, 83 adapted, 11 unresolved and two fixed-scope exclusions.
- The 77-assertion public smoke passed on fresh tenant
  `public-smoke-1784686572692`; a `demo` Pebble read returned the two newest
  continuing simulated Entries.
- Authenticated browser acceptance used only temporary test values: Profile
  rename/save/reload/restore passed; Food create/read/delete passed; Admin role
  create/delete passed; Reports generated 30 SVGs and eight canvases. All
  temporary values were removed or restored.
- The unchanged homepage displayed the continuing simulator at `129 mg/dL`,
  `+3` and `FortyFiveUp`. No real health data, CGM credential or closed-loop
  client was used.

## Version 81 push-provider contract and simulator-clear increment

- Commit `ae88ba1` completely represents the 15 locked Maker, Pushover and
  Pushnotify cases. Message values, event names, key fallback, priorities,
  retries, SHA-1 keys, short dedupe leases, receipts, cancellation and All
  Clear behavior are retained behind injected transports.
- Schema v18 persists per-tenant dedupe leases, one-hour emergency receipts and
  Maker's 30-minute All Clear guard across Durable Object eviction. The
  official POST callback is live through v1 and inherited v2; it consumes only
  a previously stored unexpired receipt and acknowledges the durable alarm.
  Live external Pushover/IFTTT delivery remains disabled.
- A simulator regression proves that fresh seeded SGV data automatically
  clears an already-emitted stale-data alarm. The public `demo` simulator
  remained enabled with a fresh `121 mg/dL` reading.
- Local gates passed: 66 Workers files / 719 tests, 22 audit tests, 42 unchanged
  client tests, 134 unchanged server/data-plugin tests, TypeScript and dry run.
  The manifest is 15 direct pass, 86 adapted, eight unresolved and two
  fixed-scope exclusions.
- Public smoke passed 77 assertions on `public-smoke-1784689061606`. Unknown
  v1/v2 provider receipts returned HTTP 500 with `Internal Server Error`. The
  unchanged real homepage displayed `121 mg/dL`, `+4`, four minutes ago with
  no visible dialog, console warning or console error.

### Post-version-81 upstream audit increment

- No Worker runtime changed and no deployment was required. The complete locked
  `mongo-pool-config.test.js` file now runs unchanged: all eight upstream
  Node/Mongo pool-option cases pass, raising the current manifest to 16 direct
  passes, 86 adapted files, seven unresolved files and two fixed-scope
  exclusions.
- The unchanged server/data-plugin gate is now 21 complete files and 143/143
  tests. This is source-compatibility evidence only; NSCF uses SQLite Durable
  Objects and intentionally has no `MONGO_POOL_SIZE` Worker setting.
- The seven unresolved files are Mongo connection/retry, destructive Mongo test
  cleanup/production-safety and Mocha flakiness/self-test files. They are not
  ordinary-family Nightscout page, uploader or closed-loop API features.

## Version 82 Profile Switch realtime-status increment

- Commit `99cfe78` ports the locked `websocket.js` Profile Switch status
  behavior. Initial root authorization with `status:true` now includes the
  latest one-year, zero-duration Profile Switch as `status.activeProfile`.
- The active-profile comparison marker is stored in the existing SQLite
  `realtime_root_state` JSON. A later Profile Switch emits its Treatment delta
  plus a fresh complete status object, including `activeProfile`, after Durable
  Object eviction. Ordinary Treatment/SGV updates retain their prior compact
  delta without a status object.
- The Workers suite increased to 720/720 across the same 66 files. The final
  all-green run also passed 22/22 audits, 42/42 unchanged client tests, 143/143
  unchanged server/data-plugin tests, TypeScript and the Wrangler dry run.
- Cloudflare version `baade90c-d738-4a8b-a6c2-f1b19af68d9b` is ordinal 82,
  created at `2026-07-22T03:20:47.618975Z`; startup was 30 ms.
- Public smoke passed 77 assertions on isolated tenant
  `public-smoke-1784690470717`. The public `demo` simulator remained enabled,
  returned current five-minute readings and the unchanged homepage refreshed
  to `127 mg/dL`, four minutes old, without a dialog or console warning/error.
- No protected remote Profile Switch mutation is claimed for this version:
  the deployment shell had no API_SECRET injection. The real SQLite DO test
  performs the write, evicts the object, writes the next switch and observes
  the pushed status; remote evidence here is read-only API/protocol/browser
  smoke.

## Version 83 Bolus Wizard Preview server increment

- Commit `f09e99f` ports the locked v15.0.7 server-side BWP calculation as an
  opt-in adapter. It retains mg/dL/mmol paths, missing Profile/IOB/stale-data
  errors, IOB effect/outcome, target estimates, recent carbs, display flooring,
  Temp Basal preview percentages, warning/urgent requests and IOB-based snooze.
  It does not add a dose formula or execute a Treatment.
- BWP now participates in the official v2 property registry and Summary state,
  and Pebble adds `bwp`/`bwpo` when IOB is requested. Environment mapping covers
  the official `BWP_SNOOZE`, `BWP_WARN`, `BWP_URGENT` and `BWP_SNOOZE_MINS`
  settings only when the plugin is enabled.
- The persisted notification task evaluates twelve producers in upstream order:
  BWP runs after Loop and before CAGE. The task and request paths share Profile
  Switch, Temp Basal and Combo Bolus preprocessing, including the latest bounded
  one-year zero-duration Profile Switch.
- Local gates passed: 67 Workers files / 728 tests, 22/22 audits, 42/42 unchanged
  client tests, 143/143 unchanged server/data-plugin tests, TypeScript, Wrangler
  type generation and dry run. The dry bundle was 1220.35 KiB raw / 225.96 KiB
  gzip with 250 assets and only `ENTRY_STORE` plus `ASSETS`.
- Cloudflare version `351ae79e-fcbb-4ff7-ba52-f013547311b5` is ordinal 83,
  created at `2026-07-22T03:49:01.064Z`; startup was 26 ms. The 77-assertion
  public smoke passed on isolated tenant `public-smoke-1784692181407`.
- BWP is disabled in the public upstream-default configuration. Remote v2
  Properties returned `{}`, Summary returned `bwp:null`, and Pebble omitted BWP;
  the enabled path is proven by the real SQLite Durable Object alarm test rather
  than a protected public mutation.
- The unchanged homepage displayed `113 mg/dL`, `-1`, `Flat`, one minute old,
  without a dialog or console warning/error. The lab simulator remained enabled;
  it appended `115 mg/dL` at `2026-07-22T03:55:00.124Z` and advanced its next
  persisted five-minute deadline, so no manual reseeding or data deletion was
  needed.

## Version 84 legacy EIO3 polling increment

- Commit `45074b9` turns the previously tested EIO3/SIO4 codecs into a routed
  HTTP-polling transport while preserving the existing EIO4 polling/direct-
  WebSocket paths. Schema v19 stores the Engine protocol with each session and
  safely rebuilds an older realtime-session table during activation.
- The locked upstream Socket.IO server supplied the byte oracle. EIO3 returns
  a length-prefixed open packet first; its next poll returns root CONNECT before
  `clients`. Client ping/server pong, namespace query parsing, SIO4 packet
  conversion, ACKs and mixed EIO3/EIO4 broadcasts are protocol-aware.
- Local gates passed: 67 Workers files / 731 tests, 22/22 audits, 42/42
  unchanged client tests, 143/143 unchanged server/data-plugin tests,
  TypeScript, Wrangler type generation and dry run. The dry bundle was 1244.44
  KiB raw / 228.40 KiB gzip with 250 assets and only `ENTRY_STORE` plus
  `ASSETS`.
- Cloudflare version `c779b136-0f3f-4aaa-88ab-48309e1a53cf` is ordinal 84,
  created at `2026-07-22T04:28:56.791942Z`; startup was 39 ms. The
  99-assertion public smoke passed on isolated tenant
  `public-smoke-1784694550269` and covered both EIO4 and EIO3 polling.
- A fresh real-browser reload displayed `127 mg/dL`, `-3`, one minute old with
  the official chart, a connected live client and no console warning/error.
  The persisted simulator remains enabled on its five-minute schedule. EIO3
  direct WebSocket/upgrade, polling-to-WebSocket upgrade, JSONP and binary
  transports remained explicit gaps in version 84.

## Version 85 EIO4 polling-to-WebSocket upgrade increment

- Commit `3c4b82a` adds the standard EIO4 upgrade path without changing the
  byte-identical official client. EIO4 polling now advertises
  `upgrades:["websocket"]`; a live SID follows `2probe`, `3probe`, polling noop
  and `5` before the persisted session atomically changes to WebSocket.
- Direct and upgraded sockets use Cloudflare WebSocket Hibernation. Upgrade
  phase/deadline state is attachment-validated and the ten-second timeout uses
  the existing SQLite closure row plus the DO's single alarm. Duplicate,
  malformed, abandoned and timed-out candidates close without deleting the
  original polling session.
- Local gates passed: 67 Workers files / 734 tests, 22/22 audits, 42/42
  unchanged client tests, 143/143 unchanged server/data-plugin tests,
  TypeScript, Wrangler type generation and dry run. The dry bundle was 1251.01
  KiB raw / 229.54 KiB gzip with 250 assets and only `ENTRY_STORE` plus
  `ASSETS`.
- Cloudflare version `1eb859ef-2feb-4c42-b9c2-aa533be7cc7e` is ordinal 85,
  created at `2026-07-22T04:57:24.298446Z`; startup was 25 ms. The
  106-assertion public smoke passed on isolated tenant
  `public-smoke-1784696258002`, completed a real WSS upgrade and received root
  CONNECT plus `clients` over that upgraded transport.
- The locked homepage source explicitly requests polling, so the official page
  remains on polling by upstream choice. Its fresh reload displayed
  `121 mg/dL`, `+4`, three minutes old with the chart and no warning or console
  error. EIO3 direct WebSocket/upgrade, JSONP and binary remain explicit gaps.

## Version 87 legacy Food/Profile read-contract increment

- Commit `8ee5c73` separates the locked Food/Profile helpers from the generic
  document query path. Food root and `regular` retain stored shapes and ignore
  unused query options; `quickpicks` additionally requires exact
  `type:"quickpick"` plus string `hidden:"false"` and applies Mongo-like
  ascending `position` order.
- Non-Treatment reads no longer run the Treatment numeric mapper, which had
  fabricated `carbs`/`insulin` values on Profile, Food, Activity and
  DeviceStatus responses. Singular `/profile/` is count-only, plural
  `/profiles/` is the query/read-only route, and invalid collection children
  return 404 as in the locked Express routers.
- Local gates passed: 67 Workers files / 736 tests, 22/22 audits, 42/42
  unchanged client tests, 143/143 unchanged server/data-plugin tests,
  TypeScript, Wrangler type generation and dry run. The dry bundle was
  1253.33 KiB raw / 230.07 KiB gzip with 250 assets and only `ENTRY_STORE`
  plus `ASSETS`.
- Cloudflare version `d8c70ff9-3370-4745-b9ee-45da662c1689` is ordinal 87,
  created at `2026-07-22T05:35:41.556Z`; startup was 24 ms. The expanded
  120-assertion public smoke passed on isolated tenant
  `public-smoke-1784698633397`, retained real EIO4 WSS upgrade/EIO3 polling
  and reported 299,008 SQLite bytes.
- A fresh official Food Editor session displayed `Database loaded`, the full
  record editor and Quick-picks controls with no console warning/error. A
  separate fresh homepage displayed `118 mg/dL`, `-3`, four minutes old, no
  dialog and no console issue. The simulator remained enabled. The browser
  automation did not expose its page-local authorization object, so no remote
  protected Food write is claimed; mixed write/read/order behavior is proved
  by the real SQLite Durable Object contract.

## Version 88 Dexcom Error Codes notification increment

- Commit `7298f45` ports the locked server-side `errorcodes` producer and places
  it after Simple Alarms in official notification order. It preserves all eight
  named display codes plus fallback display, code-specific Pushover sounds,
  default information/urgent classification and literal `off` custom mapping
  through `ERRORCODES_INFO`, `ERRORCODES_WARN` and `ERRORCODES_URGENT`.
- The producer chooses the newest SGV at or before the logical evaluation time,
  requires `mgdl < 39` and strict age below ten minutes, activates future rows
  at their exact timestamp and clears at exact expiry. It publishes through the
  existing atomic SQLite `/alarm` processor; no new notification outlet, real
  CGM bridge or medical calculation is introduced.
- Local gates passed: 68 Workers files / 749 tests, 22/22 audits, 42/42
  unchanged client tests, 143/143 unchanged server/data-plugin tests,
  TypeScript, Wrangler type generation and dry run. The dry bundle was
  1256.42 KiB raw / 230.69 KiB gzip with 250 assets and only `ENTRY_STORE`
  plus `ASSETS`.
- Cloudflare version `0dd4cdd5-09d2-428e-b12e-d6d66e6905e3` is ordinal 88,
  created at `2026-07-22T06:03:08.425Z`; startup was 28 ms. The expanded
  121-assertion public smoke passed on isolated tenant
  `public-smoke-1784700236170`, retained real EIO4 WSS upgrade/EIO3 polling and
  reported 299,008 SQLite bytes.
- Remote status confirmed `errorcodes` remains enabled by the official default.
  The public tenant was not polluted with an artificial error reading; ten
  pure-adapter tests and three real SQLite DO scheduler tests prove information,
  urgent, future-activation and exact-clear behavior.
- A fresh official homepage displayed `122 mg/dL`, `+4`, an upward trend and a
  populated chart without an alarm dialog or console warning/error. Settings
  still reported Nightscout 15.0.7. The `demo` simulator remained enabled with
  `intervalMs:300000`; its latest row was current and its next alarm deadline
  advanced normally.

## Version 86 root Treatment-to-curve preprocessing increment

- Commit `750e9ec` connects the existing direct port of locked
  `lib/data/treatmenttocurve.js` to the root Socket.IO snapshot. Initial
  authorization and later `dataUpdate` deltas now carry the same display-only
  Treatment `mgdl`/`mmol` marker fields as the Node dataloader path.
- The adapter resolves units from the current tenant Profile/status settings
  and obeys the official `rawbg` enable gate. Explicit readings and caps,
  surrounding-SGV averaging and raw-calibration fallback stay in the locked
  function; no insulin recommendation or new medical calculation is added.
- Each Treatment is transformed before it is reserved in the shared realtime
  JSON budget. Added marker fields therefore remain inside the 900-KB/8,000-
  node/2,000-document Free-plan boundary instead of expanding a completed
  payload afterward.
- The named DO test covers initial root delivery, profile-derived mmol output,
  eviction, a second Treatment write and the reconstructed pushed delta. Local
  gates passed: 67 Workers files / 735 tests, 22/22 audits, 42/42 unchanged
  client tests, 143/143 unchanged server/data-plugin tests, TypeScript,
  Wrangler type generation and dry run. The dry bundle was 1251.44 KiB raw /
  229.59 KiB gzip with 250 assets and only `ENTRY_STORE` plus `ASSETS`.
- Cloudflare version `44f94fa0-8061-4a7e-a30b-113e239488e6` is ordinal 86,
  created at `2026-07-22T05:12:52.069Z`; startup was 29 ms. The 106-assertion
  public smoke passed on isolated tenant `public-smoke-1784697190440`, retained
  the real EIO4 WSS upgrade and reported 299,008 SQLite bytes.
- The remote run used no credential and therefore makes no protected-write
  claim. A fresh official homepage session received root and alarm events,
  displayed current simulated glucose, rendered two SVGs and showed no dialog,
  console warning or console error.

## Release content

The current deployed increment retains the generic SQLite background scheduler,
locked query/language layer and AR2 adapter, and adds persisted official CAGE,
SAGE, IAGE and opt-in DBSize notification producers without inventing medical
or dosing logic:

- the request-local query adapter preserves four-day/configurable date defaults,
  date-filter bypass for IDs, non-ObjectId strings, ObjectId-shaped values and
  current UUID handling without `mongodb`, `traverse` or `moment`; the live
  Entries parser reuses its default boundary and ObjectId normalization before
  bounded indexed SQLite execution;
- the request-local language adapter preserves English identity, placeholders,
  French/Czech/case-insensitive/Traditional-Chinese lookup, speech metadata and
  unsupported-language fallback. It loads dictionaries through Static Assets
  instead of `fs`; all 33 deployed JSON files are valid and byte-identical to
  the locked release, and `LANGUAGE` reaches HTTP and Socket settings;
- the official notification task now evaluates thirteen producers in server
  order: AR2, Simple Alarms, Error Codes, Pump, OpenAPS, Loop, BWP, CAGE, SAGE, IAGE,
  Treatment Notify, Timeago and opt-in DBSize;
- AR2 preserves the locked coefficients, six predicted points, inclusive
  six-sample/five-divisor average-loss behavior, warning/urgent thresholds,
  13-step forecast cone, sounds, titles, mg/dL/mmol scaling and English virtual
  assistant response;

- Simple Alarms preserves the locked recent/nonfuture SGV boundary, strict
  urgent/warning high/low thresholds, exact default message, titles, event
  names and Pushover sound metadata;
- Error Codes preserves the locked display/fallback and sound maps, default and
  literal-`off` custom levels, newest nonfuture SGV rule, strict ten-minute
  freshness and exact future-activation/expiry scheduling;
- the processor preserves request reset, first urgent then warning,
  information/announcement handling, longest eligible snooze and automatic
  all-clear;
- schema v13 adds nullable last-emission state to the existing alarm-silence
  rows. Migration from v12 is idempotent and data-preserving;
- schema v14 adds `background_tasks(kind, due_at, attempt_count, updated_at)`
  and a due-time index. Partial activation repair preserves an existing task;
- schema v15 adds per-tenant Admin-notification message aggregation, official
  eight-hour API/twelve-hour cleanup windows, readable-site and failed-auth
  producers, public-count/admin-body filtering and disable-gate persistence;
- schema v16 adds the upstream one-second trailing/five-second max-wait
  bootevent debounce as tenant SQLite state. Leading evaluation remains
  immediate, rapid Profile/Entry/DeviceStatus/Treatment uploads collapse to one
  final task, and the existing DO alarm survives isolate eviction;
- a bounded internal `EntryStore` RPC accepts at most one MiB, 128 notification
  requests and 128 snoozes, then persists the decision and publishes the
  selected live `/alarm` object in one SQLite transaction;
- canonical Entries, DeviceStatus, Treatments and Profile mutations schedule
  and immediately evaluate the notification leading edge from at most 64 SGVs,
  ten MBGs, 1,000 matching current DeviceStatus rows plus the earliest future
  matching status, the latest Profile and the newest 1,000 Treatments inside
  the shared 900-KB/8,000-node/2,000-document budget. Inactive results leave no
  periodic wake; active results repeat at the configured heartbeat;
- Simple Alarms retains the exact ten-minute SGV expiry. Treatment Notify
  retains its strict ten-minute/manual-event filter, automated-event exclusion,
  snooze arbitration, exact expiry and future Treatment activation. Timeago
  retains strict `>` warning/urgent transitions by scheduling threshold plus
  one millisecond, fresh-SGV clearing and future SGV activation;
- Pump, OpenAPS and Loop retain their strict warn/urgent threshold-plus-one-
  millisecond transitions, source expiration and future DeviceStatus
  activation. OpenAPS Offline starts at its future marker, suppresses Pump/
  OpenAPS deadlines while active and clears one millisecond after its inclusive
  expiry. Pump quiet-night low-battery behavior wakes at the next exact local
  Profile-timezone boundary without minute polling;
- Treatment Notify executes only when the official plugin-enable gate includes
  `treatmentnotify`; Timeago additionally requires truthy
  `TIMEAGO_ENABLE_ALERTS`. Pump, OpenAPS and Loop require their respective
  official plugin-enable and `*_ENABLE_ALERTS` gates. All five gated branches
  remain dormant under the deployed upstream default settings;
- task completion/reschedule, notification state and live `/alarm` queueing
  commit together. Early at-least-once delivery is a no-op; caught failures
  persist exponential retry beginning at two seconds and capped at five
  minutes;
- realtime, authorization-cleanup and background deadlines are multiplexed
  through the DO's one platform alarm. `HEARTBEAT` is bounded to 15 seconds
  through 24 hours;
- CAGE/SAGE/IAGE use only the latest current and earliest future matching
  Treatment per official event type. The scheduler wakes at exact whole-hour
  thresholds, repeats active alerts at the heartbeat and clears at the exact
  start of minute 21 after the locked inclusive alert window. The locked IAGE
  urgent-comparison bug is preserved rather than silently fixed;
- the DBSize producer consumes `ctx.storage.sql.databaseSize`, is disabled by
  default under the official alert gate, and when opted in persists heartbeat
  scheduling and publishes through `/alarm`;
- the RPC is not a public HTTP API. Remaining plugin producers and external
  push providers remain incomplete; BWP is now an opt-in persisted producer;
- all five named `simplealarms.test.js` and all eight named
  `notifications.test.js` cases pass unchanged in the direct upstream gate,
  with existing DO migration/persistence/live-publication contracts plus twelve
  schema-v14 notification scheduling/repair/retry integrations;
- the prior Basal Profile and Treatment Notify calculation behavior remains
  deployed:

- Basal preserves the scheduled Profile rate, active Temp Basal and Combo
  Bolus contributions, official property/pill, visualization and assistant
  response. It is enabled by the locked default feature set;
- the property context adds at most ten recent meter-BG Entries plus exact
  Profile Switch, Temp Basal and Combo Bolus treatment groupings, under the
  existing shared JSON budget;
- Treatment Notify preserves the upstream ten-minute record window, manual/
  automatic filtering, auto-snooze object, calibration/treatment/temporary-
  target/announcement request classification and synchronous `node:crypto`
  SHA-1 hash;
- when officially enabled, Treatment Notify is automatically evaluated,
  scheduled and retried through the shared task; delivery remains tenant-local
  `/alarm` only and no external provider is connected;
- all eight named Basal/Treatment-Notify upstream cases plus two Workers-runtime
  integration cases pass. The unchanged upstream runner now covers 20 files and
  134/134 cases, including AR2, Admin notices, ObjectId cache compatibility, the
  environment parser and Express extension middleware;
- the prior OpenAPS, Pump and Loop calculations now also execute automatically
  through the shared task under their official gates. IOB, COB, Treatment-to-
  curve, age/timeago and dataloader/database-size adapters remain deployed. No
  dose recommendation or downstream medical calculation was added.

- `ctx.storage.sql.databaseSize` supplies the real SQLite file total to v2
  ddata and the property projection; it maps to upstream `dataSize` with
  `indexSize:0` so the official plugin does not double-count indexes;
- the Workers Free one-GB per-object ceiling is expressed in the plugin's MiB
  unit as 953.67431640625, and all five upstream `DBSIZE_*` variables retain
  their numeric/boolean normalization;
- all 11 named `dbsize.test.js` cases and the complete Promise-based
  `dataloader.test.js` case pass as Workers-runtime contracts; the live API and
  official homepage consume the same byte count and maximum;
- Cloudflare's official
  [`databaseSize` documentation](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
  and [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
  define this platform substitution;
- the prior request-local static registry remains in place and replaces Node
  dynamic plugin `require` while
  preserving the locked client/server catalogs, order, enable/shown gates,
  hook/error behavior, event aggregation and client extended settings;
- the implemented v2 server properties execute through that registry, while
  descriptors for unresolved plugins do not fabricate their algorithms;
- both named `plugins.test.js` cases and the wider registry surface pass in the
  Workers suite;
- eleven complete official client files run 42/42 unchanged after the
  upstream-built bundle and NSCF public bundle are proved byte-identical;
  Care Portal and Profile Editor use their locked headless mock transports, so
  this is not credentialed remote mutation evidence.

The immediately preceding deployed increment hardened deployment
configuration without changing Nightscout runtime formulas or routes:

- `keep_vars: true` preserves dashboard-managed text variables across later
  Wrangler deployments;
- a Node audit locks that setting, rejects a checked-in `vars` object and
  rejects D1, R2, KV, Queues and custom routes while requiring only
  `ENTRY_STORE` plus `ASSETS`;
- encrypted Secrets remain preferred and are independently preserved by
  Cloudflare. No credential was created, recovered, read or printed.

The earlier deployed increment added the complete locked Sandbox module contract:

- all five named `sandbox.test.js` cases pass in both the locked original suite
  and the Workers runtime mapping, with one extra helper-surface/isolation case;
- client/server initialization, safe notification projection, immutable
  properties, historical SGV selection, LOW/HIGH and display/scaling helpers,
  default messages and plugin-specific extended settings remain request-local;
- the existing locked Profile, units and times adapters replace Node dynamic
  `require` and module-global state. The data loader and database-size plugin
  were completed in version 57; remaining plugin algorithms, notification
  runner and alarm-backed schedule remain incomplete.

The earlier deployed increment added the complete locked Settings module contract:

- all 13 named `settings.test.js` cases pass in both the locked original suite
  and the Workers runtime mapping;
- HTTP and Socket.IO status now consume a fresh request-local settings object
  with official defaults, accessors, feature/alarm resolution, threshold
  correction, snooze helpers and recursive secure-key filtering;
- one extra Workers case proves that mutation and secret fields cannot cross a
  request/tenant boundary. Broader `lib/server/env.js` process/filesystem and
  extended-settings discovery remain incomplete.

The earlier deployed increment added the complete locked Loop
plugin contract:

- all five named `loop.test.js` cases pass in the Workers runtime as well as in
  the locked original suite;
- enabled Loop DeviceStatus feeds `/api/v2/properties` with the official
  enacted/error/`received=false` display, six-point forecast and stale-status
  level, plus the locked notification-request and virtual-assistant outputs;
- the adapter only interprets uploader-provided Loop data. It adds no dosing
  calculation or medical recommendation, and the persisted background
  notification runner remains incomplete.

The earlier concurrent-uploader evidence increment added the complete contract
without changing its then-current Worker runtime:

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
  temporary-target, temp-basal schedule and current-profile mapping. The
  current release additionally feeds enabled request-local registry values,
  including IOB/COB/BWP, into the mapper. Disabled IOB/COB/BWP remain `null`;
  unsupported properties are not fabricated;

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
- persisted EIO4 polling and direct Hibernatable WebSocket root slices with
  SIO5 CONNECT, clients count, permission-derived authorization, `dataUpdate`,
  locked root mutations/ACK order and one SQL-derived Durable Object alarm;
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
  all-clear ACK payloads and Urgent-to-Warning snooze behavior. The core
  processor now selects, persists and publishes upstream notification requests
  when invoked, and one schema-v14 task automatically feeds AR2, Simple Alarms,
  Pump, OpenAPS, Loop, CAGE, SAGE, IAGE, officially enabled Treatment Notify,
  opt-in Timeago and opt-in DBSize alerts; remaining server notification plugins
  are not yet automatic;
- the official v1 GET `/notifications/ack` route on both v1 and inherited v2
  mounts. It requires `notifications:*:ack`, returns the exact Express `OK`
  body, and commits through the same durable ACK/all-clear transaction as the
  Socket.IO namespace. The release also repairs a stale-past DO alarm race so
  queued delivery cannot erase the only remaining SQL wakeup;
- the locked official v15.0.7 UI and byte-identical official Socket.IO 4.5.4
  client, with only an optional test-tenant query adapter beside it;
- Cloudflare bodyless `DELETE` normalization: a zero-byte edge stream is
  treated as the same absent authorization payload as `request.body === null`,
  while POST/PUT and nonempty malformed bodies remain strict.

The homepage uses the deployed EIO4 polling root and `/alarm` namespace through
the official client, while standard external EIO4 clients can upgrade to
WebSocket and legacy clients can use EIO3 HTTP polling. EIO3 direct
WebSocket/upgrade, JSONP and binary remain separate incomplete transport work.

## Fresh-family and storage policy

Entries uses a deliberate fresh-only policy for the incompatible pre-1.0 lab
shadow table. Activation resets only that narrow shadow; canonical documents
and other collections, including profile, are preserved. A read-only check at
2026-07-18 14:51 UTC found zero Entries and one profile. Post-deployment reads
again returned zero Entries and one profile, without inspecting or recording
the profile contents. A later 25-SGV simulator batch was temporary acceptance
data; its exact device/type rows have now been deleted and the Profile remains.

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

The deployed runtime candidate is `7298f45`. It retains schema-v15 persisted
Admin notices, adds the complete storage-shape adapter and schema-v16 durable
bootevent debounce on top of the locked v1/v2 `experiments/test`, complete named API
security/verifyauth/API_SECRET, query, language and schema-v14 notification
work, and adds the official AR2 prediction/property/notification adapter while retaining
request-local Basal Profile state and all prior OpenAPS/Pump, IOB/COB/
Treatment-to-curve, registry, age/timeago, dataloader/database-size, Sandbox,
Settings, Loop, Profile, uploader, identity, root-write/delta, v1, API3,
authorization, realtime, notification-ACK and official-page work. Schema v17
adds the opt-in per-tenant lab feed and its one-alarm continuation without
changing official request/response contracts. It also adds the exact opt-in
server BWP property/Summary/Pebble/notification chain and shared Profile
preprocessing without adding a medical formula or Treatment action.
Schema v19 additionally persists Engine protocol authority and routes the
upstream-exact EIO3/SIO4 HTTP-polling sequence alongside EIO4.
The current transport adapter additionally completes EIO4 polling-to-WebSocket
upgrade, persists candidate timeout work in the existing alarm multiplexer and
runs locked Treatment-to-curve preprocessing in initial/reconstructed root snapshots.
The same persisted notification task now includes the locked Error Codes
producer with exact mapping, strict freshness and future activation behavior.
The table below records the exact current local gate for the immutable deployed
runtime and assets. The unchanged-client runner now includes the original
client Hashauth, Admin Tools, report-settings and complete Reports workflows;
the unchanged server runner now also includes Admin notices, ObjectId cache
compatibility and the upstream environment parser. Static Assets
remain byte-identical to v15.0.7, while the runtime changes are included
in the current deployed candidate.

| Check | Result |
| --- | --- |
| Locked upstream | `nightscout/cgm-remote-monitor` v15.0.7, pinned commit and archive hash verified |
| Official UI build | Webpack production bundle completed with its three known size warnings |
| Static Assets | 250 entries rebuilt, including the byte-identical official Socket.IO 4.5.4 client and one platform tenant-query adapter |
| Upstream route/test audit | 161 registrations and 111 test files; generated outputs deterministic |
| Audit tool tests | 14/14 passed |
| Direct upstream client tests | 11 locked files passed 42/42 unchanged after public/upstream bundle byte equality (`pluginbase`, renderer, error codes, utilities, Care Portal, Bolus Wizard Preview, Profile Editor, Hashauth, Admin Tools, report storage and Reports) |
| Direct upstream server/data-plugin tests | 21 locked files passed 143/143 unchanged (`dataloader`, `dbsize`, CAGE, SAGE, IAGE, timeago, AR2, treatment-to-curve, IOB, COB, OpenAPS, Pump, Basal Profile, Treatment Notify, Simple Alarms, Notifications, Admin notices, ObjectId cache compatibility, env, Mongo pool-option parsing and Express extension middleware) |
| Authorization audit tests | 6/6 passed |
| Cloudflare configuration audit | 1/1 passed; `keep_vars` true, no checked-in vars or out-of-scope products |
| Translation asset audit | 1/1 passed; all 33 JSON files valid and byte-identical to locked v15.0.7 |
| TypeScript | `tsc --noEmit` passed |
| Workers integration tests | 68 files, 749/749 passed |
| Worker dry run | 1256.42 KiB raw / 230.69 KiB gzip |
| Dry-run bindings | `ENTRY_STORE` Durable Object and `ASSETS` only |
| Deployment variables | `keep_vars` audited; a user-supplied construction credential is active but not committed or recorded here |

The locked upstream contains 111 JavaScript test files; a static declaration
audit finds 883 active `it(...)` cases plus one skipped case. The 749 Workers
tests cover the implemented adapter subset; eleven complete client files additionally
run 42/42 unchanged against the shipped official client bundle, while 21
server/data-plugin files run unchanged in a separate 143/143 gate. All 16 API3 files,
`notifications-api.test.js`, `ddata.test.js`, `bgnow.test.js`,
`direction.test.js`, `levels.test.js`, `rawbg.test.js`, `times.test.js`,
`units.test.js`, `upbat.test.js`, `data.calcdelta.test.js`,
`dataloader.test.js`, `dbsize.test.js`, `cannulaage.test.js`,
`sensorage.test.js`, `insulinage.test.js`, `timeago.test.js`, `ar2.test.js`,
`iob.test.js`, `cob.test.js`, `data.treatmenttocurve.test.js`,
`openaps.test.js`, `pump.test.js`, `basalprofileplugin.test.js`,
`treatmentnotify.test.js`, `simplealarms.test.js`, `notifications.test.js`,
`adminnotifies.test.js`, `bootevent-debounce.test.js`, `storage.shape-handling.test.js`,
`websocket.shape-handling.test.js`, `profile.test.js`,
`concurrent-writes.test.js`, `loop.test.js`, `settings.test.js`,
`sandbox.test.js`, `plugins.test.js`, `query.test.js`, `language.test.js` and
25 v1 client/API files, `pebble.test.js` and the four named server authentication files are
classified as direct `pass` or fully `adapted`; sixteen are `pass`, seven remain unresolved and two bridge files
are fixed-scope exclusions.
Neither count proves complete compatibility.

The runtime-changing local gates were followed by the remote/API/Engine.IO and
real-browser gates below against the same active version. The later widened
unchanged-client gate requires no redeployment because the shipped bundle bytes
are unchanged and rechecked first.

## Post-deployment remote API evidence

Wrangler reports version `0dd4cdd5-09d2-428e-b12e-d6d66e6905e3` as the current
deployed version.
These credential-free checks verified response content and protocol markers,
not only Wrangler command success.

| Check | Result |
| --- | --- |
| GET `/api/v3/version` | HTTP 200 with Nightscout `15.0.7`, API3 `3.0.3-alpha` and SQLite Durable Object marker |
| GET `/api/v3/entries?limit=1` without JWT | Expected HTTP 401 `Missing or bad access token or JWT` |
| GET `/api/v1/status.json` plus anonymous mutation | Status remained HTTP 200; the configured construction credential makes anonymous mutation fail closed with HTTP 401. The smoke accepts HTTP 503 only for a deliberately unconfigured deployment and verifies that neither branch persists a row. |
| GET `/api/v1/adminnotifies` on fresh tenants | Four same-region probes returned HTTP 200, public `notifyCount:1` for the readable-site warning and an empty anonymous `notifies` array. One immediate post-activation probe returned the old zero count before deployment status reached 100%; no credential or body was exposed. |
| GET `/healthz` and `/api/v1/entries.json?count=1` | HTTP 200; healthy SQLite DO marker and empty simulated-data Entries array |
| GET `/api/v1/status.json` and `/api/v2/status.json` | HTTP 200 with byte-equivalent filtered Settings snapshots: 63 JSON-visible keys, 14 enabled defaults, official title/plugin values and no secure fields or method functions |
| GET `/api/v1/treatments.json?count=1` | HTTP 200 with an empty fresh-tenant simulated-data Treatment array |
| GET `/api/v1/profile/current` | HTTP 200 with `null` for the fresh tenant |
| GET `/api/v1/food/quickpicks.json` and v2 `/food/regular.json` | HTTP 200 with empty fresh-tenant arrays; query arguments that the locked Food helpers ignore do not alter routing |
| Invalid Food/Profile children and POST `/api/v1/profiles/` | HTTP 404; plural Profile remains the locked read-only query route |
| GET `/api/v2/summary/?hours=6` | HTTP 200 with an empty SGV array, empty temp-basal/treatment/target groups, `{}` Profile and locked `null` IOB/COB fields because both plugins are disabled |
| GET `/api/v2/ddata/at` | HTTP 200 with real isolated-tenant SQLite `dataSize:299008` bytes and `indexSize:0`; the total is not double-counted |
| GET `/api/v2/properties/dbsize` | HTTP 200 with `maxSize:953.67`, `dataSize:0.29`, `display:"0%"` and `status:"current"` |
| GET `/api/v2/properties/basal` | HTTP 200 on the public simulated profile with `display:"0.100U"`, scheduled `basal:0.1` and no fabricated active treatment contribution |
| GET `/api/v2/properties/ar2` | HTTP 200 with six input-derived predicted points (`103` through `111`), average loss and `displayLine:"BG 15m: 107 mg/dl"` |
| GET `/api/v2/properties/loop` | HTTP 200 with `{}` because Loop is opt-in and the deployed `ENABLE` setting does not enable it; no synthetic property was fabricated |
| GET `/api/v2/properties/iob,cob` | HTTP 200; property presence exactly follows the deployed opt-in `ENABLE` set and both are absent by default |
| GET `/api/v2/properties/openaps,pump` | HTTP 200; property presence exactly follows the deployed opt-in `ENABLE` set and both are absent by default |
| GET `/api/v2/properties/cage,sage,iage,timeago` | HTTP 200; CAGE/SAGE/IAGE presence follows the deployed opt-in `ENABLE` set and all are absent by default, while timeago remains a client/notification plugin rather than a fabricated property |
| GET `/api/v1/status.json` Error Codes gate | The official `errorcodes` plugin remains default-enabled. The credential-free run does not inject a fake error SGV; exact information/urgent/future/clear delivery is covered by real SQLite DO tests. |
| Credentialed simulator mutation | The historical 25-entry v1 SGV batch from `simulator://nscf-demo` returned HTTP 200 and rendered the chart; all 25 exact simulator rows were later deleted because their intentionally idle timestamps triggered stale-data alarms |
| Cloudflare bodyless DELETE | An isolated tenant created one simulated SGV, deleted it with a genuinely bodyless v1 request and returned HTTP 200 with `deletedCount:1`; a follow-up read returned zero rows |
| GET/POST `/_nscf/simulated-cgm` | Public `demo` reported enabled with `intervalMs:300000`; twelve deterministic seed rows used `simulator://nscf-test`. Fresh smoke tenants remained disabled/empty. |
| Current EIO4 polling open | HTTP 200 with a 20-character SID, `upgrades:["websocket"]`, `pingInterval:25000` and `pingTimeout:20000` |
| Current EIO4 WebSocket upgrade | Real WSS completed `2probe`/`3probe`, released the pending poll with noop, accepted `5`, then returned root CONNECT and `clients` over the upgraded socket |

The latest reusable `scripts/smoke-public.mjs` run used isolated tenant
`public-smoke-1784700236170` and passed 121 behavior/CORS/protocol assertions.
It observed 299,008 SQLite bytes and the EIO4 open/upgrade sequence above while
also retaining the EIO3 client-ping/server-pong contract.

The reusable smoke itself sends no credential and confirms that anonymous
mutation fails closed. The separate simulator batch used the user-supplied
construction credential without recording it. Every checked API response carried the complete CORS policy. The
full local suite covers authenticated search, ordering, skip, projections,
limits, srvModified filters and error shapes in addition to inherited mutation
and transport contracts. Real CGM/closed-loop traffic remains outside this
acceptance run.

An earlier property-plugin increment first attempted version
`e24bfdec-233c-4dab-a462-142337b14118` (deployment
`917e2c7e-c0c6-4d79-9cc4-ac24569f00bf`). Remote smoke caught HTTP 500 on
`/api/v2/properties`; a temporary Worker tail showed that a still-live old DO
did not implement the newly added RPC. No storage corruption occurred. The
current version adds a narrowly matched rolling-upgrade fallback, and the same
old DO returned HTTP 200 immediately after redeploy. This failed intermediate
version is retained only as incident evidence and is not a rollback target.

## Post-deployment real-time evidence

This release extends schema-v14 background tasks with CAGE, SAGE, IAGE and
opt-in DBSize alongside AR2, Simple Alarms, Treatment Notify, Timeago, Pump,
OpenAPS and Loop, and retains request-local Basal Profile, IOB/COB,
Treatment-to-curve, CAGE/SAGE/IAGE/timeago, the dataloader/database-size adapter, static plugin registry,
deployment-variable preservation/configuration audit, complete request-local
Sandbox contract, Settings, Loop property
calculation, concurrent uploader, Profile, Loop client and client/server root
transport runtime. The current version repeated a fresh credential-free EIO4
polling-open check, completed a real standard WSS upgrade and retained the
locked official Socket.IO 4.5.4 polling client on both root and `/alarm`. No API secret was required for that
anonymous-readable transport check. Successful write/change delivery remains
proved by local integration contracts; the isolated bodyless-delete smoke is
an HTTP mutation contract, not a pushed-delta claim.

| Check | Result |
| --- | --- |
| Current EIO4 polling open | HTTP 200, a 20-character Engine.IO 4 SID, `upgrades:["websocket"]`, `pingInterval:25000` and `pingTimeout:20000` |
| Current EIO4 polling upgrade | Real WSS passed probe/noop/upgrade, root CONNECT and `clients`; local contracts also cover duplicate, malformed and alarm-timeout candidates |
| Current official Socket.IO client | Root connected, initial `dataUpdate` received, authorize ACK granted read, and `/alarm` subscribed with read success |
| Live database stats/property | ddata published 299,008 SQLite bytes; the default-enabled registry property returned the same total and 953.67 MiB Free-plan maximum |
| Local plugin registry contract | both named client/server cases plus order, enable/shown gates, hook/error behavior, event aggregation, iterators and settings projection |
| Direct official client contract | 11 locked client files passed 42/42 unchanged against the byte-identical shipped bundle; Care Portal/Profile Editor/Admin/Reports mutations use locked mocks rather than the public tenant |
| Local Cloudflare configuration contract | `keep_vars` is true; no plaintext vars, D1, R2, KV, Queues or custom routes are checked in; only `ENTRY_STORE` and `ASSETS` are bound |
| Local Sandbox contract | five locked client/server/LOW-HIGH/message cases plus helper-surface and request-isolation coverage |
| Local Settings contract | 13 locked defaults/accessor/feature/alarm/threshold/snooze cases plus request isolation and recursive secure filtering |
| Local Loop property contract | five locked enacted/error/received/stale-alert/assistant cases, including six forecast points and opt-in property dispatch |
| Local AR2 contract | all ten named upstream cases run unchanged plus 13 Workers-runtime cases covering exact coefficients, six-point projection, average-loss quirk, 13-step cone, warning/urgent thresholds, mmol scaling, virtual-assistant text, settings/property dispatch and stale-input handling |
| Local IOB/COB/treatment-curve contract | all 24 named upstream cases plus two DO/HTTP integrations: official source precedence/fallback/formulas/display, bounded Profile/Treatment inputs, ddata markers and enabled Summary state |
| Local OpenAPS/Pump contract | all 16 named upstream cases plus two Workers-runtime integrations: official uploader-state precedence, thresholds, offline suppression, notification requests, pill/forecast visualization, assistant responses and opt-in dispatch |
| Local Basal/Treatment-Notify contract | all eight named upstream cases plus Workers-runtime integrations: scheduled/temporary/Combo Bolus basal state, property/pill/visualization/assistant behavior, recent Treatment/MBG selection, synchronous SHA-1 hashing, automatic manual-event emit/expiry, snooze arbitration, automated-event exclusion and future activation |
| Local notification scheduler/core contract | all five named Simple Alarms and all eight named notification-processor cases plus schema-v13 persistence; fourteen schema-v14 tests cover AR2 prediction publication, Simple high/multiplex/clear, repair/retry, Treatment Notify/Timeago exact activation/expiry/clear behavior, Loop exact stale transitions, OpenAPS Offline start/end suppression, Pump exact stale transitions, CAGE exact emit/heartbeat/clear and real-SQLite DBSize publication; ten schema-v16 tests cover all nine upstream bootevent debounce behaviors plus a real 20-Profile leading/trailing integration; three focused closed-loop adapter tests cover ordering, gates and deadlines |
| Local age/timeago contract | all 17 locked CAGE/SAGE/IAGE/timeago cases, including event selection, display boundaries, notes, alert thresholds, request shapes, enable gates and environment normalization; three additional scheduler cases prove server order, exact whole-hour transitions and minute-21 clear, while Timeago proves strict threshold-plus-one-millisecond transitions |
| Prior-version anonymous-readable root authorize | exact `{read:true,write:false,write_treatment:false}` authority |
| Prior-version read-only Food `dbAdd` | exact `{result:"Not permitted"}` ACK; follow-up Food read returned no row |
| Local Treatment identity contract | 30 locked UUID flag, legacy issue-6923 and client identity cases, including MongoDB 5 delete results |
| Local Loop client upload contract | 47 locked GAP-TREAT-012, carb/dose, ObjectIdCache and SGV/DeviceStatus cases, including ordered server-ID mapping and client-cache-miss duplicate behavior |
| Local root write contract | six collections and all four events preserve locked validation/permission/ACK order, dedupe and ACK-before-delta behavior |
| Local v1 SGV root update | an authorized live polling session receives the locked root `dataUpdate`; an unauthorized session remains silent |
| Local API3 Treatment root update | root and `/storage` delivery share the successful API3 mutation path |
| Local reconstruction | schema-v11 baseline, schema-v12 write/treatment-write authority, schema-v13 notification emission state, schema-v14 background-task state and schema-v16 debounce rows survive service reconstruction; a Treatment change remains `action:update` |
| Prior `/alarm` CONNECT | independent SIO5 namespace connection returned a namespace SID |
| Prior `/alarm` anonymous web subscribe | ACK exactly `{success:true,message:"Subscribed for alarms",read:true,ack:false}` |

Local tests additionally prove the exact locked `data.calcdelta` and
`websocket.shape-handling` cases,
non-empty-only root queueing, connection/read/live filtering, collection filtering/default order, the
Settings-admin exception, persisted subscriptions across eviction, API3
create/deduplicated update/PUT/PATCH/soft/permanent delete events, v1 exclusion,
tenant/room isolation, hibernated-WebSocket delivery, broken-subscriber
containment and v8-to-v9 schema repair. The credentialed remote mutation was
limited to the named simulator SGV batch; no credentialed `/storage`, root or
`/alarm` mutation was attempted. Separate `/alarm` contracts prove native/web authorization priority,
all five event classifications, broadcast to current unsubscribed connections,
tenant isolation, no disconnected replay, exact ACK/all-clear behavior,
Urgent-to-Warning snooze, eviction/Hibernation persistence, broken-recipient
containment and idempotent v10 schema repair. HTTP v1/v2 and Socket ACK now
share that tested durable transaction. Notification-core contracts additionally
prove schema-v13 repair, emission state across reconstruction, exactly one
automatic all-clear and atomic live publication. Schema-v14 contracts
add automatic AR2/Simple/Pump/OpenAPS/Loop/CAGE/SAGE/IAGE/Treatment-Notify/Timeago/DBSize publication, single-alarm
multiplexing, activation/expiry, in-range/fresh clearing, data-preserving
partial repair, persistent retry and recovery. The
schema-v17 contracts add default-off tenant isolation, protected
enable/disable, a twelve-point seed, idempotent re-enable, root `dataUpdate`,
alarm continuation and eviction recovery. The
credential-free remote pass did not publish a trusted notification, perform
an alarm ACK or mutate a Profile Switch; the separate simulator batch exercised only v1 SGV upload.
The real DO reconstruction test covers the active-Profile push. Remote evidence does not yet prove
EIO3 WebSocket/upgrade, remaining non-Treatment preprocessing or automatic task
execution for the remaining server plugins.

## Real-browser evidence

A real browser session exercised Cloudflare version 78's official UI after the
broader version-72/73/74 page checks:

- the homepage rendered its official chart region, loaded locked
  `bundle.app.js` and displayed the live database-size pill as `0%`;
- version 74 historically preserved the stale simulated stream and saved its
  two client stale-data alarm checkboxes off; version 78 removed all 25 exact
  `simulator://nscf-demo` SGVs, preserved Profile state and loaded a clean
  `Nightscout` heading without auto-generating replacement glucose;
- after the credentialed simulator batch, the official current display showed
  `101 mg/dL`, an upward arrow, `+3`, one-minute recency and a populated chart;
- the Settings form exposed the official language selector, reported Admin
  authorized/About Nightscout 15.0.7 and completed the unchanged Save workflow;
- the official Admin-notification link remained present; four fresh-tenant API
  probes reported the readable-site count while hiding bodies from anonymous callers;
- Admin Tools and the official `clock-color` page loaded in the earlier
  version-72 pass with no captured console error;
- a new version-78 browser profile loaded
  `/socket.io/socket.io.js?7a8ec840e096` and
  `/platform/socket-tenant-adapter.js?a083f014e6e1`, completed real EIO4
  polling, logged connected/authorize/`dataUpdate`/alarm-subscribe and reported
  zero console errors or warnings;
- no real health data was used; version 80's authenticated Profile/Food/Admin
  acceptance used temporary values that were restored or deleted.
- version 79 then rendered the explicitly enabled `demo` tenant's twelve-point
  one-hour lab seed in the same unchanged official chart.
- version 86 opened a fresh official page, received root `dataUpdate` and alarm
  subscription events, displayed current simulated glucose one minute old,
  rendered two SVGs, showed no dialog and recorded zero console warnings or
  errors. Its batch-specific Treatment write/eviction/delta proof remains the
  real SQLite DO contract because the remote smoke intentionally used no
  credential.
- version 87 opened the official Food Editor and observed `Database loaded`,
  the complete record and Quick-picks controls and zero console warnings or
  errors. A separate fresh homepage showed `118 mg/dL`, `-3`, four minutes old,
  no dialog and no console issue. The expanded remote gate added exact
  Food/Profile read-only route assertions; protected Food writes remain local
  real-DO contract evidence because the page-local credential object was not
  exposed to browser automation.
- version 88 reloaded the official homepage after enabling runtime log capture,
  displayed `122 mg/dL`, `+4`, an upward trend and the populated chart, opened
  Settings/About 15.0.7 and recorded no dialog, console warning or console
  error. The public simulator remained enabled on its persisted five-minute
  schedule; remote status also confirmed Error Codes remains default-enabled.

The combined passes assert rendered DOM, official-script presence, AR2 forecast
geometry, Settings/Save acceptance and the current official transport switch.
Cloudflare version `0dd4cdd5-09d2-428e-b12e-d6d66e6905e3` reused the same
250 Static Assets entries and passed the 121-assertion credential-free remote
API/Engine.IO/WSS/Pebble gate. Version 78 retains the named official-client and
clean-browser transport acceptance; version 79 adds the displayed lab feed;
version 80 adds the authenticated Profile/Food/Admin/Reports acceptance; version
81 adds persisted push-provider contracts/callback state and the fresh-data
All Clear/browser acceptance; version 82 adds persisted active-Profile
comparison and locked `status.activeProfile` publication; version 83 adds the
opt-in locked BWP server chain and twelve-producer persisted scheduler; version
84 adds upstream-exact legacy EIO3 HTTP polling and schema-v19 protocol state;
version 85 adds the EIO4 polling-to-WebSocket upgrade and alarm-backed candidate timeout;
version 86 adds bounded Treatment-to-curve preprocessing to initial and reconstructed root updates;
version 87 restores the locked Food/Profile read routes and raw non-Treatment shapes;
version 88 adds the locked Error Codes producer as the thirteenth persisted
notification source.

This does not prove longer-running stability, a protected mutation observed
through the pushed live-update path, every plugin workflow or real closed-loop
client compatibility.

## Known limitations

- External Nightscout/MongoDB history import is not provided; users who require
  it in the new instance must not migrate to this release.
- This remains a simulated-data lab. It must not be connected to a real CGM
  uploader, pump or closed-loop client.
- API v1 and v2 remain subsets. Their inherited notification ACK, ddata helper,
  `bgnow`/`direction`/`rawbg`/`upbat` properties and core summary mapper are
  adapted. CAGE/SAGE/IAGE, IOB/COB, OpenAPS/Pump and timeago's request-local
  calculation and AR2 prediction are also adapted; ddata includes official Treatment marker
  placement and Summary receives enabled IOB/COB/BWP state. Remaining
  plugin-derived state/persistence, v2 notification-loop and other
  routes remain incomplete. API v3
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
- EIO4 polling-to-WebSocket upgrade is deployed; EIO3 direct WebSocket/upgrade,
  JSONP and binary remain missing. EIO3 HTTP polling is deployed. The main namespace
  now emits server-originated deltas from a schema-v11 persisted baseline and
  implements the locked client root write shape contract with schema-v12
  authority, persisted Profile Switch status injection and official Treatment
  marker preprocessing, but remaining non-Treatment server-plugin preprocessing and a protected pushed mutation observed in the
  official page remain incomplete. Broader Mongo/BSON
  numeric, object-ID and mixed-type behavior is not implied by the named write
  contract. `/storage` and `/alarm` currently
  support EIO3/SIO4 and EIO4/SIO5 polling plus EIO4 direct and upgraded
  WebSocket. Direct WebSocket retains
  a named at-most-once crash window between durable dequeue and `send()`.
  `/alarm` now combines its live transport/auth/ACK outlet with the internal
  core processor: inherited v1/v2 HTTP ACK and schema-v13 emission state are
  durable, and bounded upstream request arrays can feed it. Schema-v14 tasks
  evaluate AR2, Simple Alarms, Pump, OpenAPS, Loop, CAGE, SAGE, IAGE, officially
  enabled Treatment Notify, opt-in Timeago and opt-in DBSize automatically;
  remaining server notification plugins are not yet automatic, and credentialed
  remote event delivery has not been exercised.
- `document_changes` is still an unbounded full-body journal. No transport
  consumes it; `/storage` instead atomically queues bounded frames only for
  currently subscribed live sessions. Journal retention and pruning are still
  pending, and a disconnected client receives no replay (matching upstream's
  live-notification model).
- Failed-auth Admin notification emission is persisted in schema v15. Enforced
  delay has a named 60-second cap and transient Admin messages a 128-row cap.
  Repeated/bracket secret arrays are deliberately handled safely instead of
  reproducing the locked upstream unhandled rejection.
- The generic alarm-driven background scheduler is deployed in schema v14. One
  task covers AR2, Simple Alarms, Pump, OpenAPS, Loop, BWP, CAGE, SAGE, IAGE,
  enabled Treatment Notify, opt-in Timeago and opt-in DBSize. Remaining
  plugin-derived summary/activity state still needs producer/persistence adapters. Alarm ACK/silence state
  originates in schema v10 and schema v13 adds last-emission state consumed by
  the adapted core processor. Schema v16 durably coalesces rapid mutation
  triggers for that task without delaying realtime publication. API3 pruning
  and other maintenance jobs are not scheduled yet.
- Official pages are present, but not every mutation, report, plugin and
  real-time workflow has an upstream-derived browser contract.
- No medical algorithm or dosing advice was added.

See `UPSTREAM_COMPATIBILITY.md` for the evidence matrix and
`EXECUTION_PLAN.md` for the delivery order.

## Rollback

The immediately preceding known-good rollback Worker version is
`de66cb8c-f9b6-464e-8741-8aed362d7955` (version 64). It has its own remote API,
Engine.IO and browser acceptance and retains schema-v14 automatic Simple Alarms,
Treatment Notify and Timeago but lacks this release's automatic Pump/OpenAPS/
Loop scheduling. Version 63 (`c14ae3c9-b108-4fcd-9fa8-bdbd16e1dd69`) retains
automatic Simple Alarms but lacks Treatment Notify and Timeago scheduling. Version 62
(`99984670-1693-4ea1-8dfe-c2d1bf7c59f7`) lacks the schema-v14 scheduler and
automatic Simple Alarm execution. The earlier version 60
(`18757f14-fdf9-4535-81cb-d8e8ebac4430`) lacks Basal Profile/Treatment Notify.
Version 59 (`1ed7fda2-c6bc-4137-9f53-25fcc16d8f40`)
lacks Basal/Treatment Notify plus OpenAPS/Pump. Version 58
(`1e44640e-740e-4198-a40f-65482c14edd2`) additionally lacks the IOB/COB/
treatment-curve increment. Version 57
(`3a95a34d-806a-4d2b-9dff-3db1d1051b9a`) lacks the age/timeago increment as
well. Version 56 (`ea57c96b-6c3f-4cc3-bfd7-e212db8f69ba`) lacks the
dataloader/database-size adapter.
The older
failed property rollout
`e24bfdec-233c-4dab-a462-142337b14118` remains an incident record and must not
be selected as a rollback target.

Wrangler version rollback can restore Worker code and assets. Neither rollback
nor redeployment clears or rolls back SQLite Durable Object data, and rollback
must not attempt a destructive schema downgrade. Deleting the whole lab
requires deleting the Worker and then its Durable Object namespace. No
D1/R2/KV/Queue/custom-domain cleanup is needed.
