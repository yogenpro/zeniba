import type { AccountState } from '../domain/account';
import type { BrokerOrder, Execution, Observation } from '../domain/ledger';

/** Synthetic only. No HTTP, OAuth, broker credentials or submit/replace/cancel API exists. */
export function observeMock(state: AccountState, now: number): Observation {
  const time = new Date(now).toISOString();
  const current = structuredClone(state.cutoff);
  current.as_of = time; current.observed_at = time;
  const events: Observation['events'] = [];
  if (state.mock_scenario !== 'empty') {
    const occurred = new Date(Date.parse(state.descriptor.decision_at) + 5 * 60000).toISOString();
    const fill: Execution = { kind: 'execution', execution_id: 'toy-execution-1', revision: 1, order_id: 'toy-order-1',
      instrument_id: 'TOY1', side: 'buy', shares: '2', price: '50', fee: '0', role: 'primary', reversed: false, occurred_at: occurred };
    const order: BrokerOrder = { kind: 'order', order_id: 'toy-order-1', revision: state.mock_scenario === 'canceled' ? 2 : 1,
      instrument_id: 'TOY1', side: 'buy', shares: '7', filled_shares: '2',
      status: state.mock_scenario === 'canceled' ? 'canceled' : 'partial', occurred_at: occurred };
    // Two raw views of one fill deliberately normalize to the same ID. Ledger counts it once.
    events.push(fill, structuredClone(fill), order);
    current.positions = [{ instrument_id: 'TOY1', shares: '2', role: 'primary', blocked_reason: null }];
    current.claims = [{ claim_ref: 'toy-unsettled-debit', amount: '100', direction: 'debit' }];
    current.open_orders = state.mock_scenario === 'partial' ? [{ order_id: 'toy-order-1', remaining_shares: '5' }] : [];
  }
  return { evidence_id: `toy-observation-${time}`, observed_at: time, current, events, complete: true, issues: [],
    verified_cutoff: { ...structuredClone(state.cutoff), observed_at: time } };
}
