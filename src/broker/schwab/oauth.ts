import { requireSafe, SafeError } from '../../errors';
import { equalSecret } from '../../http';
import { parseJson } from '../../json';
import type { Clock, Transport } from '../../types';
import { AUTHORIZE_URL, TOKEN_URL, schwabText } from './transport';

export interface SchwabApp { client_id: string; client_secret: string; redirect_uri: string }
export interface SchwabToken {
  access_token: string; refresh_token: string; token_type: 'Bearer'; issued_at: number; expires_at: number;
}
export function validateApp(app: SchwabApp): void {
  requireSafe(typeof app.client_id === 'string' && /^[\x21-\x39\x3b-\x7e]{8,256}$/.test(app.client_id)
    && typeof app.client_secret === 'string' && /^[\x21-\x7e]{8,512}$/.test(app.client_secret), 'invalid_schwab_app', 503);
  requireSafe(typeof app.redirect_uri === 'string' && app.redirect_uri.length <= 2048, 'invalid_schwab_callback', 503);
  let url: URL;
  try { url = new URL(app.redirect_uri); } catch { throw new SafeError('invalid_schwab_callback', 503); }
  requireSafe(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
    && !/[\s\\]/.test(app.redirect_uri), 'invalid_schwab_callback', 503);
}
export function validateToken(token: SchwabToken, now: number): void {
  requireSafe(token && token.token_type === 'Bearer' && typeof token.access_token === 'string'
    && /^[\x21-\x7e]{8,16384}$/.test(token.access_token) && typeof token.refresh_token === 'string'
    && /^[\x21-\x7e]{8,16384}$/.test(token.refresh_token) && Number.isSafeInteger(now)
    && Number.isSafeInteger(token.issued_at) && Number.isSafeInteger(token.expires_at)
    && token.expires_at > token.issued_at && token.expires_at - token.issued_at <= 86400000
    && token.issued_at <= now + 30000, 'invalid_schwab_token', 503);
}

/** Confidential-client OAuth. One active in-memory, single-use challenge per operator login.
 * Authorization code is supplied only through the protected controller prompt, never an app API.
 * No assumption of a broker-enforced read-only scope or fixed refresh-token lifetime.
 */
export class SchwabOAuth {
  private readonly app: Readonly<SchwabApp>;
  private challenge: { state: string; created: number; expires: number } | null = null;
  constructor(app: SchwabApp, private readonly transport: Transport, private readonly clock: Clock,
    private readonly timeoutMs = 5000) { validateApp(app); this.app = Object.freeze({ ...app }); }
  begin(): { authorization_url: string; expires_at: number } {
    const now = this.clock(); requireSafe(Number.isSafeInteger(now), 'invalid_schwab_clock', 503);
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const state = Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
    this.challenge = { state, created: now, expires: now + 600000 };
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({ response_type: 'code', client_id: this.app.client_id,
      redirect_uri: this.app.redirect_uri, state }).toString();
    return { authorization_url: url.href, expires_at: this.challenge.expires };
  }
  async exchange(completedCallback: string): Promise<SchwabToken> {
    // Consume even failed callbacks: retry requires a fresh challenge, not code/state replay.
    const pending = this.challenge; this.challenge = null;
    const now = this.clock();
    requireSafe(pending && now >= pending.created && now < pending.expires, 'schwab_oauth_state_unavailable', 409);
    requireSafe(typeof completedCallback === 'string' && completedCallback.length <= 16384
      && !/[\s\\]/.test(completedCallback), 'invalid_schwab_oauth_callback', 400);
    let completed: URL;
    try { completed = new URL(completedCallback); } catch { throw new SafeError('invalid_schwab_oauth_callback', 400); }
    const expected = new URL(this.app.redirect_uri);
    requireSafe(completed.origin === expected.origin && completed.pathname === expected.pathname
      && !completed.username && !completed.password && !completed.hash, 'invalid_schwab_oauth_callback', 400);
    const params = completed.searchParams;
    requireSafe([...params.keys()].every(k => ['code', 'state', 'error', 'error_description'].includes(k))
      && [...new Set(params.keys())].every(k => params.getAll(k).length === 1), 'invalid_schwab_oauth_callback', 400);
    requireSafe(params.has('state') && await equalSecret(params.get('state')!, pending.state), 'schwab_oauth_state_mismatch', 409);
    requireSafe(!params.has('error') && !params.has('error_description'), 'schwab_oauth_denied', 409);
    const code = params.get('code');
    requireSafe(code && /^[\x21-\x7e]{1,8192}$/.test(code), 'invalid_schwab_oauth_code', 400);
    return this.token(new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.app.redirect_uri }));
  }
  async refresh(previous: SchwabToken): Promise<SchwabToken> {
    validateToken(previous, this.clock());
    return this.token(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: previous.refresh_token }), previous.refresh_token);
  }
  private async token(body: URLSearchParams, previousRefresh?: string): Promise<SchwabToken> {
    const authorization = btoa(`${this.app.client_id}:${this.app.client_secret}`);
    const request = new Request(TOKEN_URL, { method: 'POST', redirect: 'manual', credentials: 'omit',
      headers: { Authorization: `Basic ${authorization}`, Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-store' }, body: body.toString() } as RequestInit & { credentials: 'omit' });
    const text = await schwabText(request, 'oauth', this.transport, this.timeoutMs);
    const parsed = parseJson(text);
    requireSafe(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'invalid_schwab_token_response', 502);
    const r = parsed as Record<string, unknown>, now = this.clock();
    requireSafe(typeof r.token_type === 'string' && r.token_type.toLowerCase() === 'bearer'
      && Number.isSafeInteger(r.expires_in) && (r.expires_in as number) >= 1 && (r.expires_in as number) <= 86400,
    'invalid_schwab_token_response', 502);
    const result: SchwabToken = { access_token: r.access_token as string,
      refresh_token: (r.refresh_token ?? previousRefresh) as string, token_type: 'Bearer',
      issued_at: now, expires_at: now + (r.expires_in as number) * 1000 };
    validateToken(result, now); return result;
  }
}
