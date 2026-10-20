import { writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

// Never print secrets or overwrite an operator's configuration.
await writeFile('.dev.vars', `OWNER_TOKEN=${randomBytes(32).toString('hex')}\nTELEGRAM_WEBHOOK_SECRET=${randomBytes(32).toString('hex')}\nTELEGRAM_USER_ID=100001\nTELEGRAM_CHAT_ID=100001\n`, { flag: 'wx', mode: 0o600 });
console.log('Created ignored .dev.vars (0600) with local-only secrets and toy Telegram IDs. Read it locally; do not share it.');
