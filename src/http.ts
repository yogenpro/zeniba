import { requireSafe, safeFailure } from './errors';
import { parseJson, readBody } from './json';

export const PRIVATE_HEADERS = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
};
export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { ...PRIVATE_HEADERS, 'Content-Type': 'application/json; charset=utf-8' } });
}
export function failure(error: unknown): Response {
  const safe = safeFailure(error); return json({ error: { code: safe.code } }, safe.status);
}
export async function objectBody(request: Request, keys: string[], required = keys): Promise<Record<string, unknown>> {
  requireSafe(request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/json', 'invalid_content_type', 415);
  const data = parseJson(await readBody(request));
  requireSafe(data !== null && typeof data === 'object' && !Array.isArray(data), 'invalid_body', 400);
  const body = data as Record<string, unknown>;
  requireSafe(Object.keys(body).every(k => keys.includes(k)) && required.every(k => k in body), 'invalid_body', 400);
  return body;
}
export function stringField(body: Record<string, unknown>, key: string): string {
  requireSafe(typeof body[key] === 'string', 'invalid_body', 400); return body[key] as string;
}
export async function equalSecret(actual: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', encoder.encode(actual)), crypto.subtle.digest('SHA-256', encoder.encode(expected))]);
  const x = new Uint8Array(a), y = new Uint8Array(b); let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i]! ^ y[i]!;
  return difference === 0;
}
