import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBrokerJson, parseJson } from '../src/json';
import { SchwabOAuth, validateApp, validateToken, type SchwabToken } from '../src/broker/schwab/oauth';
import { SchwabObserver } from '../src/broker/schwab/observer';
import { SCHWAB_ORIGIN, TOKEN_URL, ACCOUNT_NUMBERS_URL, observeRequest, validateSchwabRequest,
  schwabText, SchwabHTTPError } from '../src/broker/schwab/transport';
import type { Transport } from '../src/types';
import { code } from './helpers';

const NOW = Date.parse('2030-04-03T15:00:00Z');
const app = () => ({ client_id: 'toy-app-client', client_secret: 'toy-app-secret', redirect_uri: 'https://callback.invalid/return' });
const selection = () => ({ expected_account_number: '00000001', expected_account_type: 'MARGIN' as const,
  account_ref: 'probe_toy_account_ref_0001' });
const access = 'toy-access-token-not-real';
const response = (text: string, status = 200) => new Response(text, { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const mapping = '[{"accountNumber":"00000001","hashValue":"ToyHash0001"}]';
const account = () => ({ securitiesAccount: { accountNumber: '00000001', type: 'MARGIN', positions: [] as unknown[],
  currentBalances: { cashBalance: 0, liquidationValue: 0, equity: 0, longMarketValue: 0, shortMarketValue: 0,
    buyingPower: 0, availableFunds: 0, pendingDeposits: 0 }, isClosingOnlyRestricted: false } });
const tokenResponse = () => JSON.stringify({ access_token: access, refresh_token: 'toy-refresh-token-not-real', token_type: 'Bearer', expires_in: 1800 });
function observe(details: string, consent = mapping) {
  const calls: string[] = [];
  const observer = new SchwabObserver(selection(), async r => { calls.push(r.url); return response(r.url === ACCOUNT_NUMBERS_URL ? consent : details); }, () => NOW);
  return { observer, calls };
}

test('broker numeric literals retain exact lexemes while public contract parser stays strict', () => {
  const v = parseBrokerJson('{"amount":9007199254740993.010000000000000001,"zero":-0.00,"exp":1e-9,"flag":true}') as any;
  assert.equal(v.amount, '9007199254740993.010000000000000001'); assert.equal(v.zero, '-0.00');
  assert.equal(v.exp, '1e-9'); assert.equal(v.flag, true);
  for (const text of ['1.2', '9007199254740993', '1e2']) assert.throws(() => parseJson(text), code('unsafe_json_number'));
});
test('broker parser retains strict duplicate, nesting, byte and syntax guards', () => {
  for (const text of ['{"a":1,"\\u0061":2}', '{"x":NaN}', '{"x":01}', '\ufeff{}', '['.repeat(42) + ']'.repeat(42)])
    assert.throws(() => parseBrokerJson(text));
  assert.throws(() => parseBrokerJson(' '.repeat(262145)), code('payload_too_large'));
});
test('one-account mapping is required before ANY account detail request', async () => {
  for (const consent of ['[]', mapping.replace('00000001', '00000002'), mapping.slice(0, -1) + ',{"accountNumber":"00000002","hashValue":"OtherHash001"}]']) {
    const { observer, calls } = observe(JSON.stringify(account()), consent);
    await assert.rejects(observer.probe(access), code('schwab_single_account_consent_required'));
    assert.deepEqual(calls, [ACCOUNT_NUMBERS_URL]);
  }
});
test('mapping hash cannot inject paths, query, credentials or the mapping endpoint', async () => {
  for (const hash of ['../orders', 'accountNumbers', 'abc%2Forders', 'https://other.invalid', 'abcd?x=secret', 'a'.repeat(257)]) {
    const { observer, calls } = observe(JSON.stringify(account()), mapping.replace('ToyHash0001', hash));
    await assert.rejects(observer.probe(access), code('invalid_schwab_account_mapping')); assert.equal(calls.length, 1);
  }
});
test('all-zero explicit current observations never become settled cash, a portfolio or a proposal', async () => {
  const raw = JSON.stringify(account()).replace('"cashBalance":0', '"cashBalance":0.0000');
  const { observer, calls } = observe(raw), result = await observer.probe(access);
  assert.equal(result.report.status, 'observed_empty'); assert.equal(result.report.reported_balances!.cashBalance, '0.0000');
  assert.equal(result.report.settled_cash, null); assert.equal(result.report.account_cutoff_verified, false);
  assert.equal(result.report.open_orders_verified, false); assert.equal(result.report.history_verified, false);
  assert.equal(result.report.broker_execution_enabled, false); assert.equal(result.report.provider_called, false);
  assert.equal(result.raw_empty_account, raw); assert.equal('as_of' in result.report, false);
  assert.deepEqual(calls, [ACCOUNT_NUMBERS_URL, `${SCHWAB_ORIGIN}/trader/v1/accounts/ToyHash0001?fields=positions`]);
});
test('missing position view is unknown, not zero, and raw payload is not returned', async () => {
  const value: any = account(); delete value.securitiesAccount.positions;
  const result = await observe(JSON.stringify(value)).observer.probe(access);
  assert.deepEqual(result.report.blocks, ['schwab_positions_not_explicit']); assert.equal(result.raw_empty_account, null);
  assert.equal(result.report.connection_status, 'verified_single_account'); assert.equal(result.report.positions_state, 'omitted');
  assert.equal(result.report.positions_reported, null); assert.equal(result.report.reported_balances, null);
  assert.equal(result.report.data_certified, false); assert.equal(result.report.settled_cash, null);
});
test('null and malformed positions remain distinct from omission and from an explicit empty array', async () => {
  for (const [positions, expected] of [[null, 'null'], [{}, 'malformed'], ['not-an-array', 'malformed']] as const) {
    const value: any = account(); value.securitiesAccount.positions = positions;
    const result = await observe(JSON.stringify(value)).observer.probe(access);
    assert.equal(result.report.positions_state, expected); assert.equal(result.report.status, 'blocked');
    assert.equal(result.report.positions_reported, null); assert.equal(result.raw_empty_account, null);
  }
});
test('visible orders or account restrictions still block before an omitted-position retention case', async () => {
  for (const [extra, expected] of [[{ orderStrategies: [{ orderId: 'toy' }] }, 'schwab_order_data_present'],
    [{ isClosingOnlyRestricted: true }, 'schwab_account_restricted']] as const) {
    const value: any = account(); delete value.securitiesAccount.positions; Object.assign(value.securitiesAccount, extra);
    const result = await observe(JSON.stringify(value)).observer.probe(access);
    assert.equal(result.report.positions_state, 'omitted'); assert.deepEqual(result.report.blocks, [expected]);
    assert.equal(result.raw_empty_account, null);
  }
});
test('shape diagnostics do not change readiness results or read details for another account', async () => {
  const value: any = account(); delete value.securitiesAccount.positions;
  value.securitiesAccount.currentBalances.buyingPower = 'toy-sensitive-amount';
  value.securitiesAccount.currentBalances['toy-sensitive-key'] = 'toy-sensitive-value';
  const { observer, calls } = observe(JSON.stringify(value)); const result = await observer.probe(access);
  assert.equal(result.report.status, 'blocked'); assert.deepEqual(result.report.blocks, ['schwab_positions_not_explicit']);
  assert.equal(result.report.balance_shape!.container, 'object');
  assert.equal(result.report.balance_shape!.fields!.buyingPower, 'other_text');
  assert.equal(result.report.balance_shape!.unrecognized_field_count, 1);
  assert.equal(JSON.stringify(result.report.balance_shape).includes('sensitive'), false);
  assert.equal(result.report.reported_balances, null); assert.equal(result.report.settled_cash, null);
  assert.equal(result.raw_empty_account, null); assert.equal(result.report.data_certified, false); assert.equal(calls.length, 2);
  const wrong = observe(JSON.stringify(value), '[]');
  await assert.rejects(wrong.observer.probe(access), code('schwab_single_account_consent_required'));
  assert.equal(wrong.calls.length, 1);
});
test('unexpected holdings block even when quantities/market values are zero', async () => {
  const value = account(); value.securitiesAccount.positions = [{ instrument: { symbol: 'TOY1' }, longQuantity: 0 }];
  const result = await observe(JSON.stringify(value)).observer.probe(access);
  assert.deepEqual(result.report.blocks, ['schwab_nonempty_account']); assert.equal(result.raw_empty_account, null);
});
test('nonzero cash, tiny balances, debt and margin buying power all block without spending anything', async () => {
  for (const [key, amount] of [['cashBalance', '1'], ['buyingPower', '100000'], ['equity', '-1'],
    ['pendingDeposits', '0.000000000000000001'], ['cashBalance', '9007199254740993.0000000001']]) {
    const raw = JSON.stringify(account()).replace(`"${key}":0`, `"${key}":${amount}`);
    const result = await observe(raw).observer.probe(access);
    assert.deepEqual(result.report.blocks, ['schwab_nonzero_reported_balance']); assert.equal(result.report.reported_balances, null);
    assert.equal(result.raw_empty_account, null); assert.equal(result.report.buying_power_used_as_cash, false);
  }
});
test('missing, exponent, malformed and nested balance fields fail closed', async () => {
  const missing: any = account(); delete missing.securitiesAccount.currentBalances.equity;
  assert.deepEqual((await observe(JSON.stringify(missing)).observer.probe(access)).report.blocks, ['schwab_balance_fields_missing']);
  for (const raw of [JSON.stringify(account()).replace('"equity":0', '"equity":0e0'),
    JSON.stringify(account()).replace('"equity":0', '"equity":null'),
    JSON.stringify(account()).replace('"equity":0', '"equity":{"nested":0}')])
    assert.deepEqual((await observe(raw).observer.probe(access)).report.blocks, ['schwab_balance_format_unsupported']);
});
test('wrong response account identity fails rather than archiving another account', async () => {
  await assert.rejects(observe(JSON.stringify(account()).replace('00000001', '00000002')).observer.probe(access), code('schwab_account_identity_mismatch'));
});
test('account type, restrictions and visible order data cannot be ignored', async () => {
  const value: any = account(); value.securitiesAccount.type = 'CASH';
  assert.deepEqual((await observe(JSON.stringify(value)).observer.probe(access)).report.blocks, ['schwab_account_type_mismatch']);
  value.securitiesAccount.type = 'MARGIN'; value.securitiesAccount.orderStrategies = [{ orderId: 'toy' }];
  assert.deepEqual((await observe(JSON.stringify(value)).observer.probe(access)).report.blocks, ['schwab_order_data_present']);
  delete value.securitiesAccount.orderStrategies; value.securitiesAccount.isClosingOnlyRestricted = true;
  assert.deepEqual((await observe(JSON.stringify(value)).observer.probe(access)).report.blocks, ['schwab_account_restricted']);
});
test('observer snapshots configuration rather than following caller mutation to another account', async () => {
  const s = selection(); const calls: string[] = [];
  const observer = new SchwabObserver(s, async r => { calls.push(r.url); return response(r.url === ACCOUNT_NUMBERS_URL ? mapping : JSON.stringify(account())); }, () => NOW);
  s.expected_account_number = '00000002'; assert.equal((await observer.probe(access)).report.status, 'observed_empty'); assert.equal(calls.length, 2);
});
test('independent egress policy refuses every broker write and arbitrary endpoint/header/redirect', () => {
  const allowed = observeRequest(ACCOUNT_NUMBERS_URL, access); validateSchwabRequest(allowed, 'observe');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
    assert.throws(() => validateSchwabRequest(new Request(allowed, { method }), 'observe'), code('schwab_egress_refused'));
  for (const url of ['https://other.invalid/trader/v1/accounts/accountNumbers', 'http://api.schwabapi.com/trader/v1/accounts/accountNumbers',
    `${SCHWAB_ORIGIN}/trader/v1/accounts`, `${SCHWAB_ORIGIN}/trader/v1/accounts/ToyHash0001/orders`,
    `${SCHWAB_ORIGIN}/trader/v1/accounts/ToyHash0001?fields=positions&x=y`, TOKEN_URL])
    assert.throws(() => validateSchwabRequest(observeRequest(url, access), 'observe'), code('schwab_egress_refused'));
  for (const overrides of [{ redirect: 'follow' }, { credentials: 'include' }, { headers: { Authorization: `Bearer ${access}`, Cookie: 'toy' } }] as RequestInit[])
    assert.throws(() => validateSchwabRequest(new Request(allowed, overrides), 'observe'), code('schwab_egress_refused'));
});
test('HTTP redirects, auth errors and transport exceptions reveal no broker body/token', async () => {
  for (const status of [301, 302, 307, 401, 403, 500]) {
    const transport: Transport = async () => response('sensitive-body-do-not-echo', status);
    await assert.rejects(schwabText(observeRequest(ACCOUNT_NUMBERS_URL, access), 'observe', transport),
      e => e instanceof Error && !e.message.includes('sensitive') && !e.message.includes(access));
  }
  await assert.rejects(schwabText(observeRequest(ACCOUNT_NUMBERS_URL, access), 'observe', async () => { throw new Error(access); }), code('schwab_unavailable'));
});
test('OAuth exchange rejection exposes only fixed stage status and a known protocol reason', async () => {
  let calls = 0;
  const oauth = new SchwabOAuth(app(), async () => { calls++; return response('{"error":"invalid_grant","error_description":"toy-secret-code-and-client-id","accountNumber":"00000001"}', 400); }, () => NOW);
  const state = new URL(oauth.begin().authorization_url).searchParams.get('state');
  await assert.rejects(oauth.exchange(`${app().redirect_uri}?code=toy-secret-code&state=${state}`), error => {
    assert.ok(error instanceof SchwabHTTPError); assert.equal(error.code, 'schwab_rejected');
    assert.deepEqual(error.diagnostic, { stage: 'oauth_exchange', http_status: 400, oauth_error: 'invalid_grant' });
    assert.equal(JSON.stringify(error.diagnostic).includes('secret'), false); return true;
  });
  assert.equal(calls, 1);
});
test('refresh rejection is distinguished from exchange without weakening the existing auth error code', async () => {
  const previous: SchwabToken = { access_token: access, refresh_token: 'toy-refresh', token_type: 'Bearer', issued_at: NOW, expires_at: NOW + 1000 };
  const oauth = new SchwabOAuth(app(), async () => response('{"error":"invalid_client","error_description":"toy-private"}', 401), () => NOW);
  await assert.rejects(oauth.refresh(previous), error => {
    assert.ok(error instanceof SchwabHTTPError); assert.equal(error.code, 'schwab_reauthorization_required');
    assert.deepEqual(error.diagnostic, { stage: 'oauth_refresh', http_status: 401, oauth_error: 'invalid_client' }); return true;
  });
});
test('account diagnostics report mapping or details only and never consume private broker error bodies', async () => {
  for (const [url, stage, status] of [[ACCOUNT_NUMBERS_URL, 'account_mapping', 429],
    [`${SCHWAB_ORIGIN}/trader/v1/accounts/ToyHash0001?fields=positions`, 'account_details', 503]] as const) {
    let read = false, canceled = false;
    const transport: Transport = async () => new Response(new ReadableStream({ pull() { read = true; }, cancel() { canceled = true; } }, { highWaterMark: 0 }),
      { status, headers: { 'Content-Type': 'application/json', 'X-Private-Header': 'toy-secret' } });
    await assert.rejects(schwabText(observeRequest(url, access), 'observe', transport), error => {
      assert.ok(error instanceof SchwabHTTPError); assert.deepEqual(error.diagnostic, { stage, http_status: status, oauth_error: null });
      return true;
    });
    assert.equal(read, false); assert.equal(canceled, true);
  }
});
test('unknown malformed oversized or non-JSON OAuth errors never echo untrusted values', async () => {
  for (const [body, contentType] of [
    ['{"error":"toy-secret-token","error_description":"toy-secret"}', 'application/json'],
    ['{"error":"invalid_grant","error":"toy-secret"}', 'application/json'],
    ['{"error":{"nested":"toy-secret"}}', 'application/json'],
    ['<html>toy-secret</html>', 'text/html'], ['x'.repeat(262145), 'application/json']
  ] as const) {
    const previous: SchwabToken = { access_token: access, refresh_token: 'toy-refresh', token_type: 'Bearer', issued_at: NOW, expires_at: NOW + 1000 };
    const oauth = new SchwabOAuth(app(), async () => new Response(body, { status: 400, headers: { 'Content-Type': contentType } }), () => NOW);
    await assert.rejects(oauth.refresh(previous), error => {
      assert.ok(error instanceof SchwabHTTPError); assert.equal(error.diagnostic.oauth_error, null);
      assert.equal(JSON.stringify(error.diagnostic).includes('secret'), false); return true;
    });
  }
});
test('HTTP diagnostic constructor cannot reflect arbitrary stages statuses or reasons', () => {
  for (const make of [() => new SchwabHTTPError('toy-secret' as any, 400), () => new SchwabHTTPError('oauth_exchange', 999),
    () => new SchwabHTTPError('oauth_exchange', 400, 'toy-secret' as any)])
    assert.throws(make, code('invalid_schwab_http_diagnostic'));
});
test('OAuth error body parsing shares the existing deadline and never triggers a retry', async () => {
  let calls = 0, canceled = false;
  const previous: SchwabToken = { access_token: access, refresh_token: 'toy-refresh', token_type: 'Bearer', issued_at: NOW, expires_at: NOW + 1000 };
  const oauth = new SchwabOAuth(app(), async () => { calls++; return new Response(new ReadableStream({ cancel() { canceled = true; } }),
    { status: 400, headers: { 'Content-Type': 'application/json' } }); }, () => NOW, 5);
  await assert.rejects(oauth.refresh(previous), code('schwab_timeout'));
  assert.equal(calls, 1); assert.equal(canceled, true);
});
test('deadline aborts stalled transport and oversized/invalid response bodies are bounded', async () => {
  let aborted = false;
  await assert.rejects(schwabText(observeRequest(ACCOUNT_NUMBERS_URL, access), 'observe', r => {
    r.signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {});
  }, 5), code('schwab_timeout')); assert.equal(aborted, true);
  await assert.rejects(schwabText(observeRequest(ACCOUNT_NUMBERS_URL, access), 'observe', async () => response('x'.repeat(262145))), code('invalid_schwab_body'));
  await assert.rejects(schwabText(observeRequest(ACCOUNT_NUMBERS_URL, access), 'observe', async () => new Response('{}', { headers: { 'Content-Type': 'text/html' } })), code('invalid_schwab_content_type'));
});
test('OAuth emits a high-entropy single-use state and only the fixed confidential token exchange', async () => {
  let seen: Request | undefined;
  const client = new SchwabOAuth(app(), async r => { seen = r; return response(tokenResponse()); }, () => NOW);
  const start = client.begin(), url = new URL(start.authorization_url);
  assert.match(url.searchParams.get('state')!, /^[0-9a-f]{64}$/); assert.equal(start.expires_at, NOW + 600000);
  assert.equal(url.searchParams.get('redirect_uri'), app().redirect_uri);
  const result = await client.exchange(app().redirect_uri + '?code=toy-code%40&state=' + url.searchParams.get('state'));
  assert.equal(result.access_token, access); assert.equal(seen!.url, TOKEN_URL); assert.equal(seen!.method, 'POST');
  const body = new URLSearchParams(await seen!.text()); assert.equal(body.get('code'), 'toy-code@'); assert.equal(body.get('grant_type'), 'authorization_code');
  await assert.rejects(client.exchange(app().redirect_uri + '?code=toy&state=' + url.searchParams.get('state')), code('schwab_oauth_state_unavailable'));
});
test('Schwab session callback is accepted but only the once-decoded code reaches token exchange', async () => {
  let seen: Request | undefined;
  const oauth = new SchwabOAuth(app(), async request => { seen = request; return response(tokenResponse()); }, () => NOW);
  const state = new URL(oauth.begin().authorization_url).searchParams.get('state');
  const callback = `${app().redirect_uri}?code=toy%2Bcode%2540%40&session=toy-session%2B%3D&state=${state}`;
  await oauth.exchange(callback);
  const body = new URLSearchParams(await seen!.text());
  assert.equal(body.get('code'), 'toy+code%40@'); assert.equal(body.has('session'), false);
  assert.equal(body.has('state'), false); assert.equal([...body.keys()].length, 3);
});
test('only surrounding ASCII clipboard whitespace is trimmed, without changing callback contents', async () => {
  const oauth = new SchwabOAuth(app(), async () => response(tokenResponse()), () => NOW);
  const state = new URL(oauth.begin().authorization_url).searchParams.get('state');
  await oauth.exchange(` \t${app().redirect_uri}?code=toy-code&session=toy&state=${state}\r\n `);
});
test('Schwab session never substitutes for the active matching OAuth state', async () => {
  let calls = 0;
  for (const suffix of ['', '&state=wrong', '&state=']) {
    const oauth = new SchwabOAuth(app(), async () => { calls++; return response(tokenResponse()); }, () => NOW);
    const state = new URL(oauth.begin().authorization_url).searchParams.get('state');
    await assert.rejects(oauth.exchange(`${app().redirect_uri}?code=toy&session=${state}${suffix}`), code('schwab_oauth_state_mismatch'));
  }
  assert.equal(calls, 0);
});
test('callback shape failures report fixed nonsecret reasons before any token request', async () => {
  let calls = 0;
  const variants: [string, (state: string) => string][] = [
    ['schwab_callback_format_invalid', () => 'not-a-url'],
    ['schwab_callback_format_invalid', s => `${app().redirect_uri}?code=toy code&state=${s}`],
    ['schwab_callback_origin_mismatch', s => `https://other.invalid/return?code=toy&state=${s}`],
    ['schwab_callback_path_mismatch', s => `https://callback.invalid/other?code=toy&state=${s}`],
    ['schwab_callback_authority_invalid', s => `https://toy:password@callback.invalid/return?code=toy&state=${s}`],
    ['schwab_callback_fragment_refused', s => `${app().redirect_uri}?code=toy&state=${s}#toy-secret`],
    ['schwab_callback_duplicate_parameter', s => `${app().redirect_uri}?code=toy&state=${s}&session=a&ses%73ion=b`],
    ['schwab_callback_unexpected_parameter', s => `${app().redirect_uri}?code=toy&state=${s}&toy-secret-key=value`]
  ];
  for (const [expected, make] of variants) {
    const oauth = new SchwabOAuth(app(), async () => { calls++; return response(tokenResponse()); }, () => NOW);
    const state = new URL(oauth.begin().authorization_url).searchParams.get('state')!;
    await assert.rejects(oauth.exchange(make(state)), code(expected));
    await assert.rejects(oauth.exchange(make(state)), code('schwab_oauth_state_unavailable'));
  }
  assert.equal(calls, 0);
});
test('ignored session metadata is single-valued bounded and cannot contain decoded control bytes', async () => {
  let calls = 0;
  for (const session of ['x'.repeat(8193), 'toy%0Asession', 'toy%00session']) {
    const oauth = new SchwabOAuth(app(), async () => { calls++; return response(tokenResponse()); }, () => NOW);
    const state = new URL(oauth.begin().authorization_url).searchParams.get('state');
    await assert.rejects(oauth.exchange(`${app().redirect_uri}?code=toy&state=${state}&session=${session}`), code('schwab_callback_session_invalid'));
  }
  assert.equal(calls, 0);
});
test('callback diagnostics do not echo sensitive input even when the query key contains it', async () => {
  const oauth = new SchwabOAuth(app(), async () => { throw new Error('No transport allowed'); }, () => NOW);
  const state = new URL(oauth.begin().authorization_url).searchParams.get('state');
  await assert.rejects(oauth.exchange(`${app().redirect_uri}?code=toy-sensitive-code&state=${state}&toy-sensitive-key=x`),
    error => error instanceof Error && error.message === 'schwab_callback_unexpected_parameter'
      && !error.message.includes('sensitive'));
});
test('OAuth callback origin/path, duplicate keys, state, denial and expiry all reject before HTTP', async () => {
  let calls = 0, now = NOW;
  const client = () => new SchwabOAuth(app(), async () => { calls++; return response(tokenResponse()); }, () => now);
  for (const make of [
    (s: string) => `https://other.invalid/return?code=toy&state=${s}`,
    (s: string) => `${app().redirect_uri}/other?code=toy&state=${s}`,
    (s: string) => `${app().redirect_uri}?code=toy&state=${s}&state=${s}`,
    () => `${app().redirect_uri}?code=toy&state=wrong`,
    (s: string) => `${app().redirect_uri}?error=denied&state=${s}`,
    (s: string) => `${app().redirect_uri}?code=toy&state=${s}#fragment`,
    (s: string) => `${app().redirect_uri}?code=toy&state=${s}&redirect=other`
  ]) {
    const oauth = client(), s = new URL(oauth.begin().authorization_url).searchParams.get('state')!;
    await assert.rejects(oauth.exchange(make(s))); await assert.rejects(oauth.exchange(make(s)), code('schwab_oauth_state_unavailable'));
  }
  const oauth = client(), s = new URL(oauth.begin().authorization_url).searchParams.get('state'); now += 600000;
  await assert.rejects(oauth.exchange(`${app().redirect_uri}?code=toy&state=${s}`), code('schwab_oauth_state_unavailable')); assert.equal(calls, 0);
});
test('starting another OAuth challenge invalidates the former state and config is immutable', async () => {
  let calls = 0; const a = app(), oauth = new SchwabOAuth(a, async () => { calls++; return response(tokenResponse()); }, () => NOW);
  const old = new URL(oauth.begin().authorization_url).searchParams.get('state'), next = oauth.begin();
  assert.notEqual(old, new URL(next.authorization_url).searchParams.get('state')); a.redirect_uri = 'https://other.invalid/return';
  await assert.rejects(oauth.exchange(`${app().redirect_uri}?code=toy&state=${old}`), code('schwab_oauth_state_mismatch')); assert.equal(calls, 0);
});
test('refresh supports explicit rotation or retaining an omitted refresh token, with no infinite retry', async () => {
  const prior: SchwabToken = { access_token: access, refresh_token: 'toy-old-refresh', token_type: 'Bearer', issued_at: NOW - 3600000, expires_at: NOW - 1800000 };
  for (const refresh of [undefined, 'toy-new-refresh']) {
    let seen: Request | undefined;
    const oauth = new SchwabOAuth(app(), async r => { seen = r; return response(JSON.stringify({ access_token: access, token_type: 'Bearer', expires_in: 1800, refresh_token: refresh })); }, () => NOW);
    const token = await oauth.refresh(prior); assert.equal(token.refresh_token, refresh ?? prior.refresh_token);
    const body = new URLSearchParams(await seen!.text()); assert.equal(body.get('grant_type'), 'refresh_token'); assert.equal(body.get('refresh_token'), prior.refresh_token);
  }
  await assert.rejects(new SchwabOAuth(app(), async () => response('never expose this', 401), () => NOW).refresh(prior), code('schwab_reauthorization_required'));
});
test('streaming bodies are canceled on timeout and header rejection without an unbounded read', async () => {
  let canceled = false;
  await assert.rejects(schwabText(observeRequest(ACCOUNT_NUMBERS_URL, access), 'observe', async () =>
    new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { 'Content-Type': 'application/json' } }), 5), code('schwab_timeout'));
  assert.equal(canceled, true);
  canceled = false;
  await assert.rejects(schwabText(observeRequest(ACCOUNT_NUMBERS_URL, access), 'observe', async () =>
    new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { 'Content-Type': 'text/html' } })), code('invalid_schwab_content_type'));
  assert.equal(canceled, true);
});
test('malformed token replies never turn into a valid cached authorization', async () => {
  const previous: SchwabToken = { access_token: access, refresh_token: 'toy-refresh', token_type: 'Bearer', issued_at: NOW, expires_at: NOW + 1000 };
  for (const body of ['{"access_token":"toy-one","access_token":"toy-two"}', '{"expires_in":1800.5}',
    '{"access_token":"toy-access","refresh_token":"toy-refresh","token_type":"Bearer","expires_in":0}',
    '{"access_token":"toy-access","refresh_token":"toy-refresh","token_type":"other","expires_in":1800}', '[]', 'null'])
    await assert.rejects(new SchwabOAuth(app(), async () => response(body), () => NOW).refresh(previous));
});
test('invalid OAuth configuration/tokens fail closed without claiming a read-only broker scope', () => {
  for (const uri of ['http://callback.invalid/', 'https://user:pass@callback.invalid/', 'https://callback.invalid/?code=x', 'https://callback.invalid/#x'])
    assert.throws(() => validateApp({ ...app(), redirect_uri: uri }));
  const good: SchwabToken = { access_token: access, refresh_token: 'toy-refresh', token_type: 'Bearer', issued_at: NOW, expires_at: NOW + 1800000 };
  validateToken(good, NOW);
  for (const overrides of [{ token_type: 'read-only' }, { access_token: 'with a space' }, { issued_at: NOW + 30001 }, { expires_at: NOW }])
    assert.throws(() => validateToken({ ...good, ...overrides } as SchwabToken, NOW));
});
