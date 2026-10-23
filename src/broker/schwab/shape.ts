/** Schema-shape diagnostics ONLY, after parsing with parseBrokerJson. No amounts, numeric
 * comparisons, dynamic broker keys, identifiers, nested contents or fund/settlement claims.
 * All numbers from that parser are exact lexeme strings; these labels describe notation only.
 */
export const BALANCE_SHAPE_FIELDS = Object.freeze([
  'cashBalance', 'cashAvailableForTrading', 'cashAvailableForWithdrawal', 'availableFunds',
  'buyingPower', 'marginBalance', 'pendingDeposits', 'cashReceipts', 'moneyMarketFund',
  'liquidationValue', 'equity', 'longMarketValue', 'shortMarketValue'
] as const);
type BalanceField = typeof BALANCE_SHAPE_FIELDS[number];
export type FieldShape = 'omitted' | 'null' | 'plain_decimal' | 'exponent_decimal' | 'other_text'
  | 'boolean' | 'object' | 'array' | 'other';
export interface BalanceShape {
  container: 'omitted' | 'null' | 'object' | 'array' | 'scalar';
  fields: Record<BalanceField, FieldShape> | null;
  unrecognized_field_count: number | null;
  amounts_disclosed: false; settled_cash_inferred: false;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function shape(value: unknown): FieldShape {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value !== 'string') return 'other';
  if (/^-?(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,30})?$/.test(value)) return 'plain_decimal';
  if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?[eE][+-]?[0-9]+$/.test(value)) return 'exponent_decimal';
  return 'other_text';
}
export function balanceShape(account: Record<string, unknown>): BalanceShape {
  const value = account.currentBalances;
  const result: BalanceShape = { container: !Object.hasOwn(account, 'currentBalances') ? 'omitted'
    : value === null ? 'null' : Array.isArray(value) ? 'array' : object(value) ? 'object' : 'scalar',
  fields: null, unrecognized_field_count: null, amounts_disclosed: false, settled_cash_inferred: false };
  if (result.container !== 'object' || !object(value)) return result;
  result.fields = Object.fromEntries(BALANCE_SHAPE_FIELDS.map(key => [key,
    Object.hasOwn(value, key) ? shape(value[key]) : 'omitted'])) as Record<BalanceField, FieldShape>;
  const known: readonly string[] = BALANCE_SHAPE_FIELDS;
  result.unrecognized_field_count = Object.keys(value).filter(key => !known.includes(key)).length;
  return result;
}
