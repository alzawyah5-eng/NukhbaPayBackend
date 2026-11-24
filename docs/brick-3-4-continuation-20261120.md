# Brick 3 and Brick 4 continuation, 20 November 2026

**Release decision — NO-GO.** Main is based on `bf78627a009a763f828eab7e681197566a9acfbe`. Changes in this batch are local. This report measures the existing checklist out of 10 and 11 capabilities. A change can be implemented and verified offline while a capability remains incomplete.

## Brick 3

| Capability | Implementation and local evidence | Operational gate or remaining dependency |
| --- | --- | --- |
| 3.1 Human token and tenant identity binding | Complete offline. Signed issuer, audience, client and human principal checks bind a canonical person and tenant. `auth0.spec.ts`, token and staff-administration tests. | Qualify the selected pilot authority and real staff enrollment. |
| 3.2 Session lifecycle | Complete offline. PKCE, nonce/state, server cookie rotation, revocation, CSRF and async expiry. Staff HTTPS and browser-boundary suites. | Run pilot login, logout, revocation and asynchronous expiry on the authorized target. |
| 3.3 Scoped read authorization | Complete offline. IAM supplies current authority, and audit must commit before disclosure. Staff and catalogue admission and API tests. | Verify target identity/workload roles and read permissions. |
| 3.4 Trusted local API composition | Complete offline. Staff and catalogue services use the canonical actor, scoped readers and audit. API tests. | Verify approved BFF and target runtime composition. |
| 3.5 Non-authorized request recording | Complete offline. Version/digest and idempotency persist. A requester can close the exact current request in the disposable rehearsal. The request lock excludes concurrent decisions and execution. | Maintain the non-authorized scope. Any operational workflow needs its own IAM and audit acceptance. |
| 3.6 Independent-person observation boundary | Complete offline. Canonical reviewer, requester and beneficiary separation is verified in the staff rehearsal and intake tests. | Operational decision authority remains under 3.8. |
| 3.7 Operational MFA assurance adapter | Partial. BFF step-up binds issuer/subject via canonical session, tenant, target, operation, request ID/version/digest, approval digest, permission, expiry and idempotency key. Opaque proof is one-use. Returned revalidation checks authority and expiry after asynchronous work. | Select and qualify provider-issued factor-event semantics and wire a server-only factor verifier and persisted-intent policy. The fixture supplies a mock verifier and proves the contract. |
| 3.8 Durable independently verified approvals | Partial. Synthetic decisions bind current reviewer and immutable request, enforce separate people and slots, and veto a cancelled request. PostgreSQL rehearsal verifies atomic decisions and replay. | Persist verified operational MFA provenance under the restricted decision role and validate tenant policy and quorum against current authority. |
| 3.9 Atomic restricted executor and session invalidation on effective changes | Partial. Serialisable rehearsal persists one receipt/audit bundle for concurrent retries and rolls back on audit failure. Cancellation is serialised with rehearsal. | Implement the effective canonical membership/staff mutation, session invalidation, verified command handoff and committed audit under the restricted authority; validate commit-uncertainty recovery. |
| 3.10 Approved administration BFF integration | Partial. Existing browser session/profile and guarded API reads pass local browser/API tests. Step-up is source-level server composition. | Wire CSRF-protected, session-bound administrative forwarding and run the desktop/mobile flow after the capability and target permissions are approved. |

## Brick 4

| Capability | Implementation and local evidence | Operational gate or remaining dependency |
| --- | --- | --- |
| 4.1 Canonical catalogue and immutable snapshot model | Complete offline. Canonical products, mappings, offers, immutable snapshots and latest-complete selection. Disposable worker and catalogue import tests. | Confirm against the future approved provider feed and runtime roles. |
| 4.2 Exact pricing | Complete offline within configured AE/AED domain. Integer minor units, rounding, fee and margin tests. | Any multi-currency extension needs approved FX inputs, age bounds and pricing policy. |
| 4.3 Draft persistence and workflow evidence | Complete offline in existing synthetic scope. Worker draft save now binds lease and latest complete snapshot to the matching account. Existing workflow and rollback tests. | Qualify the exact draft writer role and guarded migration 007, and complete operational publication and delivery proof. |
| 4.4 Published catalogue and kiosk scope | Complete offline. Tenant/channel scoping, backend-controlled publication, immutable versions and signed expiry recheck. API and R6 expiry regressions. | Qualify scoped kiosk and payment clients, token expiry/rotation, isolation, throttling and external publication configuration. |
| 4.5 Tenant catalogue read and audit composition | Complete offline. Scoped current-offer, private-price and audit-before-disclosure tests. | Verify workload grants and the approved staff BFF. |
| 4.6 Advisory isolation | Complete offline. Mock fallback, bounded admission, fenced result and advisory outbox. No advisory permission can affect prices, IAM or publication. | Any real model adapters require authorized runtime configuration and data handling evidence. |
| 4.7 Scheduler/host lifecycle and lease guards | Complete offline. Disposable PostgreSQL covers clock skew, retries, expiry, lease renewal, shutdown and worker termination. | Qualify on a representative approved target with multi-process provider reads, pool telemetry and lost-acknowledgement injection. |
| 4.8 Reviewed 012 schema/role | Partial. R2 and the separate addendum run on private PostgreSQL. Rollback-only SQL confirms key, role/scope, transitions and audit. | Finalize exact restricted roles, target/migration preflight and status-reader scope. Register and apply only under a separate operational decision. |
| 4.9 Durable account/clock/transition/reconciliation controls | Partial. New open/deferred write check binds current job token/attempt, scope, schedule and account. Forced termination and expired transactions roll back and park the uncertain job. | Complete the authorized, audited reconciliation path, production draft and publication composition, and ambiguous commit acknowledgement qualification. |
| 4.10 Approved administration BFF/frontend integration | Partial. Existing admin React build and read API contract pass. | Integrate the approved UI with trusted BFF and real authorized staff/price routes. The payment and external kiosk projects require their approved handoffs. |
| 4.11 Approved live provider adapters | Partial. AE/AED synthetic read/normalization and exact pricing contracts exercise the centralized path. | Obtain actual versioned Finxplor Connect, IronGate Digital and SSL Wireless specifications. Confirm eligible endpoints, schemas, auth, paging, retry, rotation and idempotency, then run approved read-only sandboxes. |

The unchanged capability names and denominator come from the November 19 reconciliation. Scores remain **6/10 (60%)** and **7/11 (64%, rounded)**.

## Security, permissions and data boundaries

| Boundary | Code and current authority |
| --- | --- |
| BFF step-up | `apps/admin-web/src/auth0.ts` requires trusted server policy and factor-time verifier. Signed ID/access tokens must match through the nonce, subject, access-token hash and captured transaction. The BFF parses signed MFA evidence and caps it at the earliest factor, command, transaction and credential expiry. No runtime path configures these step-up ports. |
| Staff decision/execution | `durable-staff-request-store.ts` preserves existing rehearsal scope. The cancellation table is FORCE RLS and append-only with exact requester/target/version/digest FKs. Only the bound actor with current authority may record it. Staff command SQL and inactive permissions still deny effect. |
| Worker claims and writes | `012_catalogue_refresh_write_fence_PROPOSAL.sql` retains the R2 lease lock namespace. It checks DB time at write entry and with a deferred constraint before PostgreSQL commits. The composed writer uses a separate tenant/account lock to serialize import and draft snapshot selection. Tenant context is from explicit backend composition and the SQL role remains a trusted workload boundary. |
| Financial and publication controls | Exact money arithmetic, immutable draft/price versions, disabled publication and advisory-only AI use existing implementations. The fenced writer cannot invoke publication. |
| Outbox | Existing AI advisory outbox has durable identifiers, authorization, retry and reconciliation tests in `ai-outbox.test.ts` and `ai-job-store.spec.ts`. Existing draft creation persists its event in the same transaction. The enabled publication dispatch pipeline, restart/delivery acknowledgement against a real consumer and an end-to-end publication outbox test remain engineering work. |
| Credentials and API | No new browser role/tenant claim, public endpoint, token storage, kiosk entitlement or provider configuration. Existing central contracts are under [API](api/) and the approved target requirements are in [qualification runbooks](runbooks/qualification/). |

## Historical and R6 disposition

The original sources are in the Brick 4 worktree's November 19 R6 `decision-record.json` and `six-skipped-tests.json`. The original qualification verifier still rejects 29 mismatches. The established offline successor process classifies nine documented source changes, 18 generated artifacts reproduced and two stale or unexplained compiled artifacts. The affected published catalogue JavaScript lacked a post-lookup token-expiry check. The successor reproduced 254 compiled files, verified 475 archive pins and ran two focused expiry tests. Runtime authorization remains separate.

| Finding | Correction and available regression evidence |
| --- | --- |
| F1 Source-session loss | Revocation and quarantine in the managed AI source/fixed session controls. Offline worker lost-source, rollback and quarantine cases. |
| F2 Final ownership | Recheck ownership/generation at commit or before the result can be used. Worker tests for revocation during work/cleanup and stale receipt denial. |
| F3 Checkout revocation | Revalidate current ownership per use, including delayed outbox delivery, in session/control store. Worker and application outbox tests. |
| F4 Setup counted in the transaction deadline | Original R6 uses one absolute deadline, includes BEGIN and setup, and reserves cleanup time. Controlled slow setup, abort and rollback/cleanup tests are in the Brick 4 record. Managed target timing and native cancellation are still pending. |
| F5 Bounded diagnostic watchdog | R6 preserves native deadlines and a 15/15 diagnostic result alongside the prior failed run. Current successor validation preserves the archive. Native diagnostics were not rerun against the managed target. |

The six original skipped cases were selected explicitly in the private-cluster run. Catalogue replay/concurrency/ownership, documented CLI import, catalogue rollback, migration permissions/ownership and migration repeatability/rollback passed. The IAM role resolution and audit rollback scenario was attempted and was denied by `004_identity_default_acl_preflight.sql` because the disposable harness uses a private random port. This result does not qualify the IAM assertion suite past that preflight. The prerequisite must be exercised on an authorized isolated target that satisfies the original guard.

## Verification

| Check | Passed | Failed | Skipped | Evidence |
| --- | ---: | ---: | ---: | --- |
| Complete offline validation | 912 | 0 | 0 | All 25 steps in [.local results](../.local/master-development-offline-1795154386389/results.json). Two new OIDC tests and one new durable refresh composition test account for the change from 909. |
| API and browser | 51 API, 267 staff HTTPS, 56 browser boundary | 0 | 0 | Counts are included in the 912. React typecheck and production bundle built. |
| Other offline suites | 159 application, 28 database, 74 worker, 23 domain/provider, 217 Auth0 tooling, 7 inactive activation, 30 Python AI | 0 | 0 | Counts are included in the 912. |
| Staff on disposable PostgreSQL | 6 | 0 | 0 | Signed synthetic decisions, duplicate receipts, audit rollback, stale or wrong tenant, and the cancellation race. |
| R2 SQL rollback fixture | 1 | 0 | 0 | [SQL fixture log](../.local/012-r2-offline-r9wcja_k/fixture.log). |
| Workers on disposable PostgreSQL | 9 | 0 | 0 | [Worker integration log](../.local/012-r2-offline-r9wcja_k/integration.log). Includes stale replacement, killed process, account and tenant mismatches, and latest complete snapshot. |
| Historical catalogue, migration and IAM plus fenced importer | 7 | 1 | 0 | [Historical regression log](../.local/012-r2-offline-_i9g_snz/legacy.log). Five of six historical skipped tests passed. IAM preflight denied the random port. Actual fenced importer passed active claim, idempotent replay and in-transaction expiry rollback with the canonical catalogue schema. |
| R6 historical pin check | 475 archive pins | 29 source/build drift | — | [Historical verifier receipt](../.local/runtime-qualification-1795154226481/manifest.json), exit 1. |
| R6 reproducible successor | 254 repeated build files, 254 staged files, 2 expiry tests | 0 | 0 | [Successor manifest](../.local/r6-reconciliation-1795153580638068700/manifest.json), SHA-256 `49a9a01a6a8061ddb66edd0664d45e036ebd129d7aa0751ac1824f93e5e1a1b0`. All eight logged historical test-group hashes and byte lengths matched the [historical record check](../.local/master-20261120-historical-checks.json). |
| Auth0 operational MFA, provider sandboxes, kiosk and live publication | — | — | — | Pending separate authorized acceptance. |

The full runner verified the frozen migration manifest without a database connection. The independent catalogue and staff test runners created private PostgreSQL clusters, verified their data directories and used restricted fixture roles. The fenced draft is wired in the application and database code. Its database qualification against the guarded publication schema remains open. A simulated database connection failure before COMMIT proved rollback. Losing the acknowledgement after a server commit still needs a separate failure fixture.

## Remaining acceptance sequence

1. Close the Brick 3 engineering gap with the canonical tenant membership executor, current approval and factor handoff, target session invalidation, immutable receipt and audit in one transaction. Test rollback, contention and uncertain acknowledgement on a private target. Use the [Auth0/MFA package](runbooks/qualification/auth0-mfa.md) for actual factor evidence when an approved pilot issuer and endpoint are available.
2. Finalize the catalogue runtime role and audited quarantine reconciliation. Exercise the guarded draft migration on a verified dedicated target that satisfies its prerequisites, and confirm production candidate, publication and outbox transaction/restart behavior. Use the [PostgreSQL package](runbooks/qualification/postgresql.md) and [worker package](runbooks/qualification/worker-soak.md). The local commands are `python scripts/test/refresh-012-isolated.py --workers` and `python scripts/test/refresh-012-isolated.py --workers-only 180` after compilation through the offline suite.
3. Wire the approved admin BFF frontend to the existing [central API contracts](api/staff-management-catalogue.md). Scope external payment/kiosk credentials through the [kiosk package](runbooks/qualification/kiosk-access.md) only after client onboarding. Obtain the missing vendor contract revisions and use the [provider sandbox package](runbooks/qualification/provider-sandbox.md) for explicitly approved read-only scopes.
4. Keep release NO-GO until development and operational acceptance are evidenced for the affected capabilities. Any database, provider or deployment authorization must match the exact target and current artifact.

## Disposable soak

The 180-second concurrent storage soak completed with 10 PostgreSQL tests passed, zero failed and zero skipped. Three workers competed across three tenant fixtures over 4,145 rounds. The database recorded 12,435 succeeded jobs and 12,435 committed fence rows, with no duplicate or unprocessed jobs. The workers observed 24,870 losing claims, six pooled connections at peak and nine peak pool waiters. The sampled heap delta was 9,907,152 bytes. This measurement by itself cannot establish a memory trend. Expiry, rollback, restart, shutdown and forced termination ran as separate cases in the same suite. See the [180-second log](../.local/012-r2-offline-6jjktne3/integration.log).

An earlier concurrent attempt stopped on the unchanged PostgreSQL statement timeout during settlement while builds were running. The evidence is retained in the [failed run](../.local/012-r2-offline-s6e2cajd/integration.log) and [PostgreSQL log](../.local/012-r2-offline-s6e2cajd/server.log). The successful repeat verifies the bounded local storage workload. A host-wide, long-running workload with provider latency, publication outbox retries and loss after acknowledged server commit remains unqualified.

The [final staff fixture log](../.local/012-r2-offline-38qwh0jq/integration.log) records the six staff tests. The focused compiled OIDC suite passed 14 tests, the draft connection cleanup suite passed two, and the synthetic provider read contract passed one. These focused tests overlap the offline totals.

## Exact changed files

The [changed-file manifest](../.local/master-20261120-changes.json) records prior and current SHA-256 values against the worktree inventory taken before editing. The [capability inventory](../.local/master-20261120-capability-inventory.md) records the initial gaps and validation criteria. Generated evidence stays under the ignored `.local` directory.
