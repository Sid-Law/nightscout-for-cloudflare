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
- Deployment ID: `d5e654c1-7f28-4a6f-8be0-498c677753c9`
- Version ID: `87b53ac1-ded3-4afa-8b45-ea6b9830a673` at 100% traffic
- Worker ETag:
  `2c45e62276ba6bdb985c947efdfa9ff953a28467da37e4f2f09c8a8fb5516e92`
- Worker module SHA-256:
  `3b0a0fdc859aa51abb090ea6557b6f7e45009fe9aac28ee5665a81a83bb9ff1d`
- Durable Object: class `EntryStore`, SQLite backend, migration tag `v1`
- Static Assets: 214 files represented by 248 Wrangler asset entries
- Observability and invocation logs: enabled

Wrangler uploaded six changed official/generated static entries: `/index.html`,
the four secondary editor/report pages that load the transport adapter, and
`/sw.js`. The Worker module ETag remained unchanged. The deployment retained
the existing dashboard variables with `--keep-vars`; application code and
tests never read or print the configured credential.

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
| Workers integration tests | 1 file, 17/17 passed |
| Static Assets dry run | 248 entries read |
| Worker dry run | 50.37 KiB raw / 12.44 KiB gzip |
| Worker startup | Cloudflare reported 4 ms |

The locked upstream contains 111 JavaScript test files and approximately 873
test cases. The 17 adapter tests are a deployment gate for the implemented
subset, not evidence of complete compatibility.

## Post-deployment evidence

Cloudflare recorded the final deployment at 2026-07-17 16:51:48 UTC. The smoke
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
  envelope; generic CRUD, history, tombstones and JWT security remain missing.
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

Deploy the immediately preceding version
`c57bd113-3e13-4211-b5a3-00501f3b4852` at 100% traffic, or delete Worker
`nscf-phase1` and then its Durable Object namespace if the whole lab is being
removed. That preceding version does not contain the final content-addressed
cache bypass and may reproduce the profile redirect in an existing browser.
No D1/R2/KV/Queue/custom-domain cleanup is required.
