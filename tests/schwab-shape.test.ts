import test from 'node:test';
import assert from 'node:assert/strict';
import { balanceShape, BALANCE_SHAPE_FIELDS } from '../src/broker/schwab/shape';
import { parseBrokerJson } from '../src/json';

const parsed = (text: string) => parseBrokerJson(text) as Record<string, unknown>;
test('omitted balance container stays omitted and never becomes zero/empty fields', () => {
  assert.deepEqual(balanceShape({}), { container: 'omitted', fields: null, unrecognized_field_count: null,
    amounts_disclosed: false, settled_cash_inferred: false });
});
test('null array and scalar balance containers remain distinct without nested content inspection', () => {
  for (const [value, container] of [[null, 'null'], [['toy-secret'], 'array'], ['toy-secret', 'scalar'], [false, 'scalar']] as const) {
    const result = balanceShape({ currentBalances: value });
    assert.equal(result.container, container); assert.equal(result.fields, null);
    assert.equal(JSON.stringify(result).includes('toy-secret'), false);
  }
});
test('fixed balance names report notation only and never echo amount magnitude sign or zero', () => {
  const outputs = ['0', '123456789.123456789', '-2.50', '999999999999999999999999999999.999999999999999999999999999999']
    .map(amount => balanceShape(parsed(`{"currentBalances":{"buyingPower":${amount}}}`)));
  for (const result of outputs) {
    assert.equal(result.fields!.buyingPower, 'plain_decimal'); assert.equal(result.fields!.cashBalance, 'omitted');
    assert.equal(result.amounts_disclosed, false); assert.equal(result.settled_cash_inferred, false);
  }
  for (const result of outputs.slice(1)) assert.deepEqual(result, outputs[0]);
});
test('diagnostic vocabulary distinguishes notation/null/text/nested types without changing numeric parser policy', () => {
  const result = balanceShape(parsed('{"currentBalances":{"cashBalance":1e-10,"marginBalance":null,"equity":"toy-secret","cashReceipts":false,"availableFunds":{},"pendingDeposits":[]}}'));
  assert.equal(result.fields!.cashBalance, 'exponent_decimal'); assert.equal(result.fields!.marginBalance, 'null');
  assert.equal(result.fields!.equity, 'other_text'); assert.equal(result.fields!.cashReceipts, 'boolean');
  assert.equal(result.fields!.availableFunds, 'object'); assert.equal(result.fields!.pendingDeposits, 'array');
  assert.equal(JSON.stringify(result).includes('toy-secret'), false); assert.equal(JSON.stringify(result).includes('1e-10'), false);
});
test('unknown broker keys and values are never reflected, only their count', () => {
  const result = balanceShape(parsed('{"currentBalances":{"toy-sensitive-account-key":"toy-sensitive-value","__proto__":{"token":"toy-sensitive-token"},"cashBalance":0}}'));
  assert.equal(result.unrecognized_field_count, 2); assert.deepEqual(Object.keys(result.fields!), [...BALANCE_SHAPE_FIELDS]);
  const output = JSON.stringify(result); assert.equal(output.includes('sensitive'), false); assert.equal(output.includes('__proto__'), false);
});
test('inherited financial properties never appear as returned data or a balance container', () => {
  assert.equal(balanceShape(Object.create({ currentBalances: { buyingPower: '123.45' } })).container, 'omitted');
  const value = Object.assign(Object.create({ buyingPower: '123.45' }), { cashBalance: '0' });
  const result = balanceShape({ currentBalances: value });
  assert.equal(result.fields!.buyingPower, 'omitted'); assert.equal(result.fields!.cashBalance, 'plain_decimal');
});
