import { requireSafe, SafeError } from '../../errors';
import { parseJson, readBody } from '../../json';
import type { Transport } from '../../types';

export const SCHWAB_ORIGIN = 'https://api.schwabapi.com';
export const TOKEN_URL = `${SCHWAB_ORIGIN}/v1/oauth/token`;
export const AUTHORIZE_URL = `${SCHWAB_ORIGIN}/v1/oauth/authorize`;
export const ACCOUNT_NUMBERS_URL = `${SCHWAB_ORIGIN}/trader/v1/accounts/accountNumbers`;
const details = /^\/trader\/v1\/accounts\/[A-Za-z0-9_-]{8,256}$/;

const stages = ['oauth_token', 'oauth_exchange', 'oauth_refresh', 'account_mapping', 'account_details'] as const;
const reasons = ['invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_request',
  'unsupported_grant_type', 'invalid_scope', 'access_denied', 'temporarily_unavailable', 'server_error'] as const;
export type SchwabHTTPStage = typeof stages[number];
type OAuthReason = typeof reasons[number];
export interface SchwabHTTPDiagnostic { stage: SchwabHTTPStage; http_status: number; oauth_error: OAuthReason | null }

/** Preserve existing safe error codes but attach ONLY bounded, fixed-vocabulary metadata.
 * Never request URL/hash, headers, correlation IDs, descriptions or response bodies.
 */
export class SchwabHTTPError extends SafeError {
  readonly diagnostic: Readonly<SchwabHTTPDiagnostic>;
  constructor(stage: SchwabHTTPStage, status: number, reason: OAuthReason | null = null) {
    super(status >= 300 && status < 400 ? 'schwab_redirect_refused'
      : status === 401 || status === 403 ? 'schwab_reauthorization_required' : 'schwab_rejected', 502);
    requireSafe(stages.includes(stage) && Number.isSafeInteger(status) && status >= 100 && status <= 599
      && (reason === null || reasons.includes(reason)), 'invalid_schwab_http_diagnostic', 503);
    this.diagnostic = Object.freeze({ stage, http_status: status, oauth_error: reason });
  }
}
function diagnosticsStage(request: Request, kind: 'oauth' | 'observe', phase?: 'oauth_exchange' | 'oauth_refresh'): SchwabHTTPStage {
  requireSafe(phase === undefined || (kind === 'oauth' && ['oauth_exchange', 'oauth_refresh'].includes(phase)),
    'invalid_schwab_http_diagnostic', 503);
  return kind === 'oauth' ? phase ?? 'oauth_token' : request.url === ACCOUNT_NUMBERS_URL ? 'account_mapping' : 'account_details';
}
async function oauthReason(response: Response, signal: AbortSignal): Promise<OAuthReason | null> {
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return null;
  try {
    const value = parseJson(await readBody(response, signal));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const reason = (value as Record<string, unknown>).error;
    return typeof reason === 'string' && (reasons as readonly string[]).includes(reason) ? reason as OAuthReason : null;
  } catch { return null; } // No raw parsing error, error_description, response text or arbitrary reason escapes.
}

/** Independent narrow egress policy, also used at the operator's real fetch boundary.
 * OAuth POST is deliberately separate from the GET-only observer. No order/transfer routes.
 */
export function validateSchwabRequest(request: Request, kind: 'oauth' | 'observe'): void {
  const url = new URL(request.url);
  const credentials = (request as Request & { credentials?: string }).credentials;
  requireSafe(url.origin === SCHWAB_ORIGIN && !url.username && !url.password && !url.hash
    && request.redirect === 'manual' && (credentials === undefined || credentials === 'omit'), 'schwab_egress_refused', 503);
  const authorization = request.headers.get('authorization') ?? '';
  const allowedHeaders = ['authorization', 'accept', 'cache-control', ...(kind === 'oauth' ? ['content-type'] : [])];
  requireSafe([...request.headers.keys()].every(k => allowedHeaders.includes(k)), 'schwab_egress_refused', 503);
  if (kind === 'oauth') {
    requireSafe(request.url === TOKEN_URL && request.method === 'POST' && /^Basic [A-Za-z0-9+/]+=*$/.test(authorization)
      && request.headers.get('content-type') === 'application/x-www-form-urlencoded', 'schwab_egress_refused', 503);
  } else {
    requireSafe(request.method === 'GET' && request.body === null && /^Bearer [\x21-\x7e]{8,16384}$/.test(authorization)
      && (request.url === ACCOUNT_NUMBERS_URL || (details.test(url.pathname) && url.search === '?fields=positions')),
    'schwab_egress_refused', 503);
  }
}

/** No ambient fetch, redirects, retries, response echoes or external error messages. */
export async function schwabText(request: Request, kind: 'oauth' | 'observe', transport: Transport,
  timeoutMs = 5000, oauthPhase?: 'oauth_exchange' | 'oauth_refresh'): Promise<string> {
  validateSchwabRequest(request, kind);
  const stage = diagnosticsStage(request, kind, oauthPhase);
  requireSafe(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30000, 'invalid_schwab_timeout', 503);
  const controller = new AbortController();
  const outbound = new Request(request, { signal: controller.signal });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new SafeError('schwab_timeout', 504)); }, timeoutMs);
  });
  try {
    return await Promise.race([timeout, (async () => {
      let response: Response;
      try { response = await transport(outbound); }
      catch { throw new SafeError('schwab_unavailable', 502); }
      if (response.redirected || response.status !== 200) {
        // Broker account bodies are never inspected here. OAuth may yield one known protocol
        // reason, parsed under the same body/deadline bound; all descriptions/data are discarded.
        const reason = kind === 'oauth' && !response.redirected && response.status >= 400
          ? await oauthReason(response, controller.signal) : null;
        void response.body?.cancel().catch(() => {});
        throw new SchwabHTTPError(stage, response.status, reason);
      }
      if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        void response.body?.cancel().catch(() => {});
        throw new SafeError('invalid_schwab_content_type', 502);
      }
      try { return await readBody(response, controller.signal); }
      catch { void response.body?.cancel().catch(() => {}); throw new SafeError('invalid_schwab_body', 502); }
    })()]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export function observeRequest(url: string, token: string): Request {
  requireSafe(/^[\x21-\x7e]{8,16384}$/.test(token), 'invalid_schwab_token', 503);
  return new Request(url, { method: 'GET', redirect: 'manual', credentials: 'omit',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Cache-Control': 'no-store' } } as RequestInit & { credentials: 'omit' });
}
