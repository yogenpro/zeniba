import test from 'node:test';
import assert from 'node:assert/strict';
import { accountHash } from '../src/contract';
import { applyObservation, applyWorkflow, bindRequest, latest, newAccount, proposalStatus, readiness, saveProposal } from '../src/domain/account';
import { emptyLedger, ingestEvents, reconcile, type Execution, type LedgerEvent } from '../src/domain/ledger';
import { observeMock } from '../src/broker/mock-observer';
import { hashObject } from '../src/json';
import { notification, callbackData, parseTelegram, resolveCallback } from '../src/telegram';
import { NOW, code, descriptorFixture, mockClient, requestFixture } from './helpers';

const fresh = () => newAccount(descriptorFixture(), requestFixture().portfolio);
async function planned(id = 'test-request-1') {
  const state = fresh(), r = await bindRequest(state, id, NOW);
  const response = await mockClient().propose(r.body, state.descriptor);
  await saveProposal(state, id, response.proposal, response.raw); return state;
}
const execution = (changes: Partial<Execution> = {}): Execution => ({ kind: 'execution', execution_id: 'exec-1', order_id: 'order-1', revision: 1,
  instrument_id: 'TOY1', side: 'buy', shares: '2', price: '50', fee: '0.12', role: 'primary', reversed: false,
  occurred_at: new Date(NOW - 60000).toISOString(), ...changes });

test('request identity and exact bytes are frozen; changed reuse is rejected', async () => {
  const state = fresh(), a = await bindRequest(state, 'same-id', NOW);
  const retry = await bindRequest(state, 'same-id', NOW + 10000); assert.equal(a.body, retry.body); assert.equal(a.hash, retry.hash);
  assert.equal(a.hash, await hashObject(JSON.parse(a.body)));
  await assert.rejects(bindRequest(state, 'same-id', NOW, a.body.replace('1000', '1001')), code('request_id_conflict'));
  await assert.rejects(bindRequest(state, 'same-id', NOW, ' ' + a.body), code('request_id_conflict'));
});
test('proposal and raw provider response are immutable; new request is a new version', async () => {
  const state = await planned(), saved = latest(state)!;
  const before = JSON.stringify(saved.proposal);
  await saveProposal(state, 'test-request-1', saved.proposal!, saved.response_raw!);
  await assert.rejects(saveProposal(state, 'test-request-1', saved.proposal!, 'changed bytes'), code('immutable_proposal_conflict'));
  const next = await bindRequest(state, 'version-two', NOW);
  const response = await mockClient().propose(next.body, state.descriptor); await saveProposal(state, 'version-two', response.proposal, response.raw);
  assert.notEqual(latest(state)!.proposal!.proposal_id, saved.proposal!.proposal_id);
  assert.equal(proposalStatus(state, saved, NOW), 'superseded'); assert.equal(JSON.stringify(saved.proposal), before);
});
test('duplicate workflow events survive serialization; changed event ID reuse is rejected', async () => {
  let state = await planned(); const id = latest(state)!.proposal!.proposal_id;
  const event = { event_id: 'callback-1', proposal_id: id, action: 'seen' as const, received_at: new Date(NOW).toISOString() };
  assert.equal(await applyWorkflow(state, event, NOW), true);
  state = JSON.parse(JSON.stringify(state));
  assert.equal(await applyWorkflow(state, { ...event, received_at: new Date(NOW + 1000).toISOString() }, NOW + 1000), false);
  assert.equal(state.workflow_events.length, 1);
  await assert.rejects(applyWorkflow(state, { ...event, action: 'placed' }, NOW), code('workflow_event_conflict'));
});
test('Seen, Skip, I placed orders and Sync are workflow events, never fills or cash', async () => {
  for (const action of ['seen', 'skip', 'placed', 'sync'] as const) {
    const state = await planned(), original = await accountHash(state.current);
    await applyWorkflow(state, { event_id: `event-${action}`, proposal_id: latest(state)!.proposal!.proposal_id,
      action, received_at: new Date(NOW).toISOString() }, NOW);
    assert.equal(await accountHash(state.current), original); assert.deepEqual(state.ledger.effective, {}); assert.equal(state.revision, 1);
  }
});
test('Skip remains terminal for intent workflow, but Sync still observes', async () => {
  const state = await planned(), proposal_id = latest(state)!.proposal!.proposal_id;
  await applyWorkflow(state, { event_id: 'skip', proposal_id, action: 'skip', received_at: new Date(NOW).toISOString() }, NOW);
  await assert.rejects(applyWorkflow(state, { event_id: 'placed', proposal_id, action: 'placed', received_at: new Date(NOW).toISOString() }, NOW), code('proposal_skipped'));
  await applyWorkflow(state, { event_id: 'sync', proposal_id, action: 'sync', received_at: new Date(NOW).toISOString() }, NOW);
  assert.equal(latest(state)!.workflow, 'skipped');
});
test('late reporting is audit-only; expired proposals never become active or catch up', async () => {
  const state = await planned(), saved = latest(state)!, now = Date.parse(state.descriptor.valid_until);
  await applyWorkflow(state, { event_id: 'late', proposal_id: saved.proposal!.proposal_id, action: 'placed', received_at: new Date(now).toISOString() }, now);
  assert.equal(state.workflow_events[0]!.late, true); assert.equal(proposalStatus(state, saved, now), 'expired');
  assert.deepEqual(state.ledger.effective, {}); await assert.rejects(bindRequest(state, 'catch-up', now));
});
test('unknown/stale cutoff verification blocks proposals; observation does not relabel historical data', async () => {
  const state = fresh(); assert.deepEqual(readiness(state, NOW), []);
  await assert.rejects(bindRequest(state, 'stale', NOW + 15 * 60000 + 1), code('stale_account'));
  const originalCutoff = state.cutoff.as_of;
  const obs = observeMock(state, NOW + 60000); await applyObservation(state, obs, NOW + 60000);
  assert.equal(state.cutoff.as_of, originalCutoff); assert.equal(state.current.as_of, new Date(NOW + 60000).toISOString());
  assert.equal(state.cutoff_verified_at, obs.observed_at); assert.deepEqual(readiness(state, NOW + 60000), []);
  const wrong = observeMock(state, NOW + 120000); wrong.verified_cutoff!.settled_cash = '999';
  await assert.rejects(applyObservation(structuredClone(state), wrong, NOW + 120000), code('cutoff_reconstruction_conflict'));
});
test('unknown normalization, ownership and claims are blockers, not zero/cash', async () => {
  const state = await planned(); const obs = observeMock(state, NOW + 1);
  obs.current = null; obs.verified_cutoff = null; obs.complete = false; obs.issues = ['unknown_ownership'];
  await applyObservation(state, obs, NOW + 1); assert.ok(readiness(state, NOW + 1).includes('normalization_unresolved'));
  assert.equal(proposalStatus(state, latest(state)!, NOW + 1), 'stale'); await assert.rejects(bindRequest(state, 'unknown', NOW + 1));
  const claimed = fresh(); claimed.current.claims.push({ claim_ref: 'claim', amount: null, direction: 'debit' });
  assert.ok(readiness(claimed, NOW).includes('unknown_claim')); assert.equal(claimed.current.claims[0]!.amount, null);
});
test('partial fills and repeated sync count broker execution once; cancellation does not erase fills', async () => {
  const state = await planned(); state.mock_scenario = 'partial';
  await applyObservation(state, observeMock(state, NOW + 1), NOW + 1);
  assert.equal(Object.values(state.ledger.effective).filter(e => e.kind === 'execution').length, 1);
  assert.equal(state.current.positions[0]!.shares, '2'); assert.equal(state.current.settled_cash, '1000');
  assert.equal(state.current.claims[0]!.amount, '100'); assert.ok(readiness(state, NOW + 1).includes('outstanding_orders'));
  const revision = state.revision; await applyObservation(state, observeMock(state, NOW + 2), NOW + 2); assert.equal(state.revision, revision);
  state.mock_scenario = 'canceled'; await applyObservation(state, observeMock(state, NOW + 3), NOW + 3);
  assert.equal(state.current.positions[0]!.shares, '2'); assert.deepEqual(state.current.open_orders, []);
  assert.equal(state.ledger.effective['order:toy-order-1']!.kind, 'order');
  assert.ok(readiness(state, NOW + 3).includes('account_changed_since_cutoff'));
  assert.equal(proposalStatus(state, latest(state)!, NOW + 3), 'stale');
});
test('reordered observations never overwrite a newer snapshot', async () => {
  const state = fresh(); await applyObservation(state, observeMock(state, NOW + 10), NOW + 10);
  await assert.rejects(applyObservation(state, observeMock(state, NOW + 5), NOW + 10), code('reordered_observation'));
});
test('order states including rejected, partial and canceled never manufacture executions', async () => {
  for (const status of ['partial', 'filled', 'canceled', 'rejected'] as const) {
    const ledger = emptyLedger(); await ingestEvents(ledger, [{ kind: 'order', order_id: 'o', revision: 1,
      instrument_id: 'TOY1', side: 'buy', shares: '7', filled_shares: status === 'rejected' ? '0' : '2', status, occurred_at: new Date(NOW).toISOString() }]);
    assert.equal(Object.values(ledger.effective).filter(e => e.kind === 'execution').length, 0);
  }
});
test('corrections/reversals and reordered broker revisions preserve exact evidence identities', async () => {
  const ledger = emptyLedger(); const original = execution(), corrected = execution({ revision: 2, shares: '1.5', fee: '0.11' });
  await ingestEvents(ledger, [corrected, original, corrected]);
  assert.equal((ledger.effective['execution:exec-1'] as Execution).shares, '1.5'); assert.equal(Object.keys(ledger.receipts).length, 2);
  await assert.rejects(ingestEvents(ledger, [execution({ revision: 2, shares: '1.6' })]), code('broker_identity_conflict'));
  await ingestEvents(ledger, [execution({ revision: 3, reversed: true })]);
  assert.equal((ledger.effective['execution:exec-1'] as Execution).reversed, true);
  assert.deepEqual(reconcile(requestFixture().portfolio, { ...requestFixture().portfolio, as_of: new Date(NOW).toISOString() }, ledger), []);
});
test('manual external activity is recorded independently of intents and unexplained exposure blocks', async () => {
  const ledger = emptyLedger(); await ingestEvents(ledger, [execution({ order_id: 'external-manual-order' })]);
  const current = requestFixture().portfolio; current.as_of = new Date(NOW).toISOString();
  current.positions = [{ instrument_id: 'TOY1', shares: '2', role: 'primary', blocked_reason: null }];
  assert.deepEqual(reconcile(requestFixture().portfolio, current, ledger), []);
  current.positions[0]!.shares = '3'; assert.ok(reconcile(requestFixture().portfolio, current, ledger).includes('holdings_ledger_mismatch'));
});
test('cash flows and fees are separate from trade returns; actions retain passive exposure or block', async () => {
  const ledger = emptyLedger();
  const events: LedgerEvent[] = [{ kind: 'cash_flow', transaction_id: 'deposit', revision: 1, occurred_at: new Date(NOW).toISOString(),
    category: 'deposit', direction: 'credit', amount: '100', reversed: false },
  { kind: 'action', action_id: 'spin', revision: 1, occurred_at: new Date(NOW).toISOString(), instrument_id: 'TOY2', status: 'unresolved', passive_shares: null }];
  await ingestEvents(ledger, events); await ingestEvents(ledger, events);
  assert.equal(Object.values(ledger.effective).filter(e => e.kind === 'cash_flow').length, 1);
  const current = requestFixture().portfolio; current.as_of = new Date(NOW).toISOString(); current.settled_cash = '1100';
  assert.ok(reconcile(requestFixture().portfolio, current, ledger).includes('unresolved_action'));
  await ingestEvents(ledger, [{ ...events[1]!, revision: 2, status: 'resolved', passive_shares: '0.5' } as LedgerEvent]);
  current.positions = [{ instrument_id: 'TOY2', shares: '0.5', role: 'passive', blocked_reason: 'unpriced' }];
  assert.deepEqual(reconcile(requestFixture().portfolio, current, ledger), []); assert.equal(current.positions[0]!.blocked_reason, 'unpriced');
});
test('Telegram callbacks fit byte limit, resolve saved versions and summaries contain no amounts/instruments', async () => {
  const state = await planned(), proposal = latest(state)!.proposal!;
  for (const action of ['seen', 'skip', 'placed', 'sync'] as const) {
    const data = callbackData(action, proposal); assert.ok(Buffer.byteLength(data) <= 64);
    assert.deepEqual(resolveCallback(state, data), { proposal_id: proposal.proposal_id, action });
  }
  assert.throws(() => resolveCallback(state, 'buy all'), code('invalid_callback'));
  const body = JSON.stringify(notification(state, NOW)); assert.ok(!body.includes('1000')); assert.ok(!body.includes('FAKE'));
});
test('Telegram authenticates exact numeric user AND chat, never text or username', () => {
  const value = { update_id: 123, callback_query: { data: 'seen:' + '0'.repeat(32), from: { id: 100001, is_bot: false }, message: { chat: { id: -100001 } } } };
  assert.equal(parseTelegram(value, '100001', '-100001').event_id, 'telegram:123');
  assert.throws(() => parseTelegram(value, '100002', '-100001'), code('telegram_forbidden'));
  assert.throws(() => parseTelegram(value, '100001', '100001'), code('telegram_forbidden'));
  assert.throws(() => parseTelegram({ update_id: 1, message: { text: 'buy all' } }, '100001', '-100001'), code('telegram_forbidden'));
});
