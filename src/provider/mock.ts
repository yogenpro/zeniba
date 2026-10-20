import { CONTRACT_SHA256, accountHash, portfolioBlocks, spendable, validateRequest, validateRequestWindow } from '../contract';
import { D, ZERO } from '../decimal';
import { SafeError, safeFailure } from '../errors';
import { byteLength, hashObject, parseJson, readBody } from '../json';
import { SCHEMA, type Clock, type Descriptor, type Portfolio, type Proposal, type ProposalRequest, type Transport } from '../types';

export const MOCK_RELEASE = '0'.repeat(64);
export const MOCK_TOKEN = 'offline-transport-only';
export async function mockDescriptor(now: number): Promise<Descriptor> {
  const content: Omit<Descriptor, 'input_snapshot_id'> = { schema: SCHEMA, release_id: MOCK_RELEASE,
    decision_at: new Date(now - 60 * 60000).toISOString(), execution_at: new Date(now + 120 * 60000).toISOString(),
    valid_until: new Date(now + 60 * 60000).toISOString(), input_provenance: 'synthetic',
    instruments: [{ instrument_id: 'TOY1', symbol: 'FAKE' }] };
  // Each persisted synthetic window is its own immutable input identity, not a moving 'latest'.
  return { ...content, input_snapshot_id: await hashObject(content) };
}
export function syntheticPortfolio(d: Descriptor, now: number): Portfolio {
  return { account_ref: 'toy-account', as_of: d.decision_at, observed_at: new Date(now).toISOString(),
    currency: 'USD', settled_cash: '1000', positions: [], claims: [], open_orders: [] };
}
function response(value: unknown, status = 200): Response {
  const body = JSON.stringify(value);
  return new Response(body, { status, headers: { 'Content-Type': 'application/json',
    'Content-Length': String(byteLength(body)), 'Cache-Control': 'no-store' } });
}
/** Fixed toy intent, NOT an investment algorithm. No external I/O or real input support. */
export function mockTransport(descriptor: Descriptor, clock: Clock): Transport {
  return async request => {
    try {
      if (request.headers.get('authorization') !== `Bearer ${MOCK_TOKEN}`) throw new SafeError('auth_failed', 401);
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === '/v1/health') return response({ schema: SCHEMA,
        release_id: descriptor.release_id, contract_sha256: CONTRACT_SHA256, mode: 'shadow', status: 'ok' });
      if (request.method === 'GET' && path === `/v1/inputs/${descriptor.input_snapshot_id}`) return response(descriptor);
      if (request.method !== 'POST' || path !== '/v1/proposals') throw new SafeError('not_found', 404);
      if (request.headers.get('content-type') !== 'application/json' || !request.headers.has('content-length')) throw new SafeError('invalid_content_type', 415);
      const body = await readBody(request);
      if (String(byteLength(body)) !== request.headers.get('content-length')) throw new SafeError('invalid_length', 400);
      const value = parseJson(body); validateRequest(value);
      validateRequestWindow(value, descriptor, clock());
      return response(await toyProposal(value, descriptor));
    } catch (error) { const failure = safeFailure(error); return response({ error: { code: failure.code } }, failure.status); }
  };
}
export async function toyProposal(r: ProposalRequest, d: Descriptor): Promise<Proposal> {
  const codes = portfolioBlocks(r.portfolio);
  // This fixture only models a cash-only starting point. Unknown/unpriced holdings stay blocked.
  if (r.portfolio.positions.length) codes.push('toy_fixture_cash_only');
  let cash = spendable(r.portfolio); if (cash.compare(ZERO) < 0) cash = ZERO;
  if (cash.compare(D('360')) < 0) codes.push('toy_fixture_insufficient_cash');
  let value = D(r.portfolio.settled_cash);
  for (const claim of r.portfolio.claims) if (claim.amount !== null) {
    value = claim.direction === 'credit' ? value.add(D(claim.amount)) : value.sub(D(claim.amount));
  }
  const knownValue = !r.portfolio.positions.length && !r.portfolio.claims.some(c => c.amount === null) && value.compare(ZERO) >= 0;
  const blocked = codes.length > 0;
  const content: Omit<Proposal, 'proposal_id'> = {
    schema: SCHEMA, request_id: r.request_id, release_id: r.release_id, input_snapshot_id: r.input_snapshot_id,
    request_hash: await hashObject(r), account_state_hash: await accountHash(r.portfolio), account_ref: r.portfolio.account_ref,
    decision_at: d.decision_at, execution_at: d.execution_at, valid_until: d.valid_until,
    mode: 'shadow', requires_human_review: true, broker_execution_enabled: false, input_provenance: 'synthetic',
    portfolio_value: knownValue ? value.toString() : null,
    spendable_cash: cash.toString(), status: blocked ? 'blocked' : 'proposed',
    orders: blocked ? [] : [{ intent_id: 'toy-intent-1', instrument_id: 'TOY1', symbol: 'FAKE', side: 'buy',
      shares: '7', action: 'entry', reference_price: '50', maximum_debit: '360', currency: 'USD', execution_at: d.execution_at }],
    blocks: codes.map(code => ({ code, instrument_id: null, fatal: true })),
    warnings: ['shadow_only_not_authorized_for_execution', 'synthetic_transport_fixture', 'execution_order_type_not_selected']
  };
  return { ...content, proposal_id: await hashObject(content) };
}
