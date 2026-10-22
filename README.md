# zeniba

A strategy-neutral, human-controlled trading assistant. Public-capable application code;
private strategy provider, private deployment, private financial records.

## Current state

A **mock-only shadow application** is implemented in TypeScript for Cloudflare Workers.
It has an authenticated owner view, a serialized SQLite Durable Object, private R2 evidence and
backup snapshots, immutable provider proposals, and version-bound Telegram webhook handling.
Only synthetic accounts and a fixed toy provider are wired into the application.

Public application source: [yogenpro/zeniba](https://github.com/yogenpro/zeniba).

**No brokerage connection, live provider calls or order-writing capability is configured.
A shadow intent is not authorization for a real trade.**

The authorized hosted mock is at **https://zeniba.yogenpro.com**, protected by owner-only
Cloudflare Access plus an independent owner credential. See [deployment](docs/DEPLOYMENT.md) for
the guarded controller-only process and [status](docs/STATUS.md) for verification limits. The
owner reports the hosted view works; that is not an independent persistence/recovery audit.
Public CI does not deploy.

A separately authorized [Schwab observation-only controller probe](docs/SCHWAB_READ_ONLY.md)
is implemented for ONE preselected empty account. It is NOT wired into the hosted app. OAuth
and two fixed account-data GET routes are tested synthetically; private setup and explicit
`--live` commands are required before any actual connection. No order/funding/transfer method,
provider call or portfolio/cash normalization exists in this probe. Real tokens may themselves
have broader capabilities; an empty account is not a substitute for access controls.

## Run locally

Requires Node **24.x** (tested with **24.19.0**) and a platform supported by Cloudflare's `workerd`.
On Linux, the pinned runtime needs glibc **2.35+**; use a compatible development environment or an
operator-supplied isolated runtime wrapper, not an in-place system-library replacement.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run local:setup
npm run dev
```

`local:setup` creates an ignored, mode-0600 `.dev.vars` with random local-only secrets and toy
Telegram IDs. It refuses to overwrite an existing file and never prints secrets; skip setup if
that file already exists. Open the loopback URL shown by Wrangler, read `OWNER_TOKEN` from that
file **locally**, and paste it into
the unlock form. Never paste it into a URL, issue, chat, recording or log. The browser keeps it
in memory only; **Lock view** clears the rendered data and credential.

Initialize, create a shadow version, record workflow events, then simulate a partial fill and
cancellation. Observe that button clicks do not create fills, repeated observations deduplicate,
and changed account state invalidates old proposals. The one-hour demo window is not a market
calendar; expiry produces no automatic new proposal. No Telegram message is sent externally.

See [local development](docs/LOCAL_DEVELOPMENT.md) for routes, storage, test coverage and limits.

## Boundaries

Read [AGENTS.md](AGENTS.md), [project boundary](docs/PROJECT.md), [status](docs/STATUS.md),
[architecture](docs/ARCHITECTURE.md), [implementation plan](docs/IMPLEMENTATION_PLAN.md), and
[provider contract](docs/STRATEGY_PROVIDER_CONTRACT.md) before extending the application.

- The application owns observation, normalization, proposal workflow, private views and durable
  reconciliation. Git is code governance, **not** the operational ledger.
- A separately operated private provider owns investment calculations. Consume a pinned release
  and opaque registered input ID; never copy strategy formulas or a research checkout here.
- `Seen`, `Skip`, `I placed orders` and `Sync` are workflow events. Only broker evidence records
  actual activity; even actual fills do not establish settlement or new spendable cash.
- Public CI uses synthetic fixtures with no private dependency, secrets or deployment step.

See [the JSON Schema](contracts/strategy-provider-v1.schema.json) and purely synthetic
[request](contracts/examples/request.json)/[response](contracts/examples/proposal.json). They
illustrate transport only, not an investment strategy, real account, signal or performance claim.

If `PRIVATE_HANDOFF.local.md` exists, read it locally. It is ignored intentionally and must never
be copied into a public issue, commit, artifact or log. Deployment-local configuration, evidence,
backups and credentials also remain ignored. Public source publication does not authorize private
strategy disclosure or live integration. Hosting the mock app requires separate operator authority.
