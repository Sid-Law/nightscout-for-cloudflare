# Nightscout patch queue

`vendor/nightscout` is kept byte-for-byte equivalent to the extracted official
release archive identified by `upstream/manifest.json`. Do not edit it in place.

Phase 1 currently needs no upstream source patch. The official Webpack bundle,
EJS page, static files, translations, plugins and client calculations are built
as released. Cloudflare differences are implemented in `src/`, `platform/`, and
`scripts/`.

If a future runtime incompatibility cannot be isolated at the platform edge,
store a numbered, reviewable patch here (for example `0001-worker-transport.patch`)
and make the build apply it to a disposable worktree. Each patch must name the
upstream tag/commit and must not redesign UI or change medical calculations.
