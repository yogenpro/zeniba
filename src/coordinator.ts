import { DurableObject } from 'cloudflare:workers';
import { observeMock } from './broker/mock-observer';
import { ID, utc } from './contract';
import { applyObservation, applyWorkflow, bindRequest, latest, newAccount, proposalStatus, readiness, saveProposal,
  type AccountState, type WorkflowAction } from './domain/account';
import { requireSafe, SafeError } from './errors';
import { failure, json, objectBody, stringField } from './http';
import { byteLength, canonicalJson, hashBytes, hashObject } from './json';
import { ProviderClient } from './provider/client';
import { MOCK_TOKEN, mockDescriptor, mockTransport, syntheticPortfolio } from './provider/mock';
import { notification, resolveCallback } from './telegram';

export interface Env {
  APP_MODE: string; OWNER_TOKEN?: string; TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_USER_ID?: string; TELEGRAM_CHAT_ID?: string;
  ACCOUNTS: DurableObjectNamespace; EVIDENCE: R2Bucket;
}
/** One durable account aggregate, serialized across EVERY await, including R2/provider I/O.
 * No token refresh or broker-writing methods exist. SQL transactions publish receipts with state.
 */
export class AccountCoordinator extends DurableObject<Env> {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS account_state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (event_id TEXT PRIMARY KEY, body_hash TEXT NOT NULL, result TEXT NOT NULL);`);
  }
  fetch(request: Request): Promise<Response> {
    const task = this.tail.then(() => this.handle(request)).catch(failure);
    this.tail = task.then(() => undefined, () => undefined); return task;
  }
  private load(): AccountState | null {
    const row = this.ctx.storage.sql.exec<{ payload: string }>('SELECT payload FROM account_state WHERE id=1').toArray()[0];
    return row ? JSON.parse(row.payload) as AccountState : null;
  }
  private commit(state: AccountState, receipt?: { id: string; hash: string; result: unknown }): void {
    const payload = JSON.stringify(state);
    requireSafe(byteLength(payload) <= 1500000, 'account_capacity_requires_archive');
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('INSERT INTO account_state (id,payload) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', payload);
      if (receipt) this.ctx.storage.sql.exec('INSERT INTO commands(event_id,body_hash,result) VALUES(?,?,?)', receipt.id, receipt.hash, JSON.stringify(receipt.result));
    });
  }
  private async archive(state: AccountState, kind: string, raw: string): Promise<string> {
    requireSafe(state.evidence_keys.length < 10000, 'evidence_capacity_requires_archive');
    const hash = await hashBytes(raw), key = `evidence/${hash}.json`;
    // Persist raw bytes BEFORE publishing a checkpoint. A failed SQL commit may leave an orphan,
    // but cannot advance the ledger without evidence. Content addressing makes retries harmless.
    await this.env.EVIDENCE.put(key, raw, { httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' }, customMetadata: { kind } });
    if (!state.evidence_keys.includes(key)) state.evidence_keys.push(key); return key;
  }
  private client(state: AccountState): ProviderClient {
    return new ProviderClient({ baseUrl: 'https://mock.invalid/', token: MOCK_TOKEN,
      releaseId: state.descriptor.release_id, inputId: state.descriptor.input_snapshot_id,
      clock: Date.now, transport: mockTransport(state.descriptor, Date.now) });
  }
  private async sync(state: AccountState, now: number): Promise<void> {
    const observation = observeMock(state, now);
    await this.archive(state, 'synthetic_broker_observation', canonicalJson(observation));
    await applyObservation(state, observation, now);
  }
  private view(state: AccountState, now: number): unknown {
    return { mode: 'mock', shadow: true, broker_execution_enabled: false, account_ref: state.cutoff.account_ref,
      descriptor: state.descriptor, revision: state.revision, observed_at: state.observed_at, readiness: readiness(state, now),
      current: state.current, issues: state.issues, ledger: Object.values(state.ledger.effective),
      evidence_count: state.evidence_keys.length, workflow_events: state.workflow_events.slice(-100),
      proposals: Object.values(state.requests).filter(r => r.proposal).slice(-50).map(r => ({ proposal: r.proposal, status: proposalStatus(state, r, now) })),
      latest_proposal_id: latest(state)?.proposal?.proposal_id ?? null, mock_scenario: state.mock_scenario };
  }
  private async handle(request: Request): Promise<Response> {
    requireSafe(this.env.APP_MODE === 'mock', 'mock_only_build', 503);
    const path = new URL(request.url).pathname, now = Date.now();
    let state = this.load();
    if (path === '/api/bootstrap' && request.method === 'POST') {
      await objectBody(request, []);
      if (!state) {
        const d = await mockDescriptor(now); state = newAccount(d, syntheticPortfolio(d, now));
        await this.sync(state, now); this.commit(state);
      }
      return json({ ok: true, mode: 'mock' });
    }
    requireSafe(state, 'account_not_initialized', 409);
    if (path === '/api/state' && request.method === 'GET') return json(this.view(state, now));
    if (path === '/api/notification' && request.method === 'GET') return json(notification(state, now));
    if (path === '/api/proposals' && request.method === 'POST') {
      const body = await objectBody(request, ['request_id']); const id = stringField(body, 'request_id');
      const saved = await bindRequest(state, id, now);
      if (saved.proposal) return json({ ok: true, proposal_id: saved.proposal.proposal_id, status: proposalStatus(state, saved, now) });
      requireSafe(saved.account_revision === state.revision && readiness(state, now).length === 0, 'account_changed');
      // Durable identity is saved before transport, even if the provider subsequently fails.
      this.commit(state);
      const client = this.client(state); await client.health(); const descriptor = await client.descriptor();
      requireSafe(canonicalJson(descriptor) === canonicalJson(state.descriptor), 'descriptor_changed');
      await this.archive(state, 'provider_request', saved.body);
      const response = await client.propose(saved.body, descriptor);
      await this.archive(state, 'provider_response', response.raw);
      requireSafe(Date.now() < utc(response.proposal.valid_until), 'proposal_expired');
      requireSafe(readiness(state, Date.now()).length === 0, 'account_not_ready');
      await saveProposal(state, id, response.proposal, response.raw); this.commit(state);
      return json({ ok: true, proposal_id: response.proposal.proposal_id, status: proposalStatus(state, saved, Date.now()) });
    }
    if (request.method !== 'POST') throw new SafeError('not_found', 404);
    const fields: Record<string, string[]> = {
      '/api/sync': ['event_id'], '/api/synthetic': ['event_id', 'scenario'], '/api/backup': ['event_id'],
      '/api/workflow': ['event_id', 'proposal_id', 'action'], '/internal/telegram': ['event_id', 'callback_data']
    };
    const keys = fields[path]; requireSafe(keys, 'not_found', 404);
    const body = await objectBody(request, keys), eventId = stringField(body, 'event_id');
    requireSafe(ID.test(eventId), 'invalid_event_id', 400);
    const hash = await hashObject({ path, body });
    const receipt = this.ctx.storage.sql.exec<{ body_hash: string; result: string }>('SELECT body_hash,result FROM commands WHERE event_id=?', eventId).toArray()[0];
    if (receipt) { requireSafe(receipt.body_hash === hash, 'command_id_conflict'); return json(JSON.parse(receipt.result)); }
    const count = this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM commands').toArray()[0]!.n;
    requireSafe(count < 10000, 'command_capacity_requires_archive');
    let result: unknown = { ok: true };
    if (path === '/api/sync') await this.sync(state, now);
    if (path === '/api/synthetic') {
      const scenario = stringField(body, 'scenario');
      requireSafe(scenario === 'partial' || scenario === 'canceled', 'invalid_scenario', 400);
      requireSafe(state.mock_scenario !== 'canceled' || scenario === 'canceled', 'scenario_rewind_forbidden');
      state.mock_scenario = scenario; await this.sync(state, now);
    }
    if (path === '/api/workflow' || path === '/internal/telegram') {
      const binding = path === '/internal/telegram' ? resolveCallback(state, stringField(body, 'callback_data'))
        : { proposal_id: stringField(body, 'proposal_id'), action: stringField(body, 'action') as WorkflowAction };
      const changed = await applyWorkflow(state, { event_id: eventId, ...binding, received_at: new Date(now).toISOString() }, now);
      if (changed && (binding.action === 'placed' || binding.action === 'sync')) await this.sync(state, now);
    }
    if (path === '/api/backup') {
      const commands = this.ctx.storage.sql.exec<{ event_id: string; body_hash: string; result: string }>(
        'SELECT event_id,body_hash,result FROM commands ORDER BY event_id').toArray();
      const raw = canonicalJson({ format: 'zeniba.private-backup.v1', created_at: new Date(now).toISOString(), state, commands });
      const key = `backups/${await hashBytes(raw)}.json`;
      await this.env.EVIDENCE.put(key, raw, { httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' } });
      result = { ok: true, backup_key: key }; // The key is not a public URL or access grant.
    }
    this.commit(state, { id: eventId, hash, result }); return json(result);
  }
}
