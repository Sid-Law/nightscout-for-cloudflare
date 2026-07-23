# Nightscout for Cloudflare

**English** | [简体中文](README.zh-CN.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Sid-Law/nightscout-for-cloudflare)

This repository provides a fast and free way to deploy
[Nightscout](https://github.com/nightscout/cgm-remote-monitor) on Cloudflare.
It is designed to run entirely within Cloudflare's free-plan limits for
ordinary family use, without a paid server or MongoDB service. It is an
independent and unofficial port, not an official Nightscout release.

Current release: **v1.0.0-beta.1**

Upstream baseline: **Nightscout v15.0.7**

This project builds and serves the official Nightscout pages, layout, charts,
client plugins, translations and calculations. It does not replace them with a
custom user interface. Its code is the platform adapter that replaces the
Node.js, Express, MongoDB, Socket.IO server and background-task runtime.

> This release is suitable for new test deployments and simulated data. It is
> not yet a claim of complete upstream parity or a medical device, and it must
> not be used to make automatic insulin-dosing decisions.

## Why this project exists

Nightscout is a great project. We used to be able to deploy it on Heroku for
free, but that was a long time ago. Cloudflare, meanwhile, is something of a
cyber philanthropist, but it does not support MongoDB.

Nightscout has already provided excellent instant noodles, but without a fork
or hot water (it used to have them). This project provides the fork and puts
the hot water (Cloudflare) right in front of you. Just click a few times and,
in the time it takes to make instant noodles, you can get a Nightscout.

## What works today

### Official pages

- Nightscout home page, glucose chart, trend arrow and status information
- Profile Editor
- Food Editor
- Admin Tools
- Reports
- Split, multiframe and Clock pages
- v1 and v3 Swagger API documentation
- Nightscout v15.0.7 translations and client-side plugins

### Data and APIs

- Persistent storage in SQLite Durable Objects, with no MongoDB, D1 or R2
- Entries, Treatments, Device Status, Profile, Food, Settings and Activity
- The main read and write workflows required by Nightscout API v1, v2 and v3
- Contract-tested common AAPS, AndroidAPS and Loop upload shapes
- ObjectId and UUID handling, deduplication, batch writes, sorting, time
  ranges, history and soft deletion
- JSON plus the CSV, TSV and XML representations required by implemented APIs
- Profile timezone, basal, carb ratio, sensitivity, target and historical
  Profile calculations

### Authentication and permissions

- A user-defined `API_SECRET`
- Official Nightscout web authentication
- **Remember this device**
- Subjects, Roles, access tokens and API v3 JWTs
- Common Admin role and cleanup workflows

### Real-time updates

- Engine.IO 3 and Engine.IO 4
- Socket.IO polling and WebSocket transports
- Live home-page `dataUpdate`
- API v3 `/storage` events
- `/alarm` notifications, acknowledgement and silence state
- Sessions, heartbeats and pending queues that survive Durable Object eviction

### Plugins and background tasks

The current adapters include commonly used state and notification behavior for
IOB, COB, Loop, OpenAPS, Pump, Uploader Battery, CAGE, SAGE, IAGE, BAGE,
Timeago, Simple Alarm, Treatment Notify, Dexcom Error Codes, xDrip-js and
DBSize.

Tasks that previously relied on a permanently running Node.js process use
Durable Object alarms instead.

### Simulated glucose for testing

This project includes a test-only simulated CGM switch. It creates a short five-minute
glucose history and then adds one new reading every five minutes. It does not
connect to a real CGM or calculate insulin doses.

## What is not finished

The current differences from a completely equivalent upstream Nightscout
server are:

- Final acceptance with a real AAPS/Loop client and real devices has not been
  completed by the project owner
- There is no ready-made importer for an existing MongoDB history; new
  deployments are the current priority
- Arbitrary MongoDB query syntax, unrestricted regular expressions,
  aggregation pipelines and every mixed-type edge case are not implemented
- Requests cannot upload or retrieve unlimited data; explicit request, batch
  and result limits protect Cloudflare Free usage
- Engine.IO binary packets are not implemented; ordinary Nightscout JSON data
  and live page updates do not depend on them
- A small number of server plugins that depend on dynamic Node.js `require`,
  filesystem access or a permanent process still need individual adapters
- Some non-core third-party notification or voice-assistant integrations are
  not enabled
- The public Deploy-button flow and final production hardening review are
  still pending

These gaps are recorded openly. A page loading successfully is not treated as
proof of complete API, plugin or real-time compatibility. See the detailed
[upstream compatibility matrix](docs/UPSTREAM_COMPATIBILITY.md).

## Who this release is for

The first release prioritizes:

- Families creating a new Nightscout instance
- People who want free access to the official home page, charts, records,
  Profile, Admin and common upload APIs
- Users who do not need to import many years of MongoDB history
- Users willing to validate their AAPS or Loop connection on a test instance
  first

Keep an existing Nightscout deployment if you must preserve a large historical
database, depend on a server plugin that is not yet adapted, or need complete
production parity today.

## One-click deployment

Cloudflare's Deploy button can clone only a public GitHub or GitLab repository.
Once this repository is public, use the button at the top of this page.

The deployment asks for one required user setting:

> Choose your own Nightscout access password, `API_SECRET`, with at least 12
> characters.

Enter the password as plain text. Do not calculate a SHA-1 hash. After
deployment, use the same password in the Nightscout web interface, AAPS or
another uploader.

Cloudflare creates:

1. one Worker;
2. one Workers Static Assets deployment;
3. one SQLite Durable Object namespace; and
4. one encrypted `API_SECRET`.

The deployment does not create D1, R2, KV, Queues, a custom domain or a real CGM
connection.

## First launch

An empty instance redirects the first home-page visit to `/profile/`. This is
normal upstream Nightscout behavior because the database does not yet contain
a Profile.

1. Scroll to the bottom of Profile Editor and select **(Authenticate)**.
2. Enter the same `API_SECRET` chosen during deployment.
3. On your own device, enable **Remember this device**.
4. Select **Authenticate**.
5. The default `Default` Profile and `UTC` timezone can be saved as-is, or you
   can first choose your own name, timezone and units.
6. Select **Save** and wait for `Status: success`, then return to `/`.

If closing Profile Editor immediately sends you back, check whether the bottom
of the page still says `Unauthorized`. This normally means authentication was
not completed; it does not mean a required Profile field is missing or that
Cloudflare failed to save the Profile.

## Local development

Node.js 22 LTS or newer is recommended.

```sh
npm install
cp .dev.vars.example .dev.vars
```

Set a local test password in `.dev.vars`:

```dotenv
API_SECRET=choose-your-own-password
```

Then run:

```sh
npm run build
npm run check
npm test
npm run dev
```

Open <http://localhost:8787/>.

Before deployment:

```sh
npm run build
npm run check
npm test
npm run deploy:dry
npm run deploy
```

## Project boundaries

- `upstream/manifest.json` pins and verifies the upstream release
- `vendor/nightscout` contains the unmodified Nightscout v15.0.7 snapshot
- `src`, `platform` and `scripts` contain the Cloudflare adapter
- This project adds no medical algorithm and provides no dosing recommendation
- The current public test uses simulated data only

Developer documentation:

- [Deployment and first use](docs/DEPLOYMENT.md)
- [Upstream compatibility matrix](docs/UPSTREAM_COMPATIBILITY.md)
- [Cloudflare architecture](docs/ARCHITECTURE.md)
- [Implementation plan](docs/EXECUTION_PLAN.md)

## License and attribution

This project is licensed under `AGPL-3.0-only`. Nightscout contributors retain all
rights in upstream work. See `LICENSE`, `NOTICE.md`, and the preserved
`vendor/nightscout/COPYRIGHT` and `vendor/nightscout/LICENSE`.
