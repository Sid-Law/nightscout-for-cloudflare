# Nightscout for Cloudflare

**English** | [简体中文](README.zh-CN.md)

Nickname: **The Instant Noodle Edition**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Sid-Law/nightscout-for-cloudflare)

This repository provides a fast and free way to deploy
[Nightscout](https://github.com/nightscout/cgm-remote-monitor) on Cloudflare.
It runs within Cloudflare's free-plan limits without a paid server or MongoDB
service. It is an independent, unofficial port—not an official Nightscout
release.

Current release: **v1.0.0-beta.1**

Upstream baseline: **Nightscout v15.0.7**

This project preserves the official Nightscout pages, layout, charts, plugins,
translations and calculations, adding only the Cloudflare platform adapter.

## Why this project exists

Nightscout is a great project. We used to be able to deploy it on Heroku for
free, but that was a long time ago. Cloudflare, meanwhile, is something of a
cyber philanthropist, but it does not support MongoDB.

Nightscout has already provided excellent instant noodles, but without a fork
or hot water (it used to have them). This project provides the fork and puts
the hot water (Cloudflare) right in front of you. Just click a few times and,
in the time it takes to make instant noodles, you can get a Nightscout.

## What works today

- Most commonly used Nightscout features are implemented
- The home page, glucose chart, trend arrow, status information and settings
  pages work
- The common read and write APIs used through v1, v2 and v3 are implemented

## What is not finished

- There is no ready-made importer for existing Nightscout/MongoDB history;
  this release is better suited to a new instance.
- [SQLite Durable Objects Free](https://developers.cloudflare.com/durable-objects/platform/pricing/)
  currently includes 5 GB of total storage, plus daily limits of 100,000
  Durable Object requests, 5,000,000 rows read and 100,000 rows written. At a
  very rough 1 KB per glucose record, 5 GB is about 17,000 days—nearly 48 years
  of readings—so it cannot store more than 48 years of glucose records.
- A small number of less common endpoints, MongoDB edge queries and third-party
  features are not yet adapted.

Even with these limitations, the current release should cover most everyday
Nightscout use.

## One-click deployment and first launch

Tutorial placeholder. A step-by-step guide will be added later.

## Technical documentation

- [Cloudflare architecture](docs/ARCHITECTURE.md)
- [Upstream compatibility matrix](docs/UPSTREAM_COMPATIBILITY.md)

## License and attribution

This project is licensed under `AGPL-3.0-only`. Nightscout contributors retain
all rights in upstream work. See `LICENSE`, `NOTICE.md`, and the preserved
`vendor/nightscout/COPYRIGHT` and `vendor/nightscout/LICENSE`.
