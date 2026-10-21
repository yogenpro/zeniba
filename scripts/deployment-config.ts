import { readFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { requireSafe } from '../src/errors';
import { canonicalJson, parseJson } from '../src/json';

export interface DeploymentConfig { name: string; account_id: string }
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
/** A deployment may relocate the mock app, never add a live integration or a second IaC writer. */
export function validateDeploymentConfig(value: unknown): DeploymentConfig {
  requireSafe(value && typeof value === 'object' && !Array.isArray(value), 'invalid_deployment_config');
  const c = value as Record<string, unknown>;
  const keys = ['$schema', 'name', 'account_id', 'main', 'compatibility_date', 'workers_dev', 'preview_urls',
    'build', 'vars', 'durable_objects', 'migrations', 'r2_buckets', 'observability'];
  requireSafe(Object.keys(c).every(k => keys.includes(k)), 'unexpected_deployment_setting');
  requireSafe(typeof c.name === 'string' && /^[a-z][a-z0-9-]{2,62}$/.test(c.name)
    && !c.name.includes('local') && typeof c.account_id === 'string' && /^[0-9a-f]{32}$/.test(c.account_id), 'invalid_deployment_identity');
  requireSafe(c.main === 'src/worker.ts' && c.compatibility_date === '2026-07-30', 'deployment_source_mismatch');
  requireSafe(c.workers_dev === false && c.preview_urls === false, 'alternate_ingress_must_be_disabled');
  requireSafe(same(c.vars, { APP_MODE: 'mock' }), 'mock_mode_required');
  requireSafe(same(c.build, { command: 'npm run generate' }), 'deployment_build_mismatch');
  requireSafe(same(c.durable_objects, { bindings: [{ name: 'ACCOUNTS', class_name: 'AccountCoordinator' }] })
    && same(c.migrations, [{ tag: 'v1', new_sqlite_classes: ['AccountCoordinator'] }]), 'deployment_storage_mismatch');
  const buckets = c.r2_buckets as { name?: unknown; binding?: unknown; bucket_name?: unknown }[] | undefined;
  requireSafe(Array.isArray(buckets) && buckets.length === 1 && buckets[0]?.binding === 'EVIDENCE'
    && typeof buckets[0].bucket_name === 'string' && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(buckets[0].bucket_name)
    && Object.keys(buckets[0]).length === 2, 'deployment_evidence_binding_required');
  requireSafe(same(c.observability, { enabled: false }), 'deployment_logging_must_be_disabled');
  return { name: c.name, account_id: c.account_id };
}
export function readDeploymentConfig(filename: string): { path: string; config: DeploymentConfig } {
  const path = resolve(filename);
  requireSafe(path.endsWith('.local.json') && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'private_deployment_file_required');
  return { path, config: validateDeploymentConfig(parseJson(readFileSync(path, 'utf8'))) };
}
