# NSCF — Nightscout for Cloudflare

NSCF is a public-interest, open-source, independent and unofficial downstream port of
[Nightscout](https://github.com/nightscout/cgm-remote-monitor) for Cloudflare.
It is not an official Nightscout release and is not endorsed by or affiliated
with the Nightscout Foundation. Sugar AI may provide initiator or maintenance
support, but NSCF does not depend on or require Sugar AI.

This repository is an active, incomplete Cloudflare port. It directly builds
and serves the official Nightscout v15.0.7 homepage, charts, client plugins and
translations; NSCF does not provide a redesigned or substitute UI. The complete
Node/Mongo and complete Socket.IO/server-plugin behavior are not yet compatible. It uses
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
  behavior. The enforced delay is deliberately capped at 60 seconds. Failed
  credentials now produce the locked Admin notification, aggregated by source
  IP in tenant SQLite and retained across Durable Object eviction.
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
  evaluates CAGE, SAGE, IAGE, Simple Alarms and opt-in Timeago alerts
  automatically, preserving exact future thresholds, the inclusive 20-minute
  age-alert window, heartbeat repetition and automatic clear.
- The official Nightscout v15.0.7 homepage, Admin Tools, Profile Editor, Food
  Editor, Reporting, multiframe view, clock faces and Swagger pages, built from
  the unmodified source snapshot in `vendor/nightscout`.
- The locked legacy `/pebble` endpoint, including newest-first/count behavior,
  mg/dL and mmol/L formatting, direction/trend, delta, uploader battery, raw
  calibration fields and the official IOB/COB display mapping. Its request-local
  data projection and 1,000-row ceiling are Cloudflare adapter boundaries.
- The byte-identical official Nightscout Socket.IO 4.5.4 browser client from
  the locked v15.0.7 tree. The official homepage, Admin, Profile, Food and
  Reporting pages now connect it directly to NSCF's EIO4 polling root and
  `/alarm` namespaces. The only adjacent browser adapter adds NSCF's optional
  test-tenant query; it contains no data, chart, plugin or medical logic.
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
  tagged socket attachments after eviction. Standard EIO4 clients can also
  upgrade an existing polling SID through the locked `2probe`/`3probe`, polling
  noop and `5` sequence. Candidate timeout/abort state is alarm-backed and does
  not delete the still-valid polling session.
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
  registry properties; IOB/COB/BWP remain `null` when disabled. Other unported
  plugin state is not invented.
- A tenant-local Durable Object alarm derived from persisted realtime
  deadlines, authorization-delay cleanup, schema-v14 background tasks and an
  optional schema-v17 lab-CGM deadline. It
  survives eviction and drives
  server ping, pong timeout, session expiry, bounded WebSocket closure retry,
  abandoned poll/POST lease cleanup, stale authorization-failure cleanup and
  automatic Uploader Battery, AR2, Simple Alarm, Dexcom Error Codes, Pump, OpenAPS, xDrip-js,
  Loop, BWP, CAGE, SAGE, IAGE, BAGE,
  Treatment Notify, Timeago and opt-in DBSize re-evaluation without
  relying on a process-lifetime `setInterval`. Mutations evaluate the leading
  edge inside their originating request; no future deadline is retained when
  all sixteen enabled producers are inactive.
- An NSCF platform-only, per-tenant simulated CGM switch for the public lab.
  It is disabled by default, requires the ordinary Entries write/delete
  permissions to change, seeds twelve deterministic five-minute SGVs when
  enabled and then appends one fresh SGV every five minutes through the same
  Durable Object alarm. Eviction preserves its schedule; a delayed wake emits
  one current reading rather than fabricating a long backlog. The generated
  rows use the official Entries schema and flow through the official root
  `dataUpdate`; no client UI, medical formula or dosing logic is added.
- Routed official EIO4/SIO5 and legacy EIO3/SIO4 HTTP polling through the same
  persisted tenant transport. EIO3 keeps its client-ping/server-pong heartbeat,
  length-prefixed payloads and two-stage root CONNECT/`clients` sequence; EIO4
  retains RS framing and server-ping/client-pong. EIO4 polling advertises and
  completes the WebSocket upgrade; direct WebSocket remains EIO4 only. EIO3
  continues to advertise no upgrades, and EIO3 WebSocket/upgrade, JSONP and
  binary transports are not implemented.
- Content-addressed loading for the official Socket.IO client and the small
  tenant-query adapter, so an older upstream service worker cannot keep
  serving an obsolete transport boundary after deployment.
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
Mongo query/collection parity beyond the tested safe subset, Engine.IO
EIO3 direct WebSocket/upgrade and JSONP/binary,
the direct-WebSocket at-most-once crash window, remaining non-Treatment
dataloader/server-plugin preprocessing on root updates, remaining background-task kinds, general server plugin
execution, remaining plugin alarm generation,
external push providers, plugin-derived v2 summary
state/persistence, and broader plugin-specific page workflows.
The official homepage now uses the implemented EIO4 polling endpoint and
`/alarm` namespace and is intentionally pinned to polling by the locked
v15.0.7 client source. The separate standard EIO4 polling-to-WebSocket upgrade
passes local and public WSS contracts. The page does not yet prove EIO3
WebSocket/upgrade, every pushed mutation workflow or the still-missing server-side plugin
preprocessing pipeline.
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

That is sufficient for ordinary CGM/closed-loop data upload and Nightscout
viewing. The official Loop **remote override/carb/bolus push** feature is a
separate advanced opt-in: it additionally requires an Apple Developer APNs
`.p8` key, key ID, team ID and Profile `loopSettings` device metadata. Leaving
those values unset disables only remote APNs commands; it does not disable
ordinary Loop/AAPS data upload or the Nightscout display.

The Deploy to Cloudflare template obtains this value from the human-readable
binding description in `package.json`, without asking a family to calculate a
hash. A clean source checkout now installs the locked upstream build tools and
rebuilds the official assets through `npm run build`; `.dev.vars.example`
declares only `API_SECRET`. The actual one-click button still needs a public
GitHub/GitLab repository and a fresh-account acceptance run, so current
operators still use Wrangler or the Cloudflare dashboard as documented below.
The internal binding remains `API_SECRET` for Nightscout compatibility.

## Local setup

Requires Node.js and npm. Node 22 LTS or newer is recommended.

```sh
npm install
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

For a continuously moving **test-only** curve, enable the NSCF platform
adapter for that tenant. This is not an upstream Nightscout API and is disabled
until explicitly enabled:

```sh
curl -X POST 'http://localhost:8787/_nscf/simulated-cgm?tenant=demo' \
  -H 'Content-Type: application/json' \
  -H "api-secret: ${NSCF_API_HASH}" \
  --data '{"enabled":true}'
```

Post `{"enabled":false}` to stop future readings; existing simulated Entries
remain ordinary Entries and can be deleted with the official APIs.

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
are the 60-second Workers cap on enforced delay and replacement of the
upstream unbounded Admin-notification array: NSCF retains at most 128 transient
messages per tenant while keeping persistent warnings. The root adapter
dependency audit is clean,
while `npm ci` for the locked upstream
v15.0.7 tree currently reports 66 inherited findings (9 low, 18 moderate, 37
high, 2 critical). They are recorded rather than silently changed because
`npm audit fix` would mutate the official release dependency graph.

The routed EIO4 root namespace derives read, write and treatment-write flags
from the same credential permissions as upstream. Anonymous reads follow the
current readable default and retain `{read:true, write:false,
write_treatment:false}`; invalid explicit credentials disconnect only the root
namespace without closing the Engine.IO SID. Authorized `dbAdd`, `dbUpdate`,
`dbUpdateUnset` and `dbRemove` events use the bounded shared repository and
preserve the locked ACK-before-delta order. The separate `/storage` namespace accepts only a
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
`simplealarms.test.js`, `notifications.test.js`, `adminnotifies.test.js`,
`bootevent-debounce.test.js`, `ar2.test.js`,
`websocket.shape-handling.test.js`,
`profile.test.js`, `concurrent-writes.test.js`, `loop.test.js`,
`settings.test.js`, `sandbox.test.js`, `plugins.test.js`, `query.test.js`,
`language.test.js` and 25 v1 client/API
files are classified as fully `adapted`. Eleven complete locked client files
(`pluginbase.test.js`, `client.renderer.test.js`, `errorcodes.test.js`,
`utils.test.js`, `careportal.test.js`, `boluswizardpreview.test.js` and
`profileeditor.test.js`, plus `hashauth.test.js`, `admintools.test.js`,
`reportstorage.test.js` and `reports.test.js`) run unchanged for 42/42 tests against the
byte-identical official client bundle and are classified as `pass`.
Twenty-one complete locked server/data-plugin files also run unchanged for
143/143 tests; the newest addition is `mongo-pool-config.test.js`, whose eight
cases lock the official Node/Mongo pool-option parser without claiming that
SQLite Durable Objects use a Mongo connection pool. The preceding addition is
`ar2.test.js`, whose ten cases lock the
official prediction cone, warning/urgent decisions, interpolation and virtual
assistant output. The preceding `expressextensions.test.js` addition locks
exact `.json` suffix handling and rejects the lookalike `entriesXjson` path.
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
`api.unauthorized.test.js` and `api.v1-batch-operations.test.js`; seven files remain
unresolved and two real-CGM bridge files are fixed-scope exclusions.

The deployed runtime candidate is commit `86dd941`. The 70-file Workers-runtime
suite passes 782/782 tests, the audit suites pass 23/23, eleven complete
official client files pass 42/42 unchanged, and twenty-one locked server/data-plugin
files pass 143/143 unchanged. Wrangler dry-run reads 250 Static Assets entries,
reports 1288.03 KiB raw / 236.93 KiB gzip and exposes only
`ENTRY_STORE` and `ASSETS`.
The deployed candidate retains the replacement of the upstream process-local Admin notification array
with schema-v15 per-tenant SQLite state. It preserves aggregation, the public
count/admin-only body split, the eight-hour API and twelve-hour retention
windows, the readable-site warning, failed-auth producer and
`ADMIN_NOTIFIES_ENABLED` gate. The original Admin-notifies file now runs
unchanged; the 128-transient-message ceiling is an explicit Workers Free
hardening boundary.
This increment also adapts the complete 26-case upstream storage-shape file.
The public scalar/array/batch paths retain their response cardinality, while
direct Profile/Food/Activity `save()` now generates a fresh ObjectId for a
missing or invalid internal ID just as the locked Mongo storage does. The HTTP
API still rejects invalid IDs before that internal adapter, so this does not
weaken uploader validation. Raw Mongo `insertOne` is intentionally replaced by
an explicit typed SQLite document-batch RPC rather than emulated.
Schema v16 additionally replaces upstream's process-local Lodash timer and
mutable `dataloadRunning`/`dataloadPending` flags with a per-tenant SQLite
burst window. The first mutation evaluates immediately, rapid uploads receive
one final trailing evaluation after one quiet second, and sustained uploads
are forced through within five seconds. The same Durable Object alarm survives
isolate eviction, while immediate root/API publication is not delayed. All
nine locked `bootevent-debounce.test.js` cases plus one real 20-Profile batch
integration are represented by ten Workers-runtime tests.
It retains the request-local Worker-safe port of the locked query defaults,
walker, date and ObjectId/UUID normalization surface; live Entries parsing
reuses its four-day boundary and ObjectId normalization before bounded SQLite
execution. It also retains the locked server language surface without
bundling 1.5 MiB of dictionaries into the Worker: localization is fetched from
Workers Static Assets, all 33 JSON files are audited as valid and byte-identical
to v15.0.7, `LANGUAGE` reaches HTTP/Socket settings, and the default Sandbox
uses the same request-local translator.
This runtime connects a single `plugin-notifications` SQLite task to the locked
official Uploader Battery, AR2, Simple Alarms, Error Codes, Pump, OpenAPS, xDrip-js, Loop, BWP,
CAGE, SAGE, IAGE, BAGE,
Treatment Notify, Timeago and DBSize calculations and the core notification
processor. The engine evaluates all sixteen official
producers in official server order from one bounded context, arbitrates requests and snoozes in one
transaction, atomically publishes the selected live `/alarm` frame, and stores
the next exact logical deadline. AR2 preserves the official coefficients,
six-point loss divisor, prediction cone, exact alert titles/messages/sounds,
`ALARM_TYPES` and `AR2_CONE_FACTOR`; it is also exposed by the v2 property
registry and renders through the unchanged official client. Simple Alarms preserves strict high/low
thresholds and ten-minute SGV expiry. Error Codes retains its locked display,
sound and strict ten-minute selection. The opt-in xDrip-js adapter exposes the
official `sensorState` property, CGM pill fields, transmitter-state and battery
alerts, and persists its last state-notification marker in schema v20 so
Durable Object eviction cannot reset the configured repeat interval. Treatment
Notify preserves its strict
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
heartbeat bound is an explicit Workers Free hardening difference. The automatic
adapter is internal, not a public processing API. Version 81 also ports the
complete locked Maker, Pushover and Pushnotify message-selection, dedupe,
cancellation and acknowledgement contracts. Schema v18 persists their dedupe
leases, emergency receipts and Maker All Clear timestamp per tenant, and the
official v1/v2 Pushover callback can acknowledge a previously stored receipt.
External Pushover/IFTTT delivery is still disabled until that specific
destination is authorized and a persisted outbox is connected.
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
The prior age/timeago and database-size adapters remain. Timeago, CAGE, SAGE
and IAGE alerts are now automatically scheduled when their locked settings
enable them. The opt-in DBSize producer consumes the same real SQLite byte
count, persists heartbeat scheduling and publishes through `/alarm`; it remains
off by default, so ordinary deployments do not spend extra alarm work for this
diagnostic. Ddata continues to publish the Durable Object's real SQLite file
size without double-counting indexes. Its platform maximum defaults to the documented
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
Node plugin `require` without fabricating unresolved Node/Mongo or test-harness
behavior. The manifest records sixteen direct passes, 86 adapted, seven unresolved
and two fixed-scope exclusions. The deployed configuration also retains
Wrangler `keep_vars`, so dashboard-managed plaintext
variables are preserved instead of being overwritten by a code deployment.
Its Node configuration audit rejects stored plaintext vars and prohibited
D1/R2/KV/Queues/routes while locking the existing footprint.
Non-Entries echo, arbitrary aggregation pipelines, unrestricted Mongo mixed-
type/nested/array and BSON numeric/object-ID semantics, safe-attribute DOMPurify
byte parity, EIO3 WebSocket/upgrade/JSONP/binary, server-side
summary/activity persistence and remaining non-plugin task kinds remain
missing. The user-supplied construction credential is active and was used only
for the named simulated SGV batch; its value is not stored or quoted in this
repository.
Entries migration remains intentionally
fresh-only: an incompatible pre-1.0 narrow `entries` shadow is reset instead of
being imported, while canonical documents and other collections such as
profile are preserved. A pre-seeding read found zero Entries and one profile in
the public tenant. The later 25 `simulator://nscf-demo` rows were new test data,
not imported history; they were removed by exact device/type matching on
2026-07-22 after the intentionally idle stream triggered the official stale-
data alarm. The Profile was preserved, and ordinary deployments do not
auto-generate fake glucose. This is not a general legacy-data migration guarantee.

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

Cloudflare version `d1249e2d-e5b7-42c4-8c4d-b6bf2b93c930` (ordinal 79) was
created at `2026-07-22T01:34:33.270Z`; Wrangler reported a 33 ms startup and no
asset changes relative to the preceding version. Version 75
`3c124be0-a30c-48b2-9a6f-0faa84240e01` uploaded the official Socket.IO client,
the tenant-query adapter and the six rebuilt page/service-worker entries.
Credential-free remote smoke returned HTTP 200 for health, bounded v1 Entries
and Treatments reads, a fresh-tenant current Profile and v2 Summary, API3
version, matching v1/v2 Settings snapshots, real ddata/database-size values,
the default-enabled `dbsize` and Basal properties, opt-in-disabled Loop, IOB/COB,
OpenAPS/Pump and age
properties, null disabled IOB/COB Summary state, and EIO4 polling;
missing-token API3 Entries returned the expected 401. That version-80 77-assertion script
used fresh tenant `public-smoke-1784686572692`, observed 270,336 SQLite bytes and a
`0%`/`current` database-size pill.
The Settings
snapshot retained 63 JSON-visible keys and 14 enabled defaults while excluding
secure fields and method functions.
The reusable 77-assertion smoke deliberately sent no credential and confirmed
that anonymous mutation fails closed. A separate authenticated 25-entry
simulator write/read returned HTTP 200; UUID identity mutation and legacy-row
repair remain local contract evidence.

The first attempted plugin deployment exposed Cloudflare rolling-upgrade
behavior: an already-live Durable Object temporarily lacked the newly added
property-context RPC and `/properties` returned 500. The current version keeps
the bounded new RPC but falls back only for Cloudflare's precise
missing-method error to the previously deployed snapshot RPC. The same old DO
then returned 200 immediately; real storage/parser failures are still surfaced.

A real browser run loaded Cloudflare version 72 and rendered the official
homepage, chart region, initial empty-data `---`, `mg/dl` units and live `0%` dbsize
pill plus the official Admin-notification link. The Settings form opened with
the complete official language selector
and the About block reported Nightscout 15.0.7. The same pass opened Admin
Tools and the official `clock-color` page; both loaded without a console error.
After the user supplied a valid construction credential, 25 entries from
`simulator://nscf-demo` were written and read back; the homepage then rendered
`101 mg/dL`, an upward arrow, `+3` and a populated two-hour chart. No Settings
save, Food/Profile mutation or real health data was used. These checks do not prove every protected
mutation, report, plugin or realtime workflow.
After the AR2 deployment, a version 73 browser pass loaded the same official
homepage with two SVGs, eleven chart paths and all 26 official AR2 forecast
dots. The only captured errors were the browser's expected autoplay-policy
rejection before user interaction; no application/API error was captured.
Version 73 has therefore passed its 72-assertion credential-free remote API,
Engine.IO and named real-browser gates. Four fresh-tenant Admin-notification
probes returned count one while correctly hiding the body from anonymous
callers. One immediate post-activation request returned the old zero-count
behavior; the 100% deployment status and same-region retries then converged.
Administrator-body, Profile/Food/Admin mutation and real closed-loop paths
remain for the final user environment test.

After the age/DBSize scheduler deployment, a version 74 browser pass reloaded
the official homepage, connected to the live transport, displayed the preserved
simulated stream and opened the complete official Settings form. The form showed
Admin authorized and Nightscout version 15.0.7; clicking the unchanged official
Save button completed successfully and closed the form. The only console errors
were the browser's expected audio autoplay-policy rejections before interaction.
Version 74 also passed the same 72-assertion credential-free API/Engine.IO gate.

Versions 75–78 replaced the REST polling shim with the locked official
Socket.IO 4.5.4 client and then repaired a Cloudflare edge difference where a
bodyless `DELETE` can arrive as a zero-byte stream. A remote isolated-tenant
contract created one simulated SGV, deleted it with a genuinely bodyless
request and observed HTTP 200, `deletedCount:1` and zero remaining rows. The
final official Socket.IO client smoke connected the root and `/alarm`, received
the initial `dataUpdate`, authorized anonymous read and subscribed for alarms.
A new browser profile loaded both content-addressed transport assets, used real
EIO4 polling, logged the four corresponding connection/data/subscription
events and had zero console errors or warnings. After the 25 stale simulator
rows were removed, the page title remained `Nightscout` without a stale-data
alarm.

Version 79 adds only the opt-in schema-v17 lab simulator and its protected
platform endpoint. The public `demo` tenant was explicitly enabled after
deployment: twelve one-hour seed points appeared in the official chart and the
same DO appended the `01:40` and `01:45` readings. The already-open official
page advanced to the newest value without a reload. Fresh or ordinary tenants
remain disabled, so this does not fabricate glucose for normal deployments.

Version 80 (`407dbd03-4a4f-454a-b9a2-1304deb19ac2`) deploys the locked legacy
`/pebble` adapter. The 77-assertion credential-free remote smoke passed against
fresh tenant `public-smoke-1784686572692`; a live `demo` Pebble read returned
the newest two ordinary Entries with the official display shape. An
authenticated real-browser acceptance renamed, saved and reloaded the current
Profile and then restored its original name; created/read/deleted a temporary
Food item; created and removed a temporary Admin role; and generated the
official Report page output (30 SVGs and eight canvases). The homepage then
rendered the continuing simulated stream at `129 mg/dL`, `+3` and
`FortyFiveUp`. All temporary acceptance records were removed or restored. No
real health data, CGM credential or closed-loop traffic was used, and a
protected mutation observed through the pushed live-update path remained a
separate gate at that version; version 93 closes it with an authenticated
Profile save plus live `dataUpdate`/`retroUpdate` observation.

Version 81 (`5f0c3898-7d92-4164-af78-55b64cc46517`) deploys commit `ae88ba1`
with the locked Maker/Pushover/Pushnotify provider contracts, schema-v18 SQLite
dedupe/receipt/All-Clear state and the inherited v1/v2 Pushover receipt
callback. The callback rejects unknown receipts and no live external provider
is enabled. A new simulator regression proves that fresh simulated SGV data
automatically clears an already-emitted stale-data alarm. The 66-file,
719-test Workers gate, 77-assertion public smoke and real browser all passed;
the unchanged homepage displayed `121 mg/dL`, `+4`, `FortyFiveUp`, four minutes
ago, with no dialog, console warning or console error.

Version 82 (`baade90c-d738-4a8b-a6c2-f1b19af68d9b`) deploys commit `99cfe78`
and restores the locked realtime Profile Switch status chain. The latest
zero-duration Profile Switch from the official one-year window now appears as
`status.activeProfile` during initial Socket.IO authorization; changing that
profile adds a fresh complete status object to the root `dataUpdate`. The
comparison marker is stored in the existing SQLite root baseline so the
behavior survives Durable Object eviction, while ordinary updates do not gain
an extra status payload. The 66-file, 720-test Workers gate and 77-assertion
public smoke passed. The public simulator continued at five-minute intervals;
the official homepage refreshed to `127 mg/dL`, four minutes old, with no
dialog or console warning/error. A protected remote Profile Switch mutation was
not claimed because no construction credential was injected into the local
test shell; the real SQLite DO reconstruction contract covers that write path.

Version 83 (`351ae79e-fcbb-4ff7-ba52-f013547311b5`) deploys commit `f09e99f`
and ports the locked server-side Bolus Wizard Preview chain without changing its
formula or executing a Treatment. The opt-in BWP plugin now supplies official
v2 property/Summary state, Pebble `bwp`/`bwpo` fields, warning/urgent requests,
IOB snooze behavior and persisted background evaluation after Loop and before
the age plugins. It shares the deployed Profile Switch, Temp Basal and Combo
Bolus preprocessing rather than duplicating it. BWP remains disabled under the
public upstream-default settings: remote `/properties` returned no BWP object,
Summary returned `bwp:null`, and Pebble omitted the fields, while the enabled
path passed a real SQLite Durable Object alarm test. The 67-file, 728-test
Workers gate, all source/audit gates and the 77-assertion public smoke passed.
The unchanged homepage displayed the continuing simulator at `113 mg/dL`,
`-1`, `Flat`, one minute old, without a dialog or console warning/error. At
`2026-07-22T03:55:00.124Z` the persisted simulator independently appended the
next `115 mg/dL` reading and advanced its following five-minute deadline.

Version 84 (`c779b136-0f3f-4aaa-88ab-48309e1a53cf`) deploys commit `45074b9`
and adds the legacy `allowEIO3` HTTP-polling compatibility slice over schema-v19
persisted protocol authority. The locked upstream Socket.IO stack supplied the
wire oracle: the first response is the EIO3 length-prefixed open packet, while
the next poll returns root CONNECT before `clients`, exactly preserving the
two-stage Socket.IO 2.x sequence. Client ping/server pong, namespace query
parsing, per-session EIO3/SIO4 packet conversion, ACKs and mixed EIO3/EIO4
broadcasts are covered without changing EIO4 behavior. EIO3 direct WebSocket,
polling-to-WebSocket upgrade, JSONP and binary transports remained explicit
gaps in version 84.
The 67-file, 731-test Workers gate, all audit/source gates, dry run and the
99-assertion public smoke passed; the smoke used isolated tenant
`public-smoke-1784694550269` and exercised both EIO4 and EIO3 polling. A fresh
real-browser reload of the unchanged official homepage displayed `127 mg/dL`,
`-3`, one minute old with the chart present, a connected live client and no
console warning or error. The five-minute persisted simulator remains enabled,
so the public lab does not age into a stale-data alarm while migration work
continues.

Version 85 (`1eb859ef-2feb-4c42-b9c2-aa533be7cc7e`) deploys commit `3c4b82a`
and completes the standard EIO4 polling-to-WebSocket upgrade path. The polling
open packet now advertises `upgrades:["websocket"]`; a live SID accepts the
locked probe/noop/upgrade order, preserves SQLite session authority across
transport replacement and survives Durable Object eviction through a validated
Hibernation attachment. Duplicate, malformed, abandoned and timed-out upgrade
candidates close without deleting the original polling session. The 734-test
Workers gate, all source/audit gates, TypeScript and the 1251.01-KiB dry run
passed. A 106-assertion public smoke on tenant
`public-smoke-1784696258002` completed a real WSS upgrade and received root
CONNECT plus `clients`; the refreshed unchanged homepage displayed `121 mg/dL`,
`+4`, three minutes old with no warning or console error. The locked homepage
client remains polling-only by upstream choice; external standard EIO4 clients
can use the newly deployed upgrade.

Version 86 (`44f94fa0-8061-4a7e-a30b-113e239488e6`) deploys commit `750e9ec`
and connects the already locked `lib/data/treatmenttocurve.js` port to the
official root Socket.IO data path. Initial authorization data and later
`dataUpdate` deltas now receive the same display-only Treatment marker
placement that upstream runs after its dataloader: explicit mg/dL/mmol values,
caps, profile display units, raw-BG fallback and surrounding-SGV placement are
preserved without adding a dose calculation. Transformation happens before
the shared realtime JSON budget reserves each Treatment, so its added fields
cannot bypass the Workers Free payload ceiling. The new contract covers both
initial delivery and a post-eviction pushed delta; the Workers gate increased
to 735/735 while every unchanged upstream and audit gate stayed green. The
106-assertion public smoke passed on `public-smoke-1784697190440`. A fresh
official-page session displayed current simulated glucose, two SVGs, no dialog,
and zero console warnings or errors while receiving root and alarm events.

Version 87 (`d8c70ff9-3370-4745-b9ee-45da662c1689`) deploys commit `8ee5c73`
and restores the official Food/Profile read split. Food `quickpicks` now keeps
only exact string `hidden:"false"` records and applies Mongo-like ascending
position order; Food root/regular/quickpicks ignore query controls that locked
v15.0.7 does not read. Singular Profile remains count-only, plural Profiles is
the read-only query route, and invalid child paths return 404. The generic
non-Treatment reader no longer fabricates `carbs` or `insulin` fields. All
736/736 Workers tests, unchanged upstream suites, audits, TypeScript and the
1253.33-KiB dry run passed. The expanded 120-assertion public smoke passed on
`public-smoke-1784698633397`; the unchanged Food Editor reported `Database
loaded` with complete Quick-picks controls, while the homepage displayed a
fresh `118 mg/dL` simulated value. Both pages had zero console warnings or
errors.

Version 88 (`0dd4cdd5-09d2-428e-b12e-d6d66e6905e3`) deploys commit `7298f45`
and adds the locked server-side Dexcom Error Codes notification producer after
Simple Alarms in official order. It preserves the eight named display codes,
fallback display, code-specific sounds, default information/urgent mapping,
literal `off` custom mappings, newest nonfuture SGV selection and strict
ten-minute expiry. The existing SQLite notification task now evaluates
thirteen producers and activates future error-code readings at their exact
timestamp before publishing through the same persisted `/alarm` processor.
Ten pure-adapter tests and three real Durable Object scheduler tests raise the
Workers gate to 749/749 across 68 files. All unchanged upstream and audit gates,
TypeScript and the 1256.42-KiB dry run passed. The 121-assertion public smoke
passed on `public-smoke-1784700236170`; a fresh official homepage showed a
current `122 mg/dL`, `+4`, upward-trend reading with no dialog or console
warning/error, Settings still reported Nightscout 15.0.7, and the durable
five-minute simulator remained enabled. The public run confirms the official
default enable flag; information, urgent, future-activation and clear behavior
are proven without polluting the lab by the real SQLite DO integration tests.

Version 89 (`aa72dd6d-4307-41fc-8162-27211ed6dbb8`) deploys commit `31d0260`
and ports the opt-in official xDrip-js CGM Status server plugin. The v2 property
registry now exposes the locked `sensorState` shape from the newest eligible
24-hour DeviceStatus row, including device, transmitter, session, calibration,
signal and battery fields. Transmitter-state and low-battery notifications run
in official server order between OpenAPS and Loop. Schema v20 persists the
small last-state notification marker so the default 31-minute repeat behavior
survives Durable Object eviction; future activation, exact 24-hour expiry,
battery heartbeat repeats and automatic All Clear use the existing atomic
SQLite scheduler/outlet. xDrip-js remains disabled by the official default.
The full local gate passed 69 Workers files / 763 tests, 22/22 audits, 42/42
unchanged client tests, 143/143 unchanged server/data-plugin tests, TypeScript
and a 1269.08-KiB raw / 233.24-KiB gzip dry run. The 125-assertion public smoke
passed on `public-smoke-1784702685161`; the official homepage rendered a fresh
`114 mg/dL`, `+2` simulated reading and chart, Settings reported Nightscout
15.0.7, and the browser produced zero warnings or errors. The persisted
five-minute simulator remained enabled and independently wrote the current row
at `2026-07-22T06:45:00.168Z`.

Version 90 (`4dbd8a38-3f35-4e85-b379-324cbe2f5577`) deploys commit `73fdf64`
and completes the request-time property surface of the locked official server
plugin registry. Default-enabled Runtime State now returns the upstream
`{state:"loaded"}` shape, while opt-in Pump Battery Age (`BAGE`) selects the
newest nonfuture 62-day `Pump Battery Change`, preserves day/hour display,
notes, Summary age and the official information/warning/urgent thresholds.
BAGE is the fifteenth producer in the persisted scheduler; exact future
thresholds, the inclusive 20-minute notification window, heartbeat repetition,
minute-21 All Clear and live `/alarm` delivery use the existing SQLite task.
The remaining official server notification producer is Uploader Battery
(`upbat`); external delivery and summary/activity persistence also remain.
The full local gate passed 69 Workers files / 769 tests, 22/22 audits, 42/42
unchanged client tests, 143/143 unchanged server/data-plugin tests, TypeScript
and a 1273.27-KiB raw / 233.63-KiB gzip dry run. The 129-assertion public smoke
passed on `public-smoke-1784704705985`, including default Runtime State,
default-disabled BAGE, Summary omission, EIO4 WebSocket upgrade and EIO3
polling. A fresh official homepage rendered `127 mg/dL` and its chart;
Settings/About reported Nightscout 15.0.7 and the captured browser log contained
zero warnings or errors.

Version 91 (`d044403f-469f-4aad-9ff2-9829d0cb177d`) deploys commit `5309eff`
and completes the official server `checkNotifications` registry. Uploader
Battery now maps `UPBAT_WARN`, `UPBAT_URGENT` and `UPBAT_ENABLE_ALERTS`, uses
the official recent-30-minute, per-device ten-minute-lowest calculation and
multi-device/voltage message, and runs before AR2 in locked server order. The
schema-v14 task preserves future DeviceStatus activation, heartbeat repetition,
the inclusive 30-minute source boundary, millisecond-after expiry All Clear and
live `/alarm` delivery. Alerts remain opt-in; the default official property is
still available without background alarm work.

The full local gate passed 69 Workers files / 773 tests, 22/22 audits, 42/42
unchanged client tests, 143/143 unchanged server/data-plugin tests, TypeScript
and a 1275.98-KiB raw / 234.06-KiB gzip dry run. The 134-assertion public smoke
passed on `public-smoke-1784706560346`, including default UPBAT configuration,
empty-property output, EIO4 WebSocket upgrade and EIO3 polling. A fresh official
homepage rendered `113 mg/dL`, `-1`, one-minute-old simulated data and its
chart; Settings/About reported Nightscout 15.0.7 and the browser log contained
zero warnings or errors.

Version 92 (`8f11cd37-f90d-4b51-9ad6-5ce85091ac42`) deploys commit `db85900`
and restores the v2-only `POST /api/v2/notifications/loop` route used by the
official Loop plugin for Temporary Override, override cancellation, Remote
Carbs and Remote Bolus requests. The request-local adapter preserves the locked
credential/Profile validation order, exact callback error text, `loopSettings`
device/topic lookup, alert text, custom payload keys and five-minute expiry.
Workers Web Crypto signs Apple's ES256 provider JWT from the existing
`LOOP_APNS_*` settings, and bounded awaited `fetch` replaces the Node-only
`@parse/node-apn` client. Provider tokens are reused for fifty minutes inside
an isolate, APNs error bodies are capped at 8 KiB and requests time out after
ten seconds. No Apple credentials are configured in the public lab, so no real
remote override, carb or bolus instruction was sent.

The full local gate passed 70 Workers files / 782 tests, 22/22 audits, 42/42
unchanged client tests, 143/143 unchanged server/data-plugin tests, TypeScript
and a 1288.03-KiB raw / 236.93-KiB gzip dry run. The 139-assertion public smoke
passed on `public-smoke-1784710160605`; it proved that the deployed v2 route
reaches the locked permission boundary, that v1 does not invent the route, and
retained real EIO4 WebSocket upgrade and EIO3 polling. A fresh official
homepage rendered `117 mg/dL`, `+3`, one-minute-old simulated data and its
chart. The official Admin page loaded all cleanup workflows, seven built-in
roles, zero subjects and `Admin authorized` against the same active version.

Version 93 in the project release sequence
(`117d0d35-e696-41b5-a12f-06a7e0e274c4`) deploys commit `86dd941` and prepares
the clean-source Cloudflare deployment template. Root `npm run build` now
installs the pinned Nightscout build tree before rebuilding the official UI;
the clean-source run installed 1,057 locked upstream build packages and
generated all 250 Static Assets. Wrangler 4.113.0 and
`@cloudflare/workers-types` 5.20260722.1 are locked, and the configuration
audit verifies the exact build/deploy commands plus the sole `API_SECRET`
onboarding binding. A public Git remote and fresh-account Deploy button
acceptance are still required before calling setup one-click.

The full local gate remained 70 Workers files / 782 tests, increased to 23/23
audits, 42/42 unchanged client tests, 143/143 unchanged server/data-plugin
tests, TypeScript and the 1288.03-KiB raw / 236.93-KiB gzip dry run. The
post-deploy 139-assertion smoke passed on
`public-smoke-1784712181612`, including EIO4 WebSocket upgrade and EIO3
polling. The unchanged official homepage displayed current simulated glucose
and its chart; the Profile Editor loaded `Profile11111111`, `Asia/Shanghai`
and `Admin authorized`. Immediately before this deployment, an authenticated
Profile rename/save emitted live-page `dataUpdate` and `retroUpdate` events;
the original name was then restored and reloaded successfully. No real health
data or closed-loop instruction was used.

The APNs transport follows Apple's current provider-token and notification
request specifications and Cloudflare's current Web Crypto/fetch APIs:
[Apple token authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns),
[Apple notification requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns),
[Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) and
[Workers fetch](https://developers.cloudflare.com/workers/runtime-apis/fetch/).

Rollback can restore a prior Worker version; removing the entire lab deletes
the Worker, Static Assets deployment and Durable Object namespace. See
`docs/EXECUTION_PLAN.md`.

## License and attribution

NSCF is licensed under `AGPL-3.0-only`. Nightscout contributors retain all
rights in upstream work. See `LICENSE`, `NOTICE.md`, and the preserved upstream
`vendor/nightscout/COPYRIGHT` and `vendor/nightscout/LICENSE`.
