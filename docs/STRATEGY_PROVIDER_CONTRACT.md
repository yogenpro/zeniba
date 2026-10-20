# Private strategy-provider contract v1

The neutral schema is [`../contracts/strategy-provider-v1.schema.json`](../contracts/strategy-provider-v1.schema.json),
version `zeniba.strategy-proposal.v1`. This contract contains no investment formulas.
[Toy request](../contracts/examples/request.json) and [toy response](../contracts/examples/proposal.json)
are synthetic transport examples, NOT valid production release/input IDs or strategy fixtures.

## Transport and capability

Backend-only HTTPS in deployment; an authenticated private proxy can forward to loopback Python.
All endpoints require `Authorization: Bearer <service token>`. Store the token as a deployment
secret; never send it to a browser, URL, Telegram, issue or log. Broker OAuth is independent.
Do not follow redirects to a different host or forward credentials across redirects.

- `GET /v1/health`: schema, pinned opaque `release_id`, `contract_sha256`, mode and status.
- `GET /v1/inputs/{input_snapshot_id}`: neutral descriptor containing release/input IDs,
  decision/execution/deadline timestamps, provenance kind and instrument ID/symbol mapping.
  It intentionally exposes no feature definitions or strategy source. The trusted operator
  must supply the current registered input ID; no active/latest snapshot catalog is promised.
- `POST /v1/proposals`: JSON request; structured proposal or safe error. Maximum body262144 bytes;
  Content-Length and application/json are required. No duplicate JSON keys, nonfinite values,
  unknown fields, cost/order-type/strategy overrides, or broker-write endpoints.

Responses are `Cache-Control: no-store`. No CORS/cookie authentication is provided. Do not expose
this API as a public unauthenticated strategy oracle. Apply private TLS, ingress authentication,
rate/concurrency limits and independent health monitoring at deployment.

## Request

Pin `release_id` explicitly. `input_snapshot_id` binds private, registered immutable input data.
`request_id` is an opaque owner/coordinator-generated identifier. The same retry must reuse the
same exact body; persist its hash. Changed reuse requires rejection/new request ID in `zeniba`.

`portfolio` uses an opaque `account_ref`, USD, exact decimal-string cash/shares, explicit primary
versus passive positions, debit/credit claims (unknown amount is null), and outstanding orders.
Do not send account numbers, passwords, OAuth credentials, arbitrary commands or local file paths.

- `as_of` must be EXACTLY the descriptor's decision cutoff. Reconstruct that state from the
  account ledger; do not relabel a later balance response as cutoff-state data.
- `observed_at` records retrieval/verification, not a replacement for `as_of`. Current v1 requires
  it within15 minutes of provider time, with at most30 seconds future clock skew.
- `requested_at` must be within5 minutes of provider time, with at most30 seconds future skew.
- No spending unpaid credits or unsettled sale proceeds. Known debit claims reserve settled
  cash; unknown claims/ownership or outstanding orders require resolution. Confirm broker
  normalization to avoid deducting the same reservation twice.
- All timestamps are explicit-offset ISO8601; use UTC `Z`. All amounts are decimal strings,
  never JS Number calculations. Inputs allow at most30 integer and30 fractional digits,
  no exponent notation; positive/nonnegative ranges are checked semantically. Outputs use
  plain notation with a wider grammar to preserve exact calculated debit ceilings. Do not
  round or truncate output values to the input grammar. Structural schema is not the only check.

## Proposal

Check schema, configured release ID, input ID, account ref, immutable request association,
clock/deadline, all capability flags and status BEFORE presenting actionable information.
V1 always returns `mode: shadow`, `requires_human_review: true`, and
`broker_execution_enabled: false`. `status: proposed` is NOT a live authorization or broker order.
`status: blocked` has no actionable orders. Nonfatal blocks can explain unfunded intents in an
otherwise valid proposal; do not resize, retry or complete them yourself.

`orders` are exact proposed side/share intents with entry/exit/resize labeling, raw reference
prices, maximum-debit constraints and scheduled execution time. There is no selected broker
order type, guaranteed fill price, settlement authorization or instruction to borrow. Never
invent an order type or execute a shadow intent automatically. Preserve partial manual action
and reconcile actual broker IDs rather than pretend the entire basket executed.

The provider returns `request_hash`, `account_state_hash` and `proposal_id`. Canonical hashing is
SHA256 of UTF-8 JSON with keys sorted, compact separators, JSON escaping and one terminal newline.
`request_hash` hashes the entire request; `account_state_hash` hashes portfolio without
`observed_at`; `proposal_id` hashes the proposal object before adding `proposal_id`. Preserve the
server's hashes and original bytes. These are content identities, not signatures or approvals.
Do not assume JavaScript JSON.stringify alone supplies identical canonical hashing.

`portfolio_value` includes known claims/exposure for sizing; `spendable_cash` is separately
constrained. Unknown valuation is null, not zero. `input_provenance` distinguishes synthetic
from operator-supplied inputs; the latter is not a PIT/data-completeness certification.
`valid_until` is the proposal deadline, not proof the broker accepts any particular closing
order at that instant. Current-account revalidation and owner workflow still belong to zeniba.

## Errors, retries and missing infrastructure

Errors are `{"error":{"code":"opaque_safe_code"}}`, with no request echoes or stack traces.
Typical statuses:401 auth;400 schema/identity/decimal;404 unknown input/route;409 incompatible
release, stale state, expired window or hash conflict;413 size;415 content type;503 pinned
release unavailable;500 sanitized internal failure. Do not log request bodies for diagnosis.

A read-only proposal retry is safe only with the identical saved request and within its window;
responses are deterministic there. After expiry, stop and show an exception. The provider is
stateless with respect to request-ID reuse; zeniba must enforce durable ID-to-body binding.
New input/strategy/account state creates a new proposal version, not an edited approval.

Live data publication, provider URL/secret/TLS setup, brokerage normalization and monitoring
are not provisioned by this handoff. Build the mock client first. Coordinate those private
prerequisites through ignored local integration notes instead of hardcoding them into public
source. A future execution capability would require an independently reviewed new scope and
contract; this v1 must not silently acquire one.
