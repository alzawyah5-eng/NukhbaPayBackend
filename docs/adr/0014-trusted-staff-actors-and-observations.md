# ADR 0014: Trusted staff actors and denied approval observations

Date: 11 November 2026

Status: implemented locally for synthetic acceptance. Accepted approvals, privileged persistence, MFA and operational activation remain BLOCKED.

The owner authorized actor identity/provenance and actor-scoped receipt foundations only. Existing ADR 0013 execution gates and all reserved permission restrictions remain. This decision implements code and PostgreSQL acceptance, not another planning phase.

## Actor trust and freshness

`TrustedStaffActorBoundary` consumes the existing opaque `VerifiedStaffIdentity`; it does not parse tokens, trust headers, link email or enroll anyone. The existing jose verifier remains the signature/profile trust boundary. Exact issuer/subject resolution uses Brick 3A's restricted IAM repository. Each boundary instance keeps a private WeakMap from an empty frozen actor handle to the verified identity, optional tenant scope and snapshot fingerprint. No issuer/subject/token, credentials or arbitrary caller fields appear in the actor's JSON. UUIDs, JSON, cloned handles, identities without verifier provenance and handles from another instance fail closed.

An actor proves resolved identity at establishment, NOT permissions. Before each observation or receipt read, resolve exact identity again, check token expiry, active staff and binding, active exact tenant membership, and compare current authorization version, membership version and grants/status fingerprint. A changed snapshot invalidates the held actor; callers must re-establish and still pass current policy. No positive authorization cache is introduced. Role validity and conflicts for approvals use unchanged `authorizeStaffAccess`; platform roles cannot confer tenant approval authority.

The verifier attestation constructor and injected repositories/policies are trusted server adapter code. This protects against untrusted request data, not malicious code already executing inside the server. No public route accepts these handles or DI ports. Handles are process-local and deliberately cannot be rehydrated from persisted JSON.

## Immutable observations, never accepted approvals

Approval inspection accepts an actor handle and request ID. The request snapshot comes only from a trusted server request-reader port, not request JSON. Validate ID, digest, version, current lifecycle policy version, deadline, scope and fixed approval permission. Reject canonical requester/beneficiary IDs, forged prior observations, mismatched request versions/digests, stale approvers and duplicate canonical staff people, including alternate external identities for the same person.

The boundary can issue an immutable `StaffApprovalObservation` only after verified identity/current grant checks and a committed DENIED authorization audit. It binds the opaque actor, canonical person, request ID/digest/version, policy version, observation time and `assurance=not-established`. It explicitly contains `acceptedApproval=false`, `execution=NOT_AUTHORIZED`, and required evidence for fresh strong MFA, active approval permission and durable approval binding. Observation provenance is instance-local WeakSet membership; a structural clone does not have it. Prior observations are rejection diagnostics, never approvals or quorum evidence; omitting them cannot enable acceptance.

Reserved approval permissions remain inactive. Even an unexpected future ALLOW decision returns EXECUTION_BLOCKED here. Signed client MFA/amr/acr claims do not change the existing verifier assurance. There is no accepted-approval constructor, approval writer, request-state transition or APPLY executor. If authentic approval assurance cannot be established, return denial. Current observations cannot demonstrate complete authentic approval provenance and must never be stored/replayed as accepted authority.

The request-reader port has no production implementation. Test bootstrap supplies synthetic immutable snapshots. Durable requests/approvals, independently authenticated approval storage, canonical-person provisioning rules and fresh MFA evidence remain required before actual approval acceptance. No privileged database path or migration is added.

## Explicit synthetic own-receipt boundary

Default behavior denies receipt access. A separate trusted DI port must explicitly select `NON_AUTHORIZED_RECEIPT_RECONCILE` and approve the freshly resolved context. It is not a permission-catalog entry, does not activate reserved permissions and does not use `staff.self.read`. The local test adapter restricts exact canonical person/tenant by server-owned policy plus current active grant/lifetime checks. Synthetic `.invalid` issuer is mandatory. No runtime composition registers the port.

The caller supplies only opaque actor, bounded UUID key and expected digest. The boundary derives actor/tenant server-side, queries through the adapter, validates returned actor/tenant/key/outcome/execution/digest and copies the row before awaits. It returns only the operation ID, SIMULATION_RECORDED outcome and NOT_AUTHORIZED marker. Foreign actors/tenants, substituted rows and conflicting payloads return no receipt. Missing or unavailable lookup is UNRESOLVED; absence alone cannot prove rollback. Existing ADR 0013 reservation/retry tests remain unchanged.

A committed authorization audit is required before receipt disclosure, followed by fresh actor and access-policy checks. Audit or IAM outages deny. A suspension during lookup is detected before returning the result. These are separate restricted reader/audit-writer transactions, not an atomic staff mutation or a global revocation linearization guarantee. A future privileged command still needs one authoritative transaction for current authority, mutation, audit, receipt and outbox. No claim of that guarantee is made here.

The PostgreSQL fixture adapter uses its existing ephemeral recorder only to read the synthetic artifact tables with parameterized actor/key/tenant predicates and transaction-local RLS scope. IAM resolution and audit use distinct existing restricted roles. Catalogue roles receive no grants. The recorder credential alone still does NOT authenticate or isolate a human actor: never issue it to clients or wire it into runtime. Production authenticated receipt access/least-privilege role design remains blocked on the corresponding durable trust boundary. No RLS or migration changes.

## Verification and remaining gates

Disposable PostgreSQL acceptance combines real synthetic jose verification, restricted IAM lookup, committed audits and persisted non-authorized receipts. It covers forged/cloned/cross-instance actors; exact case-sensitive identity resolution; valid other staff in the same tenant and valid same staff in another tenant; own receipt success under an explicit policy; no-policy denial; suspended staff, revoked membership, stale/revoked grants; self/beneficiary/duplicate-person rejection; cloned observations; stale request/policy; client MFA spoofing; substituted receipts; mid-read suspension; audit and IAM failure. Prior token, HTTP, recovery, privilege and financial tests remain. Exact results are in verification.md.

Brick 3 is not fully complete. MFA assurance, accepted independent approvals, durable authenticated provenance, full privileged migration 005, real onboarding, browser login and operational activation remain BLOCKED/PENDING. Proposed next bounded code: a denied-by-default restricted actor-filtered PostgreSQL receipt-reader adapter with disposable acceptance, without runtime grant activation, public routes or privileged execution. Stop for review; no next increment starts automatically.
