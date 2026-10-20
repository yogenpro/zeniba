import test from 'node:test';
import assert from 'node:assert/strict';
import { utc } from '../src/contract';
import { newAccount, bindRequest, applyWorkflow, latest, saveProposal } from '../src/domain/account';
import { emptyLedger, ingestEvents, reconcile, type Execution } from '../src/domain/ledger';
import { ProviderClient } from '../src/provider/client';
import { MOCK_TOKEN, mockDescriptor } from '../src/provider/mock';
import { readBody, parseJson } from '../src/json';
import { NOW, code, descriptorFixture, requestFixture, mockClient } from './helpers';

test('valid IDs matching Object prototype keys have durable own-property semantics', async () => {
  let state = newAccount(descriptorFixture(), requestFixture().portfolio);
  const request = await bindRequest(state, 'constructor', NOW);
  const response = await mockClient().propose(request.body, state.descriptor);
  await saveProposal(state, 'constructor', response.proposal, response.raw);
  state = JSON.parse(JSON.stringify(state));
  assert.equal((await bindRequest(state, 'constructor', NOW)).hash, request.hash);
  assert.equal(await applyWorkflow(state, { event_id: 'toString', proposal_id: latest(state)!.proposal!.proposal_id,
    action: 'seen', received_at: new Date(NOW).toISOString() }, NOW), true);
  assert.equal(state.workflow_events.length, 1);
});
test('synthetic input identities bind immutable windows rather than a moving latest descriptor', async () => {
  const a = await mockDescriptor(NOW), retry = await mockDescriptor(NOW), next = await mockDescriptor(NOW + 1);
  assert.equal(a.input_snapshot_id, retry.input_snapshot_id); assert.notEqual(a.input_snapshot_id, next.input_snapshot_id);
  assert.equal(a.release_id, next.release_id);
});
test('a supplied descriptor cannot bypass configured client release/input pins', async () => {
  const d = descriptorFixture(); const c = new ProviderClient({ baseUrl: 'https://mock.invalid/', token: MOCK_TOKEN,
    releaseId: 'f'.repeat(64), inputId: d.input_snapshot_id, clock: () => NOW,
    transport: async () => { throw new Error('Must reject before transport'); } });
  await assert.rejects(c.propose(JSON.stringify(requestFixture()), d), code('provider_pin_mismatch'));
});
test('UTC semantic validation rejects normalized nonexistent dates and omitted offsets', () => {
  for (const time of ['2030-02-30T14:00:00Z', '2030-01-31T25:00:00Z', '2030-01-31T14:00:00', '2030-01-31T14:00:00+00:00']) assert.throws(() => utc(time), code('invalid_time'));
  assert.equal(utc('2030-01-31T14:00:00.000000Z'), NOW);
});
test('body abort cancels an unfinished stream rather than leaving it consuming resources', async () => {
  let canceled = false; const abort = new AbortController();
  const response = new Response(new ReadableStream({ cancel() { canceled = true; } }));
  const pending = readBody(response, abort.signal); abort.abort();
  await assert.rejects(pending, code('body_read_aborted')); assert.equal(canceled, true);
  assert.throws(() => parseJson('\ufeff{}'), code('invalid_json'));
});
test('filled order without matching execution evidence is an exception, not a synthetic fill', async () => {
  const ledger = emptyLedger(); await ingestEvents(ledger, [{ kind: 'order', order_id: 'filled-order', instrument_id: 'TOY1',
    revision: 1, occurred_at: new Date(NOW).toISOString(), side: 'buy', shares: '7', filled_shares: '7', status: 'filled' }]);
  const current = requestFixture().portfolio; current.as_of = new Date(NOW).toISOString();
  assert.ok(reconcile(requestFixture().portfolio, current, ledger).includes('order_execution_mismatch'));
});
test('corrections crossing the cutoff require explicit reconstruction even if event time moves later', async () => {
  const baseline = requestFixture().portfolio, ledger = emptyLedger();
  const e: Execution = { kind: 'execution', execution_id: 'cross-cutoff', order_id: 'external-order', instrument_id: 'TOY1',
    side: 'buy', shares: '1', price: '50', fee: '0', role: 'primary', reversed: false, revision: 1,
    occurred_at: new Date(Date.parse(baseline.as_of) - 1000).toISOString() };
  await ingestEvents(ledger, [{ ...e, revision: 2, occurred_at: new Date(NOW - 1000).toISOString() }, e]);
  const current = { ...baseline, as_of: new Date(NOW).toISOString() };
  assert.ok(reconcile(baseline, current, ledger).includes('cutoff_reconstruction_required'));
});
