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
  page-data endpoints.
- Tenant-local, SQLite-persisted HS256 JWT signing, the upstream eight-hour
  authorization-token lifetime, locked `shiro-trie` permission matching and
  corrected `verifyauth` behavior.
- The public API v3 version envelope, JWT-protected status endpoint and a
  treatments-only JSON HTTP vertical: collection search/create, resource
  read/replace/patch/delete, both history forms and treatments-aware
  `lastModified`.
- A treatments-focused SQLite schema-v4/repository for legacy/API3 identity,
  ordered search, branch-sensitive mutation permissions, server timestamps,
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
- Tested official EIO4/SIO5 and legacy EIO3/SIO4 packet codecs. Only EIO4
  polling is routed: the endpoint advertises `upgrades: []`, rejects EIO3, and
  does not implement binary packets.
- Content-addressed loading for that platform shim, so an older upstream
  service worker cannot keep serving an obsolete adapter after deployment.
- A response-header adapter that preserves upstream asset bytes while supplying
  the UTF-8 charset normally added by Nightscout's Express server.
- Workers-runtime tests plus real-browser verification for API, SQLite,
  persistence, isolation and official-page rendering.
- No D1, R2, KV, Queues, custom domain or CGM credentials.

## What is not complete

This is not yet a drop-in Nightscout server. Important missing work includes
the complete v1/v2/v3 route and error surface, API v3 collections other than
treatments, API v3 CSV/XML rendering, the authorization delay list and
legacy access-token derivation, Mongo query/collection parity,
WebSocket upgrade, EIO3 HTTP transport, `/storage` and `/alarm` namespaces,
root write handlers, real-time database-change broadcasts, bounded change
outbox retention, Durable Object alarms, server plugin execution,
notification/summary persistence and end-to-end verification of every official
page workflow. The polling shim only keeps the official browser bundle supplied
with aggregate REST data; it does not use the new EIO4 endpoint. Switching the
homepage to the official Socket.IO client is a later slice that also requires
safe non-default tenant propagation and the page-used alarm namespace.

The evidence-based compatibility matrix and acceptance criteria are in
[`docs/UPSTREAM_COMPATIBILITY.md`](docs/UPSTREAM_COMPATIBILITY.md). The storage
and UI flow are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Intended one-click setup

The release deployment flow has one user-facing setting:

> Set a family access password (at least 12 characters), then enter the same
> password in the phone's Nightscout data-source settings.

The Deploy to Cloudflare form obtains this value from `.dev.vars.example` and
the human-readable binding description in `package.json`. Users do not need to
run a CLI command, visit the Worker settings page, or calculate a hash. The
internal binding remains `API_SECRET` for Nightscout compatibility.

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

## Current security boundary

The current deployment is a public simulated-data lab, not a personal
Nightscout deployment.
Current v1/v2 writes require a Nightscout-compatible API-secret digest or an
authorized subject credential; API v3 treatments writes require a Bearer JWT.
The tenant selector provides storage routing, not authorization. Missing or
shorter-than-12-character `API_SECRET` configuration
fails closed with HTTP 503 for API-secret writes. A request must carry the
SHA-1 or SHA-512 hexadecimal digest in `api-secret` (or `?secret=`); the raw
passphrase is deliberately rejected on the wire. A subject's long-lived access
token can obtain an eight-hour HS256 JWT from
`/api/v2/authorization/request/<token>`; Bearer authorization verifies the
signature and expiry, then re-reads the subject and roles from that tenant's
SQLite Durable Object. Each tenant has a separate random signing key that
survives DO eviction and is never returned. This is the authorization core, not
full parity: upstream IP failure delays, body-carried credentials and the
historical access-token derivation/prefix behavior remain to be ported. The root
adapter dependency audit is clean, while `npm ci` for the locked upstream
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
`/status`, `/lastModified` and every treatments operation require a valid
Bearer JWT.

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
asset/version contracts, implemented status and page-data contracts, API-secret
failure modes, the implemented entries and document CRUD subset, activity
conditional requests, JWT issue/verify/expiry/tamper/cross-tenant behavior,
Shiro permission matching, `verifyauth`, the API v3 version/status envelopes,
SQLite persistence across eviction, tenant isolation and invalid input. It also
covers schema-v4 repair, v1/API3 treatment time separation, UUID query handling,
API3 materialization and rollback, the treatments JSON HTTP workflow, and the
EIO4 polling HTTP/session boundary: packet ordering, root authorization,
heartbeat, eviction, overlap, body/session/queue caps, cursor-bounded
initial/retro snapshots, byte/node/document truncation, removal of the fixed
100-status cutoff, deterministic older-tail
truncation and cross-tenant SID rejection. The locked upstream has 111
JavaScript test files and about 873 test cases; the local adapter tests do not
prove complete Nightscout compatibility.

The current simulated-data lab is deployed at
<https://nscf-phase1.nscf-lab-20260717.workers.dev/>. It is intentionally
limited and must not receive real health data. Deployment resources, remote
smoke evidence and rollback details are documented in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

The current deployed code is commit `08b2970b129104a2bdbb293502abd9aa025a19a5`
(Cloudflare version `6cffd451-08e1-4dd5-b582-df7e5e6cbb6e`). Its release gate
rebuilt 248 official asset entries, passed the 161-route/111-test-file audit,
14/14 audit-tool tests and 130/130 Workers-runtime tests, then passed remote
API/EIO4 polling smoke and real-Chromium homepage, Settings, Profile, Food,
Admin, Report and color-clock checks. These counts cover only the named adapter
subset; they are not evidence of a complete Nightscout port.

Rollback can restore a prior Worker version; removing the entire lab deletes
the Worker, Static Assets deployment and Durable Object namespace. See
`docs/EXECUTION_PLAN.md`.

## License and attribution

NSCF is licensed under `AGPL-3.0-only`. Nightscout contributors retain all
rights in upstream work. See `LICENSE`, `NOTICE.md`, and the preserved upstream
`vendor/nightscout/COPYRIGHT` and `vendor/nightscout/LICENSE`.
