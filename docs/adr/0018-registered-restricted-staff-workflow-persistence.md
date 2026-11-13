# ADR 0018: Registered restricted staff workflow persistence

12 November 2026 follow-on: ADR 0019 implements the subsequently authorized internal participant-scoped request/status/revision/review reads with isolated SELECT-only grants. This migration and its backend grant recipe remain unchanged; no accepted approval, APPLY, runtime or development activation follows from the reader.

Date: 12 November 2026

Status: implemented for local synthetic acceptance on verified disposable PostgreSQL targets only. Accepted privileged approvals, APPLY, operational MFA and non-disposable activation remain BLOCKED.

The owner authorized one implementation increment following ADRs 0011–0017. Migration 005 registers the existing non-authorized persistence foundation, not the future privileged staff-management schema. No effective staff, identity, membership or grant mutation is implemented. No deployed composition or endpoint changes.

## Registered objects

`packages/database/migrations/005_staff_workflow_persistence.ts` is a self-contained frozen migration. It reads no rehearsal files at runtime. The three files under `pending-migrations` remain unchanged historical evidence; fixtures no longer execute them. Registered 001–004 source is unchanged.

| Tables | Purpose |
| --- | --- |
| iam_workflow_proposals, iam_workflow_audit_intents, iam_workflow_receipts, iam_workflow_outbox | Four compatibility tables preserve the previously tested simulation, receipt-reader and wire-failure contracts. They remain UNVERIFIED/SIMULATION_ONLY/NOT_AUTHORIZED with NO_EXTERNAL_DELIVERY. |
| staff_request_operations | Canonical actor/key operation ledger, exact issuer/subject, intent digest, request/version/scope, SUBMIT/REVIEW only. Unique canonical-person/key namespace. |
| staff_access_requests | Immutable request versions, exact requester/target/tenant, intended roles, authority versions/digests, parent version/digest, policy, bounded expiry and normalized intent. SUBMITTED/NOT_AUTHORIZED only. |
| staff_review_observations | Exact request/version/digest, canonical independent reviewer and authority snapshot; unique person per version; not-established/accepted_approval=false/NOT_AUTHORIZED. |
| staff_request_audit | Fixed SYNTHETIC_REQUEST_SUBMITTED or SYNTHETIC_REVIEW_OBSERVED event; composite operation/actor/request/version/scope/digest references. |
| staff_request_receipts | RECORDED_NOT_AUTHORIZED only, exact operation/scope. |
| staff_request_outbox | NO_EXTERNAL_DELIVERY only, exact receipt/scope. No dispatcher. |
| staff_synthetic_provenance | Safe ADR 0017 binding/evidence metadata, unique challenge/event, exact operation identity and review/request/version/scope/authority references. Never raw assertions or operational assurance. |

All eleven tables are logged, ENABLE/FORCE RLS and append-only: eleven immutable-record triggers use the existing audit mutation rejection function; one additional BEFORE INSERT trigger independently rejects self/beneficiary/out-of-window observations. Eleven scope policies match `nukhabapay.workflow_scope` exactly. These settings guard accidental backend scope; they do not authenticate people.

Two new functions are SECURITY INVOKER with fixed `search_path=pg_catalog`: `check_synthetic_review()` validates observations; `execute_staff_command(jsonb)` always raises 42501. There is no SECURITY DEFINER, owner-switching execution path or privileged approval function. Both functions revoke PUBLIC and all four canonical workload roles. PostgreSQL trigger invocation does not require granting callers direct function EXECUTE.

Composite foreign keys bind actor, target, request, version, scope, digest and generated operation/event kind. Deferred reverse edges require the complete operation/request-or-review/audit/receipt/outbox tuple at commit, plus provenance for a tagged review. Revisions append an exact parent; canonical requester/target/scope cannot change. Request expiry is greater than creation and at most thirty minutes; synthetic evidence lifetime is at most sixty seconds. Expected staff authority versions may start at zero; tenant membership versions must be present and positive.

Promotion strengthens rehearsal constraints: a generated existing-target reference requires a canonical staff row for non-CREATE intent; explicit non-null tenant membership version and revision parent digest; platform/tenant role vocabulary separation; `IS TRUE` payload/provenance binding checks so SQL NULL cannot satisfy a missing JSON field or tenant binding. CREATE planning names an immutable future target UUID with no staff row or role grants; its database exception requires a platform STAFF CREATE intent, no proposed roles and zero expected authority version. This preserves the pure lifecycle/store contract without provisioning anyone. Application policy still enforces role conflicts, freshness, head CAS and all lifecycle semantics. Database rows or digests are not proof of authenticated approval.

## Exact privilege matrix

| Principal | Eleven new tables | New functions | Existing IAM/catalogue |
| --- | --- | --- | --- |
| PUBLIC, catalogue runtime/importer, IAM reader/authorization audit writer | None, including SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER | No EXECUTE | Existing object ACLs, column grants and RLS preserved. |
| Migrator/owner | DDL ownership; FORCE RLS applies to ordinary owner DML | Ownership; command gate still denies | Never ordinary application credentials. |
| Generated synthetic request backend | SELECT/INSERT on canonical six; seventh provenance table only when explicitly selected LOCAL_SYNTHETIC_ONLY. No compatibility table grants. No UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER. | None | Only the 27 IAM SELECT columns below; no contacts/display/evidence, IAM writes, catalogue, schema CREATE, database CREATE/TEMP or role membership. |
| Existing disposable compatibility recorder/receipt reader | Existing tests explicitly grant their unchanged four-table append or fourteen-column read projection | Only fixture recorder may call always-deny gate | No new IAM or catalogue rights. Never deployed. |

IAM projection: users(id,status,authz_version); identities(staff_id,issuer,subject,status); memberships(id,staff_id,tenant_id,status,version); platform grants(id,staff_id,role_code,scope,granted_at,expires_at,revoked_at); tenant grants(id,membership_id,tenant_id,role_code,scope,granted_at,expires_at,revoked_at). Two separate SELECT-only IAM policies name only the generated backend and require exact `nukhabapay.tenant_id`; existing reader policies are unchanged.

The new owner-operated `roles/grant_staff_workflow_backend.sql` applies this matrix inside a transaction to an already provisioned generated `nukh_request_<20 hex>` login. It validates target/history/mode, restricted role flags, no memberships and separate ownership. It does not create roles, grant staff authority or register runtime credentials. Configuration GUCs select grants, not human identity. Existing adapter startup rejects missing/excessive privileges.

Global and schema-local defaults for future owner-created tables/functions are revoked from PUBLIC and configured catalogue/IAM roles before creation. Any remaining unreviewed default grantee causes the whole migration to fail and roll back; it cannot silently acquire artifact privileges. Explicit revokes protect each new object even under hostile defaults. Existing object ACLs are not reset; existing IAM reader/audit writer permissions and catalogue restrictions remain intact. Existing authorization audit vocabulary still rejects lifecycle-success and privileged-approval event names. Synthetic workflow audits have a separate fixed vocabulary and writer; none represents staff mutation.

## Target, transaction and recovery gates

The migration rejects any target outside loopback port 5432 and exact existing disposable fixture name patterns (`nukhabapay_{db,i,cli,r,iam,b3b2,b3b3}_<32 hex>`). This is defense in depth, not permission to migrate any similarly named database: the harness must first verify actual host/port/database/owner, its own target creation and restricted workload roles. No run against development is attempted. Grant bootstrap further limits targets to loopback port 5432 b3b2/b3b3 with the actual 005 history row. Wrong role/mode or inherited workload privileges deny bootstrap without grants.

Historical IAM-only fixtures explicitly stop at 004 using node-pg-migrate `up 4 --timestamp`; workflow fixtures and the new suite run actual registered 005 and verify history. The default migration command now discovers 005; its local target gate rejects development/shared names and the single transaction rolls back. Do not invoke it against development. A future approved non-disposable deployment needs a separately reviewed target/activation change and backup/restore evidence.

The unchanged durable adapter uses SERIALIZABLE transactions and bounded whole-transaction retries. Session advisory reservations occur before BEGIN in fixed order: request identity, canonical actor/key. Each attempted lock is tracked, released in reverse order or its connection discarded. The operation ledger and unique/FK constraints are durable guards; there is no persistent privileged execution lease. Fresh actor/requester/target checks precede commit; a separate read-only pool checks current authority snapshots. These checks do not close the final revocation race for future privileged execution, which remains blocked.

Atomicity covers artifacts only. Changed-payload keys conflict; identical replay returns the existing receipt without duplicate evidence. COMMIT acknowledgement loss returns UNRESOLVED and discards the connection; fresh actor-bound authoritative lookup/retry reconciles. An empty unsynchronized lookup does not prove rollback. Failure/replay/concurrency/receipt isolation tests now run on registered 005 without replacing their assertions.

Automatic `down` deliberately refuses before deleting immutable history. A failed `up` rolls back schema, default ACL changes and migration history in its single transaction. Restoring a committed database requires a separately approved verified recovery procedure; destructive rollback is not supplied. Source checkpoints are not database backups. No server crash, failover, media-loss or backup-restore guarantee is claimed.

## Completion and remaining gates

Local functionality: durable synthetic submission/revisions, independent non-approved review, opaque actor-bound synthetic provenance, atomic evidence/receipt/no-delivery outbox, idempotency, concurrency and authoritative receipt recovery on disposable PostgreSQL. Acceptance includes hostile defaults/roles, forced RLS, null/malformed bindings, injected migration failure, deny-only command gate and unchanged 004 object privileges. Exact results are recorded in verification.md.

Prohibited: accepted approval/quorum, APPROVED/APPLIED state, real MFA claims, staff/identity/membership/grant changes, outbox dispatch, real bootstrap, reserved permission activation, real Auth0/staff, deployed endpoints and development migration. Existing grant cancellation/scheduled-revocation constraints and operational authority linearization are unresolved for privileged execution. Management ownership, authentic assurance, independently authenticated approvals, recovery and non-disposable migration gates remain PENDING/BLOCKED. Brick 3 overall is incomplete. Further schema changes require a separately authorized later numbered migration; do not append privileged execution to frozen 005.

Next proposed bounded functional step: internal actor-scoped request detail/status and review-history reads through explicit artifact-read authority, fresh actor/scope checks and committed audit, with disposable privilege/isolation acceptance. No public endpoints, privileged approvals or APPLY. Stop for owner review before that increment.
