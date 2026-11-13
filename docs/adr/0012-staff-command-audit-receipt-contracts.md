# ADR 0012: Pure staff command, audit, receipt and idempotency contracts

Status: implemented for the separately authorized pure-contract increment
Date: 11 November 2026

## Scope and non-authorization boundary

Define immutable contracts and deterministic constructors/comparison functions for future staff lifecycle commands, audit intents, receipts and transaction boundaries. Reuse ADR 0011's planner unchanged. All values retain `execution: NOT_AUTHORIZED` and existing assurance/permission/no-executor blockers. No APPLY, workflow executor, database adapter, audit persistence, account, provider or HTTP route is implemented. No mode or fixture may convert a simulation into authorization. Current `assurance=not-established` and reserved permission denial remain unchanged.

Production source provides only pure proposal construction, bounded safe fields and interface declarations. The orchestrator and in-memory transactional model live exclusively under application test fixtures and are excluded from production compilation. The model records intent tuples, never a staff directory or lifecycle state mutation.

## Command and identifier contracts

`prepareStaffCommand` requires a valid SUBMITTED/APPROVED request, trusted current context and canonical UUID idempotency key. It reruns the existing pure planner, retaining every blocker; even a pending structural quorum can describe a non-executable candidate. Actor is exactly requester staff UUID, target/scope/roles come from the validated allowlisted intent. No caller-supplied operation ID, raw claims, email, token or arbitrary metadata is copied.

Operation ID is standard-library SHA-256 over version/domain, LOCAL_SYNTHETIC namespace, canonical actor staff UUID and idempotency key. The namespace deliberately excludes target/tenant: reusing one actor/key for a different target or tenant conflicts rather than silently creating another operation. Different actors have distinct namespaces. Keys/IDs are correlation identifiers, not bearer credentials or authorization proofs.

Command digest binds operation ID, the existing request-intent digest and a canonical digest of the validated approval records, including slots/people/versions/times. Roles and approval ordering are canonicalized without locale-dependent collation. Material target/tenant/role/approval changes conflict under a previously recorded key; bookkeeping state alone is not a payload change. Digests are not signatures, authenticated approvals or current authority.

Candidates use a private nominal marker/process-local provenance set, copied/frozen operation/scope/role arrays and safe fields only. Original candidates are required to describe simulation bundles; structural/JSON clones cannot be used as command proof. Persisted command rehydration is deliberately not implemented. Scoped lookup hints and receipts are plain allowlisted values and may be compared without reissuing an expired command; they remain internal hints requiring future authenticated caller checks.

## Audit and receipt contracts

Fixed event names are STAFF_CREATE_INTENT, STAFF_ACTIVATE_INTENT, STAFF_SUSPEND_INTENT, STAFF_REVOKE_INTENT, STAFF_REACTIVATE_INTENT, STAFF_DISABLE_INTENT and STAFF_RECOVER_INTENT. Each is explicitly SIMULATION_ONLY, with operation/command/request references, canonical actor/target UUIDs, exact scope, fixed catalogue role codes and supplied epoch-millisecond time. Event IDs bind operation and command digest deterministically. No SUCCESS, STAFF_CREATED, committed mutation or database audit event is fabricated.

Receipts use only `outcome: SIMULATION_RECORDED`, SIMULATION_ONLY, NOT_AUTHORIZED/blockers, operation/command digest, actor/target, scope, event ID and time. Nested values are frozen. Description requires original candidate provenance and a valid time in the request lifetime. Safe receipt comparison checks namespace, actor, expected payload digest, target, scope, event ID, fixed tags and time bounds. Results reconstitute an immutable allowlist so adapter extra fields cannot escape. Existing database audit vocabulary/writer/permissions are untouched and cannot consume these new intents as committed staff events.

## Future atomic boundary and test protocol

The erased interfaces describe the sequence, not a database implementation:

1. Reserve/serialize actor-key namespace and read its receipt under the reservation.
2. Matching existing receipt returns replay; changed payload returns conflict with no additional intent/audit.
3. Stage mutation intent, audit intent and receipt privately, in order.
4. Validate the complete bundle bindings and deadline.
5. Publish the entire simulation tuple atomically and acknowledge it, or return unknown acknowledgement.
6. On precommit failure discard staging; finish/release the reservation on every terminal path.

The test model publishes one immutable tuple in one synchronous Map update, so observers see no tuple or all three records. An earlier operation's history is preserved on later failures. Barriers/promises control concurrency without sleeps or wall-clock reads. Queueing, duplicate calls, conflicting calls and recovery are exercised deterministically.

For a future real adapter, actual staff mutation, audit, receipt and any required outbox must commit on the same checked-out connection/transaction, with uniqueness/CAS/locks, fresh verified actor/assurance/permission/versions and explicit rollback/release. Connection failure during commit can make the outcome uncertain; rollback after such failure is not proof that nothing committed. Rollback failure requires connection discard and reconciliation. None of those PostgreSQL guarantees is implemented or claimed by the in-memory model.

## Uncertain acknowledgement and lookup

The commit contract distinguishes ACKNOWLEDGED_SIMULATION from UNKNOWN with operation ID and mandatory lookup. Test-level outcomes are RECORDED, REPLAYED, REJECTED, FAILED and UNCERTAIN; every one is NOT_AUTHORIZED. FAILED and UNCERTAIN contain no receipt or successful staff result. Lost acknowledgement is tested both with publication and without publication.

Lookup distinguishes RECORDED_SIMULATION, CONFLICT, INVALID_LOOKUP, INVALID_RECEIPT, NOT_FOUND, PENDING and LOOKUP_UNAVAILABLE. A missing receipt explicitly requires reservation before retry; absence alone is not proof that the original operation rolled back. In-flight work reports PENDING, and unavailable lookup cannot resolve uncertainty. A serialized retry reserves the same key and checks again before staging, preventing duplicate tuples. Recorded receipts may be reconciled after candidate expiry without creating another intent; reconciliation is not renewed authorization.

## Acceptance and limits

Tests cover fixed event mapping, immutable/allowlisted values, actor/key namespaces, payload/approval canonicalization, exact staff/tenant/role bindings, forged/cloned contracts, replay/conflict, concurrent duplicates/conflicts, failure after each stage, incomplete/substituted bundles, cleanup/retry, prior history, uncertain acknowledgement, pending/unavailable lookup and expiry while paused. Existing policy/assurance/APPLY denial is retained. Verification records exact commands/results and omissions.

No database connections/writes/migrations or destructive integration tests occur. Existing policy, active permissions, audit writer, identity verifier, API/runtime, database and financial/provider source remain unchanged. In-memory atomicity is not durability, multi-process exclusion, a restart/restore drill or protection against malicious trusted code. Approval provenance, canonical-person mapping, real bootstrap, fresh MFA, real receipts/audit/outbox, idempotency retention and privileged execution remain unimplemented/PENDING. Stop after this increment. Proposed next bounded work: read-only persistence/transaction threat-model and migration acceptance specification, without SQL execution, grants, provisioning or permission activation.
