import { constants, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, fstatSync, lstatSync,
  mkdirSync, rmdirSync, unlinkSync, renameSync, existsSync, linkSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { requireSafe } from '../src/errors';
import { canonicalJson, parseJson, MAX_BODY } from '../src/json';
import { validateApp, validateToken, type SchwabApp, type SchwabToken } from '../src/broker/schwab/oauth';
import { validateSelection, type SchwabSelection } from '../src/broker/schwab/observer';

export interface ProbeConfig extends SchwabApp, SchwabSelection {
  schema: 'zeniba.schwab-controller.v1'; binding_id: string;
  approved_app_docs_reviewed: true; one_empty_account_only: true;
}
export interface StoredToken { binding_id: string; token: SchwabToken }
export function validateProbeConfig(value: unknown): ProbeConfig {
  requireSafe(value && typeof value === 'object' && !Array.isArray(value), 'invalid_schwab_config', 503);
  const c = value as ProbeConfig;
  const keys = ['schema', 'binding_id', 'client_id', 'client_secret', 'redirect_uri', 'expected_account_number',
    'expected_account_type', 'account_ref', 'approved_app_docs_reviewed', 'one_empty_account_only'];
  requireSafe(Object.keys(c).length === keys.length && keys.every(k => Object.hasOwn(c, k))
    && c.schema === 'zeniba.schwab-controller.v1' && /^[0-9a-f]{64}$/.test(c.binding_id)
    && c.approved_app_docs_reviewed === true && c.one_empty_account_only === true, 'invalid_schwab_config', 503);
  validateApp(c); validateSelection(c);
  // This first controller probe must not deliver a code to a deployed app/Access/logging path.
  requireSafe(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(c.redirect_uri).hostname),
    'schwab_loopback_callback_required', 503);
  return c;
}
export function validateStoredToken(value: unknown, config: ProbeConfig, now: number): StoredToken {
  requireSafe(value && typeof value === 'object' && !Array.isArray(value), 'invalid_schwab_token_store', 503);
  const v = value as StoredToken;
  requireSafe(Object.keys(v).length === 2 && v.binding_id === config.binding_id, 'schwab_token_binding_mismatch', 503);
  validateToken(v.token, now); return v;
}
const uid = () => process.getuid?.();
const privateFile = (s: Stats) => s.isFile() && !s.isSymbolicLink()
  && s.uid === uid() && (s.mode & 0o777) === 0o600 && s.nlink === 1;

/** Local single-writer controller state, OUTSIDE every Git tree, not a cloud secret vault.
 * No world-readable files, symlinks/hardlinks, stale-lock breaking or secret output.
 */
export class SchwabStore {
  readonly directory: string;
  constructor(path: string, create = false) {
    requireSafe(typeof path === 'string' && path.length <= 4096 && !/[\x00-\x1f\x7f]/.test(path)
      && isAbsolute(path) && path === resolve(path) && path !== '/', 'private_schwab_directory_required', 503);
    let parent = path;
    while (true) {
      if (existsSync(parent)) requireSafe(lstatSync(parent).isDirectory() && !lstatSync(parent).isSymbolicLink(), 'schwab_directory_symlink_refused', 503);
      requireSafe(!existsSync(join(parent, '.git')), 'schwab_directory_must_be_outside_git', 503);
      if (parent === dirname(parent)) break; parent = dirname(parent);
    }
    if (create && !existsSync(path)) mkdirSync(path, { mode: 0o700 });
    const s = lstatSync(path);
    requireSafe(s.isDirectory() && s.uid === uid() && (s.mode & 0o777) === 0o700, 'unsafe_schwab_directory', 503);
    this.directory = path;
  }
  private path(name: string): string {
    requireSafe(/^(?:config\.json|token\.json|refresh-pending\.json|authorization\.html|(?:probe|operation)-[0-9a-f]{32}\.json)$/.test(name), 'invalid_schwab_store_name', 503);
    return join(this.directory, name);
  }
  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const lock = join(this.directory, '.lock');
    requireSafe(!existsSync(lock), 'schwab_controller_busy', 409);
    // mkdir is the actual atomic acquisition; another operator cannot race past existsSync.
    try { mkdirSync(lock, { mode: 0o700 }); } catch { throw new Error('schwab_controller_busy'); }
    try { return await operation(); } finally { rmdirSync(lock); }
  }
  exists(name: string): boolean { return existsSync(this.path(name)); }
  read(name: string): unknown {
    const path = this.path(name), before = lstatSync(path);
    requireSafe(privateFile(before) && before.size <= MAX_BODY, 'unsafe_schwab_secret_file', 503);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      requireSafe(privateFile(opened) && opened.ino === before.ino && opened.dev === before.dev && opened.size <= MAX_BODY,
        'unsafe_schwab_secret_file', 503);
      return parseJson(readFileSync(fd, 'utf8'));
    } finally { closeSync(fd); }
  }
  create(name: string, value: unknown): void { this.write(name, canonicalJson(value), false); }
  replace(name: string, value: unknown): void { this.write(name, canonicalJson(value), true); }
  authorization(html: string): void { this.write('authorization.html', html, false); }
  removeAuthorization(): void {
    const path = this.path('authorization.html');
    if (existsSync(path)) { requireSafe(privateFile(lstatSync(path)), 'unsafe_schwab_secret_file', 503); unlinkSync(path); }
  }
  clearRefreshBarrier(): void {
    const path = this.path('refresh-pending.json');
    requireSafe(privateFile(lstatSync(path)), 'unsafe_schwab_secret_file', 503);
    unlinkSync(path); this.sync();
  }
  evidence(kind: 'probe' | 'operation', value: unknown): string {
    const name = `${kind}-${randomBytes(16).toString('hex')}.json`; this.create(name, value); return name;
  }
  private write(name: string, text: string, replace: boolean): void {
    const target = this.path(name);
    requireSafe(Buffer.byteLength(text) <= MAX_BODY * 2, 'schwab_store_value_too_large', 503);
    if (replace) requireSafe(existsSync(target) && privateFile(lstatSync(target)), 'unsafe_schwab_secret_file', 503);
    else requireSafe(!existsSync(target), 'schwab_state_already_exists', 409);
    const temporary = join(this.directory, `.pending-${randomBytes(16).toString('hex')}`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(fd, text, 'utf8'); fsyncSync(fd);
      requireSafe(privateFile(fstatSync(fd)), 'unsafe_schwab_secret_file', 503);
    } catch (error) { unlinkSync(temporary); throw error; }
    finally { closeSync(fd); }
    try {
      if (replace) {
        requireSafe(privateFile(lstatSync(target)), 'unsafe_schwab_secret_file', 503);
        renameSync(temporary, target);
      } else {
        // link is no-clobber even if a file/dangling symlink appeared after the first check.
        linkSync(temporary, target); unlinkSync(temporary);
      }
      this.sync();
    } catch (error) { if (existsSync(temporary)) unlinkSync(temporary); throw error; }
  }
  private sync(): void { const fd = openSync(this.directory, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }
}
