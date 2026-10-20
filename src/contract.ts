import { validate_request, validate_proposal, validate_descriptor, validate_health } from '../.generated/validators.cjs';
import { D, ZERO, nonnegative, positive } from './decimal';
import { requireSafe } from './errors';
import { hashObject } from './json';
import { SCHEMA, type Descriptor, type Health, type Portfolio, type Proposal, type ProposalRequest } from './types';
export { CONTRACT_SHA256 } from '../.generated/contract';

export const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export function utc(time: string): number {
  // Schema checks calendar validity; explicit UTC avoids accidental local-time interpretation.
  requireSafe(typeof time === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(time)
    && Number.isFinite(Date.parse(time)) && new Date(time).toISOString().slice(0, 19) === time.slice(0, 19), 'invalid_time', 400);
  return Date.parse(time);
}
function unique(values: string[]): void { requireSafe(new Set(values).size === values.length, 'duplicate_identity', 400); }
export function validatePortfolio(p: Portfolio): void {
  // Use the authoritative schema for nested objects too, without a second handwritten schema.
  requireSafe(validate_request({ schema: SCHEMA, request_id: 'validation', release_id: '0'.repeat(64),
    input_snapshot_id: '1'.repeat(64), requested_at: p.observed_at, portfolio: p }), 'invalid_portfolio', 400);
  utc(p.as_of); utc(p.observed_at); nonnegative(p.settled_cash);
  unique(p.positions.map(x => x.instrument_id)); unique(p.claims.map(x => x.claim_ref));
  for (const x of p.positions) positive(x.shares);
  for (const x of p.claims) if (x.amount !== null) nonnegative(x.amount);
}
export function validateRequest(value: unknown): asserts value is ProposalRequest {
  requireSafe(validate_request(value), 'invalid_request', 400);
  const r = value as ProposalRequest; utc(r.requested_at); validatePortfolio(r.portfolio);
}
export function validateHealth(value: unknown, release: string, schemaHash: string): asserts value is Health {
  requireSafe(validate_health(value), 'invalid_health', 502);
  const h = value as Health;
  requireSafe(h.release_id === release && h.contract_sha256 === schemaHash, 'provider_pin_mismatch', 502);
}
export function validateDescriptor(value: unknown, release: string, input: string, now: number): asserts value is Descriptor {
  requireSafe(validate_descriptor(value), 'invalid_descriptor', 502);
  const d = value as Descriptor;
  requireSafe(d.release_id === release && d.input_snapshot_id === input, 'provider_pin_mismatch', 502);
  requireSafe(utc(d.decision_at) <= now && utc(d.decision_at) < utc(d.valid_until)
    && utc(d.valid_until) <= utc(d.execution_at), 'invalid_window', 502);
  requireSafe(now < utc(d.valid_until), 'proposal_expired');
  unique(d.instruments.map(x => x.instrument_id)); unique(d.instruments.map(x => x.symbol));
}
export function validateRequestWindow(r: ProposalRequest, d: Descriptor, now: number): void {
  validateRequest(r);
  requireSafe(r.release_id === d.release_id && r.input_snapshot_id === d.input_snapshot_id, 'provider_pin_mismatch');
  requireSafe(r.portfolio.as_of === d.decision_at, 'cutoff_state_required');
  const observed = utc(r.portfolio.observed_at), requested = utc(r.requested_at);
  requireSafe(observed >= utc(d.decision_at) && observed <= now + 30000 && observed >= now - 15 * 60000, 'stale_account');
  requireSafe(requested <= now + 30000 && requested >= now - 5 * 60000, 'stale_request');
  requireSafe(now < utc(d.valid_until), 'proposal_expired');
}
export function accountIdentity(p: Portfolio): Omit<Portfolio, 'observed_at'> {
  const { observed_at: _observed, ...identity } = p; return identity;
}
/** For current-vs-cutoff comparison only. Does NOT turn current data into cutoff state. */
export function economicIdentity(p: Portfolio): Omit<Portfolio, 'observed_at' | 'as_of'> {
  const { as_of: _cutoff, ...identity } = accountIdentity(p); return identity;
}
export function accountHash(p: Portfolio): Promise<string> { return hashObject(accountIdentity(p)); }
export function portfolioBlocks(p: Portfolio): string[] {
  const blocks: string[] = [];
  if (p.open_orders.length) blocks.push('outstanding_orders');
  if (p.positions.some(x => x.blocked_reason !== null)) blocks.push('unresolved_exposure');
  if (p.claims.some(x => x.amount === null)) blocks.push('unknown_claim');
  if (spendable(p).compare(ZERO) < 0) blocks.push('reserved_debits_exceed_cash');
  return blocks;
}
export function spendable(p: Portfolio) {
  let cash = D(p.settled_cash);
  for (const c of p.claims) if (c.direction === 'debit' && c.amount !== null) cash = cash.sub(D(c.amount));
  return cash; // Credits and sale proceeds are never added here.
}
export async function validateProposal(value: unknown, r: ProposalRequest, d: Descriptor, now: number): Promise<Proposal> {
  requireSafe(validate_proposal(value), 'invalid_proposal', 502);
  const p = value as Proposal;
  requireSafe(p.request_id === r.request_id && p.release_id === r.release_id && p.input_snapshot_id === r.input_snapshot_id
    && p.account_ref === r.portfolio.account_ref && p.input_provenance === d.input_provenance, 'proposal_binding_mismatch', 502);
  requireSafe(p.decision_at === d.decision_at && p.execution_at === d.execution_at && p.valid_until === d.valid_until, 'proposal_window_mismatch', 502);
  requireSafe(now < utc(p.valid_until), 'proposal_expired');
  const { proposal_id: _id, ...content } = p;
  requireSafe(p.request_hash === await hashObject(r) && p.account_state_hash === await accountHash(r.portfolio)
    && p.proposal_id === await hashObject(content), 'proposal_hash_mismatch', 502);
  nonnegative(p.spendable_cash);
  if (p.portfolio_value !== null) nonnegative(p.portfolio_value);
  const fatal = p.blocks.some(b => b.fatal);
  requireSafe(p.status !== 'blocked' || p.orders.length === 0, 'blocked_proposal_has_orders', 502);
  requireSafe(p.status !== 'proposed' || (!fatal && p.portfolio_value !== null && portfolioBlocks(r.portfolio).length === 0), 'unsafe_proposal', 502);
  if (p.status === 'proposed') requireSafe(D(p.spendable_cash).compare(spendable(r.portfolio)) <= 0, 'unsafe_cash', 502);
  unique(p.orders.map(o => o.intent_id));
  let debits = ZERO;
  const sold = new Map<string, ReturnType<typeof D>>();
  for (const o of p.orders) {
    const instrument = d.instruments.find(x => x.instrument_id === o.instrument_id);
    requireSafe(instrument?.symbol === o.symbol && o.execution_at === d.execution_at, 'intent_binding_mismatch', 502);
    positive(o.shares); requireSafe(o.reference_price !== null, 'unpriced_intent', 502); positive(o.reference_price);
    if (o.maximum_debit !== null) nonnegative(o.maximum_debit);
    if (o.side === 'buy') {
      requireSafe(o.maximum_debit !== null && o.reference_price !== null, 'unbounded_debit', 502);
      requireSafe(D(o.maximum_debit).compare(D(o.shares).mul(D(o.reference_price))) >= 0, 'unsafe_debit', 502);
      debits = debits.add(D(o.maximum_debit));
    } else {
      const holding = r.portfolio.positions.find(x => x.instrument_id === o.instrument_id && x.role === 'primary');
      const total = (sold.get(o.instrument_id) ?? ZERO).add(D(o.shares)); sold.set(o.instrument_id, total);
      requireSafe(holding && total.compare(D(holding.shares)) <= 0, 'unowned_sale', 502);
    }
  }
  requireSafe(debits.compare(D(p.spendable_cash)) <= 0, 'unsafe_debit', 502);
  return p;
}
