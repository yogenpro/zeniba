# Schwab observation-only controller probe

This is a **single-account connectivity probe**, not a trading adapter, hosted-app account
connection or a production portfolio normalizer. The deployed mock and its ledger remain
unchanged. The OAuth app must already be approved; configuration, tokens and evidence stay
outside Git on the operator's Linux controller. No credential or live account is used by CI.

## Boundaries

- Authorize only ONE intentionally empty test account in Schwab's official consent flow. Pin
  its full expected account number privately BEFORE login. Mapping enumeration must contain
  exactly that account; extra/wrong consent blocks before positions/balances are requested.
  Mapping enumeration reads transient identifiers, not every account's holdings. Do not use
  a broadly consented token as a shortcut; resolve consent through Schwab's own UI.
- No order preview/placement/replacement/cancellation, funds transfer/deposit, account-setting
  change, margin use, password/MFA collection or login automation. Only account-data GETs
  exist. OAuth token exchange/refresh POST is separately fixed to its token endpoint.
- A token may itself permit trading. Read-only behavior is enforced by the narrow connector;
  there is no claim of a separately enforced read-only Schwab scope. Empty accounts alone
  are not a security boundary or a promise of zero security/privacy risk.
- Money/share numeric literals are parsed as exact decimal lexemes, never binary floating
  point. Buying power is NEVER settled cash. Every reported current balance must be zero
  for this first probe; unknown formats/nonzero values block rather than become zero.
- `positions` must be explicitly present and empty. An omitted field is UNKNOWN, not zero.
  The API's exact approved response schema must be checked; a legitimately omitted empty
  field will currently block and needs a separately reviewed mapping, not a permissive flag.
- `observed_empty` means only the requested current observations passed this narrow check.
  It is NOT settled-cash normalization, open-order/claim/history completeness, opening-state
  certification, a strategy cutoff snapshot or trading readiness. Certification flags stay
  false; settled cash stays null; no provider/proposal call occurs.

## Protected local setup

Use Node24 on a Linux controller with normal TLS verification. The project tests additionally
need the supported workerd/glibc environment described in [local development](LOCAL_DEVELOPMENT.md).
No cloud resources, callback route, broker SDK or new dependency is needed for this probe.

From a reviewed checkout:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run schwab -- setup "$HOME/.zeniba-schwab-probe"
npm run schwab -- status "$HOME/.zeniba-schwab-probe"
```

`setup` uses a real terminal and hidden prompts for the app key, app secret, EXACT registered
HTTPS loopback callback, expected account number and `MARGIN` or `CASH`. It requires explicit
acknowledgement after reviewing the approved app docs/consent. It creates an absent0700 state
directory and0600 configuration, without network access or overwriting existing files. Its
parent must already exist; do not choose a location inside ANY Git tree, even if ignored.

Never put a secret/account/code in a command argument, environment example, public issue, chat,
clipboard manager, screen recording or log. Do not reuse broker secrets as app/provider keys.
The operator must confirm the approved app/API and account eligibility; search/third-party
docs are not an approved response-schema or permission certificate.

## Explicit owner OAuth and first probe

Only after offline checks and private setup:

```sh
npm run schwab -- login "$HOME/.zeniba-schwab-probe" --live
```

This is the FIRST potentially live command. It can make one OAuth token POST plus mapping GET
and the matched account GET. There is no broker-write capability. The operator remains present:

1. Open the generated **protected local `authorization.html` file** privately in your browser.
   It contains the public OAuth client ID and one-use CSRF state, never the app secret/token.
   The CLI does not print the authorization URL, app/account identifiers or credentials.
2. Log in directly at Schwab and consent to ONLY the intended empty account. No password/MFA
   is supplied to this application or an agent. A token with additional accounts is rejected.
3. After Schwab redirects to the registered loopback callback, copy the **entire final address**
   into the hidden terminal prompt. There is no callback server in this manual flow, so a
   loopback connection-refused page can be expected; do not disable TLS or use a public URL
   as a workaround. Never paste that callback/code into chat. The exact scheme/host/port/path,
   state, query uniqueness and ten-minute expiry are verified before token exchange.
4. The state is consumed even on failure; retries need a new login. The authorization file is
   removed on normal completion/failure. Only a passing single-account empty observation saves
   the token; failed consent never saves one. Unexpected holdings/balances are not returned as
   raw archived evidence. Safe block codes explain supported-data gaps.

The profile accepts HTTPS callbacks only on127.0.0.1, localhost or::1; it must EXACTLY match the
approved app. This avoids sending a code through hosted app/edge logging or changing Access.
Manual URL copy is an OAuth flow, not scraping/password automation. Do not automate consent.

## Callback compatibility and private troubleshooting

Schwab can add a `session` query parameter to its landing URL, as shown in this
[public transcript of the portal OAuth reference](https://github.com/pashpashpash/schwab-cli/blob/main/docs/schwab-api/oauth.md).
The parser accepts that one auxiliary parameter as bounded, single-valued metadata and ignores
it. It is never forwarded, persisted, logged or accepted instead of our generated OAuth state.
The direct official documentation can require authenticated access; this reference does not
certify a particular app's permissions or the operator's exact callback contents.

Only surrounding ASCII clipboard whitespace is trimmed; internal whitespace, backslashes,
embedded credentials, fragments, duplicate/unknown query parameters and callback mismatches
still fail closed. URLSearchParams decodes the code ONCE; never manually decode/rewrite it.

The old generic `invalid_schwab_oauth_callback` is replaced by fixed, nonsecret reason codes:

| Code | Private action |
| --- | --- |
| `schwab_callback_format_invalid` | Copy the entire final address, without quotes or internal line breaks. |
| `schwab_callback_origin_mismatch` | Privately compare scheme, host and port to the configured/registered callback. localhost and127.0.0.1 are not interchangeable. |
| `schwab_callback_path_mismatch` | Check the exact registered path; do not rewrite the returned URL to force a match. |
| `schwab_callback_authority_invalid` / `schwab_callback_fragment_refused` | Do not include embedded credentials or a URL fragment. |
| `schwab_callback_duplicate_parameter` / `schwab_callback_unexpected_parameter` | Do not concatenate URLs or add fields. Report only the safe code, never query keys/values. |
| `schwab_callback_session_invalid` | Unsupported auxiliary metadata remains blocked; do not remove security checks. |
| `schwab_oauth_state_mismatch` | Use the NEW page from the CURRENT login. Session does not replace state. If a fresh callback truly omits state, stop for protocol review, not CSRF bypass. |
| `schwab_oauth_state_unavailable` | Expired/consumed challenge: start a fresh login and browser tab. |

Failed validation consumes the challenge. Restart login and use the newly generated page/state,
not a previous callback. No setup repetition, callback edit, credential sharing, TLS weakening
or permission change is needed for the session-parameter compatibility fix. For diagnosis,
share ONLY the safe error code—never the callback URL, authorization code/state/session,
configuration, account number or credentials. No diagnostic command contacts the broker.

## Headless WSL: use your Windows browser

A headless WSL shell does NOT require a Linux GUI for this manual flow. Keep the login command
running in your first interactive terminal; it creates `authorization.html` and waits for the
callback. The CLI prints a Windows handoff when it detects WSL. In a SECOND WSL terminal run:

```sh
explorer.exe "$(wslpath -w "$HOME/.zeniba-schwab-probe/authorization.html")"
```

This opens the SAME protected file through Windows/WSL file access; choose your Windows browser
if Explorer prompts for an application. Click **Continue at Schwab**, log in yourself and select
ONLY the empty account. Copy the entire final loopback callback address into the hidden prompt
in the FIRST terminal, not chat or a shell command. No callback web server or Linux browser is
needed, and a refused-connection page at the loopback callback is expected.

If Windows interop commands are unavailable, open the same file from Windows File Explorer via
`\\\\wsl.localhost\\<distro>\\home\\<linux-user>\\.zeniba-schwab-probe\\authorization.html`. Use your own
Windows user, not a shared computer/profile. Do not copy the file to a public folder, print its
contents/authorization URL, change file permissions, run a web server or expose a callback port.
The handoff contains only a local filename; no app secret/token/code is put into a command.

Complete the flow within ten minutes. If an earlier login is still waiting, cancel it with
Ctrl+C in its original terminal before starting a fresh login; do not run competing controllers
or delete a live `.lock`. On restart, use the NEW authorization file/state rather than an old
browser tab. If no actual terminal/PTY is attached, use an interactive terminal (or allocate a
PTY for your SSH session); do not pipe credentials or the callback around the hidden-input gate.
You do NOT need to repeat setup, change the registered callback, weaken TLS or redeploy the app.

## Repeated observation, rotation and private records

```sh
npm run schwab -- probe "$HOME/.zeniba-schwab-probe" --live
npm run schwab -- status "$HOME/.zeniba-schwab-probe"
```

Each probe rechecks the one-account mapping before fetching details. A nearly expired access
token is refreshed ONCE, under the same exclusive controller lease, and rotated tokens are
atomically persisted before account reads. There is no hardcoded refresh-token lifetime or
infinite retry. A refresh-pending barrier precedes dispatch: interrupted/ambiguous refresh or
failed token persistence blocks later probes until an EXPLICIT fresh OAuth login succeeds.
Do not delete the barrier just to retry an old possibly consumed refresh token.

Files are mode0600, under a0700 operator-owned directory outside Git; symlink/hardlink/bad-mode
files fail closed. Token updates use private temp files, fsync/atomic replacement, single-writer
leases and explicit configuration binding. Initial creates are no-clobber. A crashed process
may leave `.lock`: never automatically break it. An operator must first confirm the controller
is no longer running; preserve evidence and recover deliberately. No secret file is printed.

Private `operation-*` receipts record safe dispatch-attempt counts/failure codes, not request
URLs, bodies or tokens. They precede each dispatch; counts are attempts, not proof of broker
receipt or zero traffic after a crash. Private `probe-*` files contain the bounded report and
raw account details ONLY after explicit empty/zero observations for the matched account. All
other raw payloads are discarded; a blocked report is not a reconciled financial ledger.
There is no R2 upload, hosted app import, schedule, real market-data feed or provider call.

## Verified offline and remaining live gates

The synthetic suite exercises exact decimal lexemes, duplicate/malformed JSON, wrong/extra
consent, wrong detail identity, holdings/debt/unknown balances, egress methods/URLs/headers,
timeouts/body limits, state/replay/expiry, refresh and interrupted persistence, config binding,
private files/symlinks/leases, non-echo output and actual CLI refusal without a TTY/live opt-in.
These tests are not live OAuth/account verification, independent security review or account
statement reconciliation. No actual credentials or account identifiers are stored in source.

The hosted app intentionally still rejects live deployment modes and has only mock adapters.
Connecting observations to its durable ledger needs a separate reviewed adapter, storage and
recovery/failure checks. Complete order/history/claims/settlement/statement semantics must be
verified before portfolio normalization. A real strategy proposal additionally requires trusted
current inputs, a functioning pinned private-provider transport, exact cutoff reconstruction
and a separate financial-readiness decision. No trading permission follows from this probe.
