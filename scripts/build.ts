import { build } from 'esbuild';
await build({
  entryPoints: ['src/worker.ts'], outfile: '.build/worker.mjs', bundle: true,
  format: 'esm', platform: 'browser', target: 'es2023', external: ['cloudflare:workers'],
  logLevel: 'warning'
});
console.log('Built mock-only Worker. No upload or deployment performed.');
