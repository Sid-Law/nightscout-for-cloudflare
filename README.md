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
- Minimal Nightscout v1 entries/current/status/auth startup endpoints.
- The official Nightscout v15.0.7 homepage and official chart bundle, built from
  the unmodified source snapshot in `vendor/nightscout`.
- A transport-only polling shim for the upstream client's Socket.IO surface.
- Workers-runtime and browser tests for API, SQLite, persistence, isolation and
  official-page rendering.
- No D1, R2, KV, Queues, custom domain or CGM credentials.

The API contract and current gaps are in
[`docs/UPSTREAM_COMPATIBILITY.md`](docs/UPSTREAM_COMPATIBILITY.md). The storage
and UI flow are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

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

Insert simulated data:

```sh
NSCF_NOW_MS=$(node -p 'Date.now()')
curl -X POST http://localhost:8787/api/v1/entries \
  -H 'Content-Type: application/json' \
  -H 'X-NSCF-Tenant: demo' \
  --data "{\"sgv\":123,\"date\":${NSCF_NOW_MS},\"direction\":\"Flat\",\"device\":\"nscf-simulator\"}"
```

Read it back:

```sh
curl 'http://localhost:8787/api/v1/entries.json?count=10' \
  -H 'X-NSCF-Tenant: demo'
```

Tenant names are lowercase letters/numbers followed by up to 63 lowercase
letters, numbers, `_` or `-`. The selector provides storage isolation only; it
is not access control.

## Prototype security notice

Phase 1 is a public simulated-data lab, not a personal Nightscout deployment.
Writes are unauthenticated and the tenant selector is not authorization. The
root NSCF adapter dependency audit is clean, while `npm ci` for the locked
upstream v15.0.7 tree currently reports 66 inherited findings (9 low, 18
moderate, 37 high, 2 critical). They are recorded rather than silently changed
because `npm audit fix` would mutate the official release dependency graph.
Authentication and an explicit upstream dependency remediation review are
required before any use beyond synthetic test data.

## Upstream source policy

`upstream/manifest.json` pins official release `v15.0.7`, full commit
`7e0e77f88fc113a76fe363504125f5b36b8a3fe3`, archive URL and SHA-256.
`vendor/nightscout` is an unmodified snapshot. Cloudflare-specific work stays in
`src/`, `platform/`, and `scripts/`; future unavoidable upstream changes belong
in the explicit `patches/nightscout` queue.

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
email. The current deployment attempt and evidence are documented in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

Rollback is limited to deleting this Worker, Static Assets deployment and its
Durable Object namespace; see `docs/EXECUTION_PLAN.md`.

## License and attribution

NSCF is licensed under `AGPL-3.0-only`. Nightscout contributors retain all
rights in upstream work. See `LICENSE`, `NOTICE.md`, and the preserved upstream
`vendor/nightscout/COPYRIGHT` and `vendor/nightscout/LICENSE`.
