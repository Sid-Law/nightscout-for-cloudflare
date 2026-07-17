# Phase 1 execution plan

Last synchronized: 2026-07-17

## Goal and fixed scope

Phase 1 delivers a vertically complete public test port on Workers Free: every
official Nightscout v15.0.7 page route, the official Webpack bundle and static
assets, one ES-module Worker, one SQLite-backed Durable Object class, page-backed
CRUD, API-secret plus role/subject authentication, aggregate polling, local
runtime tests and remote page/API smoke tests. Only simulated data is allowed.

Out of scope: real CGM credentials or health data, D1, R2, KV, Queues, custom
domains, a GitHub repository, complete historical API v1/v2/v3 coverage, and a
full Engine.IO/WebSocket server. NSCF must not design a replacement UI; the
upstream UI, charts, plugins, translations and calculations remain upstream
code.

## Steps and completion evidence

1. Initialize the account `workers.dev` subdomain through the Cloudflare API.
   Result: `nscf-lab-20260717` (`nscf-lab` was unavailable).
2. Lock the latest official release. Result: `v15.0.7` at commit
   `7e0e77f88fc113a76fe363504125f5b36b8a3fe3`; record archive provenance.
3. Vendor the unmodified release and build its official Webpack bundle, EJS
   homepage and secondary pages, Swagger pages, static files, translations and
   service worker.
4. Implement a tenant-sharded `EntryStore` Durable Object using embedded SQLite.
5. Implement entries and generic SQLite document storage for food, profiles,
   treatments, device status, roles and subjects; add Nightscout-compatible
   API_SECRET and access-token authorization.
6. Implement status, properties, aggregate live-data and the page-used query
   subset; add a transport-only Socket.IO surface shim that polls the aggregate
   endpoint and emits upstream `dataUpdate`.
7. Run generated-binding checks, Workers-runtime tests, and real-browser tests
   proving the official page draws simulated SGV data.
8. Upload the Worker plus Workers Static Assets and enable its `workers.dev` route.
9. Run remote page/API/write/read smoke tests, record timings and
   resources in `docs/DEPLOYMENT.md`, then commit the verified local repository.

## Current execution status

All implementation and deployment steps are complete. `npm run build`,
TypeScript validation, all 15 Workers-runtime integration tests and the Wrangler
deployment dry run passed. The public Worker is `nscf-phase1`; every official
page route returns the locked upstream page, including Admin, Profile, Food,
Reporting, Split, clock faces and both Swagger pages.

The final remote page/read smoke passed. The current dashboard `API_SECRET` is
present—an invalid digest returns HTTP 401 rather than the missing-binding
HTTP 503—but it no longer matches the earlier test value, so the final
credentialed remote CRUD rerun correctly stopped at 401. The same deployed
build's write paths are covered by the 15 local Workers/SQLite tests, while an
earlier authorized remote closure proved Worker-to-DO persistence and official
chart rendering. No credential was read, replaced or logged during final
verification.

Remote browser testing exposed two Cloudflare-specific routing couplings:
Static Assets needed the UTF-8 response charset normally supplied by Express,
and clean page URLs needed explicit no-slash/with-slash routing through the
Worker. Both are platform adaptations with tests; upstream UI bytes remain
unchanged. See `docs/DEPLOYMENT.md` for resource IDs and verification evidence.

## Completion standard

- `workers.dev` initialized and recorded.
- Worker, Workers Static Assets and SQLite Durable Object deployed.
- Entries, food, profile, treatments, device-status, roles, subjects, status,
  properties, live-data and startup auth helpers behave as documented.
- Tests cover HTTP behavior, SQLite persistence, tenant isolation, idempotence,
  invalid input, current selection, time/count filtering, CRUD, access tokens
  and UI provenance.
- The official Nightscout homepage renders current SGV, direction, age and its
  official chart from data persisted in the Cloudflare adapter.
- README, architecture, compatibility, deployment evidence, and this plan match
  the code and deployed state.

## Risks and controls

- **Write authentication:** every write requires a SHA-1/SHA-512 digest of the
  configured `API_SECRET` or an authorized subject access token; missing
  API_SECRET configuration fails closed for API-secret writes. Reads remain
  public, so the deployment is still limited to simulated-data validation.
- **10ms CPU ceiling:** bound POST batches to 100, GET to 1,000, use indexed
  SQLite queries, stream the small text-header adaptation, and avoid server-side
  frameworks. Cloudflare telemetry over 129 phase-one invocations measured 1 ms
  median, 2 ms p95 and 4 ms maximum CPU.
- **Compatibility drift:** pin contracts in tests and compare upstream README,
  shipped Swagger/OpenAPI, releases and endpoint tests on each update.
- **Upstream provenance drift:** never edit `vendor/nightscout` in place; update
  the manifest/archive hash, then rebase an explicit patch queue if needed.
- **Node Socket.IO coupling:** phase 1 supplies only the page-used client surface
  and aggregate REST polling. Full Engine.IO/WebSocket compatibility remains
  later.
- **Tenant header is not authorization:** tenant names select a DO only; they do
  not prove identity or provide access control.
- **Fresh platform behavior:** validate Wrangler metadata against its bundled
  schema and use official API responses as deployment evidence.

## Rollback

The Cloudflare footprint consists only of Worker `nscf-phase1`, its Static
Assets deployment, and the `EntryStore` SQLite Durable Object namespace created
by its `v1` migration. Delete that Worker through Wrangler or the Workers API to
remove the active route; delete the associated namespace separately if the
platform retains it. The account-wide `nscf-lab-20260717.workers.dev` subdomain
can be retained for later workers or deleted through the account subdomain API.
No D1/R2/Queue/custom-domain cleanup is needed because none is created.
