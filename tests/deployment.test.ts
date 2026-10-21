import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDeploymentConfig } from '../scripts/deployment-config';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

const config = () => ({ ...JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')),
  name: 'toy-shadow-service', account_id: '0'.repeat(32), r2_buckets: [{ binding: 'EVIDENCE', bucket_name: 'toy-private-evidence' }] });

test('deployment guard accepts only an explicit mock configuration with closed alternate ingress', () => {
  assert.equal(validateDeploymentConfig(config()).name, 'toy-shadow-service');
});
test('deployment guard rejects live modes, preview routes, logging, unknown settings and storage drift', () => {
  for (const change of [
    (c: any) => delete c.account_id, (c: any) => c.workers_dev = true, (c: any) => delete c.preview_urls,
    (c: any) => c.preview_urls = true, (c: any) => c.vars.APP_MODE = 'live',
    (c: any) => c.vars.PROVIDER_TOKEN = 'synthetic-not-real', (c: any) => c.observability.enabled = true,
    (c: any) => c.routes = [{ pattern: 'toy.invalid', custom_domain: true }],
    (c: any) => c.triggers = { crons: ['* * * * *'] }, (c: any) => c.main = 'other.ts',
    (c: any) => c.r2_buckets = [], (c: any) => c.r2_buckets[0].remote = true,
    (c: any) => c.migrations = [], (c: any) => c.durable_objects.bindings[0].class_name = 'OtherClass',
    (c: any) => c.name = 'zeniba-local-shadow', (c: any) => c.build.command = 'arbitrary shell'
  ]) { const c = config(); change(c); assert.throws(() => validateDeploymentConfig(c)); }
});
