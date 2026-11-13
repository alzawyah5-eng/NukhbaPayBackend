# Implementation progress

## Current increment: controlled A/B/C local integration

13 November 2026: **MERGES COMPLETE; INTEGRATED ACCEPTANCE NO-GO.** All three reviewed branch histories are merged locally in A/B/C order, with explicit historical checkout-byte rules and safe provider-logout integration. All 398 distinct executable tests passed with zero failed/cancelled/skipped cases, including the complete disposable catalogue/IAM/session/restore regression. Persistent development history remained 001-003 and database/role inventories were restored. The final required structure check failed because its generic admin-web client rule includes the trusted Node BFF and server test fixtures. The checker remains unchanged; no exemption, rollback or additional implementation was attempted after that gate. See [the integration record](security/three-branch-integration.md) for exact commits, dependency approvals, conflict resolutions, commands and the required narrowly reviewed architecture-check correction. Persistent IAM, real Auth0 login, staff mutations, accepted privileged approvals and financial execution remain disabled.

## Current increment: Brick 4A draft catalogue publication foundation

13 November 2026: **COMPLETE for local synthetic draft generation and disposable PostgreSQL acceptance; publication activation remains BLOCKED** (ADR 0026).

The application layer now builds immutable, versioned DRAFT candidates from explicit COMPLETE catalogue snapshots and normalized offers. It reuses the existing bigint AED pricing waterfall and deterministic half-up percentage rounding, validates AED/product/policy/freshness/version boundaries, and derives stable order-independent content and operation identities. Results are always `NOT_AUTHORIZED` with `activationAllowed=false`. AI evidence is a separate advisory-only classification and cannot enter arithmetic, policy or authority.

A non-public draft store validates a dedicated disposable-only PostgreSQL role, source evidence, tenant, product and expected prior version. A tenant/product advisory transaction lock makes concurrent identical requests converge; identical replay is idempotent, changed payloads conflict and stale versions reject. Candidate/source/request/event evidence commits atomically. There is no activation operation, route or reserved permission.

Proposed migration 007 remains **unregistered and unapplied**. It adds four append-only FORCE-RLS draft-evidence tables and no successful-publication state. Its gated disposable rehearsal rejects hostile schema/default ACLs; existing catalogue runtime/importer and IAM roles receive no rights. The ephemeral writer has only narrow catalogue source reads and draft SELECT/INSERT, without IAM/security-audit/update/delete/schema/role authority.

Final applicable verification passed with zero skips: 93 application, 6 new publication/PostgreSQL, 18 database, 34 combined 001-006 migration/security/restore, 48 API/authentication, 19 financial/provider and 9 Python tests (227 distinct tests). Builds and application/database/API typechecks, deterministic demonstration and structure checks passed. The first combined retry failed only because the new launcher used the wrong existing PostgreSQL binary environment key; correcting the launcher produced 34/34. Earlier new-code failures also exposed invalid privilege-probe syntax and a pre-lock serializable snapshot; both were corrected and rerun.

Persistent `nukhabapay_dev` history and database inventory were compared before/after disposable runs and remained unchanged at 001-003. All generated databases and roles were cleaned. The credential-free pre-change checkpoint is preserved at `../recovery-checkpoints/before-brick-4a-20261113T112729133Z.zip` (SHA-256 `035a70cd134988d3e3335ad1954ecbb60d6f92e47dd60034f94f3a992356cf83`).

Next bounded Brick 4 proposal: define authenticated, independently approved candidate review/activation contracts and customer-safe active-publication projections, while keeping activation disabled until persistent IAM, real staff trust and explicit publication permission are approved.

## Current increment: secure persistent IAM activation readiness

13 November 2026: **SOURCE READINESS COMPLETE; PERSISTENT DEPLOYMENT NO-GO** (ADR 0025). A separate `persistent-development-preflight-v1` profile is disabled by default and exposes read-only preflight only—there is no persistent apply mode. It binds an operator approval identifier to the exact development database, database OID, PostgreSQL system identifier, canonical owner/workload roles and verified migration-manifest SHA-256. It rejects production/disposable ambiguity, unsafe/missing credentials, unexpected 001–003 history, unsafe role attributes/memberships, database/schema ACL drift, prepared transactions, competing project connections, pre-existing IAM/session objects and any successful wrong-password connection.

The isolated staff-session parser now fail-closes on stray disabled-mode settings and, when explicitly parsed for persistent development, requires exact environment/host/port/database/role/target identity plus bounded pool and operation timeouts. Its URL is redacted/non-enumerable. It is not registered in runtime dependency injection, and the deployed session mode remains disabled. A non-registered owner recipe proposes only IAM reader/writer CONNECT and schema USAGE with excess-privilege checks; it was not executed. The duplicate importer example and obsolete disposable-admin example were corrected without changing credentials.

Registered 004, 005 and 006 and their preserved hashes are unchanged; the existing disposable runner is unchanged. The live read-only negative probe passed by rejecting the current loopback `trust` fallback while confirming development history remains exactly 001–003. Final verification passed 77 counted tests with zero failures/skips: 5 profile/grant tests, 1 live trust-rejection test, 18 database tests, 34 combined disposable migration/security/session/restore tests and 19 financial/provider regressions. Source integrity, database typecheck and structure checks also passed. Generated databases were removed and development history remained 001–003.

Deployment is still blocked on SCRAM-SHA-256/HBA conversion and independent role secrets; named operator/change, backup/recovery, maintenance and postcheck approvals; a restored-development-backup rehearsal; execution approval for IAM/session roles and grants; and a separately reviewed persistent activation wrapper/source transition because immutable migration guards still reject `nukhabapay_dev`. No migration, persistent role/ACL, pg_hba, certificate, Auth0, staff, privileged operation or financial change occurred.

## Previous increment: development IAM deployment preparation

13 November 2026: **READ-ONLY/DOCUMENTATION COMPLETE; PERSISTENT DEPLOYMENT NO-GO.** Repository and PostgreSQL inspection recommends the existing `nukhabapay_dev` database as the eventual IAM target because migrations 004–006 depend on exact 001–003 history and database-local foreign keys to the canonical tenant table. A separate IAM database would duplicate tenant/catalogue foundations and require synchronization without cross-database FK enforcement.

Current development evidence: PostgreSQL 17.11 at loopback port 5432, database owned by `nukhabapay_migrator`, history exactly 001–003, approximately 8 MB, and zero current catalogue rows. The five existing roles retain LOGIN with no superuser/createdb/createrole/inherit/bypass-RLS flags or memberships. Identity reader/writer and importer currently lack database CONNECT/schema USAGE; this must be resolved by an exact reviewed privilege recipe rather than assumed from test fixtures. Development IAM/session objects remain absent. No migration, role, ACL, credential, Auth0 or trust-store change was made.

Persistent execution is blocked because the registered runner, preflight, migration 005, reviewed 006 SQL, session grant recipe and session store deliberately accept only disposable targets. The session runtime also has no persistent configuration parser/composition, and current loopback PostgreSQL authentication is `trust`. These controls must not be bypassed. A separately authorized exact-target activation implementation, new reviewed checksums where necessary, restored-clone rehearsal, credential/authentication decision and recovery ownership are required first.

The draft [development IAM deployment runbook](runbooks/development-iam-deployment.md) records the target rationale, role/environment mapping, backup/restore procedure, post-migration ACL/RLS checks, failure handling and operational blockers. Real Auth0, staff bootstrap, accepted approvals, privileged APPLY and financial execution remain disabled. Stop for approval; do not deploy.

## Current increment: controlled migration 006 registration

13 November 2026: **COMPLETE for source registration and disposable acceptance** (ADR 0024). The already accepted transactional wrapper is now numbered `006_staff_server_sessions.ts`; its reviewed IAM/session SQL sidecars are unchanged and remain SHA-256 verified. The source manifest status is `006_REGISTERED_LOCAL_SOURCE_HISTORY`, and the candidate-only runner switch is removed. The guarded normal runner now stages exactly registered 001–006, holds the same advisory lock across preflight and migration, checks order, and commits in one transaction.

Frozen migration hashes remain unchanged: 004 `ebb5b282d9afad7dc5ef7b8221bd7b34942c1cbb53757e73832987b36975b312`; 005 `41910d1aa060a1971c8e33e123b0e350d884ffede490cb71b52dc00838779390`. Registered 006 is `035fa9bb914de3cb4094f8e98ce2fa9164dc4e6b5e11b40ddfdd55707bc98eed`.

Focused verification passed **120 tests with zero failures/skips**: 86 application policy/session regressions and 34 combined migration/security tests. Connection-free manifest verification, registered-wrapper strict typecheck, runner syntax check and API/workspace build also passed. Disposable acceptance covered 001–006 order/replay, hostile defaults/ACLs, FORCE RLS and exact privileges, failed-up rollback/forward retry, concurrent authority advancement, session lifecycle/restart evidence and real pg_dump/pg_restore recovery.

The harness confirmed `nukhabapay_dev` history and database inventory were unchanged before and after. Migrations 004–006 were not applied there. Random disposable databases and generated session roles were removed; no new permanent role or grant was introduced. The verified 250-file pre-registration checkpoint is preserved as `../recovery-checkpoints/before-migration-006-registration-20261113T071118818Z.zip`, SHA-256 `aa13e92f84cc0dfa76e4e13919990756cb91fbd11a911e8218c414871a895a29`.

Registration is not deployment approval. A controlled persistent target, backup/restore ownership, secret handling and post-migration acceptance remain PENDING. Real Auth0, browser-trusted HTTPS, staff bootstrap, genuine MFA/approval provenance, privileged APPLY, reserved permissions and financial execution remain disabled. Brick 3 operational completion is not claimed. Stop for review.

See [ADR 0024](adr/0024-registered-staff-session-migration.md), [the migration runbook](security/migration-security-rehearsal.md) and [verification](verification.md). The prior correction record and its 355-test evidence remain preserved below and in ADR 0023.

## Preserved correction increment: migration security corrections and combined acceptance

13 November 2026: **COMPLETE for the bounded local synthetic correction task** (ADR 0023). Migration 004 now has a separate fail-closed default-ACL/schema preflight and additive candidate authority/version/cutoff safeguards; frozen 004/005 bytes and historical checksums are unchanged. The identity/session boundary enforces tokens_valid_after using verified signed issuance. Restricted-reader access expands by exactly that one column, on disposable targets only. No staff mutation or approval executor is added.

Proposed 006 now rejects NULL socket/network metadata, unexpected schema defaults and actual namespace ACLs. Its reviewed transactional wrapper is rehearsed with the complete 001-006 sequence, exact dependency/order checks and a ten-input SHA-256 manifest. Session revocation persists AUTHORITY_CHANGED correctly; replay of an old rotated/logout cookie cannot invalidate a current sibling actor. Immutability checks run before row changes. The candidate remains outside the registered migration directory.

**355 distinct project tests pass, zero failures/skips in final suite results:** application 86, database 15, API/authentication 48, existing IAM/HTTP/workflow 123, existing sessions 18, new combined migration/security 34, HTTPS/CSRF 3, financial/provider 19 and Python 9. Applicable builds/typechecks, explicit pending-wrapper typecheck, source integrity, demonstration and structure checks pass. Earlier failures and the outer-wrapper deadline are preserved and explained in verification; the final IAM suite ran directly from freshly compiled files. No assertion, database/query timeout or required test is weakened or skipped.

Combined acceptance proves monotonic versions/cutoffs across suspension/reinstatement, identity/membership/grant changes and emergency invalidation; stale tokens cannot recreate authority. It also proves hostile-role/default-ACL rejection, FORCE RLS, unchanged catalogue/workflow privileges, immutable atomic audit/receipts, concurrency, failed-up rollback/forward retry, pool restart behavior and real pg_dump/pg_restore into fresh disposable databases. No operational down recovery is used. The SQL NULL branch is tested in PostgreSQL; native Unix transport is unavailable on this Windows setup.

Final read-only database evidence confirms development still has only 001-003, no IAM/session schema or added identity index, five original restricted roles with no memberships, and zero generated roles/project connections/disposable databases. Task-created rehearsal directories are gone. Recovery archives are preserved, including the verified 241-file pre-correction checkpoint. No certificate trust, Auth0 setting, real staff data, public endpoint or financial execution changes occur.

Verdicts: 004 PASS with the reviewed additive safeguard chain; 005 PASS for non-authorized synthetic workflows; candidate 006 PASS for combined disposable acceptance and remains UNREGISTERED. Brick 3 and operational Brick 3C are not fully complete. Persistent migration targets/registration, real provider trust, browser HTTPS trust, staff bootstrap, genuine MFA/approval provenance, privileged APPLY, operational secret/monitoring/recovery ownership and session HA/refresh/retention remain gated. Management approvals stay PENDING. Stop for review; no next increment is authorized.

See [the correction runbook and exact 42-file inventory](security/migration-security-rehearsal.md), [ADR 0023](adr/0023-reviewed-migration-security-and-authority-invalidation.md) and the current verification record. The enclosing recovery-checkpoints directory contains the final change hashes, verification summary, redacted command logs and migration-security-final-20261113T065607036Z.json.

## Preserved earlier progress

## Current increment: local HTTPS staff BFF and server-session foundation

12 November 2026: implemented ADR 0022 in the existing admin-web/application/database areas. The minimal Node HTTPS portal targets https://localhost:3001, bound to 127.0.0.1; API remains 127.0.0.1:3000. Default CLI sessions/sign-in are disabled. Internal synthetic sessions require genuine opaque current actors, exact identity/tenant/version binding, committed audit, random hash-only credentials and immutable audited revocation/rotation. Canonical host-only cookie and exact-origin HMAC CSRF protect logout; no public session-creation route, real provider mode or privileged action is added.

**319 distinct project tests pass with no latest failures/skips:** application 84, database 15, API/authentication 48, existing disposable IAM/HTTP/workflow 123, new disposable sessions 18, HTTPS/CSRF 3, financial/provider 19 and Python 9. Builds/typechecks, frozen offline workspace linking, demonstration and structure checks pass. Earlier CSRF classification, late connection-reset cleanup and transient unchanged IAM timeout failures are retained and explained in verification. No existing assertion or timeout was weakened.

Proposed 006 remains unregistered/disposable-only: separate append-only FORCE-RLS session/audit tables, strict tuple constraints and a dedicated 27-SELECT/23-INSERT-column backend. Existing IAM/catalogue credentials and registered 001-005 remain unchanged. Actual development history remains 001-003; no IAM/session schema or consistency index is present there. Disposable databases, generated roles and connections are cleaned.

**Owner TLS decision: leave Windows trust unchanged.** No Root entry was installed; private encrypted certificate material remains outside OneDrive/checkpoints. The actual port-3001 HTTPS bootstrap was verified using curl with the exact public certificate and normal chain/hostname validation. Explicit pinned-client mode is documented; Windows/browser trust is not established and warnings must not be bypassed. Login/callback routes do not exist, so Auth0 callback activation is not ready.

The 225-file pre-increment recovery checkpoint is preserved. Operational MFA, real Auth0/staff data, approved persistent session/IAM targets, required version-write discipline, retention/HA/refresh, accepted privileged approvals, APPLY, reserved permissions and live finance remain blocked/PENDING. Local synthetic completion is not full operational Brick 3/3C completion. See verification, the session runbook and ADR 0022. Stop for review; no next increment is authorized.

## Earlier implementation records (preserved)

## Current increment: controlled Nukhbapay naming standardization

12 November 2026: **NAMING STANDARDIZATION COMPLETE**. Canonical display/technical names are Nukhbapay / nukhbapay. Nine workspace package names, current imports/scripts/docs, environment examples, Python module and staff-blueprint path are coordinated. Local synthetic audiences change exactly, with historical values denied; no trust alias or real provider configuration. ADR 0021 and [the naming register](naming-standardization.md) record exact identifiers, seven maintained-file renames, retained compatibility resources and future transition procedures.

Verification: **289 passing project tests, zero failures/skips** (75 application, 15 database, 48 API/authentication, 123 disposable PostgreSQL IAM/HTTP/workflow, 19 financial/provider, 9 Python). All builds/typechecks, ESM workspace resolution, legacy-alias absence, structure and AED 102.00/AED 2.77 demonstration passed. Only three workspace keys changed in the pinned pnpm lockfile; third-party versions/integrities are identical. Setup/cache/helper failures and their fixes are explicitly recorded in the latest verification entry, not hidden as passing tests.

The reviewed prior checkpoint and tested-code hashes were verified; a new credential-free 223-file pre-rename checkpoint is preserved. All migration/provisioning/grant SQL, old ADRs/handover and historical record bodies are unchanged. Existing recovery evidence is retained; the running PostgreSQL log preserves its exact original prefix and appends test entries. Git is unavailable, and no remote or software upgrade was introduced.

Read-only final PostgreSQL checks confirm development remains exactly 001?003 with no IAM/workflow tables. Neither 004 nor 005 was applied. Existing five restricted roles/privileges remain unchanged; all disposable databases/roles and project connections are cleaned. The physical checkout locator, Compose storage namespace and fixed schema/role/RLS settings retain their documented legacy identifiers. Private secret files are not edited.

All operational approvals remain PENDING; real MFA, accepted privileged approvals, APPLY, reserved permissions and live financial execution remain blocked. No new route, staff identity, external resource or further brick. This bounded naming task stops for review. See [verification](verification.md) for exact commands, evidence, remaining manual configuration actions and limitations.

## Earlier implementation records (preserved)

Updated: 12 November 2026

## Current increment: gated staff approval intake

12 November 2026: implemented a strict internal ATTEMPT/RECONCILE operation on the existing opaque actor boundary. A separate default-deny intake capability, same-instance verified synthetic proof, exact canonical actor/issuer/subject/request/version/digest/policy/tenant binding and fresh role/status/membership/head/expiry checks are required. Client MFA/authority/receipt fields, forged actors/proofs, self/beneficiary and duplicate-person participation deny. Every result retains privilegedApproval=BLOCKED, acceptedApproval=false, not-established and NOT_AUTHORIZED.

No schema change is required or made: the existing provenance-tagged REVIEW profile durably classifies blocked synthetic evidence with exact bindings and atomic review/provenance/audit/receipt/no-delivery outbox. Ordinary review/submission receipts cannot be relabelled through intake reconciliation; the backend now verifies the full stored profile. Shared serializable reservations, idempotency, bounded retries and authoritative historical reconciliation are preserved. Existing seven-table/27-IAM-column credentials are reused with no grant expansion. Original 004/005, normal runtime, catalogue/financial protections and deployed routes are unchanged. ADR 0020 explains the mapping and its limits: no distinct accepted approval/attempt-log schema or in-place upgrade of prior participation.

Reviewed checkpoint preserved: `../recovery-checkpoints/before-approval-intake-20261112T074145Z.zip`, 219 maintained files, SHA-256 `f2661996c7fb407883be4251dc3551f4de10281aa8507968238af4b3500c92ef`. Prior backups unchanged; no Git/software/dependency installation or remote publication. Focused disposable acceptance passed 123/123; complete final commands/results are recorded in verification.md.

Final verification: **288 passed, zero failed/cancelled/skipped** (application 75, database 15, API 47, disposable integration 123, financial/provider 19, Python 9); builds/typechecks/demo/structure passed. Artifact stem: `../recovery-checkpoints/approval-intake-verification-20261112T080425934Z`. Independent postcheck verifies clean disposable inventory/roles/sessions and unchanged development history 001–003, registered migrations and role recipes. This bounded local increment is complete; privileged and operational gates remain closed.

Real accepted approvals remain blocked on demonstrably independent approved strong-authentication provenance, named approver authority/recovery and a separately reviewed later schema/executor. Synthetic signatures establish no real MFA; reserved permissions/APPLY/staff mutation, Auth0/employees, endpoints and development migrations remain disabled. Next independently safe direct proposal is internal server-session lifecycle/revocation persistence for Brick 3C with current actor/version binding and audited invalidation, without browser/provider login or privileged execution. Stop for review.

## Previous increment: secure internal request and review reads

12 November 2026: implemented DETAIL, STATUS, REVISIONS and REVIEWS through the existing opaque staff actor boundary, with separate default-deny synthetic read authorization, fresh identity/status/membership/grant checks and committed audit before disclosure. Each lookup requires an exact actor-owned submission/review operation and request/scope. Requesters see their own request history and redacted review summaries; reviewers see only observed versions and their own observations. No queue/enumeration API, peer identities, authority/provenance evidence or raw tokens/payloads are returned.

The isolated PostgreSQL reader has 34 SELECT-column grants on three existing FORCE-RLS tables, no IAM/provenance/audit/receipt/outbox/mutation/command rights, fixed bounded pools and read-only repeatable snapshots. Opaque one-use actor/query-bound cursors page bounded histories and pin the visible revision head. Startup rejects missing/excess privileges including views/functions. Existing IAM/catalogue credentials, financial source, migrations 001–005 and deployed routes are preserved. ADR 0019 records exact visibility, columns, concurrency and remaining trust limits; verification.md records actual tests and files.

Final verification: **268 passed, zero failed/skipped** (application 71, database 15, API 47, disposable integration 107, financial/provider 19, Python 9). All builds/typechecks/demo/structure checks passed. Artifacts: `../recovery-checkpoints/workflow-reads-verification-20261112T071144041Z`. Independent metadata confirms zero generated roles/sessions/idle transactions, unchanged database inventory and development history 001–003; no 004/005 IAM/workflow tables exist there. The new read increment is complete locally; all privileged/operational gates remain closed.

Reviewed checkpoint preserved: `../recovery-checkpoints/before-workflow-reads-20261112T064212Z.zip`, 214 maintained files, SHA-256 `e42f96daa225b02476bb122a82442386df3b8cd56b29ed8051b42f6dd954c263`. Prior backups were not overwritten. Git remains unavailable; no software/dependency installation or remote publication.

Real privileged approval acceptance/MFA/APPLY, effective staff/grant mutation, reserved permission activation, Auth0/real employees, deployed endpoints and non-disposable migrations remain BLOCKED/PENDING. Development remains on 001–003. Next direct proposed code increment is gated approval-intake persistence with exact fresh binding and atomic audit; synthetic/absent assurance must remain blocked, with actual approval/execution requiring proven independent strong-authentication trust. No further reader/planning-only increment is proposed. Stop for review.

## Previous increment: registered migration 005 restricted workflow foundation

Migration 005 now registers eleven immutable FORCE-RLS tables: four compatibility simulation artifacts plus canonical operation/request-version/review/audit/receipt/outbox/provenance records. Two SECURITY INVOKER functions retain observation validation and an always-deny execution gate. Explicit revokes and global/schema default-privilege correction prevent PUBLIC, catalogue and existing IAM workload access. A separate owner-operated grant recipe gives generated restricted synthetic backends only the reviewed SELECT/INSERT and minimum IAM projection. Existing migrations 001–004, IAM/catalogue roles, application policy and runtime registration remain unchanged.

The migration tightens null-sensitive version/payload/tenant constraints, target references and role scope. Existing request/review/provenance/concurrency/wire-recovery acceptance now runs registered 005 rather than installing pending rehearsal SQL. Historical IAM-only fixtures explicitly stop at 004. New migration acceptance verifies hostile defaults/roles, actual failed-transaction rollback, unchanged existing object ACLs, target denial and refusal of automatic destructive down. Exact evidence is recorded in verification.md.

Final verification: **252 passed, zero failures/skips** (application 71, database 15, API 47, disposable API/PostgreSQL acceptance 91, financial/provider 19, Python 9). Builds/typechecks/demo/structure passed. Final artifact stem: `../recovery-checkpoints/migration005-verification-20261112T061650247Z`. Independent postcheck confirms zero generated roles/connections/idle transactions and unchanged database inventory/history; no 004/005 IAM/workflow tables exist in development. This bounded local increment is complete; operational/privileged gates remain closed.

Preserved reviewed checkpoint: `../recovery-checkpoints/before-migration005-20261112T053905Z.zip` (209 maintained files, SHA-256 `ca4ecefe615350a66c56c25d66442f442a5492f0dc78d53754d28ff53eddc51c`). No previous backup overwritten. No dependency/lockfile changes, software installation or remote publication. Development history remains 001–003; neither 004 nor 005 is applied there.

Local scope only: requests/revisions, independent non-approved observations and synthetic provenance persist atomically with audit/receipt/no-delivery outbox. All execution remains NOT_AUTHORIZED, assurance not-established, acceptedApproval=false. Privileged approval acceptance/APPLY, effective staff/grant changes, authentic MFA, non-disposable activation and Brick 3 completion remain BLOCKED. No deployed endpoint, reserved permission, Auth0 or financial change. ADR 0018 supersedes historical statements that these schemas are only pending rehearsals. Stop for review; next proposed bounded functionality is internal actor-scoped request detail/status/review-history reads, not privileged execution.

## Previous increment: Day 4 synthetic assurance and actor-bound approval provenance

12 November 2026: implemented a default-disabled local assurance contract and strict pinned-jose synthetic assertion verifier. Opaque one-use challenges bind exact verified actor, canonical person, request/version/digest, tenant, policy and authority; immutable provenance retains synthetic/not-established/acceptedApproval=false/NOT_AUTHORIZED. Self/beneficiary, forged/cloned/replayed claims, alternate-person participation, stale authority/request and cross-scope attempts deny. Client MFA flags and real staff tokens cannot substitute for the synthetic profile.

An additive disposable schema persists safe provenance metadata/digests with the same review/audit/receipt/outbox transaction and unique challenge/event/person constraints. Same-key retry/recovery remains safe; stripped provenance conflicts. Separate generated test credentials preserve existing IAM/catalogue privileges. No raw bearer or assertion appears in application results or storage, no real MFA is established, and no runtime/HTTP/permission/migration activation is added. Final full verification passed 242 tests (application 71, database 15, API 47, integration 81, financial/provider 19, Python 9), zero failures/skips; builds/typechecks/demo/structure passed. The stopped existing local cluster was restarted from its verified data directory, completed normal crash recovery and retained development history 001–003. Disposable targets/roles were cleaned. ADR 0017 explains demonstrated local provenance versus independently authenticated privileged acceptance, which remains BLOCKED. Complete evidence is in verification.md. Stop for review; Brick 3 remains incomplete.

## Previous increment: durable synthetic staff requests and review observations

11 November 2026: implemented actor-bound SUBMIT/REVIEW/LOOKUP operations for non-authorized synthetic records. Versioned immutable requests preserve target/scope/role intents, expected authority versions/digests and expiry; revisions require parent CAS. Canonical independent reviews remain acceptedApproval=false/not-established/NOT_AUTHORIZED. One database transaction commits request or observation plus fixed immutable audit, receipt and no-delivery outbox; deferred constraints reject incomplete commits. Idempotency, request reservations, bounded retries, fresh authority and uncertain-commit lookup preserve safe recovery. ADR 0016 specifies exact scope/privileges and limitations; verification.md records actual tests and files.

Final full verification: 233 tests passed (application 71, database 15, API 47, integration 72, financial/provider 19, Python 9), zero failures/skips; builds/typechecks/demo/structure passed. Earlier fixture-version/RLS/fault-boundary issues and a transient filesystem lock are recorded transparently in verification.md. Development history remains 001–003 and disposable inventory is clean. Only disposable targets/new restricted backend credentials are used. Existing IAM/catalogue credentials and registered migrations remain unchanged; the fixture gives only the new role equivalent tenant-filtered IAM read policies and removes them at cleanup. No runtime registration, endpoint, effective staff change, approval/APPLY, provider, financial operation or development migration. Operational MFA/accepted approvals/privileged persistence remain BLOCKED. Stop for review.

## Previous increment: restricted synthetic PostgreSQL receipt reader

11 November 2026: added a default-deny PostgreSQL reader consumed through the opaque actor boundary and a one-use in-flight query capability. Requires explicit synthetic receipt access, server-derived actor/tenant, exact operation/key/digest, committed audit and fresh authority. Dedicated disposable reader has fourteen column SELECT grants only, no IAM/audit/outbox/command or write access. Factory verifies target/login/privileges/RLS; pool and read-only transaction cleanup are bounded. No normal runtime registration, endpoint, migration change or reserved permission activation.

ADR 0015 records the implementation, exact privilege matrix and human-identity boundary. Final full run passed 222 tests: application 71, database 15, API 47, integration 61, financial/provider 19 and Python 9; zero failures/skips. Builds/typechecks/demo/structure passed. The preceding run exposed a delayed socket error; lifetime client-error handling/discard fixed it and the full rerun passed. Development history remains 001–003 and disposable inventory/roles were cleaned. Verification.md records commands, setup failures and changed files. MFA, accepted durable approvals, privileged staff persistence and operational activation remain BLOCKED; Brick 3 remains incomplete. Stop for review. Proposed next functional step is local synthetic staff access-request submission/review with durable server-owned versions and canonical-person review records, keeping approval/APPLY gates closed; no further receipt preparation is proposed.

## Previous increment: trusted actor and denied approval-provenance foundation

11 November 2026: application code now issues instance-bound opaque staff actors only from existing verified identities and exact restricted IAM resolution. Fresh identity/staff/membership/grant/version checks reject stale actors. Immutable actor/request/policy-bound approval observations explicitly deny acceptance: current assurance and reserved permissions cannot satisfy privileged approval requirements. Self/beneficiary and alternate-identity duplicate-person checks use canonical internal staff IDs. No client MFA flag, UUID, JSON clone or simulation receipt becomes authority.

A separate denied-by-default local synthetic receipt-access port derives actor/tenant from the verified handle, validates persisted receipt bindings, requires committed audit and rechecks current authority before disclosure. It never infers receipt permission from staff.self.read. No runtime registration, endpoint, role grant, migration or staff mutation is added. Final full regression passed 213 tests (application 71, database 15, API 47, integration 52, financial/provider 19, Python 9), zero failures/skips; builds/typechecks/demo/structure passed. Development history remains 001–003 and disposable inventory was cleaned. ADR 0014 documents the implementation and its limitations; verification.md records commands and changed files. MFA, accepted/durable independent approvals, privileged persistence and operational activation remain BLOCKED. Brick 3 remains incomplete. Stop after this increment for review.

## Previous increment: non-authorized database failure-recovery acceptance

11 November 2026: seven new disposable-PostgreSQL acceptance cases exercise connection loss before COMMIT, two lost-acknowledgement wire cuts, loss after confirmed COMMIT, unavailable receipt lookup, failed-transaction cleanup and COMMIT returning ROLLBACK. Fixture-only reconciliation uses authoritative primary receipts, actor/key reservation, exact actor/tenant/digest filters and fail-closed bootstrap-bound lookup context. Concurrent independent retries converge on one complete tuple; changed payloads conflict. All outcomes remain NOT_AUTHORIZED. No production adapter, SQL/migration/grant change, real staff mutation, reserved permission, provider, endpoint or financial operation is introduced.

Final focused integration passed 44/44 with no failures/skips. Full regression passed application 71, database 15, API/authentication 47, integration 43, financial/provider 19 and Python 9; the final focused rebuild includes the seventh recovery case added after that full-run compilation. Builds/typechecks, demo and structure checks passed. Commands and exact changed files are recorded in verification.md. ADR 0013 documents the protocol and the important limit: recorder credentials/GUCs do not authenticate a human actor; this remains test-only. Real MFA, independently authenticated approvals, privileged staff persistence/full migration 005 and operational activation remain BLOCKED. Brick 3 remains incomplete. Stop after this bounded task for review; no additional increment is authorized automatically.

## Previous increment: Brick 3 security amendment (limited local foundations verified)

11 November 2026: executable pending-005 SQL was rehearsed only on a verified disposable PostgreSQL target. Four untrusted proposal/audit-intent/simulation-receipt/no-delivery-outbox tables have exact binding constraints, deferred complete-tuple enforcement, FORCE RLS, append-only protection and no grants to existing workload roles. A SECURITY INVOKER command gate always denies; no actor UUID, approval JSON or simulation object enables execution. This is not the complete privileged migration 005 and is not registered by the normal migrator.

Partial Brick 3C transport code adds local `.invalid` HTTPS origin/CSRF/header checks, secure host-only cookie policy and session metadata lifetime checks. It creates no session or endpoint and returns no authorization. Only GET /health/live remains deployed. Existing migrations, permissions, verifier/policy, catalogue and pricing source and prior assertions are preserved.

Final regression: application 71, database 15, API/authentication 47, disposable IAM/HTTP/runtime/persistence 37, finance/provider 19 and Python 9 passed; no skips. Builds/typechecks, demo and structure checks passed. Full commands, failure history and limits are in verification.md; ADR 0013 specifies the exact matrix and gates. Read-only before/after history on loopback PostgreSQL 17.11 confirms nukhabapay_dev remains 001–003; migration 004 was not applied. Disposable targets and the ephemeral recorder were removed.

Privileged staff mutation, independent authenticated approval persistence, fresh MFA assurance, full migration 005, complete browser/BFF login and operational activation remain **BLOCKED**. Current `assurance=not-established` is unchanged. No management row is approved by synthetic tests. **Brick 3 is not fully complete.** The smallest independently safe next code is real connection-loss/reconciliation testing for non-authorized artifacts; opening execution requires the trust gates in ADR 0013, not more simulated authority.

## Previous increment: pure staff command/audit/receipt/idempotency contracts (complete locally)

Verified 11 November 2026. New application contracts construct immutable command candidates from the unchanged lifecycle planner, fixed *_INTENT audit events, SIMULATION_RECORDED receipts, scoped lookup hints/results and erased future transaction ports. Domain-separated standard SHA-256 operation IDs bind canonical actor/idempotency key; command digests bind request intent and canonical approval records. Exact target, tenant and role changes conflict under a recorded actor/key. Unknown/private input fields are omitted and all results retain NOT_AUTHORIZED with the existing assurance/phase/no-executor blockers. No APPLY, privileged execution or actual staff mutation is implemented.

The in-memory boundary/orchestrator exists only in test fixtures and records intent/audit/receipt tuples, never staff state. It reserves a key, checks replay, stages privately and publishes one complete tuple. Deterministic barriers exercise concurrent duplicates/conflicts, failure after each stage, cleanup/retry, preserved prior history, expiry and uncertain acknowledgement both with/without publication. UNKNOWN returns no receipt; scoped lookup distinguishes pending/missing/conflict/unavailable and requires reservation before retry. Recorded simulation receipts can be reconciled after expiry without another intent. This does not establish database durability or multi-process atomicity.

Application 71/71 (previous 45 plus 26 new cases), API 44/44, pure database configuration 8/8, financial/provider 19/19 and Python 9/9 passed with zero failures/skips. Application/database/API builds and typechecks, test compilation, demo and structure checks passed. The first new-test compile caught an unused type import; it was removed without relaxing compiler settings/assertions. No runtime assertion failed. No PostgreSQL connection/write/migration was performed; destructive and real identity integration remain unrun under this scope. Earlier disposable evidence is historical and migration history was not rechecked.

Before coding, all prior archive/entry hashes were verified/preserved. A reviewed 179-file source archive was written/read back: `../recovery-checkpoints/before-staff-contracts-20261111T114725Z.zip`, SHA-256 `dc6b919fb0b429c1fd348a5760a3a81052dfca0d5e9c7dbc7ff910c8c550a400`. Environment/data/key/dependency/generated outputs were excluded and existing synthetic URL-pattern fixtures reviewed without printing credentials. No applicable AGENTS.md was found; Git remains unavailable and was not installed. No dependency, lockfile, prior test, existing policy/assurance/permission/audit implementation, API/runtime, database/migration/grant or financial/provider code changed. New constructors/ports are exported from the application index only; no adapter is wired.

ADR 0012 and verification record exact contracts, sequence, commands/results, omissions and limits. Stop after this increment. Proposed next bounded work is read-only persistence/transaction threat-model and migration acceptance specification, with no SQL execution, grants, provider, provisioning or permission activation.

### Pending Management Approvals

All real bootstrap/canonical-person/approval provenance, fresh assurance/MFA, durable atomic audit/receipts/outbox, idempotency retention/reconciliation, provider/environment/region/ownership, migration and operational/financial decisions remain PENDING. Simulation does not approve execution or another brick.

## Previous increment: pure staff lifecycle policy foundation (complete locally)

Verified 11 November 2026. Typed application planning now models CREATE, ACTIVATE, SUSPEND, REVOKE, REACTIVATE, DISABLE and RECOVER, explicit request states/events, canonical-person independent approvals, role/tenant delegation, fresh authority/intent versions and bounded explicit-time expiry. Standard-library SHA-256 binds immutable request intent; it is not a signature or approval proof. CREATE proposes PENDING, recovery stays SUSPENDED, disabled staff and revoked memberships cannot silently reactivate, and future-dated grants can be planned for cancellation at the actual current time.

Every result remains NOT_AUTHORIZED with assurance-not-established, inactive-permission and no-executor blockers. All state/event edges are checked; APPLY is unavailable in every state. Complete approval quorum is only a structural planning result. No verified-MFA adapter, permission activation, database/provider call, account, audit write, provisioning, privileged executor or endpoint is added. Inputs are trusted snapshots; future execution still needs verified human/assurance evidence and locked state. Existing authz/assurance contracts remain unchanged.

Application tests passed 45/45 (previous 18 plus 27 new deterministic cases), API 44/44, database configuration 8/8, financial/provider 19/19 and Python 9/9, with zero failures/skips. Application/database/API builds and typechecks, database test compilation, demo and structure checks passed. No PostgreSQL connection was opened; destructive database and identity integration were deliberately not run under the no-write/no-migration scope. Prior disposable acceptance remains historical. Development migration history was not rechecked and no migration was applied.

Before editing, all older archive/entry hashes were verified/preserved. A new 175-file reviewed source checkpoint was archived/read back: `../recovery-checkpoints/before-staff-policy-20261111T102152Z.zip`, SHA-256 `ec7eb1a0204b8bc0db30011b7ae011172e5d29fcda3d11db7f3bd937d9c30f0b`. Environment/data/key/dependency/generated outputs were excluded; existing synthetic URL-pattern sources were reviewed without printing credentials. No applicable AGENTS.md was found; Git remains unavailable and was not installed. No dependency or lockfile changed. Existing Node types were explicitly enabled for the standard-library digest; compiler strictness was preserved.

ADR 0011, verification, security and application documentation describe the exact state graph, approval rules, tests and limits. Initial compilation caught missing explicit Node type inclusion and a rejection helper typed too broadly; both were corrected without relaxing checks or weakening assertions. Existing application policies, permission catalogue, identity contract, API/runtime/database/migrations/roles, catalogue/pricing source and previous tests remain byte-identical. Stop after this increment. Proposed next bounded work is pure command/audit/receipt contracts and in-memory failure/idempotency tests, with no writer, executor, migration or endpoint.

### Pending Management Approvals

All real bootstrap/canonical-person mapping, independent administration, assurance/MFA/recovery, re-enrollment, future-grant persistence constraints, atomic audit/receipts/outbox, provider trust/region/ownership, migration and deployment/financial decisions remain PENDING in the register. This local policy authorization grants no production authority or later-brick approval.

## Previous increment: local synthetic runtime lifecycle (complete locally)

Verified 11 November 2026 after the separately authorized Brick 3B-4 read-only readiness review. `createLocalApiRuntime` now explicitly composes the actual verifier, restricted IAM runtime and existing global guards. Default `API_STAFF_AUTH_MODE=disabled` opens no identity resources and rejects stray identity settings. Explicit `local-synthetic` requires complete configuration, loopback listener, reserved `.invalid` issuer and a trusted injected synthetic key transport. No real provider or production mode can be activated by configuration. Only IAM allowlisted settings reach the runtime; migration/importer/catalogue/admin credentials are not read or forwarded.

Enabled startup requires usable keys and IAM readiness before application initialization/listen. Internal coalesced `checkReadiness()` returns only a boolean object, reads no staff records, writes no audit events and adds no route. Checks cover public signing-key material, role boundaries, repository column access, writer privileges and forced RLS. Failed startup/listener initialization unwinds resources. Nest lifecycle hooks cancel key work, drain HTTP and close both pools; managed/direct close and repeated cleanup are tested. Pool reconnection and restart after dependency restoration are verified locally. Native service-manager signals/failover remain untested.

The full run passed application 18/18, database 15/15, API 44/44 (all previous 40 plus four lifecycle unit tests), internal/HTTP/lifecycle PostgreSQL 29/29 (previous 21 plus parent/seven lifecycle cases), financial/provider 19/19 and Python 9/9, with zero failures/skips. Builds/typechecks, demo and structure checks passed. The new integration initially failed on a synthetic seed missing required contact_email; corrected fixture data preserves schema/assertions. Initial compilation also corrected concrete-repository coupling to application ports and an explicit fixture-map type; strict compiler settings were preserved.

Passing full-run IAM targets were `nukhabapay_b3b2_89d452ca4238468e8bef39030df73dd2`, lifecycle `nukhabapay_b3b3_79dbca483e3c43c2896c9f9529cba186`, and HTTP `nukhabapay_b3b3_e0bb657799564379a56fdeeea9c3829e`. All fixture databases, including development-test runs, were cleaned after ownership/session verification. The lifecycle suite verifies zero IAM sessions after failed startup/close. Temporary schema rename, target CONNECT denial and backend termination occurred only on its verified disposable database. Development remains on actual migrations 001–003, with the original four-database inventory. No 004 application, grants or fixture writes targeted development.

Before coding, all earlier archive/entry hashes were verified/preserved and 171 reviewed files were archived/read back: `../recovery-checkpoints/before-local-runtime-20261111T094917Z.zip`, SHA-256 `5792942f309cdaf53f894e2f3f2e23140b8d8678a89cfe84d179b72e4f3e5a33`. Environment/data/key/dependency/generated artifacts were excluded. Three pre-existing synthetic configuration sources with URL patterns were reviewed; no credentials were printed. Git remains unavailable, with no applicable AGENTS.md found; no installation or remote publication occurred. Existing workspace database dependency moves from test to runtime scope without version/download changes.

AppModule/controller registration, migrations, role provisioning, application policy/permission catalogue, catalogue recovery, financial/provider source and all previous test assertions remain unchanged. Only liveness is deployed; no readiness/staff/business endpoint, real staff, Auth0 account, reserved permission, browser, Brick 3C/4 or live transaction is added. ADR 0010 and verification record implementation, commands, actual targets, failures and limits. Stop after this increment. Proposed next bounded work is a separately approved local synthetic bootstrap/suspension and audit design/acceptance specification, without provisioning or endpoint expansion.

### Pending Management Approvals

All external-test/production region/residency/commercial, exact trust/human profile/MFA, operations ownership, real onboarding/bootstrap, environment separation, non-disposable migration, secret/network/TLS, monitoring/recovery and financial decisions remain PENDING in the register. Local lifecycle authorization changes no management status. A real staff write/audit mechanism and emergency key invalidation remain absent. These gates did not block approved synthetic development.

## Previous increment: Brick 3B-3 global staff HTTP guards (complete locally)

Verified on 11 November 2026 with synthetic identities, ephemeral signing keys and disposable PostgreSQL. Global authentication and authorization now protect matched HTTP handlers through the common Nest factory. Only the exact reviewed health class/handler/path and GET method are public. Authentication reuses bounded raw-header parsing and the unchanged verifier, checks opaque provenance, and stores validated identity only in private per-request state. No identity/tenant header or token permission claim grants authority.

Protected handlers require explicit permission/scope/GET metadata. Missing metadata, unreviewed public markers, implicit HEAD, alternate methods and reserved permissions deny. Strict/case-sensitive routing prevents health aliases, OPTIONS returns generic 404 and method-override headers are ignored. Authorization reuses fresh exact issuer/subject lookup, active staff/identity/membership/grant checks and the self-only policy. Only `staff.self.read` stays active; platform grants never confer tenant authority. There is no positive authz cache, email linking or enrollment.

Successful handlers require committed audit persistence. Reader/allow-audit/verifier/required-JWKS failures return sanitized 503 without executing the handler. Already-denied audit failure remains 403 with a fixed warning. Errors use generic classifications, no-store and a Bearer challenge on 401; response/log assertions exclude generated tokens, private identity and dependency details. The 16 KiB JSON bound, compression rejection, header cap and timeouts remain intact.

The acceptance controller exists only under test bootstrap, excluded from production compilation. Deployed AppModule/main remain unchanged and register only liveness. Default startup configures no verifier or IAM connection; any added protected route fails closed without trusted-code dependencies. Real Auth0/provider authentication and runtime activation remain unverified/unconfigured. Migration 004 remains pending on `nukhabapay_dev`; no migration, role grant, application/database source or permission catalogue changed.

The completed full run passed application 18/18, database 15/15, API 40/40 (existing 27 plus 13 HTTP guard tests), internal/HTTP PostgreSQL acceptance 21/21 (existing 10 plus 11 HTTP tests), financial/provider 19/19 and Python 9/9, with zero failures/skips. Builds/typechecks, test compilation, synthetic demo and structure checks passed. Earlier development checks caught fixture imports/optional-claim construction, router-setting initialization order, a missing Host in the duplicate-header fixture and a fixture authorization-version assumption; all were corrected without weakening existing tests or policy. Verification records exact commands and results.

Passing integration targets were `nukhabapay_b3b2_a69728a0dbd44c829f906774dcc91b47` and `nukhabapay_b3b3_3f015a89a0cd4bae9306acf726d164ac`. All generated databases, including initial test-development targets, were removed after owner/session checks. Read-only pre/post metadata confirms the original four-database inventory and unchanged development migrations 001–003. Actual restricted-role regressions preserve catalogue IAM denial, importer limits, IAM column rights, forced RLS, audit immutability and catalogue transaction recovery.

Before coding, all prior checkpoints were verified/preserved and a new reviewed 161-file archive was hash-verified: `../recovery-checkpoints/before-brick3b3-20261111T090947Z.zip`, SHA-256 `ae1513b9c295bab6ac2a0e6015f27e149d6d7af6f6d2be78e62cc9a16812a89f`. Environment/data/key/dependency/generated artifacts were excluded. Git is unavailable; no installation, dependency change or remote publication occurred. ADR 0009, security, architecture, build sequence, module READMEs and verification describe the implemented scope and remaining gates. No maintained file was deleted.

Brick 3B-3 is complete for local synthetic and disposable-PostgreSQL HTTP acceptance only. Stop here. Proposed next bounded work is a read-only operational activation/approval package naming the exact non-production trust profile, database target/migration procedure and accountable owners; actual runtime activation or further coding requires separate authorization. No staff endpoint, browser, external resource, Brick 3C/4 or live financial operation is started.

### Pending Management Approvals

Every region/residency/commercial, external trust/profile, operations ownership, real staff onboarding, MFA/recovery, environment separation, non-disposable migration, deployment/monitoring and financial decision in `docs/governance/pending-management-approvals.md` remains PENDING. The owner's local 3B-3 authorization changes none of those statuses. No pending production decision blocked the approved synthetic work.

## Previous increment: Brick 3B-2 restricted IAM runtime and internal integration (complete locally)

Verified on 11 November 2026 using synthetic identities, ephemeral signing keys and disposable PostgreSQL. The IAM-only runtime parser requires only reader/audit-writer URLs, validates exact restricted roles and matching host/effective port/database, bounds pool/timeouts and hides connection strings from ordinary inspection/serialization. Explicit initialization checks actual login flags/memberships/DDL/database ownership. No migration, catalogue runtime/importer or administrator credentials are read by this runtime; fixture administration remains separate.

The existing verifier now returns an opaque immutable shared application identity, attested only after the unchanged cryptographic/profile checks. A nominal type and runtime provenance check reject plain objects, JSON clones and structural casts. The internal bridge connects bounded Authorization parsing and verification to the existing exact issuer/subject resolver and deny-by-default policy. `readAuthorizedStaffSelf` performs fresh active staff/identity/membership checks, denies mismatched scope, expired/revoked grants, missing/reserved permissions and platform inheritance, and permits only self data. There is no email linking, enrollment or positive authorization cache.

Allow requires a committed bounded audit before output. Reader/allow-audit failure produces sanitized unavailable errors; a denied request remains denied with an audit-failure flag if persistence is unavailable. Only `staff.self.read` remains active. A self read is independent of department roles; selected tenant summaries still require active matching membership. Sensitive writes/session workflows remain deferred.

The complete run passed application 18/18, database 15/15 (including previous real catalogue/IAM acceptance), API 27/27 (all 24 verifier tests preserved), new cryptographic-token-to-IAM acceptance 10/10, financial/provider 19/19 and Python 9/9, with zero failures/skips. Relevant builds/typechecks, test compilation, demo and structure checks passed. The new explicit integration command has no skip fallback and does not run during ordinary non-destructive API tests.

The passing new integration target was `nukhabapay_b3b2_cf727cc46a6a4ab0b55a4579af665455`; its earlier test-development target was `nukhabapay_b3b2_68a624918eeb4230871da1a755b4f0f8`. Both were generated, ownership-checked and removed by their fixture. Full regression used additional generated disposable databases. Pre/post metadata confirms the original four-database inventory and unchanged 001–003 development history. Migration 004, catalogue/importer grants, permission catalogue, financial/provider source and API bootstrap/routes remain unchanged. No Auth0, real staff, browser login, protected endpoint or later brick was added.

Before coding, previous checkpoints were verified/preserved and a new reviewed 151-file source archive was created as `../recovery-checkpoints/before-brick3b2-20261111T082312Z.zip`, with a SHA-256 manifest. Git remains unavailable and was not installed. Existing versions were linked offline from the approved pnpm store; no package version upgrade or download was needed. Compiled workspace exports and dependency build order were added for the internal integration and tests.

ADR 0008 and verification document the exact scope, commands, targets, resolved new-test assumptions and remaining risks. Brick 3B-2 is complete only for local internal acceptance. The project stops here pending another bounded authorization.

### Pending Management Approvals

All region/residency/commercial, external account/trust profile, operations ownership, real staff onboarding, MFA/recovery, environment separation, non-disposable migration and deployment/financial decisions in `docs/governance/pending-management-approvals.md` remain PENDING. The owner's local 3B-2 authorization changes none of those statuses and does not authorize Brick 3B-3, 3C or 4. No pending production decision was used to block the approved synthetic work.

## Previous increment: Brick 3B-1 isolated token verifier (complete for synthetic acceptance)

Verified on 11 November 2026. The API identity folder now contains a provider-independent verifier contract, strict fail-closed development/test configuration, exact issuer/audience and approved-client checks, the `rfc9068-staff-v1` signed-human access-token profile, bounded Bearer/raw-header parsing and trusted JWKS retrieval with cache/rotation/failure bounds. JWT cryptography and standard claim validation use exactly pinned `jose` 6.2.17. The output contains only frozen validated identity and approved security evidence; assurance remains not established and the bearer/other claims are never returned or logged.

The verifier is not registered in API bootstrap, guards or controllers. The only deployed route remains `/health/live`. No staff lookup/enrollment, database access, permission activation, Auth0 provisioning, browser login or business endpoint was added. Brick 3B-2, 3C and 4 remain unstarted and require separate authorization. Actual Auth0 issuance and operations are unverified. Migration 004 and all database/application source remain unchanged.

Acceptance: 24 new synthetic verifier/configuration/header tests passed; full API suite 27/27, application 11/11, database configuration 4/4, financial/provider 19/19 and Python 9/9 passed with zero failures/skips in the completed runs. API/application/database builds and typechecks, database test compilation, demo and structure checks passed. No PostgreSQL integration/migration/destructive test was run; the previous recovery's database acceptance is historical evidence, not a new run.

Before editing, the existing recovery archive and every manifest entry were hash-verified without replacement. A separate 139-file reviewed checkpoint was created as `../recovery-checkpoints/before-brick3b1-20261111T073759Z.zip`, with its own manifest. Git remains unavailable and was not installed; environment/data/generated artifacts were excluded. Dependency installation used the existing pnpm store after approval, without a global setting change. Only the API's exact `jose` dependency and matching lockfile entries changed.

ADR 0007, the identity README, security requirements and latest verification record describe configuration, controls, tests, resolved development failures and remaining provider/deployment gates. The proposed next increment is separately approved restricted-IAM/context integration; no such work was started here.

### Pending Management Approvals

The governance document supplied during final review was preserved. The register at `docs/governance/pending-management-approvals.md` marks all unapproved region/residency/commercial, ownership, real token-profile/trust, staff onboarding, MFA/recovery, environment, operational, migration-target and later deployment/financial decisions PENDING. These gates do not block separately approved local synthetic work. No management approval or authorization to start another brick is inferred from completing 3B-1.

## Previous increment: bounded recovery (verified, 11 November 2026)

Bricks 2B and 3A are verified again within their existing local synthetic/provider-independent scopes. The recovery fixed three defects found during takeover:

- Identical catalogue replay returned from an open transaction. It now commits before releasing its pooled connection. PostgreSQL acceptance repeats replay, inspects the reused backend for an idle state with no transaction/advisory lock, and independently acquires the same lock; conflict, six-way concurrency, history preservation and post-write rollback still pass.
- The failing-migration rollback assertion inspected maintenance database `postgres`. It now verifies the actual uniquely named failed target, requires the intended division-by-zero error, and checks both absent probe table and absent failed migration history.
- Migration 004 inherited catalogue-role SELECT defaults. Before creating IAM tables it removes automatic table grants for those roles, then explicitly revokes all catalogue/PUBLIC IAM table privileges. Existing catalogue permissions and forced tenant RLS are preserved. Acceptance denies both catalogue logins reads across all nine IAM tables, checks exact IAM reader/writer column rights, and creates a new table as the migrator to prove default grants do not recur.

The final `pnpm.cmd db:test` run passed 11/11 with zero failures/skips. Application 11/11, API 3/3, financial/provider 19/19, Python 9/9, all relevant builds/typechecks, demo and structure checks passed. The earlier serialized database acceptance also passed 11/11. Commands and limitations are in `docs/verification.md`.

Before editing, 139 reviewed source/documentation files were archived and hash-verified in the sibling `recovery-checkpoints` directory. Environment files, databases, dependencies, caches and generated artifacts were excluded. No Git metadata was found in this or enclosing directories; Git was unavailable on PATH and in standard install locations. Official Git for Windows standalone/portable and WinGet installation methods were identified; no installation, system settings or remote publication was performed.

Read-only pre/post checks confirmed the same loopback PostgreSQL 17.11 target and unchanged database inventory. `nukhabapay_dev` still contains only migrations 001–003; 004 was amended as a pending migration and exercised only on disposable targets. No development migration, cluster reset, Auth0 configuration, business endpoint, live integration, Brick 3B or Brick 4 work occurred. The earlier instruction proposal for root `AGENTS.md` remains a review proposal; no instruction file was added.

## Previous increment: Brick 3A identity and authorization foundation (complete for local synthetic acceptance)

Brick 3A is complete within the implemented, provider-independent local scope. Migration 004 adds the staff identity/membership/role/permission/grant schema and append-only security-audit table. The application package provides exact issuer/subject resolution ports, staff and tenant context resolution, a fixed scoped role/permission catalogue, deny-by-default authorization, and bounded audit validation. The separate IAM reader and audit-writer roles are isolated from the migrator, catalog runtime, and importer. The importer privileges and migrations 001–003 were left unchanged.

The local database actually has not yet been migrated: `nukhabapay_dev` still reports only `001_catalog`, `002_import_role_privileges`, and `003_import_role_read_access`. Migration 004 was validated twice on fresh disposable PostgreSQL databases. The only PostgreSQL changes outside those disposable databases were creation of the two restricted local login roles; the existing cluster and development database were not recreated or reset.

Real PostgreSQL acceptance passed on a fresh disposable database: fresh and repeated migrations; seeded role/permission catalog counts; exact/case-sensitive identity round-trip and duplicate rejection; membership and tenant-scoped grant reads; tenant and role/permission scope constraint failures; denied platform-to-tenant permission leakage; active, suspended, disabled, expired, revoked, and conflicting-role outcomes; no-context and tenant-context RLS; pooled tenant-context cleanup; reader/writer ACL and column boundaries; immutable audit checks; and audit batch rollback after one insert, preserving both previously accepted tenant audit records. Pure application tests cover missing and unknown permissions/context, inactive phase, scope mismatch, object-tenant mismatch, self-approval using internal staff IDs, audit input bounds, and database failure propagation. There are no staff/grant write operations or exposed business routes.

No token verifier, browser login, Auth0 setup, external account provisioning, invitations, staff/grant management workflow, business API, or production configuration is implemented. Auth0 remains proposed and unconfigured. Issuer/audience/client settings, provider approval/procurement/region, operational ownership, and KissAux/NubbaPay identity-system reuse remain unresolved for Brick 3B. Brick 2B remains complete for its tested local synthetic, complete-snapshot scope, with its previously recorded limitations.

An application test harness compilation issue was fixed by adding pinned Node type declarations and compiling the test files to JavaScript before running them, matching the package's NodeNext `.js` import convention. One existing `nukhabapay_dev` connection configuration and migrations remain intact.

## Previous increment: Brick 2B recovery (complete)

The prior live database run exposed two distinct test defects and one repository defect:

- The identical-replay conflict was caused by stored `timestamptz` values being returned by node-postgres as `Date` objects and compared through non-canonical string conversion. Stored product identity fields had also been reconstructed incompletely. The comparison now canonicalizes timestamps and compares the full persisted product/offer content plus source version and snapshot timestamps.
- The prior rollback case failed before database writes: its second offer referenced the accepted snapshot while the import expected the failed snapshot. Snapshot mismatch and approval validation now have separate assertions. The rollback case now uses a controlled PostgreSQL trigger that fails on a later offer insert, then reads from the restricted runtime connection to prove there are no partial failed-snapshot rows and the accepted baseline is unchanged.
- The import path no longer creates an APPROVED mapping from provider input. It requires a pre-existing canonical product and approved mapping. A concurrency test exposed a pool deadlock when read-back checked out a second connection while same-identity imports held the pool; read-back now reuses the transaction's checked-out connection.
- Live ACL inspection found the existing `nukhabapay_dev` import role lacked SELECT grants despite having import writes. Migrations 002 and 003 now narrow write access and explicitly restore the intended import-role reads. Migration 003 was applied to the existing database without recreating it; effective privileges were checked.
- The local command `pnpm.cmd catalog:import:synthetic` is documented and exercised end-to-end through the application use case against a disposable PostgreSQL database. The application now uses the existing shared provider offer contract instead of duplicating it.

Final gates on this machine: `pnpm.cmd --filter @nukhabapay/database test` passed 9/9, and `pnpm.cmd --filter @nukhabapay/database test:integration` passed 9/9; both had zero failures and zero skips. They include the real CLI-to-application-to-PostgreSQL import case. Database build/typecheck, application build/typecheck and 1/1 use-case test, API build/typecheck and 3/3 tests, 19/19 domain/provider tests, 9/9 Python matching tests, structure checks (20 JSON files), and frozen-lockfile install passed. Exact commands and outcomes are recorded in `docs/verification.md`.

The test fixtures create random, uniquely named local PostgreSQL databases and no longer issue `DROP DATABASE IF EXISTS` or reuse `nukhabapay_dev`. One database from the initial deadlock investigation and two older import-test-pattern databases were verified as synthetic test fixtures with no active sessions, then explicitly cleaned up by exact name. Migrations 002/003 were applied to the existing `nukhabapay_dev` database without dropping/recreating it. No developer data, cluster, or PostgreSQL installation was reset.

## Historical increment: Brick 2A - local PostgreSQL foundation

### Scope and final verification

- Current workspace is the source of truth; no starter archive was substituted.
- Verified the actual Windows environment is native PowerShell on Windows 10/11, not WSL or a container.
- Installed and verified a user-scoped PostgreSQL 17.11 runtime under `C:\Users\Admin\PostgreSQL\pgsql` and initialized a local cluster on `127.0.0.1:5432` without disabling security controls.
- Created a disposable development database, separate migration and runtime roles, and applied the pending migration to `nukhabapay_dev` using the migration role.
- Confirmed runtime-role read-only behavior, migration idempotence, and migration rollback on a failing fixture.
- Executed the real database integration tests against the live local cluster.

### Brick 2A status

Verified and passed on this machine. The project now has:

- a working PostgreSQL 17.11 local cluster initialized in the user-scoped install path,
- distinct `nukhabapay_migrator` and `nukhabapay_runtime` roles with the runtime role configured as read-only and restricted,
- a catalog migration applied successfully to a disposable development database,
- pass/fail validation covering migration repeatability and rollback cleanup,
- a live integration suite that passes against the local cluster.

### Exact commands and evidence

- `C:\Users\Admin\PostgreSQL\pgsql\bin\initdb.exe --version` -> PostgreSQL 17.11
- `pg_ctl -D C:\Users\Admin\PostgreSQL\pgsql\data -l ... start` -> local cluster started and `pg_isready` reported `127.0.0.1:5432 - accepting connections`
- `psql -h 127.0.0.1 -U postgres -d postgres -c "SELECT version();"` -> PostgreSQL 17.11 on x86_64-windows
- `pnpm --filter @nukhabapay/database test` -> 3/3 config tests passed
- `pnpm --filter @nukhabapay/database test:integration` -> 2/2 live database integration tests passed
- `pnpm --filter @nukhabapay/database migrate` -> migration applied successfully to `nukhabapay_dev`

### Next bounded step

Proceed to the next brick only after the database-backed foundation remains green. No worker, payments, provider, AI, or business endpoint work was added in this increment.

## Previous increment: environment readiness and API foundation

### Repository inspection

- Confirmed the architecture starter and offline examples are present.
- Reviewed the project instructions, README, architecture, project inventory, data model, build sequence, verification record, security trust boundaries, three ADRs, package manifests, financial rules, synthetic provider adapters, advisory matching guard, and focused tests.
- No `AGENTS.md` was found in the workspace or its immediate parent.
- No `.git` metadata was found at the workspace root or in enclosing directories. Git initialization is not required for runtime checks.
- No prior progress record existed.
- The architecture and code identify the TypeScript sample as a synthetic AED pricing simulation, not an executable quote, and the Python matcher as deterministic advisory logic.

### Environment diagnosis

- The execution shell is native 64-bit Windows PowerShell (`Microsoft Windows NT 10.0.19045.0`, AMD64), not WSL.
- The workspace path is `C:\Users\Admin\OneDrive\Desktop\NAUKHBAPAY AI\nukhabapay`.
- Initial command discovery found no `node`, `npm`, `npm.cmd`, `git`, `py`, or `pymanager`.
- `python` and `python3` resolve to Microsoft Store WindowsApps launchers. Invoking `python --version` produced the Store message that Python was not found (exit code 9009); no Python code ran. These are not verified interpreters.
- `winget` resolves to `C:\Users\Admin\AppData\Local\Microsoft\WindowsApps\winget.exe`. WinGet 1.29.380 functioned with the configured Microsoft Store, community `winget`, and font sources.
- WinGet had no Node.js 24 package. The official Node.js distribution offered Node v24.22.2 x64 with a published SHA-256 checksum.
- WinGet catalog metadata for `Python.Python.3.13` identified Python Software Foundation, version 3.13.17, x64 installer hosted at `python.org`; WinGet verified the installer hash during installation.
- The first environment failure was actual absence of usable runtimes, not only a Python alias or stale VS Code. After install, VS Code-launched PowerShell retained its old process PATH; explicit verified paths were used, while the existing user PATH was appended to rather than replaced. A reconstructed environment from the saved machine/user PATH resolves Node, npm.cmd, Python, py, and pnpm.cmd correctly. Fully restart VS Code before relying on bare commands in its existing integrated environment.

### Installed toolchain

- Node.js v24.22.2 x64 is installed at `C:\Users\Admin\AppData\Local\Programs\node-v24.22.2-win-x64`. The official archive SHA-256 matched `ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2`.
- npm 11.19.1 is bundled with Node.js. `npm.cmd` works without invoking `npm.ps1`.
- CPython 3.13.17 x64 was installed per-user through WinGet at `C:\Users\Admin\AppData\Local\Programs\Python\Python313\python.exe`.
- Verified executable paths: `C:\Users\Admin\AppData\Local\Programs\node-v24.22.2-win-x64\node.exe`, `C:\Users\Admin\AppData\Local\Programs\node-v24.22.2-win-x64\npm.cmd`, and `C:\Users\Admin\AppData\Local\Programs\Python\Python313\python.exe`.
- Observed versions: Node `v24.22.2`, npm `11.19.1`, and Python `3.13.17` (64-bit CPython).
- The Python WindowsApps `python.exe`/`python3.exe` aliases remain Store launchers and still fail to start an interpreter. The installed `py.exe` launcher and absolute CPython path both execute successfully. The Python install paths precede WindowsApps in the saved user PATH; no alias setting was disabled.
- Corepack `0.36.0` set the project pin to pnpm `10.34.9` including its package-manager integrity hash. `corepack.cmd enable pnpm --install-directory C:\Users\Admin\AppData\Local\Programs\node-v24.22.2-win-x64` created the user-scoped `pnpm.cmd` shim.
- pnpm engine, version-strictness, and peer-dependency settings are in `pnpm-workspace.yaml`. An initial `.npmrc` placement produced npm warnings, so it was removed; existing `npm.cmd run demo` and `npm.cmd test` then passed without those warnings.
- No execution policy, antivirus, signature, or certificate setting was changed. No unrelated installation was removed or overwritten.

### Verification status

- Baseline re-run on this machine after implementation: demo passed with AED 102.00 customer total and AED 2.77 expected contribution; TypeScript tests passed (19/19); Python tests passed (9/9 methods, including fixture cases); structure checks passed (17 JSON files and the documented scaffold checks).
- Exact baseline commands and tool versions are recorded in `docs/verification.md`.
- API acceptance passed: frozen-lockfile install, Nest build, strict TypeScript check, 3 API tests, and a compiled-entry startup probe.
- A fresh effective PATH assembled from the saved machine/user values resolved `node`, `npm.cmd`, `python`, `py`, and `pnpm.cmd`; exact versions and executable paths are in `docs/verification.md`.
- Resolved issues during setup: Corepack initially lacked a `pnpm.cmd` shim for recursive package scripts; enabling the shim fixed it. The first strict typecheck identified index-signature property-access and type-only import errors; both were fixed and the final check passes.
- No baseline, build, typecheck, or API test failures remain. Existing PATH entries were preserved, and no policy/security settings were changed.

## API foundation

Complete for this bounded increment. The API has a pinned Node/pnpm/NestJS/compiler toolchain, strict TypeScript settings, validated configuration with a loopback default, bounded JSON handling, sanitized errors, a process-only `/health/live` route, and startup/configuration/HTTP tests. Verification evidence is in `docs/verification.md`.

No worker runtime, database, migrations, persistence, authentication, business endpoints, provider integration, AI calls, payment behavior, or deployment was added.

## Historical Brick 2B handover and remaining identity prerequisite

### Brick 2B handover

Brick 2B is **complete** for the tested local synthetic, complete-snapshot
import/read workflow. Its limits remain: it is not an authenticated catalog
API, delta-feed implementation, price-publication system, live-provider
integration, or production-readiness claim. Imports require pre-registered
canonical products and approved mappings. Preserve the completed acceptance
baseline and restricted importer permissions.

An earlier roadmap sentence described publication and customer-facing reads
as the next step. That sequence is superseded: publication/customer catalogue
work must not skip the agreed identity and authorization increment.

### Remaining Brick 3 work — provider-backed identity (not started)

The smallest next increment is an API authentication boundary that validates
tokens from a selected trusted identity provider, resolves the verified
issuer/subject to active server-side tenant membership and permissions, and
passes an explicit authorized context into an internal application operation.
It adds no customer-facing business endpoint. The acceptance cases and
package boundaries are defined in `docs/build-sequence.md`.

The identity-provider decision is still open. Local staff/membership records
and authorization are implemented under ADR 0006, but no real issuer, API
audience, registered client or operational provisioning/deprovisioning process
is selected. Choose and document the provider and lifecycle before token
validation; do not substitute tenant headers, custom token schemes or other
authentication shortcuts. The recovery increment does not authorize this work.

The design prerequisite is now recorded in
[`docs/adr/0005-trusted-identity-provider.md`](adr/0005-trusted-identity-provider.md).
It recommends **Auth0-managed OIDC provisionally**, compares self-hosted
Keycloak, scopes the first callers to staff only, and defines proposed tenant,
membership, permission, and revocation behavior. This recommendation is
**proposed and awaiting approval/information**, not an implemented or verified
identity system. No issuer, API audience, client, secret, or provider account
has been configured. Repository inspection found only planning placeholders
for API identity/admin UI/device modules and no evidence of an existing
KissAux or NubbaPay login integration; owners must confirm whether such an
external system exists.

Brick 4 follows completion of Brick 3: controlled price publication and an
authorized catalogue API. Brick 3A is implemented and recovered within its
local scope; Brick 3B has not started. Provider approval and the other ADR
0005 prerequisites remain open. Neither Brick 3B nor Brick 4 was started by
the recovery increment.
