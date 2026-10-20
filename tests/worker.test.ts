import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import { hashBytes } from '../src/json';

// Entirely synthetic test credentials; no environment secret or private handoff is loaded.
const OWNER = 'synthetic-test-owner-token-not-a-real-secret';
const TELEGRAM = 'synthetic_test_webhook_token_1234567890';
const bindings = { APP_MODE: 'mock', OWNER_TOKEN: OWNER, TELEGRAM_WEBHOOK_SECRET: TELEGRAM,
  TELEGRAM_USER_ID: '100001', TELEGRAM_CHAT_ID: '100001' };

test('mock-only Worker: authenticated owner, SQLite coordination, private R2 evidence and durable retries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zeniba-synthetic-'));
  let outboundCalls = 0;
  const options = {
    scriptPath: resolve('.build/worker.mjs'), modules: true, compatibilityDate: '2026-07-30',
    host: '127.0.0.1', port: 0, bindings,
    durableObjects: { ACCOUNTS: { className: 'AccountCoordinator', useSQLite: true } },
    r2Buckets: ['EVIDENCE'], durableObjectsPersist: join(directory, 'do'), r2Persist: join(directory, 'r2'),
    outboundService: async () => { outboundCalls++; throw new Error('Outbound network forbidden in tests'); }
  };
  let mf = new Miniflare(options);
  t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  const call = (path: string, body?: unknown, extra: Record<string, string> = {}) => mf.dispatchFetch(`https://zeniba.test${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${OWNER}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  let proposalId = '';
  await t.test('public auth shell has no account data and authenticated APIs fail closed', async () => {
    const shell = await mf.dispatchFetch('https://zeniba.test/'); assert.equal(shell.status, 200);
    assert.match(shell.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    const text = await shell.text(); assert.ok(!text.includes(OWNER)); assert.ok(!text.includes(TELEGRAM));
    assert.ok(!text.includes('localStorage')); assert.ok(!text.includes('toy-account'));
    const unauth = await mf.dispatchFetch('https://zeniba.test/api/state'); assert.equal(unauth.status, 401);
    assert.equal(unauth.headers.get('cache-control'), 'no-store'); assert.ok(!unauth.headers.has('access-control-allow-origin'));
    assert.equal((await call('/api/bootstrap', {}, { Origin: 'https://evil.invalid' })).status, 403);
    assert.equal((await call('/api/state?token=secret')).status, 400);
  });
  await t.test('initialization is idempotent and rejects unknown fields/duplicate JSON', async () => {
    assert.equal((await call('/api/bootstrap', { hidden: true })).status, 400);
    assert.equal((await call('/api/bootstrap', {})).status, 200); assert.equal((await call('/api/bootstrap', {})).status, 200);
    const duplicate = await mf.dispatchFetch('https://zeniba.test/api/proposals', { method: 'POST', headers: {
      Authorization: `Bearer ${OWNER}`, 'Content-Type': 'application/json' }, body: '{"request_id":"a","request_id":"b"}' });
    assert.equal(duplicate.status, 400); assert.equal((await duplicate.json() as any).error.code, 'duplicate_json_key');
    const view: any = await (await call('/api/state')).json(); assert.deepEqual(view.readiness, []);
    assert.equal(view.current.settled_cash, '1000'); assert.equal(view.proposals.length, 0);
  });
  await t.test('concurrent duplicate proposal commands serialize across provider/archive awaits', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => call('/api/proposals', { request_id: 'durable-request-1' })));
    const bodies = await Promise.all(results.map(async r => { assert.equal(r.status, 200, await r.clone().text()); return r.json() as Promise<any>; }));
    proposalId = bodies[0].proposal_id; assert.ok(bodies.every(b => b.proposal_id === proposalId));
    const view: any = await (await call('/api/state')).json(); assert.equal(view.proposals.length, 1);
    assert.equal(view.proposals[0].proposal.broker_execution_enabled, false); assert.equal(view.proposals[0].proposal.input_provenance, 'synthetic');
    assert.equal((await call('/api/proposals', { request_id: 'durable-request-1', portfolio: {} })).status, 400);
  });
  await t.test('owner workflow is version-bound, idempotent and never becomes a fill', async () => {
    const body = { event_id: 'owner-event-1', proposal_id: proposalId, action: 'placed' };
    assert.equal((await call('/api/workflow', body)).status, 200); assert.equal((await call('/api/workflow', body)).status, 200);
    assert.equal((await call('/api/workflow', { ...body, action: 'skip' })).status, 409);
    assert.equal((await call('/api/workflow', { ...body, event_id: 'unknown', proposal_id: 'f'.repeat(64) })).status, 409);
    const view: any = await (await call('/api/state')).json(); assert.deepEqual(view.ledger, []);
    assert.deepEqual(view.current.positions, []); assert.equal(view.workflow_events.length, 1);
  });
  const telegramUpdate = (id: number, action = 'seen', user = 100001, chat = 100001) => ({ update_id: id, callback_query: {
    id: 'synthetic-query', data: `${action}:${proposalId.slice(0, 32)}`, from: { id: user, is_bot: false }, message: { chat: { id: chat } }
  } });
  const telegramCall = (body: unknown, secret = TELEGRAM) => mf.dispatchFetch('https://zeniba.test/telegram/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(body)
  });
  await t.test('Telegram secret plus numeric user/chat IDs and durable update identity are enforced', async () => {
    assert.equal((await telegramCall(telegramUpdate(1), 'wrong')).status, 401);
    assert.equal((await telegramCall(telegramUpdate(1, 'seen', 100002))).status, 403);
    assert.equal((await telegramCall(telegramUpdate(1, 'seen', 100001, 100002))).status, 403);
    assert.equal((await telegramCall({ update_id: 1, message: { text: 'buy' } })).status, 403);
    assert.equal((await telegramCall(telegramUpdate(2))).status, 200); assert.equal((await telegramCall(telegramUpdate(2))).status, 200);
    assert.equal((await telegramCall(telegramUpdate(2, 'skip'))).status, 409);
    const view: any = await (await call('/api/state')).json(); assert.equal(view.workflow_events.length, 2); assert.deepEqual(view.ledger, []);
    const message = await (await call('/api/notification')).text(); assert.ok(!message.includes('1000')); assert.ok(!message.includes('FAKE'));
  });
  await t.test('raw evidence and backups are private, content-addressed and bound to the durable checkpoint', async () => {
    const body = { event_id: 'backup-one' }; const first: any = await (await call('/api/backup', body)).json();
    const second: any = await (await call('/api/backup', body)).json(); assert.equal(first.backup_key, second.backup_key);
    const bucket = await mf.getR2Bucket('EVIDENCE'); const object = await bucket.get(first.backup_key); assert.ok(object);
    const raw = await object.text(); assert.equal(first.backup_key, `backups/${await hashBytes(raw)}.json`);
    const saved = JSON.parse(raw); assert.equal(saved.format, 'zeniba.private-backup.v1');
    assert.ok(saved.commands.some((c: any) => c.event_id === 'telegram:2'));
    assert.ok(saved.commands.some((c: any) => c.event_id === 'owner-event-1'));
    assert.ok(!raw.includes(OWNER)); assert.ok(!raw.includes(TELEGRAM));
    for (const key of saved.state.evidence_keys) {
      const evidence = await bucket.get(key); assert.ok(evidence); const bytes = await evidence.text();
      assert.equal(key, `evidence/${await hashBytes(bytes)}.json`);
    }
    assert.equal((await call('/api/evidence')).status, 404);
  });
  await t.test('SQLite and event deduplication survive complete Worker shutdown/restart', async () => {
    await mf.dispose(); mf = new Miniflare(options);
    assert.equal((await call('/api/proposals', { request_id: 'durable-request-1' })).status, 200);
    assert.equal((await telegramCall(telegramUpdate(2))).status, 200);
    const view: any = await (await call('/api/state')).json(); assert.equal(view.proposals.length, 1); assert.equal(view.workflow_events.length, 2);
    assert.equal(view.latest_proposal_id, proposalId);
  });
  await t.test('synthetic partial/cancel evidence is deduplicated, retains actual exposure and invalidates plan', async () => {
    const partial = { event_id: 'partial-one', scenario: 'partial' };
    assert.equal((await call('/api/synthetic', partial)).status, 200); assert.equal((await call('/api/synthetic', partial)).status, 200);
    let view: any = await (await call('/api/state')).json(); assert.equal(view.current.positions[0].shares, '2');
    assert.equal(view.ledger.filter((e: any) => e.kind === 'execution').length, 1); assert.equal(view.current.open_orders.length, 1);
    assert.equal(view.proposals[0].status, 'stale'); const revision = view.revision;
    assert.equal((await call('/api/sync', { event_id: 'overlapping-sync' })).status, 200);
    view = await (await call('/api/state')).json(); assert.equal(view.revision, revision);
    assert.equal((await call('/api/synthetic', { event_id: 'cancel-one', scenario: 'canceled' })).status, 200);
    view = await (await call('/api/state')).json(); assert.equal(view.current.positions[0].shares, '2'); assert.equal(view.current.open_orders.length, 0);
    assert.equal(view.current.claims[0].amount, '100'); assert.equal(view.current.settled_cash, '1000');
    assert.equal((await call('/api/proposals', { request_id: 'cannot-relabel-current-state' })).status, 409);
    assert.equal((await call('/api/synthetic', { event_id: 'rewind', scenario: 'partial' })).status, 409);
    assert.equal((await call('/api/orders/submit', { event_id: 'no-write' })).status, 404);
  });
  assert.equal(outboundCalls, 0, 'No real provider, Telegram or broker HTTP is permitted');
});

test('missing owner secret and non-mock configuration disable the application', async () => {
  const mf = new Miniflare({ scriptPath: resolve('.build/worker.mjs'), modules: true, compatibilityDate: '2026-07-30',
    bindings: { APP_MODE: 'mock' }, durableObjects: { ACCOUNTS: { className: 'AccountCoordinator', useSQLite: true } }, r2Buckets: ['EVIDENCE'] });
  try {
    const response = await mf.dispatchFetch('https://zeniba.test/'); assert.equal(response.status, 503);
    assert.equal((await response.json() as any).error.code, 'owner_not_configured');
    await mf.setOptions({ scriptPath: resolve('.build/worker.mjs'), modules: true, compatibilityDate: '2026-07-30',
      bindings: { APP_MODE: 'live', OWNER_TOKEN: OWNER }, durableObjects: { ACCOUNTS: { className: 'AccountCoordinator', useSQLite: true } }, r2Buckets: ['EVIDENCE'] });
    assert.equal((await mf.dispatchFetch('https://zeniba.test/')).status, 503);
  } finally { await mf.dispose(); }
});
