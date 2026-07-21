# NSCF — Nightscout for Cloudflare

NSCF is a public-interest, open-source, independent and unofficial downstream port of
[Nightscout](https://github.com/nightscout/cgm-remote-monitor) for Cloudflare.
It is not an official Nightscout release and is not endorsed by or affiliated
with the Nightscout Foundation. Sugar AI may provide initiator or maintenance
support, but NSCF does not depend on or require Sugar AI.

This repository is an active, incomplete Cloudflare port. It directly builds
and serves the official Nightscout v15.0.7 homepage, charts, client plugins and
translations; NSCF does not provide a redesigned or substitute UI. The complete
Node/Mongo/Socket.IO/server-plugin behavior is not yet compatible. It uses
simulated glucose values only. It is not a medical device and must not be used
for diagnosis, dosing, or medical decisions.

## What is implemented

- A TypeScript Cloudflare Worker on `workers.dev`.
- One SQLite-backed Durable Object class, sharded one instance per tenant.
- A tested subset of Nightscout entries, food, profile, treatments,
  device-status, activity, roles, subjects, status, authorization and
  page-data endpoints. The v1/v2 Status surface now follows the locked
  routing, negotiation, redirect, format, authorization and error contracts.
- A substantial but still partial v1/v2 Entries uploader/read slice: ordered
  batch prefix commits, single-object/array/extended-urlencoded shapes,
  server-owned ID normalization with non-ObjectId uploader IDs preserved as
  `identifier`, bounded numeric/string filters and request sorting,
  current/model/ID reads, JSON/plain/CSV/TSV representations, weak ETags,
  result/runtime-SGV Last-Modified/conditional 304 and HEAD. The Entries
  `echo` query debugger is adapted for the supported filter subset, and
  `count/{entries,treatments,devicestatus}/where` performs a server-side SQLite
  aggregate without materializing matching documents. HTML-like upload leaves
  are recursively and idempotently entity-encoded before preview or
  persistence; this safe Workers adaptation is stricter than the locked
  JSDOM/DOMPurify output.
- Complete named Workers-runtime mappings for the locked legacy uploader edge
  files `api.deduplication.test.js`, `api.entries.uuid.test.js` and
  `api.partial-failures.test.js`. The SQLite uniqueness selectors match the
  upstream collection rules rather than inventing broad `pump`/`sync`/`id`
  indexes. Legacy v1/v2 DeviceStatus uploads also preserve the official
  prediction trimming contract: only IOB/COB/UAM/ZT prediction arrays under
  `suggested` or `enacted` are limited to 288 values by default; a positive
  `PREDICTIONS_MAX_SIZE` changes the limit and `0` disables this trimming.
- Tenant-local, SQLite-persisted HS256 JWT signing, the upstream eight-hour
  authorization-token lifetime, derived subject access tokens and prefix
  matching, body/query/header credential precedence, persisted per-IP failure
  delay, locked `shiro-trie` permission matching and corrected `verifyauth`
  behavior. The enforced delay is deliberately capped at 60 seconds; failed
  authentication does not yet generate the upstream admin notification.
- The public API v3 version envelope, JWT-protected status endpoint and all six
  official generic collection verticals: entries, treatments, device status,
  profile, food and settings. Each has collection search/create, resource
  read/replace/patch/delete, both history forms and collection-aware
  `lastModified` in the locked JSON, CSV and XML formats. The locked Settings
  exception is retained: collection search and history require admin while a
  single-resource read uses read permission. The HTTP boundary now preserves
  Express-style implicit HEAD behavior, exposes the complete upstream API CORS
  method/header preflight, and accepts a lower `API3_MAX_LIMIT` while retaining
  a hard 1,000-row Workers Free ceiling.
- A shared SQLite repository for all six generic collections, covering
  legacy/API3 identity, collection-specific fallback dedupe, ordered search,
  branch-sensitive mutation permissions, server timestamps,
  tombstones/history and atomic change snapshots. V1 Food writes use the same
  repository and history as API v3; Settings deliberately has no legacy
  fallback identity.
- The locked v1 Treatments `preBolus` create behavior, inherited unchanged by
  v2: every truthy normalized `preBolus` creates the official time-shifted
  child; truthy carbs move off the primary, while a missing/zero carbs value
  retains upstream's empty-string child field. PUT remains the upstream
  one-record save path. Both POST records are committed in one SQLite
  transaction and retransmissions deduplicate both fallback identities.
- The complete locked Treatment identity files `uuid-handling.test.js`,
  `issue-6923-legacy-uuid.test.js` and `identity-matrix.test.js`.
  `UUID_HANDLING` keeps upstream's exact true-by-default `on/true/off/false`
  parsing. Enabled mode promotes non-ObjectId uploader IDs and resolves both
  modern `identifier` rows and pre-fix raw UUID `_id` rows; disabled mode
  strips the uploader ID without promotion and uses raw-ID lookup only. Legacy
  PUT updates a raw UUID row in place. Treatment deletes return the MongoDB
  5.9 response shape `{acknowledged,deletedCount}`.
- The complete locked Loop client files `gap-treat-012.test.js`,
  `carb-dose-upload.test.js`, `objectid-cache.test.js` and
  `sgv-devicestatus.test.js`, represented by 47 named Workers-runtime
  contracts. Loop override UUID promotion/update/delete, carb and dose
  ObjectId-cache workflows, ordered upload responses, SGV direction/device
  payloads and nested Loop/pump DeviceStatus values are preserved.
  `syncIdentifier` remains descriptive rather than an invented uniqueness
  index: a cache miss with a new timestamp can create the same duplicate that
  makes Loop's client-side ObjectId cache necessary.
- The complete 24-assertion `profile.test.js` calculation contract. Legacy and
  store-based profiles now share the locked DIA, carb absorption, carb ratio,
  sensitivity, target, basal schedule, units, IANA-timezone and historical
  profile-selection rules. The Workers adapter replaces only Node-specific
  lodash/memory-cache/moment-timezone mechanics with native arrays, `Map` and
  `Intl`, and the API v2 Summary path uses this adapter.
- The complete 13-case `concurrent-writes.test.js` uploader contract. Five-way
  scalar and batch writes across Treatments, DeviceStatus and Entries retain
  every response/document; generated ObjectIds stay unique; 50 AAPS SMB, 100
  AndroidAPS SGV and 30 cross-collection offline-recovery requests complete
  through one tenant SQLite Durable Object without loss.
- The complete five-case `loop.test.js` plugin contract. Enabled Loop device
  status now feeds `/api/v2/properties` with the official enacted/error state,
  forecast and stale-status calculation. This displays uploader-provided Loop
  results; it does not calculate insulin doses or add medical advice.
- The complete locked `cannulaage.test.js`, `sensorage.test.js`,
  `insulinage.test.js` and `timeago.test.js` contracts. Opt-in CAGE, SAGE and
  IAGE properties use the latest non-future matching Treatment and preserve
  the official pills, thresholds, notes and environment normalization.
  Timeago keeps the unchanged official client behavior and has a request-local
  server request/display adapter. The schema-v14 durable task runner now
  evaluates Simple Alarms and opt-in Timeago alerts automatically. Automatic
  CAGE/SAGE/IAGE evaluation remains a later task kind.
- The official Nightscout v15.0.7 homepage, Admin Tools, Profile Editor, Food
  Editor, Reporting, multiframe view, clock faces and Swagger pages, built from
  the unmodified source snapshot in `vendor/nightscout`.
- A transport-only polling shim for the upstream client's Socket.IO surface;
  it loads one aggregate data payload and emits the upstream `dataUpdate`.
- A separately routed, tenant-local `/socket.io/` server slice for strict EIO4
  HTTP polling and the SIO5 root namespace. Sessions, heartbeat state,
  read/write/treatment-write authorization state and bounded outbound queues
  persist in the existing `EntryStore` SQLite Durable Object across eviction.
  The locked client-originated `dbAdd`, `dbUpdate`, `dbUpdateUnset` and
  `dbRemove` contracts are implemented for treatments, entries, device status,
  profile, food and activity, including exact ACK/error ordering, upstream
  treatment/device/AAPS-profile dedupe behavior and ACK-before-`dataUpdate`
  delivery. Writes remain bounded to 100 documents per event.
- A direct EIO4 WebSocket transport accepted by the same Durable Object through
  WebSocket Hibernation. It persists protocol authority in SQLite and restores
  tagged socket attachments after eviction. It does not implement an
  Engine.IO polling-to-WebSocket upgrade; clients open the direct transport.
- The API v3 `/storage` Socket.IO namespace on those EIO4/SIO5 transports.
  Subject access-token authorization, the official six-collection default
  order, per-collection rooms, the Settings-admin exception and subscription
  state persist in SQLite. API v3 create/upsert/PUT/PATCH/soft-delete/permanent-
  delete events use the official `create`, `update` and `delete` payloads;
  changes made through v1 are deliberately not broadcast, as upstream specifies.
- The API v3 `/alarm` Socket.IO namespace on both current EIO4 transports.
  It can connect independently, preserves the locked native-access-token and
  web secret/JWT/anonymous subscription branches and ACK shapes, persists
  ACK/silence authority across Durable Object eviction, and exposes a trusted
  tenant-local outlet that classifies the official `clear_alarm`, `alarm`,
  `urgent_alarm`, `announcement` and `notification` events. ACKs broadcast the
  locked all-clear payload, including Urgent-to-Warning snooze behavior. The
  official notification arbitration core now consumes bounded request and
  snooze arrays, persists emit/silence state and publishes its selected object
  through this outlet in one SQLite transaction. One persisted
  `plugin-notifications` task now evaluates Simple Alarms, Pump, OpenAPS, Loop,
  Treatment Notify and Timeago in official server order. Pump, OpenAPS and Loop
  retain their official plugin-enable plus `*_ENABLE_ALERTS` gates; Treatment
  Notify retains its plugin-enable gate, and Timeago additionally requires
  truthy `TIMEAGO_ENABLE_ALERTS`. The public upstream-default configuration
  leaves all five opt-in alert branches dormant.
- The official GET `/api/v1/notifications/ack` route and its inherited v2
  mount. Both require `notifications:*:ack`, return Express's exact `200 OK`
  text body, and use the same SQLite ACK/clear transaction as Socket.IO.
  Repeated ACKs remain suppressed across eviction; malformed authenticated
  requests are bounded 200 no-ops rather than unbounded tenant state.
- The v2 `/ddata/at` adapter plus the complete named `ddata.test.js` contract:
  every official data bucket, deep cloning, runtime time/duration derivation
  and prefer-new `_id`/`identifier` merging are represented. The v2
  `/properties` route now supports upstream comma-selection and truthy
  `pretty` formatting. Its `bgnow`, four five-minute `buckets`, interpolated
  `delta`, mmol rounding and current `direction` values are direct stateless
  ports of the locked official property plugins, with complete named coverage
  for `bgnow.test.js` and `direction.test.js`. The locked `times`, `units` and
  `levels` foundations plus `rawbg` and `upbat` plugins are also adapted:
  default-enabled `upbat` is live in `/properties`, while `rawbg` follows the
  official enabled-plugin gate and can be added through the compatible
  `ENABLE` setting. The opt-in `loop` property now uses the locked Loop status,
  pill, six-point forecast, failure/received flag, stale-status level and
  virtual-assistant calculations. Its notification request now also runs
  automatically through the persisted scheduler when the official Loop alert
  gates enable it.
  Property reads use the bounded SGV/calibration/device-status/Treatment/Profile
  DO projection, with an exact rolling-deploy fallback for an older live DO
  isolate. Official opt-in IOB/COB calculations now execute through the same
  dispatcher. `/api/v2/summary/` ports the locked SGV, treatment,
  temporary-target, temp-basal and current-profile mapping and receives enabled
  registry properties; IOB/COB remain `null` when disabled. BWP and other
  unported plugin state are not invented.
- A tenant-local Durable Object alarm derived from persisted realtime
  deadlines, authorization-delay cleanup and schema-v14 background tasks. It
  survives eviction and drives
  server ping, pong timeout, session expiry, bounded WebSocket closure retry,
  abandoned poll/POST lease cleanup, stale authorization-failure cleanup and
  automatic Simple Alarm, Pump, OpenAPS, Loop, Treatment Notify and Timeago
  re-evaluation without
  relying on a process-lifetime `setInterval`. Mutations evaluate the leading
  edge inside their originating request; no future deadline is retained when
  all six enabled producers are inactive.
- Tested official EIO4/SIO5 and legacy EIO3/SIO4 packet codecs. Only EIO4
  polling and direct WebSocket are routed: polling advertises `upgrades: []`,
  EIO3 and binary packets are rejected, and polling-to-WebSocket upgrade is not
  implemented.
- Content-addressed loading for that platform shim, so an older upstream
  service worker cannot keep serving an obsolete adapter after deployment.
- A response-header adapter that preserves upstream asset bytes while supplying
  the UTF-8 charset normally added by Nightscout's Express server. The Split
  route also overrides Cloudflare's incorrect `text/plain` metadata, strips
  stale conditional validators and returns `no-store`, so an old cached
  source view is replaced by the official HTML without changing its bytes.
- Workers-runtime tests plus real-browser verification for API, SQLite,
  persistence, isolation and official-page rendering.
- No D1, R2, KV, Queues, custom domain or CGM credentials.

## What is not complete

This is not yet a drop-in Nightscout server. Important missing work includes
the complete v1/v2 route and error surface, large-response CSV/XML resource
adaptation and broader generic API v3 mixed-type/nested/query parity,
failed-auth admin notifications, Mongo query/collection parity beyond the
tested safe subset, Engine.IO polling-to-WebSocket upgrade, EIO3 HTTP transport,
the direct-WebSocket at-most-once crash window, profile-switch/plugin
preprocessing on root updates, remaining background-task kinds, general server
plugin execution, automatic CAGE/SAGE/IAGE/BWP/DBSize/admin
notification generation, external push providers, plugin-derived v2 summary
state/persistence, and end-to-end verification of every official page workflow.
The polling shim only keeps the official browser bundle supplied
with aggregate REST data; it does not use the new EIO4 endpoint. Switching the
homepage to the official Socket.IO client is a later slice that also requires
safe non-default tenant propagation and integration with the still-missing
server-side notification/plugin pipeline.
Entries also remains incomplete beyond its now-adapted locked test file:
`times/echo`, `times` and dateString `slice` support only the bounded numeric-
brace fixtures, while non-Entries `echo`, client-supplied count aggregation
pipelines, arbitrary regex/slice fields, Mongo operators, nested/array/mixed-
type behavior and collation extend beyond the fail-closed subset. Treatment
safe attributes are stripped, so the Workers sanitizer is not generally byte-
equivalent to upstream DOMPurify. The 512 KiB body, 100-item batch, eight-prefix,
256-expansion and 10,000-row result/candidate bounds are explicit Free-plan
controls rather than upstream limits. Server-side `count` is not subject to the 10,000-row result
limit, but retrieving the matching records still requires bounded date ranges.
The adapter still materializes a selected
Entries response before sorting, formatting and hashing it; an artificial
request for thousands of records containing abnormally large custom fields can
therefore approach the Workers Free CPU/memory boundary. Ordinary compact SGV
rows and normal recent-data clients are not expected to do so. A total-response
budget or streaming redesign is explicitly deferred rather than presented as
solved.

The evidence-based compatibility matrix and acceptance criteria are in
[`docs/UPSTREAM_COMPATIBILITY.md`](docs/UPSTREAM_COMPATIBILITY.md). The storage
and UI flow are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Intended one-click setup

The first release is intended only for families starting a fresh NSCF
deployment. It does not provide an importer for an existing
Nightscout/MongoDB database or years of historical data. A family that needs
that history to remain available in the new instance should keep its existing
Nightscout deployment and should not switch to NSCF yet.

The release deployment flow has one user-facing setting:

> Set a family access password (at least 12 characters), then enter the same
> password in the phone's Nightscout data-source settings.

The planned Deploy to Cloudflare flow will obtain this value from the
human-readable binding description in `package.json`, without asking a family
to calculate a hash. That one-click flow has not yet passed end-to-end release
testing; current operators still use Wrangler or the Cloudflare dashboard as
documented below. The internal binding remains `API_SECRET` for Nightscout
compatibility.

## Local setup

Requires Node.js and npm. Node 22 LTS or newer is recommended.

```sh
npm install
npm run upstream:install
npm run build
npm run check
npm test
npm run dev
```

Open `http://localhost:8787/`. The page is the upstream Nightscout homepage,
not an NSCF-designed frontend. Local Durable Object state is maintained by
Wrangler under `.wrangler/` and ignored by Git.

Before starting Wrangler, create an ignored `.dev.vars` file containing a
Nightscout API secret of at least 12 characters:

```dotenv
API_SECRET=replace-with-your-own-long-passphrase
```

Insert simulated data:

```sh
export NSCF_API_SECRET='replace-with-the-same-long-passphrase'
NSCF_API_HASH=$(node -p "require('crypto').createHash('sha1').update(process.env.NSCF_API_SECRET).digest('hex')")
NSCF_NOW_MS=$(node -p 'Date.now()')
curl -X POST http://localhost:8787/api/v1/entries \
  -H 'Content-Type: application/json' \
  -H "api-secret: ${NSCF_API_HASH}" \
  --data "{\"sgv\":123,\"date\":${NSCF_NOW_MS},\"direction\":\"Flat\",\"device\":\"simulator\"}"
```

Read it back:

```sh
curl 'http://localhost:8787/api/v1/entries.json?count=10&tenant=demo'
```

Tenant names are lowercase letters/numbers followed by up to 63 lowercase
letters, numbers, `_` or `-`. The selector provides storage isolation only; it
is not access control.

## Current code security boundary

The public deployment is a simulated-data lab, not a personal Nightscout
deployment. The contracts described below are live in the current Cloudflare
version, but they remain only a tested compatibility subset.
Current v1/v2 writes require a Nightscout-compatible API-secret digest or an
authorized subject credential; API v3 operations for all six official generic
collections require a Bearer JWT.
The tenant selector provides storage routing, not authorization. Missing or
shorter-than-12-character `API_SECRET` configuration
fails closed with HTTP 503 for API-secret writes. A request must carry the
SHA-1 or SHA-512 hexadecimal digest in `api-secret` (or `?secret=`); the raw
passphrase is deliberately rejected on the wire. A subject's
API-secret/ObjectId-derived access token can obtain an eight-hour HS256 JWT from
`/api/v2/authorization/request/<token>`; Bearer authorization verifies the
signature and expiry, then re-reads the subject and roles from that tenant's
SQLite Durable Object. Each tenant has a separate random signing key that
survives DO eviction and is never returned. Query, header and first-body-object
credentials follow the locked extraction order, and failed explicit
credentials participate in a persisted per-IP delay list shared with the DO's
single alarm. Repeated or bracket-form `secret` arrays are a deliberate
hardening difference: locked v15.0.7 passes them to a scalar-only API-key check
and the request does not complete normally; NSCF never treats an array as the
admin secret, tries its bounded values as subject credentials in order, and
returns 401 plus a recorded failure when none match. Other explicit differences
are the 60-second Workers cap on enforced delay and the missing upstream
failed-auth admin notification. The root adapter dependency audit is clean,
while `npm ci` for the locked upstream
v15.0.7 tree currently reports 66 inherited findings (9 low, 18 moderate, 37
high, 2 critical). They are recorded rather than silently changed because
`npm audit fix` would mutate the official release dependency graph.

The routed EIO4 root namespace is read-only even when a credential could grant
HTTP writes: its authorization ACK is always `{read:true, write:false,
write_treatment:false}`. Anonymous reads follow the current readable default;
invalid explicit credentials disconnect only the root namespace without
closing the Engine.IO SID. This narrow transport surface does not authorize any
database mutation event. The separate `/storage` namespace accepts only a
subject access token, joins only rooms for which that subject has the locked
read permission (`api:settings:admin` for Settings), and emits notifications
about successful HTTP API v3 mutations; it does not grant mutation permission.
The separate `/alarm` namespace follows the locked native access-token and web
secret/JWT/anonymous subscription branches. Web subscriptions report separate
`read` and notification-ACK rights; native subject access tokens retain the
upstream ACK behavior regardless of roles. ACK permission only persists an
alarm-group snooze and broadcasts the locked all-clear event; it cannot mutate
medical records. Alarm groups are bounded to 256 distinct names of at most 256
characters, and disconnected clients receive no replay.

## Configure API_SECRET on Cloudflare

Open **Workers & Pages → `nscf-phase1` → Settings → Variables and Secrets**,
click **Add**, select **Secret** rather than a plaintext variable, name it
exactly `API_SECRET`, enter a passphrase of at least 12 characters, then
save/deploy. Its value is the raw passphrase. A compatible Nightscout uploader
normally asks for that same raw passphrase and hashes it before sending. The
CLI equivalent is `npx wrangler secret put API_SECRET`; Worker code still
receives it as `env.API_SECRET`, while Wrangler and the dashboard no longer
show the value. This follows Cloudflare's current guidance to use encrypted
[Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
for passwords and API tokens. A plaintext `API_SECRET` should be rotated and
replaced with a Secret before any non-lab use.

`wrangler.jsonc` sets `keep_vars: true` because a family may initially use the
dashboard setup flow. Cloudflare documents that ordinary dashboard variables
are otherwise overwritten by the next Wrangler deployment, while encrypted
Secrets are not deleted by ordinary deploys. This protection preserves an
already configured value; it does not create, recover or print one. The current
acceptance pass did not inspect the public lab's credential inventory or value;
an operator-managed value must be kept outside the repository. See the official
[Wrangler configuration reference](https://developers.cloudflare.com/workers/wrangler/configuration/#top-level-only-keys).

Do not put a real value in `wrangler.jsonc`, commit `.dev.vars`, or paste it
into an issue. Most current GET endpoints remain publicly readable. API v3
`/status`, `/lastModified` and every generic collection operation (entries,
treatments, device status, profile, food and settings) require a valid Bearer
JWT.

If Nightscout says `Wrong API secret`, verify that the Worker setting has no
leading/trailing spaces, save it, wait for the deployment to finish, then enter
that exact raw passphrase in Nightscout. A direct API client normally sends its
SHA-1/SHA-512 digest; the official web authentication dialog performs the
conversion for the user.

## Upstream source policy

`upstream/manifest.json` pins official release `v15.0.7`, full commit
`7e0e77f88fc113a76fe363504125f5b36b8a3fe3`, archive URL and SHA-256.
`vendor/nightscout` is an unmodified snapshot. Cloudflare-specific work stays in
`src/`, `platform/`, and `scripts/`; future unavoidable upstream changes belong
in the explicit `patches/nightscout` queue.

The deployed Nightscout UI and status contract contain no NSCF branding or
downstream version suffix. Project identity, attribution and the unofficial
downstream disclaimer live only in repository documentation.

## Test and deploy

```sh
npm run build
npm run check
npm test
npm run deploy:dry
npm run deploy
```

`wrangler.jsonc` creates only Worker `nscf-phase1`, its Workers Static Assets,
and the `EntryStore` SQLite Durable Object namespace. Its checked-in
`keep_vars` setting makes the former `--keep-vars` command-line flag redundant.
A normal Wrangler deploy
requires an authenticated Cloudflare session and a verified Cloudflare account
email.

The automated Workers-runtime suite covers the shipped page routes, dynamic
clock template, polling-adapter
asset/version contracts, strict v1/v2 Status and page-data contracts,
API-secret failure modes, derived/body credentials and persisted failure delay,
the implemented Entries uploader/query/read representations and document CRUD
subset, including ordered partial batch failure, recursive upload sanitization,
preview, numeric filter coercion, sort-before-limit, conditional GET/HEAD and
v2 inheritance. The v1 collection contracts now also cover Activity, Food,
Profile and DeviceStatus batch/empty-array handling, locked ObjectId validation
and error envelopes, Food missing-ID save creation, DeviceStatus timezone
normalization, wildcard-delete filtering and locked mutation response shapes,
plus cross-collection scalar/array handling and NightscoutKit-compatible writes.
The suite also covers JWT issue/verify/expiry/tamper/cross-tenant behavior, Shiro permission
matching, `verifyauth`, and the API v3 version/status envelopes. It also covers
fresh-only Entries schema repair, v1/API3 identity and time separation across
entries, treatments, device status, profile, food and settings; UUID/ObjectId
query handling, API3
materialization and rollback, safe regular-expression compilation,
JSON/CSV/XML workflows for all six official generic collections, and the
EIO4 polling/direct-Hibernatable-WebSocket boundary: packet ordering, root
authorization, alarm-driven heartbeat/expiry, eviction, overlap,
body/session/queue caps, cursor-bounded initial/retro snapshots,
byte/node/document truncation, removal of the fixed 100-status cutoff,
deterministic older-tail truncation and cross-tenant session rejection. It now
also covers `/storage` namespace connection, access-token/room authorization,
persisted subscriptions, API3-only create/update/delete delivery, collection
and tenant isolation, hibernated WebSocket delivery, broken-subscriber
containment and v8-to-v9 schema repair. `/alarm` coverage locks independent
namespace connection, all native/web subscription branches, exact ACKs, all
five event classifications, live-only tenant isolation, persisted snooze and
Hibernatable-WebSocket eviction behavior, broken-recipient containment and
idempotent v10 schema repair. The notification-core coverage additionally locks
all eight named upstream processor cases, schema-v13 repair, emission state
across reconstruction, exactly one automatic all-clear and atomic live
publication when invoked. The inherited v1/v2 notification ACK coverage
also locks HTTP authorization, exact response bytes, shared clear broadcasts,
Urgent-to-Warning state, repeated suppression, malformed-input bounds and
broken-recipient isolation. The
locked upstream has 111 JavaScript test files; a static declaration audit finds
883 active `it(...)` cases plus one skipped case. Those declarations are not
directly comparable with the adapter suite and do not prove complete Nightscout
compatibility. All 16 locked `api3.*` files, `notifications-api.test.js`,
`ddata.test.js`, `bgnow.test.js`, `direction.test.js`, `levels.test.js`,
`rawbg.test.js`, `times.test.js`, `units.test.js`, `upbat.test.js`,
`data.calcdelta.test.js`, `dataloader.test.js`, `dbsize.test.js`,
`cannulaage.test.js`, `sensorage.test.js`, `insulinage.test.js`,
`timeago.test.js`, `iob.test.js`, `cob.test.js` and
`data.treatmenttocurve.test.js`, `openaps.test.js`, `pump.test.js`,
`basalprofileplugin.test.js`, `treatmentnotify.test.js`,
`simplealarms.test.js`, `notifications.test.js`,
`websocket.shape-handling.test.js`,
`profile.test.js`, `concurrent-writes.test.js`, `loop.test.js`,
`settings.test.js`, `sandbox.test.js`, `plugins.test.js`, `query.test.js`,
`language.test.js` and 25 v1 client/API
files are classified as fully `adapted`. Seven complete locked client files
(`pluginbase.test.js`, `client.renderer.test.js`, `errorcodes.test.js`,
`utils.test.js`, `careportal.test.js`, `boluswizardpreview.test.js` and
`profileeditor.test.js`) run unchanged for 30/30 tests against the
byte-identical official client bundle and are classified as `pass`.
The latest two complete upstream additions are `query.test.js` and
`language.test.js`. The preceding two are `simplealarms.test.js` and
`notifications.test.js`; the preceding two are `basalprofileplugin.test.js`
and `treatmentnotify.test.js`; the preceding two are `openaps.test.js` and
`pump.test.js`; the preceding three are `iob.test.js`, `cob.test.js` and
`data.treatmenttocurve.test.js`. The preceding four
plugin additions are `cannulaage.test.js`, `sensorage.test.js`,
`insulinage.test.js` and `timeago.test.js`. The preceding four v1 additions
are `gap-treat-012.test.js`,
`carb-dose-upload.test.js`, `objectid-cache.test.js` and
`sgv-devicestatus.test.js`; the preceding three are `uuid-handling.test.js`,
`issue-6923-legacy-uuid.test.js` and `identity-matrix.test.js`.
The prior eight v1 additions are
`api.aaps-client.test.js`, `api.alexa.test.js`, `api.entries.test.js`,
`api.root.test.js`, `api.status.test.js`, `api.treatments.test.js`,
`api.unauthorized.test.js` and `api.v1-batch-operations.test.js`; 27 files remain
unresolved and two real-CGM bridge files are fixed-scope exclusions.

The deployed runtime candidate is commit
`f0d442ca79fce67c2a2a118b9944ee5c2738f426`. The 58-file Workers-runtime
suite passes 652/652 tests, the four audit suites pass 22/22, seven complete
official client files pass 30/30 unchanged, and fifteen locked server/data-plugin
files pass 90/90 unchanged. Wrangler dry-run reads the same
248 official assets, reports 1154.98 KiB raw / 213.27 KiB gzip and exposes only
`ENTRY_STORE` and `ASSETS`.
This increment adds a request-local Worker-safe port of the locked query
defaults, walker, date and ObjectId/UUID normalization surface; live Entries
parsing reuses its four-day boundary and ObjectId normalization before bounded
SQLite execution. It also adds the locked server language surface without
bundling 1.5 MiB of dictionaries into the Worker: localization is fetched from
Workers Static Assets, all 33 JSON files are audited as valid and byte-identical
to v15.0.7, `LANGUAGE` reaches HTTP/Socket settings, and the default Sandbox
uses the same request-local translator.
This runtime connects a single `plugin-notifications` SQLite task to the locked
official Simple Alarms, Pump, OpenAPS, Loop, Treatment Notify and Timeago
calculations and the core notification processor. The engine evaluates the six
producers in official server order from one bounded context, arbitrates requests and snoozes in one
transaction, atomically publishes the selected live `/alarm` frame, and stores
the next exact logical deadline. Simple Alarms preserves strict high/low
thresholds and ten-minute SGV expiry. Treatment Notify preserves its strict
ten-minute window, manual/automatic filtering, snooze rules and synchronous
upstream SHA-1 `notifyhash`. Timeago preserves strict `>` warning/urgent
boundaries by waking one millisecond after the threshold. Pump, OpenAPS and Loop
preserve strict warn/urgent threshold-plus-one-millisecond transitions, source
expiration and future DeviceStatus activation. OpenAPS Offline begins at its
future marker time, suppresses Pump/OpenAPS deadlines while active and ends one
millisecond after its inclusive expiry; Pump quiet-night low-battery mode wakes
at the next exact profile-timezone boundary rather than polling each minute.
Future SGVs and eligible manual Treatments retain their exact activation
deadline; active notifications repeat at the configured heartbeat and clear
after expiry or a fresh in-range mutation. The bounded context contains at most
64 SGVs, ten MBGs, 1,000 matching current DeviceStatus rows plus the earliest
future matching row, the latest Profile and the newest 1,000 Treatments within
the existing time window and shared response budget. The task runs only through
the official enable gates. Task failures persist a
two-second exponential retry capped at five minutes. A 15-second to 24-hour
heartbeat bound is an explicit Workers Free hardening difference. The adapter
is internal, not a public processing API or an external push provider.
Basal is enabled by the official default feature set
and calculates the current scheduled basal plus active Temp Basal and Combo
Bolus treatment contributions from the current Profile; it exposes the locked
pill, visualization and assistant response without recommending a dose.
Treatment Notify preserves the upstream ten-minute selection window, manual
versus automatic filtering, auto-snooze payloads, calibration/treatment/
temporary-target/announcement classification and SHA-1 deduplication hash.
When officially enabled, mutations and the persisted task now feed that request
and snooze into the same processor automatically. Pump, OpenAPS and Loop use the
same task and processor under their official alert gates. No external delivery
provider is connected.
The runtime retains the preceding official IOB and COB formula adapters. They
keep OpenAPS, Loop and pump DeviceStatus precedence, Treatment
fallback, Profile/DIA/sensitivity/carb-ratio inputs, official recency and
rounding behavior, and now feed enabled IOB/COB into API v2 Summary. The
Durable Object projects the official 2.5-day ordinary-Treatment window, the
latest zero-duration Profile Switch from one year, the latest current Profile
and the existing 62-day age events; ordinary Treatments are capped at the
newest 1,000 under the existing Workers Free response budget. API v2 ddata now
also applies the locked treatment-to-glucose-curve marker placement, including
explicit units and raw-BG fallback. These are official calculations and display
placement only; NSCF adds no dose recommendation.
The prior age/timeago and database-size adapters remain. Timeago warning and
urgent alerts are now automatically scheduled when the locked setting enables
them; CAGE/SAGE/IAGE remain request-local. Ddata continues to publish the
Durable Object's real SQLite file size and the official `dbsize` calculation
consumes it without double-counting indexes. Its platform maximum defaults to the documented
Workers Free one-GB per-object ceiling expressed as 953.67 MiB; the official
[`databaseSize` API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
and [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
are the sources for that adapter. The release retains the complete five-case Sandbox adapter, 13-case Settings
adapter, five-case Loop plugin, concurrent uploader and
Profile calculation contracts, four Loop client files and three Treatment identity contracts,
exact `UUID_HANDLING` behavior, legacy raw-UUID repair and the MongoDB 5
delete-result shape. It retains the legacy uploader edge and
DeviceStatus prediction adapters, schema-v12 root-write authority, schema-v13
notification emit state, server-originated deltas,
the prior property, API, authorization, `/storage` and `/alarm` slices.
This does not make the whole Nightscout port or the complete v1/v2 API
compatible.
The Sandbox reuses the locked Profile, units and times adapters instead of Node
dynamic `require` or module-global state. The static registry likewise replaces
Node plugin `require` without fabricating the 27 unresolved plugin/test
algorithms. The manifest records seven direct passes, 75 adapted, 27 unresolved
and two fixed-scope exclusions. The deployed configuration also retains
Wrangler `keep_vars`, so dashboard-managed plaintext
variables are preserved instead of being overwritten by a code deployment.
Its Node configuration audit rejects stored plaintext vars and prohibited
D1/R2/KV/Queues/routes while locking the existing footprint.
Non-Entries echo, arbitrary aggregation pipelines, unrestricted Mongo mixed-
type/nested/array and BSON numeric/object-ID semantics, safe-attribute DOMPurify
byte parity, EIO3, polling-to-WebSocket upgrade and the server-side
remaining plugin evaluators/task kinds, including realtime profile-switch preprocessing,
remaining BWP/plugin-derived summary fields and their persistence, remain
missing. No deployed
credential was read or supplied to remote smoke requests, and no credential
value is stored or quoted in this repository.
Entries migration remains intentionally
fresh-only: an incompatible pre-1.0 narrow `entries` shadow is reset instead of
being imported, while canonical documents and other collections such as
profile are preserved. A read-only check found zero Entries and one profile in
the public tenant, and post-deployment reads preserved those counts without
recording profile contents. This is not a general legacy-data migration
guarantee.

The planned first-release onboarding path is a fresh deployment for a new
family. “Fresh” means a new Worker/SQLite Durable Object namespace or an
otherwise empty NSCF tenant. External Nightscout/MongoDB history import is not
included in the first release. A family that needs that history in the new
instance should not switch yet. Redeploying code to the same Worker updates
Worker code and Static Assets but does not erase or replace the existing
Durable Object namespace; the current public lab's preserved profile therefore
remains across this release. NSCF-internal schema upgrades are a separate
release requirement and must preserve data covered by supported NSCF schema
contracts. A truly empty reset requires a new namespace or an explicitly
destructive delete. This is still a simulated-data development release: it
must not receive real uploader, CGM, pump or closed-loop traffic.

The current simulated-data lab is deployed at
<https://nscf-phase1.nscf-lab-20260717.workers.dev/>. It is intentionally
limited and must not receive real health data. Deployment resources, remote
smoke evidence and rollback details are documented in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

Cloudflare version `1841cdc5-b06b-4ab4-94f1-742bef1e4e24` (ordinal 66) was made
current by deployment `35700469-468c-499b-8c6f-91c6a81b5290` at
`2026-07-21T19:45:24.998Z`; the version was created at
`2026-07-21T19:45:23.975Z`, with a reported 31 ms startup. No asset bytes needed
uploading because all 248 official asset entries were unchanged.
Credential-free remote smoke returned HTTP 200 for health, bounded v1 Entries
and Treatments reads, a fresh-tenant current Profile and v2 Summary, API3
version, matching v1/v2 Settings snapshots, real ddata/database-size values,
the default-enabled `dbsize` and Basal properties, opt-in-disabled Loop, IOB/COB,
OpenAPS/Pump and age
properties, null disabled IOB/COB Summary state, and EIO4 polling;
missing-token API3 Entries returned the expected 401. The 72-assertion script
used fresh tenant `public-smoke-1784663163199`, observed 237,568 SQLite bytes and a
`0%`/`current` database-size pill.
The Settings
snapshot retained 63 JSON-visible keys and 14 enabled defaults while excluding
secure fields and method functions.
The acceptance run deliberately sent no API secret and did not perform a
protected mutation. Dashboard credential presence and value were not
inspected; no secret value was read, generated, printed or written. Successful
UUID identity mutation and legacy-row repair therefore remain local contract
evidence, not a claim about a credentialed remote write.

The first attempted plugin deployment exposed Cloudflare rolling-upgrade
behavior: an already-live Durable Object temporarily lacked the newly added
property-context RPC and `/properties` returned 500. The current version keeps
the bounded new RPC but falls back only for Cloudflare's precise
missing-method error to the previously deployed snapshot RPC. The same old DO
then returned 200 immediately; real storage/parser failures are still surfaced.

A real browser run reloaded Cloudflare version 66 and rendered the official
homepage, chart region, empty-data `---`, `mg/dl` units and live `0%` dbsize
pill. The Settings form opened with the complete official language selector
and the About block reported Nightscout 15.0.7. Admin Tools displayed the
expected unauthenticated device-authentication dialog without receiving a
credential, and `clock-color` rendered `-?-` with no JavaScript error. The
first reload immediately after activation retained one timestamped ddata 500
console entry; a direct `/api/v2/ddata/at?tenant=demo` check and a second reload
returned 200 and produced no new error, so the transient is recorded rather
than hidden. No protected server mutation or Settings save was attempted. The
user's existing homepage tab was returned to `/` and kept open.
The public tenant currently has no
Entries, so `---` is expected. These checks do not prove every protected
mutation, report, plugin or realtime workflow.
Version 66 has therefore passed its credential-free remote API, Engine.IO and
the named real-browser acceptance gates, with the activation-time transient
above retained as an explicit observation.

Rollback can restore a prior Worker version; removing the entire lab deletes
the Worker, Static Assets deployment and Durable Object namespace. See
`docs/EXECUTION_PLAN.md`.

## License and attribution

NSCF is licensed under `AGPL-3.0-only`. Nightscout contributors retain all
rights in upstream work. See `LICENSE`, `NOTICE.md`, and the preserved upstream
`vendor/nightscout/COPYRIGHT` and `vendor/nightscout/LICENSE`.
