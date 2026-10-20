import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import assert from 'node:assert/strict';
import { SafeError } from '../src/errors';
import { type Descriptor, type Proposal, type ProposalRequest } from '../src/types';
import { ProviderClient } from '../src/provider/client';
import { MOCK_TOKEN, mockTransport } from '../src/provider/mock';

export const NOW = Date.parse('2030-01-31T14:00:00Z');
export const requestFixture = (): ProposalRequest => JSON.parse(readFileSync(new URL('../contracts/examples/request.json', import.meta.url), 'utf8'));
export const proposalFixture = (): Proposal => JSON.parse(readFileSync(new URL('../contracts/examples/proposal.json', import.meta.url), 'utf8'));
export function descriptorFixture(): Descriptor {
  const p = proposalFixture(); return { schema: p.schema, release_id: p.release_id, input_snapshot_id: p.input_snapshot_id,
    decision_at: p.decision_at, execution_at: p.execution_at, valid_until: p.valid_until,
    input_provenance: 'synthetic', instruments: [{ instrument_id: 'TOY1', symbol: 'FAKE' }] };
}
export function mockClient(clock = () => NOW): ProviderClient {
  const d = descriptorFixture(); return new ProviderClient({ baseUrl: 'https://mock.invalid/', token: MOCK_TOKEN,
    releaseId: d.release_id, inputId: d.input_snapshot_id, clock, transport: mockTransport(d, clock) });
}
export function code(expected: string) {
  return (error: unknown): boolean => { assert.ok(error instanceof SafeError); assert.equal(error.code, expected); return true; };
}
