import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { requireSafe, safeFailure } from '../src/errors';
import { readDeploymentConfig } from './deployment-config';

try {
  const args = process.argv.slice(2), dryRun = args[1] === '--dry-run';
  requireSafe(args.length === 1 || (args.length === 2 && dryRun), 'explicit_private_config_required');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { path, config } = readDeploymentConfig(args[0]!);
  requireSafe(dirname(path) === resolve(root), 'deployment_file_must_be_in_project_root');
  requireSafe(spawnSync('git', ['check-ignore', '--quiet', path], { cwd: root }).status === 0, 'deployment_file_must_be_ignored');
  if (!dryRun) requireSafe(process.env.CLOUDFLARE_ACCOUNT_ID === config.account_id
    && typeof process.env.CLOUDFLARE_API_TOKEN === 'string' && process.env.CLOUDFLARE_API_TOKEN.length >= 20, 'explicit_controller_credentials_required');
  const env: NodeJS.ProcessEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
  // Wrangler needs the Cloudflare controller credential, not Terraform's backend keys.
  for (const key of Object.keys(env)) if (key.startsWith('AWS_') || key === 'GITHUB_TOKEN' || key === 'GH_TOKEN') delete env[key];
  const result = spawnSync(resolve(root, 'node_modules/.bin/wrangler'), ['deploy', '--config', path,
    ...(dryRun ? ['--dry-run', '--outdir', resolve(root, '.build/deploy-dry-run')] : [])], { cwd: root, env, stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(safeFailure(error).code); // No config values, credentials or exception stacks.
  process.exitCode = 1;
}
