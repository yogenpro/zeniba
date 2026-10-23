import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizationFileNotices } from '../scripts/schwab-browser';

const filename = '/home/toy/.zeniba-schwab-probe/authorization.html';
test('headless WSL handoff uses Windows browser and the same local file, not a Linux GUI/server', () => {
  const text = authorizationFileNotices(filename, true).join('\n');
  assert.ok(text.includes('SECOND WSL terminal'));
  assert.ok(text.includes(`explorer.exe "$(wslpath -w '${filename}')"`));
  assert.ok(text.includes('\\\\wsl.localhost\\<distro>\\'));
  assert.ok(text.includes('hidden prompt, never chat'));
  assert.equal(text.includes('xdg-open'), false); assert.equal(text.includes('http://'), false);
  assert.equal(text.includes('api.schwabapi.com'), false);
});
test('non-WSL flow retains the ordinary protected-file instruction without Windows commands', () => {
  assert.deepEqual(authorizationFileNotices(filename, false), [`Open the protected local file ${filename} privately in your browser.`]);
});
test('Windows handoff shell-quotes spaces and apostrophes without interpolation', () => {
  const path = "/home/toy/it's $(not-a-command)/authorization.html";
  const text = authorizationFileNotices(path, true).join('\n');
  assert.ok(text.includes("wslpath -w '/home/toy/it'\\''s $(not-a-command)/authorization.html'"));
});
test('relative/control-character filenames are rejected rather than printed into a terminal command', () => {
  for (const path of ['relative.html', '/home/toy/file\ncommand', '/home/toy/\u001b[2J', 'x'.repeat(4097)])
    assert.throws(() => authorizationFileNotices(path, true));
});
test('handoff is pure instruction formatting and does not need any actual config/auth file or browser', () => {
  const path = '/nonexistent/toy-only/authorization.html';
  assert.equal(authorizationFileNotices(path, true)[0], `Open the protected local file ${path} privately in your browser.`);
});
