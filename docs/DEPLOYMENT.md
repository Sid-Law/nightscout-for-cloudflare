# Phase 1 deployment record

Last synchronized: 2026-07-17

## Current status

Remote deployment is **blocked by an external account prerequisite**, not by a
code or Cloudflare runtime failure. The authorized Cloudflare API rejected the
first upload of Worker `nscf-phase1` with:

```text
Cloudflare API error 10034: You need to verify your email address to use Workers.
```

Cloudflare's response links to its account email-verification instructions at
<https://developers.cloudflare.com/fundamentals/setup/account/verify-email-address/>.
The public OpenAPI schema has no operation that can complete this verification;
the mailbox owner must follow Cloudflare's verification email.

## Cloudflare state

- Account `workers.dev` subdomain: initialized as `nscf-lab`.
- Intended Worker: `nscf-phase1`.
- Intended public URL after deployment:
  `https://nscf-phase1.nscf-lab.workers.dev/`.
- Worker scripts created by this task: none (upload rejected before creation).
- Durable Object classes/namespaces created by this task: none.
- D1, R2, KV, Queues, custom domains, routes and other resources: none.
- A temporary account-less Quick Tunnel was investigated as an asset transport
  fallback, but outbound TCP/7844 was blocked. It never registered a connector;
  its process was stopped and its one-time credential file was deleted.

## Local verification evidence

| Check | Result |
| --- | --- |
| TypeScript | `tsc --noEmit` passed |
| Workers integration tests | 1 file, 8 tests passed; latest run 318 ms total |
| Official UI build | Nightscout v15.0.7 Webpack build passed |
| Vendor integrity | 655 files identical to re-hashed official release archive |
| Official main bundle | 2.07 MiB, unchanged upstream build output |
| Static Assets dry run | 201 asset entries read from `public/` |
| Worker dry-run upload | 16.29 KiB raw / 5.20 KiB gzip |
| Browser console | 0 errors, 0 warnings |
| Browser API calls | status, translations, adminnotifies, verifyauth and entries all HTTP 200 |
| SQLite/API closure | 12 simulated SGVs inserted; newest three read back as 124/127/131 |
| Official page closure | title `124 -3 →`; Blood Sugar `124`; chart present with history |

The browser evidence is saved as `outputs/local-official-nightscout.png`.

## Workers Free 10 ms CPU assessment

`wrangler.jsonc` explicitly sets `limits.cpu_ms` to `10`, and the dry run accepts
that configuration. Local Miniflare wall-clock logs are not production CPU
measurements, but steady-state entry reads were usually 2–9 ms wall time; status
and auth helpers were generally 1–7 ms. The first 12-entry SQLite write logged
20 ms wall time and includes local runtime/storage overhead, so it cannot prove
or disprove the remote 10 ms CPU budget.

The implementation limits POST bodies to 64 KiB, batches to 100, history to
1,000, uses a date index and synchronous SQLite operations, and serves all UI
work through Static Assets. Actual Cloudflare invocation CPU must be recorded
from remote observability after the account is verified; this is still a phase
1 completion item.

## Resume and smoke test

After the mailbox owner verifies the Cloudflare account email:

1. Re-run the authorized Worker upload/deploy. The expected footprint is only
   Worker `nscf-phase1`, its Static Assets, and SQLite class `EntryStore` via
   migration tag `v1`.
2. Enable the script's workers.dev route with preview URLs disabled.
3. POST a fresh simulated SGV batch to `/api/v1/entries`.
4. Verify history, current and status responses at the public URL.
5. Open the public root in a real browser and confirm the official Nightscout
   chart renders those stored values with no console errors.
6. Record version/deployment identifiers and remote CPU evidence here.

## Rollback

Delete Worker `nscf-phase1` and, if retained separately by Cloudflare, its
`EntryStore` Durable Object namespace. Optionally remove the account-wide
`nscf-lab.workers.dev` subdomain. No other product cleanup is required.
