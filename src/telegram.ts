import { requireSafe } from './errors';
import type { AccountState, WorkflowAction } from './domain/account';
import { latest, proposalStatus } from './domain/account';
import type { Proposal } from './types';

const actions: WorkflowAction[] = ['seen', 'skip', 'placed', 'sync'];
// Telegram callback_data is at most 64 bytes; a full 64-char hash plus action would exceed it.
export function callbackData(action: WorkflowAction, proposal: Proposal): string { return `${action}:${proposal.proposal_id.slice(0, 32)}`; }
export function resolveCallback(state: AccountState, data: string): { proposal_id: string; action: WorkflowAction } {
  const match = /^(seen|skip|placed|sync):([0-9a-f]{32})$/.exec(data);
  requireSafe(match, 'invalid_callback', 400);
  const matches = Object.values(state.requests).map(r => r.proposal).filter(p => p?.proposal_id.startsWith(match[2]!));
  requireSafe(matches.length === 1 && matches[0], 'unknown_callback', 409);
  return { proposal_id: matches[0].proposal_id, action: match[1] as WorkflowAction };
}
export function notification(state: AccountState, now: number): unknown {
  const saved = latest(state);
  if (!saved?.proposal) return { text: 'No saved shadow proposal. No action required.', reply_markup: { inline_keyboard: [] } };
  const status = proposalStatus(state, saved, now);
  const labels = { seen: 'Seen', skip: 'Skip', placed: 'I placed orders', sync: 'Sync' };
  const available = ['unseen', 'seen', 'reported'].includes(status) ? actions : ['sync'] as WorkflowAction[];
  return { text: `Synthetic shadow proposal: ${status}. Not trade authorization. Check the private view. Buttons never record fills.`,
    reply_markup: { inline_keyboard: available.map(action => [{ text: labels[action], callback_data: callbackData(action, saved.proposal!) }]) } };
}
/** Strict numeric Telegram identities. No usernames, forwarded chat IDs or free text. */
export function parseTelegram(value: unknown, userId: string, chatId: string): { event_id: string; callback_data: string } {
  requireSafe(/^[1-9]\d*$/.test(userId) && /^-?[1-9]\d*$/.test(chatId), 'telegram_not_configured', 503);
  const v = value as { update_id?: unknown; callback_query?: {
    data?: unknown; from?: { id?: unknown; is_bot?: unknown }; message?: { chat?: { id?: unknown } };
  } } | null;
  const q = v?.callback_query;
  const uid = q?.from?.id, cid = q?.message?.chat?.id;
  requireSafe(typeof uid === 'number' && Number.isSafeInteger(uid) && String(uid) === userId
    && typeof cid === 'number' && Number.isSafeInteger(cid) && String(cid) === chatId && q?.from?.is_bot === false, 'telegram_forbidden', 403);
  requireSafe(typeof v?.update_id === 'number' && Number.isSafeInteger(v.update_id) && v.update_id >= 0
    && typeof q?.data === 'string' && q.data.length <= 64, 'invalid_telegram_update', 400);
  return { event_id: `telegram:${v.update_id}`, callback_data: q.data };
}
