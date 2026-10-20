import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import standaloneCode from 'ajv/dist/standalone/index.js';

// Generate ahead of time: Workers must not compile schemas with eval/new Function.
const bytes = await readFile(new URL('../contracts/strategy-provider-v1.schema.json', import.meta.url));
const schema = JSON.parse(bytes.toString('utf8'));
const ajv = new Ajv2020({ code: { source: true, esm: false }, strict: true, allErrors: false });
addFormats(ajv, { mode: 'full' });
ajv.addSchema(schema);
const names = ['request', 'proposal', 'descriptor', 'health', 'error'];
const exports = Object.fromEntries(names.map(name => [`validate_${name}`, `${schema.$id}#/$defs/${name}`]));
await mkdir(new URL('../.generated/', import.meta.url), { recursive: true });
await writeFile(new URL('../.generated/validators.cjs', import.meta.url), standaloneCode(ajv, exports));
await writeFile(new URL('../.generated/validators.d.cts', import.meta.url), names.map(name =>
  `export declare function validate_${name}(value: unknown): boolean;`).join('\n') + '\n');
await writeFile(new URL('../.generated/contract.ts', import.meta.url),
  `export const CONTRACT_SHA256 = '${createHash('sha256').update(bytes).digest('hex')}';\n`);
console.log('Generated offline contract validators and schema byte pin.');
