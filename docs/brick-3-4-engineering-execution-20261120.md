# Brick 3 and Brick 4 engineering execution

**Release decision — NO-GO.** This batch continues from the 912-test November 20 baseline. Staff effects were exercised only against a private, disposable PostgreSQL fixture. Live payments, publication and provider execution remain disabled.

## Brick 3

| Canonical capability | Current status | Evidence and gate |
| --- | --- | --- |
| Human token and tenant identity binding | Offline verified | Signed access and ID tokens, issuer/audience/client, canonical person and tenant. Pilot and enrollment acceptance remain external. |
| Session lifecycle | Offline verified | HTTPS/PKCE, rotation, CSRF, revocation and expiry. Effective suspension invalidates a genuine application session backed by canonical PostgreSQL IAM reads. The test session port is in-memory. |
| Scoped read authorization | Offline verified | Existing services verify permissions, tenant and committed audit. New HTTPS tests cover session-bound staff and catalogue forwarding. |
| Trusted local API composition | Offline verified | API suite and optional server-only BFF composition reuse application services and trusted identity. |
| Non-authorized request recording | Offline verified | Existing durable request and cancellation regression. Requests are versioned and immutable and supply the canonical executor input. |
| Independent-person observation boundary | Offline verified | Requester/beneficiary, role and tenant denial are covered in the rehearsal and effective suites. |
| Operational MFA assurance adapter | Implemented contract, operationally blocked | Signed canonical factor event, issuer, subject, session digest and exact command enter the one-use step-up path. Real Auth0 factor semantics and claim profile are external. |
| Durable independently verified approvals | Implemented and verified in the disposable slice, operationally blocked | Append-only decisions bind canonical reviewer, immutable request and version, slot, authority stamp, event and expiry. Quorum and current reviewer authority are rechecked transactionally. Production factor verifier and runtime role composition remain open. |
| Atomic restricted executor and session invalidation on effective changes | Offline verified for tenant membership suspension | Actual canonical membership CAS, session invalidation, audit and receipt. A restricted executor role cannot write IAM directly. Other lifecycle effects and operational activation are outside this verified slice. |
| Approved administration BFF integration | Implemented read forwarding, partial | Existing HTTPS portal reads use the canonical session, with post-read revalidation. Live administrative mutation routes and the accepted runtime handoff remain gated. |

**Progress — 7/10 (70%)** for the existing checklist. The newly credited capability is scoped to effective tenant membership suspension, the command implemented by the existing step-up contract. No operational qualification is inferred.

## Brick 4

| Canonical capability | Current status | Evidence and gate |
| --- | --- | --- |
| Canonical catalogue and immutable snapshot model | Offline verified | Actual importer, latest complete snapshot and source immutability checks. |
| Exact pricing | Offline verified in AE/AED scope | Exact minor-unit arithmetic and draft amount 10,200 in the PostgreSQL adapter test. Broader currency work needs approved FX inputs. |
| Draft persistence and workflow evidence | Offline verified in the disposable scope | Actual draft adapter exercised with restricted roles, tenant-scoped projections, replay, expiry rollback and stale snapshot denial. The guarded 007 install remains pending. |
| Published catalogue and kiosk scope | Offline verified | Existing central API and token-expiry coverage. Live channel, credentials and kiosk coordination remain external. |
| Tenant catalogue read and audit composition | Offline verified | Scoped catalogue service, audit-before-disclosure and optional HTTPS BFF wiring. |
| Advisory isolation | Offline verified | Existing mock advisory, boundary and outbox checks. Real model connectivity still needs authorization. |
| Scheduler/host lifecycle and lease guards | Offline verified | Disposable expiry, stale claim, renewals, retry, minimal-role access, pool exhaustion, stop and forced termination. |
| Reviewed 012 schema/role | Partial | R2 and additive reconciliation verified in PostgreSQL using fixture grants. Exact target worker/reader grants and the guarded downstream schema remain pending. |
| Durable account/clock/transition/reconciliation controls | Partial | Reconciler verifies the stored commit evidence, live transaction, authenticated rollback witness and unresolved quarantine. Automated audited disposition of quarantined jobs on the operational scheduler remains open. |
| Approved administration BFF/frontend integration | Partial | The existing React workspace renders catalogue selection and private results through typed same-origin reads. Approved tenant rollout, full publication action UI and external payment/kiosk handoff remain open. |
| Approved live provider adapters | Blocked on vendor contracts and access | Repository supports synthetic normalized AE/AED catalogue reads. Finxplor Connect, IronGate Digital and SSL Wireless specifications and sandbox configuration are absent from the project. |

**Progress — 7/11 (64%, rounded).** Production provider, kiosk, Auth0 and publication acceptance remain outstanding.

## Implementation and permission boundaries

- **Effective staff execution.** `staff-membership-executor.ts` reuses the canonical lifecycle planner and reads real issuer/subject, active membership, grants, persisted head and recorded decisions in one serializable transaction. A NOLOGIN definer owns only the narrow mutation path. The executor login cannot update IAM or read the fixture handoff key. The function binds the signed handoff to the exact intent and database clock, then changes the membership version, writes canonical audit and persists one receipt. The same authority lock serializes mutations with request and role updates. The runtime startup and frozen staff command gate remain disabled.
- **BFF.** Factor-event verification is a trusted adapter contract with an explicit event ID and factor timestamp. The optional staff/audit/catalogue read routes derive tenant and identity from the verified server session and check the session again before disclosure. The approved workspace pattern is reused for region, country, service, provider, product, exact amounts and publication history. No browser-supplied authorization or tenant selects a backend scope.
- **Refresh.** The reader and writer have separate fixture roles. Commit evidence must match the exact account, schedule, job, attempt, resource and token. An opaque in-process witness proves the transaction identity for a rollback conclusion. After restart, exact committed evidence can be recognized without that witness; otherwise recovery records quarantine. Reconciliation observes and audits rather than unilaterally renewing or settling leases.
- **Publication delivery.** A PostgreSQL trigger emits immutable version-only events in the same transaction as publication rows. The delivery worker orders by tenant/product revision, uses bounded retries and leases, and reuses a stable event ID. The separate recovery role requires a verified recipient receipt to resolve a terminal delivery. Existing central catalogue readers supply prices and channel authorization. There is no active dispatcher to an external client.
- **Historical IAM and guarded publication.** Exclusive local binds to both `127.0.0.1:5432` and `[::1]:5432` failed with Windows error 10048. The workstation has no available isolated PostgreSQL namespace that satisfies both original guards. The prior IAM test reached `004_identity_default_acl_preflight.sql` and was rejected because the private cluster uses a random port. The actual draft adapter was tested with a separate projection fixture. The frozen 007/009 guards were preserved.
- **R6.** All 29 drifts reconcile to nine documented source changes, 18 reproducible generated artifacts and two stale or unexplained generated artifacts. The original archive and manifest were preserved. Five of the original six skipped cases passed on private PostgreSQL. IAM remains the sixth case. See the November 20 continuation for the original evidence and named tests.

## Local reproduction

Run `pnpm.cmd development:test:offline` before the confirmed disposable PostgreSQL cases below.

- `python scripts/test/refresh-012-isolated.py --effective`
- `python scripts/test/refresh-012-isolated.py --workers`
- `python scripts/test/refresh-012-isolated.py --publication`
- `python scripts/test/refresh-012-isolated.py --workers-only 180`
- `python scripts/test/refresh-012-isolated.py --legacy` preserves the historical IAM port failure.
- `python scripts/reconcile-r6-offline.py` reproduces the R6 successor without changing archived pins.

## Verified results

| Verification | Pass | Fail | Skip | Evidence |
| --- | ---: | ---: | ---: | --- |
| Full offline validation | 914 | 0 | 0 | [All 25 steps](../.local/master-development-offline-1795156300986/results.json). The two added tests cover replay of a signed factor event and scoped HTTPS forwarding. |
| API and browser subsets | 51 API, 269 staff HTTPS, 56 browser boundary | 0 | 0 | Included in the offline total. React typecheck and Vite bundle passed. |
| Effective staff PostgreSQL | 8 | 0 | 0 | [Effective execution log](../.local/012-r2-offline-r9gn027a/integration.log). Includes stored approval, real mutation, session lifecycle invalidation, rollback, concurrent execution, late cancellation denial and signed BFF proof. |
| R2 fixture and worker PostgreSQL | 1 SQL scenario and 12 tests | 0 | 0 | [Worker log](../.local/012-r2-offline-e9fl3t02/integration.log) and [R2 rollback log](../.local/012-r2-offline-e9fl3t02/fixture.log). |
| Publication outbox PostgreSQL | 5 | 0 | 0 | [Outbox log](../.local/012-r2-offline-i55a172m/integration.log). Recovery after four failed acknowledgements uses one durable recipient receipt. |
| Concurrent storage soak | 11 | 0 | 0 | [180.036-second soak log](../.local/012-r2-offline-32ezg_y3/integration.log). Three workers and three tenants, 3,895 rounds, 11,685 successful jobs and committed fences, no duplicate or unprocessed jobs, 23,370 losing claims, six peak connections and nine peak waiters. Heap delta 37,818,520 bytes, which includes test bookkeeping. |
| Historical catalogue, IAM and migration with fenced import | 7 | 1 | 0 | [Legacy result](../.local/012-r2-offline-geqqbcgk/legacy.log). IAM remains blocked at the original port guard. |
| Original R6 verifier | 475 archive pins | 29 drifted pins | — | [Original verifier receipt](../.local/runtime-qualification-1795156211582/manifest.json), exit 1 as expected. |
| R6 successor | 254 rebuilds and 2 expiry checks | 0 | 0 | [Successor manifest](../.local/r6-reconciliation-1795155975929666500/manifest.json). |

The acknowledgement-loss fixture commits on PostgreSQL before suppressing the response to the caller. It validates the application's uncertainty handling and durable observation. Transport-level testing and representative-host pipeline acceptance remain pending. All private PostgreSQL processes were shut down and their disposable data directories removed. The [file manifest](../.local/master-engineering-execution-changes.json) records the exact before and after hashes.

## Remaining engineering and external dependencies

- Extend the restricted effect path to any additional approved lifecycle operations. Finish production-eligible approval, MFA and BFF command admission once the real factor-event contract and scoped roles are available. Keep the effective command feature disabled until the scope passes authorized acceptance.
- Qualify the original IAM and guarded 007/009 publication chain in an isolated environment with an exclusive loopback port 5432. After role acceptance, exercise lost acknowledgements and audited disposition against the full scheduler, draft, activation and outbox chain.
- Obtain the versioned provider specifications, auth and paging policies, schemas, availability and price fields and approved read-only sandbox credentials. Complete kiosk and payment integration once client credentials, scope and frontend handoffs are approved.
