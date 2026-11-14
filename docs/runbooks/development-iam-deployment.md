# Development IAM deployment preparation

Track A operator review: [SCRAM recovery, authentication matrix and restricted activation contract](database-security-operator-review.md).
The source-only preparation wrapper is `node scripts/prepare-persistent-iam-activation.mjs --prepare`;
it has no execution mode and does not resolve the persistent-source transition gate.

Status: **IMPLEMENTED READINESS CONTROLS — NO-GO for persistent migration**. Updated 13 November 2026 after source-only safeguards, read-only target inspection and disposable acceptance. This document authorizes no database, role, credential, Auth0, certificate or staff-data change.

ADR 0025 adds the disabled-by-default `persistent-development-preflight-v1` profile. The only exposed command is `pnpm.cmd db:preflight:persistent-development`; there is deliberately no persistent apply command. The profile verifies the manifest before connecting and then verifies exact target identity, owner, role flags/memberships, 001–003 history, database/schema ACLs, absent IAM/session objects, quiescence and SCRAM password enforcement. It rejects test-admin/disposable settings and production-like environment labels. Registered 004–006 and the disposable runner are byte-for-byte unchanged.

## Target recommendation

Use the existing `nukhabapay_dev` database for a future controlled IAM deployment, after the blockers in this document are resolved. Do not create a separately authoritative IAM database.

The existing database is the correct architectural boundary because:

- its recorded history is exactly `001_catalog`, `002_import_role_privileges`, `003_import_role_read_access`;
- migration 004 binds `staff_memberships.tenant_id` directly to the existing `nukhabapay.tenants` table;
- migrations 005 and 006 bind workflow/session records to the same staff, membership and tenant rows;
- PostgreSQL cannot enforce these foreign keys across databases;
- the catalogue configuration requires migration/runtime/import roles to use one database, and existing full-stack tests assume one canonical tenant authority;
- a second database would require a duplicate 001–003 foundation, tenant synchronization, two backup/recovery paths and explicit cross-database consistency handling that does not exist.

The current development database is approximately 8 MB and the read-only inspection found zero tenants, products, provider accounts, mappings, snapshots and offers. That reduces current data-conversion risk, but it does not remove the requirement to quiesce writers and prove restore recovery: the database is the canonical catalogue target and could contain data by the execution date.

## Current hard blockers

Persistent migration must not be attempted with the current commands or sources:

1. The new persistent profile is preflight-only. `scripts/rehearse-reviewed-migrations.mjs` correctly remains limited to generated `nukhabapay_b3b2_*` / `nukhabapay_b3b3_*` disposable targets.
2. `004_identity_default_acl_preflight.sql` rejects `nukhabapay_dev`.
3. registered migration 005 rejects every non-disposable database name.
4. the reviewed migration 006 SQL sidecar accepts only generated b3b2/b3b3 targets.
5. `grant_staff_session_backend.sql` and `createStaffSessionStore` also reject persistent database and role names.
6. a fail-closed persistent-development session parser exists, but no deployed dependency-injection registration exists; the portal keeps sessions disabled.
7. loopback host authentication is currently `trust` for ordinary and replication connections. A URL password is therefore not evidence that PostgreSQL authenticated the workload credential.
8. the existing five roles have the required restricted flags and no memberships, but only `nukhabapay_runtime` currently has recorded role-level timeout/read-only settings. Persistent credential, timeout and secret ownership need explicit review.
9. `nukhabapay_identity_reader`, `nukhabapay_identity_writer` and `nukhabapay_importer` currently lack database CONNECT and schema USAGE on development. The importer retains restricted table grants, but they are not usable without those enclosing privileges. Migration 004 grants IAM schema/table projections but does not grant database CONNECT.
10. `.env.example` has been corrected to remove the duplicate importer key and identify the disposable admin as test-only. It remains an example, not an activation or secret source.

Resolving these gates requires a separately authorized source change and disposable restored-clone acceptance. Do not fake migration history, rename a b3b database into a persistent target, bypass a guard, edit checksums manually or treat a disposable name as durable storage.

## Migration and object dependencies

The only valid persistent sequence is:

1. existing 001 catalogue foundation;
2. existing 002 importer privileges;
3. existing 003 importer read access;
4. 004 staff identities, memberships, fixed roles/permissions/grants and security audit;
5. 005 disabled/non-authorized staff workflow evidence;
6. 006 authority invalidation safeguards and server-session evidence.

004–006 must be applied in order in one migration transaction under the node-pg-migrate advisory lock. The 004 default-ACL/schema preflight must execute under that same owner connection and lock. 006 independently requires exact 001–005 history and exact manifest-verified SQL sidecars. Automatic down and fake history remain prohibited.

Current source hashes:

| Source | SHA-256 |
| --- | --- |
| 004 | `ebb5b282d9afad7dc5ef7b8221bd7b34942c1cbb53757e73832987b36975b312` |
| 005 | `41910d1aa060a1971c8e33e123b0e350d884ffede490cb71b52dc00838779390` |
| 006 | `035fa9bb914de3cb4094f8e98ce2fa9164dc4e6b5e11b40ddfdd55707bc98eed` |
| Manifest | `7ae4f427e640360813edf4b3007f1c2a1a02b74b384e76558dd1358cb4359666` |

Any approved persistent-target implementation that changes a registered byte must produce a new reviewed manifest/checksum record and repeat full combined acceptance. The preserved hashes above must remain historical evidence; they must not be silently overwritten.

## Role and configuration map

### Existing roles

| Role | Use | Required boundary |
| --- | --- | --- |
| `nukhabapay_migrator` | Migration/preflight owner only | LOGIN; no superuser, createdb, createrole, inherit, bypass-RLS or memberships; owns the database/schema objects; never used by application runtime |
| `nukhabapay_runtime` | Read-only catalogue runtime | Existing catalogue SELECT only; no IAM/workflow/session access |
| `nukhabapay_importer` | Restricted catalogue import | Existing catalogue import/read columns only; no IAM/workflow/session access. Development CONNECT/schema USAGE are currently absent and require separate catalogue-owner review. |
| `nukhabapay_identity_reader` | IAM resolution/freshness | Exact column projections including `tokens_valid_after`; tenant RLS; no contact email, mutation or session access. Requires approved database CONNECT in addition to migration 004 grants. |
| `nukhabapay_identity_writer` | Authorization audit append | INSERT only on the bounded security-audit table; no lifecycle-success fabrication or session access. Requires approved database CONNECT in addition to migration 004 grants. |

Do not provision workflow backend/reader roles for this deployment. Migration 005 may create its disabled evidence schema without activating a runtime credential, accepted approval or APPLY.

### Proposed required session role — not implemented or approved

A persistent session runtime eventually needs one distinct canonical restricted login, proposed as `nukhabapay_session_backend`. It must have LOGIN and no superuser, createdb, createrole, inherit, bypass-RLS, memberships, ownership, CREATE or TEMP rights. Its only object rights are the reviewed 27 SELECT-column and 23 INSERT-column session projections plus CONNECT and session-schema USAGE. It must have no IAM/catalogue/workflow access, table-wide grants, UPDATE/DELETE, DDL or function execution.

The current code accepts only ephemeral `nukh_session_<20-hex>` roles and disposable databases. The proposed name and persistent grant recipe require approval and code/test changes before provisioning.

### Existing environment variables

| Purpose | Variables |
| --- | --- |
| Migration | `DB_MIGRATION_URL`; canonical `DB_RUNTIME_ROLE`, `DB_IMPORT_ROLE`, `DB_IDENTITY_READER_ROLE`, `DB_IDENTITY_WRITER_ROLE` are also verified before migration |
| Catalogue runtime/import | `DB_RUNTIME_URL`, `DB_IMPORT_URL`, `DB_RUNTIME_ROLE`, `DB_IMPORT_ROLE`, `DB_POOL_MAX`, `DB_CONNECTION_TIMEOUT_MS`, `DB_QUERY_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS` |
| IAM runtime | `DB_IDENTITY_READER_URL`, `DB_IDENTITY_WRITER_URL`, optional exact role variables, `DB_IDENTITY_POOL_MAX`, `DB_IDENTITY_CONNECTION_TIMEOUT_MS`, `DB_IDENTITY_QUERY_TIMEOUT_MS`, `DB_IDENTITY_STATEMENT_TIMEOUT_MS` |
| Persistent preflight only | `NUKHBAPAY_DB_DEPLOYMENT_PROFILE=persistent-development-preflight-v1`, exact `NUKHBAPAY_ENVIRONMENT`, `NUKHBAPAY_ENV`, `NODE_ENV`, approval ID, expected database OID/system identifier, manifest-bound confirmation and reviewed SCRAM/HBA attestation. Values are process-only and no apply mode exists. |
| Disposable tests only | `DB_TEST_ADMIN_URL`, `NUKHBAPAY_PG_TEST_BIN` — never application or persistent migration credentials |

Connection values must come from the approved local secret mechanism, never source, logs, command history, chat or a checkpoint. Migration, catalogue, importer, IAM reader, IAM writer and session credentials remain distinct.

Exact persistent preflight process contract:

| Variable | Required value/evidence |
| --- | --- |
| `NUKHBAPAY_DB_DEPLOYMENT_PROFILE` | `persistent-development-preflight-v1` |
| `NUKHBAPAY_ENVIRONMENT` / `NUKHBAPAY_ENV` / `NODE_ENV` | `development` / `local` / `development` |
| `DB_MIGRATION_URL` | Secret-injected exact migrator URL for literal loopback/5432 and `nukhabapay_dev`; no query/fragment; never printed |
| `DB_RUNTIME_ROLE` / `DB_IMPORT_ROLE` | Existing canonical catalogue runtime/importer role names |
| `DB_IDENTITY_READER_ROLE` / `DB_IDENTITY_WRITER_ROLE` | Existing canonical restricted IAM role names |
| `NUKHBAPAY_DB_DEPLOYMENT_APPROVAL_ID` | Named approved change identifier matching the bounded format; not a secret and not self-authorization |
| `NUKHBAPAY_DB_EXPECTED_DATABASE_OID` | Fresh read-only DBA evidence for the exact target |
| `NUKHBAPAY_DB_EXPECTED_SYSTEM_IDENTIFIER` | Fresh read-only DBA evidence for the exact PostgreSQL cluster |
| `NUKHBAPAY_DB_DEPLOYMENT_CONFIRMATION` | `PREFLIGHT_ONLY:nukhabapay_dev:<exact current migration-manifest SHA-256>` |
| `NUKHBAPAY_DB_SCRAM_HBA_ATTESTATION` | `SCRAM_SHA_256_LOOPBACK:<same approval ID>` after independent HBA review; the wrong-password probe still verifies enforcement |

`DB_TEST_ADMIN_URL` and `NUKHBAPAY_PG_TEST_BIN` must be absent. No `APPLY` confirmation string is accepted.

### Required SCRAM-SHA-256 conversion — not executed

The current loopback `trust` rules are a hard stop. A PostgreSQL administrator must perform the following in a separately approved maintenance window; this repository increment does not edit `pg_hba.conf`, set passwords, reload or restart PostgreSQL.

1. Back up the active HBA/config files and record their hashes and PostgreSQL service identity. Confirm `SHOW hba_file`, `SHOW password_encryption` and the ordered effective rules using `pg_hba_file_rules` from an authorized administrator connection. The migrator is intentionally unable to read that view.
2. Set `password_encryption = 'scram-sha-256'` before resetting each project role to a distinct secret delivered through the approved secret manager. Never reuse or pass a password on a command line.
3. Place database-and-role-specific loopback rules before any broad loopback rule. The reviewed intent is `host nukhabapay_dev <exact-project-role-list> 127.0.0.1/32 scram-sha-256` and, only if IPv6 is required and tested, the equivalent `::1/128` rule. Do not use `trust`, `password`, broad database/user wildcards or remote CIDRs for project roles. Replication rules require separate DBA scope and must not be inferred from application access.
4. Validate syntax/order through `pg_hba_file_rules`, then use the platform-supported configuration reload. PostgreSQL on Windows applies HBA changes to subsequent new connections; still follow the approved service procedure and do not assume an existing pool was reauthenticated.
5. Prove each exact role succeeds only with its own correct secret and exact database, then prove empty, incorrect and another role's secret fail with authentication error. Confirm remote/non-loopback attempts remain unavailable.
6. Run `pnpm.cmd db:preflight:persistent-development`. The preflight independently connects with an incorrect password and accepts only SQLSTATE `28P01`; the present trust configuration therefore fails even if an operator supplies the attestation string.

The ordered HBA evidence, role-secret rotation record and negative authentication results must be reviewed without copying secrets or password verifiers into project artifacts.

### Persistent session environment contract — parsed but not activated

`NUKHBAPAY_STAFF_SESSION_MODE` remains `disabled`. The isolated parser reserves `DB_STAFF_SESSION_URL`, `DB_STAFF_SESSION_ROLE`, `DB_STAFF_SESSION_EXPECTED_DATABASE_OID`, `DB_STAFF_SESSION_EXPECTED_SYSTEM_IDENTIFIER`, `DB_STAFF_SESSION_POOL_MAX`, `DB_STAFF_SESSION_CONNECTION_TIMEOUT_MS`, `DB_STAFF_SESSION_QUERY_TIMEOUT_MS` and `DB_STAFF_SESSION_STATEMENT_TIMEOUT_MS`. Persistent-development parsing requires exact local/development labels, literal loopback/5432, `nukhabapay_dev`, `nukhabapay_session_backend`, a credential, target identity and bounded timeouts. The URL is non-enumerable/redacted. Runtime registration and grants remain unimplemented, so setting these values does not authorize activation.

## Dependency-ordered development activation checklist

This is a preparation checklist, not an execution authorization. Persistent
activation remains **NOT VERIFIED / NOT AUTHORIZED**; all operational checklist
items are pending. Prepared 14 November 2026. Record
sanitized evidence and named approvals in the approved change record; never put
credentials, staff PII, database URLs, or password verifiers in this repository.
Any failed, stale, ambiguous, or unavailable check is a stop condition.

### Preparation — source and disposable-only readiness (engineering; no persistent writes)

- [ ] Preserve the frozen 004–006 sources and historical manifest hashes. Verify
  with `pnpm.cmd db:verify:sources`; do not edit migration history or bypass a
  target guard.
- [ ] Implement and review a new immutable persistent-target activation source
  transition. Bind its reviewed source/manifest hashes, exact database OID and
  PostgreSQL system identifier, approval, backup hash, and restored-clone
  acceptance. Keep the existing disposable runner and migrations unchanged.
- [ ] Implement and review the persistent session-role grant recipe and
  connection adapter. Require the exact approved target, role, OID and system
  identifier; retain the exact SELECT/INSERT column envelope, FORCE RLS, audit
  append-only behavior, and deny all IAM/catalogue/workflow access.
- [ ] Add trusted server composition for the restricted IAM reader, audit
  writer, tenant-bound `TrustedStaffActorBoundary`, session lifecycle/store,
  and `Auth0Login`. The CLI must remain disabled by default; partial or
  contradictory configuration must fail startup. Never accept actors,
  issuer, subject, tenant, roles, or permissions from browser input.
- [ ] Exercise the new source transition, grants, adapter, and composition on
  fresh disposable databases and a fresh restore of the development backup.
  Include negative privilege, tenant-isolation, audit-failure, session-failure,
  config, and browser/server-boundary assertions. Do not use the persistent
  target for engineering tests.
- [ ] Review and freeze the new source/manifest/checksum set before any
  operational change. Stop if disposable or restored-clone acceptance is not
  complete.

### Stage A — change authority, quiescence, and recoverability (operations)

- [ ] Obtain a named DBA, change approver, secret custodian, and recovery owner;
  approve the exact target, maintenance window, permitted changes, retention,
  residency, monitoring, RPO/RTO, and rollback/recovery decision path.
- [ ] Stop and verify all project writers are quiescent. Retain and test an
  independent PostgreSQL administrator recovery connection.
- [ ] Back up PostgreSQL configuration/HBA files, included-file inventory,
  permissions, service identity, and hashes to the approved restricted vault.
- [ ] Take the custom-format `nukhabapay_dev` backup and non-secret globals
  backup. Record archive hashes and restore the database to a new, empty,
  isolated rehearsal target. A successful archive listing alone is not
  acceptance.
- [ ] On the restore, verify catalogue row digests/counts, object definitions,
  owners, ACLs, schema/default ACLs, sequences, migration history, and
  catalogue regression behavior. Rehearse the reviewed 004–006 source
  transition there in one transaction; verify rollback and postchecks. Do not
  restore over or rename the live target.

### Stage B — SCRAM and restricted role authentication (DBA; separately approved)

- [ ] Confirm deployed PostgreSQL/client compatibility and review every ordered
  HBA rule and include. Set SCRAM password encryption for the approved
  password-setting session, rotate each project role to a distinct
  secret-manager-delivered credential, and install exact database/role
  loopback SCRAM rules before broader rules. Review IPv6 separately.
- [ ] Verify role attributes, memberships, owners, connection limits, timeouts,
  and secret custody. Application roles must not be superuser, createdb,
  createrole, inherit, bypass-RLS, owners, or members of other roles.
- [ ] Validate HBA syntax/order and fresh connections. Run the sanitized
  per-role matrix from the operator review: own credential succeeds only where
  approved; wrong and another role's credentials fail with `28P01`; no
  password never succeeds; remote/IPv6 paths match separately approved policy.
  Keep the recovery connection open throughout.
- [ ] Run the connection-free migration-source verification and then the
  exact-target **read-only** persistent preflight with current approval,
  database OID/system identifier, manifest confirmation, and SCRAM attestation.
  Require its wrong-password probe to observe `28P01`. Preflight is not
  migration authorization.

### Stage C — persistent IAM migration (separate explicit execution approval)

- [ ] Reconfirm quiescence, backup hash, restore acceptance, target identity,
  source hashes, exact 001–003 history, role/ACL/default-ACL baseline, and no
  unexpected connections or prepared transactions immediately before apply.
- [ ] Obtain separate written approval for the exact persistent migration
  transaction. Use only the reviewed activation source, as
  `nukhabapay_migrator`, on the approved target. Acquire the migration advisory
  lock, run the preflight on that same connection, and apply 004, 005, and 006
  in order in one transaction. No application, session, IAM, importer, or
  administrator runtime role may execute migrations.
- [ ] If any assertion fails or commit acknowledgement is uncertain, stop.
  Inspect authoritative history/state read-only; never retry blindly or run
  migration down.
- [ ] After a successful commit, obtain separate approval for the narrow IAM
  CONNECT/USAGE grants. Review effective database, schema, table, column,
  sequence, function, PUBLIC, and inherited privileges. Keep the importer
  decision separate.
- [ ] Approve/provision a distinct persistent session login and its reviewed
  persistent grant recipe only after verifying exactly 27 SELECT and 23 INSERT
  column grants, no table-wide or mutation rights, no IAM/catalogue/workflow
  access, and no unsafe role attributes or memberships. The disposable grant
  script is not valid for this target.

### Stage D — IAM, tenant binding, session, and audit acceptance

- [ ] Verify migration history is exactly 001–006; expected tables, constraints,
  triggers, owners, RLS/FORCE RLS and exact ACLs are present; catalogue data and
  existing object ACLs match the approved baseline.
- [ ] Create only a separately approved, non-privileged development test
  identity using the exact issuer/subject. Verify unknown/disabled staff,
  inactive membership, wrong tenant, cross-tenant access, and missing
  `staff.self.read` all deny. Tenant UUID is selected only by trusted server
  composition; verify membership/foreign-key ownership against the canonical
  tenant table.
- [ ] Using synthetic identities, prove session creation, hash-only persistence,
  rotation, expiry, logout/revocation, cold-process behavior, authority-change
  invalidation, and audit atomicity. Inject unavailable IAM, session, and audit
  dependencies and verify no credential or success-shaped response is issued.
  Verify retention, capacity, alerting, restart, backup, and recovery ownership.
- [ ] Keep all application processes stopped until every post-migration
  privilege, tenant, audit, session, and catalogue check passes.

### Stage E — secure runtime composition and Auth0 development configuration

- [ ] Review the server-only runtime configuration contract and implementation.
  The default is disabled; absent/partial settings reject; client secret and
  database URLs are injected through approved process-only secret delivery,
  redacted from inspection/logs, and never bundled into browser assets.
- [ ] Compose only the reviewed IAM reader/audit writer, server-selected tenant,
  exact Auth0 issuer allowlist, persistent session store, and Auth0 BFF. Run
  startup readiness checks against the exact approved target and expected
  database/cluster identity. A failed readiness check prevents listener/login
  startup.
- [ ] Configure the Auth0 **development** application with exact callback and
  logout allowlists, confidential client credentials, exact API audience and
  signed human-principal claim. Verify RS256 token profiles and emission,
  MFA-factor semantics, `amr=mfa`, and fresh `auth_time`; retain no refresh
  token. Never use wildcard callbacks or dynamic tenant/return URLs.
- [ ] Confirm browser-trusted HTTPS, exact listener origin, rate limits,
  monitoring, log redaction, and incident/recovery contacts. No secret is
  supplied in this plan or repository.

### Stage F — controlled OIDC/MFA integration test and activation decision

- [ ] Obtain separate approval for a bounded Auth0 development integration
  window. Use a non-privileged synthetic development identity pre-enrolled to
  the exact issuer/subject and exact tenant. Do not use production staff or
  privileged roles.
- [ ] Test successful login/callback and logout against the approved development
  tenant, plus issuer/audience/signature, state/nonce/PKCE, expiry/replay,
  missing/stale MFA, unknown/disabled identity, wrong tenant, CSRF, session
  rotation/revocation, audit/session persistence failure, and browser/server
  import-boundary rejection. Verify no token or secret reaches the browser,
  logs, or persistent session rows.
- [ ] Stop and return to disabled mode on any mismatch. Record sanitized
  evidence, hashes, exact tested configuration versions, and approvals. A
  separate owner decision is required to enable even controlled development
  login; this checklist itself never enables it.

## Current code-level blockers

| Area | Existing fail-closed boundary | Required reviewed change before activation |
| --- | --- | --- |
| Migration execution | `scripts/rehearse-reviewed-migrations.mjs` accepts only generated disposable targets; `scripts/prepare-persistent-iam-activation.mjs` only prepares a report and has no apply mode. | New immutable, approval-bound persistent source transition and transaction wrapper; do not weaken the existing runner. |
| Migration SQL | 004 default-ACL preflight rejects the development database; 005 and the 006 SQL sidecar require generated disposable names. 004–006 are registered/frozen, not persistent-target ready. | Preserve all frozen bytes/hashes; review/register a new transition and repeat disposable plus restored-backup acceptance. |
| IAM grants | 004 supplies IAM projections but not development database CONNECT; IAM reader/writer currently lack the enclosing CONNECT/USAGE grants. Proposed IAM grant SQL is not registered or authorized. | Separately approved exact IAM CONNECT/USAGE grants and effective-rights verification. |
| Session grants/store | `grant_staff_session_backend.sql` and `createStaffSessionStore` accept only an ephemeral role/database. No persistent session-role grant recipe exists; the store does not bind startup to the parser's expected OID/system identifier. | New persistent-target adapter and least-privilege grant recipe, with independent identity/privilege checks and disposable tests. |
| Runtime composition | `apps/admin-web/src/main.ts` rejects every session mode except `disabled`; it constructs neither IAM actors nor session persistence nor `Auth0Login`. The persistent session parser is not registered in runtime DI. | Reviewed server-only composition/readiness gates; keep default disabled and fail startup on any dependency/configuration failure. |
| Auth0 configuration | A server-only pending development Auth0 parser exists, but the CLI does not call it or select a secret/session adapter. `Auth0Login` remains trusted-composition/test-only. No live tenant claims/MFA behavior has been verified. | Exact server-only config contract, allowlists, provider claim/MFA verification, and separately approved synthetic-identity integration test. |
| Dashboard | React sign-in follows explicit BFF availability; default CLI composition advertises unavailable. A fresh minimal self profile is required for the self-only authenticated view. | Enable only after the runtime and all operational gates pass; no browser-side Auth0 client or token handling. |
| Operations | Current loopback PostgreSQL auth is documented as `trust`; backup/restore, SCRAM, target approvals, retention/HA/recovery and named operational ownership remain unresolved. | Complete and record Stages A–F in this checklist; no code flag substitutes for operational evidence or explicit approval. |

Existing synthetic negative coverage is in `apps/admin-web/test/auth0.spec.ts`,
`apps/admin-web/test/portal.spec.ts`, `packages/application/test/staff-session.test.ts`,
`packages/database/test/staff-session-runtime-config.spec.ts`,
`apps/api/test/identity-guards.spec.ts`, and
`apps/api/test/staff-sessions.integration.ts`. It covers incomplete/disabled
startup, invalid MFA and token profiles, unavailable audit/session persistence,
unknown or inactive identities, tenant mismatch, rotation/revocation, CSRF, and
browser/server boundaries. PostgreSQL integration tests require an explicitly
configured disposable admin and PostgreSQL 17 test binaries; they must not fall
back to the development database.

## Controlled deployment procedure

### Gate 0 — approvals and implementation

Before scheduling migration, approve:

- the exact persistent target (`127.0.0.1:5432`, `nukhabapay_dev`) and named database owner/operator;
- a reviewed persistent-target runner/preflight/005/006/session-store design that does not weaken disposable protections;
- any resulting new hashes and immutable deployment manifest;
- the canonical session role/configuration contract, without activating sessions;
- exact database CONNECT/schema-USAGE provisioning for the IAM roles and a decision on the currently unusable importer envelope, without broad table grants;
- credential custody, PostgreSQL authentication method and separate secret owners;
- backup location, retention, recovery owner, acceptable RPO/RTO and maintenance window;
- audit/session retention and monitoring ownership;
- an explicit statement that Auth0, real staff onboarding, accepted approvals and privileged execution remain disabled.

The resulting implementation must first pass the complete 001–006 suite on (a) a fresh disposable target and (b) a fresh restore of the actual pre-migration development backup. Persistent execution remains NO-GO until both pass.

### Gate 1 — read-only baseline and source preflight

1. Freeze catalogue imports and stop API/BFF/worker processes that can connect to the target.
2. Verify PostgreSQL server/client major compatibility and the literal target host, port, database, current user and database owner.
3. Verify history is exactly 001–003 in order; reject extra, missing or renamed rows.
4. Record table counts, database size and a safe schema/object inventory. Re-read them immediately before migration.
5. Verify the five existing roles have LOGIN, no unsafe flags or memberships, and no application role owns the database/schema/tables.
6. Verify database/schema ACLs and default ACLs match the reviewed baseline. At inspection time only the migrator/runtime could connect, only migrator/runtime had schema access, and owner-created tables defaulted SELECT to catalogue runtime/importer. Treat the absent importer/IAM enclosing privileges as unresolved, not as permission to grant broadly.
7. Verify no unexpected connections, prepared transactions, logical slots, uncommitted migration or idle-in-transaction sessions.
8. Run `pnpm.cmd db:verify:sources` and independently record 004/005/006/manifest hashes.
9. Record the baseline and source evidence. Do not edit authentication or apply migrations during this gate.

Any mismatch is a stop condition. Do not auto-correct ACLs, terminate unrelated connections or proceed with a partial migration.

### Gate 2 — backup, restore, SCRAM, and final read-only preflight

With approved secret delivery outside command arguments, create a custom-format database archive using the PostgreSQL 17 `pg_dump` binary:

```powershell
pg_dump.exe --host 127.0.0.1 --port 5432 --username nukhabapay_migrator --dbname nukhabapay_dev --format custom --file <approved-vault-path> --no-password
pg_restore.exe --list <approved-vault-path>
Get-FileHash -Algorithm SHA256 <approved-vault-path>
```

Separately capture non-secret global role definitions/attributes for recovery, without password hashes:

```powershell
pg_dumpall.exe --host 127.0.0.1 --port 5432 --username <approved-admin-role> --database postgres --globals-only --no-role-passwords --file <approved-vault-path> --no-password
```

The custom archive must be restored into a newly created, empty, verified rehearsal database with all required roles already present:

```powershell
pg_restore.exe --host 127.0.0.1 --port 5432 --username <approved-restore-role> --dbname <fresh-restore-target> --single-transaction --exit-on-error --no-password <approved-vault-path>
```

Validate counts, history, owners, ACLs and catalogue behavior on the restore before rehearsing 004–006 there. Never use `--clean` against the existing database, never restore over a non-empty target, and never treat the globals file as an automatically executable role-replacement script. PostgreSQL documents custom archives as suitable for `pg_restore`; `--single-transaction` makes a restore all-or-nothing and implies exit-on-error. `pg_dumpall --globals-only --no-role-passwords` captures global definitions without role passwords.

Only after the backup has been restored and accepted may the separately
authorized DBA change HBA/password settings and provision/rotate restricted
role credentials, following Stage B of the dependency-ordered checklist and the
operator review. Validate fresh connections and the complete authentication
matrix before continuing. Then inject the process-only approved preflight
values, including exact target OID/system identifier, approval ID, reviewed HBA
attestation and
`PREFLIGHT_ONLY:nukhabapay_dev:<current-manifest-sha256>`. Run
`pnpm.cmd db:preflight:persistent-development` and require its wrong-password
probe to observe SQLSTATE `28P01`. Never put these values or the database URL in
a script, log, chat, or checkpoint. This read-only preflight is not migration
authorization; `pnpm.cmd db:migrate` is not the persistent profile and must not
be run against development.

### Gate 3 — migration window

Only an approved future persistent deployment command may be used. It must:

1. verify the manifest before connecting;
2. connect as `nukhabapay_migrator` to the exact approved database;
3. revalidate actual host/port/database/owner/role flags and zero unexpected connections;
4. acquire the node-pg-migrate advisory lock;
5. run the reviewed default-ACL/schema preflight on the same connection;
6. apply pending registered migrations 004, 005 and 006 in order in one transaction;
7. release the lock and close the connection cleanly.

No application pool, identity reader/writer, importer, session backend or administrator credential may execute the migration.

After the migration transaction and before starting any runtime, the approved database owner may use `packages/database/roles/proposed_persistent_iam_connection_grants.sql` only after its separate execution approval. It is not registered or invoked automatically. It grants database CONNECT and schema USAGE only to the IAM reader/writer, retains migration 004's exact column privileges, and rejects unexpected database grants or unsafe role attributes. The importer decision is separate catalogue scope. Session CONNECT/schema/column grants remain deferred until its persistent role and grant recipe are approved. Every grant must be followed by an exact excess-privilege check.

### Gate 4 — post-migration acceptance

Keep application processes stopped until every check passes:

- migration history is exactly 001–006;
- all expected IAM/workflow/session tables, indexes, constraints and triggers exist and are owned by the migrator;
- all 16 scoped IAM/workflow/session tables have both RLS enabled and FORCE RLS;
- no SECURITY DEFINER function exists in the project schemas;
- PUBLIC, catalogue runtime and importer cannot read IAM/workflow/session data;
- IAM reader has only the reviewed projections, including `tokens_valid_after`, and cannot read contact details or mutate;
- IAM writer can append only permitted authorization audit records and cannot fabricate lifecycle-success events;
- no workflow backend/reader grant exists unless separately authorized;
- the session role, if separately approved later, has only the exact column grants and cannot read IAM or mutate/delete session evidence;
- schema ACLs and owner default ACLs contain no unexpected grantee/privilege;
- catalogue row counts and read/import regression behavior match the preflight baseline;
- a synthetic session can be created, rotated, expired and revoked with durable reason evidence, followed by clean pool shutdown/restart behavior;
- no raw token, connection URL, credential or private staff data appears in logs.

Record sanitized results and archive hashes. Do not enable real authentication merely because schema checks pass.

## Failure and recovery

- If source/preflight/lock validation fails before migration: make no correction automatically; close the owner connection and investigate.
- If the single migration transaction fails: verify history is still exactly 001–003 and no IAM/session objects or ACL changes committed. Retry only after the cause is reviewed. Do not run down.
- If commit acknowledgement is uncertain: reconnect read-only and inspect authoritative migration history and object/ACL state before deciding anything. Never rerun blindly.
- If migration commits but postchecks fail: keep all writers stopped. Restore the pre-migration archive into a new empty replacement database, validate it completely, and obtain separate destructive approval for any database-name swap or old-target retirement. Do not restore over the failed database and do not use migration down as recovery.
- Preserve the failed database read-only until evidence and incident ownership permit disposal. Never expose dumps or globals files through source control, OneDrive project checkpoints, logs or chat.

## Session and audit operational blockers

- The actor registry is in-memory and deliberately not reconstructed from database rows. A cold process rejects existing cookies; this must be accepted as the development restart policy or replaced through a separately reviewed reauthentication design.
- The registry has a 1,000-issued-entry limit. There is no distributed/HA registry, refresh flow or multi-instance coordination.
- Absolute lifetime is capped at eight hours, idle lifetime at fifteen minutes, and effective lifetime by the original verified token (currently at most five minutes). There is no silent refresh.
- Session and security audit records are append-only. No approved retention, archival, partitioning, purge, capacity alert or legal retention policy exists.
- Revocation is durable and authority changes preserve `AUTHORITY_CHANGED`, but no operational suspension/revocation SLO, alert routing or incident dashboard exists.
- Migration 005 outbox records are intentionally no-delivery synthetic evidence; no relay is authorized.
- Database failover, media-loss recovery, operational RPO/RTO and cross-host restore are not proven.
- The portal session mode remains disabled and no persistent session runtime configuration is implemented.

## Deployment decision

**NO-GO** for applying 004–006 to any persistent database today.

Implemented readiness evidence: the source manifest verifies without a connection; configuration and tamper tests reject unsafe/missing profile inputs; the read-only probe proves the current loopback trust configuration is rejected while development history remains 001–003; the persistent session parser is bounded and disabled; and the unchanged registered migrations continue through disposable combined acceptance. These controls do not create an apply path.

Remaining hard gates are: replace trust with reviewed SCRAM-SHA-256 rules and distinct secrets; approve the named operator/change record and backup/recovery owners; complete a restored-development-backup rehearsal; approve/provision the IAM CONNECT envelope and the separate session role/grants; and register a reviewed persistent activation wrapper/source transition because the immutable 004–006 guards still reject `nukhabapay_dev`.

**Conditional target recommendation:** once the exact-target activation implementation, credential authentication, restored-clone rehearsal, recovery ownership and postchecks are approved and passing, use the existing `nukhabapay_dev` database. Do not introduce a second tenant/IAM source of truth.
