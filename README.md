# NSCF — Nightscout for Cloudflare

NSCF is a public-interest, open-source, independent and unofficial downstream port of
[Nightscout](https://github.com/nightscout/cgm-remote-monitor) for Cloudflare.
It is not an official Nightscout release and is not endorsed by or affiliated
with the Nightscout Foundation. Sugar AI may provide initiator or maintenance
support, but NSCF does not depend on or require Sugar AI.

This repository is a phase-one Cloudflare port. It directly builds and serves
the official Nightscout v15.0.7 homepage, charts, plugins and translations; NSCF
does not provide a redesigned or substitute UI. It uses simulated glucose values
only. It is not a medical device and must not be used for diagnosis, dosing, or
medical decisions.

## What phase 1 contains

- A TypeScript Cloudflare Worker on `workers.dev`.
- One SQLite-backed Durable Object class, sharded one instance per tenant.
- Nightscout-compatible entries, food, profile, treatments, device-status,
  roles, subjects, status, authorization and live-data endpoints required by
  the shipped pages.
- The official Nightscout v15.0.7 homepage, Admin Tools, Profile Editor, Food
  Editor, Reporting, multiframe view, clock faces and Swagger pages, built from
  the unmodified source snapshot in `vendor/nightscout`.
- A transport-only polling shim for the upstream client's Socket.IO surface;
  it loads one aggregate data payload and emits the upstream `dataUpdate`.
- A response-header adapter that preserves upstream asset bytes while supplying
  the UTF-8 charset normally added by Nightscout's Express server.
- Workers-runtime and browser tests for API, SQLite, persistence, isolation and
  official-page rendering.
- No D1, R2, KV, Queues, custom domain or CGM credentials.

The API contract and current gaps are in
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

## Prototype security notice

Phase 1 is a public simulated-data lab, not a personal Nightscout deployment.
All writes require a Nightscout-compatible API-secret digest or an authorized
subject access token; the tenant selector provides storage routing, not
authorization. Missing or shorter-than-12-character `API_SECRET` configuration
fails closed with HTTP 503 for API-secret writes. A request must carry the
SHA-1 or SHA-512 hexadecimal digest in `api-secret` (or `?secret=`); the raw
passphrase is deliberately rejected on the wire. The root adapter dependency
audit is clean, while `npm ci` for the locked upstream v15.0.7 tree currently
reports 66 inherited findings (9 low, 18 moderate, 37 high, 2 critical). They
are recorded rather than silently changed because `npm audit fix` would mutate
the official release dependency graph.

## Configure API_SECRET on Cloudflare

Open **Workers & Pages → `nscf-phase1` → Settings → Variables and Secrets**,
click **Add**, select a plain-text variable, name it exactly `API_SECRET`, enter
a passphrase of at least 12 characters, then save/deploy. Its value is the raw
passphrase. A compatible Nightscout uploader normally asks for that same raw
passphrase and hashes it before sending. Secret storage
(`npx wrangler secret put API_SECRET`) is optional; both forms appear to Worker
code as `env.API_SECRET`.

Do not put a real value in `wrangler.jsonc`, commit `.dev.vars`, or paste it
into an issue. GET endpoints remain publicly readable in this phase.

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
npm test
npm run check
npm run deploy:dry
npm run deploy
```

`wrangler.jsonc` creates only Worker `nscf-phase1`, its Workers Static Assets,
and the `EntryStore` SQLite Durable Object namespace. A normal Wrangler deploy
requires an authenticated Cloudflare session and a verified Cloudflare account
email.

The automated suite currently contains 15 Workers-runtime integration tests.
It covers every shipped page route, the dynamic clock template, status and
live-data contracts, API-secret failure modes, entries, food, profile,
treatments, device status, roles/subjects, access tokens, SQLite persistence
across eviction, tenant isolation, invalid input and cleanup.

The phase-one simulated-data lab is deployed at
<https://nscf-phase1.nscf-lab-20260717.workers.dev/>. It is intentionally
limited and must not receive real health data. Deployment resources, remote
smoke evidence, CPU measurements and rollback details are documented in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

Rollback is limited to deleting this Worker, Static Assets deployment and its
Durable Object namespace; see `docs/EXECUTION_PLAN.md`.

## License and attribution

NSCF is licensed under `AGPL-3.0-only`. Nightscout contributors retain all
rights in upstream work. See `LICENSE`, `NOTICE.md`, and the preserved upstream
`vendor/nightscout/COPYRIGHT` and `vendor/nightscout/LICENSE`.
