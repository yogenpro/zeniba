import { validatePortfolio, utc } from '../contract';
import { D, ZERO, nonnegative, positive } from '../decimal';
import { requireSafe } from '../errors';
import { canonicalJson, hashObject } from '../json';
import type { Portfolio, Position } from '../types';

interface Versioned { revision: number; occurred_at: string }
export interface Execution extends Versioned {
  kind: 'execution'; execution_id: string; order_id: string; instrument_id: string;
  side: 'buy' | 'sell'; shares: string; price: string; fee: string;
  role: 'primary' | 'passive' | 'unknown'; reversed: boolean;
}
export interface BrokerOrder extends Versioned {
  kind: 'order'; order_id: string; instrument_id: string; side: 'buy' | 'sell';
  shares: string; filled_shares: string; status: 'open' | 'partial' | 'filled' | 'canceled' | 'rejected';
}
export interface CashFlow extends Versioned {
  kind: 'cash_flow'; transaction_id: string; category: 'deposit' | 'withdrawal' | 'fee' | 'settlement';
  amount: string; direction: 'credit' | 'debit'; reversed: boolean;
}
export interface CorporateAction extends Versioned {
  kind: 'action'; action_id: string; instrument_id: string; status: 'unresolved' | 'resolved';
  passive_shares: string | null;
}
export type LedgerEvent = Execution | BrokerOrder | CashFlow | CorporateAction;
export interface Ledger {
  receipts: Record<string, string>;
  effective: Record<string, LedgerEvent>;
  earliest: Record<string, string>;
}
export interface Observation {
  evidence_id: string; observed_at: string; events: LedgerEvent[];
  current: Portfolio | null; complete: boolean; issues: string[];
  // An adapter must actually verify/reconstruct this historical snapshot; never relabel current.
  verified_cutoff: Portfolio | null;
}
export function emptyLedger(): Ledger { return { receipts: {}, effective: {}, earliest: {} }; }
function eventId(event: LedgerEvent): string {
  switch (event.kind) {
    case 'execution': return `execution:${event.execution_id}`;
    case 'order': return `order:${event.order_id}`;
    case 'cash_flow': return `cash_flow:${event.transaction_id}`;
    case 'action': return `action:${event.action_id}`;
  }
}
function validateEvent(e: LedgerEvent): void {
  requireSafe(e && ['execution', 'order', 'cash_flow', 'action'].includes(e.kind), 'invalid_ledger_event');
  const fields = {
    execution: ['execution_id', 'order_id', 'instrument_id', 'side', 'shares', 'price', 'fee', 'role', 'reversed'],
    order: ['order_id', 'instrument_id', 'side', 'shares', 'filled_shares', 'status'],
    cash_flow: ['transaction_id', 'category', 'amount', 'direction', 'reversed'],
    action: ['action_id', 'instrument_id', 'status', 'passive_shares']
  };
  const keys = ['kind', 'revision', 'occurred_at', ...fields[e.kind]];
  requireSafe(Object.keys(e).length === keys.length && Object.keys(e).every(k => keys.includes(k)), 'invalid_ledger_event');
  for (const [key, value] of Object.entries(e)) if (key.endsWith('_id')) {
    requireSafe(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value), 'invalid_broker_identity');
  }
  requireSafe(Number.isSafeInteger(e.revision) && e.revision > 0, 'invalid_ledger_revision'); utc(e.occurred_at);
  if (e.kind === 'execution' || e.kind === 'order') requireSafe(e.side === 'buy' || e.side === 'sell', 'invalid_ledger_event');
  if (e.kind === 'execution') {
    positive(e.shares); positive(e.price); nonnegative(e.fee);
    requireSafe(['primary', 'passive', 'unknown'].includes(e.role) && typeof e.reversed === 'boolean', 'invalid_ledger_event');
  }
  if (e.kind === 'order') {
    positive(e.shares); nonnegative(e.filled_shares);
    requireSafe(['open', 'partial', 'filled', 'canceled', 'rejected'].includes(e.status), 'invalid_ledger_event');
    requireSafe(D(e.filled_shares).compare(D(e.shares)) <= 0, 'invalid_order_quantity');
  }
  if (e.kind === 'cash_flow') {
    nonnegative(e.amount);
    requireSafe(['deposit', 'withdrawal', 'fee', 'settlement'].includes(e.category)
      && (e.direction === 'credit' || e.direction === 'debit') && typeof e.reversed === 'boolean', 'invalid_ledger_event');
  }
  if (e.kind === 'action') {
    requireSafe(e.status === 'resolved' || e.status === 'unresolved', 'invalid_ledger_event');
    if (e.passive_shares !== null) nonnegative(e.passive_shares);
  }
}
/** Both order and transaction views must normalize a fill to the SAME execution identity.
 * Order statuses themselves never manufacture fills, cash or holdings.
 */
export async function ingestEvents(ledger: Ledger, events: LedgerEvent[]): Promise<boolean> {
  let changed = false;
  for (const event of events) {
    validateEvent(event);
    const key = eventId(event), receipt = `${key}:${event.revision}`, hash = await hashObject(event);
    if (ledger.receipts[receipt]) {
      requireSafe(ledger.receipts[receipt] === hash, 'broker_identity_conflict'); continue;
    }
    requireSafe(Object.keys(ledger.receipts).length < 10000, 'ledger_capacity_requires_archive');
    ledger.receipts[receipt] = hash;
    if (!ledger.earliest[key] || utc(event.occurred_at) < utc(ledger.earliest[key]!)) ledger.earliest[key] = event.occurred_at;
    const previous = ledger.effective[key];
    if (previous && previous.revision >= event.revision) continue; // Overlapping/reordered fetch.
    ledger.effective[key] = structuredClone(event); changed = true;
  }
  return changed;
}
export function reconcile(baseline: Portfolio, current: Portfolio, ledger: Ledger): string[] {
  validatePortfolio(current);
  requireSafe(current.account_ref === baseline.account_ref && utc(current.as_of) >= utc(baseline.as_of), 'observation_identity_mismatch');
  const issues = new Set<string>();
  const expected = new Map<string, { shares: ReturnType<typeof D>; role: Position['role'] }>();
  for (const p of baseline.positions) expected.set(p.instrument_id, { shares: D(p.shares), role: p.role });
  const add = (id: string, shares: ReturnType<typeof D>, role: Position['role']) => {
    const old = expected.get(id);
    if (old && old.role !== role) issues.add('ownership_conflict');
    expected.set(id, { shares: (old?.shares ?? ZERO).add(shares), role: old?.role ?? role });
  };
  for (const [key, e] of Object.entries(ledger.effective)) {
    if ((e.kind === 'execution' || e.kind === 'cash_flow') && e.revision > 1
      && (!ledger.receipts[`${key}:1`] || utc(ledger.earliest[key]!) <= utc(baseline.as_of))) issues.add('cutoff_reconstruction_required');
    if (utc(e.occurred_at) <= utc(baseline.as_of)) {
      // Baseline already includes older activity. Reversal/correction across cutoff needs reconstruction.
      if ((e.kind === 'execution' || e.kind === 'cash_flow') && (e.reversed || e.revision > 1)) issues.add('cutoff_reconstruction_required');
      continue;
    }
    if (utc(e.occurred_at) > utc(current.as_of)) { issues.add('observation_not_current'); continue; }
    if (e.kind === 'execution' && !e.reversed) {
      if (e.role === 'unknown') { issues.add('unknown_ownership'); continue; }
      add(e.instrument_id, e.side === 'buy' ? D(e.shares) : ZERO.sub(D(e.shares)), e.role);
    }
    if (e.kind === 'order') {
      if (e.status === 'open' || e.status === 'partial') issues.add('outstanding_orders');
      let filled = ZERO;
      for (const fill of Object.values(ledger.effective)) if (fill.kind === 'execution' && fill.order_id === e.order_id && !fill.reversed) filled = filled.add(D(fill.shares));
      if (filled.compare(D(e.filled_shares)) !== 0) issues.add('order_execution_mismatch');
    }
    if (e.kind === 'action') {
      if (e.status === 'unresolved' || e.passive_shares === null) issues.add('unresolved_action');
      else add(e.instrument_id, D(e.passive_shares), 'passive');
    }
  }
  for (const [id, position] of expected) {
    if (position.shares.compare(ZERO) < 0) issues.add('unowned_or_short_exposure');
    const actual = current.positions.find(p => p.instrument_id === id);
    if (position.shares.compare(D(actual?.shares ?? '0')) !== 0 || (actual && actual.role !== position.role)) issues.add('holdings_ledger_mismatch');
  }
  for (const p of current.positions) if (!expected.has(p.instrument_id)) issues.add('unexplained_position');
  // Balances/claims are authoritative broker-normalized observations, not execution-derived
  // spendable cash. Never assume settlement or count transaction/order mirrors twice.
  return [...issues].sort();
}
export function sameEconomicPositions(a: Portfolio, b: Portfolio): boolean {
  return canonicalJson(a.positions) === canonicalJson(b.positions);
}
