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
`bundle.app.js`. The NSCF build EJS-renders the official index, Admin, Profile,
Food, Reporting, Split and clock views with their upstream partials; publishes
`static/**`, `translations/**`, the service worker, Swagger UI assets and both
shipped API specifications through Workers Static Assets.

Cloudflare's platform adapter adds the UTF-8 response charset normally supplied
by the upstream Express server. Remote and local `bundle.app.js` SHA-256 values
are identical; this adaptation changes response headers only and is covered by
an integration test.

## Phase 1 compatible surface

| Route | Implemented behavior |
| --- | --- |
| `POST /api/v1/entries` | One SGV object or an array; requires a SHA-1/SHA-512 `api-secret`; success is HTTP 200 with `[]`, matching the upstream empty-rejected-list convention. |
| `POST /api/v1/entries.json` | Same as above. |
| `GET /api/v1/entries.json` | Descending SGV array; `count`; millisecond `find[date][$gt/$gte/$lt/$lte]`; convenience `from`/`to`. |
| `GET /api/v1/entries/current.json` | Array containing the newest SGV, or `[]`. |
| `GET /api/v1/status.json` | Startup settings/capabilities with `runtimeState: loaded`. |
| `GET /api/v1/status.js` | Official JavaScript status bootstrap used by clock/profile pages. |
| `GET /api/v2/properties` | Phase-one `bgnow`/delta property shape used by official clock views. |
| `GET /api/v2/ddata/at[/<at>]` | Aggregate page polling payload containing SGVs, treatments, food, profiles and device status. |
| `GET /api/v1/verifyauth` | Upstream `OK`/`UNAUTHORIZED` response contract; a valid API-secret digest reports admin/write capability. |
| `GET /api/v1/adminnotifies` | Empty notification queue required by official client startup. |
| `GET /api/versions` | Version discovery used by upstream tooling. |
| `GET/POST/PUT/DELETE /api/v1/food[...]` | Food Editor create/update/filter/delete, including regular and quick-pick routes. |
| `GET/POST/PUT/DELETE /api/v1/profile[...]` | Profile Editor first-save, current, list, update and delete. |
| `GET/POST/PUT/DELETE /api/v1/treatments[...]` | Report/careportal treatment CRUD with bounded filters. |
| `GET/POST/PUT/DELETE /api/v1/devicestatus[...]` | Device-status CRUD and live aggregation. |
| `/api/v2/authorization/roles[...]` | Default plus persisted role CRUD. |
| `/api/v2/authorization/subjects[...]` | Subject CRUD and access-token generation. |
| `/api/v2/authorization/request/<token>` | Persisted subject/role permission lookup. |
| `/socket.io/socket.io.js` | Transport-only compatibility shim: aggregate REST polling to upstream `dataUpdate`; no replacement UI. |

The upstream `/admin`, `/profile`, `/food`, `/report`, `/split`, arbitrary safe
`/clock/<face>`, `/api-docs` and `/api3-docs` pages are rendered or copied
directly from the locked release. NSCF does not rename or restyle them. Both
with-slash and without-slash page URLs are accepted by the platform adapter.
The deployed Nightscout surface has no downstream branding or public provenance
payload, and its status version is the exact upstream `15.0.7`.
Independent-project provenance remains in `upstream/manifest.json`, README and
NOTICE rather than the running UI/API.

Returned entry fields are `_id`, optional `identifier`, `sgv`, `date`,
`dateString`, `direction`, `device`, and `type`. Minimum input is `sgv` plus
either `date` or `dateString`. Object and array POST bodies are supported.

The Cloudflare storage adapter accepts an optional, unbranded `tenant` query
parameter solely for phase-one routing. If omitted, the stable `demo` tenant is
used. Upstream does not define this selector.

`API_SECRET` follows the upstream minimum of 12 characters. Cloudflare stores
the raw passphrase in the environment binding; clients transmit its 40-character
SHA-1 or 128-character SHA-512 hexadecimal digest through `api-secret` or
`secret`. Persisted role/subject access tokens are implemented for the page-used
authorization flow.

## Known incompatibilities and omissions

- The page-used role/subject/token flow exists, but the complete upstream
  authorization UI semantics and every historical permission edge case are not
  claimed.
- API v3 Swagger documentation is shipped unchanged, but the generic API v3
  runtime is not implemented. Historical v1/v2 routes not used by the shipped
  pages may also be absent.
- The bounded Mongo-style query subset supports equality, nested paths,
  `$gt/$gte/$lt/$lte/$ne/$exists/$in`, sort and report literal search; arbitrary
  Mongo operators, aggregations and server-side regular expressions do not.
- Invalid writes return structured HTTP 400 rather than every historical
  upstream error/status variant.
- Generated IDs are 24-character hexadecimal strings but are not Mongo ObjectIds.
- Summary/activity persistence, notifications, plugin-specific background jobs,
  alarms and Mongo change streams are not implemented.
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
6. Expand fixtures route-by-route before claiming complete historical
   authorization, API v3, plugin or real-time compatibility.

Phase-one research baseline is the precise release/commit above and its shipped
Swagger/tests, as observed on 2026-07-17.
