# Strategy-neutral application architecture

```text
Trading-day scheduler / authenticated owner / Telegram webhook
                            |
                    Worker control plane
                            |
           account Durable Object + private ledger
                /                           \
    observation-only broker adapter     private provider client
                |                       (pinned release + input ID)
    orders/fills/transactions                     |
                |                       private investment engine
                +---------- reconciliation -------+
                            |
                 private views / notifications
```

The private provider returns proposed intents, not broker orders or permission to trade.
No strategy code is downloaded into a browser or public bundle. A provider service token is
separate from broker OAuth tokens and never shared with that provider as a brokerage credential.

## Responsibilities

- Worker: authenticated routes, Telegram webhook, private views and scheduled orchestration.
- Account coordinator: serialized decisions, durable idempotency, immutable proposal versions,
  token refresh coordination, reconciliation checkpoints and retry/exception state.
- Broker observer: actual orders/executions, transactions, positions and balances; preserves
  raw evidence with retrieval times. Confirm current account/API eligibility and history limits.
- Provider client: authenticated backend requests, schema/version/pin/expiry checks, bounded
  payloads/timeouts, no automatic release changes. Know the explicit current input snapshot ID;
  do not guess from a public market signal or scrape private strategy configuration.
- Private object storage: raw responses, statements, normalized exports and backup/restore.
  Keep operational payloads out of source/CI logs/issues. Add query infrastructure only if needed.

## State and trust

Capture the normalized account AS OF the descriptor's decision time and the actual retrieval
`observed_at` separately. A current API response is not automatically a historical state snapshot.
Unknown ownership, outstanding orders, claims/actions, stale state or missing prices block a
proposal rather than become zero/cash. Cash normalization is an audited broker boundary.

Persist `request_id` -> immutable request hash and response. Reject changed reuse of an ID.
A repeated webhook/job may repeat observation but cannot invent a fill or duplicate a future
write. Proposals expire; a later state/plan requires a new version. A basket is not atomic.

Use provider descriptor times plus an exchange-calendar adapter for monitoring/deadlines;
Cloudflare Cron is UTC, not a DST-aware market calendar or hard-real-time execution guarantee.
Do not hardcode a particular strategy's monthly schedule into the generic application.

A later write-capable executor would be separately authorized/reviewed, isolated from observation,
and bound to explicit one-use approval of an account/plan/window. It is intentionally absent.

## Implemented local slice

`src/worker.ts` serves an auth shell and gates private APIs/Telegram ingress. `src/coordinator.ts`
serializes a single synthetic account across all asynchronous provider/storage operations. Its
SQLite checkpoint and command receipts commit atomically; content-addressed raw evidence is
archived to the R2 binding first. Request identities survive failed transport and process restarts.
`src/domain/` contains the account workflow and versioned execution/order/transaction/action ledger.
`src/provider/client.ts` validates transport and content identities; only `src/provider/mock.ts`
is wired in. `src/broker/mock-observer.ts` supplies synthetic evidence without any broker I/O.
`src/ui.ts` renders authenticated detail data without putting a service token in the browser.

The SQLite account aggregate is intentionally bounded, not a completed permanent-ledger design.
Backup snapshots include command receipts and evidence references; restore and disaster-recovery
verification are the next persistence work. Telegram notification payloads are generated locally;
external delivery/outbox, real provider/broker adapters, calendar scheduling and production private
ingress are absent. See [status](STATUS.md) and [local development](LOCAL_DEVELOPMENT.md) for tested
behavior and limits. No synthetic scenario or generic framework code is a strategy implementation.
