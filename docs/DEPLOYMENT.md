# Current deployment record

Last synchronized: 2026-07-18 (Asia/Shanghai)

## Status

The public Worker is deployed and healthy, but it is **not a complete
Nightscout port**. It serves the locked official v15.0.7 browser assets and the
compatibility subset recorded in `UPSTREAM_COMPATIBILITY.md`. Page availability
is not counted as server/API/plugin compatibility.

- Public URL: <https://nscf-phase1.nscf-lab-20260717.workers.dev/>
- Account ID: `fad59c859cb78943d97441581dfcab78`
- Worker: `nscf-phase1`
- Deployed code commit: `78502a01c624d3f8b38e207abd5b7c9d1cea50c8`
- Deployment ID: `f2d15877-631a-4645-b43a-24be65a4818d`
- Version ID: `e3e9b197-bd1d-45b1-b2c8-a5b18b907e90` at 100% traffic
- Worker ETag: not emitted by Wrangler 4.111.0 for this upload
- Worker module SHA-256:
  `4b2e0f607528f531621d5857af9422c3fb8931fcc8c0acdbb1340beb74c01f15`
- Durable Object: class `EntryStore`, SQLite backend, migration tag `v1`
- Static Assets: 214 files represented by 248 Wrangler asset entries
- Observability and invocation logs: enabled

The rebuilt official assets were byte-identical to the preceding deployment,
so Wrangler uploaded no changed asset files. It uploaded the Worker module that
adds the deterministic upstream contract inventory, the treatments-focused
SQLite schema-v4/repository slice and isolated Engine.IO 3/4 plus Socket.IO 4/5
protocol codecs. The codecs are not routed as a session server yet. The
deployment retained the existing dashboard variables with `--keep-vars`;
application code and tests never read or print the configured credential.

## Cloudflare footprint

The project uses exactly:

1. one Worker;
2. one Workers Static Assets deployment;
3. one SQLite Durable Object namespace.

It does not create or use D1, R2, KV, Queues, a custom domain or a zone route.
The public instance is for simulated data only.

## Pre-deployment gate

| Check | Result |
| --- | --- |
| Locked upstream | `nightscout/cgm-remote-monitor` v15.0.7, pinned commit and archive hash verified |
| Official UI build | Upstream Webpack production bundle completed |
| Upstream route/test audit | 161 registrations and 111 test files; generated outputs deterministic |
| Audit tool tests | 14/14 Node tests passed |
| Type generation | `wrangler types` completed |
| TypeScript | `tsc --noEmit` passed |
| Workers integration tests | 5 files, 75/75 passed |
| Static Assets dry run | 248 entries read |
| Worker dry run | 115.92 KiB raw |
| Worker startup | Cloudflare reported 6 ms |

The locked upstream contains 111 JavaScript test files and approximately 873
test cases. The 75 Workers tests form the gate for the implemented adapter
subset; no whole upstream test file is claimed green yet. Neither count proves
complete compatibility.

## Post-deployment evidence

Cloudflare recorded the final deployment at 2026-07-18 03:47:50 UTC. The smoke
test verifies response content, not merely a successful Wrangler command. The
preceding deployment also demonstrated that edge propagation may take tens of
seconds: a request about 22 seconds after that deployment still reached its
old version, while the new version was active by about 44 seconds.

| Check | Result |
| --- | --- |
| `/` | HTTP 200, `text/html; charset=utf-8` |
| `/healthz` | HTTP 200 with the expected upstream/storage adapter metadata |
| `/api/v3/version` | HTTP 200; v15.0.7, API `3.0.3-alpha`, SQLite DO adapter metadata |
| `/api/v3/status` without JWT | HTTP 401; `Missing or bad access token or JWT` |
| `/api/v2/ddata/at` | HTTP 200; aggregate page payload includes the persisted profile |
| `/api/v1/profile/current` | HTTP 200; current profile remains persisted |
| `/api/v1/activity?count=2` | HTTP 200 and an empty JSON list for the current simulated tenant |
| `/socket.io/?EIO=4&transport=polling` | HTTP 404, correctly retained as an explicit compatibility gap; protocol codecs alone are not routed |

A real Chrome session loaded `/profile/`. The official page reported
`Values loaded`, selected the persisted `Profile11111111` profile with
`Asia/Shanghai`, and rendered the upstream editor controls. Its existing
browser authorization reported `Admin authorized`. Clicking the one official
Save button with the existing simulated profile values produced
`Status: success`.

That same browser exposed a stale-cache compatibility failure after the first
save: v15.0.7's service worker had cached an earlier
`/socket.io/socket.io.js` adapter. That older adapter omitted `profiles`, so
the untouched basal plugin produced its upstream missing-profile warning and
redirected `/` back to `/profile`. The final build now:

1. preserves upstream's first-data-before-authorize server ordering;
2. derives an adapter hash (`ab4e533ad279`) from its actual bytes;
3. loads the adapter and registers `/sw.js` through versioned URLs;
4. opts service-worker updates out of the HTTP cache; and
5. no longer precaches the unversioned adapter.

After deployment, the existing browser required no manual cache clearing.
Repeating the exact `/profile` → official `X` close workflow returned to `/`,
remained there for six seconds, and rendered `BASAL 0.100U`. A subsequent real
browser reload remained on `/`, still rendered the basal value, did not reopen
Profile Editor and had no JavaScript dialog.

The same real browser rendered the official Admin Tools, Food Editor,
Nightscout reporting and color-clock pages. Admin showed the seven default
roles, Food reported `Database loaded`, Report rendered its report selector and
filters, and the simulated empty clock showed the upstream `No data found in
DB` state. There were no console errors. The official standalone subpages emit
the existing `Unable to find element for #chartContainer` warning because they
do not include the homepage chart container; that warning is not a failed API
or a profile redirect.

Activity CRUD, conditional `Last-Modified`/`If-Modified-Since`,
entries/document CRUD, authorization failure modes, persistence and tenant
isolation were also exercised in the local Workers/SQLite integration suite.
The expanded suite additionally covers eight-hour HS256 JWT issue/refresh,
signature tamper and expiry rejection, DO eviction, cross-tenant rejection,
subject deletion invalidation, exact Shiro matching and JWT-only API v3 status.

A real Chrome reload after this deployment remained on the official homepage,
showed the persisted `BASAL 0.100U`, and had no JavaScript dialog or redirect.
The browser's credential material and storage were not inspected or printed.

## Historical remote closure evidence

Before this deployment, the same Worker/DO footprint had already completed a
simulated-data closure run covering authorized entry insertion, idempotent
retry, SQLite persistence, tenant isolation, official chart rendering and the
main page-data endpoints. That evidence remains useful for regression context,
but it does not expand the current compatibility claim.

The earlier observability window covered 129 invocations:

| CPU metric | Time |
| --- | ---: |
| Average | 1.14 ms |
| Median | 1 ms |
| p95 | 2 ms |
| Maximum | 4 ms |

These figures are historical measurements, not a guarantee for unimplemented
full-port workloads.

## Known limitations

- Public reads and the tenant selector are not a private-health-data security
  boundary; simulated data only.
- Engine.IO/Socket.IO session handling is not implemented. Versioned EIO4/SIO5
  and legacy EIO3/SIO4 packet codecs are isolated and tested, but the shipped
  browser file remains a page-used REST polling adapter and `/socket.io/`
  polling handshakes still return 404.
- API v1 and v2 are subsets. API v3 currently exposes only the public version
  envelope and JWT-protected status; generic CRUD, lastModified, history and
  tombstones remain missing.
- JWT signing, expiry and Shiro permission matching are implemented, but the
  upstream access-token derivation/prefix behavior, request-body credentials
  and persistent per-IP failure delay list remain missing.
- MongoDB query, BSON ObjectId, index and update semantics are only partially
  mapped to SQLite.
- Server plugin jobs, real-time database broadcasts, notifications, summary
  persistence and alarm-driven background work remain incomplete.
- The official pages are present, but every workflow has not yet passed an
  upstream-derived browser contract.
- No medical algorithm or dosing advice was added.

See `UPSTREAM_COMPATIBILITY.md` for the evidence matrix and
`EXECUTION_PLAN.md` for the delivery order.

## Rollback

Deploy the prior known-good UI/JWT/API-subset version
`b5d23db9-7ace-430d-ae13-65e753a774e5` (deployment
`ff412019-ba1d-48ab-a389-ead053bd6ad0`) at 100% traffic, or delete Worker
`nscf-phase1` and then its Durable Object namespace if the whole lab is being
removed. That preceding version contains the content-addressed cache fix and
tenant JWT/API v3 status increment, but not the schema-v4 treatments repository
or protocol codecs. Schema-v4 is additive and preserves legacy document bodies;
rollback must not attempt a destructive SQLite downgrade.
No D1/R2/KV/Queue/custom-domain cleanup is required.
