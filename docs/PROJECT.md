# Project boundary and user direction

## Goal

Build a strategy-neutral assistant: private automated proposals, human execution control,
and durable monitoring of actual account activity. Keep research and investment logic outside
this public-capable codebase. The user selected the name `zeniba` and a private remote strategy
service, allowing a Workers application to call a Python calculation running elsewhere.

## Initial scope

- Manual execution in Schwab; observation, reconciliation and proposed instructions only.
- Telegram notifications plus private detailed views; Git is code governance, not the ledger.
- Cloudflare-compatible control plane, initially mockable locally without credentials.
- Dedicated-account normalization. Actual account type/permissions/initial holdings and
  production authorization remain private operator prerequisites.
- Permanent account evidence and normalized ledger, separating intent, user decisions and
  actual fills/transactions/actions. Do not infer execution from a button click.

## Exclusions

No proprietary strategy code, stock-selection assumptions, performance research, public real
signals, automatic broker writes, margin funding, extra acquisition, or deployment is granted
by this handoff. No final license has been selected. After the mock implementation, the operator
explicitly authorized public GitHub publication of the strategy-neutral application source. That
authorization does not extend to private strategy material, financial records or deployment.

See [architecture](ARCHITECTURE.md), [contract](STRATEGY_PROVIDER_CONTRACT.md) and
[implementation plan](IMPLEMENTATION_PLAN.md). Local private integration details, if supplied,
belong only in the ignored `../PRIVATE_HANDOFF.local.md`.
