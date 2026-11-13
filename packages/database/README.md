# Database package

Brick 4A adds a pending, unregistered `007_catalogue_publication_drafts.sql` proposal and a disposable-only draft writer recipe. The four proposed tables contain append-only DRAFT/NOT_AUTHORIZED evidence under FORCE RLS. The adapter accepts only application-generated candidates and has no activation function. Do not register or apply 007 to `nukhabapay_dev`; ADR 0026 and the publication integration test define the reviewed local boundary.

13 November 2026: migration 006 is registered source. Use the reviewed manifest/preflight path in `scripts/rehearse-reviewed-migrations.mjs`; normal migrate is restricted to verified random disposable b3b2/b3b3 targets and executes registered 001–006 in one transaction. It cannot target development. The registered wrapper checks exact 001–005 history and exact unchanged authority/session sidecars. See `../../docs/security/migration-security-rehearsal.md`. Raw historical CLI invocations in tests exercise frozen behavior and are not an operational deployment procedure.

Local lifecycle follow-on: the IAM runtime now returns internal `checkReadiness()` alongside restricted repositories and idempotent `close()`. It checks role identity/flags/ownership, required column access without rows, audit-writer rights and forced RLS, returning a boolean only. It writes no audit/fixture data and never migrates. Closed pools return false; lost connections may reconnect. This does not continuously audit all ACLs or verify migration history. The API consumes it through its explicitly composed synthetic lifecycle; see ADR 0010 and verification.

The package owns the PostgreSQL catalog schema, migrations, role grants, and narrow repository implementations. Application orchestration lives in `packages/application`; financial-domain code has no database dependency.

The local synthetic import operation accepts complete snapshots only. It requires a pre-existing canonical product and approved tenant/provider-SKU mapping, writes snapshot and offers in one transaction, and treats identical source identity/content as an idempotent replay. Changed content under the same identity is a conflict. Imports do not delete or replace historical snapshots. Delta feeds, a mapping-approval workflow, live providers, and a customer-facing catalog API are not implemented.

Configure distinct migration, read-only runtime, import, identity-reader, and identity-writer database URLs in the local environment, plus `DB_TEST_ADMIN_URL` for disposable PostgreSQL acceptance tests. The tests create uniquely named databases on the loopback PostgreSQL instance and drop only the databases they successfully created; they do not reset or reuse `nukhabapay_dev`. Never place credentials in source control or print connection URLs.

Run `pnpm.cmd --filter @nukhbapay/database test` and `pnpm.cmd --filter @nukhbapay/database test:integration` from the repository root with the required local role configuration. The integration suite must report zero skipped PostgreSQL tests to count as acceptance evidence. The import role has SELECT access, INSERT on snapshots/offers, and column-limited snapshot completion updates; it has no DELETE, product/mapping writes, DDL, or role-management grants. The runtime role is read-only.

Amounts are stored as integer minor units and read as `bigint`; do not coerce financial amounts into floating-point values.

## Brick 3B-2 IAM runtime

Use the compiled `@nukhbapay/database/identity-runtime` entry point for explicit `parseIdentityRuntimeConfiguration` / `createIdentityRuntime`. Unlike the legacy catalogue/test configuration parser, it reads no migration, importer, catalogue runtime or administrator credentials. It does not migrate or provision anything and is not called by API bootstrap.

Required inputs are `DB_IDENTITY_READER_URL` and `DB_IDENTITY_WRITER_URL`. Their roles must be exactly `nukhabapay_identity_reader` / `nukhabapay_identity_writer`, their loopback host/effective port/database must match, and system database names and URL query/fragment options reject. Optional role settings, if supplied, must match these names. Arbitrary role names and privileged identities cannot be substituted. Password values are required by the local URL parser but loopback trust authentication remains unchanged and is not production credential evidence.

| Optional setting | Default | Bounds |
| --- | --- | --- |
| `DB_IDENTITY_POOL_MAX` | 3 | 1–10; audit writer remains capped at 2 |
| `DB_IDENTITY_CONNECTION_TIMEOUT_MS` | 3000 | 100–10000 |
| `DB_IDENTITY_QUERY_TIMEOUT_MS` | 6000 | 200–15000 |
| `DB_IDENTITY_STATEMENT_TIMEOUT_MS` | 4000 | 100–10000 and strictly less than query timeout |

The configuration hides URLs from JSON and ordinary inspection; never deliberately print its secret properties or pools. Initialization verifies actual login flags, memberships, schema-CREATE and database ownership; it returns only restricted repository/audit ports and an idempotent close function. Initialization errors are sanitized without a retained cause or connection URL. Existing per-column grants and forced RLS remain unchanged and are checked in acceptance, not claimed as a continuous startup ACL monitor.

The API's separate `pnpm.cmd --filter @nukhbapay/api test:identity:integration` command builds dependencies and tests verified identity through this runtime on a generated disposable database. It requires explicit test-admin/migrator/catalogue/IAM fixture configuration for test lifecycle only; those credentials are not passed to IAM runtime initialization. It has no skipped-test fallback. See ADR 0008 and `docs/verification.md`.

## Brick 3A identity foundation

Migration `004_staff_identity_foundation.ts` adds staff users, exact external
identity bindings, memberships, fixed scoped role/permission definitions,
separate platform and tenant grants, and append-only security-audit events.
It does not add authentication, external account provisioning, staff/grant
management workflows, or HTTP business endpoints. Only the internal
`staff.self.read` permission is active in 3A; later-phase business permissions
remain reserved and deny access.

Provision only the two isolated local login roles with the checked-in script,
run against the existing local PostgreSQL maintenance database by an
authorized administrator:

```powershell
psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d postgres -f packages\database\roles\provision_identity_roles.sql
```

The script creates or validates `nukhabapay_identity_reader` and
`nukhabapay_identity_writer` as non-inheriting, non-superuser logins with no
database/role creation or `BYPASSRLS` capability and no role memberships. It
does not set passwords. The reader has column-limited identity/membership/
grant reads and tenant-scoped RLS; it cannot read staff contact email or the
permission-definition tables. The writer has INSERT on the bounded audit table
only. Neither owns schema/tables or has DDL. Keep these workload identities
distinct from migration, catalog runtime, and importer roles.

The current local PostgreSQL loopback configuration uses trust authentication;
the test URLs therefore use non-secret placeholder passwords to satisfy the
local URL parser. Do not copy those test values into a password-authenticated
deployment. Configure and rotate separate credentials using the deployment's
approved secret-management and PostgreSQL authentication procedures.

Set `DB_IDENTITY_READER_URL` and `DB_IDENTITY_WRITER_URL` for the same local
database as the catalog roles. The test harness also requires `DB_TEST_ADMIN_URL`
to point to the loopback `postgres` maintenance database; it creates random
disposable databases, runs fresh and repeated migrations, and drops only those
databases. Synthetic seed records are inserted by that disposable test
administrator because the schema owner is subject to `FORCE ROW LEVEL
SECURITY`; application reads/writes are tested through the actual restricted
login roles. The migration and IAM acceptance tests do not alter
`nukhabapay_dev`.

RLS is enabled and forced for memberships, tenant grants, and tenant-associated
audit reads/writes. The trusted application sets the requested tenant context
transaction-locally on the same connection. This limits accidental
cross-tenant reads but is not a security boundary against a compromised
trusted application or leaked reader credential. No tenant-facing route uses
this foundation yet.
