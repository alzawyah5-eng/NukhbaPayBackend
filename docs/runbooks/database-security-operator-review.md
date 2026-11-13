# Database security operator review — Track A

Prepared 13 November 2026. NO-GO. This procedure authorizes no execution.
Use with [the deployment runbook](development-iam-deployment.md). Named DBA,
change approver, secret custodian and recovery owner must sign a change record.

Reference: PostgreSQL 17 [password authentication](https://www.postgresql.org/docs/17/auth-password.html)
and [HBA matching, validation and Windows behavior](https://www.postgresql.org/docs/17/auth-pg-hba-conf.html).
Confirm all deployed client libraries support SCRAM before rotating credentials.

## SCRAM conversion and recovery

Before touching authentication, stop project writers and retain an independent,
tested administrator recovery connection. Record service identity, PostgreSQL 17
binary versions, `SHOW data_directory`, `SHOW config_file`, `SHOW hba_file`,
`SHOW ident_file`, `SHOW password_encryption` and `SELECT * FROM pg_hba_file_rules`.
Resolve included configuration files; back up their bytes, permissions and SHA-256
hashes to an access-restricted vault outside the repository and OneDrive.
Back up the database and non-secret globals and restore to an isolated empty
cluster as described in Gate 2. Record successful restore, counts, owners, ACLs,
history and recovery time. A listed archive alone is insufficient.

DBA review must include every earlier matching HBA record and included file.
Require explicit database/role SCRAM rules for IPv4 loopback before broad rules;
review IPv6 separately even though the application parser requires IPv4. Do not
alter replication authentication under this change. Set password encryption to
SCRAM for the password-setting administrator session before using interactive
`psql \password <role>` for each distinct secret. Do not use SQL literals,
environment dumps or command arguments containing secrets. The DBA must confirm
all project password verifiers are SCRAM without exporting verifier values.
Changing password_encryption does not convert existing password verifiers.

Validate HBA syntax (`error IS NOT NULL` returns zero rows), exact rule order and
effective settings before the approved reload. Windows applies HBA edits to new
connections immediately: keep the recovery channel open during editing, and test
fresh connections after every step. Existing pools do not prove authentication.

Run the following matrix through a DBA-reviewed driver which records only role,
case, success and SQLSTATE. Disable ambient PGPASSWORD, passfiles and service
configuration; each probe must be a new explicit TCP connection to literal
127.0.0.1:5432/nukhabapay_dev with bounded timeouts and no fallback. Inject secrets
through the approved process-only mechanism. Do not log driver error objects.

| Case, for each provisioned project login | Required result |
| --- | --- |
| Correct own secret | Success for migrator/runtime; `42501` CONNECT denial for importer/identity roles before separately approved grants |
| Random incorrect secret | Exactly `28P01`; network failure or CONNECT denial is not a pass |
| Another role's secret | Exactly `28P01` |
| No password | Client refusal or server authentication rejection; never success; record separately from the `28P01` proof |
| Correct secret, approved role and database after grants | Success, followed by exact privilege checks |
| Non-loopback and IPv6 paths | Match separately approved network/HBA policy; no unreviewed trust route |

Repeat for the session login only after separate provisioning. Run the existing
preflight after the matrix; its wrong-password probe must also pass. Record HBA
hashes and sanitized results, never secrets or verifiers.

If authentication fails, keep applications stopped. Use the retained administrator
channel to inspect matching rules and syntax. Restore reviewed configuration bytes
and permissions only under the recovery owner's decision, then validate/reload and
retest fresh connections. Restoring HBA does not restore rotated passwords; retain
the new secrets and repair their delivery or reset them through the recovery DBA.
If rollback reintroduces trust, isolate the service and keep project clients stopped;
the deployment remains NO-GO. Never automatically restore insecure authentication.

## Restricted activation wrapper and preservation contract

`node scripts/prepare-persistent-iam-activation.mjs --prepare` verifies all ten
registered source hashes and prints a non-secret review plan without connecting.
Every other mode rejects. It cannot apply migrations. The immutable sources still
reject the persistent database; an executable wrapper requires a separately
reviewed source transition. Do not replace database-name expressions at runtime,
rename targets, rewrite checksums or fake history to circumvent these guards.

The future executor must bind separate approval to its own source hash, manifest
hash, database OID and cluster system identifier, backup hash and restored-clone
acceptance record. Reuse the existing exact-target preflight and SCRAM probe,
then acquire the installed migrator lock on the same owner connection. Begin one
transaction, recheck identity/history/quiescence, lock existing catalogue tables
against writers in stable name order, and run the reviewed preflight and 004–006
in order. Apply no grants outside the separately approved envelope.

Before migration, capture every existing catalogue table's row count and a SHA-256
digest over deterministically ordered complete row encodings (explicit UTC and
stable JSON/bytea representation). Retain only digests/counts in review evidence.
Also capture table/column definitions, constraints, indexes, owners, RLS/policies,
existing object ACLs and sequence values. Compare within the same locked transaction
after migration; reject any catalogue data or existing object change. Owner default
ACL tightening is an intentional migration effect and must be compared against the
reviewed expected delta, separately from existing object grants. Counts alone do
not prove preservation. Repeat catalogue read/import regression on the restored
disposable cluster with synthetic fixtures before approving execution.

Postchecks must assert exact 001–006 history, expected IAM objects/ownership/RLS,
absence of excess grants and unchanged catalogue evidence before COMMIT. Any failed
check rolls back the entire transaction. A lost COMMIT acknowledgement requires
read-only authoritative inspection, never blind retry. Recovery after commit is a
verified restore to a new empty database and separately approved cutover, never down.

## Role-grant plan

Retain all five existing restricted roles, flags and zero memberships. Migrator
alone owns schema objects. Runtime keeps existing catalogue reads. Importer CONNECT
and schema USAGE remain separate catalogue-owner scope. No role receives global,
default, table-wide or function grants as a convenience.

After 004–006, the separately approved owner transaction may run the existing
`proposed_persistent_iam_connection_grants.sql` with its bounded approval setting.
Before it, verify exact identity/history and snapshot all effective privileges.
It adds only IAM reader/writer CONNECT and schema USAGE; migration 004 supplies
the exact reader columns and audit INSERT envelope. Compare effective column,
table, sequence, schema, database and function rights afterward, including PUBLIC
and inherited access. Test denied contact-email reads, writes by the reader,
audit reads/updates/deletes by the writer, cross-tenant reads and catalogue-role
access to IAM/workflow/session objects.

The session login remains unprovisioned. Its future owner-approved grant recipe
must enumerate the existing 27 SELECT and 23 INSERT columns from the reviewed
disposable session recipe, plus CONNECT/session-schema USAGE only. No UPDATE,
DELETE, ownership, membership or IAM/catalogue/workflow access. A persistent recipe
and negative acceptance tests remain blockers; do not run the disposable grant
script on the persistent target. Workflow roles, session runtime, Auth0 and frontend
activation are outside this change.

## Review evidence and blockers

Unit/source tests use temporary directories and mocked target evidence only.
They do not establish live target identity, catalogue preservation, HBA enforcement
or restored-backup acceptance. Those remain operator execution gates. No persistent
inspection or migration is performed by this Track A preparation.

Reproduce the connection-free checks:

```powershell
node scripts/rehearse-reviewed-migrations.mjs --verify-only
node --test scripts/test/persistent-development-iam.test.mjs scripts/test/persistent-activation-preparation.test.mjs
node scripts/prepare-persistent-iam-activation.mjs --prepare
```

On this Windows worktree `core.autocrlf=true` changed three frozen sources on
checkout. Exact LF rules in `.gitattributes` preserve their committed bytes;
the manifest and historical hashes remain unchanged. Source verification still
rejects byte changes; it does not normalize inputs to hide corruption.
