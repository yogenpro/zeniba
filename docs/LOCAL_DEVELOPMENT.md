# Local mock application

## Toolchain and entry points

Dependencies are exact-pinned in `package.json` and `package-lock.json`. Node 24.x is required;
CI selects 24.19.0 on Ubuntu 24.04. There is no private package dependency.

- `npm run generate`: compile the public JSON Schema to standalone validators and derive its
  byte-level SHA256 pin in ignored `.generated/`. No dynamic schema compilation in Workers.
- `npm run typecheck`: generate validators and check application, scripts and tests.
- `npm run build`: produce the mock-only Worker in ignored `.build/`, without upload.
- `npm test`: build and run unit tests plus real local `workerd`/SQLite/R2 integration tests.
- `npm run check`: typecheck and all tests. No real provider/broker/Telegram HTTP in tests.
- `npm run local:setup`: create ignored local secrets without printing or overwriting them.
- `npm run dev`: run Wrangler locally, bound to `127.0.0.1`. Do not use `--remote`.

Set `WRANGLER_SEND_METRICS=false` to disable Wrangler tool telemetry. Linux `workerd` requires
glibc 2.35 or newer. For an isolated compatible binary/loader, Miniflare recognizes the local
`MINIFLARE_WORKERD_PATH` environment variable; keep machine-specific wrappers/configuration out
of tracked files. Do not disable tests or substitute a fake SQL store to conceal incompatibility.

`wrangler.jsonc` defines **local mock bindings**, not provisioned cloud resources. `workers_dev`
and preview URLs are disabled. There is no route, cron, live-provider config, OAuth integration
or execution flag to turn on. `APP_MODE` other than `mock` fails closed. The separately authorized
[deployment wrapper](DEPLOYMENT.md) requires an explicit ignored profile; it never deploys this
local profile implicitly and is not invoked by public CI.

## Credentials and private views

`.dev.vars` needs a random `OWNER_TOKEN` of at least 32 characters. Every `/api/` route requires
`Authorization: Bearer <owner token>`. Writes require JSON and requests with a supplied Origin
must be same-origin. There are no CORS allowances or cookie sessions. The unauthenticated `/`
response is only an auth shell; account data is loaded after authentication. Responses use
`no-store`, `nosniff`, no-referrer and a restrictive CSP. UI content uses text nodes, not HTML
interpolation of provider data. The owner token is not persisted by the browser.

Telegram handling additionally requires a random `TELEGRAM_WEBHOOK_SECRET` of 32–256 characters
from `A-Za-z0-9_-`, and exact numeric `TELEGRAM_USER_ID` and signed numeric `TELEGRAM_CHAT_ID`.
The generated IDs are toys, not a configured bot. There is **no bot token or outbound delivery**.
`POST /telegram/webhook` checks the secret header before reading the update, then authenticates
both numeric identities. Only saved-proposal callback actions are accepted; free text, usernames,
inline callbacks without a verifiable chat, and arbitrary commands cannot act on accounts.

Do not expose an ungated demo or use local toy credentials in a deployment. Authorized mock
hosting additionally requires private owner-only ingress and independent deployment secrets.
Real-account production auth/rate/rotation/monitoring readiness remains separate work.

## Owner API (all data synthetic)

| Method/path | Body / purpose |
| --- | --- |
| `POST /api/bootstrap` | `{}`; create one synthetic account once; never reset an existing account |
| `GET /api/state` | Normalized account, ledger, workflow events and proposal versions/statuses |
| `POST /api/proposals` | `{ "request_id": "opaque-id" }`; durably bind then call the in-process mock |
| `POST /api/workflow` | `{ "event_id": "opaque-id", "proposal_id": "saved-hash", "action": "seen" }` |
| `POST /api/sync` | `{ "event_id": "opaque-id" }`; observe the current synthetic scenario |
| `POST /api/synthetic` | `{ "event_id": "opaque-id", "scenario": "partial" }`; simulate broker evidence |
| `GET /api/notification` | Safe toy message/inline-keyboard payload for an adapter to deliver later |
| `POST /api/backup` | `{ "event_id": "opaque-id" }`; write private R2 backup; return a storage key, not a public URL |

Workflow actions are exactly `seen`, `skip`, `placed`, `sync`. They bind the full saved proposal
identity. Superseded versions reject new clicks; late reports are marked audit-only and never
revive a plan. `placed` and `sync` trigger observation, not execution. Reusing a durable event ID
with changed content is a conflict. Proposal retries reuse the originally saved request bytes,
including timestamps; a stale retry cannot silently refresh its body. A cached expired proposal
may be inspected but is never returned as an active version.

The synthetic scenarios move from empty to partial to canceled; cancellation does not erase the
two observed shares or the unsettled debit claim. Rewinding from canceled is refused. To start
an entirely new local demo after expiry, stop Wrangler and deliberately remove **only your local
synthetic** persistence under `.wrangler/state/`. This deletes local demo records; it is not an
application reset/recovery path and must never be used on real records. Back up anything needed
first. There is no automatic reset or expiry catch-up.

## Storage and invariants

`src/coordinator.ts` serializes every account operation across awaits. SQLite holds a versioned
account aggregate and durable command ID/body-hash/result receipts. Each checkpoint and receipt
are published in the same SQL transaction. Requests are bound durably **before** provider I/O.
R2 stores original request/response bytes and raw synthetic observations under content hashes
**before** state/checkpoint advancement. A failed commit may leave an unreferenced private object,
not a ledger checkpoint without evidence. No evidence is served through a public object URL.

Backups contain the aggregate, immutable request/response records, workflow/ledger deduplication,
prior command receipts and raw-evidence object references. They are content-addressed snapshots
of state immediately before the backup command; retain the referenced evidence objects as well.
A backup is not yet a validated, automatic restore solution. Restore/import, recovery drills,
retention/orphan cleanup and R2/SQL failure-injection coverage are the next persistence work.

The local aggregate deliberately stops at 1.5 MB serialized state, 1,000 requests and 10,000
ledger receipts/workflow events/commands/evidence references rather than silently dropping
history. This is a bounded mock implementation, not a scalable permanent accounting database.
An append-only SQL layout/migration will be needed before long-running operation.

`src/domain/account.ts` preserves the historical cutoff snapshot separately from current
observations. Only an adapter's explicit verified/reconstructed cutoff can refresh its
verification time. Current balances are not relabeled. New economic state, unresolved ownership,
claims, actions, outstanding orders, missing evidence or stale verification invalidate/block a
proposal. The toy observer supplies synthetic proof only; it proves nothing about real account
history or broker cash semantics.

`src/domain/ledger.ts` uses broker execution identities shared across normalized order/transaction
views. Order status is not a fill. Repeated revisions deduplicate; changed reuse conflicts;
newer corrections/reversals supersede effective records while receipts and archived raw evidence
remain. Corrections potentially crossing the cutoff require reconstruction. Corporate actions
retain explicit passive exposure or block; cash flows/fees are recorded separately. Financial
amounts use decimal strings and BigInt decimal arithmetic. Settlement is not inferred from fills.
Complete cash/statement reconciliation, cost basis and performance analytics are **not** implemented.

The provider client requires an explicitly injected transport. It verifies the schema byte pin,
release/input/descriptor/account/request/proposal bindings, shadow-only capabilities, clocks and
deadlines, exact decimal constraints, bounded streaming bodies and timeouts; redirects are
refused. Canonical hashes match the public wire examples and independent Unicode/ordering test
vectors. Real-provider interoperability still requires an authorized integration check. The app
injects only an in-process mock and has no real-provider URL/token configuration path.

## Evidence and remaining scope

Tests exercise schema errors, duplicate keys, unsafe numeric literals, exact decimal precision,
canonical hashes, pin/capability/hash mismatch, blocked/unfunded intents, timeout cancellation,
stale/expired state, immutable versions, at-least-once callbacks, partial/canceled/rejected/manual
activity, corrections/reversals, passive actions, cash flows, auth, private backups and actual
SQLite/R2 persistence across full runtime restart. Integration tests install an outbound-network
trap and assert it was never called.

Tests do **not** establish profitability, account eligibility, market-calendar correctness,
current-data completeness, broker settlement/order support, complete reconciliation, disaster
recovery, production authentication or live readiness. Actual strategy calculation and market
input publication remain outside this repository. After mock persistence recovery is complete,
a separately authorized shadow integration can use backend-only provider transport and an
observation-only broker adapter. No broker write endpoint belongs to this release.
