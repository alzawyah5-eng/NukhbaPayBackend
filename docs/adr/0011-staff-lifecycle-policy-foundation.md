# ADR 0011: Pure staff lifecycle policy foundation

Status: implemented for the separately authorized application-only increment
Date: 11 November 2026

## Boundary

Implement deterministic planning for the reviewed staff lifecycle design, without executing any workflow. New application modules export typed requests/snapshots/approvals, grant classification, request-intent digest, lifecycle planning and request-state proposals. They perform no repository calls, network operations, database writes, migrations, provisioning or audit persistence. No API wiring, reserved permission activation, bootstrap runner or production operation is added.

Every result carries `execution: NOT_AUTHORIZED` and immutable blockers: `ASSURANCE_NOT_ESTABLISHED`, `RESERVED_PERMISSION_INACTIVE`, `NO_EXECUTOR`. A complete approval quorum is only a structural planning result, never verified MFA, authorization or a committed change. There is no execution flag, fake assurance adapter or test-mode bypass. The current verified identity contract and authorization evaluator remain unchanged; assurance remains `not-established` and reserved permissions still deny.

Inputs are trusted current application snapshots, not HTTP DTOs or proof of authentication. A future executor must independently resolve canonical staff identities, permissions, assurance and locked database state. No current caller may convert a plan into authority. The SHA-256 intent digest uses Node's standard library, not custom cryptography; it binds fields but is not a signature or proof of approval provenance. Explicit existing Node types are enabled for this standard-library import; strict compiler options remain intact and no dependency is added.

## Operations and grant semantics

| Operation | Proposed transition |
| --- | --- |
| CREATE staff | ABSENT -> PENDING; no initial role intent |
| ACTIVATE staff | PENDING -> ACTIVE; independent approval and identity/MFA preconditions remain |
| SUSPEND staff/membership | ACTIVE -> SUSPENDED; cannot self-contain |
| REVOKE membership/grant | ACTIVE/SUSPENDED membership or unrevoked grant -> REVOKED; no role additions |
| REACTIVATE staff/membership | SUSPENDED -> ACTIVE under restored-access approval requirements |
| DISABLE staff | PENDING/ACTIVE/SUSPENDED -> DISABLED |
| RECOVER staff | SUSPENDED -> SUSPENDED; verification planning never reactivates |

DISABLED staff and revoked memberships cannot be reactivated by this foundation. Separately approved rehire/re-enrollment design must close old grants and preserve history. Global access removal uses suspension/disable; REVOKE targets grants/memberships, not an invented global revoked staff state. No role grant or identity-binding command is emitted.

Grant classification uses explicit UTC epoch milliseconds and no wall clock. Future grants are not active; expiry is exclusive and equality is expired; any recorded revocation is inactive. Cancellation before scheduled validity is valid in the pure model, using the actual current revocation time. Malformed/future revocation timestamps reject. Migration 004's existing revocation-order constraint remains unchanged; future persistence needs the separately reviewed correction. No claim is made that the new model has been persisted.

Unrevoked future/expired assignments still count for role-conflict and target-protection planning, preserving the existing conservative policy. Restrictive cancellation can remove a conflict; activation/reactivation cannot hide it. Scope groups remain separate, so roles in different tenants do not merge. Staff-wide reactivation considers protected authority across all tenants.

## Delegation and approval records

Only an active ACCESS_ADMIN can submit ordinary platform/global requests. Low-risk tenant requests can use an active TENANT_ADMIN grant with active matching membership. All grants must be current, unrevoked and correctly scoped. Platform roles never substitute for tenant roles or membership. A platform access administrator may plan an explicitly delegated tenant access change; that is not tenant data authorization.

SUPPORT_AGENT and CATALOG_OPERATOR are the only low-risk roles. Every platform role, including PLATFORM_AUDITOR, and other tenant roles require separate SECURITY_ADMIN and GOVERNANCE_OWNER approval. Do not infer approval requirements merely from catalogue `privileged` flags. Disable/recovery always need both slots. Ordinary staff creation/activation without protected role intent needs SECURITY_ADMIN approval. Existing/proposed protected authority cannot be omitted from the snapshot to downgrade required approvals.

An active SECURITY_ADMIN may plan immediate staff suspension with no additional approval slot, but still cannot execute it. An eligible TENANT_ADMIN can plan immediate low-risk own-membership containment; platform/protected tenant targets deny. The suspender cannot reactivate alone. Self-suspension/revocation, requester/beneficiary approval, duplicate staff-person approval and duplicate slots reject. Canonical internal staff UUIDs identify people across login bindings; provisioning must enforce that mapping and cannot use email as an identity key.

Approvals bind request ID, version, policy version and deterministic intent digest, as well as current approver authority version. Digest includes operation, target, scope, role set, expected state versions and request timing, excluding mutable bookkeeping state. Material edits invalidate stored intent and existing approvals. Unknown, stale, expired, inactive, revoked, future-authority or rejected approvals deny. Request/approval lifetime is bounded to 30 minutes; all checks use an explicit supplied time. Expiry equality rejects.

## Request-state proposals

| State | Proposed outgoing states, subject to policy validation |
| --- | --- |
| DRAFT | SUBMITTED, CANCELLED, SUPERSEDED; EXPIRED only at/after deadline |
| SUBMITTED | APPROVED only with present quorum; REJECTED only with validated rejection; CANCELLED, SUPERSEDED; EXPIRED at/after deadline |
| APPROVED | CANCELLED, SUPERSEDED; EXPIRED at/after deadline |
| REJECTED/CANCELLED/EXPIRED/SUPERSEDED/APPLIED | None |

APPLY always returns EXECUTION_UNAVAILABLE for every state. State proposals are not stored. Fresh intent/versions and valid context are required; the foundation does not implement background expiry, transactional CAS, approval withdrawal, replay receipts or database recovery. Stale inputs reject rather than being silently repaired.

## Safe output and acceptance

Results contain only fixed reasons, required slots, quorum, proposed status/state, precondition codes and immutable execution blockers. They omit staff/request/tenant IDs, identities, arbitrary input and tokens. Arrays/results are frozen; snapshots and role arrays are never mutated. Input bounds and runtime checks fail closed, including structurally malformed values. No success/audit receipt is fabricated.

Deterministic synthetic tests cover every operation, all state/event edges, role/tenant boundaries, independent/canonical-person approvals, tampered intent, stale versions, timing boundaries, inactive authorities, future cancellation, immutable results and current assurance/phase denial. Existing non-destructive application/API/verifier/configuration/financial/Python checks remain required. No PostgreSQL integration is run in this increment because the authorization forbids database writes/migrations; prior disposable evidence remains historical. Verification records exact commands, results and resolved development issues.

## Remaining work and approvals

Real bootstrap, database command roles/functions, atomic state+audit+receipt/outbox, assurance verification, external provider operations, revocation/session semantics, onboarding/recovery, migration correction and operational controls are unimplemented. Management decisions remain PENDING. Local model approval does not approve real people, activate a reserved phase or authorize another brick. Stop after this foundation. Proposed next bounded work: pure typed atomic command/audit/receipt contracts with in-memory failure/idempotency tests, still without a database writer or executor.
