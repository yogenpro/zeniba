import { requireSafe } from './errors';
import { equalSecret, failure } from './http';
import { parseJson, readBody } from './json';
import { parseTelegram } from './telegram';
import { ownerShell } from './ui';
import type { Env } from './coordinator';
export { AccountCoordinator } from './coordinator';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      requireSafe(env.APP_MODE === 'mock', 'mock_only_build', 503);
      requireSafe(typeof env.OWNER_TOKEN === 'string' && env.OWNER_TOKEN.length >= 32, 'owner_not_configured', 503);
      const url = new URL(request.url);
      requireSafe(!url.search, 'query_not_supported', 400); // No credentials/account IDs in URLs.
      if (url.pathname === '/' && request.method === 'GET') return ownerShell();
      const coordinator = () => env.ACCOUNTS.get(env.ACCOUNTS.idFromName('synthetic-account'));
      if (url.pathname === '/telegram/webhook' && request.method === 'POST') {
        const secret = env.TELEGRAM_WEBHOOK_SECRET;
        requireSafe(typeof secret === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(secret)
          && env.TELEGRAM_USER_ID && env.TELEGRAM_CHAT_ID, 'telegram_not_configured', 503);
        requireSafe(await equalSecret(request.headers.get('x-telegram-bot-api-secret-token') ?? '', secret), 'unauthorized', 401);
        requireSafe(request.headers.get('content-type')?.split(';')[0]?.trim() === 'application/json', 'invalid_content_type', 415);
        const callback = parseTelegram(parseJson(await readBody(request)), env.TELEGRAM_USER_ID, env.TELEGRAM_CHAT_ID);
        return await coordinator().fetch(new Request('https://internal.invalid/internal/telegram', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(callback)
        }));
      }
      requireSafe(url.pathname.startsWith('/api/'), 'not_found', 404);
      const authorization = request.headers.get('authorization') ?? '';
      requireSafe(authorization.startsWith('Bearer ') && authorization.length <= 1024
        && await equalSecret(authorization.slice(7), env.OWNER_TOKEN), 'unauthorized', 401);
      requireSafe(!request.headers.has('origin') || request.headers.get('origin') === url.origin, 'cross_origin_refused', 403);
      requireSafe(request.method === 'GET' || request.method === 'POST', 'method_not_allowed', 405);
      return await coordinator().fetch(request);
    } catch (error) { return failure(error); }
  },
  // Deliberately no scheduled job creates proposals or catches up on expired decisions.
  // The initial mock UI invokes observation explicitly. A live scheduler needs a calendar adapter.
} satisfies ExportedHandler<Env>;
