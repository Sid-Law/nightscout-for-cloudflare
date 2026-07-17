# Upstream compatibility

## Relationship to Nightscout

NSCF is an independent, unofficial downstream Cloudflare port of
`nightscout/cgm-remote-monitor`. It does not claim to be an upstream Nightscout
release. The long-term direction is to track upstream behavior and APIs without
changing its UI or medical algorithms. Official client code is carried
unchanged; NSCF work is confined to platform boundaries.

Upstream is AGPL-licensed and NSCF uses `AGPL-3.0-only`, retains upstream
attribution, and publishes a separate-project disclaimer in README and NOTICE.

## Locked upstream and tracking layout

- Release: `v15.0.7` (Blueberry Muffin), the latest official release observed
  2026-07-17.
- Commit: `7e0e77f88fc113a76fe363504125f5b36b8a3fe3`.
- Provenance: `upstream/manifest.json`, including the official archive SHA-256.
- Clean source snapshot: `vendor/nightscout`.
- Optional future adaptations: `patches/nightscout`; none are applied in phase 1.

The 655 vendored upstream files were compared recursively against a fresh copy
of the recorded archive after its SHA-256 was rechecked; there were no
differences. The official source includes
`tests/fixtures/api3/localhost.key`, a publicly distributed localhost test
fixture, not an NSCF or Cloudflare credential. It is retained only because the
vendor snapshot is deliberately unmodified.

The official `webpack/webpack.config.js` builds `bundle/bundle.source.js` to
`bundle.app.js`. The NSCF build EJS-renders `views/index.html` with its official
partials and publishes `static/**`, `translations/**`, and the official service
worker through Workers Static Assets.

Cloudflare's platform adapter adds the UTF-8 response charset normally supplied
by the upstream Express server. Remote and local `bundle.app.js` SHA-256 values
are identical; this adaptation changes response headers only and is covered by
an integration test.

## Phase 1 compatible surface

| Route | Implemented behavior |
| --- | --- |
| `POST /api/v1/entries` | One SGV object or an array; success is HTTP 200 with `[]`, matching the upstream empty-rejected-list convention. |
| `POST /api/v1/entries.json` | Same as above. |
| `GET /api/v1/entries.json` | Descending SGV array; `count`; millisecond `find[date][$gt/$gte/$lt/$lte]`; convenience `from`/`to`. |
| `GET /api/v1/entries/current.json` | Array containing the newest SGV, or `[]`. |
| `GET /api/v1/status.json` | Startup settings/capabilities with `runtimeState: loaded`. |
| `GET /api/v1/verifyauth` | Readable default-role response required by official client startup. |
| `GET /api/v1/adminnotifies` | Empty notification queue required by official client startup. |
| `/socket.io/socket.io.js` | Transport-only compatibility shim: v1 polling to upstream `dataUpdate`; no replacement UI. |

Returned entry fields are `_id`, optional `identifier`, `sgv`, `date`,
`dateString`, `direction`, `device`, and `type`. Minimum input is `sgv` plus
either `date` or `dateString`. Object and array POST bodies are supported.

NSCF adds `X-NSCF-Tenant` or `tenant` solely for phase-one tenant routing. If
omitted, the stable `demo` tenant is used. Upstream does not define this selector.

## Known incompatibilities and omissions

- No API secret, access tokens, writable roles, admin, or production auth yet.
- No treatments, profiles, devicestatus, food, activity, properties, full
  websocket, API v2/v3, Swagger UI, count, delete, or query-by-id endpoints.
- No MongoDB query grammar beyond the listed date operators; no SGV/type/device
  filters and no two-day implicit window.
- Invalid writes return structured HTTP 400 rather than upstream's historical
  405 behavior. Successful writes expose counts in diagnostic response headers.
- Generated IDs are 24-character hexadecimal strings but are not Mongo ObjectIds.
- The official UI/plugin/calculation code is present, but phase-one server data
  and write capabilities are limited. NSCF does not rewrite these modules.
- The Socket.IO compatibility surface uses 15-second REST polling; it is not yet
  a complete Engine.IO, WebSocket, alarm, or database-write transport.
- Installing the exact upstream v15.0.7 lockfile currently reports 66 inherited
  npm audit findings (9 low, 18 moderate, 37 high, 2 critical). Phase 1 does not
  run an automatic audit fix because that would change the pinned upstream
  dependency graph; remediation requires an explicit compatibility review.

## Tracking strategy

At each NSCF release:

1. Record and hash the upstream release/tag and commit under review.
2. Replace the clean vendor snapshot; never hand-edit it.
3. Compare upstream README API notes, Swagger/OpenAPI, build config, views,
   client transport calls, storage normalization, tests and release notes.
4. Rebase explicit compatibility patches and add fixtures before expanding routes.
5. Keep Cloudflare-specific behavior namespaced and documented.
6. Treat auth and write compatibility as blockers before real personal use.

Phase-one research baseline is the precise release/commit above and its shipped
Swagger/tests, as observed on 2026-07-17.
