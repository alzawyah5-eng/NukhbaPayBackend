# ADR 0019: Secure internal staff request and review reads

Follow-on, 12 November 2026: ADR 0020 implements the next authorized gated approval intake using existing blocked synthetic evidence, with strict stored-profile reconciliation and no schema/grant changes. This read implementation and its privacy/authority boundaries remain unchanged; accepted approval, MFA/APPLY and real activation are still blocked.

Date: 12 November 2026

Status: implemented for verified local synthetic actors and disposable PostgreSQL only. No deployed registration, real staff, operational MFA, accepted approvals or APPLY.

The owner authorized one functional increment after migration 005, then review. This implements request detail/status, revision history and review history through the existing opaque actor boundary. It does not activate any reserved permission or widen existing credentials.

## Authority and visibility

`TrustedStaffActorBoundary.readStaffWorkflow(actor, input)` reuses the original instance-private actor registry. Fresh exact issuer/subject resolution, active staff/identity/membership, token lifetime and unchanged authorization fingerprint are required. JSON/UUIDs/clones, actors from another boundary and stale authority cannot substitute. No positive authorization cache or email linking.

The optional trusted DI port must explicitly select `NON_AUTHORIZED_STAFF_WORKFLOW_READ` and allow the current context/query. It defaults absent/denied. `staff.self.read` grants no access. Existing `authorizeStaffAccess` checks current grant lifetime, role conflicts and scope: platform requesters need request/containment eligibility; platform reviewers need approval-role eligibility; tenant participants need matching active tenant request authority. Platform roles do not confer tenant access. Only the existing PERMISSION_INACTIVE eligibility outcome is accepted by this isolated artifact path; it never converts a reserved permission to ALLOW. An unexpected operational ALLOW also fails this synthetic gate. Trusted identity issuer must remain `.invalid`.

Every query requires one exact request UUID, an owned operation ID, and an explicit REQUESTER/REVIEWER view. Caller-supplied actor, tenant or MFA fields cannot create authority. The actor supplies canonical staff and exact tenant/platform scope server-side; input `view` is only a requested projection, never proof of participation.

| View | Required anchor | Permitted visibility |
| --- | --- | --- |
| REQUESTER | The canonical actor's SUBMIT operation, bound to the same request/version/scope and submission record | This request's immutable revisions and latest head; redacted independent review observations for this request. |
| REVIEWER | The canonical actor's REVIEW operation, bound to the same request/version/scope and own non-approved observation; actor is neither requester nor beneficiary | Only versions this person has observed, latest visible participated version, and this person's own review observations. Peers and later unobserved revisions are excluded. |
| Beneficiary or unrelated staff | No implicit access | Denied even with a known request ID/another person's operation ID or an otherwise eligible role. |

Alternate verified identities resolve to the same canonical person for ownership. A review operation cannot masquerade as a submission. These are participant-scoped reads, not a pending-review queue or prospective reviewer assignment system. There is no listing/search/enumeration operation and no implicit administrator override.

## Contracts and safe output

Application contracts are in `identity/staff-workflow-read.ts`; the existing actor boundary alone issues one-use `AuthorizedStaffWorkflowRead` tickets registered privately. The exported consumer can validate/consume, never attest/mint. Tickets are valid only during the in-flight read, bounded to five seconds/original token expiry, with a fresh authority/policy callback. They are deleted on every exit; JSON, clones and replay reject before database access.

Kinds: DETAIL (optional exact version), STATUS, REVISIONS and REVIEWS (optional exact version). UUID/hash/version/limit inputs are bounded and normalized to a copied allowlist. Page size defaults ten, maximum twenty-five. Missing/unauthorized/invisible records share READ_DENIED with no identifiers/data/cursor; dependency failures return fixed UNAVAILABLE. Valid requests with no observations return an audited empty review list.

The output allowlist contains request ID/view, visible head, persisted SUBMITTED state, server-derived SUBMITTED/EXPIRED status and head expiry. Expiry is a read projection, not a database state transition. Details/revisions contain exact version, target UUID, normalized lifecycle operation, role intent, immutable request/parent digests, expected target versions, fixed policy version and creation/expiry. Digests/versions identify immutable intent for later CAS; they are not approval or mutation authority.

Review summaries contain only version, observation time, acceptedApproval=false and assurance=not-established. Requesters receive no peer person/operation IDs; reviewers receive no peer records. No issuer/subject, contact, raw payload, idempotency key, authority snapshot digest, challenge/event/key metadata, assertion or privileged approval evidence is returned. Safe result copying validates bindings/times/scopes/bounds and freezes nested operations/role arrays before subsequent awaits. Unknown adapter fields are dropped; substituted bindings or malformed pages deny.

Histories use private keyset positions. Continuations are frozen empty process-local handles in an instance-private WeakMap, bound to exact actor handle, request, owned operation, view, kind/version/limit and first visible head. They expire within sixty seconds/original token expiry and are consumed once. No serialized peer ID/operation key is exposed; copied/replayed/cross-actor/changed-query cursors deny. New immutable revisions do not enter an existing cursor's pinned head. Each page is independently authorized/audited and uses its own consistent snapshot. Concurrent appended reviews may require a fresh scan to obtain a new complete view; no cross-page database snapshot/session is retained.

## PostgreSQL boundary

`createStaffWorkflowReader` uses one isolated explicit connection configuration; it requires no importer/migration/IAM credentials. It accepts only generated `nukh_history_<20 hex>` logins on loopback 5432 and an exact `nukhabapay_b3b3_<32 hex>` target. Fixed pool maximum two, bounded connection/statement/query/idle-transaction timeouts and read-only default. Startup verifies actual database/user, no superuser/CREATEDB/CREATEROLE/INHERIT/BYPASSRLS/membership/ownership, no CREATE/TEMP, no missing/excess table/column rights and ENABLE/FORCE RLS on all three tables. Unexpected view/materialized/foreign-table rights or callable module functions reject startup. The only inherited module-function exceptions are the three pre-existing invoker trigger-only functions from 001/004; they cannot be called as ordinary functions and no TRIGGER/DDL privilege is granted. The two 005 functions remain inaccessible.

Owner-operated `roles/grant_staff_workflow_reader.sql` requires a verified disposable target/history and already provisioned restricted login, inside a transaction. It creates no account, policy, view or function and changes no existing principal. Exact SELECT-only matrix:

| Table | Columns |
| --- | --- |
| staff_request_operations | operation_id, actor_staff_id, request_id, request_version, scope_key, kind, execution (7) |
| staff_access_requests | request_id, version, requester_staff_id, target_staff_id, tenant_id, scope_key, roles, created_at_ms, expires_at_ms, policy_version, state, payload, submission_operation, execution, request_digest, previous_digest, expected_authz_version, expected_membership_version (18) |
| staff_review_observations | operation_id, request_id, request_version, reviewer_staff_id, scope_key, observed_at_ms, assurance, accepted_approval, execution (9) |

Total 34 columns, not table-wide SELECT. `payload` is required to extract the normalized operation; PostgreSQL column ACLs cannot grant only a JSON subfield. Actual queries select only `payload->'operation'`, and the application copies only its fixed operation fields. The backend credential therefore remains trusted server custody, never a human credential. No IAM, catalogue, security-audit, synthetic-provenance, receipt/outbox or authority-digest reads; no writes, TRUNCATE, REFERENCES, TRIGGER, command execution or new role membership. Existing IAM reader/audit writer/catalogue/importer grants are unchanged. No migration or schema change is needed.

All reads consume a ticket, revalidate, then run parameterized anchor/visibility/head/detail/history queries on one checked-out connection in REPEATABLE READ READ ONLY. Transaction-local workflow scope protects all three existing FORCE-RLS tables. Every query binds exact actor/request/scope/operation and visibility; rows cannot enumerate unrelated requests or disclose another person's operation. COMMIT is checked; rollback failure or socket errors discard the client. Idle errors are sanitized; close is idempotent. No raw errors/configuration or tokens are logged.

The existing restricted IAM infrastructure performs fresh actor/authority checks, and the existing separate audit writer must commit the fixed AUTHORIZATION_DECISION audit before successful disclosure. Fresh actor/grant/policy checks occur again after lookup and audit. Audit/IAM unavailability, suspension during lookup and policy revocation during audit deny without data. These are separate read/audit transactions, not a globally linearized revocation or privileged mutation guarantee. Database credentials and mutable RLS scope authenticate/constrain a trusted workload, not a human; a stolen credential could inspect permitted columns within selectable scope. The opaque actor/ticket, explicit read policy and query predicates enforce human access. Nothing is registered in deployed runtime.

## Acceptance and next step

Real disposable PostgreSQL and existing ephemeral jose-verifier identities exercise all four operations, participant/tenant/operation isolation, bounded opaque paging, expiry/status, empty/missing records, forged/retained tickets and actors, stale/suspended/revoked/conflicting/expired authority, safe DTO copying, committed audit, actual IAM/audit privilege failure, excessive column/view/function grants, connection termination/recovery and cleanup. A temporary SECURITY INVOKER advisory latch in an additional restrictive SELECT policy pauses only the test reader; it proves a concurrent revision commits while the in-flight read retains its earlier snapshot. The extra policy/function grant is removed immediately; it cannot widen the original scope policy and is never production code. Existing recovery, migration, auth, financial and Python regressions remain required. Exact results/files/commands are in verification.md.

This bounded read functionality is complete locally; Brick 3 overall is not. Accepted privileged approvals, quorum/APPLY, effective staff/grant changes, reserved permissions, real Auth0/MFA/employees, deployed endpoints and non-disposable migrations remain BLOCKED/PENDING. Original migrations 004/005 and development history 001–003 are preserved.

Next direct implementation proposal: gated approval-intake persistence/orchestration with exact actor/request/version/policy/authority binding and atomic audit/receipt/outbox. Synthetic or absent assurance must produce a blocked/rejected outcome; no accepted approval or lifecycle mutation until independent approved strong-authentication provenance and owner authority are demonstrably satisfied. Implement the safe blocked path and rejection/concurrency/recovery tests, rather than another reader/planning phase. Real acceptance and controlled execution remain security-gated. Stop for owner review before that increment.
