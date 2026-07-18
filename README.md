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
- Tenant-local, SQLite-persisted HS256 JWT signing, the upstream eight-hour
  authorization-token lifetime, derived subject access tokens and prefix
  matching, body/query/header credential precedence, persisted per-IP failure
  delay, locked `shiro-trie` permission matching and corrected `verifyauth`
  behavior. The enforced delay is deliberately capped at 60 seconds; failed
  authentication does not yet generate the upstream admin notification.
- The public API v3 version envelope, JWT-protected status endpoint and three
  generic collection verticals for entries, treatments and device status:
  collection
  search/create, resource read/replace/patch/delete, both history forms and
  collection-aware `lastModified` in the locked JSON, CSV and XML formats.
- A shared SQLite repository for entries, treatments and device status
  legacy/API3 identity, collection-specific fallback dedupe, ordered search,
  branch-sensitive mutation permissions, server timestamps,
  tombstones/history and atomic change snapshots.
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
  the UTF-8 charset normally added by Nightscout's Express server.
- Workers-runtime tests plus real-browser verification for API, SQLite,
  persistence, isolation and official-page rendering.
- No D1, R2, KV, Queues, custom domain or CGM credentials.

## What is not complete

This is not yet a drop-in Nightscout server. Important missing work includes
the complete v1/v2/v3 route and error surface, the three remaining API v3
generic collections, large-response CSV/XML resource adaptation, failed-auth
admin notifications, Mongo query/collection parity beyond the tested safe
subset, Engine.IO polling-to-WebSocket upgrade, EIO3 HTTP transport,
the direct-WebSocket at-most-once crash window, `/storage` and `/alarm`
namespaces, root write handlers, real-time
database-change broadcasts, bounded change
outbox retention, the general background-task scheduler, server plugin
execution,
notification/summary persistence and end-to-end verification of every official
page workflow. The polling shim only keeps the official browser bundle supplied
with aggregate REST data; it does not use the new EIO4 endpoint. Switching the
homepage to the official Socket.IO client is a later slice that also requires
safe non-default tenant propagation and the page-used alarm namespace.

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
authorized subject credential; API v3 entries, treatments and device-status
operations require a Bearer JWT.
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
database mutation event.

## Configure API_SECRET on Cloudflare

Open **Workers & Pages → `nscf-phase1` → Settings → Variables and Secrets**,
click **Add**, select a plain-text variable, name it exactly `API_SECRET`, enter
a passphrase of at least 12 characters, then save/deploy. Its value is the raw
passphrase. A compatible Nightscout uploader normally asks for that same raw
passphrase and hashes it before sending. Secret storage
(`npx wrangler secret put API_SECRET`) is optional; both forms appear to Worker
code as `env.API_SECRET`.

Do not put a real value in `wrangler.jsonc`, commit `.dev.vars`, or paste it
into an issue. Most current GET endpoints remain publicly readable. API v3
`/status`, `/lastModified` and every entries/treatments/device-status operation
require a valid Bearer JWT.

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
the implemented entries and document CRUD subset, activity conditional
requests, JWT issue/verify/expiry/tamper/cross-tenant behavior, Shiro permission
matching, `verifyauth`, and the API v3 version/status envelopes. It also covers
fresh-only Entries schema repair, v1/API3 entries/treatments/device-status
identity and time separation, UUID/ObjectId query handling, API3
materialization and rollback, safe regular-expression compilation,
JSON/CSV/XML workflows for all three implemented generic collections, and the
EIO4 polling/direct-Hibernatable-WebSocket boundary: packet ordering, root
authorization, alarm-driven heartbeat/expiry, eviction, overlap,
body/session/queue caps, cursor-bounded initial/retro snapshots,
byte/node/document truncation, removal of the fixed 100-status cutoff,
deterministic older-tail truncation and cross-tenant session rejection. The
locked upstream has 111
JavaScript test files and about 873 test cases; the local adapter tests do not
prove complete Nightscout compatibility.

The deployed code candidate is commit
`d8e406d13b87b2e304b1db4dc075af18ae463022`; deployment ran from repository
HEAD `ac0947dc6139d16e424cc212e3757dde0c7c088b`. Its 18-file Workers-runtime
suite passes 215/215 tests. It adds the strict Status, authorization, direct
EIO4 WebSocket and API v3 Entries slices described above. The official
upstream build completed with its three known Webpack size warnings, and
Wrangler read 248 assets and reported only `ENTRY_STORE` and `ASSETS` bindings
(764.00 KiB raw / 135.65 KiB gzip). Deployment used `--keep-vars`; the
configured secret was neither read nor printed. Its Entries migration is intentionally
fresh-only: an incompatible pre-1.0 narrow `entries` shadow is reset instead of
being imported, while canonical documents and other collections such as
profile are preserved. A read-only check at 2026-07-18 14:51 UTC found zero
Entries and one profile in the public tenant, and the post-deployment smoke
again returned zero Entries and one profile. This particular lab therefore
has no old simulated Entry row to carry forward. This is not a general
legacy-data migration guarantee.

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

Cloudflare version `65db0a2f-9f4e-4c41-8edf-de85bb49c31d` reached 100% traffic
at 2026-07-18T15:13:42.775Z with a reported 20 ms startup. No asset bytes
needed uploading because all 248 official asset entries were unchanged.
Remote smoke returned HTTP 200 for health, API v3 version, v1 Entries, the
preserved one-element Profile response, strict Status text negotiation and
`/api/v2/ddata/at`; unknown Status extensions returned 404 and API v3 Entries
without a token returned 401. EIO4 polling and direct WebSocket each completed
open, SIO5 connect, `clients`, read-only authorize, `dataUpdate` and ACK. The
polling open advertised no upgrades, a 25-second ping interval, 20-second
timeout and 1,000,000-byte maximum.

A real Playwright browser run rendered the official homepage chart and About
version 15.0.7. Settings stayed closed across several 15-second `dataUpdate`
rounds rather than rebounding. Profile Values loaded, while Admin, Food,
Report and the color clock rendered their official controls. There were zero
console errors and only known upstream/browser warnings. No credentialed Save
or other protected mutation was attempted, so this is not proof that every
protected page workflow is complete. These counts and observations cover only
the named adapter subset; they are not evidence of a complete Nightscout port.

Rollback can restore a prior Worker version; removing the entire lab deletes
the Worker, Static Assets deployment and Durable Object namespace. See
`docs/EXECUTION_PLAN.md`.

## License and attribution

NSCF is licensed under `AGPL-3.0-only`. Nightscout contributors retain all
rights in upstream work. See `LICENSE`, `NOTICE.md`, and the preserved upstream
`vendor/nightscout/COPYRIGHT` and `vendor/nightscout/LICENSE`.
