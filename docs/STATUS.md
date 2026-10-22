# Resume status

## Observation-only controller probe — offline implementation (2026-10-22)

The operator reports the deployed owner view works and explicitly requests real-account tests
without risking existing holdings. Treat this as an owner report, NOT independent authenticated
UI/DO/R2/persistence certification. The bounded next scope is ONE privately selected empty
account, observation only. No financial writes, funding, margin use, holdings-account fallback,
provider calls, cloud deployment or changes to the hosted mock are authorized by this probe.
Actual operator configuration/account details and answers remain private, not in this source.

Implemented [controller runbook](SCHWAB_READ_ONLY.md), fixed-origin confidential OAuth and
GET-only observer, exact broker-number lexeme parsing, single-account consent/identity checks,
protected Linux24 local setup/token/evidence store, single-use expiring state, hidden TTY input,
loopback-only callback, no redirects, bounded deadlines/body, redacted errors and explicit live
opt-in. Additional consent blocks BEFORE account detail reads. Missing positions/unknown or
nonzero balances block; margin buying power is never cash. The result is NOT a Portfolio: all
certification/history/order/cutoff flags false, settled cash null, no real proposal. Unexpected
holdings/balances are not returned as raw archived evidence. Only matched empty-current records
may be saved outside Git in0600 files under0700, not in app DO/R2 state.

A local exclusive lease serializes refresh and file updates; atomic/fsynced no-clobber creates
and replacements reject bad ownership/modes/symlink/hardlink input. Refresh-pending barrier
survives ambiguous network/persistence failure and requires explicit fresh OAuth, never silently
retries a possibly consumed token. No stale-lock breaking. Public CI is synthetic/no credentials.
Worker/coordinator/config/contract/dependency-lock bytes are unchanged; the built Worker contains
neither the Schwab origin nor probe schema. Existing deployment guards still allow only mock.

Verification: reviewed local `npm run check` passes **91 tests/0 failed/0 skipped**, including
40 new probe/parser/OAuth/controller/filesystem/failure tests and all51 prior tests. Typecheck,
bundle and actual local workerd/SQLite/R2 tests pass using the preexisting isolated compatible
runtime, no system-library changes or remote runtime. First CF/Node Request type errors and
a follow-on type-assertion formatting failure are retained privately with corrected checks.
An ancillary source inventory also caught an untracked temporary dependency symlink (EISDIR);
removed that link ONLY, clean-installed dependencies into an actual ignored directory, and
repeated all91 tests successfully against this worktree's own binary with the same isolated
loader. Corrected source inventory has17 regular files/no symlinks/secret-pattern hits/private
paths; no staging/publication occurred at failure. No financial/runtime rule changed to pass.
This is self-review plus tests, NOT an independent security audit or live Schwab proof.

**Live calls so far: ZERO.** No app secret/token, account identifier or actual Schwab state has
been read/received/configured by this work; no secret lookup, consent/login, credentialed request,
provider call, R2 upload or deployment. Exact remaining owner step: review the probe, then run
hidden local `setup` with the approved app's matching HTTPS loopback callback and the one empty
account, followed by explicit `login --live`. Only the owner completes Schwab login/consent and
pastes the final callback into the hidden terminal, never chat. Schema gaps remain blocked and
need approved API documentation/review; do not relax them just to get a green empty result.
Hosted integration, histories/claims/settlement, backup restore, monitoring and private-provider
transport/current inputs remain separate gates. This probe is not a real-capital pilot.

## Authorized mock-only Workers deployment — 2026-10-21

Deployed the reviewed, tested mock app at **https://zeniba.yogenpro.com**, behind owner-only
Cloudflare Access and an independent owner bearer secret. This was explicitly authorized separately
from source publication. No provider, broker, real account, market data, Telegram delivery, schedule
or trade authorization was configured. All operational config, secrets, version IDs and deployment
receipts remain ignored/operator-local, not in this public repository.

Followed the private infrastructure ownership/review practice: Wrangler owns code/bindings/SQLite
DO migration v1/secrets and closed alternate ingress. The private Terraform workflow owns the
custom domain, private R2 container with prevent-destroy and hardened owner-only Access app. The
bounded plan created the domain/bucket and imported the deliberately created/captured Access app;
there were no unrelated changes/deletions. Both PRs' checks and merged-main checks passed, the
private main workflow applied successfully, and the post-deploy account plan reports **No changes**
with the Cloudflare audit passing. Merged deployment worktrees/branches were cleaned up.

Application `npm run check`: **51 passed, 0 failed, 0 skipped**, with typecheck/build and guarded
Wrangler dry-run passing. All **29 infrastructure suites** passed. The explicit-private-config
wrapper rejects alternate ingress, live modes, extra routes/cron, logging, binding/migration drift
and inline credential overrides; public CI remains credential-free and non-deploying.

Verified the active version matches the controller upload, only the four expected mock/owner/DO/R2
bindings exist, workers.dev and previews are disabled, the bucket has no public managed/custom
object domain, and anonymous HTTPS requests to both `/` and `/api/state` receive the Access
challenge (302), not app/account data. No edge bypass or service token was created for testing.

**Verification limits:** the owner-authenticated remote UI/workflow/persistence check still needs
an owner browser session. Local real-workerd/SQLite/R2 tests are not a substitute. Observability
is explicitly disabled in the upload config; live readbacks confirm logpush off and no tail
consumers, but the read API omits the native Workers Logs enabled flag, so independent live
readback of that flag remains unverified. Do not describe either gap as fully checked.

**Exact next step:** sign in through the owner Access identity, unlock with the privately stored
owner credential, and validate only the synthetic proposal/observation/persistence workflow.
Confirm the remaining logging setting without weakening ingress or sharing credentials. Then
continue mock-only verified backup restore/failure-injection work below. Hosting is not a
real-account or capital pilot. See [DEPLOYMENT.md](DEPLOYMENT.md).

## Public GitHub publication — 2026-10-20

Published the strategy-neutral framework to the explicitly authorized **public** repository
[yogenpro/zeniba](https://github.com/yogenpro/zeniba), with `main` tracking `origin/main`. There
was no existing remote, repository at that target, or prior local commit history. The initial
commit uses the operator's GitHub no-reply identity, not a private email address.

Verified anonymous public API access and an exact match between the 40 reviewed local files and
the published file tree. The publication inventory has no symlinks or matches for local secret
values, private handoff pointers/pins or common credential patterns. Private handoffs, `.dev.vars`,
local runtime notes, evidence/state, build output and dependencies remain ignored and excluded.
This is a publication boundary check, not a comprehensive security audit or live-readiness claim.

Pre-publication `npm run check` passed **49 tests, 0 failures, 0 skips**, with TypeScript and build
checks passing. The initial GitHub [Synthetic checks run](https://github.com/yogenpro/zeniba/actions/runs/39478914202)
completed successfully on the public repository. No production deployment or live provider,
broker or Telegram service was used. Publication grants no private-strategy disclosure or live
integration permission; no license has been selected.

Exact next step: implement mock-only verified backup restore into an empty coordinator and
failure-injection coverage, as specified in the application next-step section below.

## Mock-only vertical slice — 2026-10-20

Implemented a runnable local TypeScript/Cloudflare Workers application using **only synthetic
accounts and an in-process toy provider**. Read the public handoff/contract and the ignored local
handoff before implementation. No private strategy source, fixtures, parameters, release pins,
actual decisions or operational financial records were copied into public-capable files.

### Completed

- Exact-pinned tooling/lockfile, standalone JSON Schema validators suitable for Workers, and a
  local-only Wrangler configuration. No remote, publication, cloud resource or deployment created.
- Strict bounded JSON parsing (duplicate-key/unsafe-number rejection), exact BigInt decimal
  arithmetic, canonical SHA256 identities matching the public wire examples, and semantic checks.
- Backend provider client with explicit transport injection, byte-level contract pin, release/input
  pins, account/request/proposal/descriptor binding, authoritative shadow capabilities, deadlines,
  freshness, bounded streamed bodies, timeout cancellation and sanitized errors. App transport is
  **mock only**; there is no real-provider URL/token binding or global-fetch default.
- Immutable cutoff snapshots, separate current observations/verification times, immutable request
  bodies/proposal versions, stale-state invalidation, expiry, skip/report workflow and no catch-up.
- Synthetic observation/ledger paths covering shared execution-ID deduplication, partial fills,
  canceled/rejected orders, external manual activity, revised/corrected/reversed records, fees,
  cash flows, unresolved actions and passive exposure. Order states/buttons never manufacture fills.
- One serialized account Durable Object, actual SQLite persistence/atomic command receipts, private
  content-addressed R2 raw evidence, and backup snapshots including command receipts/evidence refs.
- Bearer-authenticated owner API/detail view; restrictive CSP/no-store, in-memory browser token,
  version-bound Seen/Skip/I-placed-orders/Sync events. Telegram callbacks require webhook secret
  and exact numeric user/chat IDs, with durable update deduplication and bounded callback data.
  Safe notification payloads are generated **without any outbound Telegram delivery**.
- Synthetic CI definition with SHA-pinned actions, read-only permissions, no private dependency,
  secrets, artifact upload, deployment or privileged PR-target trigger.
- [Local runbook](LOCAL_DEVELOPMENT.md) with routes, storage invariants and explicit limits.

### Tests and verification

`npm run check`: **49 passed, 0 failed, 0 skipped** (includes the integration-suite parent).
A clean `npm ci --ignore-scripts --no-audit --no-fund`, TypeScript check and Worker bundle build
pass. A loopback `wrangler dev --local` smoke check returned 200 for the auth shell, synthetic
initialization, proposal creation and private state view; tooling did not print generated local
secrets, and the smoke server was stopped. Local secrets/state remain ignored. Tests validate the
supplied schema/wire examples, immutable synthetic input/window identities, exact precision/hashing,
malformed/unsafe inputs, pin/capability/identity errors, blocked/stale/
expired plans, immutable retries, workflow semantics, broker revisions and reconciliation blocks.

The integration suite runs the **actual local Cloudflare workerd runtime**, SQLite Durable Object
and R2 implementations. It checks authenticated routes, concurrent duplicate proposals, webhook
identity/secret checks, private backup/evidence content hashes, complete runtime shutdown/restart
and durable deduplication, then partial-fill/cancellation state. Its outbound-network trap records
**zero provider, broker or Telegram HTTP calls**. No private dependency or real credentials used.

The host's default system C library cannot start the pinned workerd. Validation succeeded using
an isolated compatible loader/runtime wrapper, without modifying host libraries or using a remote
runtime. Machine-specific invocation notes remain in ignored `DEVELOPMENT.local.md`; developers
on a supported platform can run `npm run check` directly. This compatibility requirement is not
hidden by skipped tests. No profit/live-readiness claim follows from synthetic test results.

### Limits and blockers

This completes the initial mock skeleton/state-machine/private-view vertical slice, **not** every
production stage of `IMPLEMENTATION_PLAN.md`:

- SQLite currently stores a bounded account aggregate plus a command table. Capacity limits fail
  closed; append-only SQL migration/retention is needed for a permanent long-running ledger.
- Backups are written/verified and restart persistence is tested; backup **restore/import and
  disaster-recovery drills are not implemented**. R2/SQL failure-injection coverage is still needed.
- Cash flows/fees are separate records, but complete cash/statement reconciliation, cost basis,
  settlement normalization and performance analytics are not implemented. Correction gaps and
  ambiguous state block rather than infer a result. No real broker adapter or OAuth path exists.
- Owner auth is a local-development bearer gate. Production private ingress/auth, rate limiting,
  secret rotation, monitoring, notification outbox/delivery/retries and a calendar-aware scheduler
  are not provisioned. The demo window is synthetic, not an exchange-calendar claim.
- Real provider deployment/auth and current registered input publication are operator dependencies.
  Input IDs are explicit; there is no active/latest catalog or market-data/strategy acquisition.
  Real account cutoff reconstruction and a separately authorized shadow pilot remain prerequisites.
- No order submit/replace/cancel method, execution toggle, production deployment or live integration.
  `mode: shadow`, human-review required and broker execution disabled remain authoritative.

### Exact next step

Implement **offline, mock-only backup verification/restore into an empty coordinator**: validate
backup/content hashes and all evidence references, restore immutable requests plus durable command
receipts atomically, force fresh observation and keep restored proposals non-actionable. Add tests
for missing/corrupt evidence, incompatible versions, interrupted R2/SQL writes and duplicate delivery
after restore. Do not add live credentials, provider/broker calls, a market-data strategy or a broker
write endpoint to accomplish this. Then move the bounded aggregate toward an append-only SQL ledger
and implement a mock notification outbox/calendar orchestration before seeking live-integration
configuration and authorization.

## Seed history

The original local handoff supplied public-safe docs, `zeniba.strategy-proposal.v1`, its schema and
synthetic examples, with no executable application. The provider endpoints remain authenticated
`GET /v1/health`, `GET /v1/inputs/{opaque_id}`, `POST /v1/proposals`. Private integration pointers
remain ignored and confidential. No remote was configured by either the seed or this implementation.
