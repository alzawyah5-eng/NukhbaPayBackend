# Brick 3 and Brick 4 final engineering continuation

**Operational release — NO-GO.** This batch advances the November 20 baseline of 914 passing tests and 25 validation steps. The updated local result is 917 passing tests and 25 validation steps.

## Brick 3

| Canonical capability | Status and evidence |
| --- | --- |
| Human token and tenant identity binding | Offline verified. Existing signed ID/access token validation and canonical issuer, subject and tenant binding. |
| Session lifecycle | Offline verified. Effective suspension uses the existing persistence code against a separate private schema projection and writes a durable revocation event. |
| Scoped read authorization | Offline verified. Staff, audit and catalogue reads reuse the central permission and committed-audit services. |
| Trusted local API composition | Offline verified. HTTPS tests and the injected BFF reuse the existing canonical IAM and administration services. |
| Non-authorized request recording | Offline verified. Versioned request and cancellation records feed command admission without conveying effect authority. |
| Independent-person observation boundary | Offline verified. The effective and rehearsal suites cover requester, beneficiary and revoked-reviewer denials. |
| Operational MFA assurance adapter | Provider-neutral factor-event contract implemented and fixture verified. The Auth0 pilot's accepted factor claims and authority evidence remain unavailable. |
| Durable independently verified approvals | Quorum and current reviewer authority are checked at both command preparation and execution. Disposable approval storage and negative cases passed. Operational decision admission requires verified factor provenance and runtime role composition. |
| Atomic restricted executor and session invalidation on effective changes | Offline verified for tenant suspension. Membership CAS, scoped durable revocation, audit and receipt commit as one transaction. Audit failure rolls them all back. |
| Approved administration BFF integration | Offline verified for the implemented tenant workflow. HTTPS admission requires CSRF and a current session, resolves the exact request, redirects through signed step-up, and consumes confirmation once. Runtime startup has no effective command composition. |

**8/10 (80%) offline verified in the implemented tenant scope.** Canonical platform staff suspension and platform session revocation remain reserved under the existing permission catalogue. Their effective execution paths are not started. None of the new capabilities has operational acceptance.

## Brick 4

| Canonical capability | Status and evidence |
| --- | --- |
| Canonical catalogue and immutable snapshot model | Offline verified. Latest-complete snapshot, actual fenced import and actual draft writer tests. |
| Exact pricing | Offline verified in configured AE/AED scope. Minor units are exact. The React views display backend decimal strings. |
| Draft persistence and workflow evidence | Offline verified in the private projection fixture. The adapter commits the candidate, source, request and audit together. The original guarded installer still requires its exact target. |
| Published catalogue and kiosk scope | Offline verified for central API scopes and R6 expiry regressions. Payment and kiosk runtime authorization remain external. |
| Tenant catalogue read and audit composition | Offline verified. Tenant policy and audit-before-disclosure govern the BFF. |
| Advisory isolation | Offline verified. AI remains advisory and has no financial or publication authority. |
| Scheduler/host lifecycle and lease guards | Offline verified for contention, renewal, database-clock expiry, termination, pool exhaustion and safe shutdown. |
| Reviewed 012 schema/role | Reconciliation and disposition applied in private PostgreSQL with restricted fixture roles. Operational grants and downstream guarded schema qualification remain blocked. |
| Durable account/clock/transition/reconciliation controls | Offline verified. Transport-level COMMIT response loss, rollback, in-flight and uncertain outcomes, audited quarantine skip and successor claim passed. The old slot remains recorded and cannot replay. |
| Approved administration BFF/frontend integration | Implemented catalogue reads, search, pagination, source freshness and authorized pricing in the existing React workspace. Privileged publication UI, browser-rendered acceptance and external client handoffs remain open. |
| Approved live provider adapters | Blocked on vendor contracts and sandbox access. The versioned synthetic loopback contract passed. |

**8/11 (73%, rounded) offline verified.** The guarded provider-snapshot-to-published-catalogue chain remains blocked on the exact database target.

## Database target and permission boundaries

Windows listener metadata identified postgres.exe PID 21776 on both 127.0.0.1:5432 and [::1]:5432. The process parent was pg_ctl.exe PID 13400, the running postgresql-x64-18 service. No SQL connection was made to that instance. Neither listener nor service was stopped or reconfigured. Docker and Podman commands and the Windows Sandbox binary were unavailable. The WSL command did not expose a usable Linux instance.

The original installers require the loopback listener, migration owner, generated database name, reviewed history and role/default-ACL conditions. The 009 publication gate requires IPv4 loopback. The exact prerequisite is a separate authorized PostgreSQL namespace with exclusive access to the guarded listener, expected migration owner and schema history. The existing host service is unsuitable as a disposable target.

The private random-port fixture verifies the actual PostgreSQL process and data directory. The session fixture reuses the real SQL transactions and tickets with an independent role bound to the private staff-effect schema. The original guarded 006 installer remains intact. The publication delivery fixture uses a projection of publication versions. The guarded 007/009/010 chain remains unchanged and unexecuted.

Audited quarantine disposition requires a persisted observation for the exact tenant, schedule, version, slot and lease. PostgreSQL supplies the operator role and timestamp. The separate worker role cannot append disposition evidence or rewrite a parked job. The publication delivery addendum rejects a stale acknowledgement even if the SQL update happened before expiry and COMMIT happens after it.

## Provider contract coverage

| Provider | Repository evidence | Missing inputs |
| --- | --- | --- |
| Finxplor Connect | Vendor interface unavailable. | Approved catalogue endpoints/version, authentication and scopes, countries/services, request/response and cost/currency/availability fields, errors, paging, rate limits and sandbox access. |
| IronGate Digital | Vendor interface unavailable. | Approved endpoint/version, authentication, countries/services, schemas and monetary fields, errors, retry, pagination, rate limits and sandbox access. |
| SSL Wireless | Vendor interface unavailable. | Approved service contract revision, authentication, geography, product IDs and availability, cost/currency, errors, paging, rate limits and sandbox access. |
| Synthetic CatalogProvider | Backend-only AE/AED digital PIN catalogue. Read operations accept an abort signal. Normalized fields include identity, debit, discount, additional fee, availability, eligibility and observation/expiry. | The versioned loopback test is synthetic. It verifies exact money strings, availability, cancellation, unknown version and method denial. No external provider endpoint is configured. |

Payment and kiosk clients retain the central catalogue API. The fixture did not use external provider or kiosk infrastructure.

## Verification

| Check | Pass | Fail | Skip | Evidence |
| --- | ---: | ---: | ---: | --- |
| Full offline validation | 917 | 0 | 0 | [25 steps](../.local/master-development-offline-1795158701346/results.json). One new privileged HTTPS test and two synthetic provider tests account for the increase from 914. |
| Included API, staff HTTPS and browser boundary suites | 51 API, 270 staff HTTPS, 56 browser boundary | 0 | 0 | Already included above. React typecheck and Vite build passed. |
| Focused HTTPS and command admission | 18 | 0 | 0 | Select portal and TLS group in scripts/test/run-staff-synthetic-tests.mjs. |
| Focused synthetic provider contract | 3 | 0 | 0 | packages/provider-adapters/test/mock-provider.test.ts. |
| Staff request/approval rehearsal | 6 | 0 | 0 | [Disposable rehearsal](../.local/012-r2-offline-cyr_tw9c/integration.log). |
| Effective staff and durable session PostgreSQL | 8 | 0 | 0 | [Effective fixture](../.local/012-r2-offline-x0z7qeoq/integration.log). |
| R2 SQL and worker regression | 1 SQL plus 13 tests | 0 | 0 | [Worker fixture](../.local/012-r2-offline-f155g8ch/integration.log). |
| Refresh recovery soak | 14 | 0 | 0 | [180.055-second run](../.local/012-r2-offline-5ie_zs7o/integration.log). Three workers, three tenants, 9,600 successful jobs, 9,600 fence records, 48 reconciliations, zero duplicate/unprocessed jobs, six peak worker connections and nine waiters. |
| Publication delivery and soak | 7 | 0 | 0 | [90.026-second run](../.local/012-r2-offline-sr3ikdni/integration.log). Three workers, three tenants, 7,362 events and unique receipts, 60 suppressed acknowledgements recovered, zero undelivered events. |
| Historical database rerun | 7 | 1 | 0 | [Legacy run](../.local/012-r2-offline-f779v39n/legacy.log). Five of six historically skipped checks passed. Original IAM preflight returned 42501. |
| Headless React rendering | 0 | 1 | 0 | The browser smoke fixture could not start a DevTools channel on this Windows host. TCP startup and a pipe probe both failed. The failure preceded page navigation. [Edge diagnostics](../.local/staff-browser-final-VXZOEk.log). |
| Guarded publication, Auth0 pilot, real provider/kiosk acceptance | — | — | — | Blocked or awaiting authorized targets, contracts and credentials. |

The lost-COMMIT test intercepted and discarded PostgreSQL's CommandComplete response on a disposable loopback proxy after the server committed. Reconciliation verified the existing durable write and preserved idempotency. The recovery soak repeatedly used that store's committed-write observation alongside scheduled work.

## R6 integrity

The [original verifier](../.local/runtime-qualification-1795158660082/manifest.json) still rejected 29 pins. The [successor](../.local/r6-reconciliation-1795158420382348300/manifest.json) verified 475 archive pins, reproduced 254 build outputs and passed two compiled expiry checks. Classifications remain nine documented source changes, 18 reproducible artifacts and two stale outputs.

The stale pair is the built application published-catalogue.js and its source map. The worktree JavaScript lacks the credential expiry recheck after asynchronous client-binding lookup. Both isolated rebuilds include it and have the same JavaScript hash. The paired maps record the regenerated structure under the established build-path normalization. The historical archive, source pin evidence and reported failures remain intact.

## Exact files and remaining work

The [changed-file manifest](../.local/final-continuation-changes.json) gives every file's previous and current SHA-256.

1. Run the original IAM and 006/007/009/010 publication qualification on an authorized isolated port-5432 target. Exercise approval, activation, outbox, rollback and a correctly scoped published read as one chain.
2. Qualify the approved Auth0 factor event, workload grants, browser approval flow and any remaining authorized lifecycle commands. Keep operational effects disabled pending acceptance.
3. Run the headless UI fixture on a host that allows a fresh browser profile and DevTools. Obtain the versioned vendor specifications and read-only sandbox scope, and qualify the existing payment and kiosk interfaces with authorized clients.
