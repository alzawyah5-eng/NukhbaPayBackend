# Synthetic catalog import

`importSyntheticCatalogProvider` fetches one complete synthetic provider snapshot and delegates it to the narrow `CatalogImportRepository` port. `readSyntheticProviderSnapshot` exposes an internal read operation. The PostgreSQL repository is implemented in `packages/database`; no customer-facing route is registered.

From the repository root, run:

```powershell
$env:NUKHBAPAY_TENANT_ID = '<existing tenant UUID>'
$env:NUKHBAPAY_PROVIDER_ACCOUNT_ID = '<existing synthetic-provider-a account UUID>'
pnpm.cmd catalog:import:synthetic
```

The command uses the configured `DB_IMPORT_URL` identity and requires `DB_MIGRATION_URL`, `DB_RUNTIME_URL`, `DB_IMPORT_URL`, `DB_RUNTIME_ROLE`, and `DB_IMPORT_ROLE`. It imports the fixed `synthetic-provider-a` complete snapshot under source version `v1`. It does not create tenant/account records, products, or mappings: the provider account, canonical product, and approved provider-SKU mapping must already exist. Missing or non-approved mappings are rejected rather than approved from provider input.

The command is local-only and accepts internal IDs from the operator's process environment, not request headers. It is not authentication or tenant authorization for an external caller. No delta feed, scheduled worker, live provider, pricing publication, quote, order, or payment behavior is included.
