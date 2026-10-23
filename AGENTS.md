# zeniba agent handoff

Read `README.md`, `docs/PROJECT.md`, `docs/STATUS.md`, `docs/ARCHITECTURE.md`,
`docs/IMPLEMENTATION_PLAN.md`, `docs/STRATEGY_PROVIDER_CONTRACT.md`, and the contract schema.
Read `PRIVATE_HANDOFF.local.md` locally if present; keep it ignored and confidential.
Update `docs/STATUS.md` with completed work, tests, blockers and the exact next step.

## Single-empty-account observation probe (2026-10-22)

The operator now explicitly requests real-account testing WITHOUT risking holdings. Read
`docs/SCHWAB_READ_ONLY.md` and latest STATUS: implement a separate controller-only, observation-
only probe for ONE preselected empty account. Initial live calls require approved private app
configuration, exact HTTPS LOOPBACK callback, explicit --live and owner-driven Schwab consent.
Do not infer credentials/account IDs or hunt them. No order preview/submit/replace/cancel,
funding/transfer/margin use, all-account holdings query or holdings-account fallback. Tokens
may themselves permit writes; do not claim a broker-enforced read-only scope.

Domain OAuth/observer use injected transports and fixed narrow egress. The real fetch exists
only in the explicitly invoked controller script; Worker/coordinator/Wrangler stay mock-only.
No real data/provider/telemetry/broker secret or callback into production app. Store outside
ANY Git tree in protected0700/0600 local files with leases/atomic updates; preserve ambiguous
refresh barriers and require fresh OAuth, no automatic stale-token/lock retry. No account
as_of/cash/claims certification from a current probe. Unknown positions/balances block; buying
power is never cash. The owner separately approved protected token retention for an authenticated,
matched one-account connection when positions are OMITTED and this is the sole data block.
This is NOT empty/certified: preserve blocked data, null position count/cash/balances and false
flags; no raw unknown response archive. Null/malformed, visible order/restriction, scope/type or
other data failures do not gain the exception. A completed connection/exit0 is not a portfolio
validation pass. Public tests/fixtures remain synthetic. Live-test results and operator
configuration stay private. See STATUS for source/test evidence and actual live-call count.

## Scope and confidentiality

- Implement the strategy-neutral application here, not proprietary investment formulas or
  research/backtesting machinery. Never copy a private strategy implementation or its
  strategy-specific fixtures, parameters, explaining documents, or actual decisions here.
- Treat all tracked source/docs/examples as public-capable. Use toy instruments and synthetic
  accounts. Keep account data, OAuth tokens, provider credentials, deployment-local config,
  real proposals, statements and logs out of Git. `.gitignore` does not erase prior disclosures.
- Creating/publishing a remote or changing visibility requires explicit operator authorization.
  The operator authorized public GitHub publication of this strategy-neutral framework after
  implementation. Private strategy details and operational records remain excluded; publication
  does not authorize deployment, live integration or changes to any private strategy repository.
- The operator subsequently authorized a mock-only Cloudflare Workers deployment using the private
  infrastructure repository's ownership/review practice. Keep deployment configuration/secrets and
  operational receipts private, alternate ingress disabled, and the owner view behind authentication.
  This is not authorization to connect a provider/broker, real accounts, or live market data.
- First release is manual-first, read/observe-only and shadow. No live brokerage connections,
  provider calls with real account data, production deployments, or order submit/replace/cancel
  until explicitly configured and authorized. Build all unblocked framework paths with mocks.
- A private provider's `mode: shadow` and `broker_execution_enabled: false` are authoritative.
  Do not silently reinterpret a proposed intent as a broker-ready/authorized instruction.

## Correctness and operations

- Pin an opaque strategy release. Do not fetch a moving research HEAD/latest/best strategy.
- Account state `as_of` is the provider decision cutoff, not the API retrieval time. Preserve
  `observed_at` separately; never relabel today's cash/holdings as an earlier state. Reconstruct
  and reconcile through the account ledger or block the proposal if unknown.
- Distinguish primary strategy-owned holdings, passive action-derived exposure, settled cash,
  reserved debit claims, unpaid credits, open orders and unresolved actions. Never infer
  ownership or make unpriced exposure disappear. Do not use margin/buying power as settled cash.
- All money/share values are decimal strings. Do not round them through JavaScript `Number`.
- Provider input IDs bind already registered private data snapshots. Input freshness/catalog
  publication is an integration dependency, not permission to build a new market-data strategy.
- A proposal is immutable and bound to release/input/account/request hashes and expiry. Changed
  state creates a new version. No-response/late response causes no trade or automatic catch-up.
- Telegram `Seen`, `Skip`, `I placed orders`, and `Sync` are workflow events, not fills. Reconcile
  actual broker execution/transaction IDs, partials, cancels, corrections, fees and cash flows.
- One durable account coordinator should serialize state transitions/token updates. Treat
  scheduled jobs, webhooks and retries as at-least-once. Deduplicate durably. Preserve raw broker
  evidence privately and normalize without double-counting order and transaction views.
- Private web views/authenticated backend only. Never expose a provider/broker token to browsers,
  public issues, callback URLs, errors or logs. Authenticate Telegram webhook secret and numeric
  user/chat IDs. No free-text-to-order/LLM execution path.
- Public CI uses synthetic/mock data and no private strategy dependency. Untrusted PRs must not
  obtain live secrets or trigger production deployment. No real provider/broker HTTP in tests.

## Initial technology direction

TypeScript/Cloudflare Workers control plane, one account Durable Object/SQLite, R2 for private
raw evidence/backups; avoid adding a second database or perpetual websocket before needed.
Choose exact tool/dependency versions when implementation begins. Test provider clients and
state machines offline before cloud or broker integration. Retain this separation if a
scheduled server is used initially. Document limits honestly; no synthetic test proves profit,
account eligibility, execution support, complete data, or production readiness.
