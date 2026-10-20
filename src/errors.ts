export class SafeError extends Error {
  constructor(public readonly code: string, public readonly status = 409) {
    super(code);
    this.name = 'SafeError';
  }
}
export function requireSafe(condition: unknown, code: string, status = 409): asserts condition {
  if (!condition) throw new SafeError(code, status);
}
export function safeFailure(error: unknown): { code: string; status: number } {
  // No exception messages, provider bodies, account references, URLs or credentials escape.
  return error instanceof SafeError ? { code: error.code, status: error.status }
    : { code: 'internal_failure', status: 500 };
}
