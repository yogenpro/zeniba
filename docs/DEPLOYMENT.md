# Authorized mock-only Workers deployment

Cloud deployment is a separate operator action, not an effect of publishing source or running CI.
The authorized deployment still uses only synthetic accounts and the in-process mock provider.
It enables no live provider/broker access, Telegram delivery, automatic scheduling or order writes.

## Ownership and private configuration

The application repository/Wrangler owns code, bindings, SQLite Durable Object migrations,
compatibility date, secrets and the workers.dev/preview switches. A separate private infrastructure
workflow owns the custom domain, owner-only edge Access policy and private R2 container with
`prevent_destroy`. Do not give either system ownership of fields the other writes. In particular,
no domains/routes or Terraform credentials belong in the application config or public CI.

Keep the deployment's account ID, Worker/bucket names, configuration, secret material and operational
receipts out of tracked files. The default `wrangler.jsonc` remains a local development profile.
An operator can derive a **root-level, ignored `*.local.json`** deployment profile from it, supplying
`account_id`, a non-local Worker `name`, and the provisioned `EVIDENCE` bucket name. All other
settings must match the tested mock configuration. Do not put secrets in `vars` or reuse local toy
Telegram identities/credentials. Install an independent random owner token through Wrangler's
secret API, via a protected file/stdin, never an argument, URL or log.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run deploy -- wrangler.deploy.local.json --dry-run
# Only from the authorized controller, with explicitly configured Cloudflare credentials:
npm run deploy -- wrangler.deploy.local.json
```

The deployment wrapper requires the ignored file explicitly, validates its closed ingress,
mock-only mode, logging-off settings, exact code/migration/binding shape and absence of additional
routes, cron, provider or override fields. Actual upload requires an explicit matching account ID
and existing API token; it never starts login or searches for a stronger credential. Terraform's
AWS backend keys and GitHub tokens are removed from the Wrangler child environment. The wrapper
never provisions infrastructure, writes DNS, installs a secret or enables a public preview.
Public CI remains synthetic/credential-free and has no deployment job or production secrets.

## First installation and verification

For a new service, a controller may create a fail-closed HTTP-503 bootstrap with workers.dev and
previews off. Private infrastructure review/apply then creates the R2 container, custom domain and
owner-only Access gate. Only after those controls exist should the tested, reviewed application
revision be uploaded with its owner secret. There is no need for an ungated temporary hostname.

Verify the deployed revision/binding metadata, the lack of alternate ingress and public R2 access,
and anonymous denial/Access redirect at the custom domain. Verify the authenticated UI, synthetic
proposal workflow and persistence as the owner; do not call an Access redirect an authenticated
application health check. Record actual version IDs, receipts, auth/backup results and any gaps
privately. Never disable the edge gate to make a probe pass.

The initial SQLite migration creates an empty mock account namespace; code rollback does not roll
back SQLite migrations or delete R2 evidence. There is no automatic reset, cleanup, restore or
real-account onboarding. Backup restore, long-running ledger layout, rate/monitoring controls and
real integration readiness remain separate work. A reachable deployed mock is not a capital pilot.
