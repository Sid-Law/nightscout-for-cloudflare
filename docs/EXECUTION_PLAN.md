# Phase 1 execution plan

Last synchronized: 2026-07-17

## Goal and fixed scope

Phase 1 delivers a vertically complete public test port on Workers Free: the
official Nightscout v15.0.7 homepage and Webpack bundle, one ES-module Worker,
one SQLite-backed Durable Object class, the minimum status/auth/entries and
polling transport required by that homepage, local runtime/browser tests, and a
remote smoke test. Only simulated SGV data is allowed.

Out of scope: real CGM credentials or health data, production authentication,
write-capable treatments/profiles, D1, R2, KV, Queues, custom domains, and a
GitHub repository. NSCF must not design a replacement UI; the upstream UI,
charts, plugins, translations and calculations remain upstream code.

## Steps and completion evidence

1. Initialize the account `workers.dev` subdomain through the Cloudflare API.
   Result: `nscf-lab`.
2. Lock the latest official release. Result: `v15.0.7` at commit
   `7e0e77f88fc113a76fe363504125f5b36b8a3fe3`; record archive provenance.
3. Vendor the unmodified release and build its official Webpack bundle, EJS
   homepage, static files, translations and service worker.
4. Implement a tenant-sharded `EntryStore` Durable Object using embedded SQLite.
5. Implement the minimum v1 status/auth/entries routes and a transport-only
   Socket.IO surface shim that polls entries and emits upstream `dataUpdate`.
6. Run generated-binding checks, Workers-runtime tests, and a real-browser test
   proving the official page draws simulated SGV data.
7. Upload the Worker plus Workers Static Assets and enable its `workers.dev` route.
8. Run the same remote write/read/official-page smoke test, record timings and
   resources in `docs/DEPLOYMENT.md`, then commit the verified local repository.

## Current execution status

Steps 1–6 are complete. `npm run build`, TypeScript validation, all eight
Workers-runtime integration tests, the Wrangler deployment dry run, and a real
browser rendering test have passed. The browser test wrote 12 simulated SGVs to
local SQLite Durable Object storage and the untouched official Nightscout page
rendered current value `124`, delta `-3`, direction `→`, age and chart history.

Step 7 was attempted through the authorized Cloudflare API on 2026-07-17. The
platform rejected the first Worker upload with API error `10034`: the new
Cloudflare user's email address must be verified before Workers can be used.
There is no public API endpoint for completing account-email verification; the
mailbox owner must open Cloudflare's verification message. No Worker or Durable
Object namespace was created by the rejected upload. Step 7 and the remote part
of step 8 remain pending only on that account prerequisite. See
`docs/DEPLOYMENT.md` for exact evidence and the resume procedure.

## Completion standard

- `workers.dev` initialized and recorded.
- Worker, Workers Static Assets and SQLite Durable Object deployed.
- Both POST entry paths, history, current, status and startup auth helpers behave
  as documented.
- Tests cover HTTP behavior, SQLite persistence, tenant isolation, idempotence,
  invalid input, current selection, time/count filtering and UI provenance.
- The official Nightscout homepage renders current SGV, direction, age and its
  official chart from data persisted in the Cloudflare adapter.
- README, architecture, compatibility, deployment evidence, and this plan match
  the code and deployed state.

## Risks and controls

- **Public unauthenticated writes:** deployment is explicitly a simulated-data lab;
  never send real data. Authentication is a phase-two blocker for personal use.
- **10ms CPU ceiling:** bound POST batches to 100, GET to 1,000, use indexed SQLite
  queries, keep UI work in static assets, and avoid server-side frameworks.
- **Compatibility drift:** pin contracts in tests and compare upstream README,
  shipped Swagger/OpenAPI, releases and endpoint tests on each update.
- **Upstream provenance drift:** never edit `vendor/nightscout` in place; update
  the manifest/archive hash, then rebase an explicit patch queue if needed.
- **Node Socket.IO coupling:** phase 1 supplies only the homepage-used client
  surface and REST polling. Full Engine.IO/WebSocket compatibility remains later.
- **Tenant header is not authorization:** tenant names select a DO only; they do
  not prove identity or provide access control.
- **Fresh platform behavior:** validate Wrangler metadata against its bundled
  schema and use official API responses as deployment evidence.

## Rollback

The Cloudflare footprint consists only of Worker `nscf-phase1`, its Static
Assets deployment, and the `EntryStore` SQLite Durable Object namespace created
by its `v1` migration. Delete that Worker through Wrangler or the Workers API to
remove the active route; delete the associated namespace separately if the
platform retains it. The account-wide `nscf-lab.workers.dev` subdomain can be
retained for later workers or deleted through the account subdomain API. No
D1/R2/Queue/custom-domain cleanup is needed because none is created.
