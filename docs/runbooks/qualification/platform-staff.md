# Platform staff security qualification

**Architecture** Owner approved for implementation and disposable testing on November 20, 2026.  
**Operational execution** Pending separate authorization.

Phase 3C is tenant-scoped staff management. Phase 3D is platform security administration. The canonical catalogue records the approved permissions. The general runtime authorization phase remains 3A. The frozen IAM migration remains historical evidence. The guarded disposable schema installs the corresponding catalogue changes locally. [Permission catalogue](../../../packages/application/src/identity/permission-catalog.ts) · [Local schema](../../../packages/database/fixtures/staff-effective-platform.sql)

| Platform command | Canonical binding | Independent approvals | Effect |
| --- | --- | --- | --- |
| `platform.sessions.revoke` | Staff UUID and authority version, exact immutable session UUID, creation operation UUID and stored session scope | One security reviewer | Append revocation for only the bound session. |
| `platform.sessions.revoke_all` | Staff UUID and authority version, exact current identity cutoff | One security reviewer and a different governance reviewer | Advance the cutoff and authority version. Revoke this identity's sessions across tenant and platform contexts. Staff status and memberships remain as recorded. |
| `platform.staff.suspend` | Staff UUID and authority version, exact current identity cutoff | One security reviewer and a different governance reviewer | Set suspended status, advance the cutoff and version, and revoke the identity's sessions. |

## Local execution contract

- Use a canonical platform session and a current role mapped to the exact permission. Submission, approval, rejection, cancellation, execution, and receipt lookup bind opaque MFA evidence to the precise immutable command intent. The local executor only accepts the disposable assurance profile and a restricted loopback database role. The requester and affected beneficiary cannot fill a review slot.
- Persist immutable request versions, decisions, cancellations, and receipts. A revision supersedes the earlier version by matching its digest. Recheck target, head, current canonical identity and grants, distinct quorum, and expiry inside the effect transaction. An identity cutoff rejects credentials issued at or before the cutoff.
- Serialize effect transactions with canonical authority writes, session creation, and session revocation. Commit the factor replay reservation, audit, state change, revocations and receipt together. Audit or persistence failure rolls back all effects. The deferred database deadline rejects a commit after its earliest expiry.
- An ambiguous COMMIT returns `UNRESOLVED`. Reconcile through an exact actor, request version and digest, target, command and idempotency key lookup. A matching immutable receipt confirms the outcome. Retry the same intent only after confirmed absence and a fresh proof. [Executor](../../../packages/database/src/platform-staff-executor.ts) · [Disposable scenarios](../../../scripts/test/staff-effective-platform.mjs)

## Recovery

A revoked single session can be replaced by fresh authentication under current authority. All-session revocation requires a new credential issued strictly after the cutoff. A suspended staff identity remains blocked even with a fresh credential. Restoration requires a separate authorized IAM decision. Verify incident closure, reaffirm the staff identity and its approved grants, retain the cutoff, advance authority version and require fresh MFA before issuing any session. Prior sessions and approvals stay invalid. Provider-side session action requires separate approval and its own evidence.

## Qualification

Build the application and database packages and run `python scripts/test/refresh-012-isolated.py --platform` on the repository's disposable PostgreSQL harness. It uses a new loopback-only data directory and verifies the target before loading fixtures. For operational readiness, bind an approved platform login composition to the pilot verifier, qualify real factor provenance and durable consumption, and review the production least-privilege role and migration plan. The disposable outcome does not grant operational authority. [Auth0 pilot checklist](auth0-mfa.md)
