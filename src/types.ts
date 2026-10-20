export const SCHEMA = 'zeniba.strategy-proposal.v1' as const;
export interface Position {
  instrument_id: string; shares: string; role: 'primary' | 'passive'; blocked_reason: string | null;
}
export interface Claim { claim_ref: string; amount: string | null; direction: 'credit' | 'debit' }
export interface Portfolio {
  account_ref: string; as_of: string; observed_at: string; currency: 'USD';
  settled_cash: string; positions: Position[]; claims: Claim[]; open_orders: unknown[];
}
export interface ProposalRequest {
  schema: typeof SCHEMA; request_id: string; release_id: string; input_snapshot_id: string;
  requested_at: string; portfolio: Portfolio;
}
export interface Descriptor {
  schema: typeof SCHEMA; release_id: string; input_snapshot_id: string;
  decision_at: string; execution_at: string; valid_until: string;
  input_provenance: 'synthetic' | 'operator_supplied';
  instruments: { instrument_id: string; symbol: string }[];
}
export interface Intent {
  intent_id: string; instrument_id: string; symbol: string; side: 'buy' | 'sell';
  shares: string; action: 'entry' | 'exit' | 'resize'; reference_price: string | null;
  maximum_debit: string | null; currency: 'USD'; execution_at: string;
}
export interface Proposal {
  schema: typeof SCHEMA; request_id: string; release_id: string; input_snapshot_id: string;
  request_hash: string; account_state_hash: string; proposal_id: string; account_ref: string;
  decision_at: string; execution_at: string; valid_until: string;
  mode: 'shadow'; requires_human_review: true; broker_execution_enabled: false;
  input_provenance: 'synthetic' | 'operator_supplied'; portfolio_value: string | null;
  spendable_cash: string; status: 'proposed' | 'blocked'; orders: Intent[];
  blocks: { code: string; instrument_id: string | null; fatal: boolean }[]; warnings: string[];
}
export interface Health {
  schema: typeof SCHEMA; release_id: string; contract_sha256: string; mode: 'shadow'; status: 'ok';
}
export type Clock = () => number;
export type Transport = (request: Request) => Promise<Response>;
