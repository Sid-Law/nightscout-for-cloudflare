# Phase 1 architecture

## Request and data flow

```text
Official Nightscout v15.0.7 browser bundle / compatible uploader
        |
        | static HTML/CSS/JS, v1 API, transport polling
        v
Cloudflare Worker (nscf-phase1) + Workers Static Assets
  - official upstream page/assets
  - API_SECRET write authentication, bounded parsing and tenant routing
  - Socket.IO client-surface polling adapter
        |
        | ENTRY_STORE.getByName(tenant), typed RPC
        v
EntryStore Durable Object (one logical instance per tenant)
        |
        | synchronous SQL API
        v
Embedded SQLite
  - entries table
  - unique server id / upstream-style date+type dedupe
  - descending date index
  - local schema migration table
```

Workers Static Assets serves a build of upstream `views/index.html`,
`bundle/bundle.source.js`, `static/**`, `translations/**`, and the upstream
service worker. NSCF contains no alternative page, chart, component, CSS theme,
plugin implementation, translation, or medical calculation.

Nightscout's Express server supplies UTF-8 in response headers, while the
upstream homepage itself has no `<meta charset>`. Cloudflare Static Assets
normalizes stored HTML and JavaScript media types without that charset. Text
asset paths therefore run through the Worker first; it streams the unchanged
asset response and appends `charset=utf-8` to text, JavaScript, JSON, XML and SVG
media types. Binary assets continue to use the direct Static Assets path. This
is a platform response-header adaptation, not a source or UI fork.

The official client expects Socket.IO and consumes a `dataUpdate` runtime shape
rather than loading entries directly. At `/socket.io/socket.io.js`, a thin NSCF
transport adapter implements only the homepage-used `connect`, `authorize`,
`subscribe`, `loadRetro`, and `dataUpdate` surface. It polls the v1 entries API,
maps stored `{sgv,date}` rows to upstream `{mgdl,mills}` runtime records, and then
hands control to the untouched upstream client/chart/plugin code. This is the
phase-one replacement for the long-lived Node Socket.IO server, not a UI fork.

Before a POST can reach storage, the Worker requires `API_SECRET` to be present
as a Cloudflare environment binding and at least 12 characters long. It hashes
the configured raw passphrase with SHA-1 and SHA-512 through Web Crypto and
compares the supplied `api-secret` header (or `secret` query parameter) with
the hexadecimal digests. Raw passphrases on the request wire are rejected.
Missing configuration fails closed; phase-one GET routes remain public.

The Worker is otherwise stateless. `X-NSCF-Tenant` (or the `tenant` query
parameter) is validated and passed to `ENTRY_STORE.getByName()`. The default is
`demo`. A deterministic name always routes one tenant to the same strongly
consistent DO; different names route to separate DO instances and separate
SQLite databases. This is isolation by storage shard, not authentication.

`EntryStore` uses RPC rather than an internal HTTP hop. Its constructor uses
`blockConcurrencyWhile()` only for idempotent schema setup. Critical data is
written synchronously before returning. The upstream v15.0.7 rule of one SGV per
normalized timestamp/type is represented by a unique dedupe key; client UUIDs
are preserved as `identifier`, while valid 24-hex IDs may be retained as `_id`.

## Why no D1 or R2 in phase 1

D1 would centralize cross-tenant relational queries, but phase 1 needs the
opposite property: strongly consistent per-tenant state with the smallest
possible operational footprint. Each DO already contains SQLite, so D1 would
duplicate storage and add an unnecessary resource.

R2 is intended for objects and large blobs. SGV records are small structured
rows and need range ordering and uniqueness. Official browser files are served
by Workers Static Assets, so R2 is also unnecessary for the UI.

Queues, KV and custom domains are intentionally absent from `wrangler.jsonc`.

## Runtime and safety boundaries

- Maximum request body: 64 KiB; maximum POST batch: 100 entries.
- SGV range accepted by this prototype: integer 20–600 mg/dL.
- History count defaults to 10 and is capped at 1,000.
- Official UI and calculations are not changed; no NSCF dosing logic exists.
- `API_SECRET` is the only application credential. It is a Cloudflare binding,
  never a committed Wrangler variable; the current lab uses a plain-text
  dashboard variable at the owner's request.
- The polling shim is transport-only, runs every 15 seconds and has no medical or
  display logic.
- Text asset responses are streamed rather than buffered when UTF-8 headers are
  adapted, keeping the extra Worker CPU and memory work constant.
