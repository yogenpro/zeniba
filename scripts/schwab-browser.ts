import { isAbsolute } from 'node:path';
import { requireSafe } from '../src/errors';

/** Instructions only: never reads the authorization file/config, launches a browser or makes
 * a network request. The Windows browser reads the SAME protected WSL file through WSL interop.
 * No auth URL, client ID, state, code or token is included in a shell command or stdout.
 */
export function authorizationFileNotices(filename: string, wsl: boolean): string[] {
  requireSafe(isAbsolute(filename) && filename.length <= 4096 && !/[\x00-\x1f\x7f]/.test(filename),
    'invalid_schwab_authorization_path', 503);
  const messages = [`Open the protected local file ${filename} privately in your browser.`];
  if (wsl) {
    const quoted = "'" + filename.replace(/'/g, "'\\''") + "'";
    messages.push('Headless WSL needs no Linux GUI. Keep THIS terminal waiting; in a SECOND WSL terminal run:',
      `explorer.exe "$(wslpath -w ${quoted})"`,
      'Open the HTML file with your Windows browser under your own Windows user; click Continue at Schwab.',
      'If Windows interop is unavailable, use Windows File Explorer to open the same file through \\\\wsl.localhost\\<distro>\\ (do not copy it to a public/shareable directory).',
      'Return to THIS terminal and paste the completed callback into the hidden prompt, never chat.');
  }
  return messages;
}
