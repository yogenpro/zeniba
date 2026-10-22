import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, chmodSync, lstatSync, readdirSync, readFileSync, writeFileSync,
  symlinkSync, linkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { controllerArguments, runController, type OperatorIO } from '../scripts/schwab-controller';
import { SchwabStore, validateProbeConfig, validateStoredToken, type ProbeConfig } from '../scripts/schwab-store';
import { TOKEN_URL, ACCOUNT_NUMBERS_URL } from '../src/broker/schwab/transport';
import type { Transport } from '../src/types';
import { code } from './helpers';

const NOW = Date.parse('2030-04-03T15:00:00Z');
const config = (): ProbeConfig => ({ schema: 'zeniba.schwab-controller.v1', binding_id: 'a'.repeat(64),
  client_id: 'toy-app-client', client_secret: 'toy-app-secret', redirect_uri: 'https://127.0.0.1/return',
  expected_account_number: '00000001', expected_account_type: 'MARGIN', account_ref: 'probe_toy_account_ref_0001',
  approved_app_docs_reviewed: true, one_empty_account_only: true });
const stored = () => ({ binding_id: config().binding_id, token: { access_token: 'toy-access-token',
  refresh_token: 'toy-refresh-token', token_type: 'Bearer' as const, issued_at: NOW - 3600000, expires_at: NOW - 1800000 } });
function fixture() {
  const path = mkdtempSync('/var/tmp/zeniba-schwab-test-'); chmodSync(path, 0o700);
  const store = new SchwabStore(path); return { path, store, clean: () => rmSync(path, { recursive: true, force: true }) };
}
function fake(consent = '[{"accountNumber":"00000001","hashValue":"ToyHash0001"}]') {
  const calls: Request[] = [];
  const transport: Transport = async r => {
    calls.push(r);
    const body = r.url === TOKEN_URL ? '{"access_token":"toy-next-access","refresh_token":"toy-next-refresh","token_type":"Bearer","expires_in":1800}'
      : r.url === ACCOUNT_NUMBERS_URL ? consent : '{"securitiesAccount":{"accountNumber":"00000001","type":"MARGIN","positions":[],"currentBalances":{"cashBalance":0.0,"liquidationValue":0,"equity":0,"longMarketValue":0,"shortMarketValue":0,"buyingPower":0}}}';
    return new Response(body, { headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, transport };
}
function operator(path: string) {
  const notices: string[] = [];
  const io: OperatorIO = { notice: text => { notices.push(text); }, hidden: async () => {
    const html = readFileSync(join(path, 'authorization.html'), 'utf8');
    const encoded = /href="([^"]+)"/.exec(html)![1]!.replace(/&amp;/g, '&');
    return config().redirect_uri + '?code=toy-code&state=' + new URL(encoded).searchParams.get('state');
  } };
  return { io, notices };
}

test('operator commands require explicit live opt-in; no arbitrary command/URL/credential argument', () => {
  for (const args of [['probe', '/var/tmp/toy'], ['login', '/var/tmp/toy'], ['submit', '/var/tmp/toy', '--live'],
    ['probe', '/var/tmp/toy', '--live', '--token', 'toy'], ['setup', '/var/tmp/toy', '--live']])
    assert.throws(() => controllerArguments(args));
  assert.equal(controllerArguments(['probe', '/var/tmp/toy', '--live']).live, true);
  assert.equal(controllerArguments(['setup', '/var/tmp/toy']).live, false);
});
test('configuration explicitly binds one account and rejects additional capabilities/missing acknowledgements', () => {
  validateProbeConfig(config());
  for (const change of [(c: any) => c.orders_enabled = true, (c: any) => c.one_empty_account_only = false,
    (c: any) => c.approved_app_docs_reviewed = false, (c: any) => c.expected_account_number = '../other',
    (c: any) => c.expected_account_type = 'ANY', (c: any) => c.redirect_uri = 'https://callback.invalid/return',
    (c: any) => delete c.binding_id]) {
    const c = config(); change(c); assert.throws(() => validateProbeConfig(c));
  }
  assert.throws(() => validateStoredToken({ ...stored(), binding_id: 'b'.repeat(64) }, config(), NOW), code('schwab_token_binding_mismatch'));
});
test('private controller files are 0600 under 0700, create is no-clobber and replace is atomic', async () => {
  const f = fixture(); try {
    await f.store.exclusive(async () => { f.store.create('config.json', config()); });
    assert.equal(lstatSync(join(f.path, 'config.json')).mode & 0o777, 0o600);
    const inode = lstatSync(join(f.path, 'config.json')).ino;
    assert.throws(() => f.store.create('config.json', config()), code('schwab_state_already_exists'));
    f.store.replace('config.json', config()); assert.notEqual(lstatSync(join(f.path, 'config.json')).ino, inode);
    assert.equal((f.store.read('config.json') as ProbeConfig).binding_id, config().binding_id);
    assert.deepEqual(readdirSync(f.path), ['config.json']);
  } finally { f.clean(); }
});
test('symlink, hardlink and permissive secret files are rejected without following or overwriting them', () => {
  const f = fixture(); try {
    const source = join(f.path, 'source'); writeFileSync(source, '{}', { mode: 0o600 });
    symlinkSync(source, join(f.path, 'config.json')); assert.throws(() => f.store.read('config.json'), code('unsafe_schwab_secret_file'));
    assert.throws(() => f.store.replace('config.json', config()), code('unsafe_schwab_secret_file'));
    rmSync(join(f.path, 'config.json')); linkSync(source, join(f.path, 'config.json'));
    assert.throws(() => f.store.read('config.json'), code('unsafe_schwab_secret_file')); rmSync(join(f.path, 'config.json'));
    f.store.create('config.json', config()); chmodSync(join(f.path, 'config.json'), 0o644);
    assert.throws(() => f.store.read('config.json'), code('unsafe_schwab_secret_file'));
    assert.throws(() => f.store.replace('config.json', config()), code('unsafe_schwab_secret_file'));
  } finally { f.clean(); }
});
test('a dangling link cannot be clobbered by initial secret creation', () => {
  const f = fixture(); try {
    symlinkSync(join(f.path, 'missing'), join(f.path, 'config.json'));
    assert.throws(() => f.store.create('config.json', config())); assert.equal(lstatSync(join(f.path, 'config.json')).isSymbolicLink(), true);
  } finally { f.clean(); }
});
test('directories in Git, symlink ancestry, bad modes and path traversal/control names are rejected', () => {
  const f = fixture(); try {
    mkdirSync(join(f.path, '.git')); assert.throws(() => new SchwabStore(f.path), code('schwab_directory_must_be_outside_git'));
    rmSync(join(f.path, '.git'), { recursive: true });
    symlinkSync(f.path, join(f.path, 'alias')); assert.throws(() => new SchwabStore(join(f.path, 'alias')), code('schwab_directory_symlink_refused'));
    chmodSync(f.path, 0o755); assert.throws(() => new SchwabStore(f.path), code('unsafe_schwab_directory')); chmodSync(f.path, 0o700);
    for (const path of ['relative', f.path + '/../elsewhere', f.path + '\n']) assert.throws(() => new SchwabStore(path));
    for (const name of ['../elsewhere', 'anything.json', 'config.json/../token.json']) assert.throws(() => f.store.create(name, {}), code('invalid_schwab_store_name'));
  } finally { f.clean(); }
});
test('single-writer lease rejects simultaneous controllers and releases after both success and failure', async () => {
  const f = fixture(); try {
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    const first = f.store.exclusive(() => wait);
    await assert.rejects(new SchwabStore(f.path).exclusive(async () => {}), code('schwab_controller_busy'));
    release(); await first; assert.equal(existsSync(join(f.path, '.lock')), false);
    await assert.rejects(f.store.exclusive(async () => { throw new Error('toy'); }));
    assert.equal(existsSync(join(f.path, '.lock')), false);
  } finally { f.clean(); }
});
test('offline setup and status perform zero network requests and never echo private configuration', async () => {
  const f = fixture(); try {
    const prompts = ['toy-app-client', 'toy-app-secret', config().redirect_uri, '00000001', 'MARGIN', 'OBSERVE_ONE_EMPTY_ACCOUNT'];
    const notices: string[] = []; let requests = 0;
    const io: OperatorIO = { hidden: async () => prompts.shift()!, notice: text => { notices.push(text); } };
    const noNetwork: Transport = async () => { requests++; throw new Error('No network'); };
    await runController('setup', f.store, io, noNetwork, () => NOW);
    await runController('status', f.store, io, noNetwork, () => NOW);
    assert.equal(requests, 0); const output = notices.join('\n');
    for (const secret of ['toy-app-client', 'toy-app-secret', '00000001']) assert.equal(output.includes(secret), false);
    assert.throws(() => f.store.create('config.json', config()));
  } finally { f.clean(); }
});
test('successful synthetic OAuth probe persists only bound token and private empty-account evidence, not a hosted portfolio', async () => {
  const f = fixture(); try {
    f.store.create('config.json', config()); const { io, notices } = operator(f.path); const { transport, calls } = fake();
    await runController('login', f.store, io, transport, () => NOW);
    assert.deepEqual(calls.map(r => r.method), ['POST', 'GET', 'GET']);
    assert.equal(existsSync(join(f.path, 'authorization.html')), false);
    const value = validateStoredToken(f.store.read('token.json'), config(), NOW); assert.equal(value.token.access_token, 'toy-next-access');
    const names = readdirSync(f.path); assert.equal(names.filter(n => n.startsWith('probe-')).length, 1);
    const receipt = JSON.parse(readFileSync(join(f.path, names.find(n => n.startsWith('operation-'))!), 'utf8'));
    assert.deepEqual(receipt.counts, { oauth_token_posts: 1, mapping_gets: 1, selected_account_gets: 1, broker_writes: 0 });
    assert.equal(receipt.status, 'complete');
    for (const secret of ['toy-app-client', 'toy-app-secret', '00000001', 'toy-next-access', 'toy-next-refresh', 'toy-code'])
      assert.equal(notices.join('\n').includes(secret), false);
    for (const n of names) assert.equal(lstatSync(join(f.path, n)).mode & 0o777, 0o600);
  } finally { f.clean(); }
});
test('additional consent stops before account details and never saves a token or raw records', async () => {
  const f = fixture(); try {
    f.store.create('config.json', config()); const { io } = operator(f.path), { transport, calls } = fake('[]');
    await assert.rejects(runController('login', f.store, io, transport, () => NOW), code('schwab_single_account_consent_required'));
    assert.deepEqual(calls.map(r => r.method), ['POST', 'GET']); assert.equal(f.store.exists('token.json'), false);
    assert.equal(f.store.exists('authorization.html'), false); assert.equal(readdirSync(f.path).some(n => n.startsWith('probe-')), false);
    const receipt = JSON.parse(readFileSync(join(f.path, readdirSync(f.path).find(n => n.startsWith('operation-'))!), 'utf8'));
    assert.equal(receipt.status, 'failed'); assert.equal(receipt.counts.selected_account_gets, 0);
  } finally { f.clean(); }
});
test('a nonempty first login preserves only a blocked receipt and never stores token/holdings', async () => {
  const f = fixture(); try {
    f.store.create('config.json', config()); const { io } = operator(f.path), base = fake();
    await assert.rejects(runController('login', f.store, io, async r => {
      if (r.url.includes('?fields=positions')) return new Response('{"securitiesAccount":{"accountNumber":"00000001","type":"MARGIN","positions":[{"instrument":{"symbol":"TOY1"}}]}}', { headers: { 'Content-Type': 'application/json' } });
      return base.transport(r);
    }, () => NOW), code('schwab_initial_observation_blocked'));
    assert.equal(f.store.exists('token.json'), false);
    const name = readdirSync(f.path).find(n => n.startsWith('probe-'))!;
    const evidence = readFileSync(join(f.path, name), 'utf8');
    assert.equal(JSON.parse(evidence).raw_empty_account, null); assert.equal(evidence.includes('TOY1'), false);
    assert.equal(evidence.includes('00000001'), false);
  } finally { f.clean(); }
});
test('denied or malformed callbacks consume the login and remove the protected authorization page', async () => {
  const f = fixture(); try {
    f.store.create('config.json', config()); let count = 0;
    await assert.rejects(runController('login', f.store, { hidden: async () => 'https://other.invalid/?code=toy', notice: () => {} },
      async () => { count++; throw new Error('No network'); }, () => NOW), code('invalid_schwab_oauth_callback'));
    assert.equal(count, 0); assert.equal(f.store.exists('authorization.html'), false); assert.equal(f.store.exists('token.json'), false);
  } finally { f.clean(); }
});
test('expired access refresh rotates token atomically before account reads and supports repeat probes without refresh', async () => {
  const f = fixture(); try {
    f.store.create('config.json', config()); f.store.create('token.json', stored()); const { calls, transport } = fake(); const { io } = operator(f.path);
    await runController('probe', f.store, io, async request => {
      if (request.url === ACCOUNT_NUMBERS_URL) assert.equal((f.store.read('token.json') as any).token.refresh_token, 'toy-next-refresh');
      return transport(request);
    }, () => NOW);
    assert.deepEqual(calls.map(r => r.method), ['POST', 'GET', 'GET']);
    calls.length = 0; await runController('probe', f.store, io, transport, () => NOW + 1000);
    assert.deepEqual(calls.map(r => r.method), ['GET', 'GET']);
  } finally { f.clean(); }
});
test('ambiguous refresh cannot be retried automatically and requires fresh single-account OAuth', async () => {
  const f = fixture(); try {
    f.store.create('config.json', config()); f.store.create('token.json', stored()); const { io } = operator(f.path);
    let calls = 0;
    await assert.rejects(runController('probe', f.store, io, async () => { calls++; throw new Error('toy transport interruption'); }, () => NOW), code('schwab_unavailable'));
    assert.equal(calls, 1); assert.equal(f.store.exists('refresh-pending.json'), true);
    await assert.rejects(runController('probe', f.store, io, async () => { calls++; throw new Error('Must not retry'); }, () => NOW), code('schwab_refresh_reauthorization_required'));
    assert.equal(calls, 1);
    await runController('login', f.store, io, fake().transport, () => NOW);
    assert.equal(f.store.exists('refresh-pending.json'), false);
    assert.equal((f.store.read('token.json') as any).token.access_token, 'toy-next-access');
  } finally { f.clean(); }
});
test('token-persistence failure after successful refresh leaves old token plus a fail-closed recovery barrier', async () => {
  const f = fixture(); try {
    f.store.create('config.json', config()); f.store.create('token.json', stored());
    const replace = f.store.replace.bind(f.store);
    f.store.replace = (name, value) => { if (name === 'token.json') throw new Error('toy interrupted write'); replace(name, value); };
    const { io } = operator(f.path), network = fake();
    await assert.rejects(runController('probe', f.store, io, network.transport, () => NOW));
    assert.equal(network.calls.length, 1); assert.equal((f.store.read('token.json') as any).token.refresh_token, 'toy-refresh-token');
    assert.equal(f.store.exists('refresh-pending.json'), true);
    await assert.rejects(runController('probe', f.store, io, network.transport, () => NOW), code('schwab_refresh_reauthorization_required'));
    assert.equal(network.calls.length, 1);
  } finally { f.clean(); }
});
test('wrong token binding and unsafe token file fail before OAuth or account HTTP', async () => {
  const f = fixture(); try {
    f.store.create('config.json', config()); f.store.create('token.json', { ...stored(), binding_id: 'b'.repeat(64) }); const { io } = operator(f.path);
    let count = 0; const noNetwork: Transport = async () => { count++; throw new Error('No network'); };
    await assert.rejects(runController('probe', f.store, io, noNetwork, () => NOW), code('schwab_token_binding_mismatch'));
    f.store.replace('token.json', stored()); chmodSync(join(f.path, 'token.json'), 0o644);
    await assert.rejects(runController('probe', f.store, io, noNetwork, () => NOW), code('unsafe_schwab_secret_file')); assert.equal(count, 0);
  } finally { f.clean(); }
});
test('stale leases are never broken automatically and insecure TLS is refused before state access', async () => {
  const f = fixture(); try {
    mkdirSync(join(f.path, '.lock'), { mode: 0o700 });
    await assert.rejects(f.store.exclusive(async () => {}), code('schwab_controller_busy'));
    assert.equal(existsSync(join(f.path, '.lock')), true);
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/schwab-observe.ts', 'status', f.path],
      { encoding: 'utf8', env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' } });
    assert.equal(r.status, 1); assert.match(r.stderr, /schwab_TLS_verification_required/);
    assert.deepEqual(readdirSync(f.path), ['.lock']);
  } finally { f.clean(); }
});
test('actual CLI refuses live calls without opt-in or a private TTY, without creating state', () => {
  const f = fixture(); try {
    for (const args of [['login', f.path], ['login', f.path, '--live'], ['setup', f.path]]) {
      const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/schwab-observe.ts', ...args], { encoding: 'utf8' });
      assert.equal(r.status, 1); assert.match(r.stderr, /explicit_schwab_live_opt_in_required|schwab_private_TTY_required/);
      assert.deepEqual(readdirSync(f.path), []);
    }
  } finally { f.clean(); }
});
