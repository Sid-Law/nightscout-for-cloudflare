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
- The official Nightscout v15.0.7 homepage, Admin Tools, Profile Editor, Food
  Editor, Reporting, multiframe view, clock faces and Swagger pages, built from
  the unmodified source snapshot in `vendor/nightscout`.
- A transport-only polling shim for the upstream client's Socket.IO surface;
  it loads one aggregate data payload and emits the upstream `dataUpdate`.
- A separately routed, tenant-local `/socket.io/` server slice for strict EIO4
  HTTP polling and the read-only SIO5 root namespace. Sessions, heartbeat state,
  authorization state and bounded outbound queues persist in the existing
  `EntryStore` SQLite Durable Object across eviction.
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
  locked all-clear payload, including Urgent-to-Warning snooze behavior. This
  is the transport/auth/ACK slice only; server plugins do not yet generate the
  notifications that feed it.
- The official GET `/api/v1/notifications/ack` route and its inherited v2
  mount. Both require `notifications:*:ack`, return Express's exact `200 OK`
  text body, and use the same SQLite ACK/clear transaction as Socket.IO.
  Repeated ACKs remain suppressed across eviction; malformed authenticated
  requests are bounded 200 no-ops rather than unbounded tenant state.
- The v2 `/ddata/at` adapter plus the complete named `ddata.test.js` contract:
  every official data bucket, deep cloning, runtime time/duration derivation
  and prefer-new `_id`/`identifier` merging are represented. The v2
  `/properties` route now supports upstream comma-selection and truthy
  `pretty` formatting. `/api/v2/summary/` ports the locked SGV, treatment,
  temporary-target, temp-basal and current-profile mapping without inventing
  plugin values; until the official server plugin engine is present, its
  IOB/COB/BWP state serializes as `null` and age/battery fields are absent.
- A tenant-local Durable Object alarm derived from persisted realtime
  deadlines and authorization-delay cleanup. It survives eviction and drives
  server ping, pong timeout, session expiry, bounded WebSocket closure retry,
  abandoned poll/POST lease cleanup and stale authorization-failure cleanup
  without relying on a process-lifetime `setInterval`.
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
the direct-WebSocket at-most-once crash window, root write handlers,
main-namespace real-time database-update broadcasts, the general
background-task scheduler, server plugin execution, notification generation,
plugin-derived v2 summary state/persistence, and end-to-end verification of every official page
workflow. The polling shim only keeps the official browser bundle supplied
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
npm run deploy -- --keep-vars
```

`wrangler.jsonc` creates only Worker `nscf-phase1`, its Workers Static Assets,
and the `EntryStore` SQLite Durable Object namespace. A normal Wrangler deploy
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
idempotent v10 schema repair. The inherited v1/v2 notification ACK coverage
also locks HTTP authorization, exact response bytes, shared clear broadcasts,
Urgent-to-Warning state, repeated suppression, malformed-input bounds and
broken-recipient isolation. The
locked upstream has 111 JavaScript test files; a static declaration audit finds
883 active `it(...)` cases plus one skipped case. Those declarations are not
directly comparable with the adapter suite and do not prove complete Nightscout
compatibility. All 16 locked `api3.*` files, `notifications-api.test.js`,
`ddata.test.js` and 15 v1 client/API files are classified as fully `adapted`.
The prior eight v1 additions are
`api.aaps-client.test.js`, `api.alexa.test.js`, `api.entries.test.js`,
`api.root.test.js`, `api.status.test.js`, `api.treatments.test.js`,
`api.unauthorized.test.js` and `api.v1-batch-operations.test.js`; 76 files remain
unresolved and two real-CGM bridge files are fixed-scope exclusions.

The deployed code candidate and Git HEAD used by Wrangler are commit
`79ddf4985bd93510a07444e40bf61972120aa9b6`. After rebuilding the locked
official UI, its 31-file Workers-runtime suite passes 303/303 tests and both
audit suites pass 20/20. Wrangler dry-run reads the same 248 official assets,
reports 942.98 KiB raw / 170.71 KiB gzip and exposes only `ENTRY_STORE` and
`ASSETS`. This deployed increment adapts locked `ddata.test.js`, v2 property
selection/pretty serialization and the core summary mapper while retaining the
prior v1/API3/authorization/realtime slices. This does not make the whole
Nightscout port or the complete v1/v2 API compatible.
Non-Entries echo, arbitrary aggregation pipelines, unrestricted Mongo mixed-
type/nested/array semantics, safe-attribute DOMPurify byte parity, EIO3, root
writes, polling-to-WebSocket upgrade and the server-side notification/plugin
engine, including plugin-derived summary state, remain missing. No deployed
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

Cloudflare version `be2ed773-9148-43df-bbfb-d438bb24fe6f` was made current by
deployment `6d9e7df3-439c-44a4-a206-123a2ded391c` at
`2026-07-19T20:16:32.660015Z`, with a reported 31 ms startup. No asset bytes
needed uploading because all 248 official asset entries were unchanged.
Credential-free remote smoke returned HTTP 200 for selected/pretty v2
properties, v2 summary, v2 ddata, API3 version and v1 Status. No deployed
credential was read or sent.

A real browser run reloaded the current deployment and rendered the official
homepage with its chart region and no console errors. The official Admin Tools,
Food Editor, Profile Editor and `clock-color` page also loaded with their
official controls and zero console errors. Profile reached `Values loaded.` and
Food reached `Database loaded`; no credential was entered and no protected
write was submitted. The
browser was returned to the homepage. The public tenant currently has no
Entries, so `---` is expected. These checks do not prove every protected
mutation, report, plugin or realtime workflow.

Rollback can restore a prior Worker version; removing the entire lab deletes
the Worker, Static Assets deployment and Durable Object namespace. See
`docs/EXECUTION_PLAN.md`.

## License and attribution

NSCF is licensed under `AGPL-3.0-only`. Nightscout contributors retain all
rights in upstream work. See `LICENSE`, `NOTICE.md`, and the preserved upstream
`vendor/nightscout/COPYRIGHT` and `vendor/nightscout/LICENSE`.
