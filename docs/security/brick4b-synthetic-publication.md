# Brick 4B synthetic approval and publication

This increment builds on b1703d5 and leaves registered migrations, pending 007 and 008 byte-for-byte unchanged. Pending 009 is additive and unregistered. It can run only as the reviewed migrator on a loopback random b3b3 disposable database, after exact registered 001-006 history, submission evidence, explicit BRICK_4B_WORKFLOW_SYNTHETIC configuration, and clean schema/default ACLs. No persistent migration, real identity, production permission, financial execution, HTTP route or external consumer is activated.

## Authority

prepareSyntheticPublicationCommand requires a verifier-registered .invalid human identity, fresh active tenant membership and role grant, and an explicit trusted fixture permission port. Approval requires pricing.approve and PRICING_APPROVER. Activation requires pricing.activate and a synthetic PUBLICATION_OPERATOR role. Rollback requires publication.rollback and that operator role. These gates are separate from globally inactive pricing permissions; existing NOT_AUTHORIZED and acceptedApproval=false evidence never becomes approval. Unknown, conflicted, revoked, expired, wrong-scope or stale authority fails closed. A one-use WeakSet ticket captures the immutable normalized command, internal staff ID, issuer/subject, authority versions, permission, timestamp and command digest. The request cannot supply an actor. Required authorization audit precedes ticket issuance. Ticket authority is checked under the scope lock and again before commit.

## State and atomicity

Scope is tenant ID plus canonical product ID, matching the 4A candidate scope. Evidence-only DRAFT -> SYNTHETIC_APPROVED -> append ACTIVATE event. Rollback appends a new ROLLBACK event referencing a strictly earlier publication for the same tenant/product/candidate, with a bounded reason. It cannot rewrite approval or publication records. Approval rejects its creator. Activation and rollback require an operator distinct from both creator and approver.

009 adds four FORCE-RLS append-only tables: price_workflow_operations, price_workflow_approvals, price_workflow_versions and price_workflow_audit. Dedicated SELECT/INSERT grants allow no mutation, truncation, IAM or raw provider access. Composite foreign keys bind scope, candidate and actor; one approval per candidate and unique scope revision prevent ambiguity. A deferred complete-evidence constraint requires each operation's matching result and audit. Precommit audit failure, omitted audit, failed SQL or stale identity returns no successful receipt and rolls back all writes. A lost commit acknowledgement can leave the operation committed without a returned receipt. Callers retry the identical command with a fresh authorized ticket; the immutable command digest returns the original operation without writing a second event.

All commands take the same transaction advisory lock as draft/submission creation using READ COMMITTED with a fresh post-lock snapshot. Approval and activation require the newest candidate version. Activation/rollback also compare the exact expected active operation ID. Identical actor/key/command retries replay the original receipt; a changed command or actor conflicts. Replay returns the original recorded operation, not a claim that it is still the current head.

The active version is derived as the highest revision in each tenant/product ledger. No mutable active flags or head table exist. A database transition trigger checks the predecessor and next revision while holding the scope lock, so there is exactly one head after the first activation and no head before it. Rollback advances the revision while preserving all previous events.

## Independent financial and provenance checks

The adapter requires 008 evidence plus its audit; legacy drafts cannot enter. It parses the 16-field canonical array, reconstructs the full product, policy, snapshots and offers, and reruns the existing bigint pricing engine. SHA-256 must match the requested candidate and the exact canonical bytes must regenerate unchanged. Every stored financial amount, version, selected source, rounding policy and policy version is compared. The accepted subset requires approved, eligible offers with the shared product identity established by 008. Current product identity, complete snapshots, active accounts and every canonical offer's amounts, timestamps and availability must match the restricted source projections. Both forward activation and rollback require an unexpired candidate and source observation ages within the persisted policy limit at command time. Rollback never makes an expired provider offer valid again.

A narrow SECURITY DEFINER function, explicitly granted only to the synthetic writer, locks source offers/accounts/snapshots/mappings/products FOR SHARE for the exact GUC-bound scope. It returns no data or human authority. It prevents concurrent changes to validated source rows until commit. It rejects unapproved mappings. No generic SQL/pool endpoint is exposed.

## Validation and remaining work

The disposable integration suite covers identity/permission denial, cross-tenant membership and RLS, creator/approver/operator separation, legacy rejection, canonical tampering, stale candidate/head, actor revocation, identical replay, concurrent distinct approvals/activations, audit insert failure, deferred-commit failure on omitted audit, active-head selection and immutable rollback history. Financial, application, database, migration/security/restore, structure and HTTP guard regressions are run separately.

Catalogue APIs remain unimplemented: separately authenticated application/kiosk clients, tenant/catalogue ownership, safe public projection, version-pinned stable pagination, rate limiting, sanitized transport errors and route integration need their own reviewed increment. The synthetic ledger is not exposed to consumers.

## Test runner correction

The first new nested integration test was accidentally registered on its outer test context, causing a test scheduling deadlock before workflow execution. Its 240-second subprocess timeout left the test child and an exact disposable fixture behind. The child process tree was verified by PID/command path and stopped; only nukhabapay_b3b3_a97236bce74c459fb7ed16cca7ca82bf and its generated writer role were removed after checking owner and zero connections. Persistent development data and the unrelated pre-existing disposable database were untouched. The test now uses its own child context and completes normally. No timeout or security check was weakened.

## Acceptance results

Passed: 95 application tests, 19 financial/provider regressions, 8 publication/foundation tests (including the nested workflow acceptance), 18 database regressions, 34 migration/security/restore tests, and 14 HTTP guard/header tests. Structure, frozen migration-source verification, and whitespace checks passed. A final focused publication run passed after the source-age check and monetary rollback test were added: the ledger preserved totals 10200 -> 10300 -> 10200 minor units across three immutable revisions. Both successful acceptance runners verified unchanged persistent 001-003 history, database inventory and generated-role/connection evidence.

GO for isolated synthetic acceptance of these internal workflows. Production approvals/publication, IAM/Auth0 activation, persistent migration deployment, provider execution and external consumers remain disabled. 007 SHA-256 remains c4ed1ef748dabdfeb16cfc8cc40b667cb0106e944c5d97547677671ac064a2c9.
