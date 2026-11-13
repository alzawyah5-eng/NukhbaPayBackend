# ADR 0016: Durable synthetic staff access requests and independent review observations

12 November 2026 follow-on: ADR 0018 promotes a frozen copy of this schema into registered restricted migration 005 with stricter null/payload/target/scope constraints. Pending SQL remains unchanged historical evidence; acceptance fixtures now use registered 005 and the explicit backend grant recipe. All NOT_AUTHORIZED, independence, transaction and execution restrictions below remain.

Date: 11 November 2026

Status: implemented for local disposable PostgreSQL acceptance only. Approval acceptance, APPLY and operational activation remain BLOCKED.

The owner authorized durable versioned request submission and independent non-approved review observations, then review. This is functional storage, not staff mutation or a privileged migration deployment. ADRs 0013–0015 trust boundaries remain.

## Application authority boundary

Existing opaque `TrustedStaffActor` handles are required. The boundary re-resolves exact verified issuer/subject, canonical person, token lifetime, active staff/identity/membership and the unchanged authority snapshot. A separate default-deny `NON_AUTHORIZED_STAFF_REQUESTS` port policy authorizes recording synthetic artifacts. It does not inherit staff.self.read or activate reserved permissions.

Commands are bounded, typed SUBMIT, REVIEW or LOOKUP. A normalized allowlist strips client actor, tenant, state, approval and MFA assertions. The server derives canonical requester and tenant from the actor. A frozen one-use in-flight ticket binds the verified identity, authority digest, command, server time/deadline and fresh revalidation callback. Only the actor boundary issues it; JSON/clones/raw UUIDs cannot invoke the store. Reconciliation uses a fresh actor, never a persisted receipt as authority.

Lifecycle request shape, scoped roles, conflicts, target transitions, expected versions and expiry are checked through the existing `planStaffLifecycle`/`accessChangeRequestDigest`. A PLAN remains NOT_AUTHORIZED. Review eligibility uses current fixed role policy and a distinct explicit artifact-recording capability. Reserved permission denial remains intact; even an unexpected future ALLOW is not accepted by this observation path. Client MFA claims are never evaluated as assurance.

## Durable schema

`packages/database/pending-migrations/staff-access-request-records.sql` is an additive disposable-only DDL rehearsal, outside automatic migration registration. It does not replace registered migrations or claim full privileged migration 005 readiness. The test fixture verifies its actual generated target, then executes the DDL on a migrator connection inside BEGIN/COMMIT. No 005 migration-history row is inserted and no development startup loads it.

Six logged tables:

| Table | Stored evidence and invariants |
| --- | --- |
| staff_access_requests | Immutable `(request_id,version)`; canonical requester/target, exact scope, intended roles, expected target staff/membership versions, requester version and authority digest, target authority digest, policy/version/digest, normalized lifecycle JSON and server creation/expiry. State is always SUBMITTED; execution NOT_AUTHORIZED. |
| staff_review_observations | Request/version/digest, canonical verified reviewer, reviewer authority/version, observed time; assurance not-established, accepted_approval=false, execution NOT_AUTHORIZED. Unique person per request version. |
| staff_request_operations | Stable canonical-person/key operation ID, unique person/key namespace, exact verified issuer/subject, request/version/scope, command digest and SUBMIT/REVIEW kind. |
| staff_request_audit | Fixed SYNTHETIC_REQUEST_SUBMITTED or SYNTHETIC_REVIEW_OBSERVED event, exact operation/actor/request/version/scope/digest; no privileged approval/mutation audit fabricated. |
| staff_request_receipts | RECORDED_NOT_AUTHORIZED only, operation/scope binding. |
| staff_request_outbox | NO_EXTERNAL_DELIVERY only; no dispatcher or external effect. |

Version revisions append rather than update. Parent version/digest foreign keys and immutable requester/target/scope parent bindings preserve historical identity. Service CAS requires exactly the next version and prior digest under the request reservation. Review uses the latest head and exact supplied digest; a superseded version is rejected. The first authority version may be zero, matching migration 004 and the existing pure policy.

Fixed state/assurance/approval checks, bounded role vocabulary/lifetime, payload-to-column equality checks, canonical-person uniqueness, composite audit bindings, generated event/kind bindings and deferred circular completion edges protect consistency. At commit, a SUBMIT must have its request version; REVIEW must have its observation; both must have audit, receipt and outbox. Trigger checks independently reject requester/beneficiary reviews and out-of-window observations. Update/delete rejection triggers and absent mutation grants protect history. No accepted approval, APPROVED/APPLIED state or staff grant can be emitted.

## Transactions, concurrency and recovery

The store verifies a generated loopback disposable target and generated restricted login, copies its configuration, bounds its pools and masks dependency errors. No deployed composition registers it. All artifacts for one operation commit on one checked-out connection in one SERIALIZABLE transaction.

Fixed reservation order: request identity, then canonical actor/key. Session advisory reservations are obtained before BEGIN so a waiter receives a snapshot after the previous head commit. Each attempted acquisition is tracked even if its acknowledgement is uncertain. Every terminal path releases locks in reverse order; unlock/rollback failure discards the connection, whose termination releases its session locks. Nothing returns a reserved connection to the pool. Unique keys and parent constraints remain the database guard.

Actor identity, status, memberships and current grants are read inside the transaction, with both IAM tenant and workflow scope set transaction-locally. Before commit, the original actor/policy callback is revalidated. A separate bounded read-only freshness pool then compares current actor/requester/target authority snapshots to the transaction's expected snapshots. This catches observed mid-operation changes without granting IAM write/row-lock privileges. Pools are bounded to two connections each, and every acquired connection is committed/rolled back/released or discarded. This is still not a globally linearized privilege mutation: authority can change after the final read. The stored observations grant no permission; a future privileged executor must implement its own atomic authority/assurance checks and locks.

Identical person/key/payload replay returns the original durable receipt without duplicate audit/outbox. Changed intent conflicts. Whole transactions retry boundedly on 40001/40P01/23505 with fresh authority checks; business role conflicts are policy denials, not idempotency conflicts. Connection loss around COMMIT returns UNRESOLVED without a successful request digest/receipt. Fresh actor/key/request/version LOOKUP can return the authoritative committed receipt; absence is UNRESOLVED and is not proof of rollback. A serialized same-key retry checks first. Real wire acknowledgement loss is exercised in acceptance.

## Privilege and RLS matrix

The fixture creates `nukh_request_<20 hex>` with LOGIN/NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOINHERIT/NOBYPASSRLS and no role memberships. Explicit target CONNECT/schema USAGE only; no CREATE/TEMP.

| Principal | New six tables | Existing IAM | Catalogue / staff execution |
| --- | --- | --- | --- |
| Dedicated synthetic request backend | SELECT and INSERT; no UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER | Column SELECT only: users(id,status,authz_version); identities(staff_id,issuer,subject,status); memberships(id,staff_id,tenant_id,status,version); platform grants(id,staff_id,role_code,scope,granted_at,expires_at,revoked_at); tenant grants(id,membership_id,tenant_id,role_code,scope,granted_at,expires_at,revoked_at) | No catalogue access, contact/display/evidence fields, IAM writes, DDL or execute_staff_command |
| Existing IAM reader / audit writer / catalogue runtime / importer / PUBLIC | None | Existing rights unchanged | Existing rights unchanged |
| Migrator/fixture administration | Verified-target DDL/setup/acceptance only | Fixture data and controlled failure injection only | Never application credentials |

All six tables have enabled/FORCE RLS and transaction-scoped tenant/platform filtering. Existing IAM membership/grant policies name the IAM reader, so the fixture adds separate SELECT-only policies for the new role, with the same exact tenant filter. Original policies/grants and enabled/FORCE flags remain unchanged. The new role cannot write IAM. New IAM policies, column/table grants and generated role are removed during fixture cleanup. No development or shared grant changes.

The adapter rejects excessive IAM read/write/schema/command rights at startup. PostgreSQL credentials and mutable scope settings authenticate a trusted backend workload, not a human. Canonical human provenance is admitted through the opaque verified ticket and server policy; never expose these credentials to clients. A compromised trusted backend could append false non-authorized artifacts: these records are not cryptographic MFA/privileged approval proofs and must never be promoted or rehydrated as actor/execution authority. No SECURITY DEFINER function is introduced; new validation trigger is SECURITY INVOKER with fixed pg_catalog search_path and revoked PUBLIC EXECUTE.

## Locally functional versus prohibited

Working locally: submit a policy-valid synthetic request; persist proposed roles without granting them; append a CAS-bound immutable revision; record an eligible independent person's non-approved observation; reject self/beneficiary/duplicate-person/foreign-scope/stale/expired attempts; idempotently replay; reconcile an uncertain commit from durable own-operation receipts. Prior versions/evidence remain intact and all artifact writes/audit/receipts/outbox are atomic.

Prohibited/unimplemented: create/activate/suspend/revoke/reactivate/disable/recover actual staff or memberships; grant/revoke effective roles; accept an MFA claim, approval or quorum; transition to APPROVED/APPLIED; dispatch outbox; activate reserved permissions; expose staff/business endpoints; connect Auth0, real employees/providers or financial execution; apply migration 004 or any new schema to development. These remain BLOCKED/PENDING. Brick 3 overall and operational activation are not complete.

Acceptance, exact commands, failures, targets and changed files are in verification.md. Stop after this bounded implementation for owner review.
