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
  single-resource read uses read permission.
- A shared SQLite repository for all six generic collections, covering
  legacy/API3 identity, collection-specific fallback dedupe, ordered search,
  branch-sensitive mutation permissions, server timestamps,
  tombstones/history and atomic change snapshots. V1 Food writes use the same
  repository and history as API v3; Settings deliberately has no legacy
  fallback identity.
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
the complete v1/v2/v3 route and error surface, large-response CSV/XML resource
adaptation and broader generic API v3 mixed-type/nested/query parity,
failed-auth admin notifications, Mongo query/collection parity beyond the
tested safe subset, Engine.IO polling-to-WebSocket upgrade, EIO3 HTTP transport,
the direct-WebSocket at-most-once crash window, the `/alarm` namespace, root
write handlers, main-namespace real-time database-update broadcasts, the
general background-task scheduler, server plugin execution,
notification/summary persistence and end-to-end verification of every official
page workflow. The polling shim only keeps the official browser bundle supplied
with aggregate REST data; it does not use the new EIO4 endpoint. Switching the
homepage to the official Socket.IO client is a later slice that also requires
safe non-default tenant propagation and the page-used alarm namespace.
Entries also remains incomplete: `times/echo`, `times` and `slice` are absent;
non-Entries `echo`, client-supplied count aggregation pipelines, Mongo
operators, nested/array/mixed-type behavior and collation extend beyond the
fail-closed query subset; and the conservative Workers sanitizer is not
byte-equivalent to upstream DOMPurify. The 512 KiB body, 100-item batch and
10,000-row result/scan bounds are explicit Free-plan controls rather than
upstream limits. Server-side `count` is not subject to the 10,000-row result
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
v2 inheritance, plus activity conditional
requests, JWT issue/verify/expiry/tamper/cross-tenant behavior, Shiro permission
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
containment and v8-to-v9 schema repair. The
locked upstream has 111 JavaScript test files; a static declaration audit finds
883 active `it(...)` cases plus one skipped case. Those declarations are not
directly comparable with the adapter suite and do not prove complete Nightscout
compatibility.

The deployed code candidate and Git HEAD used by Wrangler are commit
`121db7ca5a0b45784713a5ac909a5bcbb3c1f499`. After rebuilding the locked
official UI, its 22-file Workers-runtime suite passes 245/245 tests and both
audit suites pass 20/20. Wrangler dry-run reads the same 248 official assets,
reports 895.01 KiB raw / 160.79 KiB gzip and exposes only `ENTRY_STORE` and
`ASSETS`. This deployed increment adds the persisted API v3 `/storage`
namespace and live API3-only collection-change events while retaining the prior
six generic collection verticals, bounded Entries echo/count work and official
UI. It does not add `times/echo`, `times`, `slice`, `/alarm`, EIO3, root writes
or polling-to-WebSocket upgrade and is not closed-loop completion.
Deployment used `--keep-vars`; no deployed credential was supplied to remote
smoke requests, and no credential value is stored or quoted in this repository.
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

Cloudflare version `00ecdd3a-240c-4fc1-a984-ad6449bb0b84` was made current by
the direct Wrangler deployment, with a reported 22 ms startup. Version tag
`git-121db7c` and its deployment message record the Git mapping. Wrangler did
not print a separate creation/activation timestamp. No asset bytes
needed uploading because all 248 official asset entries were unchanged.
Final credential-free remote smoke returned HTTP 200 for health, v15.0.7
version and the empty v1 Food collection. Missing JWTs on the new API v3 Food
and Settings routes returned the locked HTTP 401 envelope. Their full
CRUD/history/renderer/dedupe/permission contracts passed locally; no
credentialed remote upload or protected mutation was attempted. A fresh EIO4
polling session connected `/storage` independently and returned the locked
`Missing or bad accessToken` ACK for an empty subscription. A separate fresh
session confirmed that `/alarm` remains an explicit `Invalid namespace` gap.

A real browser run rendered the official homepage and its empty chart state
without warning/error logs. The public tenant currently has no Entries, so
`---` is the expected empty-data display. The official Food Editor reached
`Database loaded` and showed the expected anonymous read-only state without
submitting a write. It emitted two non-fatal upstream-bundle warnings that the
chartless Food page has no `#chartContainer`; there were no script errors.
These checks do not prove every protected mutation, report, plugin or realtime
workflow.

Rollback can restore a prior Worker version; removing the entire lab deletes
the Worker, Static Assets deployment and Durable Object namespace. See
`docs/EXECUTION_PLAN.md`.

## License and attribution

NSCF is licensed under `AGPL-3.0-only`. Nightscout contributors retain all
rights in upstream work. See `LICENSE`, `NOTICE.md`, and the preserved upstream
`vendor/nightscout/COPYRIGHT` and `vendor/nightscout/LICENSE`.
