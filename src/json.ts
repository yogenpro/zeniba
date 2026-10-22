import { requireSafe, SafeError } from './errors';

export const MAX_BODY = 262144;
const encoder = new TextEncoder();
export function byteLength(text: string): number { return encoder.encode(text).length; }

/** Strict JSON, bounded nesting, duplicate-key detection before native parsing can lose data.
 * Numeric operational IDs may be safe integers; financial values must remain strings.
 * Fractional/unsafe numeric literals are rejected rather than rounded by JSON.parse.
 */
export function parseJson(text: string): unknown { return parse(text, false); }

/** Broker JSON uses numeric money/share literals. Retain EVERY number's original lexeme as a
 * string instead of passing it through binary floating point. Not a request/schema bypass:
 * only the disconnected observation adapter calls this; ordinary parseJson stays strict.
 */
export function parseBrokerJson(text: string): unknown { return parse(text, true); }

function parse(text: string, preserveNumbers: boolean): unknown {
  requireSafe(byteLength(text) <= MAX_BODY, 'payload_too_large', 413);
  let i = 0;
  const fail = (): never => { throw new SafeError('invalid_json', 400); };
  const ws = () => { while (i < text.length && /[\x20\t\r\n]/.test(text[i]!)) i++; };
  const string = (): string => {
    if (text[i] !== '"') return fail();
    const start = i++;
    while (i < text.length) {
      const c = text[i++];
      if (c === '"') {
        try { return JSON.parse(text.slice(start, i)); } catch { return fail(); }
      }
      if (c === '\\') i++;
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    if (depth > 40) return fail();
    ws();
    if (text[i] === '"') return string();
    if (text[i] === '{') {
      i++; ws();
      const result: Record<string, unknown> = Object.create(null);
      const keys = new Set<string>();
      if (text[i] === '}') { i++; return result; }
      while (i < text.length) {
        ws(); const key = string();
        requireSafe(!keys.has(key), 'duplicate_json_key', 400); keys.add(key);
        ws(); if (text[i++] !== ':') return fail();
        result[key] = value(depth + 1); ws();
        const end = text[i++];
        if (end === '}') return result;
        if (end !== ',') return fail();
      }
      return fail();
    }
    if (text[i] === '[') {
      i++; ws(); const result: unknown[] = [];
      if (text[i] === ']') { i++; return result; }
      while (i < text.length) {
        result.push(value(depth + 1)); ws(); const end = text[i++];
        if (end === ']') return result;
        if (end !== ',') return fail();
      }
      return fail();
    }
    for (const [token, parsed] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(token, i)) { i += token.length; return parsed; }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i));
    if (match) {
      i += match[0].length;
      if (preserveNumbers) return match[0];
      const n = Number(match[0]);
      requireSafe(!/[.eE]/.test(match[0]) && Number.isSafeInteger(n), 'unsafe_json_number', 400);
      return n;
    }
    return fail();
  };
  const parsed = value(0); ws(); if (i !== text.length) return fail(); return parsed;
}

// Python-compatible sorted compact JSON, ensure_ascii escaping, one terminal newline.
// Unicode code-point order (not JS UTF-16 key order) also covers non-ASCII intent IDs.
function compareKeys(a: string, b: string): number {
  const x = Array.from(a, c => c.codePointAt(0)!); const y = Array.from(b, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}
function quote(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
export function canonicalJson(value: unknown): string {
  const encode = (v: unknown): string => {
    if (v === null) return 'null';
    if (typeof v === 'string') return quote(v);
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v);
    if (Array.isArray(v)) return '[' + v.map(encode).join(',') + ']';
    if (typeof v === 'object' && v && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
      return '{' + Object.keys(v).sort(compareKeys).map(k => quote(k) + ':' + encode((v as Record<string, unknown>)[k])).join(',') + '}';
    }
    throw new SafeError('noncanonical_value', 400);
  };
  return encode(value) + '\n';
}
export async function hashBytes(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
export function hashObject(value: unknown): Promise<string> { return hashBytes(canonicalJson(value)); }

export async function readBody(message: Request | Response, signal?: AbortSignal): Promise<string> {
  const length = message.headers.get('content-length');
  if (length !== null) requireSafe(/^\d+$/.test(length) && BigInt(length) <= BigInt(MAX_BODY), 'payload_too_large', 413);
  const reader = message.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    requireSafe(!signal?.aborted, 'body_read_aborted', 400);
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      requireSafe(size <= MAX_BODY, 'payload_too_large', 413); chunks.push(value);
    }
    requireSafe(!signal?.aborted, 'body_read_aborted', 400);
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new SafeError('invalid_json', 400); }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
}
