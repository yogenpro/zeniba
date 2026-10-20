import { accountHash, economicIdentity, ID, portfolioBlocks, utc, validatePortfolio, validateRequestWindow } from '../contract';
import { requireSafe } from '../errors';
import { canonicalJson, hashObject, parseJson } from '../json';
import { SCHEMA, type Descriptor, type Portfolio, type Proposal, type ProposalRequest } from '../types';
import { emptyLedger, ingestEvents, reconcile, type Ledger, type Observation } from './ledger';

export type WorkflowAction = 'seen' | 'skip' | 'placed' | 'sync';
export interface SavedRequest {
  body: string; hash: string; account_revision: number; proposal: Proposal | null;
  response_raw: string | null; workflow: 'unseen' | 'seen' | 'skipped' | 'reported';
}
export interface WorkflowEvent {
  event_id: string; proposal_id: string; action: WorkflowAction; received_at: string;
  late: boolean; stale: boolean;
}
export interface AccountState {
  version: 1; descriptor: Descriptor; cutoff: Portfolio; current: Portfolio;
  cutoff_verified_at: string; observed_at: string; revision: number;
  complete: boolean; issues: string[]; ledger: Ledger;
  requests: Record<string, SavedRequest>; latest_request_id: string | null;
  workflow_events: WorkflowEvent[]; event_receipts: Record<string, string>;
  evidence_keys: string[]; mock_scenario: 'empty' | 'partial' | 'canceled';
}
export function newAccount(descriptor: Descriptor, snapshot: Portfolio): AccountState {
  validatePortfolio(snapshot);
  requireSafe(snapshot.as_of === descriptor.decision_at, 'cutoff_state_required');
  return { version: 1, descriptor: structuredClone(descriptor), cutoff: structuredClone(snapshot),
    current: structuredClone(snapshot), cutoff_verified_at: snapshot.observed_at, observed_at: snapshot.observed_at,
    revision: 1, complete: true, issues: [], ledger: emptyLedger(), requests: {}, latest_request_id: null,
    workflow_events: [], event_receipts: {}, evidence_keys: [], mock_scenario: 'empty' };
}
export function readiness(state: AccountState, now: number): string[] {
  const issues = new Set(state.issues);
  if (!state.complete) issues.add('incomplete_observation');
  if (now >= utc(state.descriptor.valid_until)) issues.add('proposal_expired');
  if (utc(state.observed_at) < now - 15 * 60000 || utc(state.observed_at) > now + 30000
    || utc(state.cutoff_verified_at) < now - 15 * 60000 || utc(state.cutoff_verified_at) > now + 30000) issues.add('stale_account');
  if (canonicalJson(economicIdentity(state.cutoff)) !== canonicalJson(economicIdentity(state.current))) issues.add('account_changed_since_cutoff');
  for (const issue of [...portfolioBlocks(state.cutoff), ...portfolioBlocks(state.current)]) issues.add(issue);
  return [...issues].sort();
}
export async function bindRequest(state: AccountState, requestId: string, now: number, exactBody?: string): Promise<SavedRequest> {
  requireSafe(ID.test(requestId), 'invalid_request_id', 400);
  const saved = Object.hasOwn(state.requests, requestId) ? state.requests[requestId] : undefined;
  if (saved) {
    if (exactBody !== undefined) requireSafe(await hashObject(parseJson(exactBody)) === saved.hash && exactBody === saved.body, 'request_id_conflict');
    return saved;
  }
  requireSafe(readiness(state, now).length === 0, readiness(state, now)[0] ?? 'account_not_ready');
  requireSafe(Object.keys(state.requests).length < 1000, 'proposal_capacity_requires_archive');
  const request: ProposalRequest = { schema: SCHEMA, request_id: requestId, release_id: state.descriptor.release_id,
    input_snapshot_id: state.descriptor.input_snapshot_id, requested_at: new Date(now).toISOString(),
    portfolio: { ...structuredClone(state.cutoff), observed_at: state.cutoff_verified_at } };
  validateRequestWindow(request, state.descriptor, now);
  const body = canonicalJson(request);
  if (exactBody !== undefined) requireSafe(exactBody === body, 'request_id_conflict');
  const result: SavedRequest = { body, hash: await hashObject(request), account_revision: state.revision,
    proposal: null, response_raw: null, workflow: 'unseen' };
  state.requests[requestId] = result;
  return result;
}
export async function saveProposal(state: AccountState, requestId: string, proposal: Proposal, raw: string): Promise<void> {
  const saved = Object.hasOwn(state.requests, requestId) ? state.requests[requestId] : undefined;
  requireSafe(saved, 'unknown_request');
  requireSafe(proposal.request_id === requestId && proposal.release_id === state.descriptor.release_id
    && proposal.input_snapshot_id === state.descriptor.input_snapshot_id && proposal.account_ref === state.cutoff.account_ref
    && proposal.request_hash === saved.hash && proposal.account_state_hash === await accountHash(state.cutoff), 'proposal_binding_mismatch');
  requireSafe(saved.account_revision === state.revision, 'account_changed');
  if (saved.proposal) {
    requireSafe(canonicalJson(saved.proposal) === canonicalJson(proposal) && saved.response_raw === raw, 'immutable_proposal_conflict'); return;
  }
  saved.proposal = structuredClone(proposal); saved.response_raw = raw;
  state.latest_request_id = requestId;
}
export function latest(state: AccountState): SavedRequest | null {
  return state.latest_request_id ? state.requests[state.latest_request_id] ?? null : null;
}
export function proposalStatus(state: AccountState, request: SavedRequest, now: number): string {
  if (!request.proposal) return 'pending';
  if (now >= utc(request.proposal.valid_until)) return 'expired';
  if (state.latest_request_id !== request.proposal.request_id) return 'superseded';
  if (request.account_revision !== state.revision || readiness(state, now).length) return 'stale';
  if (request.proposal.status === 'blocked') return 'blocked';
  return request.workflow;
}
export async function applyWorkflow(state: AccountState, event: Omit<WorkflowEvent, 'late' | 'stale'>, now: number): Promise<boolean> {
  requireSafe(ID.test(event.event_id), 'invalid_event_id', 400);
  requireSafe(['seen', 'skip', 'placed', 'sync'].includes(event.action), 'invalid_action', 400);
  // The idempotency identity excludes local receipt time so at-least-once delivery is stable.
  const hash = await hashObject({ event_id: event.event_id, proposal_id: event.proposal_id, action: event.action });
  const previous = Object.hasOwn(state.event_receipts, event.event_id) ? state.event_receipts[event.event_id] : undefined;
  if (previous) { requireSafe(previous === hash, 'workflow_event_conflict'); return false; }
  const saved = Object.values(state.requests).find(r => r.proposal?.proposal_id === event.proposal_id);
  requireSafe(saved?.proposal, 'unknown_proposal');
  requireSafe(state.latest_request_id === saved.proposal.request_id, 'superseded_proposal');
  requireSafe(saved.workflow !== 'skipped' || event.action === 'sync' || event.action === 'skip', 'proposal_skipped');
  requireSafe(state.workflow_events.length < 10000, 'workflow_capacity_requires_archive');
  const late = now >= utc(saved.proposal.valid_until);
  const stale = saved.account_revision !== state.revision || readiness(state, now).length > 0;
  state.event_receipts[event.event_id] = hash;
  state.workflow_events.push({ ...event, late, stale });
  if (event.action === 'skip') saved.workflow = 'skipped';
  if (event.action === 'seen' && saved.workflow === 'unseen') saved.workflow = 'seen';
  if (event.action === 'placed') saved.workflow = 'reported';
  // Even late 'placed' reports are audit-only; caller schedules observation. No fills here.
  return true;
}
export async function applyObservation(state: AccountState, observation: Observation, now: number): Promise<void> {
  requireSafe(utc(observation.observed_at) <= now + 30000 && utc(observation.observed_at) >= utc(state.observed_at), 'reordered_observation');
  const previous = canonicalJson(economicIdentity(state.current));
  const previousIssues = canonicalJson(state.issues);
  const previousComplete = state.complete;
  const ledgerChanged = await ingestEvents(state.ledger, observation.events);
  if (observation.current) {
    validatePortfolio(observation.current);
    requireSafe(observation.current.observed_at === observation.observed_at, 'observation_time_mismatch');
    requireSafe(utc(observation.current.as_of) >= utc(state.current.as_of)
      && utc(observation.current.as_of) <= utc(observation.observed_at), 'reordered_observation');
    state.issues = [...new Set([...observation.issues, ...reconcile(state.cutoff, observation.current, state.ledger)])].sort();
    state.current = structuredClone(observation.current);
  } else state.issues = [...new Set([...observation.issues, 'normalization_unresolved'])].sort();
  state.complete = observation.complete && observation.current !== null;
  state.observed_at = observation.observed_at;
  if (observation.verified_cutoff !== null) {
    validatePortfolio(observation.verified_cutoff);
    requireSafe(await accountHash(observation.verified_cutoff) === await accountHash(state.cutoff)
      && observation.verified_cutoff.observed_at === observation.observed_at, 'cutoff_reconstruction_conflict');
    state.cutoff_verified_at = observation.observed_at;
  }
  if (ledgerChanged || previous !== canonicalJson(economicIdentity(state.current))
    || previousIssues !== canonicalJson(state.issues) || previousComplete !== state.complete) state.revision++;
}
