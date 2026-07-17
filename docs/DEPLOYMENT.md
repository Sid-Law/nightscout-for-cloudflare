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
- Deployment ID: `ff412019-ba1d-48ab-a389-ead053bd6ad0`
- Version ID: `b5d23db9-7ace-430d-ae13-65e753a774e5` at 100% traffic
- Worker ETag: not emitted by Wrangler 4.111.0 for this upload
- Worker module SHA-256:
  `0c621744c4724668d619400425b8b7d7f3496832f721c6129aed175f32c668b6`
- Durable Object: class `EntryStore`, SQLite backend, migration tag `v1`
- Static Assets: 214 files represented by 248 Wrangler asset entries
- Observability and invocation logs: enabled

The rebuilt official assets were byte-identical to the preceding deployment,
so Wrangler uploaded no changed asset files. It uploaded the Worker module that
adds tenant JWT persistence, Shiro-compatible permissions and API v3 status.
The deployment retained the existing dashboard variables with `--keep-vars`;
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
| Type generation | `wrangler types` completed |
| TypeScript | `tsc --noEmit` passed |
| Workers integration tests (historical deployment gate) | 1 file, 19/19 passed |
| Static Assets dry run | 248 entries read |
| Worker dry run | 68.82 KiB raw / 16.80 KiB gzip |
| Worker startup | Cloudflare reported 6 ms |

The locked upstream contains 111 JavaScript test files and approximately 873
test cases. At that recorded deployment, 19 adapter tests formed the gate for
the implemented subset; the current local suite count is maintained in the
README and compatibility matrix. Neither count proves complete compatibility.

## Post-deployment evidence

Cloudflare recorded the final deployment at 2026-07-17 17:24:29 UTC. The smoke
test verifies response content, not merely a successful Wrangler command. The
preceding deployment also demonstrated that edge propagation may take tens of
seconds: a request about 22 seconds after that deployment still reached its
old version, while the new version was active by about 44 seconds.

| Check | Result |
| --- | --- |
| `/` | HTTP 200, `text/html; charset=utf-8` |
| `/admin/` | HTTP 200, official Admin Tools asset |
| `/clock/clock-color/` | HTTP 200, official clock asset |
| `/api/v3/version` | HTTP 200; v15.0.7, API `3.0.3-alpha`, SQLite DO adapter metadata |
| `/api/v3/status` without JWT | HTTP 401; `Missing or bad access token or JWT` |
| `/api/v3/status` with malformed JWT | HTTP 401; `Bad access token or JWT` |
| `/api/v2/authorization/request/not-a-subject` | HTTP 401; upstream `description: Invalid/Missing` field |
| Anonymous `/api/v1/verifyauth` | HTTP 200; read-only DEFAULT/NOTFOUND/UNAUTHORIZED contract |
| `/api/v2/ddata/at` | HTTP 200; aggregate page payload includes the persisted profile |
| `/api/v1/profile/current` | HTTP 200; current profile remains persisted |
| `/api/v1/activity?count=2` | HTTP 200 and an empty JSON list for the current simulated tenant |
| Unknown API route | HTTP 404 with the current compatibility-adapter message |
| Real Engine.IO polling endpoint | HTTP 404, correctly retained as an explicit compatibility gap |

A real Chrome session loaded `/profile/`. The official page moved from
`Not loaded` to `Values loaded`, selected the persisted profile and rendered
the upstream editor controls. Its existing browser authorization reported
`Admin authorized`. Clicking the official Save button produced `success` and
the console message `profile saved`; a subsequent public
`/api/v1/profile/current` read returned the new `_id`, current `created_at` and
updated profile contents.

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

After deployment, the existing browser required no manual cache clearing. The
homepage remained open without a JavaScript dialog or profile redirect and
rendered `BASAL 0.100U`. Repeating the exact `/profile` → official `X` close
workflow returned to `/`, remained there for five seconds, and retained the
same basal rendering. Standalone Profile Editor warnings about the absent main
chart container remain upstream page behavior and are unrelated.

Activity CRUD, conditional `Last-Modified`/`If-Modified-Since`,
entries/document CRUD, authorization failure modes, persistence and tenant
isolation were also exercised in the local Workers/SQLite integration suite.
The expanded suite additionally covers eight-hour HS256 JWT issue/refresh,
signature tamper and expiry rejection, DO eviction, cross-tenant rejection,
subject deletion invalidation, exact Shiro matching and JWT-only API v3 status.

A real Chrome reload after this deployment remained on the official homepage,
showed the persisted `BASAL 0.100U`, had no JavaScript dialog or redirect and
reported no warning/error console entries. The browser's existing
authorization state was not inspected or printed.

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
- Engine.IO/Socket.IO is not implemented. The shipped browser file is a
  page-used REST polling adapter.
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

Deploy the prior known-good UI/API-subset version
`87b53ac1-ded3-4afa-8b45-ea6b9830a673` at 100% traffic, or delete Worker
`nscf-phase1` and then its Durable Object namespace if the whole lab is being
removed. That preceding version contains the content-addressed cache fix but
does not contain the tenant JWT/API v3 status increment. The SQLite v3 secret
table is forward-compatible and can remain unused by the preceding module.
No D1/R2/KV/Queue/custom-domain cleanup is required.
