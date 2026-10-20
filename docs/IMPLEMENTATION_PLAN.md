# Initial implementation plan

This is a framework implementation handoff, not permission for live execution or publication.
Complete each unblocked path with synthetic/mock inputs; update STATUS with evidence and limits.

Implementation checkpoint: the initial mock contract/state-machine/local-persistence/owner-view/
Telegram-callback vertical slice now runs offline. This is not completion of the live-integration
or recovery stages below. See [STATUS.md](STATUS.md) for test evidence and the exact next step,
and [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md) to run it without credentials or cloud resources.

1. **Local skeleton and contracts.** Select TypeScript/Workers tooling and pinned dependencies.
   Add schema-aware request/response types and an offline mock provider. Validate provided toy
   examples; add tests for malformed JSON, unknown fields, decimal strings, pin mismatch,
   expired/blocked plans, timeouts and sanitized errors. Do not need a private strategy package.
2. **Account/proposal state machine.** Define cutoff-state normalization, ownership/claims/open
   orders and freshness. Serialize account transitions; freeze proposals and bind hashes/expiry.
   Test duplicate events, changed request-ID reuse, reordered/partial/canceled/rejected/manual
   activity and stale accounts. No button becomes a fill. No auto-catch-up instruction.
3. **Private persistence and evidence.** Durable Object/SQLite account state, private raw archive,
   durable broker-ID deduplication, corrections/reversals, cash flows, actions and backups.
   Use synthetic adapters; distinguish time-weighted strategy results from investor cash flows.
4. **Owner UI and Telegram.** Private detail pages, safe notification summaries, numeric identity
   allowlist, webhook secret, Seen/Skip/I-placed-orders/Sync interactions, expiry and exception
   handling. Bind every click to the saved proposal version; no arbitrary text execution.
5. **Private provider integration.** Use authenticated backend-only health/descriptor/proposal
   calls with pinned release and explicit input ID. Verify deployment/contract/clock boundary;
   actual current-input availability is supplied by the provider operator, not invented here.
6. **Schwab observation integration, only when authorized.** Confirm app/account eligibility,
   OAuth/callback/history limits and cash semantics. Handle reauthorization alerts, overlapping
   history fetches, stale monitoring and statement-backed gap recovery. Tokens stay private;
   do not bypass OAuth with password storage or browser scraping. No broker write endpoint.
7. **End-to-end shadow operation.** Reconcile a real authorized account without placing orders,
   compare manual actions to proposals and independent statements, test outages/restore, and
   document actual detection latency. Synthetic correctness alone is not a live-readiness gate.

Before a real-capital proposal pilot: resolve input provenance/current universe, account opening
state and as-of reconstruction, owner availability, supported closing-order method and deadlines,
private TLS/auth/rate limits, monitoring/backup responsibility and separate explicit authorization.
Do not automatically proceed to API execution, a public remote, new strategy research or extra
market data. Do not block the mock/framework work on these production-only prerequisites.
