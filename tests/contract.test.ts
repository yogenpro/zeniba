import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import { CONTRACT_SHA256, accountHash, spendable, validateDescriptor, validateProposal, validateRequest, validateRequestWindow } from '../src/contract';
import { D } from '../src/decimal';
import { byteLength, canonicalJson, hashObject, parseJson, readBody } from '../src/json';
import { ProviderClient } from '../src/provider/client';
import { MOCK_TOKEN, mockTransport, toyProposal } from '../src/provider/mock';
import type { Proposal, Transport } from '../src/types';
import { NOW, code, descriptorFixture, mockClient, proposalFixture, requestFixture } from './helpers';

function client(transport: Transport, timeoutMs = 1000) {
  const d = descriptorFixture(); return new ProviderClient({ baseUrl: 'https://mock.invalid/', token: MOCK_TOKEN,
    releaseId: d.release_id, inputId: d.input_snapshot_id, transport, clock: () => NOW, timeoutMs });
}
function response(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }
async function rehash(p: Proposal): Promise<Proposal> { const { proposal_id: _id, ...body } = p; return { ...body, proposal_id: await hashObject(body) }; }

test('schema byte pin and public toy canonical identities match', async () => {
  const bytes = readFileSync(new URL('../contracts/strategy-provider-v1.schema.json', import.meta.url));
  assert.equal(CONTRACT_SHA256, createHash('sha256').update(bytes).digest('hex'));
  const r = requestFixture(), p = proposalFixture(); validateRequest(r);
  assert.equal(await hashObject(r), p.request_hash); assert.equal(await accountHash(r.portfolio), p.account_state_hash);
  assert.equal((await validateProposal(p, r, descriptorFixture(), NOW)).proposal_id, p.proposal_id);
});
test('canonical JSON sorts integer-like keys lexically, escapes Unicode and ends with exactly one newline', () => {
  assert.equal(canonicalJson({ '2': 'é😀', '10': '\n', z: '\u007f' }), '{"10":"\\n","2":"\\u00e9\\ud83d\\ude00","z":"\\u007f"}\n');
  assert.equal(canonicalJson({ '\u{10000}': 1, '\ue000': 2 }), '{"\\ue000":2,"\\ud800\\udc00":1}\n');
});
test('duplicate keys (including escaped equivalents), malformed/nonfinite JSON and unsafe numbers fail closed', () => {
  for (const text of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"n":{"x":null,"x":true}}']) assert.throws(() => parseJson(text), code('duplicate_json_key'));
  for (const text of ['{"x":NaN}', '{"x":Infinity}', '{"x":01}', '{"x":1,}', '[true,]', 'null true', '"unterminated', '"bad\nstring"']) assert.throws(() => parseJson(text));
  for (const text of ['9007199254740993', '1e999', '0.1']) assert.throws(() => parseJson(text), code('unsafe_json_number'));
  assert.equal((parseJson('{"__proto__":{"admin":true}}') as Record<string, unknown>).__proto__ !== undefined, true);
  assert.equal(({} as { admin?: boolean }).admin, undefined);
  assert.throws(() => parseJson('['.repeat(50) + ']'.repeat(50)));
});
test('payload limits apply to UTF-8 bytes and streaming responses without Content-Length', async () => {
  assert.equal(byteLength('é'), 2);
  assert.throws(() => parseJson(' '.repeat(262145)), code('payload_too_large'));
  await assert.rejects(readBody(new Response('x', { headers: { 'Content-Length': '262145' } })), code('payload_too_large'));
  await assert.rejects(readBody(new Response('x'.repeat(262145))), code('payload_too_large'));
  await assert.rejects(readBody(new Response(new Uint8Array([0xff]))), code('invalid_json'));
});
test('exact financial arithmetic preserves values beyond Number precision and tiny fractions', () => {
  assert.equal(D('9007199254740993.000000000000000000000000000001').add(D('0.000000000000000000000000000009')).toString(), '9007199254740993.00000000000000000000000000001');
  assert.equal(D('0.1').add(D('0.2')).toString(), '0.3');
  assert.equal(D('-0.10').toString(), '-0.1'); assert.equal(D('-0.00').toString(), '0');
  assert.equal(D('1.000000000000000000000000000001').mul(D('1.000000000000000000000000000001')).toString(), '1.000000000000000000000000000002000000000000000000000000000001');
});
test('schema rejects unknown fields, numeric money, excess input precision and invalid identities', () => {
  for (const change of [
    (r: any) => r.override = 'unsafe', (r: any) => r.portfolio.settled_cash = 1000,
    (r: any) => r.portfolio.settled_cash = '1e3', (r: any) => r.portfolio.settled_cash = '0.' + '1'.repeat(31),
    (r: any) => r.release_id = 'latest', (r: any) => r.portfolio.currency = 'EUR'
  ]) { const r = requestFixture(); change(r); assert.throws(() => validateRequest(r), code('invalid_request')); }
  const negative = requestFixture(); negative.portfolio.settled_cash = '-1'; assert.throws(() => validateRequest(negative), code('negative_amount'));
  const duplicate = requestFixture(); duplicate.portfolio.claims = [{ claim_ref: 'x', direction: 'debit', amount: '1' }, { claim_ref: 'x', direction: 'debit', amount: '2' }];
  assert.throws(() => validateRequest(duplicate), code('duplicate_identity'));
});
test('cutoff and observation times are separate; stale/request/skew/expiry fail closed', () => {
  const d = descriptorFixture();
  const r = requestFixture(); validateRequestWindow(r, d, NOW);
  r.portfolio.as_of = r.portfolio.observed_at; assert.throws(() => validateRequestWindow(r, d, NOW), code('cutoff_state_required'));
  for (const age of [-15 * 60000 - 1, 30001]) { const r = requestFixture(); r.portfolio.observed_at = new Date(NOW + age).toISOString(); assert.throws(() => validateRequestWindow(r, d, NOW), code('stale_account')); }
  for (const age of [-5 * 60000 - 1, 30001]) { const r = requestFixture(); r.requested_at = new Date(NOW + age).toISOString(); assert.throws(() => validateRequestWindow(r, d, NOW), code('stale_request')); }
  const expired = requestFixture(); expired.requested_at = d.valid_until; expired.portfolio.observed_at = d.valid_until;
  assert.throws(() => validateRequestWindow(expired, d, Date.parse(d.valid_until)), code('proposal_expired'));
});
test('descriptor pins and duplicate symbol mappings are checked', () => {
  const d = descriptorFixture(); assert.throws(() => validateDescriptor(d, 'f'.repeat(64), d.input_snapshot_id, NOW), code('provider_pin_mismatch'));
  d.instruments.push({ instrument_id: 'TOY2', symbol: 'FAKE' });
  assert.throws(() => validateDescriptor(d, d.release_id, d.input_snapshot_id, NOW), code('duplicate_identity'));
});
test('unpaid credits never fund spending; debit claims reserve settled cash', async () => {
  const r = requestFixture(); r.portfolio.claims = [{ claim_ref: 'debit', direction: 'debit', amount: '200' }, { claim_ref: 'credit', direction: 'credit', amount: '1000000' }];
  assert.equal(spendable(r.portfolio).toString(), '800');
  const p = await toyProposal(r, descriptorFixture()); assert.equal(p.spendable_cash, '800');
  assert.equal(p.portfolio_value, '1000800'); // Known credits affect valuation, never spending.
});
test('mock health, descriptor and deterministic identical-body proposal retries are offline', async () => {
  const c = mockClient(); assert.equal((await c.health()).mode, 'shadow'); assert.equal((await c.descriptor()).input_provenance, 'synthetic');
  const a = await c.propose(canonicalJson(requestFixture()), descriptorFixture());
  const b = await c.propose(canonicalJson(requestFixture()), descriptorFixture());
  assert.equal(a.raw, b.raw); assert.equal(a.proposal.broker_execution_enabled, false);
});
test('unknown claims, open orders and unpriced/passive exposure produce blocked plans, never zero exposure', async () => {
  for (const change of [
    (r: any) => r.portfolio.claims.push({ claim_ref: 'unknown', amount: null, direction: 'debit' }),
    (r: any) => r.portfolio.open_orders.push({ order_id: 'toy' }),
    (r: any) => r.portfolio.positions.push({ instrument_id: 'TOY2', shares: '2', role: 'passive', blocked_reason: 'unpriced' })
  ]) {
    const r = requestFixture(); change(r); const { proposal: p } = await mockClient().propose(canonicalJson(r), descriptorFixture());
    assert.equal(p.status, 'blocked'); assert.deepEqual(p.orders, []);
    if (r.portfolio.positions.length) assert.equal(p.portfolio_value, null);
  }
});
test('all response capability flags, pins, account and hashes are mandatory', async () => {
  for (const change of [
    (p: any) => p.mode = 'live', (p: any) => p.broker_execution_enabled = true,
    (p: any) => p.requires_human_review = false, (p: any) => p.release_id = 'f'.repeat(64),
    (p: any) => p.account_ref = 'other', (p: any) => p.request_hash = 'a'.repeat(64), (p: any) => p.proposal_id = 'b'.repeat(64)
  ]) { const p = proposalFixture(); change(p); await assert.rejects(validateProposal(p, requestFixture(), descriptorFixture(), NOW)); }
});
test('semantically unsafe intents are rejected even with valid hashes', async () => {
  for (const change of [
    (p: any) => p.orders[0].shares = '0', (p: any) => p.orders[0].maximum_debit = null,
    (p: any) => p.orders[0].maximum_debit = '1', (p: any) => p.orders[0].side = 'sell',
    (p: any) => p.orders[0].reference_price = null, (p: any) => p.portfolio_value = null,
    (p: any) => p.orders[0].symbol = 'OTHER', (p: any) => p.status = 'blocked',
    (p: any) => p.blocks.push({ code: 'fatal', instrument_id: null, fatal: true })
  ]) { const p = proposalFixture(); change(p); await assert.rejects(validateProposal(await rehash(p), requestFixture(), descriptorFixture(), NOW)); }
});
test('wide output decimal precision is preserved without narrowing to request grammar', async () => {
  const p = proposalFixture(); p.orders[0]!.maximum_debit = '360.' + '0'.repeat(35) + '1';
  const validated = await validateProposal(await rehash(p), requestFixture(), descriptorFixture(), NOW);
  assert.equal(validated.orders[0]!.maximum_debit, p.orders[0]!.maximum_debit);
});
test('transport sends exact saved bytes, bearer backend auth, length and no redirects', async () => {
  const body = canonicalJson(requestFixture()), d = descriptorFixture(); const mock = mockTransport(d, () => NOW);
  const c = client(async r => { assert.equal(r.redirect, 'manual'); assert.equal(r.headers.get('authorization'), `Bearer ${MOCK_TOKEN}`);
    assert.equal(r.headers.get('content-length'), String(byteLength(body))); assert.equal(await r.clone().text(), body); return mock(r); });
  await c.propose(body, d);
  await assert.rejects(client(async () => new Response(null, { status: 302, headers: { location: 'https://other.invalid/' } })).health(), code('provider_redirect_refused'));
});
test('timeouts cover headers AND streamed bodies; errors never echo upstream details', async () => {
  await assert.rejects(client(async () => new Promise(() => {}), 20).health(), code('provider_timeout'));
  const stream = new ReadableStream({ start() {} });
  await assert.rejects(client(async () => new Response(stream, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }), 20).health(), code('provider_timeout'));
  await assert.rejects(client(async () => { throw new Error('SECRET credential and URL'); }).health(), code('provider_unavailable'));
  await assert.rejects(client(async () => response({ error: { code: 'SECRET' } }, 500)).health(), code('provider_rejected'));
  await assert.rejects(client(async () => new Response('SECRET')).health(), code('invalid_provider_response'));
});
