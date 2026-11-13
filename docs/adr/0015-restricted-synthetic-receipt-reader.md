# ADR 0015: Restricted PostgreSQL synthetic receipt reader

Date: 11 November 2026

Status: implemented for local disposable acceptance only. No deployed runtime registration or privileged execution.

The owner authorized this bounded reader implementation and acceptance, then review. Do not start further receipt preparation increments absent a genuine security defect. ADRs 0013/0014 keep their authority, MFA, approval and persistence gates.

## Trust and query flow

Existing `TrustedStaffActorBoundary` freshly resolves the original verified issuer/subject to canonical active staff/membership and unchanged authorization snapshot. A separate explicit NON_AUTHORIZED_RECEIPT_RECONCILE policy must allow access; staff.self.read does not grant it. The boundary now issues a frozen, instance-derived query capability registered privately in the application module, with server-derived actor/tenant, key, expected digest and optional expected operation ID. The new PostgreSQL adapter requires the operation ID. Legacy synthetic fixtures may omit it; the real adapter then denies without querying.

Only the actor boundary can issue capabilities. The exported adapter validator can consume, never mint them. JSON, UUIDs, structural clones and replayed/retained capabilities fail. A capability is active only while its original lookup is in flight and can be consumed once. The boundary invalidates it on every exit. No capability is returned to a caller or exposed by an HTTP endpoint.

`createSyntheticReceiptReader` returns a lookup/close object without exposing its pool or credentials. It accepts only explicit loopback port 5432, a generated disposable b3b3 database and a generated restricted receipt-reader role. URL ambiguity/options and mismatched target/login fail closed with one sanitized error. The adapter is not wired into API, IAM startup, environment configuration or any deployed provider.

The parameterized SQL requires exact actor, tenant scope, UUID idempotency key, operation ID and digest on both joined proposal/receipt rows, plus UNVERIFIED/SIMULATION_ONLY/NOT_AUTHORIZED proposal and SIMULATION_RECORDED/NOT_AUTHORIZED receipt tags. No list, prefix, search, offset or wildcard method exists. LIMIT 2 bounds results; exactly one row is required. A missing/mismatched row or dependency failure returns UNRESOLVED, never proof of noncommit. Returned fields are copied/frozen and the application returns only operation ID/outcome/execution after committed audit and fresh actor/policy rechecks.

## Minimum disposable database privileges

The acceptance fixture creates a unique `nukh_receipt_<20 hex>` LOGIN role, with NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOINHERIT, NOBYPASSRLS and no memberships. It explicitly grants target CONNECT, schema USAGE and these SELECT columns only:

| Table | SELECT columns |
| --- | --- |
| iam_workflow_proposals | operation_id, actor_staff_id, scope_key, idempotency_key, command_digest, provenance, record_kind, execution |
| iam_workflow_receipts | operation_id, actor_staff_id, scope_key, command_digest, outcome, execution |

Fourteen column grants; no full-table SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, schema/database CREATE, TEMP or command-function EXECUTE. No staff/identity/contact/membership/grant/audit-intent/outbox/security-audit access. No role-management/ownership path or SECURITY DEFINER function. The factory checks login flags, memberships, enabled/FORCE RLS, excessive table/column rights and the exact projection before accepting the pool. Missing or excessive privileges reject initialization and close the pool.

All existing catalogue/importer/IAM role grants and migration files are unchanged. IAM resolution uses its existing reader; committed audit uses its distinct existing writer. The new fixture role cannot audit or mutate anything. Its column privileges are explicitly revoked, pool sessions checked closed, then role removed before disposable database teardown. No role is provisioned on development/shared targets.

Human actor isolation is enforced by the verified capability/application boundary, not by the login alone or a client GUC. Existing FORCE RLS restricts selected tenant scope but a SQL credential holder can set that scope and read its granted projection; direct database access is not approved for ordinary callers. Credentials must never be given to clients or treated as human identity. This is a trusted backend adapter with minimal data privileges, not proof of human identity inside PostgreSQL. Existing PUBLIC connectivity outside the disposable database is unchanged; factory target restrictions prevent using it as a general database client.

## Transactions and lifecycle

The fixed pool is bounded to two connections, three-second connection/statement deadlines, four-second query deadline, one-second idle timeout and five-second idle-in-transaction timeout. Every lookup begins READ ONLY, sets transaction-local scope, performs one bounded query and commits. COMMIT's command tag is checked. Errors attempt rollback; rollback failure discards the connection with a sanitized marker. Every acquired client is released. Close is idempotent; closed pools deny. Idle failures reconnect or deny without logging tokens/credentials. A lifetime per-client transport-error listener marks failed clients for discard, including errors while pg-pool moves its own idle listener on checkout/removal; no process-level exception handler is used. Disposable fault injection exposed and fixed an unhandled late ECONNRESET in the first full run.

No writes, staff commands, approval acceptance or APPLY are implemented. Concurrent readers cannot duplicate workflow records. Reader/IAM/audit work uses separate transactions with fresh checks before disclosure; this does not establish an atomic privileged mutation or globally linearized revocation. Those existing gates remain BLOCKED.

## Package boundary and evidence

Database now declares a workspace dependency on application and consumes the capability validator through the package export. A relative runtime import would compile a second private registry; the initial compile caught that nominal type mismatch. A single package instance is required for runtime provenance. No third-party version/download changed; the lockfile adds only that workspace link. Exact local dependency setup, failures and passing commands are in verification.md.

Disposable tests cover fourteen-column/no-write privilege evidence; forged/cloned actors and capabilities; mismatched operation/key/digest; cross-person/cross-tenant requests through otherwise allowed own-receipt policies; missing records; concurrent permitted and foreign-context reads on the bounded pool; stale authority; one-use query replay; idle connection recovery; missing/excess privileges and missing databases; actual backend loss while the receipt query waits on a controlled lock; and complete cleanup. Existing IAM/audit/token/recovery/financial suites remain required.

No non-disposable migration, runtime registration, endpoint, real identity, MFA acceptance, reserved permission or financial operation. Full Brick 3 and operational activation remain incomplete. Next proposed functional work is local synthetic staff access-request submission/review with durable versioned server-owned requests and canonical-person review records, while MFA/approval/APPLY gates stay closed. That is not another receipt preparation task. Stop for review; do not start it automatically.
