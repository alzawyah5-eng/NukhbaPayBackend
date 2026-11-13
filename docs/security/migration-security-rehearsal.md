# Registered migration security and disposable rehearsal

13 November 2026. Scope: local source registration and disposable acceptance, ADRs 0023 and 0024. No approved persistent database, Auth0 login or privileged staff executor is created.

## Source and recovery controls

Git remains unavailable. The reviewed session and pre-correction checkpoints are preserved. The pre-registration archive is `recovery-checkpoints/before-migration-006-registration-20261113T071118818Z.zip` in the enclosing workspace. It contains 250 reviewed source files, excludes environment/certificate/key/database/log/dependency/build material, and has SHA-256 `aa13e92f84cc0dfa76e4e13919990756cb91fbd11a911e8218c414871a895a29`. Its manifest verifies every archived byte. No existing checkpoint is overwritten.

Frozen migration hashes:

| Source | SHA-256 |
| --- | --- |
| 004_staff_identity_foundation.ts | ebb5b282d9afad7dc5ef7b8221bd7b34942c1cbb53757e73832987b36975b312 |
| 005_staff_workflow_persistence.ts | 41910d1aa060a1971c8e33e123b0e350d884ffede490cb71b52dc00838779390 |
| 006_staff_server_sessions.ts | 035fa9bb914de3cb4094f8e98ce2fa9164dc4e6b5e11b40ddfdd55707bc98eed |

The reviewed deployment manifest lists all ten exact migration inputs. All six numbered migration hashes are also pinned independently by the runner. Source changes, including a coordinated 006-and-manifest edit, fail before any connection; the runner never updates the manifest. The registered profile/status are `REGISTERED_MIGRATIONS_V1` and `006_REGISTERED_LOCAL_SOURCE_HISTORY`. This local manifest is not an external signature or a replacement for controlled release ownership.

## Safe commands and targets

Run from the existing repository with pinned pnpm and installed dependencies; no install or dependency upgrade is needed:

```text
pnpm.cmd db:verify:sources
pnpm.cmd db:test:combined
pnpm.cmd staff:sessions:test:integration
```

The first command reads source only. Integration commands require the existing synthetic process-local database test configuration and an explicit absolute `NUKHBAPAY_PG_TEST_BIN` directory containing pg_dump.exe/pg_restore.exe. Do not paste credentials or full URLs into logs/chat. Existing TLS tests use the existing encrypted certificate through the reviewed launcher, with no certificate installation or trust-store change.

Normal `db:migrate` now stages registered 001–006 through the reviewed runner. It rejects development, remote/shared databases, non-canonical workload roles, unsafe role flags/memberships and incorrect actual targets. There is no candidate-mode switch. Its temporary directory is verified as task-created and removed after execution.

Fixture maintenance verifies the local maintenance connection, creates a fresh random owned b3b2/b3b3 database, revokes PUBLIC database access and grants only required connections. Destructive operations are confined to that exact created target and guarded cleanup. Historical negative tests intentionally create their distinct wrong-name disposable fixture to test frozen 005 rejection; that fixture receives no new validity grant or activation safeguards. It cannot exercise a real authentication mode.

## Combined sequence

1. Verify source bytes and role configuration before connecting.
2. Verify the actual loopback host/effective port, random database, isolated migration role, owner and absence of inherited memberships.
3. Hold the installed node-pg-migrate advisory lock on the same owner connection. Run the read-only default-ACL/schema preflight; unreviewed grants require investigation rather than silent repair.
4. Stage the six registered files plus the reviewed 006 SQL, authority safeguards and manifest. SQL/JSON sidecars are excluded from migration discovery.
5. Run the migrator with order checks and a single transaction. Registered 006 verifies exact 001–005 history, installs additive validity/version safeguards and session schema, and records its history only in the verified disposable target.
6. Verify all six ordered history rows; replay must be a history no-op. Check 16 ENABLE/FORCE-RLS tables, exact least-privilege projections, non-executable mutation gates, immutable evidence and owner-only new trigger functions.
7. Exercise failure/replay/concurrency/session/authority cases and verified backup/restore. Close pools/listeners/clients before dropping only the created disposable databases and generated roles.

PostgreSQL applies [default privileges separately to schemas, tables and functions](https://www.postgresql.org/docs/17/sql-alterdefaultprivileges.html). Preflight rejects unknown global/schema table/function/sequence grants and schema CREATE/USAGE defaults. Registered 006 also checks the resulting namespace ACL, so revoking a few known workloads cannot conceal an unrelated grantee.

## Exact authority contract

Only the IAM reader gains SELECT(tokens_valid_after); it still has no contact, staff mutation or grant-write rights. The workflow backend's 27 IAM columns and all existing catalogue grants are unchanged. The session backend remains 27 SELECT and 23 INSERT column grants on two separate FORCE-RLS tables, with no IAM access, UPDATE/DELETE/DDL/function execution or role membership.

Tokens at or before a non-null cutoff cannot resolve an authorized identity. Only runtime-registered verifier evidence supplies issuance time. Missing/invalid cutoff, copied identity objects and unavailable dependencies deny. Session freshness uses this same resolution path.

The additive invoker triggers advance staff version/cutoff on status, identity, membership and role-grant changes. Membership status/manual version and tenant-grant changes also advance membership version. Emergency advancement is an already-authorized database mutation of version by one or a forward cutoff; it never becomes a public application command. Versions/cutoffs cannot be reset. Canonical identity/scope bindings and revoked grants cannot be repurposed; fixed permission data cannot be activated by DML. Cosmetic staff edits do not invalidate authority.

Suspension and reinstatement completed between reads still leave higher versions and a later cutoff. A stale token cannot simply establish another actor and recover the old session. Reauthentication must provide verified issuance strictly after the cutoff. Observed authority changes revoke with durable AUTHORITY_CHANGED; ordinary LOGOUT remains distinct. Old rotated/logout-cookie replay cannot poison a valid sibling session.

These triggers do not authorize changes, accept approvals, construct staff, or replace an atomic privileged executor. No workload gets a mutation privilege. Fixture-only maintenance writes prove the contract. A future approved executor must independently prove actor/MFA/approvals, obtain ordered locks, revalidate authority, and commit mutation/audit/receipt/outbox in one transaction. It remains blocked.

## Recovery acceptance and limits

The acceptance deliberately fails 006 after earlier DDL and verifies that the same disposable target has no committed IAM/catalogue data or migration rows. Removing only the deliberately conflicting empty fixture schema permits a clean forward retry; no migration down is used. The migration runner may leave an empty history table created before its transaction; sequence gaps are not success evidence.

A complete synthetic custom archive is restored with [pg_restore --single-transaction --exit-on-error](https://www.postgresql.org/docs/17/app-pgrestore.html) into another fresh verified disposable database, preserving source role owners/grants, ordered history, SHA-256 session-event evidence, immutability and FORCE RLS. A conflicting restore is rolled back without partial restored schemas. Dumps exist only in guarded temporary directories and are removed after acceptance. Maintenance credentials are used only for these explicitly verified fixture backup/restore operations, never application requests.

The tests do not establish cross-cluster role provisioning, a real backup vault, operational RPO/RTO, media loss or failover. Windows has no Unix-socket listener in this setup: the NULL connection-metadata branch of the actual guard is executed in PostgreSQL using substituted environment inputs; actual Unix transport is not exercised. No test is skipped to hide that distinction.

## Pending activation decisions

006 is registered in source history by ADR 0024 after review of wrapper/sidecar placement, manifest digest, target gates, one-column reader grant, additional trigger objects and tested restore behavior. Applying it to development/shared targets and provisioning persistent credentials remain separately gated. Applying 004 alone without the additive safeguards does not establish the full invalidation contract.

Real Auth0 login/callback and browser-trusted HTTPS are still absent. Exact issuer/client/human-token compatibility, approved persistent IAM/session targets, staff bootstrap, genuine provider MFA/freshness/recovery evidence, secret/monitoring ownership, retention/HA/refresh and operational recovery remain pending. Synthetic assurance remains not-established; accepted approvals, APPLY, reserved permissions and financial execution stay disabled. See the management approval register. Stop after this increment.

## Preserved correction-increment inventory

33 modified and 9 created maintained repository files. No paths are renamed or deleted. Generated build outputs are excluded. Verification helpers/evidence stay in the enclosing recovery-checkpoints directory.

### Modified

- `ARCHITECTURE.md`
- `README.md`
- `apps/api/package.json`
- `apps/api/src/modules/identity/README.md`
- `apps/api/test/fixtures/disposable-iam-database.ts`
- `apps/api/test/identity-guards.spec.ts`
- `apps/api/test/local-api-runtime.spec.ts`
- `apps/api/test/staff-sessions.integration.ts`
- `docs/build-sequence.md`
- `docs/data-model.md`
- `docs/governance/pending-management-approvals.md`
- `docs/progress.md`
- `docs/security/requirements.md`
- `docs/security/staff-server-sessions.md`
- `docs/verification.md`
- `package.json`
- `packages/application/src/identity/staff-access.ts`
- `packages/application/src/identity/staff-session.ts`
- `packages/application/test/identity-authorization.test.ts`
- `packages/application/test/staff-approval-intake.test.ts`
- `packages/application/test/staff-lifecycle.test.ts`
- `packages/application/test/staff-session.test.ts`
- `packages/application/test/verified-staff-self.test.ts`
- `packages/database/README.md`
- `packages/database/migrations/README.md`
- `packages/database/package.json`
- `packages/database/pending-migrations/006_staff_server_sessions.sql`
- `packages/database/src/durable-staff-request-store.ts`
- `packages/database/src/identity-runtime.ts`
- `packages/database/src/repositories/README.md`
- `packages/database/src/repositories/staff-identity-repository.ts`
- `packages/database/src/staff-session-store.ts`
- `packages/database/test/identity-integration.spec.ts`

### Created

- `apps/api/test/migration006.integration.ts`
- `docs/adr/0023-reviewed-migration-security-and-authority-invalidation.md`
- `docs/security/migration-security-rehearsal.md`
- `packages/database/migration-manifest.json`
- `packages/database/pending-migrations/004_identity_activation_safeguards.sql`
- `packages/database/pending-migrations/004_identity_default_acl_preflight.sql`
- `packages/database/pending-migrations/006_staff_server_sessions.ts` (historical pre-registration path)
- `packages/database/roles/grant_identity_validity_reader.sql`
- `scripts/rehearse-reviewed-migrations.mjs`

### Workspace verification helpers

- `recovery-checkpoints/verify-migration-security.mjs`
- `recovery-checkpoints/verify-migration-security.ps1`
- `recovery-checkpoints/check-migration-security.mjs`

All pre-existing helpers, source archives, manifests and test logs are preserved. New timestamped verification/cleanup/security evidence and final change manifests are additive. No environment files, private certificate/key material or database dump are checkpointed.

### Registration increment

The bounded registration moves the wrapper from the historical pending path to `packages/database/migrations/006_staff_server_sessions.ts`, updates `packages/database/migration-manifest.json`, `scripts/rehearse-reviewed-migrations.mjs` and `apps/api/test/migration006.integration.ts`, adds ADR 0024, and updates current documentation. The SQL sidecars, role recipes, frozen 004/005 sources, lockfile and runtime authorization code do not change.
