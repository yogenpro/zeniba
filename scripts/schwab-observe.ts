import { stdin, stdout } from 'node:process';
import { requireSafe, safeFailure, SafeError } from '../src/errors';
import { controllerArguments, runController, type OperatorIO } from './schwab-controller';
import { SchwabStore } from './schwab-store';

/** Real TTY only. Secret/callback/account input never echoes, appears in argv or reads a pipe. */
function hidden(prompt: string): Promise<string> {
  requireSafe(stdin.isTTY && stdout.isTTY && typeof stdin.setRawMode === 'function', 'schwab_private_TTY_required', 503);
  return new Promise((resolve, reject) => {
    let text = '', settled = false;
    const done = (error?: Error) => {
      if (settled) return; settled = true;
      stdin.off('data', data); stdin.off('end', ended); stdin.setRawMode(false); stdin.pause(); stdout.write('\n');
      if (error) reject(error); else resolve(text);
    };
    const ended = () => done(new SafeError('schwab_operator_input_aborted', 409));
    const data = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3 || byte === 4 || byte === 27) { done(new SafeError('schwab_operator_input_aborted', 409)); return; }
        if (byte === 10 || byte === 13) { done(); return; }
        if (byte === 127 || byte === 8) text = text.slice(0, -1);
        else if (byte >= 32 && byte <= 126) text += String.fromCharCode(byte);
        else { done(new SafeError('invalid_schwab_operator_input', 400)); return; }
        if (text.length > 16384) { done(new SafeError('invalid_schwab_operator_input', 400)); return; }
      }
    };
    stdout.write(prompt); stdin.setRawMode(true); stdin.resume(); stdin.on('data', data); stdin.once('end', ended);
  });
}
try {
  const { command, directory } = controllerArguments(process.argv.slice(2));
  requireSafe(process.platform === 'linux' && process.versions.node.split('.')[0] === '24', 'schwab_supported_controller_required', 503);
  requireSafe(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', 'schwab_TLS_verification_required', 503);
  if (command === 'setup' || command === 'login') requireSafe(stdin.isTTY && stdout.isTTY, 'schwab_private_TTY_required', 503);
  const store = new SchwabStore(directory, command === 'setup');
  const io: OperatorIO = { hidden, notice: text => stdout.write(text + '\n') };
  // This is the only real fetch in the extension; runController independently enforces the
  // fixed OAuth/GET-only egress policy first. No Worker/global-fetch default is changed.
  await runController(command, store, io, request => fetch(request), Date.now);
} catch (error) {
  console.error(safeFailure(error).code); // Fixed codes only; no callback/body/file/exception echo.
  process.exitCode = 1;
}
