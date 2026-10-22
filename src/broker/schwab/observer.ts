import { D, ZERO } from '../../decimal';
import { requireSafe } from '../../errors';
import { parseBrokerJson } from '../../json';
import type { Clock, Transport } from '../../types';
import { ACCOUNT_NUMBERS_URL, SCHWAB_ORIGIN, observeRequest, schwabText } from './transport';

export interface SchwabSelection {
  expected_account_number: string; expected_account_type: 'MARGIN' | 'CASH'; account_ref: string;
}
export interface EmptyProbe {
  schema: 'zeniba.schwab-probe.v1'; account_ref: string; observed_at: string;
  status: 'observed_empty' | 'blocked'; blocks: string[]; reported_balances: Record<string, string> | null;
  positions_reported: number | null; expected_account_type: 'MARGIN' | 'CASH';
  data_certified: false; account_state_certified: false;
  account_cutoff_verified: false; open_orders_verified: false; history_verified: false;
  settled_cash: null; buying_power_used_as_cash: false; broker_execution_enabled: false; provider_called: false;
}
export function validateSelection(selection: SchwabSelection): void {
  requireSafe(typeof selection.expected_account_number === 'string' && /^[0-9]{6,20}$/.test(selection.expected_account_number)
    && ['MARGIN', 'CASH'].includes(selection.expected_account_type) && typeof selection.account_ref === 'string'
    && /^[A-Za-z][A-Za-z0-9_-]{15,80}$/.test(selection.account_ref), 'invalid_schwab_selection', 503);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Deliberately NOT a Portfolio/Observation adapter. Only two account-data GET routes exist.
 * One-account consent is checked EVERY probe; no get-all-accounts/positions or order writes.
 */
export class SchwabObserver {
  private readonly selection: Readonly<SchwabSelection>;
  constructor(selection: SchwabSelection, private readonly transport: Transport, private readonly clock: Clock,
    private readonly timeoutMs = 5000) { validateSelection(selection); this.selection = Object.freeze({ ...selection }); }

  async probe(accessToken: string): Promise<{ report: EmptyProbe; raw_empty_account: string | null }> {
    const mappingText = await schwabText(observeRequest(ACCOUNT_NUMBERS_URL, accessToken), 'observe', this.transport, this.timeoutMs);
    const mappings = parseBrokerJson(mappingText);
    requireSafe(Array.isArray(mappings) && mappings.length === 1 && object(mappings[0])
      && mappings[0].accountNumber === this.selection.expected_account_number, 'schwab_single_account_consent_required', 409);
    const accountHash = mappings[0].hashValue;
    requireSafe(typeof accountHash === 'string' && /^[A-Za-z0-9_-]{8,256}$/.test(accountHash)
      && accountHash !== 'accountNumbers', 'invalid_schwab_account_mapping', 502);
    const raw = await schwabText(observeRequest(`${SCHWAB_ORIGIN}/trader/v1/accounts/${accountHash}?fields=positions`, accessToken),
      'observe', this.transport, this.timeoutMs);
    const parsed = parseBrokerJson(raw), now = this.clock();
    requireSafe(Number.isSafeInteger(now), 'invalid_schwab_clock', 503);
    const report: EmptyProbe = { schema: 'zeniba.schwab-probe.v1', account_ref: this.selection.account_ref,
      observed_at: new Date(now).toISOString(), status: 'blocked', blocks: [], reported_balances: null, positions_reported: null,
      expected_account_type: this.selection.expected_account_type, data_certified: false, account_state_certified: false,
      account_cutoff_verified: false,
      open_orders_verified: false, history_verified: false, settled_cash: null, buying_power_used_as_cash: false,
      broker_execution_enabled: false, provider_called: false };
    const blocked = (code: string) => { report.blocks.push(code); return { report, raw_empty_account: null }; };
    requireSafe(object(parsed) && object(parsed.securitiesAccount), 'invalid_schwab_account_response', 502);
    const account = parsed.securitiesAccount;
    requireSafe(account.accountNumber === this.selection.expected_account_number, 'schwab_account_identity_mismatch', 409);
    if (account.type !== this.selection.expected_account_type) return blocked('schwab_account_type_mismatch');
    // An omitted positions field is UNKNOWN, not automatically an empty account.
    if (!Array.isArray(account.positions)) return blocked('schwab_positions_not_explicit');
    report.positions_reported = account.positions.length;
    if (account.positions.length !== 0) return blocked('schwab_nonempty_account');
    if ('orderStrategies' in account && (!Array.isArray(account.orderStrategies) || account.orderStrategies.length !== 0))
      return blocked('schwab_order_data_present');
    if ('isClosingOnlyRestricted' in account && account.isClosingOnlyRestricted !== false) return blocked('schwab_account_restricted');
    const balances = account.currentBalances;
    // These are observed balance fields, not a claim about Schwab settlement semantics.
    if (!object(balances) || !['cashBalance', 'liquidationValue', 'equity', 'longMarketValue', 'shortMarketValue']
      .every(k => Object.hasOwn(balances, k))) return blocked('schwab_balance_fields_missing');
    const exact: Record<string, string> = Object.create(null);
    for (const [key, value] of Object.entries(balances)) {
      if (!/^[A-Za-z][A-Za-z0-9]{0,100}$/.test(key) || typeof value !== 'string'
        || !/^-?(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,30})?$/.test(value)) return blocked('schwab_balance_format_unsupported');
      if (D(value).compare(ZERO) !== 0) return blocked('schwab_nonzero_reported_balance');
      exact[key] = value;
    }
    report.reported_balances = exact; report.status = 'observed_empty';
    // Raw evidence may be saved privately ONLY for the matched account with explicit all-zero
    // observations. Unexpected holdings/balances are not returned to a generic caller/archive.
    return { report, raw_empty_account: raw };
  }
}
