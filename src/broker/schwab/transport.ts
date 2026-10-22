import { requireSafe, SafeError } from '../../errors';
import { readBody } from '../../json';
import type { Transport } from '../../types';

export const SCHWAB_ORIGIN = 'https://api.schwabapi.com';
export const TOKEN_URL = `${SCHWAB_ORIGIN}/v1/oauth/token`;
export const AUTHORIZE_URL = `${SCHWAB_ORIGIN}/v1/oauth/authorize`;
export const ACCOUNT_NUMBERS_URL = `${SCHWAB_ORIGIN}/trader/v1/accounts/accountNumbers`;
const details = /^\/trader\/v1\/accounts\/[A-Za-z0-9_-]{8,256}$/;

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
  timeoutMs = 5000): Promise<string> {
  validateSchwabRequest(request, kind);
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
        void response.body?.cancel().catch(() => {});
        throw new SafeError(response.status >= 300 && response.status < 400 ? 'schwab_redirect_refused'
          : response.status === 401 || response.status === 403 ? 'schwab_reauthorization_required' : 'schwab_rejected', 502);
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
