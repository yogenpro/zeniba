import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { requireSafe, safeFailure } from '../src/errors';
import { SchwabOAuth } from '../src/broker/schwab/oauth';
import { SchwabObserver, type EmptyProbe } from '../src/broker/schwab/observer';
import { validateSchwabRequest, TOKEN_URL, ACCOUNT_NUMBERS_URL } from '../src/broker/schwab/transport';
import type { Clock, Transport } from '../src/types';
import { SchwabStore, validateProbeConfig, validateStoredToken, type ProbeConfig } from './schwab-store';

export interface OperatorIO {
  hidden(prompt: string): Promise<string>; notice(text: string): void;
  authorizationFile?(filename: string): void;
}
export type ControllerCommand = 'setup' | 'status' | 'login' | 'probe';
export function controllerArguments(args: string[]): { command: ControllerCommand; directory: string; live: boolean } {
  const [command, directory, flag] = args;
  requireSafe(['setup', 'status', 'login', 'probe'].includes(command ?? '') && typeof directory === 'string'
    && (args.length === 2 || (args.length === 3 && flag === '--live')), 'invalid_schwab_controller_command', 400);
  const live = flag === '--live';
  requireSafe((command === 'login' || command === 'probe') === live, 'explicit_schwab_live_opt_in_required', 409);
  return { command: command as ControllerCommand, directory, live };
}
function escape(text: string): string {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
function summary(report: EmptyProbe, tokenCached: boolean): string {
  return JSON.stringify({ status: report.status, blocks: report.blocks, connection_status: report.connection_status,
    positions_state: report.positions_state, positions_reported: report.positions_reported, token_cached: tokenCached,
    data_certified: false, open_orders_verified: false, settled_cash_normalized: false, broker_execution_enabled: false });
}
/** Separate connection admission from financial/data validity. The owner explicitly permits
 * retention for an OMITTED positions field only; null/malformed, known nonempty, other blocks
 * and wrong scope/type remain failures. Missing positions NEVER become empty/zero.
 */
function retainableConnection(report: EmptyProbe): boolean {
  return report.connection_status === 'verified_single_account' && (report.status === 'observed_empty'
    || (report.status === 'blocked' && report.positions_state === 'omitted' && report.positions_reported === null
      && report.blocks.length === 1 && report.blocks[0] === 'schwab_positions_not_explicit'));
}

/** Only this explicit operator boundary gets a real transport. The Worker never imports it. */
export async function runController(command: ControllerCommand, store: SchwabStore, io: OperatorIO,
  transport: Transport, clock: Clock): Promise<void> {
  await store.exclusive(async () => {
    if (command === 'setup') {
      requireSafe(!store.exists('config.json') && !store.exists('token.json'), 'schwab_configuration_already_exists');
      io.notice('Offline setup only. Never share secrets, OAuth callbacks or account identifiers in chat.');
      const client_id = await io.hidden('Approved app key (hidden): ');
      const client_secret = await io.hidden('Approved app secret (hidden): ');
      const redirect_uri = await io.hidden('EXACT registered HTTPS callback (hidden): ');
      const expected_account_number = await io.hidden('ONE expected empty account number (hidden): ');
      const expected_account_type = await io.hidden('Expected account type: MARGIN or CASH (hidden): ');
      requireSafe(await io.hidden('After checking the approved app docs/consent, type OBSERVE_ONE_EMPTY_ACCOUNT (hidden): ')
        === 'OBSERVE_ONE_EMPTY_ACCOUNT', 'schwab_operator_acknowledgement_required');
      const config: ProbeConfig = validateProbeConfig({ schema: 'zeniba.schwab-controller.v1',
        binding_id: randomBytes(32).toString('hex'), client_id, client_secret, redirect_uri,
        expected_account_number, expected_account_type, account_ref: 'probe_' + randomBytes(16).toString('hex'),
        approved_app_docs_reviewed: true, one_empty_account_only: true });
      store.create('config.json', config);
      io.notice('Protected configuration created (0600). No network request made.'); return;
    }
    const config = validateProbeConfig(store.read('config.json'));
    if (command === 'status') {
      if (!store.exists('token.json')) { io.notice('Configured; no authorized token. No network request made.'); return; }
      const stored = validateStoredToken(store.read('token.json'), config, clock());
      io.notice(JSON.stringify({ configured: true, token_present: true, access_token_expired: stored.token.expires_at <= clock(),
        refresh_reauthorization_required: store.exists('refresh-pending.json'),
        broker_execution_enabled: false, network_requests_made: 0 })); return;
    }
    const counts = { oauth_token_posts: 0, mapping_gets: 0, selected_account_gets: 0, broker_writes: 0 };
    const operation = store.evidence('operation', { schema: 'zeniba.schwab-operation.v1', command,
      started_at: new Date(clock()).toISOString(), status: 'started', counts });
    const guarded: Transport = async request => {
      const kind = request.url === TOKEN_URL ? 'oauth' : 'observe';
      validateSchwabRequest(request, kind);
      if (kind === 'oauth') counts.oauth_token_posts++;
      else if (request.url === ACCOUNT_NUMBERS_URL) counts.mapping_gets++;
      else counts.selected_account_gets++;
      // Receipt precedes every dispatch. A partial/crashed run cannot masquerade as zero calls.
      store.replace(operation, { schema: 'zeniba.schwab-operation.v1', command, status: 'dispatching', counts: { ...counts } });
      return transport(request);
    };
    const oauth = new SchwabOAuth(config, guarded, clock);
    const observer = new SchwabObserver(config, guarded, clock);
    let outcome: 'observed_empty' | 'connected_data_blocked' | null = null;
    try {
      if (command === 'login') {
        const challenge = oauth.begin();
        // Protected HTML contains only public OAuth client ID/state, NEVER app secret/tokens.
        // No authorization URL/client/account ID appears in stdout, a command argument or log.
        store.authorization('<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer">'
          + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; base-uri \'none\'; form-action \'none\'">'
          + '<title>Schwab observation-only authorization</title><h1>Authorize ONE empty test account only</h1>'
          + '<p>No orders, transfers or funding. Copy the completed callback into the hidden controller prompt, not chat.</p>'
          + '<a rel="noopener noreferrer" target="_blank" href="' + escape(challenge.authorization_url) + '">Continue at Schwab</a>');
        let token;
        try {
          const filename = join(store.directory, 'authorization.html');
          if (io.authorizationFile) io.authorizationFile(filename);
          else io.notice(`Open the protected local file ${filename} privately in your browser.`);
          io.notice('Select ONLY the intended empty account at Schwab. A different or additional account blocks the probe.');
          const callback = await io.hidden('Completed callback URL (hidden, single use, expires after ten minutes): ');
          token = await oauth.exchange(callback);
        } finally { store.removeAuthorization(); }
        const result = await observer.probe(token.access_token);
        store.evidence('probe', result);
        if (!retainableConnection(result.report)) {
          io.notice(summary(result.report, false));
          requireSafe(false, 'schwab_initial_observation_blocked');
        }
        const stored = { binding_id: config.binding_id, token };
        if (store.exists('token.json')) { validateStoredToken(store.read('token.json'), config, clock()); store.replace('token.json', stored); }
        else store.create('token.json', stored);
        if (store.exists('refresh-pending.json')) {
          const barrier = store.read('refresh-pending.json') as { binding_id?: unknown } | null;
          requireSafe(barrier && barrier.binding_id === config.binding_id, 'schwab_refresh_barrier_binding_mismatch');
          store.clearRefreshBarrier(); // Explicit fresh OAuth is recovery from ambiguous rotation.
        }
        outcome = result.report.status === 'observed_empty' ? 'observed_empty' : 'connected_data_blocked';
        io.notice(summary(result.report, true));
        io.notice(outcome === 'observed_empty'
          ? 'OAuth and single-account current observations succeeded; protected token/evidence saved.'
          : 'Single-account connection saved. Portfolio data remains BLOCKED: positions unknown, balances not validated. No proposal or trade.');
      } else {
        requireSafe(!store.exists('refresh-pending.json'), 'schwab_refresh_reauthorization_required');
        const stored = validateStoredToken(store.read('token.json'), config, clock());
        if (stored.token.expires_at <= clock() + 30000) {
          // A crash/network ambiguity or failed token persistence must never silently retry
          // a possibly consumed refresh token. Only explicit fresh login clears this barrier.
          store.create('refresh-pending.json', { binding_id: config.binding_id, started_at: clock() });
          stored.token = await oauth.refresh(stored.token);
          store.replace('token.json', stored); // Rotation persisted atomically before the next read.
          store.clearRefreshBarrier();
        }
        const result = await observer.probe(stored.token.access_token);
        store.evidence('probe', result); io.notice(summary(result.report, true));
        requireSafe(retainableConnection(result.report), 'schwab_current_observation_blocked');
        outcome = result.report.status === 'observed_empty' ? 'observed_empty' : 'connected_data_blocked';
      }
      store.replace(operation, { schema: 'zeniba.schwab-operation.v1', command, status: 'complete', outcome, counts });
    } catch (error) {
      store.replace(operation, { schema: 'zeniba.schwab-operation.v1', command, status: 'failed',
        error: safeFailure(error).code, counts });
      throw error;
    }
  });
}
