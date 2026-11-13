# Verification record

## Track B Auth0 browser login source acceptance

13 November 2026, Asia/Dubai; branch `brick3/auth0-login`. Implemented gated BFF authorization-code login with S256 PKCE, one-use state/nonce/browser transactions, exact callback and token trust validation, signed fresh MFA checks, existing trusted staff/tenant/session binding, rotation and CSRF-protected local/provider logout handoff. See [configuration and security contract](security/staff-auth0-login.md).

Final logical results: **156 tests passed, zero failed/cancelled/skipped**: BFF authentication/pinned HTTPS 14; application 94; API authentication/runtime 48. Commands: `pnpm.cmd staff:test` (existing protected localhost certificate supplied process-only), `pnpm.cmd application:test`, `pnpm.cmd api:test`. `pnpm.cmd staff:build`, `pnpm.cmd staff:typecheck`, recursive API/dependency builds and `git diff --check` passed. Tests use synthetic identities, actual RSA signature verification and mocked Auth0 responses. An initial cookie-attribute assertion used the extracted cookie value; the fixture was corrected before passing verification.

CLI login/session activation remains disabled. No real Auth0 exchange, staff onboarding, persistent database/IAM deployment, PostgreSQL authentication, migration, trust-store change, dashboard UI or privileged operation was performed. Real provider profile/MFA emission, exact registration/secrets, browser TLS trust and approved operational composition remain pending. This is source acceptance only; stop for review.

## Brick 4A controlled draft publication acceptance

Date: 13 November 2026, Asia/Dubai. Scope: synthetic immutable draft candidates and proposed migration 007 on generated disposable PostgreSQL only. No provider connection, deployed endpoint, publication activation, payment, Auth0 change or persistent migration.

| Command | Actual result |
| --- | --- |
| `pnpm.cmd application:test` | 93 passed, 0 failed/skipped; includes 7 new deterministic candidate/pricing/advisory cases |
| `pnpm.cmd catalogue:publication:test:integration` | 6 passed, 0 failed/skipped on disposable 001-006 plus pending 007 |
| `pnpm.cmd db:test` | 18 passed, 0 failed/skipped |
| `node scripts/test/run-catalogue-publication-acceptance.mjs --migration-only` | 34 passed, 0 failed/skipped; combined 001-006 ACL/RLS/authority/session/restore regression |
| `pnpm.cmd api:test` | 48 passed, 0 failed/skipped |
| `pnpm.cmd test` | 19 financial/domain/provider tests passed |
| `python -B -m unittest discover -s apps/ai-service/tests -v` | 9 passed |
| `pnpm.cmd application:typecheck`, `pnpm.cmd db:typecheck`, `pnpm.cmd api:typecheck` | Passed |
| Recursive application/database/API/admin-web builds invoked by integration commands | Passed |
| `pnpm.cmd demo` | Passed; AED 102.00 total, AED 2.77 contribution, non-executable |
| `python -B scripts/check_structure.py` | Passed; 25 JSON files and selected boundaries |

The new PostgreSQL acceptance proves missing migration authorization, hostile schema ACL and unexpected default grants fail closed; all four draft tables use FORCE RLS; existing catalogue/IAM roles have no new table rights; the draft writer cannot update/delete or read IAM; concurrent identical requests create one candidate/event; changed-payload replay, stale version and cross-tenant evidence reject; event failure rolls back all candidate/source/request/event rows; and the same pool remains usable after rejected transactions.

The acceptance launcher uses process-local synthetic loopback credentials under the existing local test arrangement, records no credential, and compares persistent development history/database inventory before and after. Final evidence confirmed `nukhabapay_dev` remained exactly 001-003 and disposable databases/roles were removed. Pending 007 is absent from the registered migration manifest.

Resolved during verification: PostgreSQL privilege inquiry functions require individual table privilege names and column privileges do not include DELETE; the checks now use explicit predicates. A SERIALIZABLE transaction that executed `set_config` before waiting on an advisory lock retained a stale snapshot and could race into a uniqueness violation; the adapter now uses the explicit tenant/product lock with READ COMMITTED fresh statements. A regression-launcher variable was corrected to the existing `NUKHBAPAY_PG_TEST_BIN`; the final combined run then passed 34/34. Assertions and timeouts were not weakened.

## 13 November 2026 — persistent IAM activation readiness

Final verdict: **source readiness controls complete; persistent deployment NO-GO**. No persistent database write, migration, role/ACL/credential/HBA change, Auth0 activation or staff/session runtime activation occurred.

Final executable results, all with zero failed/cancelled/skipped:

| Command | Result |
| --- | --- |
| `pnpm.cmd db:test:persistent-readiness` | 5/5 passed: explicit authorization/target rejection, redaction/no apply export, manifest/source tamper rejection, unexpected grant rejection and unregistered grant-envelope validation. |
| `node --test scripts/test/persistent-development-trust-rejection.mjs` | 1/1 passed: current loopback trust was rejected by the wrong-password proof; development history remained exactly 001–003. |
| `node scripts/test/run-disposable-persistent-readiness.mjs --database-regression` | 18/18 database tests passed with real disposable PostgreSQL; generated inventory restored. |
| `pnpm.cmd db:test:persistent-readiness:disposable` | 34/34 combined 001–006 migration/RLS/ACL/session/rollback/concurrency/pg_dump/pg_restore cases passed; generated inventory restored. |
| `pnpm.cmd test` | 19/19 financial/domain/provider regressions passed. |
| `pnpm.cmd db:verify:sources` | immutable ten-input manifest passed; no database connection. |
| `pnpm.cmd db:typecheck` | strict database TypeScript check passed. |
| `python -B scripts/check_structure.py` | structure, 25 JSON files, public-field separation and selected import checks passed. |

**77 final counted tests passed.** Registered migration hashes remain 004 `ebb5b282d9afad7dc5ef7b8221bd7b34942c1cbb53757e73832987b36975b312`, 005 `41910d1aa060a1971c8e33e123b0e350d884ffede490cb71b52dc00838779390`, and 006 `035fa9bb914de3cb4094f8e98ce2fa9164dc4e6b5e11b40ddfdd55707bc98eed`; manifest verification passed unchanged.

Failures found and corrected during verification:

- The first combined launcher used a five-minute child timeout and was terminated during a slow disposable case. One exact generated b3b3 database was verified by its strict name and removed; the timeout is now 15 minutes. No persistent object/history changed.
- The next combined run passed the security cases but the restore subtest rejected a missing explicit PostgreSQL binary directory. The launcher now verifies `pg_dump.exe` and `pg_restore.exe` before starting. The final run passed 34/34, including restored owners/grants/FORCE RLS/history/session evidence.
- The full database regression exposed that its legacy catalogue-only helper discovered registered 004–006 and invoked 006 without the reviewed staged manifest/sidecars. `--count 3` did not change discovery semantics. Both helpers now stage exact 001–003 source files in verified temporary directories and remove them safely; IAM/session migrations remain exclusively on the reviewed manifest runner. Final database result was 18/18.
- A strengthened object-ACL query initially passed the internal generic rejection but the direct live-evidence assertion exposed PostgreSQL `42883` from an incorrect `acldefault` argument type. The check now explodes only explicit relation ACLs (a NULL ACL has no non-owner grant to inspect); the direct target-evidence phase succeeds before the independent trust-rejection phase.

Read-only target evidence: PostgreSQL 17.11, literal loopback/5432, owner/current migration role `nukhabapay_migrator`, development history exactly 001–003, IAM/session objects absent, canonical five roles without unsafe flags/memberships, expected database/schema/default ACL baseline, and no prepared/competing project transaction at preflight. Current HBA loopback authentication remains trust, intentionally causing persistent preflight rejection. The pre-change checkpoint `../recovery-checkpoints/before-persistent-iam-readiness-20261113T083158157Z.zip` remains preserved (252 files; SHA-256 `4af1c77640d12fd38c280c88b822dd5c50af63e0b2076a6908e8b9d4f5b16bab`).

Operational blockers remain: reviewed SCRAM/HBA and distinct secrets; named change/operator, backup/recovery and maintenance approvals; restored-development-backup rehearsal; IAM/session credential/grant provisioning; post-migration monitoring/retention; and a separately registered persistent activation wrapper/source transition because immutable 004–006 guards still reject `nukhabapay_dev`.

## Development IAM deployment preparation - 13 November 2026

Read-only repository and PostgreSQL inspection only; no test suite or migration was run. The verified target reported PostgreSQL 17.11, literal loopback port 5432, database `nukhabapay_dev`, owner/current migration role `nukhabapay_migrator`, and migration history exactly 001–003. IAM/session objects remain absent. Database size was approximately 8 MB; counts for tenants, products, provider accounts, mappings, snapshots and offers were all zero at inspection time.

The five project roles reported LOGIN with no SUPERUSER, CREATEDB, CREATEROLE, INHERIT or BYPASSRLS flags and no memberships. Only the catalogue runtime had recorded role-level read-only/timeout settings. The current database/schema ACL permits the migrator and catalogue runtime, while identity reader/writer and importer lack CONNECT/schema USAGE; importer table grants exist but are unusable through that envelope. Owner default table ACLs grant SELECT to catalogue runtime/importer. Loopback/local ordinary and replication HBA rules reported `trust`. No setting was changed.

Source inspection establishes a persistent-deployment blocker: the migration runner, 004 preflight, migration 005, reviewed 006 sidecar, session grant recipe and session store all reject `nukhabapay_dev`. The portal has no deployed persistent session configuration. Accordingly the readiness verdict is **NO-GO**, despite the existing database being the recommended eventual target. See `docs/runbooks/development-iam-deployment.md` for prerequisites and recovery procedure.

## Controlled migration 006 registration - 13 November 2026

**PASS: 006 is registered in source history and the focused verification passed 120 tests with zero failures or skips.** This bounded run intentionally did not repeat the complete 355-test project suite because application/session and combined PostgreSQL coverage were the relevant changed surfaces. Registration did not authorize a persistent database operation.

Registered source and integrity results:

- `packages/database/migrations/006_staff_server_sessions.ts` SHA-256: `035fa9bb914de3cb4094f8e98ce2fa9164dc4e6b5e11b40ddfdd55707bc98eed`.
- Frozen 004 SHA-256 remains `ebb5b282d9afad7dc5ef7b8221bd7b34942c1cbb53757e73832987b36975b312`.
- Frozen 005 SHA-256 remains `41910d1aa060a1971c8e33e123b0e350d884ffede490cb71b52dc00838779390`.
- Reviewed additive IAM SQL remains `ff8a9c7d36ad00baff7ec1e79655aed03358a606a3631d11cbce528e9a1595c8`; reviewed session SQL remains `37c784fa25404b5d20ee9aa6856dba856a088dcc67f80c652680078637b01cc4`.
- The manifest uses `REGISTERED_MIGRATIONS_V1` / `006_REGISTERED_LOCAL_SOURCE_HISTORY`, contains ten exact inputs, and no longer admits the old pending TypeScript path or a candidate-mode runner switch. The runner independently pins all six numbered hashes; tests reject both wrapper-only tampering and a coordinated 006-plus-manifest hash change before connecting.

Commands and actual results:

```text
pnpm.cmd db:verify:sources
node packages/database/node_modules/typescript/bin/tsc --noEmit --module NodeNext --moduleResolution NodeNext --target ES2022 --strict --skipLibCheck --noUnusedLocals --noUnusedParameters --noImplicitReturns --exactOptionalPropertyTypes packages/database/migrations/006_staff_server_sessions.ts
node --check scripts/rehearse-reviewed-migrations.mjs
pnpm.cmd application:test                                  # 86 passed, 0 failed, 0 skipped
pnpm.cmd api:build                                         # passed
node apps/api/node_modules/typescript/bin/tsc -p apps/api/tsconfig.test.json
node --test --test-concurrency=1 apps/api/dist-test/test/migration006.integration.js
                                                            # 34 passed, 0 failed, 0 skipped
```

The 34 PostgreSQL tests executed registered 001–006 on fresh random disposable targets. They verified manifest tamper rejection, exact order/dependency/replay behavior, migration advisory locking and single-transaction execution, hostile defaults/schema ACL rejection, 16 FORCE-RLS tables, exact catalogue/IAM/workflow/session privileges, failed-up rollback and forward retry without down, audit rollback, independent-connection concurrency, authority cutoff/version invalidation, session creation/rotation/expiry/revocation, durable `AUTHORITY_CHANGED`, pool restart evidence, and custom-format dump/single-transaction restore plus failed-restore atomicity. All six recorded disposable targets were removed by guarded fixture cleanup.

Artifact `../recovery-checkpoints/migration-security-verification-20261113T071423525Z` preserves the initial focused redacted log, command results and before/after metadata. After the independent in-code 006 hash pin was added, the changed 34-test suite passed again; `../recovery-checkpoints/migration-006-registration-final-tests-20261113T0728Z.json` records its command, counts and six removed targets. Final read-only artifact `../recovery-checkpoints/migration-006-registration-final-20261113T072905132Z.json` confirms development history exactly 001–003, registered source files exactly 001–006, no IAM/session objects in development, and zero disposable databases, generated roles, disposable connections or task temporary directories. Therefore 004–006 were not applied to development.

The verified pre-registration source checkpoint is `../recovery-checkpoints/before-migration-006-registration-20261113T071118818Z.zip`, 250 reviewed source files, SHA-256 `aa13e92f84cc0dfa76e4e13919990756cb91fbd11a911e8218c414871a895a29`. It excludes environment files, certificates, keys, databases, logs, dependencies and build outputs. Existing checkpoints were not changed.

No role recipe, SQL privilege, lockfile, Auth0 setting, certificate store, real staff record, public endpoint, privileged approval/APPLY path or financial operation changed. Registration is complete; application to any persistent target remains gated by management approval, target/owner/backup/restore readiness and post-migration security acceptance. See ADR 0024.

## Migration security corrections and combined 001-006 acceptance - 13 November 2026

**355 distinct tests passed; zero failures or skips in final logical suite results.** This total does not sum repeated executions. Historical failed command executions remain in their timestamped logs. The bounded correction task is complete locally; real Auth0, privileged execution, persistent migration activation and operational Brick 3 completion are not claimed.

### Commands and results

| Suite | Final passing command | Tests |
| --- | --- | ---: |
| Application policy/session | pnpm.cmd application:test | 86 |
| Database/migration/privileges | node --test --test-concurrency=1 packages/database/dist-test/database/test/*.spec.js | 15 |
| API/authentication | pnpm.cmd api:test | 48 |
| Existing IAM/HTTP/workflow | Direct compiled five-file command below | 123 |
| Existing PostgreSQL sessions | pnpm.cmd staff:sessions:test:integration | 18 |
| Combined migration/security | node --test --test-concurrency=1 apps/api/dist-test/test/migration006.integration.js | 34 |
| HTTPS/cookie/CSRF | pnpm.cmd staff:test | 3 |
| Financial/provider | pnpm.cmd test | 19 |
| Python advisory matching | python -B -m unittest discover -s apps/ai-service/tests -v | 9 |

```text
pnpm.cmd db:verify:sources
pnpm.cmd application:build
pnpm.cmd application:typecheck
pnpm.cmd db:build
pnpm.cmd db:typecheck
node packages/database/node_modules/typescript/bin/tsc -p packages/database/tsconfig.test.json
pnpm.cmd staff:build
pnpm.cmd staff:typecheck
pnpm.cmd api:build
pnpm.cmd api:typecheck
node apps/api/node_modules/typescript/bin/tsc -p apps/api/tsconfig.test.json
node --test --test-concurrency=1 apps/api/dist-test/test/internal-staff-access.integration.js apps/api/dist-test/test/staff-http.integration.js apps/api/dist-test/test/local-api-runtime.integration.js apps/api/dist-test/test/staff-persistence.integration.js apps/api/dist-test/test/migration005.integration.js
node packages/database/node_modules/typescript/bin/tsc --noEmit --module NodeNext --moduleResolution NodeNext --target ES2022 --strict --skipLibCheck --noUnusedLocals --noUnusedParameters --noImplicitReturns --exactOptionalPropertyTypes packages/database/pending-migrations/006_staff_server_sessions.ts
pnpm.cmd demo
python -B scripts/check_structure.py
```

All listed final checks passed. The demo remains OFFLINE_SYNTHETIC_SIMULATION with AED 102.00 total and AED 2.77 contribution. Structure checks validate 25 JSON files. No dependency installation, version upgrade or lockfile change was needed. Domain/provider source and existing authentication guards/configuration are unchanged.

### Evidence and database targets

The enclosing workspace recovery-checkpoints directory preserves seven migration-security-verification timestamped runs, each with redacted command/result evidence. Final logical results are selected in migration-security-verification-summary.json. Builds/typechecks and application/database/API/HTTPS results passed in the 20261113T062545014Z run; the prior session suite passed in 20261113T061311194Z. The complete final compiled IAM suite, combined suite, financial/provider, demo, Python and structure results passed in 20261113T065010938Z. The explicit pending-wrapper typecheck also exited zero. These are actual separate runs, not an assertion that the last pnpm build-plus-IAM command completed.

All destructive acceptance used newly created, owned, random disposable targets at verified 127.0.0.1:5432, PostgreSQL 17.11. Final combined source target: nukhabapay_b3b3_4d0c784c191448b98f9ba6c56c97738d. Clean restore target: nukhabapay_b3b3_3e58af0b5933426b9d862fb6df1ea083. Deliberate failed-restore target: nukhabapay_b3b3_207fe8721782487db6c16bc816d2bd3e. These targets are removed. Exact remaining targets from each run are recorded in the logs. No development/shared migration was performed.

The final read-only metadata artifact migration-security-final-20261113T065607036Z.json verifies development history 001_catalog, 002_import_role_privileges, 003_import_role_read_access only; IAM/session tables/schema and the new identity binding index are absent. The five original logins retain NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOINHERIT/NOBYPASSRLS, no memberships, no generated roles, no project connections and no disposable databases. Temporary rehearsal/test directories are absent. Registered migration files remain exactly 001-005.

### Security acceptance

- Preflight rejects unreviewed global/schema table/function/sequence defaults and hostile existing schema ACLs without changing history or defaults. 006 rejects schema CREATE/USAGE defaults for PUBLIC, every canonical workload and an unknown role, and rejects an injected actual namespace grant atomically.
- The actual SQL guard rejects NULL address/port metadata, remote addresses, wrong ports and missing 005 history. Native Unix sockets are unavailable here; substituted connection-metadata inputs execute the unchanged guard predicate in real PostgreSQL. This is a coverage limit, not a skipped test or a claim of native Unix transport acceptance.
- The staged wrapper verifies exact dependencies/order and commits the complete 001-006 sequence. A deliberate 006 schema conflict rolls back earlier IAM/catalogue DDL, grants and migration rows; clean forward retry/replay works. An empty migrator-created history table may remain, and sequence IDs need not be contiguous. No destructive down is used as recovery.
- All 16 scoped IAM/workflow/session tables have ENABLE/FORCE RLS. Catalogue roles cannot read IAM/workflow/session information. Only SELECT(tokens_valid_after) is added to the IAM reader; contact fields and mutation remain denied. Workflow grants stay unchanged. Session grants remain exactly 27 SELECT columns and 23 INSERT columns, without IAM/DDL/mutation/function execution rights or memberships. No new SECURITY DEFINER function exists.
- Verified issuance must be strictly after the persisted cutoff; equality, stale/malformed/missing evidence deny. Real PostgreSQL tests exercise suspension/reinstatement between reads, identity/membership/grant changes, emergency cutoff advancement, version/cutoff rollback attempts, independent-connection concurrency, immutable identity/scope bindings and rollback after failed audit. Fixed permission changes and staff command execution remain denied.
- AUTHORITY_CHANGED persists as the actual revocation reason. Old rotated/logout-cookie replay cannot poison a current sibling actor. Creation/rotation/revocation, expiry, uncertain acknowledgement, independent pools, failed transactions, audit outage and connection termination/recovery retain fail-closed acceptance. A cold actor registry cannot authenticate persisted rows; a pool restart preserves durable evidence without minting authority.
- Actual pg_dump custom archives and pg_restore --single-transaction --exit-on-error restore complete migration/session evidence, role ownership/grants and FORCE RLS into a fresh disposable target. Evidence SHA-256 digests match, immutable triggers still reject mutation, and a failed restore leaves no partial schema. Temporary dumps are removed. This does not establish operational RPO/RTO, cross-cluster role provisioning, failover or media-loss recovery.

### Failures found and corrected

Five failed project-command executions are preserved:

1. The first targeted combined test found replay of a rotated cookie poisoned the replacement actor. Credential-only invalidation is now separated from observed authority loss; a new deterministic application test and PostgreSQL case pass.
2. An existing wrong-name 005 test was intercepted by the new preflight during setup. The deliberately invalid fixture now receives historical 004 only, with no validity grant/activation safeguards; the original 005 rejection assertion remains intact.
3. An identity-rebind test encountered a foreign-key rejection before the intended immutability guard. Guard/propagation triggers now execute before the row change; exact error assertions and the complete contract pass.
4. A failed pg_restore process could exit before server-side connection termination completed. Cleanup now polls for at most two seconds, clears statistics snapshots, and retains the exact zero-connection assertion. No backend is killed and DROP DATABASE is not forced. The one leftover empty failed-restore fixture was verified against its run log, owner, actual target, emptiness and zero connections before removal; an additive cleanup artifact records it.
5. Under host load the outer 240-second verification deadline expired during pnpm build-plus-IAM acceptance. Process metadata was inspected with permission; no task-owned process remained by the time inspection completed. One interrupted empty fixture was identified using the baseline inventory, creation time, exact owner, absence of all project objects and zero connections, then removed with evidence. Freshly compiled five-file IAM acceptance then passed all 123 tests directly. Only the outer helper deadline became 600 seconds; no production/database/query/test timeout or assertion was relaxed. A launcher mode-dispatch typo caused a full repeat rather than the intended tail; it is corrected and the actual executed commands remain recorded.

An initial sandbox attempt could not read existing private test-certificate metadata; approved read-only access through the existing encrypted certificate/DPAPI launcher resolved that environment issue. No certificate was created/installed/trusted, and Windows trust remains unchanged. The metadata cleanup probes rejected incomplete assumptions before performing any destructive command; only fully verified empty task fixtures were removed.

### Integrity, verdicts and gates

The 241-file pre-correction source archive before-migration-security-20261113T053033Z.zip is preserved with SHA-256 345197a2cbfab661160d1fef65b2a21d79e6c3faec73a0b50f046652199a805a. The earlier reviewed checkpoint is also intact. Frozen 004/005 hashes are recorded in the correction runbook and enforced by the runner; altered/missing sources and tampered frozen manifest entries reject before connecting. The final reviewed ten-input migration manifest SHA-256 is d62874390ea1abea47c69bb594886c9585f1b265142308c0736c92b63aaf0a60. Source archives contain no secret/environment/certificate/database material. Final change hashes cover the exact 42 maintained repository files, with three task-owned verification helpers outside the repository.

004: PASS with the reviewed preflight/additive safeguards; 005: PASS for non-authorized synthetic persistence; candidate 006: PASS for combined disposable acceptance, UNREGISTERED. No existing development migration, role flags or grants were changed. Accepted privileged approvals, APPLY, reserved permissions, real Auth0, real employees, public business routes and financial execution remain disabled. Registration, persistent targets, real provider/assurance/bootstrap, browser HTTPS trust, operational secrets/monitoring/recovery and session HA/retention/refresh remain PENDING. Stop for review. See ADR 0023 and security/migration-security-rehearsal.md.

## Preserved earlier verification

## Local HTTPS staff BFF and server-session foundation - 12 November 2026

Local synthetic implementation is verified. **319 distinct project tests pass, zero latest failures/skips:** application 84 (including nine session tests), database 15, API/authentication 48, existing disposable IAM/HTTP/workflow acceptance 123, new disposable session acceptance 18, staff HTTPS/CSRF 3, financial/provider 19 and Python 9. Existing assertions remain intact; the authorized unused cookie-name assertion now expects the canonical name. An initial complete run passed 318 before adding the mid-flight authority-change regression. Failed intermediate runs remain preserved and are explained below.

**Windows trust is intentionally unchanged at the owner's explicit instruction.** The certificate generation succeeded in CurrentUser My, but Root installation met Windows' interactive Security Warning and did not complete. Remaining task-owned trust processes were checked/cancelled; the reviewed Root entry is absent. No LocalMachine or global execution-policy change occurred. The actual HTTPS bootstrap was verified at **https://localhost:3001**, IPv4 loopback, with curl using the exact public certificate and normal chain/hostname verification. No TLS bypass was used. Windows/browser trust is not established; certificate warnings must not be bypassed. The explicit `-PinnedCertificateOnly` launcher mode supports clients configured to trust the exact public certificate without modifying Windows trust.

The browser receives no Auth0 access token/client secret. CLI session mode remains disabled, GET /auth/session returns 503, and GET /auth/callback returns 404. Auth0 callback configuration is **not ready for activation**. Real Auth0 login, real MFA, staff onboarding, accepted privileged approvals, APPLY, reserved permissions and live finance remain blocked. Brick 3/operational Brick 3C completion is not claimed.

### Commands and actual evidence

Pinned pnpm 10.34.9 ran `install --lockfile-only --offline --ignore-scripts --store-dir ../.pnpm-store --reporter=append-only`, then `install --offline --frozen-lockfile --ignore-scripts --store-dir ../.pnpm-store --reporter=append-only` from the repository. Ten workspaces now include the existing admin-web area. No new third-party runtime dependency, version or integrity change occurred; the full third-party lockfile package/snapshot suffix matches the pre-increment archive. Install scripts were disabled.

Verified project commands (from the existing repository root):

```text
pnpm.cmd staff:sessions:test:integration
pnpm.cmd staff:test
pnpm.cmd application:build
pnpm.cmd application:typecheck
pnpm.cmd application:test
pnpm.cmd db:build
pnpm.cmd db:typecheck
node packages/database/node_modules/typescript/bin/tsc -p packages/database/tsconfig.test.json
node --test --test-concurrency=1 packages/database/dist-test/database/test/*.spec.js
pnpm.cmd staff:build
pnpm.cmd staff:typecheck
pnpm.cmd api:build
pnpm.cmd api:typecheck
pnpm.cmd api:test
pnpm.cmd --filter @nukhbapay/api test:identity:integration
pnpm.cmd test
pnpm.cmd demo
python -B -m unittest discover -s apps/ai-service/tests -v
python -B scripts/check_structure.py
```

The protected-certificate launcher is `powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File recovery-checkpoints/verify-staff-sessions.ps1 -Mode Full` from the enclosing workspace. Mode Recovery reran the failed IAM suite without changing its timeout/assertions and verified the final application, portal, session, financial, Python, demonstration and structure checks. Final Application and Sessions modes reran the last actor-wide negative-invalidation change. The launcher unprotects the user-only DPAPI passphrase only into the child process and redacts it along with all database credentials. Missing TLS/database settings fail; required tests have no skip fallback.

Evidence under `../recovery-checkpoints/`:

- `staff-sessions-verification-20261112T122807793Z` records the complete interim 318-test pass.
- `staff-sessions-verification-20261112T124715566Z` preserves the subsequent unchanged IAM connection-timeout failure, plus passing builds/typechecks/application/database/API/portal checks.
- `staff-sessions-verification-20261112T130247214Z` records the successful final recovery checks, including all 123 existing IAM/HTTP/workflow tests and 18 session tests.
- `staff-sessions-verification-20261112T132157154Z` and `staff-sessions-verification-20261112T132209659Z` record the final 84 application and 18 disposable session tests after actor-wide negative invalidation. Other earlier focused runs, including failures, remain preserved.
- `staff-sessions-verification-summary.json` consolidates the latest passing result for each of 19 distinct commands, exact suite counts and prior failed commands; repeats are not added to the 319 total.
- `staff-https-probe-20261112T130950305Z.json` records real port-3001 curl verification with explicit public-CA trust: portal/liveness 200, default-disabled session 503, unimplemented callback 404, then listener cleanup.
- `staff-session-security-20261112T132527745Z.json` records independent read-only migration/role/cleanup and protected-source checks.
- `staff-sessions-changes.json` records every changed maintained path and its before/after hash. The session runbook contains the complete file inventory.

### Implemented security behavior

The existing opaque actor boundary supplies runtime-registered immutable evidence tied to that exact handle, after fresh exact issuer/subject, canonical staff, active membership, staff/membership versions and time-dependent grant checks, plus committed authorization audit. JSON actors, cloned proofs, UUIDs, another actor's proof and real-provider issuers do not create synthetic session authority. No enrollment, email linking, role inheritance or positive authorization cache is added. The session kernel is default-disabled and accessible only to trusted internal composition; no HTTP operation creates a session.

Random 32-byte session credentials are hash-only in PostgreSQL/in-memory lookup; credential and dependency inspection does not expose credentials. Immutable records bind identity, scope, versions, authority digest and idle/absolute/original-identity expiry. Old-cookie replay after rotation/revocation fails. Observed invalidity is permanent for the session/actor handle, including sibling generations and changes during commit acknowledgement. Reversed status/version values cannot revive an observed-invalid handle. Dependency outage, failed audit or unknown commit never yields a successful credential/validation/confirmed logout. Authoritative tombstone lookup confirms uncertain revocation without duplicating audit.

Cookie `__Host-nukhbapay_staff` has Secure, HttpOnly, SameSite=Strict, Path=/ and no Domain. Exact Host/Origin/Fetch Metadata checks, HMAC CSRF/timing-safe comparison, duplicate-cookie rejection, empty JSON logout, bounded headers/body/timeouts, no-store/CSP/nosniff/no-referrer protect the BFF. The deployed API remains liveness-only with its unchanged disabled/local-synthetic modes and JWT validator. Browser/source/token/login/callback aliases do not bypass controls.

### Proposed persistence and privilege evidence

Unregistered candidate `packages/database/pending-migrations/006_staff_server_sessions.sql` adds `nukhbapay_sessions.sessions` and `events`, fixed immutable creation/use/revocation evidence, two FORCE-RLS actor/scope policies, four SECURITY INVOKER functions (pg_catalog search_path) and five triggers, including deferred complete-creation/rotation constraints. A unique index on existing IAM staff/issuer/subject supports an exact identity FK; it changes no staff row or existing role grant. No registered migration 001-005 source is changed, and no 006 history row is registered by the rehearsal.

The explicit owner recipe grants only 27 SELECT columns and 23 INSERT columns on those two new tables to a separately created ephemeral restricted backend. It grants no table-wide rights, UPDATE/DELETE/TRUNCATE/REFERENCES, executable function, DDL/TEMP/role/membership or effective IAM/catalogue access. Known workload/PUBLIC grants are removed from the new objects; unknown default grantees reject and roll back the entire candidate. Existing IAM/catalogue ACL snapshots stay equal. Existing IAM audit writer cannot write session/lifecycle-success events. Runtime startup rejects missing/excess/unknown-column rights, wrong roles or development targets.

READ COMMITTED operations use sorted per-session transaction advisory locks before fresh reads, parameterized exact actor/hash/scope queries and one commit for all effects/audit. Immutable revocation cannot be undone by rolling touch. Acceptance exercises two independent restricted pools, simultaneous revoke/validation, rollback of audit failures, exact tenant RLS and canonical identity constraints, actual backend termination, recovery, strict TLS/CSRF logout, and rejection of complete fabricated database rows as actor authority. New uncertain-acknowledgement tests inject failure after an actual committed operation; the original real wire-level before/during/after-COMMIT recovery suite remains passing. No server-crash/failover/storage-loss/restore claim is made.

Read-only final PostgreSQL 17.11 checks at verified 127.0.0.1:5432 confirm development history exactly 001_catalog, 002_import_role_privileges, 003_import_role_read_access. IAM/session schema and the new index are absent from development. Neither 004 nor 005 nor proposed 006 was applied there. Database inventory is exactly nukhabapay_dev, postgres, template0, template1; generated project roles and project connections are zero. Existing five restricted roles retain LOGIN with no SUPERUSER/CREATEDB/CREATEROLE/INHERIT/BYPASSRLS or memberships. The existing local loopback database trust configuration is unchanged and remains a development-only limitation.

### Failures and fixes

- Windows blocked local scripts under its default policy. The reviewed commands use RemoteSigned only for their process; no persistent policy was relaxed. The restricted sandbox could not read/unprotect the user-only certificate material; the approved user-context launcher was used without broadening its private ACLs or printing secrets.
- An accidental build invocation in the enclosing directory caused Corepack to attempt a latest-version registry lookup, which was blocked. Correct repository working directory used the existing pinned package manager; no upgrade/download was needed for the workspace addition.
- Initial new CSRF acceptance found 400 instead of 403 for cross-site requests. The implementation now distinguishes malformed Host/header requests (400) from forbidden origin requests (403); the assertion was preserved.
- Initial new PostgreSQL cases passed their logic but the process failed on a late ECONNRESET after cleanup. Per-client broken-connection tracking, safe SQL-error rollback/reuse and network-client discard fixed the lifecycle defect. No global exception suppression or test weakening was introduced.
- Review added persisted idle policy, exact column grants, post-commit authority invalidation, safe dependency inspection and sibling-handle negative invalidation. Added tests verify those controls, including an unissued committed generation being revoked after a changed authority snapshot.
- A subsequent unchanged old IAM test hit its existing 3-second connection timeout. The failure log is retained. The exact suite then passed all 123 tests with unchanged timeouts/assertions, followed by the final new session/portal checks.
- Windows Root installation could not complete through its interactive Security Warning. The owner explicitly chose to leave Windows trust unchanged. No further trust installation was attempted after that decision. Strict per-client certificate pinning verified the actual HTTPS service; browser trust is not claimed.

### Remaining limitations and stopping point

The CLI has no session/provider composition. This is synthetic-only, disposable-only persistence with no real staff data; session rows are not human proof. Restart rejects old cookies rather than reconstructing an actor from database JSON. The registry has a 1,000-issued-entry bound; retention, HA, refresh, durable actor reauthentication and a non-disposable session role/target are unimplemented. Effective session expiry is also bounded by the original at-most-five-minute verified token, even though absolute/idle maxima are eight hours/fifteen minutes. Valid bearer-cookie theft/replay before expiry/revocation is not claimed to be impossible.

Future IAM writers must advance authorization versions atomically on every security change. A change reversed entirely between fresh reads without a version advance is not detectable from snapshots alone. Independent IAM reads/audits are not an atomic privileged-execution guarantee. In-flight requests may have linearized before revocation. Operational MFA/factor/recovery evidence, exact provider issuer/client/human profile, supported OIDC SDK, reviewed transaction cookies/PKCE/state/nonce, real staff bootstrap, migration approval and production ownership/residency remain gated. Auth0 resources described by the owner remain reported context, not verified provider integration.

Pre-increment checkpoint `before-staff-sessions-20261112T113622Z.zip` is preserved: 225 maintained files, SHA-256 d4979cf0608bce8c9d57185bba35f858aff5f5ea2abc0002a7d700a3ae372ac7. Private environment/certificate/key/database/log/dependency/generated files are excluded. Earlier checkpoints, SQL, financial code, API trust/bootstrap and ADRs remain intact. The active PostgreSQL log may append acceptance entries and is never truncated as historical evidence. Git remains unavailable; no remote or system software installation occurred.

This bounded local foundation stops for owner review. No real Auth0, callback registration, privileged execution, real staff onboarding or next increment begins automatically.

## Earlier verification records (preserved)

## Controlled naming standardization ? 12 November 2026

**Verdict: NAMING STANDARDIZATION COMPLETE**, with explicitly retained database/resource identifiers and historical evidence listed in [the naming register](naming-standardization.md) and ADR 0021. This is source/package naming only, not a new brick or operational activation.

**289 project tests passed, zero failed/cancelled/skipped:** application 75; database 15; API/authentication 48; disposable IAM/HTTP/workflow acceptance 123; financial/provider 19; Python 9. The API suite adds one explicit historical-audience rejection test; synthetic assurance negatives also reject historical audiences. Existing assertions are preserved. Application/database/API builds and typechecks, all nine workspace package names and ESM dependency resolution, absence of legacy workspace aliases, the synthetic demonstration and structure checks passed. The demonstration still produces AED 102.00 and AED 2.77 expected contribution, with no execution.

Pinned pnpm 10.34.9 regenerated the lockfile; exact checkpoint comparison proves only three workspace scope keys changed, with every third-party resolution/version/integrity byte unchanged. The successful frozen install downloaded 225 locked packages with install scripts disabled. No package-manager/software upgrade or global setting change occurred.

### Exact commands and evidence

Commands below ran from the existing repository root. The verification runners inject process-only synthetic configuration and redact credentials; PostgreSQL acceptance requires its verified disposable-target setup. Do not run migration scripts against development.

```text
pnpm.cmd install --lockfile-only --offline --ignore-scripts
pnpm.cmd install --frozen-lockfile --ignore-scripts --store-dir ../.pnpm-store --reporter=append-only
pnpm.cmd application:build
pnpm.cmd application:typecheck
pnpm.cmd application:test
pnpm.cmd db:build
pnpm.cmd db:typecheck
node packages/database/node_modules/typescript/bin/tsc -p packages/database/tsconfig.test.json
node --test --test-concurrency=1 packages/database/dist-test/database/test/*.spec.js
pnpm.cmd api:build
pnpm.cmd api:typecheck
pnpm.cmd api:test
pnpm.cmd --filter @nukhbapay/api test:identity:integration
node ../recovery-checkpoints/check-naming-workspace.mjs
pnpm.cmd test
pnpm.cmd demo
python -B -m unittest discover -s apps/ai-service/tests -v
python -B scripts/check_structure.py
node ../recovery-checkpoints/check-naming-security.mjs
```

Runner commands from the enclosing workspace were `node recovery-checkpoints/verify-naming-standardization.mjs` and, after correcting only the new resolution helper, `node recovery-checkpoints/verify-naming-standardization.mjs --remaining-only`. The first eleven commands in the first run passed, including all application/database/API/integration tests. Its additional CommonJS-based resolution helper failed; the corrected ESM helper and all remaining commands passed. Passed project suites were not rerun unnecessarily. The expanded legacy-scope absence check was also rerun successfully after extending it to all eight packages and all three historical scopes.

Evidence (all under `../recovery-checkpoints/`):

- `naming-standardization-verification-20261112T104345744Z` `.before.json`, `.log`, `.results.json` retain the initial helper failure and passing project suites.
- `naming-standardization-verification-20261112T105855803Z` `.before.json`, `.after.json`, `.log`, `.results.json` record the passing remaining checks and unchanged database inventory/history.
- `naming-standardization-security-20261112T110029568Z.json` records independent read-only target, role, cleanup and evidence-preservation checks.
- `naming-standardization-reference-classification.json` classifies all 1,758 original maintained/template spelling references without source excerpts or credential values.
- `naming-standardization-changes.json` and the naming register list every maintained source change/rename; `naming-standardization-verification-summary.json` consolidates commands, counts, limitations and resolved setup/helper failures.

### Failures, fixes and limits

- Invoking Corepack from the enclosing directory attempted an unpinned latest-version lookup and hit the network restriction. Re-running inside the repository used its existing pinned pnpm 10.34.9; no upgrade was performed.
- Frozen offline relinking first rejected a non-interactive dependency-directory purge. After verifying dependency roots stay within this repository and are not linked roots, a process-only CI retry was used. That task-owned relink stalled, consuming over 3,900 CPU seconds; its exact process/arguments were verified before stopping it. Source and backup files were not removed.
- A fresh offline retry reported a missing cached tarball. The authorized frozen-lockfile install then fetched the exact locked packages into the workspace-local store, with scripts disabled. It completed successfully; no assertions, integrity checks or security configuration were relaxed. Slow downloads/OneDrive-hosted dependency I/O and one runner startup timeout were environmental limitations, not passing tests.
- The newly added workspace helper initially tried CommonJS resolution against import-only ESM exports. It now verifies real workspace links/manifests plus actual ESM resolution/import; all canonical packages and absence of historical aliases pass. No application code or existing test assertion changed for this fix.
- The new evidence helper initially treated the active PostgreSQL server log as immutable. The server legitimately appended acceptance errors to it. Its original 1,367,002-byte prefix matches the checkpoint SHA-256; only appended content is permitted. All 220 other prior evidence/archive files remain byte-identical, and all 33 protected migration/SQL/ADR/handover files remain byte-identical. The active log was never truncated or restored.

A final documentation prose edit normalized historical Markdown line endings. The strict byte-level audit rejected that change; the original title and historical suffix were restored exactly from the verified checkpoint, while retaining the current naming report. The final history/source audit passes. No migration, durable audit record or checkpoint was changed.

### Database and security evidence

Real PostgreSQL 17.11 at verified IPv4 loopback port 5432 was used. Destructive tests created owned random disposable databases/roles and cleaned them. Final database inventory is exactly `nukhabapay_dev`, `postgres`, `template0`, `template1`; generated project roles, remaining project connections and idle transactions are absent. Development was inspected read-only with its migrator identity: actual migration history is exactly 001_catalog, 002_import_role_privileges, 003_import_role_read_access; IAM/workflow tables are absent. Neither 004 nor 005 was applied there.

The existing five restricted project roles retain LOGIN with no SUPERUSER, CREATEDB, CREATEROLE, INHERIT, BYPASSRLS or inherited memberships. Real acceptance verifies catalogue runtime/importer denial on IAM, column-limited IAM reads, authorization-audit writer restrictions, hostile default grants, FORCE RLS and tenant isolation; migration 005 backend/reader limits, lifecycle-success forgery denial, atomic evidence, replay/concurrency, acknowledgement-loss reconciliation and cleanup all remain passing. Client application labels changed together with connection-cleanup tests; database schema/role/GUC/target guards and all registered migrations/SQL recipes did not change.

No real Auth0/provider resource, employee data, secret environment file, database name, grant, staff identity or durable staff mutation changed. `GET /health/live` remains the only deployed route. Operational MFA, accepted privileged approvals, APPLY, normal-runtime reserved permissions and live finance remain blocked. Real provider integration, Auth0 activation, production/externally hosted readiness and Docker operation were not performed or claimed; Docker is unavailable locally. Required project tests have no skips.

### Recovery and stopping point

The prior reviewed checkpoint and seven tested-code hashes were verified before editing. New pre-rename recovery: `before-naming-standardization-20261112T094423Z.zip`, 223 maintained files, SHA-256 `1d8022b3daa28fb26499cf7c26f93fe7d62f3094e421c50e0e2fe030e94e13de`. Environment/credential/database/generated files are excluded; the template's original hash is recorded. Git remains unavailable; no remote, history rewrite, system software installation or old checkpoint overwrite occurred.

An authorized owner must update any private local environment key names when adopting canonical project-prefixed inputs; secret values and fixed restricted-role/database identifiers stay unchanged. No Auth0 or PostgreSQL rename is required now. Any future registered trust, database/schema/role, Compose-volume or checkout relocation follows the separately reviewed procedure in the naming register. All management activation decisions remain PENDING. Stop for owner review; no next Brick 3 increment is started.

Final naming audit: 226 maintained/template files, 1,449 explicitly classified retained references, zero unclassified legacy spellings/maintained filenames. A first classifier pass flagged the two fixed migration-CLI schema references; explicitly classifying that existing compatibility contract resolved it without renaming the schema or changing tests. Final source hashes, history suffixes, template-only key-prefix changes and the three-key lockfile delta all verify. Timestamped final reference inventory is preserved alongside the earlier classification evidence.

## Earlier verification records (preserved)

**Latest evidence:** see "Gated staff approval intake" below: 288 passing tests, no failures/skips; actor-bound synthetic intake, atomic evidence, strict receipt classification/recovery and unchanged privileges verified. Registered 004/005 and development history 001–003 remain unchanged. Accepted privileged approvals, operational MFA and APPLY remain BLOCKED; Brick 3 overall is incomplete. Older entries describe historical scope.

## Gated staff approval intake

Verified 12 November 2026 under one bounded internal approval-intake authorization after the 268-test read increment. Reviewed pre-edit checkpoint preserved: `../recovery-checkpoints/before-approval-intake-20261112T074145Z.zip`, 219 maintained files, SHA-256 `f2661996c7fb407883be4251dc3551f4de10281aa8507968238af4b3500c92ef`. Previous archive hash verified; new archive opened and every source entry checked, then rechecked after implementation. Environment/database/key/dependency/generated artifacts excluded. No backup overwritten. No applicable AGENTS.md found; Git unavailable in the current environment. No software/dependency/lockfile installation or remote publication.

Working functionality: `TrustedStaffActorBoundary.intakeStaffApproval` implements strict ATTEMPT and historical RECONCILE commands through a separate default-deny NON_AUTHORIZED_STAFF_APPROVAL_INTAKE port. It reuses opaque current actors, exact issuer/subject-to-canonical-person binding, private signed synthetic provenance, current staff/membership/grants and request/version/digest/policy/scope checks. It rejects supplied actor/tenant/approval/MFA/receipt fields, forged/cloned proofs/actors, self/beneficiary and duplicate-person participation, stale authority/head/expiry and foreign scope. All results retain privilegedApproval=BLOCKED, acceptedApproval=false, not-established and NOT_AUTHORIZED.

No schema change is made or required for this limited profile. The existing provenance-tagged REVIEW stores safely classified SYNTHETIC_TEST_EVENT evidence, not an accepted approval or a distinct new attempt-log event. Review/provenance/audit/receipt/no-delivery outbox commit atomically through the existing SERIALIZABLE store, shared reservations, unique/composite/deferred constraints and FORCE RLS. New purpose-bound replay/reconciliation checks the exact stored REVIEW/provenance/person/request/version/scope/digest/policy/non-approved profile. Ordinary review/submission receipts cannot be relabelled. Historical lookup works after proof/request expiry or supersession with fresh current actor authority and committed read audit; it renews no assurance/approval. Denied/conflicting/uncertain outcomes disclose no receipt or identity fields. Full mapping and limitations are in [ADR 0020](adr/0020-gated-staff-approval-intake.md).

Exact final command: `node ../recovery-checkpoints/verify-approval-intake.mjs`. Redacted artifacts: `../recovery-checkpoints/approval-intake-verification-20261112T080425934Z.{log,results.json,before.json,after.json,security.json}`. All 15 commands exited zero:

| Exact command | Result |
| --- | --- |
| `pnpm.cmd application:build` | Passed |
| `pnpm.cmd application:typecheck` | Passed |
| `pnpm.cmd application:test` | 75 passed, including four new intake contract/eligibility tests |
| `pnpm.cmd db:build` | Passed |
| `pnpm.cmd db:typecheck` | Passed |
| `node packages/database/node_modules/typescript/bin/tsc -p packages/database/tsconfig.test.json` | Passed |
| `node --test --test-concurrency=1 packages/database/dist-test/database/test/*.spec.js` | 15 passed, real PostgreSQL catalogue/migration/IAM regression |
| `pnpm.cmd api:build` | Passed |
| `pnpm.cmd api:typecheck` | Passed |
| `pnpm.cmd api:test` | 47 passed, existing verifier/guards/runtime/browser transport |
| `pnpm.cmd --filter @nukhabapay/api test:identity:integration` | 123 passed, including 16 new real PostgreSQL intake cases |
| `pnpm.cmd test` | 19 financial/provider tests passed |
| `pnpm.cmd demo` | AED 102.00 total / AED 2.77 contribution unchanged |
| `python -B -m unittest discover -s apps/ai-service/tests -v` | 9 passed |
| `python -B scripts/check_structure.py` | Structure, 21 JSON files and selected boundaries passed |

**Final: 288 passed, zero failed/cancelled/skipped.** Previous 268 tests remain passing; twenty tests were added. All implementation/SQL/test changes preceded the final full run; only documentation and read-only evidence checks followed. The independent security artifact records all seven tested code/test/export file hashes. No original assertion was removed/weakened and no test skipped.

Executable evidence:

1. Valid independently eligible synthetic actor/proof records exactly one complete bound evidence tuple; raw assertions are absent, request remains SUBMITTED and target staff remains ACTIVE. Results explicitly report blocked privileged approval.
2. Identical command/key/proof replay returns the same operation without duplicate artifact audit/receipt/outbox; changed request/proof conflicts, and the same proof cannot bind another key.
3. Missing dedicated intake capability, legacy request capability alone, JSON/UUID/cloned actors, JSON/cloned/raw-token proofs, simulation receipts and client MFA/approval/actor/tenant fields deny without persistence.
4. Requester/beneficiary and alternate-identity duplicate person deny; separate eligible canonical people may each record blocked evidence, never accepted quorum.
5. Prior plain review participation cannot be upgraded or duplicated; immutable history and the original uniqueness slot remain intact.
6. Suspended/disabled/stale/revoked/conflicting approver authority denies; current role/time/scope checks reuse existing policy without activating reserved permissions.
7. Wrong policy/digest, superseded head, expired evidence/request and changed requester/target authority reject without new records.
8. Matching tenant intake works only with current membership/tenant grants. Revoked membership and an otherwise eligible same person in another tenant cannot record/read the original evidence.
9. INSERT failure at each of operation/review/provenance/audit/receipt/outbox rolls back all six new rows. Restored privilege permits the original same-key proof retry.
10. Concurrent retries across independently initialized PostgreSQL stores converge on one commit and replay; concurrent alternate identities for the same person produce one participation only.
11. Actual wire loss after artifact COMMIT but before acknowledgement returns UNRESOLVED with no receipt. Fresh current actor reconciliation finds exactly one authoritative complete tuple; foreign person, wrong digest and absent key cannot disclose it.
12. Historical reconciliation of the original version succeeds after proof/request expiry and supersession without accepting/renewing approval.
13. Actual plain-review and actor-owned submission receipts reject synthetic-intake relabelling, even for an otherwise eligible approver.
14. Forged/cloned/retained transaction tickets deny; substituted persistence responses return uncertainty without a success receipt.
15. Actual audit INSERT failure prevents reconciliation disclosure; IAM status-column failure and closed persistence stores fail closed. Existing required proof-issuance/audit failures remain covered by prior acceptance.
16. Real privilege metadata confirms unchanged restricted seven-table profile, no IAM mutation/command rights, all FORCE-RLS markers and zero accepted/operational evidence. Existing catalogue/IAM roles receive no new privileges; no idle transaction remains.

Privilege evidence: the existing generated `nukh_request_<20 hex>` backend is reused in LOCAL_SYNTHETIC_ONLY mode. It has the same SELECT/INSERT on seven artifact tables and the same 27 IAM read columns with exact-tenant policies as ADRs 0016–0018, no contact/effective IAM writes, UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER, schema/role rights or command execution. No new login/grant/role recipe, RLS policy, database function or runtime credential is introduced by intake. Extra independent test stores use the same restricted credentials. Existing IAM reader/audit writer/catalogue runtime/importer and 34-column workflow reader remain unchanged. Temporary fault-test revokes were restored exactly within the disposable target. The authorization audit writer still cannot emit lifecycle-success vocabulary or write workflow artifacts. Credentials/GUCs remain a workload boundary, not human authority.

Final PostgreSQL 17.11 loopback 5432 targets:

- Intake, provenance, durable requests, reads and recovery: `nukhabapay_b3b3_779bfa58fa194000ada177df0074ab9f`.
- Migration 005 privilege/rollback acceptance: `nukhabapay_b3b3_e614197f3035407fb3210a8fcc4841ef`.
- Negative target guard: `nukhabapay_guard_997a1cd65eaa461c808bdbc7f50f399f` (004 only; 005 rejected).
- Existing IAM/runtime/HTTP fixtures: `nukhabapay_b3b2_6e01f15e300c4068b0927229757630f8`, `nukhabapay_b3b3_e7a5c2dc5ddc4735a859eb0d34eaaebc`, `nukhabapay_b3b3_9466046688944330b3a92c7fa984cca0`.
- Existing database tests retain their verified generated disposable db/i/cli/r/iam/fail fixtures.

All generated databases/roles were cleaned. Independent postcheck confirms no generated history/request/receipt/workflow roles, no Naukhbapay connections/idle transactions, and inventory only nukhabapay_dev/postgres/template0/template1. Existing five workload/migrator roles retain LOGIN with NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOINHERIT/NOBYPASSRLS and no memberships. Development read-only history remains exactly 001_catalog/002_import_role_privileges/003_import_role_read_access, with no IAM/workflow tables. **No 004/005 migration, grant or data change was applied to development.** Registered migrations and every existing role recipe match checkpoint hashes.

Resolved preflight issue: TypeScript inferred randomUUID's narrow template-literal type for a fixture's default key parameter, rejecting existing string keys. Explicit `key:string` matches the command contract; runtime UUID validation and compiler strictness are unchanged. Application tests passed 75/75. First focused database run `node ../recovery-checkpoints/verify-approval-intake.mjs --integration-only` passed 123/123 (`approval-intake-verification-20261112T075646476Z`); no new PostgreSQL assertion failed. The final full run passed after all source changes, with no weakened assertion or skipped test.

Changed maintained files (18):

- Created `packages/application/src/identity/staff-approval-intake.ts`.
- Created `packages/application/test/staff-approval-intake.test.ts`.
- Created `apps/api/test/fixtures/approval-intake-acceptance.ts`.
- Created `docs/adr/0020-gated-staff-approval-intake.md`.
- Modified `packages/application/src/identity/trusted-staff-actor.ts`.
- Modified `packages/application/src/index.ts`.
- Modified `packages/database/src/durable-staff-request-store.ts`.
- Modified `apps/api/test/fixtures/approval-provenance-acceptance.ts`.
- Modified `docs/adr/0019-secure-staff-workflow-reads.md`.
- Modified `docs/progress.md`.
- Modified `docs/verification.md`.
- Modified `docs/security/requirements.md`.
- Modified `docs/governance/pending-management-approvals.md`.
- Modified `docs/build-sequence.md`.
- Modified `docs/data-model.md`.
- Modified `docs/project-structure.md`.
- Modified `README.md`.
- Modified `ARCHITECTURE.md`.

Generated builds and external checkpoint/runner/evidence files are separate. Migrations 001–005/pending SQL, role provisioning/grant recipes, deployed HTTP/runtime, identity repository/verifier, lifecycle/permission logic, workflow/receipt readers, catalogue/financial/provider/Python source and lockfile are unchanged. Transaction-replay recovery and actual-failed-target rollback tests remain preserved and passing.

Local completion: the bounded synthetic intake and durable blocked-evidence foundation is complete. Bricks 2B/3A and previous local authentication/persistence/read controls remain verified within their scope. Brick 3 overall/operational activation remain incomplete. This is the existing synthetic review profile, not a distinct attempt-log/accepted-approval schema; prior participation cannot be upgraded, and incompatible repeated attempts deny rather than add trusted approvals. Stored evidence/receipts cannot be rehydrated as privileged actors/MFA. Compromised backend credentials can append false non-authorized artifacts; no stored DTO becomes execution authority. Separate fresh reads do not prove globally linearized real revocation/privileged mutation.

Exact remaining acceptance dependency: the existing token verifier reports not-established assurance, and the isolated provider re-verifies a synthetic bearer sign-in/signs a nonce without demonstrating an independent real human factor, approved provider assurance/recovery/key-custody semantics or named operational approver authority. Reserved approval permissions remain inactive; 005 cannot store accepted approvals or execute staff changes. Genuine acceptance requires those approved trust/ownership prerequisites plus a separately reviewed later schema/privilege matrix for accepted approval/quorum/version/expiry/withdrawal and atomic mutation/audit/receipt/outbox/locking/recovery. Do not alter 004/005 to bypass this gate. No real Auth0/MFA/account, deployed endpoint, reserved-permission activation or financial operation; no operational TLS/SCRAM/failover/restore evidence is claimed.

Next direct independently safe implementation: internal actor/version-bound server-session lifecycle and audited suspension/revocation invalidation persistence for Brick 3C, using local synthetic acceptance and no browser/provider login, real staff, accepted approval or APPLY. Owners must resolve the existing independent MFA/approver trust gate before privileged approval acceptance can be enabled. Stop for review; no next implementation starts automatically.

## Secure internal request and review reads

Verified 12 November 2026 under one bounded functional authorization after migration 005. Reviewed pre-edit checkpoint: `../recovery-checkpoints/before-workflow-reads-20261112T064212Z.zip`, 214 maintained files, SHA-256 `e42f96daa225b02476bb122a82442386df3b8cd56b29ed8051b42f6dd954c263`. Previous checkpoint hash verified before creating it; the new archive was opened and every source entry hash checked. Environment/database/key/dependency/generated files excluded. No previous backup overwritten. No applicable AGENTS.md found; Git unavailable in the current environment. No software/dependency/lockfile installation or remote publication.

Implemented `TrustedStaffActorBoundary.readStaffWorkflow` with DETAIL/STATUS/REVISIONS/REVIEWS contracts, private one-use query tickets, explicit NON_AUTHORIZED_STAFF_WORKFLOW_READ policy, current role/time/scope checks and committed audit. Existing exact verified identity/canonical actor registry is reused. Owned operation/request/tenant anchors separate requester and reviewer visibility; staff.self.read confers no history access. Requesters see own immutable intent/history and redacted review summaries. Reviewers see only observed versions and own summaries; peers/later unobserved intent and unrelated requests deny. This is not a pending-review queue or real-staff administration API.

All output is copied to a validated frozen allowlist: request/version/scope view, stored state/derived expiry status, safe lifecycle intent/roles, immutable request/parent digests and expected target versions, or non-approved review time/version summaries. No issuer/subject/contact, raw payload/key, authority/provenance/authentication evidence, peer identity/operation or token is disclosed. Opaque private one-use cursors bind actor/query/operation/view/kind/version/limit and pin the first visible revision head; maximum 25 rows, 60-second/original-token expiry. Each page reauthorizes, uses one REPEATABLE READ READ ONLY transaction and requires committed audit plus post-lookup/post-audit freshness. Detailed behavior/columns are in [ADR 0019](adr/0019-secure-staff-workflow-reads.md).

Final exact command: `node ../recovery-checkpoints/verify-workflow-reads.mjs`. Redacted evidence stem: `../recovery-checkpoints/workflow-reads-verification-20261112T071144041Z` with log, results.json, before.json, after.json and independent security.json. All 15 commands exited zero:

| Exact command | Result |
| --- | --- |
| `pnpm.cmd application:build` | Passed |
| `pnpm.cmd application:typecheck` | Passed |
| `pnpm.cmd application:test` | 71 passed |
| `pnpm.cmd db:build` | Passed |
| `pnpm.cmd db:typecheck` | Passed |
| `node packages/database/node_modules/typescript/bin/tsc -p packages/database/tsconfig.test.json` | Passed |
| `node --test --test-concurrency=1 packages/database/dist-test/database/test/*.spec.js` | 15 passed, real PostgreSQL regression |
| `pnpm.cmd api:build` | Passed |
| `pnpm.cmd api:typecheck` | Passed |
| `pnpm.cmd api:test` | 47 passed |
| `pnpm.cmd --filter @nukhabapay/api test:identity:integration` | 107 passed, including 16 new workflow read cases |
| `pnpm.cmd test` | 19 financial/provider tests passed |
| `pnpm.cmd demo` | AED 102.00 total / AED 2.77 contribution preserved |
| `python -B -m unittest discover -s apps/ai-service/tests -v` | 9 passed |
| `python -B scripts/check_structure.py` | Passed: structure, 21 JSON files and selected boundaries |

**Final: 268 passed, zero failed/cancelled/skipped.** All 252 previous tests remain passing. Source/SQL/test changes were complete before the final full run; only documentation/read-only evidence followed. The security artifact records hashes of all eight implementation/test/export files. No assertion was removed/weakened or required test skipped.

New real PostgreSQL acceptance:

1. Requester detail/status/revisions/redacted reviews succeed only after a real committed authorization audit; artifact counts remain unchanged.
2. Reviewer visibility is limited to own observed versions/reviews, excluding peers, later unobserved intent and submission-view substitution.
3. Bounded keyset histories use opaque empty-object cursors; clone/replay/cross-actor/changed-kind/request/limit/expired cursor attempts deny, and revision head stays pinned.
4. Empty valid reviews return an audited empty list; absent/foreign/mismatched operation/request/version and malformed/oversized inputs disclose no record/existence result.
5. Missing explicit read policy, staff.self.read inheritance attempts, forged/cloned/foreign actors, structural identity copies and forged/cloned/retained tickets deny before disclosure.
6. Suspended/disabled staff, changed authority versions and revoked grants deny held actors; fresh actors still need current authority.
7. Grant expiry equality and conflicting role sets deny, including after fresh establishment; existing authorization policy is reused.
8. Matching tenant reads work; an otherwise eligible actor in another tenant denies. Inactive/revoked memberships and revoked tenant grants deny without platform inheritance.
9. Expiry status derives at read time; stored request state remains SUBMITTED with no mutation.
10. Actual audit INSERT privilege removal and IAM status-column SELECT removal fail closed; permissions are restored exactly. Audit/IAM exceptions, suspension during lookup and policy withdrawal during committed audit also deny without data.
11. Substituted adapter bindings reject; extra identity/assurance fields cannot escape safe DTO copying.
12. Actual role connections prove exactly 34 SELECT columns, no table-wide SELECT or IAM/provenance/audit/receipt/outbox/command/mutation/DDL rights; unscoped/foreign-scope access and row_security=off cannot bypass FORCE RLS. Existing four catalogue/IAM workloads gain nothing.
13. Initialization needs only its explicit read configuration; removing other DB credential settings does not affect it. Missing/excess columns, write grants, unapproved view/function rights, invalid config and nonexistent database reject with fixed sanitized errors.
14. A temporary restrictive SELECT policy and invoker-only advisory latch pause the reader after its head snapshot while a real independent writer commits the next revision. The result retains the original head/reviews; a new read sees the revision. Subsequent pages exclude later revisions. The temporary function/policy/grant are removed immediately, with original FORCE RLS unchanged.
15. Actual backend termination during a blocked read returns UNAVAILABLE without data; later connections recover, idle transactions remain zero, closed readers deny, and shutdown is idempotent.
16. Concurrent permitted/foreign-context reads retain actor isolation and do not change operation/audit-intent/receipt/outbox or accepted-approval state.

Privilege evidence: new ephemeral `nukh_history_<20 hex>` LOGIN has NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOINHERIT/NOBYPASSRLS, no memberships/ownership, target CONNECT/schema USAGE and only 7 operation + 18 request + 9 review SELECT columns. No new persistent RLS policy/view/function/migration. The owner-operated grant recipe validates actual loopback disposable target/history and restricted role. Startup checks expected roles, RLS, exact columns, no excess relation/function/mutation/CREATE/TEMP/command privileges. Three existing invoker trigger-only PUBLIC functions remain inherited from 001/004; no ordinary trigger/function/DDL route can use them to mutate data, and 005 functions remain inaccessible. The test-only latch is a temporary additional restrictive policy, never an authentication bypass or runtime feature. Stored request payload SELECT is needed for operation extraction; queries select only its operation subfield and DTO validation strips other fields. Credentials/GUCs remain workload scope, not proof of a human.

Final PostgreSQL 17.11 loopback targets:

- New workflow reads plus existing durable/provenance/recovery acceptance: `nukhabapay_b3b3_61a649924f7144b6a5843dc82344d5d0`.
- Existing migration 005 hostile-role/default/rollback acceptance: `nukhabapay_b3b3_1c481e8a06e14ed98eb60353fa70f6bf`.
- Target guard: `nukhabapay_guard_0fc528f36d7b459c93d1f1d7ffddcff0` (004 only; 005 rejected).
- Existing IAM/runtime/HTTP fixtures: `nukhabapay_b3b2_d12bac07d4994b90bbde5660a4c3a09e`, `nukhabapay_b3b3_e6c333fd89e74a609727bbf3819459b3`, `nukhabapay_b3b3_e832eb42ac094c19ad35cef8eed042ba`.
- Existing database tests use their verified db/i/cli/r/iam/fail disposable creation/cleanup routines.

All generated databases were cleaned. New reader/request/receipt/workflow roles and temporary RLS/test objects were removed; all reader pools close before target teardown. Independent final metadata verifies zero generated roles, zero Naukhbapay sessions/idle transactions, and only nukhabapay_dev/postgres/template0/template1 remaining. The five existing workload/migrator roles retain restricted flags and no memberships. Development read-only history is exactly 001_catalog/002_import_role_privileges/003_import_role_read_access, with no IAM/workflow tables. **Neither 004 nor 005 was applied to development.** Original 004/005 and backend grant recipe hashes match the reviewed checkpoint; no existing database grants/settings/data were changed outside disposable tests.

Resolved development/test failures: TypeScript rejected a statically impossible comparison while validating potentially malformed adapter data; explicit runtime string validation preserved the check and strict compiler settings. First focused run passed 104/107 with two failing new fixtures (plus their parent): object-spreading a repository instance lost prototype methods, and a table lock unintentionally blocked the concurrent writer's foreign-key commit. Explicit method delegation and the isolated restrictive reader-only latch corrected the fixtures without weakening expected success/isolation assertions. The second focused run `node ../recovery-checkpoints/verify-workflow-reads.mjs --integration-only` passed 107/107 (`workflow-reads-verification-20261112T070635968Z`); final full run additionally tested unexpected view/function grant rejection. Failed-run artifacts remain preserved; no test was skipped to obtain a pass.

Changed maintained files (19):

- Created `packages/application/src/identity/staff-workflow-read.ts`.
- Created `packages/database/src/staff-workflow-reader.ts`.
- Created `packages/database/roles/grant_staff_workflow_reader.sql`.
- Created `apps/api/test/fixtures/workflow-read-acceptance.ts`.
- Created `docs/adr/0019-secure-staff-workflow-reads.md`.
- Modified `packages/application/src/identity/trusted-staff-actor.ts`.
- Modified `packages/application/src/index.ts`.
- Modified `packages/database/src/index.ts`.
- Modified `apps/api/test/fixtures/durable-request-acceptance.ts`.
- Modified `docs/adr/0018-registered-restricted-staff-workflow-persistence.md`.
- Modified `docs/progress.md`.
- Modified `docs/verification.md`.
- Modified `docs/security/requirements.md`.
- Modified `docs/governance/pending-management-approvals.md`.
- Modified `docs/build-sequence.md`.
- Modified `docs/data-model.md`.
- Modified `docs/project-structure.md`.
- Modified `README.md`.
- Modified `ARCHITECTURE.md`.

Generated builds and external recovery/checkpoint/runner/evidence files are separate. Migrations 001–005/pending SQL, existing IAM/catalogue roles and repositories, token verifier, lifecycle/permission policy, durable writer/receipt reader, deployed HTTP/runtime, financial/provider/Python source and dependency lockfile are unchanged. Recovery COMMIT/rollback fixes and actual-failed-database rollback assertions remain present and passing.

This bounded functional read increment is complete locally. Bricks 2B/3A and prior synthetic authentication/persistence protections remain verified within their scope; Brick 3 overall and operational activation remain incomplete. Participation is not prospective reviewer assignment; cursors are internal process-local handles, and separate read/audit/freshness transactions do not prove globally linearized revocation. Real provider/MFA, independent accepted approvals, trusted approver ownership/recovery and atomic privileged executor/locking/version/cancellation schema remain blocked or management-pending. No real MFA, account, deployed endpoint, reserved permission, staff mutation or financial operation; no operational TLS/SCRAM/failover/backup-restore claim.

Next direct implementation recommendation: gated approval-intake persistence/orchestration, binding exact actor/request/version/policy/current authority and committing its audit/receipt/outbox atomically. Implement durable blocked/rejected handling for synthetic/absent assurance and forgery/staleness/concurrency/failure tests. Actual accepted privileged approvals require demonstrably approved independent strong-authentication provenance and named approver authority; APPLY remains closed until its separate atomic execution gates pass. This is a functional writer path, not another reader/planning-only phase. Stop for owner review before implementation.

## Registered migration 005 restricted workflow foundation

Verified 12 November 2026 under the single bounded migration 005 authorization. Reviewed pre-edit checkpoint preserved: `../recovery-checkpoints/before-migration005-20261112T053905Z.zip`, 209 maintained files, SHA-256 `ca4ecefe615350a66c56c25d66442f442a5492f0dc78d53754d28ff53eddc51c`. Archive hash and every archived source hash were verified again after testing. No previous backup overwritten. No applicable AGENTS.md found; Git remains unavailable in the current environment. No repository restart, dependency/lockfile change, software installation, remote publication or external identity connection.

**Implemented:** actual registered `005_staff_workflow_persistence`, a frozen self-contained SQL snapshot plus null/scope/target hardening; an explicit owner-operated restricted backend grant recipe; migration history boundaries in fixtures; new migration/security acceptance; existing request/review/provenance/recovery tests switched to registered 005 without executing pending rehearsal files. Application/runtime/financial source is unchanged.

Exact object inventory and privilege matrix are in [ADR 0018](adr/0018-registered-restricted-staff-workflow-persistence.md) and the migration source. Eleven tables: iam_workflow_proposals, iam_workflow_audit_intents, iam_workflow_receipts, iam_workflow_outbox, staff_request_operations, staff_access_requests, staff_review_observations, staff_request_audit, staff_request_receipts, staff_request_outbox, staff_synthetic_provenance. All eleven ENABLE/FORCE RLS and scope policies; eleven immutable-record triggers plus staff_review_independence. Two new SECURITY INVOKER functions with pg_catalog search_path: execute_staff_command(jsonb), always-deny; check_synthetic_review(), trigger validation only. PK/unique/composite and deferred foreign keys require exact actor/request/version/scope/digest and complete operation/request-or-review/audit/receipt/outbox, plus provenance for tagged observations. No effective staff mutation or privileged approval objects are created.

SQL NULL gaps are closed for tenant membership versions, revision parent digests, required JSON intent fields and tenant provenance bindings. Role vocabulary is separated by platform/tenant scope. A generated existing-target FK requires canonical staff for non-CREATE requests. The existing CREATE planning contract is preserved: a platform-only STAFF CREATE intent with no roles and zero expected version may name a future UUID, but creates no staff row. Positive acceptance proves this stays a request only.

**Exact final command:** `node ../recovery-checkpoints/verify-migration005.mjs`. Redacted artifacts: `../recovery-checkpoints/migration005-verification-20261112T061650247Z.{log,results.json,before.json,after.json,security.json}`. The runner supplies process-only synthetic connection configuration using unchanged loopback trust, checks actual targets, and redacts URLs/tokens. All 15 commands exited zero:

| Exact command | Result |
| --- | --- |
| `pnpm.cmd application:build` | Passed |
| `pnpm.cmd application:typecheck` | Passed |
| `pnpm.cmd application:test` | 71 passed |
| `pnpm.cmd db:build` | Passed |
| `pnpm.cmd db:typecheck` | Passed |
| `node packages/database/node_modules/typescript/bin/tsc -p packages/database/tsconfig.test.json` | Passed |
| `node --test --test-concurrency=1 packages/database/dist-test/database/test/*.spec.js` | 15 passed, real PostgreSQL catalogue/migration/IAM regression |
| `pnpm.cmd api:build` | Passed |
| `pnpm.cmd api:typecheck` | Passed |
| `pnpm.cmd api:test` | 47 passed, verifier/guards/runtime/browser transport preserved |
| `pnpm.cmd --filter @nukhabapay/api test:identity:integration` | 91 passed, disposable PostgreSQL and synthetic HTTP/crypto acceptance |
| `pnpm.cmd test` | 19 financial/provider tests passed |
| `pnpm.cmd demo` | AED 102.00 customer total / AED 2.77 contribution unchanged |
| `python -B -m unittest discover -s apps/ai-service/tests -v` | 9 passed |
| `python -B scripts/check_structure.py` | Structure, 21 JSON files and selected boundary checks passed |

**Final: 252 passed; zero failed/cancelled/skipped.** Previous 242-test baseline is preserved; ten additional counted cases cover registered migration and direct constraint acceptance. Source/SQL/test changes were finished before the final full run. Only documentation and read-only evidence checks followed. Migration SHA-256: `41910d1aa060a1971c8e33e123b0e350d884ffede490cb71b52dc00838779390`; grant recipe: `a1e225182a4ff34eaa0fa018d3495cb6b02ca276aca3fcf39ed67b9d141d84bb`.

Acceptance evidence:

1. Actual CLI up 4 -> up 5 -> repeat leaves exactly one 005 history entry; old table/column/function ACLs and forced-RLS flags compare equal. Historical IAM fixtures remain explicitly pinned to up 4 --timestamp; new workflow fixtures explicitly require history 005. No assertion or security test was removed/weakened.
2. Injected division-by-zero after the full 005 DDL rolls back all eleven tables, two functions, default ACL changes and 005 history on that actual disposable database. Hostile global/schema defaults for PUBLIC and all four workloads do not leak tables/functions; future-object probes also deny. An additional unreviewed default grantee independently rejects table/function defaults and rolls back unchanged.
3. Real catalogue runtime/importer, IAM reader and authorization audit-writer connections cannot SELECT any new table or execute either function. Existing audit writer rejects STAFF_CREATED, STAFF_ACTIVATED, STAFF_ROLE_GRANTED, PRIVILEGED_APPROVAL_ACCEPTED and synthetic-review events with 23514; its existing AUTHORIZATION_DECISION append still works. It cannot insert lifecycle request audits.
4. New generated backend has only six canonical SELECT/INSERT table grants, optional seventh synthetic provenance grant and 27 reviewed IAM column reads. No history mutation/TRUNCATE, contacts, catalogue, IAM writes, schema CREATE, database CREATE/TEMP, memberships, SET ROLE or staff command execution. Wrong mode, canonical IAM role substitution and INHERIT role flags deny grant bootstrap without partial grants. row_security=off cannot bypass FORCE RLS; unscoped/foreign scope queries and inserts deny.
5. Existing executable request/revision/review/provenance tests prove immutable history, canonical-person uniqueness, no self/beneficiary/alternate-identity approvals, stale authority and cross-tenant denial, changed-payload conflict, concurrent independent-connection retries and complete atomic evidence. Direct malformed-row tests reject null membership/parent versions, missing payload scope/roles, wrong-scope roles, nonexistent non-CREATE targets, invalid expiry, null/foreign provenance tenant and executable assurance/approval markers.
6. Existing staged-write/audit/receipt/outbox/provenance failure injections roll back all records; retry can safely record once. Actual wire loss before COMMIT, around acknowledgement and after confirmed commit reconciles authoritative receipts without duplicate audit/outbox or foreign-actor disclosure. Failed connections/transactions/locks are cleaned up. Receipts and provenance remain non-authorizing.
7. Automatic down refuses to delete immutable history and leaves objects/history unchanged. A separately generated unapproved disposable name rejects 005 before schema/default changes; development is never used for this negative migration test.

Final PostgreSQL 17.11 targets on loopback 5432:

- Migration 005 hostile-default/failure/ACL suite: `nukhabapay_b3b3_875dd70fa6d04adfb7c413f471ff2344`.
- Registered workflow/request/provenance/recovery suite: `nukhabapay_b3b3_05e9ce3b3b6041309114397418b5236b`.
- Negative target-guard suite: `nukhabapay_guard_67a85de3387a41d598a9dc1683f1b044` (004 only; 005 rejected).
- Existing internal/runtime/HTTP fixtures: `nukhabapay_b3b2_3f1506b3fb8046abb1e6b85fd869e509`, `nukhabapay_b3b3_4dbcdc1785e340938a9de0c5eb724caf`, `nukhabapay_b3b3_7e5212242c47439eb4fa2f6ab9f601c5` (004 boundaries preserved).
- Database catalogue/migration regressions use their unchanged generated db/i/cli/r/iam/fail disposable fixtures; the failure fixture loads only its rollback-probe migration.

The IAM/workflow targets were dropped after fixture target/ownership/zero-session checks; generated request/receipt/workflow roles and IAM policies were explicitly removed. Existing catalogue/migration fixtures retain their verified creation/cleanup protocol. Final independent read-only metadata probe confirms zero generated roles, zero Naukhbapay connections/idle transactions and only nukhabapay_dev/postgres/template0/template1 remaining. All five existing workload/migrator roles remain LOGIN, NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOINHERIT/NOBYPASSRLS with no role memberships. Development read-only history is exactly 001_catalog/002_import_role_privileges/003_import_role_read_access; no IAM/workflow tables are present. **Neither 004 nor 005 was applied to development.** No development data/grants/settings were changed.

Resolved implementation/test issues: initial injected-migration fixture included package.json, which CLI discovery treated as a migration; removing that non-migration file let the intended division-by-zero execute. The initial old-column ACL comparison accidentally included newly generated indexes; restricting column comparison to actual tables preserves full old table/column checks. Strict TypeScript rejected index-signature dot access in the new malformed-row fixture; explicit row fields fixed it without changing compiler settings. CREATE compatibility was corrected during review before completion. Initial metadata helper path matching/console encoding issues were corrected using exact archive entries and ASCII-safe expressions; they did not alter application assertions or database state. Final fresh full run passed after all SQL/test changes. Earlier focused/full logs remain preserved separately; no failed assertion was skipped to obtain a pass.

Changed maintained files (24):

- Created `packages/database/migrations/005_staff_workflow_persistence.ts`.
- Created `packages/database/roles/grant_staff_workflow_backend.sql`.
- Created `apps/api/test/fixtures/workflow-migration.ts`.
- Created `apps/api/test/migration005.integration.ts`.
- Created `docs/adr/0018-registered-restricted-staff-workflow-persistence.md`.
- Modified `apps/api/package.json`.
- Modified `apps/api/test/fixtures/disposable-iam-database.ts`.
- Modified `apps/api/test/staff-persistence.integration.ts`.
- Modified `apps/api/test/fixtures/durable-request-acceptance.ts`.
- Modified `apps/api/test/fixtures/approval-provenance-acceptance.ts`.
- Modified `packages/database/test/identity-integration.spec.ts`.
- Modified `packages/database/migrations/README.md`.
- Modified `docs/adr/0013-staff-persistence-security-gates.md`.
- Modified `docs/adr/0016-durable-synthetic-access-requests.md`.
- Modified `docs/adr/0017-synthetic-assurance-and-approval-provenance.md`.
- Modified `docs/progress.md`.
- Modified `docs/verification.md`.
- Modified `docs/security/requirements.md`.
- Modified `docs/governance/pending-management-approvals.md`.
- Modified `docs/build-sequence.md`.
- Modified `docs/data-model.md`.
- Modified `docs/project-structure.md`.
- Modified `README.md`.
- Modified `ARCHITECTURE.md`.

Generated build outputs and external checkpoint/runner/log/metadata artifacts are separate. Original migrations 001–004, all pending rehearsal SQL, IAM/catalogue provisioning source, opaque actor/lifecycle/verifier/store/receipt-reader implementation, deployed API source, financial/provider/Python source and lockfile retain their checkpoint hashes. Catalogue replay COMMIT/rollback cleanup and the actual-failed-target rollback regression remain present and passed.

Completion: this bounded local migration 005 persistence foundation is complete. Bricks 2B/3A and existing local authentication behavior remain verified within their prior scope. Brick 3 overall and operational activation are **not complete**. Accepted privileged approvals/APPLY/effective staff changes remain BLOCKED; synthetic proof is not operational MFA. A stolen trusted backend credential can append false non-authorized artifacts within selectable scope; neither credentials/GUCs nor persisted rows may become human/privileged authority. Real provider/factor/recovery/ownership, independent approval semantics, privileged atomic mutation/locking/version/cancellation schema, non-disposable migration and backup/restore gates remain PENDING/BLOCKED. No real Auth0/MFA, production DB authentication/TLS, server-crash/failover/media-loss or backup-restore drill was performed; existing local trust was unchanged.

Next proposed bounded functional increment: internal actor-scoped request detail/status and review-history reads with explicit artifact-read authorization, fresh identity/authority/scope, minimal results and committed audit, tested on disposable PostgreSQL. No receipt-preparation planning cycle, deployed endpoint, permission activation, privileged approval or APPLY. Stop for owner review before further work.

## Day 4 actor-bound synthetic assurance and approval provenance

Verified 12 November 2026 under the bounded Day 4 authorization. Source checkpoint preserved: `../recovery-checkpoints/before-day4-assurance-20261112T045308Z.zip`, 203 maintained files, SHA-256 `bbe96a81b1a1bb9744fa37a84934cc674b3c0a8afb7d91a0d582d46b932d07ab`. Prior archive hash and new archive entries verified; reviewed source allowlist excludes environment, key, database, dependency and generated artifacts. No previous backup overwritten. No applicable AGENTS.md found. No dependency/lockfile/software installation or remote publication.

Implemented an explicit isolated synthetic assurance contract, fixed local-key jose verifier and opaque server-issued challenges/provenance. Exact identity/person, request/version/digest, tenant, policy and authority bind the proof; current actor and request are rechecked, with committed required audit. Challenge/event/proof replay cannot create another accepted record. All evidence remains synthetic=true, operationalAssurance=not-established, acceptedApproval=false, NOT_AUTHORIZED. Existing staff token assurance and reserved permission catalogues are unchanged. No accepted privileged approval is produced.

The additive `pending-migrations/synthetic-approval-provenance.sql` is installed only on a verified generated disposable target in a migrator transaction. It is not automatically discovered, does not modify original migrations/ADR 0016 schema source, and inserts no migration-history row. Its immutable FORCE-RLS table stores validated metadata/digests, not raw signed assertions. Composite identity/review/request/authority bindings, unique challenge/event IDs and a deferred operation-to-proof pointer ensure provenance, review, audit, receipt and no-delivery outbox commit atomically. Optional store mode is explicitly LOCAL_SYNTHETIC_ONLY and defaults off. Existing plain non-authorized observations remain non-approvals.

Nine new disposable integration cases, including cryptographic negative subcases, passed:

1. Real ephemeral RS256 test signatures produce immutable exact-actor/request provenance; durable rows retain non-operational labels, and ordinary approval inspection remains denied.
2. Wrong issuer/audience/subject/profile/type/key/signature, HS256 confusion, JSON MFA flags, extra signed mfa/amr/acr claims, missing required claims, wrong challenge/binding and invalid times reject. Production mode/private-key configuration rejects. Staff access tokens cannot substitute for synthetic assertions.
3. Self/beneficiary/alternate requester identity, wrong actor, copied challenge, forged/cloned proof, absent verifier and wrong test sign-in reject.
4. Stale actor, target authority, superseded request, expired proof and cross-tenant participation cannot record reviews. Matching tenant context can record a non-approved observation.
5. Challenge/event replay, changed proof key, canonical duplicate person through another external identity and concurrent duplicate persistence cannot duplicate evidence. A second in-memory registry can verify a deliberately reissued signed event, but PostgreSQL's durable event uniqueness rejects its persistence atomically.
6. Missing provenance INSERT or audit INSERT rolls back the entire observation/evidence tuple; original same-key retry works after privilege restoration.
7. Actual wire loss after the artifact COMMIT but before acknowledgement returns UNRESOLVED; authoritative own-operation lookup finds the committed tuple. Removing provenance from the replayed command conflicts rather than silently downgrading it.
8. Provenance is tenant-filtered/immutable/non-approved, inaccessible to canonical IAM/catalogue roles and yesterday's request backend. Staff mutation/contact reads/command execution remain denied.
9. Unavailable assurance verifier or required audit persistence cannot mint provenance.

Exact full runner: `node ../recovery-checkpoints/verify-day4-assurance.mjs`. Redacted log/status/before/after metadata stem: `../recovery-checkpoints/day4-assurance-verification-20261112T052105511Z`. All 15 commands exited zero:

| Exact command | Final outcome |
| --- | --- |
| `pnpm.cmd application:build` | Passed |
| `pnpm.cmd application:typecheck` | Passed |
| `pnpm.cmd application:test` | 71 passed |
| `pnpm.cmd db:build` | Passed |
| `pnpm.cmd db:typecheck` | Passed |
| `node packages/database/node_modules/typescript/bin/tsc -p packages/database/tsconfig.test.json` | Passed |
| `node --test --test-concurrency=1 packages/database/dist-test/database/test/*.spec.js` | 15 passed, real PostgreSQL catalogue/migration/IAM acceptance |
| `pnpm.cmd api:build` | Passed |
| `pnpm.cmd api:typecheck` | Passed |
| `pnpm.cmd api:test` | 47 passed, previous token/guard/runtime/browser behavior preserved |
| `pnpm.cmd --filter @nukhabapay/api test:identity:integration` | 81 passed, previous 72 plus nine new provenance/assurance cases |
| `pnpm.cmd test` | 19 financial/provider tests passed |
| `pnpm.cmd demo` | Synthetic AED 102.00 total / AED 2.77 contribution unchanged |
| `python -B -m unittest discover -s apps/ai-service/tests -v` | 9 passed |
| `python -B scripts/check_structure.py` | Structure, 21 JSON files and selected import/public-field checks passed |

**Final full run: 242 passed, zero failed/cancelled/skipped.** Final compiled acceptance includes target-authority invalidation, cross-registry durable event replay and provider/audit failures. No source/DDL changes after final verification. Earlier focused run `node ../recovery-checkpoints/verify-day4-assurance.mjs --integration-only` passed 81/81 (`day4-assurance-verification-20261112T051802864Z`). No runtime assertion failed, no assertion weakened and no required test skipped. Cryptographic successes used actual jose verification, not a permissive mock.

Startup blocker/recovery: the first database runner stopped before metadata/tests with ECONNREFUSED 127.0.0.1:5432. Existing binaries/data directory/PG_VERSION=17, localhost listener and port 5432 were inspected. Starting the existing cluster required explicit tool permission because `C:\Users\Admin\PostgreSQL\pgsql\data` is outside the writable workspace. Approved action: `pg_ctl.exe -D C:\Users\Admin\PostgreSQL\pgsql\data -l <workspace recovery-checkpoints log> -w start`. The server completed ordinary crash recovery from its previous shutdown and reported ready; pg_isready and read-only target/history checks confirmed connectivity. No initdb/reset/recreation, authentication setting, account or service installation. Redacted startup log is `../recovery-checkpoints/day4-postgres-start-20261112.log`. Restricted pg_ctl/process status could not initially observe the externally started process; TCP readiness and actual SQL metadata were used, not that status message, to verify the server.

Final provenance target: `nukhabapay_b3b3_736d760e10e548839a975f16b2e839c0`. Other final IAM/runtime/HTTP targets: `nukhabapay_b3b2_a972226b7e074b3aadf619005bba586d`, `nukhabapay_b3b3_95a995829f4946dc96be891499d840d2`, `nukhabapay_b3b3_3ec60c6c70274c08bf29f071545578b6`. Database suite uses its existing verified disposable targets. Before/after metadata is identical: PostgreSQL 17.11, loopback 5432, development migrations 001_catalog/002_import_role_privileges/003_import_role_read_access; inventory only nukhabapay_dev, postgres, template0, template1. Generated roles/policies/sessions are removed by fixture teardown. Migration 004 and all new DDL remain unapplied to development. Ordinary operations use restricted roles; migrator/admin credentials are confined to verified disposable setup/lifecycle/acceptance. No raw tokens, full connection URLs or secrets recorded.

Privilege evidence: a separate generated NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOINHERIT/NOBYPASSRLS request backend has SELECT/INSERT on seven non-authorized artifact tables, the same minimum IAM column reads and SELECT-only exact-tenant policies as ADR 0016. It cannot update/delete/truncate history, read contacts, write staff/grants, manage schema/roles or execute staff commands. Existing IAM reader/audit writer/catalogue runtime/importer and the original request backend have no provenance-table rights. Original IAM policies and all registered migration/role-provisioning source remain unchanged. The added nullable operation pointer and composite constraints only bind tagged synthetic records; they do not turn plain reviews into accepted approvals. The generated role/policies/grants are explicitly removed and pool sessions checked zero before database drop.

Changed maintained files (15):

- Created `packages/application/src/identity/synthetic-assurance.ts`.
- Created `apps/api/src/modules/identity/synthetic-assurance-verifier.ts`.
- Created `packages/database/pending-migrations/synthetic-approval-provenance.sql`.
- Created `apps/api/test/fixtures/synthetic-assurance-provider.ts`.
- Created `apps/api/test/fixtures/approval-provenance-acceptance.ts`.
- Created `docs/adr/0017-synthetic-assurance-and-approval-provenance.md`.
- Modified `packages/application/src/identity/trusted-staff-actor.ts`, `packages/application/src/index.ts`, `packages/database/src/durable-staff-request-store.ts`, `apps/api/test/fixtures/durable-request-acceptance.ts`.
- Modified `docs/progress.md`, `docs/verification.md`, `docs/security/requirements.md`, `docs/governance/pending-management-approvals.md`, `docs/build-sequence.md`.

Generated outputs and external checkpoint/runner/startup logs are separate. Source hashes preserve original verified identity/lifecycle/permission logic, migrations, ADR 0016 DDL, IAM/catalogue role setup, receipt reader, HTTP/runtime registration, financial/provider source and lockfile.

Precisely BLOCKED: independently authenticated privileged approval acceptance and operational MFA. The test provider re-verifies a synthetic bearer sign-in and signs a nonce, but does not demonstrate a real independent factor, human/device ceremony, Auth0 assurance semantics, approved recovery policy/key custody/ownership or production trust. Current staff identity assurance remains not-established; approval permissions remain reserved and no privileged executor exists. Immutable local metadata is a server attestation of synthetic verification, not a rehydratable actor or independently verifiable operational MFA archive. Real Auth0/staff, accepted quorum, APPROVED/APPLIED state, effective staff/grant changes, financial execution, deployed endpoints and development migration are prohibited. All management/operational gates stay PENDING/BLOCKED; Brick 3 overall is incomplete. Stop for review.

## Durable synthetic staff access requests and independent review

11 November 2026. Reviewed pre-edit checkpoint: `../recovery-checkpoints/before-durable-requests-20261111T134825Z.zip`, 198 maintained files, SHA-256 `07949203f3e3efce9898c9e94558d2142c48acc0253fc4348cff185bd810eccd`. Prior archive hash verified/preserved; new archive entries verified on readback. Maintained-source allowlist excludes environment, database, key, dependency and generated artifacts. No applicable AGENTS.md was found. No software installation, dependency/lockfile change or remote publication.

Implemented actual SUBMIT/REVIEW/LOOKUP application operations and a restricted PostgreSQL store for non-authorized artifacts. Requests contain immutable identity/target/scope, roles, expected authority versions/digests, policy, parent CAS, creation and expiry. Reviews bind canonical verified people and exact request/version/digest, remain not-established/accepted_approval=false/NOT_AUTHORIZED. Requests always remain SUBMITTED. No effective staff/grant operation is executed.

Schema is additive `packages/database/pending-migrations/staff-access-request-records.sql`, installed by a target-verified migrator transaction only on the disposable test database. It is outside registered migration discovery, inserts no migration-history row, and is not full privileged migration 005. Six logged tables use enabled/FORCE RLS, append-only triggers, fixed state/event/approval markers, composite operation/actor/request/scope binding, parent/digest constraints and deferred completion edges requiring request or review plus audit, receipt and outbox at commit. One checked-out SERIALIZABLE transaction performs all artifact writes. Pre-BEGIN session reservations ensure waiters see committed heads; every attempted reservation is tracked and unlocked or its connection discarded. Fresh actor/policy callbacks and a separate bounded read-only pool compare current actor/requester/target snapshots before commit. This does not claim globally linearized privileged authorization.

Eleven new real PostgreSQL cases passed:

1. Immutable request metadata, identical replay, changed-payload conflict and no staff mutation.
2. Stored role intent without granting it; unknown/conflicting/wrong-scope roles rejected.
3. Concurrent identical submissions record once; competing revisions produce one new immutable head and one conflict; superseded review rejects.
4. Independent canonical-person observations persist; alternate identities cannot count twice; same-key replay and a second independent observer work without approval acceptance.
5. Requester/beneficiary review, forged actor/ticket, absent explicit capability and foreign-scope attempts deny.
6. Tenant request/review succeeds only in active matching tenant scope; platform role does not substitute. Raw restricted login with another tenant scope cannot read the request.
7. Stale held actor, target/requester authority change and request expiry deny observations.
8. INSERT failures at audit, receipt and outbox roll back all staged request records; review audit failure also rolls back the observation and uniqueness slot; same-key retry works after restoration.
9. Final policy revocation and a target version change during final validation roll back staged data and evidence.
10. Actual TCP loss after PostgreSQL artifact COMMIT but before client acknowledgement returns UNRESOLVED with no success digest. Fresh actor-scoped LOOKUP finds the committed receipt; concurrent same-key retries replay without duplicate history. Another person cannot look it up.
11. Dedicated backend cannot mutate staff or history, read contact data, create schema objects or invoke staff execution. Existing IAM/catalogue workloads gain no rights; stored requests never become approved/applied and observations never become accepted approvals.

Exact final command: `node ../recovery-checkpoints/verify-durable-requests.mjs`. All 15 commands exited zero. Redacted log/status/before/after metadata stem: `../recovery-checkpoints/durable-requests-verification-20261111T141806615Z`.

| Exact command | Final result |
| --- | --- |
| `pnpm.cmd application:build` | Passed |
| `pnpm.cmd application:typecheck` | Passed |
| `pnpm.cmd application:test` | 71 passed |
| `pnpm.cmd db:build` | Passed |
| `pnpm.cmd db:typecheck` | Passed |
| `node packages/database/node_modules/typescript/bin/tsc -p packages/database/tsconfig.test.json` | Passed |
| `node --test --test-concurrency=1 packages/database/dist-test/database/test/*.spec.js` | 15 passed, real PostgreSQL catalogue/migration/IAM acceptance |
| `pnpm.cmd api:build` | Passed |
| `pnpm.cmd api:typecheck` | Passed |
| `pnpm.cmd api:test` | 47 passed |
| `pnpm.cmd --filter @nukhabapay/api test:identity:integration` | 72 passed, 61 preserved plus eleven new durable-workflow cases |
| `pnpm.cmd test` | 19 financial/provider tests passed |
| `pnpm.cmd demo` | Synthetic AED 102.00 total / AED 2.77 contribution unchanged |
| `python -B -m unittest discover -s apps/ai-service/tests -v` | 9 passed |
| `python -B scripts/check_structure.py` | Structure/21 JSON files/selected import/public-field checks passed |

**Final full run: 233 passed; zero failed/cancelled/skipped.** Final compiled store includes session reservation and fresh-snapshot checks. Final DDL composite bindings were updated at 14:20:34 UTC, before API unit tests started at 14:20:45 UTC and before integration began; the final disposable schema therefore includes them. No source/DDL changes after the final integration run. Prior tests/assertions remain intact.

Final workflow target: `nukhabapay_b3b3_d666d912d9064c46a58bfbbcfd10046c`. Other final IAM/runtime/HTTP targets: `nukhabapay_b3b2_579c9086a4eb4c43a85b6d1fd63dee91`, `nukhabapay_b3b3_df386554a1124145993da1f0ecc02de6`, `nukhabapay_b3b3_7675ed0496ce4ca5a84b2c6c9a8e6664`. Database suite uses its existing verified disposable targets. Target-owned sessions, new roles and per-role policies were cleaned before drop. Before/after metadata is identical: PostgreSQL 17.11 on loopback, development history 001_catalog/002_import_role_privileges/003_import_role_read_access; inventory only nukhabapay_dev, postgres, template0 and template1. Neither migration 004 nor any request schema was applied to development. No credentials, tokens or full connection URLs recorded.

Privilege evidence:

- Generated `nukh_request_<20 hex>` is NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOINHERIT/NOBYPASSRLS, no memberships; explicit disposable CONNECT/schema USAGE only.
- SELECT/INSERT only on staff_request_operations, staff_access_requests, staff_review_observations, staff_request_audit, staff_request_receipts and staff_request_outbox. No UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER or DDL/command authority.
- IAM column SELECT only: staff_users(id,status,authz_version); staff_identities(staff_id,issuer,subject,status); staff_memberships(id,staff_id,tenant_id,status,version); platform_role_grants(id,staff_id,role_code,scope,granted_at,expires_at,revoked_at); tenant_role_grants(id,membership_id,tenant_id,role_code,scope,granted_at,expires_at,revoked_at). No contacts/display/evidence or security-audit access. Grant IDs are read by the new purpose-specific backend for the unchanged lifecycle model; existing IAM reader rights are not expanded.
- Existing IAM tenant policies name the IAM reader, so the fixture adds SELECT-only policies for the new role with the same exact transaction-local tenant filter; removes them before dropping that role. Original policies and enabled/FORCE RLS remain unchanged. No PUBLIC or existing-role expansion.
- Actual restricted-login SQL attempts to update staff/history, delete/truncate evidence, read contacts, create schema objects and invoke execute_staff_command return 42501. Canonical IAM reader/audit writer/catalogue runtime/importer have no rights on the new six tables. Startup checks reject excess reads/writes/schema/command rights.

Failure history is preserved rather than relabeled as passing:

- Focused run `durable-requests-verification-20261111T135928243Z`: fixture expected initial authority version 1, but migration 004 initializes version 0. Real stale-version checks correctly denied submissions. Corrected fixture and new schema constraints to the established zero-based version semantics; no stale check bypass.
- Focused run `...20261111T140201522Z`: tenant case denied because existing IAM RLS policies intentionally excluded the new role. Added only that role's equivalent tenant-filtered SELECT policies on disposable IAM tables; did not weaken existing policies.
- Focused run `...20261111T140407062Z`: role conflict was mislabeled as storage CONFLICT. Restricted storage conflicts to idempotency/version reasons; role policy conflicts remain DENIED. Negative assertions retained.
- Full run `...20261111T140725791Z`: application/database suites passed, but Windows EBUSY temporarily prevented loading an unchanged Nest dependency, producing four API file failures. The same dependency then read successfully; no file replacement, dependency change, settings change or test skip.
- Full run `...20261111T141253710Z`: all but lost-ack case passed. The proxy cut the first COMMIT, now belonging to the read-only freshness check; the store correctly denied/rolled back before artifact commit. Extended the fault fixture with an optional COMMIT ordinal (default behavior unchanged) and selected the second COMMIT. Final full run verifies actual committed artifacts, unresolved acknowledgement and authoritative reconciliation.

Changed maintained files (15):

- Created `packages/application/src/identity/durable-staff-request.ts`.
- Created `packages/database/src/durable-staff-request-store.ts`.
- Created `packages/database/pending-migrations/staff-access-request-records.sql`.
- Created `apps/api/test/fixtures/durable-request-acceptance.ts`.
- Created `docs/adr/0016-durable-synthetic-access-requests.md`.
- Modified `packages/application/src/identity/trusted-staff-actor.ts`, `packages/application/src/index.ts`, `packages/database/src/index.ts`.
- Modified `apps/api/test/fixtures/trusted-actor-acceptance.ts` (new acceptance invocation) and `apps/api/test/fixtures/commit-loss-proxy.ts` (optional fault ordinal; old defaults/assertions preserved).
- Modified `docs/progress.md`, `docs/verification.md`, `docs/security/requirements.md`, `docs/governance/pending-management-approvals.md`, `docs/build-sequence.md`.

Generated output and external checkpoint/runner artifacts are separate. Original registered migrations, prior pending-005 rehearsal, role provisioning, catalogue recovery, receipt-reader implementation, permission/assurance catalogue, token verifier, HTTP runtime/routes and financial/provider source remain unchanged.

Locally working: policy-valid synthetic request submission, role-intent storage without grants, immutable CAS revisions, independent non-approved review recording, idempotent replay and authoritative own-operation receipt lookup/recovery. Prohibited/unimplemented: effective staff create/activate/suspend/revoke/reactivate/disable/recover, effective membership/grant writes, accepted approvals/quorum, APPROVED/APPLIED transitions, MFA acceptance, delivery, reserved permissions, external identity/real staff, deployed endpoints, development migrations or financial execution. SQL credentials/GUCs do not prove a human; admitted provenance depends on the trusted opaque-ticket adapter. Stored evidence is not a cryptographic privileged approval proof and is never rehydrated as authority. Final fresh reads do not eliminate the last precommit revocation race; this non-authorized recording path does not claim atomic privileged authorization. All operational/management gates remain BLOCKED/PENDING. Brick 3 overall is incomplete. Stop for owner review.

## Restricted PostgreSQL synthetic receipt reader

11 November 2026. Reviewed source checkpoint `../recovery-checkpoints/before-receipt-reader-20261111T132232Z.zip`, 195 maintained files, SHA-256 `8798f8ed92c0dbec710f9cb8a9d27cb52464cf2bf7d0df274fecb211b600f15a`. Prior archive hash preserved/verified; new entries verified on readback. Reused reviewed source allowlist excluding environment, database, key, dependency and generated artifacts. No applicable AGENTS.md found. No Git/software installation or remote publication.

Implemented a separately instantiated local/disposable PostgreSQL receipt reader and one-use in-flight application query capabilities. The actor boundary alone issues them after fresh identity/authority and explicit receipt-policy checks; forged handles/JSON, missing operation IDs, replayed/cloned queries and mismatched operation/key/digest/scope cannot return a receipt. Fresh actor/policy checks and committed audit remain required before application disclosure. ADR 0015 describes exact privileges and limitations. Reader is not registered in deployed runtime.

Privilege evidence on the generated receipt login:

| Object | Explicit grants / actual acceptance |
| --- | --- |
| Disposable database/schema | CONNECT / USAGE; CREATE and TEMP denied; no ownership or role membership |
| iam_workflow_proposals | SELECT(operation_id,actor_staff_id,scope_key,idempotency_key,command_digest,provenance,record_kind,execution) |
| iam_workflow_receipts | SELECT(operation_id,actor_staff_id,scope_key,command_digest,outcome,execution) |
| All other application tables | No reads, including staff, contacts, identities, memberships, grants, security audit, audit intents and outbox |
| Mutation/DDL/commands | No INSERT/UPDATE/DELETE/TRUNCATE or schema CREATE; execute_staff_command denied with 42501 |

Acceptance asserts exactly fourteen column grants and exercises denied SQL using the actual reader login. Factory verifies login target/role flags/membership, no excess DML/schema/database/function/column privileges, enabled/FORCE RLS and required projection privileges. Missing SELECT(outcome), extra UPDATE(outcome), invalid configuration and missing database all reject startup with sanitized errors. Canonical catalogue/importer/IAM roles retain no workflow projection access. No migration or role-provisioning source changed. Ephemeral reader grants are explicitly revoked and login removed after zero-session pool closure.

Nine new disposable cases cover: privilege denial; forged actor/query capabilities and disabled explicit policy; exact operation/person/tenant/key/digest/missing records; concurrent permitted and foreign-context reads on the bounded pool without writes; stale authority; one-use capability clone/replay rejection; idle pool failure/recovery and closed-reader denial; missing/excess/unavailable startup dependencies; actual backend termination during a query blocked on a controlled receipt-table lock, yielding UNRESOLVED then healthy recovery. The lock and backend termination are limited to the already verified generated fixture database and generated reader role. All earlier recovery, actor/provenance, audit, HTTP and token tests remain unchanged.

Final command: `node ../recovery-checkpoints/verify-receipt-reader.mjs`. Redacted log/results/before/after metadata stem: `../recovery-checkpoints/receipt-reader-verification-20261111T133551963Z`. All 15 commands exited zero:

| Exact command | Final outcome |
| --- | --- |
| `pnpm.cmd application:build` | Passed |
| `pnpm.cmd application:typecheck` | Passed |
| `pnpm.cmd application:test` | 71 passed |
| `pnpm.cmd db:build` | Passed |
| `pnpm.cmd db:typecheck` | Passed |
| `node packages/database/node_modules/typescript/bin/tsc -p packages/database/tsconfig.test.json` | Passed |
| `node --test --test-concurrency=1 packages/database/dist-test/database/test/*.spec.js` | 15 passed, real PostgreSQL catalogue/migration/IAM acceptance |
| `pnpm.cmd api:build` | Passed |
| `pnpm.cmd api:typecheck` | Passed |
| `pnpm.cmd api:test` | 47 passed |
| `pnpm.cmd --filter @nukhabapay/api test:identity:integration` | 61 passed, 52 preserved plus nine new reader cases |
| `pnpm.cmd test` | 19 financial/provider tests passed |
| `pnpm.cmd demo` | Synthetic AED 102.00 total / AED 2.77 contribution unchanged |
| `python -B -m unittest discover -s apps/ai-service/tests -v` | 9 passed |
| `python -B scripts/check_structure.py` | Structure/21 JSON files/selected import/public-field checks passed |

**Final full-run total: 222 passed, zero failed/cancelled/skipped.** Final compiled tests include the mixed-context concurrency assertions and controlled-lock snapshot refresh/termination assertions. No source changes followed the final run; no assertion weakened or skipped.

Actual final reader/candidate target: `nukhabapay_b3b3_2532f239553d446788b1d19226458582`. Other IAM/runtime/HTTP targets: `nukhabapay_b3b2_2fe39ac82e5e421d8f075f1028480c1c`, `nukhabapay_b3b3_f4099b3fe6a04fb7b1dec66830c3a5f2`, `nukhabapay_b3b3_16638a840b5549fbab48056335d4924e`. Database suite likewise uses its verified disposable targets. Before/after metadata is identical on loopback PostgreSQL 17.11: development history 001_catalog, 002_import_role_privileges, 003_import_role_read_access; database inventory only nukhabapay_dev, postgres, template0, template1. All disposable targets and reader/recorder roles cleaned. Migration 004 and pending 005 remain unapplied to development. No authentication settings changed or credentials/full URLs/tokens recorded.

Failure/setup history (preserved, not counted as passing):

- Initial focused compile (`receipt-reader-verification-20261111T132612642Z`) caught duplicate nominal query-brand types caused by importing a separately compiled application module through a relative runtime path. Corrected to a declared database-to-application workspace dependency and package export, so issuer and consumer share one private capability registry. No brand cast or provenance bypass was used to make it pass.
- `pnpm.cmd install --offline --ignore-scripts` refused module-directory replacement without a TTY; no purge was allowed. `pnpm.cmd install --lockfile-only --offline --ignore-scripts` succeeded without downloading anything. Created only the missing generated database node_modules application workspace junction, targeting the existing application directory. Lockfile diff is exactly the new workspace dependency entry; no external version changed. Manifests/lockfile support the normal fresh workspace install; generated link is not source.
- Next focused runner (`--integration-only`, `receipt-reader-verification-20261111T132857284Z`) passed 60/60 before the final active-query-loss case was added.
- First full runner (`receipt-reader-verification-20261111T133110160Z`) passed all 61 assertions but failed the test file on delayed uncaught ECONNRESET after idle pool termination. Pool-only error handling was insufficient during client checkout/removal. Added a lifetime per-client transport-error listener and failed-client discard checks, retaining normal query rejection/rollback behavior. No global exception suppression. Repeated the full runner above; all 222 passed with no asynchronous error.

Changed maintained files (14):

- Created `packages/database/src/synthetic-receipt-reader.ts`.
- Created `apps/api/test/fixtures/receipt-reader-acceptance.ts`.
- Created `docs/adr/0015-restricted-synthetic-receipt-reader.md`.
- Modified `packages/application/src/identity/trusted-staff-actor.ts` and `packages/application/src/index.ts` (query capability/expected-operation binding).
- Modified `packages/database/src/index.ts`, `packages/database/package.json`, `pnpm-lock.yaml` (reader export and workspace dependency).
- Modified `apps/api/test/fixtures/trusted-actor-acceptance.ts` (new acceptance invocation only).
- Modified `docs/progress.md`, `docs/verification.md`, `docs/security/requirements.md`, `docs/governance/pending-management-approvals.md`, `docs/build-sequence.md`.

Generated node_modules junction/build/test output and external checkpoint/runner/log artifacts are separate. Original migration/candidate SQL, role provisioning, policy/permission/assurance behavior, verifier, HTTP/runtime composition, recovery fixtures and financial/catalogue calculations remain unchanged.

Remaining limitations/blockers: local synthetic adapter acceptance is complete; operational registration is not authorized. The SQL login has its narrow projection privileges and mutable tenant scope but does not prove a human actor; never issue it to users. Ordinary application callers must pass the opaque actor/capability boundary, and no enumeration API exists. Separate IAM/read/audit transactions do not prove globally linearized revocation or atomic privileged mutation. Real MFA/accepted independent approval provenance, durable privileged staff workflows, full migration 005, real onboarding/provider and production activation remain BLOCKED/PENDING. No APPLY, reserved permissions, real staff/provider, endpoint or financial operation. Brick 3 remains incomplete. Stop for review. Next proposed functional implementation is local synthetic staff access-request submission/review with durable versioned server-owned requests and canonical-person review observations, retaining closed approval/APPLY gates; no further receipt preparation increment is proposed.

## Trusted staff actor and denied approval provenance

11 November 2026. Reviewed checkpoint: `../recovery-checkpoints/before-staff-actor-20261111T130757Z.zip`, 192 maintained files; SHA-256 `988604822f187ca113cbd01b20d7f0870c7b0a04023595838920b82e31925729`. Reused reviewed maintained-file allowlist, excluded environment/data/key/generated/dependency artifacts, verified archive entry hashes on readback and preserved prior backups. Prior checkpoint archive hash verified. No applicable AGENTS.md was found; no software installation or remote publication occurred.

Implemented `TrustedStaffActorBoundary` and integrated acceptance through the existing disposable persistence fixture. Uses actual synthetic signed tokens through unchanged jose verification, separate restricted IAM reader/audit writer, immutable server request fixture snapshots and a separate explicit synthetic receipt capability. No staff.self.read authorization is reused. Opaque actor/observation provenance is instance-private; all observations remain denied and NOT_AUTHORIZED. ADR 0014 records the exact trust boundaries and remaining gaps.

Eight new integration cases verify:

1. Forged JSON/UUID/header-like identities, cloned actor handles and cross-instance handles cannot act.
2. An explicitly authorized synthetic own-receipt read returns only its operation ID/tags after real committed audit. Changed payloads, disabled explicit policy and omitted receipt policy deny.
3. Exact case-sensitive identity resolution denies unknown bindings. Another active person in the same tenant and the same active person in another tenant cannot read the receipt; denied contexts never reach the artifact query.
4. Held actors fail after staff suspension, revoked membership or role-grant changes. No positive authorization cache.
5. Verified observation binds immutable request/person/policy/evidence, but signed client MFA/amr/acr flags still yield not-established and denied acceptance. Alternate identities of one canonical person cannot count twice; cloned observation provenance rejects.
6. Self, beneficiary, cross-tenant request, stale request/policy and revoked/missing current approval authority deny. No permission activation.
7. Substituted receipt actor and suspension during the artifact read cannot return a receipt.
8. Audit-writer failure and unavailable authorization database cannot return success. IAM pools/recorder connections are closed before fixture teardown.

Full final runner: `node ../recovery-checkpoints/verify-staff-actor.mjs`. All 15 commands exited zero; log/results/before/after metadata stem `../recovery-checkpoints/staff-actor-verification-20261111T131316864Z`.

| Exact command | Final result |
| --- | --- |
| `pnpm.cmd application:build` | Passed |
| `pnpm.cmd application:typecheck` | Passed |
| `pnpm.cmd application:test` | 71 passed |
| `pnpm.cmd db:build` | Passed |
| `pnpm.cmd db:typecheck` | Passed |
| `node packages/database/node_modules/typescript/bin/tsc -p packages/database/tsconfig.test.json` | Passed |
| `node --test --test-concurrency=1 packages/database/dist-test/database/test/*.spec.js` | 15 passed, real PostgreSQL catalogue/migration/IAM acceptance |
| `pnpm.cmd api:build` | Passed |
| `pnpm.cmd api:typecheck` | Passed |
| `pnpm.cmd api:test` | 47 passed, including existing verifier/HTTP/runtime/browser cases |
| `pnpm.cmd --filter @nukhabapay/api test:identity:integration` | 52 passed (44 previous + eight new) |
| `pnpm.cmd test` | 19 financial/provider tests passed |
| `pnpm.cmd demo` | Synthetic AED 102.00 / AED 2.77 unchanged |
| `python -B -m unittest discover -s apps/ai-service/tests -v` | 9 passed |
| `python -B scripts/check_structure.py` | Structure/21 JSON files/selected import/public-field checks passed |

Final full-run total **213 passed**, zero failed/cancelled/skipped. Initial focused run (`node ../recovery-checkpoints/verify-staff-actor.mjs --integration-only`) passed 51/51 before the final row-substitution/race case and stronger cross-context assertions were added; artifacts `staff-actor-verification-20261111T131057777Z`. Final full run compiled and exercised all final source. No runtime test failure or assertion weakening. No further source change after final verification.

Actual final actor/candidate target: `nukhabapay_b3b3_e7331ba21b0b44cbba38a54e222b9a31`. Other final IAM/runtime/HTTP targets: `nukhabapay_b3b2_fbac659108c2497d8f1f0d28dd6cfeff`, `nukhabapay_b3b3_a13235e035254f86b6ab35197db17e02`, `nukhabapay_b3b3_61934752b831460885931f4aa53d807f`. Existing database suite likewise uses verified disposable targets. Generated targets and the ephemeral recorder were removed after zero-session checks. Read-only before/after metadata is identical: loopback PostgreSQL 17.11; development migrations 001_catalog, 002_import_role_privileges, 003_import_role_read_access. Migration 004 and the pending 005 candidate remain unapplied to development. No credentials, full URLs or tokens recorded; no authentication-setting change.

Changed-file inventory (10 maintained files):

- Created `packages/application/src/identity/trusted-staff-actor.ts`.
- Created `apps/api/test/fixtures/trusted-actor-acceptance.ts`.
- Created `docs/adr/0014-trusted-staff-actors-and-observations.md`.
- Modified `packages/application/src/index.ts` (new boundary/type exports only).
- Modified `apps/api/test/staff-persistence.integration.ts` (fixture import/invocation only).
- Modified `docs/progress.md`, `docs/verification.md`, `docs/security/requirements.md`, `docs/governance/pending-management-approvals.md`, `docs/build-sequence.md`.

Generated build/test outputs and external checkpoint/runner artifacts are separate. Hash comparison confirms existing migrations, candidate SQL, role provisioning, recovery fixtures, policy/permission/assurance behavior, verifier, deployed API routes and catalogue/financial source are unchanged.

Security findings/limits: identity provenance is demonstrable locally; **accepted approval provenance is not**. Current signed token profile does not establish MFA, and approval permissions remain reserved. Inspection returns denial with an immutable observation, never an accepted approval/quorum or privileged authority. Request storage is a trusted test port, not durable approval persistence. Real provider assurance, authenticated durable independent approvals, canonical-person provisioning, privileged atomic mutation and operational activation remain BLOCKED/PENDING. The receipt reader is injected only in synthetic acceptance, not deployed runtime. Its recorder credential is not a human actor boundary; no database actor-isolation claim. Separate reader/audit/receipt transactions do not prove globally linearized revocation or atomic privileged mutation. All returned receipt/observation outcomes remain NOT_AUTHORIZED. Brick 3 is incomplete. Stop for review; proposed next bounded code is a restricted default-deny actor-filtered receipt-reader adapter with disposable acceptance, without runtime grant activation or privileged execution.

## Non-authorized database failure-recovery acceptance

11 November 2026. Checkpoint before changes: `../recovery-checkpoints/before-staff-recovery-20261111T124249Z.zip`, 190 reviewed maintained files, SHA-256 `62a5f96d63009656472b587d5590be28141817dc59a5d3f233f88464e3e0e333`. Verified archive entries on readback; prior archive preserved and hash checked. Environment, database, dependency, generated-output and key material excluded using the reviewed maintained-file allowlist. No Git installation or remote publication.

Two new fixtures live only under API tests: a bounded loopback PostgreSQL protocol proxy and a non-authorized artifact reconciliation/retry harness. Existing persistence acceptance invokes them inside its already verified disposable target and restricted ephemeral recorder. No SQL/migration, runtime source, package, dependency, role provisioning or existing assertion changes. ADR 0013 specifies protocol and limitations.

Actual failure evidence:

- Terminated the known recorder backend while a complete staged tuple was uncommitted; the backend disappeared, all writes rolled back, fresh receipt reconciliation returned NOT_COMMITTED and retry recorded one complete tuple.
- While that transaction held its reservation, reconciliation returned UNRESOLVED rather than treating an invisible receipt as proof of rollback.
- A loopback TCP proxy cut the connection before forwarding COMMIT, then separately after PostgreSQL committed but before the client received the COMMIT acknowledgement. Both driver failures returned UNRESOLVED with no receipt/operation ID. Fresh primary receipt reconciliation distinguished NOT_COMMITTED and COMMITTED respectively.
- Three independent concurrent retry connections converged on one stable operation. Counts for proposal, audit intent, receipt and outbox remained exactly one each. Changed-payload retries returned CONFLICT without another record.
- Termination after confirmed commit preserved the authoritative receipt. Unknown/foreign actor or tenant and cloned bootstrap contexts returned DENIED with no receipt. The actor-filtered database query returned no other actor's receipt; existing populated-table tenant RLS denial is preserved.
- Unavailable lookup returned UNRESOLVED, never NOT_COMMITTED or a cached success. An aborted transaction was discarded; fresh connections recovered without idle transactions. Teardown verifies zero remaining disposable sessions, removes the recorder role and drops only the owned generated database.
- A final additional case checks COMMIT's actual command tag: PostgreSQL ROLLBACK in an aborted transaction must return NOT_COMMITTED and leave no tuple. Its final focused rebuild/result is recorded below.

Full regression command: `node ../recovery-checkpoints/verify-staff-recovery.mjs`. Redacted artifacts stem: `../recovery-checkpoints/staff-recovery-verification-20261111T124640988Z` (`.log`, `.results.json`, `.before.json`, `.after.json`). All 15 commands exited zero:

| Exact command | Full-run result |
| --- | --- |
| `pnpm.cmd application:build` | Passed |
| `pnpm.cmd application:typecheck` | Passed |
| `pnpm.cmd application:test` | 71 passed |
| `pnpm.cmd db:build` | Passed |
| `pnpm.cmd db:typecheck` | Passed |
| `node packages/database/node_modules/typescript/bin/tsc -p packages/database/tsconfig.test.json` | Passed |
| `node --test --test-concurrency=1 packages/database/dist-test/database/test/*.spec.js` | 15 passed |
| `pnpm.cmd api:build` | Passed |
| `pnpm.cmd api:typecheck` | Passed |
| `pnpm.cmd api:test` | 47 passed |
| `pnpm.cmd --filter @nukhabapay/api test:identity:integration` | 43 passed (37 preserved + six new recovery cases) |
| `pnpm.cmd test` | 19 passed |
| `pnpm.cmd demo` | Synthetic AED 102.00 total / AED 2.77 contribution unchanged |
| `python -B -m unittest discover -s apps/ai-service/tests -v` | 9 passed |
| `python -B scripts/check_structure.py` | Structure, 21 JSON files and selected import/public-field checks passed |

Full-run total 204 passed; zero failures, cancellations or skips. The seventh recovery case was added after integration compilation in that full run, so it requires the separate final focused rebuild below; it is not claimed in the 204 total. An earlier integration-only run also passed 43/43 (`staff-recovery-verification-20261111T124502651Z`). No test/assertion was weakened or skipped.

Final focused rebuild: `node ../recovery-checkpoints/verify-staff-recovery.mjs --integration-only` executes `pnpm.cmd --filter @nukhabapay/api test:identity:integration`, rebuilding application/database/API and compiling all API tests. **44/44 passed**, zero failed/cancelled/skipped, including the seventh ROLLBACK-tag case. Redacted log, zero-exit results and identical before/after metadata stem: `../recovery-checkpoints/staff-recovery-verification-20261111T125051702Z`. Candidate target: `nukhabapay_b3b3_f5a1208475ec419eae2071ff60db78a6`; all targets and the recorder were cleaned up. Latest per-suite evidence totals 205 passing test results (71 + 15 + 47 + 44 + 19 + 9), across the full run and final focused rebuild; no claim of a single 205-test full run. All seven new recovery cases passed. No runtime test failures occurred. Source/SQL hashes against the checkpoint confirm no production or migration changes. No source changes followed the final rebuild.

Full-run candidate target: `nukhabapay_b3b3_b709f9223bc54bbd91f4a00bb892b8e2`. Other IAM/runtime/HTTP targets: `nukhabapay_b3b2_009b4d420fe846febdee3625d3ca18f3`, `nukhabapay_b3b3_714f4ea74c35447880f448401e74910f`, `nukhabapay_b3b3_a2ccf39a82654e8fa38033821681676b`. Database suite uses its existing verified disposable targets. Runner metadata before/after confirms loopback PostgreSQL 17.11, development history 001_catalog/002_import_role_privileges/003_import_role_read_access and unchanged database inventory. No 004 or pending-005 application to development. Actual credentials and URLs were process-local and redacted; no authentication settings changed.

Changed maintained files: new `apps/api/test/fixtures/commit-loss-proxy.ts`, new `apps/api/test/fixtures/staff-recovery-acceptance.ts`; modified `apps/api/test/staff-persistence.integration.ts` (import/invocation only), `docs/progress.md`, `docs/verification.md`, `docs/security/requirements.md`, `docs/governance/pending-management-approvals.md`, `docs/adr/0013-staff-persistence-security-gates.md`. Generated build/test outputs and external checkpoint/runner/log artifacts are separate. Existing production source, candidate SQL, registered migrations, catalogue/IAM privileges, financial logic and test assertions remain unchanged.

Limits: all receipts/results are NOT_AUTHORIZED simulation artifacts. The actor/scope capability is synthetic test-bootstrap binding, not real human authentication. Recorder credentials can select another scope and are not database-enforced actor isolation; they remain prohibited in runtime. No privileged adapter, APPLY, staff mutation, real account, MFA/approval provenance, outbox delivery, provider, endpoint, server/storage crash, replication failover or restore exercise. Real authority/operational gates remain BLOCKED/PENDING. Brick 3 overall remains incomplete. Stop for review after this bounded acceptance task.

## Brick 3 completion security amendment

Verified 11 November 2026 against loopback PostgreSQL 17.11, synthetic identities and ephemeral local signing keys. The reviewed 185-file checkpoint is `../recovery-checkpoints/before-brick3-amendment-20261111T122059Z.zip`; SHA-256 `5c1dc800c08f3ca9cc2d71a1bb2cd491e3d23403dfa1f0842f0b9d10238dcb06`. Its manifest and archive entries were verified before edits; earlier backups preserved. Git is unavailable; no installation or remote publication. No applicable AGENTS.md was found.

Runner: `node ../recovery-checkpoints/verify-brick3-amendment.mjs`. It supplies only process-local, redacted synthetic configuration using existing loopback PostgreSQL access; it changes no authentication settings. Its read-only before/after checks verify actual development host/port/database/role/history and unchanged database inventory. Test destruction uses the existing verified disposable-target fixture. No secret values or full connection URLs are recorded.

| Exact command | Final result |
| --- | --- |
| `pnpm.cmd application:build` | Passed |
| `pnpm.cmd application:typecheck` | Passed |
| `pnpm.cmd application:test` | 71 passed |
| `pnpm.cmd db:build` | Passed |
| `pnpm.cmd db:typecheck` | Passed |
| `node packages/database/node_modules/typescript/bin/tsc -p packages/database/tsconfig.test.json` | Passed |
| `node --test --test-concurrency=1 packages/database/dist-test/database/test/*.spec.js` | 15 passed, including real PostgreSQL catalogue replay/rollback/concurrency, migration rollback, IAM privileges/RLS |
| `pnpm.cmd api:build` | Passed |
| `pnpm.cmd api:typecheck` | Passed |
| `pnpm.cmd api:test` | 47 passed, including 3 new local browser policy tests and preserved verifier/HTTP/runtime tests |
| `pnpm.cmd --filter @nukhabapay/api test:identity:integration` | 37 passed, including 7 new persistence subtests plus their parent; all 29 prior tests preserved |
| `pnpm.cmd test` | 19 finance/domain/provider tests passed |
| `pnpm.cmd demo` | Synthetic AED 102.00 total / AED 2.77 contribution unchanged |
| `python -B -m unittest discover -s apps/ai-service/tests -v` | 9 passed |
| `python -B scripts/check_structure.py` | Structure, 21 JSON files, public-field/import checks passed |

Final total: 198 test results passed, zero failed/cancelled/skipped. No assertion weakened or existing test removed. Final redacted command log, all exit statuses and before/after metadata: `../recovery-checkpoints/brick3-amendment-verification-20261111T123046156Z.{log,results.json,before.json,after.json}`.

After adding populated-table RLS assertions (missing context and foreign tenant cannot see any committed tuple member), reran `node ../recovery-checkpoints/verify-brick3-amendment.mjs --integration-only`: 37/37 passed, zero failed/skipped. This recompiles all API/application/database dependencies and integration tests. Latest redacted log/status/metadata stem: `../recovery-checkpoints/brick3-amendment-verification-20261111T123712707Z`. Candidate target was `nukhabapay_b3b3_794c3be229ad420f81569fc1129fa659`; preceding IAM/runtime/HTTP targets were `nukhabapay_b3b2_b99994c212f84e16bd964b4709a9ead2`, `nukhabapay_b3b3_0ecbfc58db884ab18cbe66d1eec19f63`, `nukhabapay_b3b3_49bba49d64b041aaac979ddde97c0db6`. Cleanup and unchanged development history/inventory passed again. No other source changed after the full regression.

Actual new-candidate database: `nukhabapay_b3b3_2401183ae64a416d8b3ea440b332cd33`. Other final IAM/HTTP/runtime targets: `nukhabapay_b3b2_7c434773dc90460fbcec3c09a132a55c`, `nukhabapay_b3b3_50316b32346843a4b22415e6f0f1c627`, `nukhabapay_b3b3_b319b6f0586e44ee9ba518895df0b011`. All were created, target-verified and removed by the existing fixture. The separate database suite likewise uses verified disposable targets. Before/after database inventory is exactly development, postgres and the two template databases. Development was queried READ ONLY: history 001_catalog, 002_import_role_privileges, 003_import_role_read_access. Migration 004 remains unapplied there. The candidate SQL is outside normal migration registration and records no 005 history row.

New PostgreSQL evidence: transaction-local scope denial; failure after each of four staged writes leaves zero records; deferred constraint rejects incomplete COMMIT; concurrent duplicate actor/key cannot commit twice; changed payload and mismatched event/digest reject; committed tuple lookup preserves digest; forged UUID/approval/MFA/simulation input cannot execute; recorder cannot read/mutate staff or forge existing security audits; all four canonical workload roles lack any workflow DML/TRUNCATE or function EXECUTE. Recorder has no schema CREATE or UPDATE/DELETE/TRUNCATE; all four tables have enabled and forced RLS. Function is SECURITY INVOKER with pg_catalog search_path. No runtime recorder is provisioned.

Failure history: initial integration-only run failed due to ambiguous UUID/text SQL parameter inference (42P08) in the new test insert, with subsequent aborted-transaction failures. Distinct parameters and guaranteed rollback corrected it; all pre-existing tests passed throughout. The next integration-only run passed 35/35. Further complete-tuple and audit-binding constraints/tests were added, then the full final run above passed 37/37 integration tests. All disposable inventories were cleaned; no bypass or assertion reduction.

Not performed / BLOCKED: real provider or MFA validation, independently authenticated approval persistence, real staff mutation/audit/receipt/outbox execution, privileged SECURITY DEFINER acceptance, network/process-kill commit uncertainty recovery, outbox delivery, backup restore, full browser/BFF session implementation and operational activation. Existing deterministic uncertain-acknowledgement tests are simulation evidence only. A four-artifact transaction is not proof of atomic staff mutation. `assurance=not-established` and reserved permission denial remain unchanged. ADR 0013 records the remaining gates and exact privilege matrix. Brick 3 is NOT fully complete.

Maintained files created: `packages/database/pending-migrations/005_staff_access_workflows.sql`, `apps/api/test/staff-persistence.integration.ts`, `apps/api/src/modules/identity/staff-browser-security.ts`, `apps/api/test/staff-browser-security.spec.ts`, `docs/adr/0013-staff-persistence-security-gates.md`. Maintained files modified: `apps/api/package.json` (explicit integration test list only), `docs/progress.md`, `docs/verification.md`, `docs/build-sequence.md`, `docs/security/requirements.md`, `docs/governance/pending-management-approvals.md`. Build/test output and external checkpoint/verification artifacts are generated separately; original migration/role/policy/catalogue/financial source remains unchanged.

Historical verification on 9 November 2026 used Node.js v24.22.1 and the workspace Python interpreter. The baseline was independently rerun on this Windows machine on 9 November 2026 using Node.js v24.22.2, npm 11.19.1, and CPython 3.13.17 (64-bit).

| Check | Observed result |
| --- | --- |
| TypeScript financial/domain and synthetic provider tests | 19 passed, 0 failed |
| Python advisory equivalence tests | 9 passed, including 10 fixture scenarios |
| Synthetic price demonstration | Customer total AED 102.00; expected contribution AED 2.77; selected synthetic provider A |
| Scaffold/JSON/public-field/import checks | Passed |
| JSON and local Compose YAML parsing | Passed |

The financial tests cover exact money, fee rounding, missing tax, fee caps, negative contribution, product mismatch, stale/expired/unavailable offers, double-counted discounts, calendar/offset validity, input bounds, public/private field separation and immutability. The matching tests cover hard negatives, missing attributes, provenance and forbidden authorization fields.

The examples create no executable quote, order or payment and make no live provider/model calls.

The historical scaffold check did not include a framework build, TypeScript compiler check, HTTP test, database migration, Docker startup, production load test, or independent security assessment. This increment adds a minimal API build/typecheck/HTTP suite, but the remaining platform and release gates are still outstanding. Native Node TypeScript execution checks runtime behavior, not static TypeScript correctness.

## Current Windows baseline rerun

Verified with the exact installed executables:

- Node: `C:\Users\Admin\AppData\Local\Programs\node-v24.22.2-win-x64\node.exe` (`v24.22.2`).
- npm: `C:\Users\Admin\AppData\Local\Programs\node-v24.22.2-win-x64\npm.cmd` (`11.19.1`).
- Python: `C:\Users\Admin\AppData\Local\Programs\Python\Python313\python.exe` (`3.13.17`, 64-bit).

Commands and observed outcomes:

| Command | Outcome |
| --- | --- |
| `node --experimental-strip-types scripts/demo.ts` | Passed; provider A selected, total AED 102.00, expected contribution AED 2.77, `executable: false`. |
| `node --experimental-strip-types --test packages/domain/test/*.test.ts packages/provider-adapters/test/*.test.ts` | 19 passed, 0 failed. |
| `python -m unittest discover -s apps/ai-service/tests -v` | 9 test methods passed. |
| `python scripts/check_structure.py` | Passed; 17 JSON files and the documented scaffold checks. |

The WindowsApps `python.exe` was initially a Store launcher without an interpreter. The successful Python commands used the verified CPython 3.13.17 executable after installation. No execution policy or security controls were weakened.

## API foundation

Verified on Node.js v24.22.2, npm 11.19.1, pnpm 10.34.9, NestJS 12.4.2, Nest CLI 12.0.12, and TypeScript 6.0.2:

| Command/check | Outcome |
| --- | --- |
| `corepack.cmd pnpm install --frozen-lockfile` | Passed; lockfile up to date, no dependency changes. |
| `pnpm.cmd api:build` | Passed with `nest build`. |
| `pnpm.cmd api:typecheck` | Passed with strict TypeScript settings and no emit. |
| `pnpm.cmd api:test` | 3 tests passed; the suite compiles tests strictly and starts a real HTTP listener on loopback. |
| Compiled `node dist/main.js` startup probe | Passed on an ephemeral loopback port; `GET /health/live` returned HTTP 200 and `{"status":"ok"}`. |

The API tests cover default and explicit configuration, invalid listener values failing before startup, the process-only liveness response, cache prevention, sanitized 404 and malformed-JSON responses, rejection of compressed JSON, and the 16 KiB request-body limit. A full baseline rerun after API dependency installation also passed: demo, 19/19 TypeScript tests, 9/9 Python test methods, and structure checks (17 JSON files).

Passing these checks does not satisfy database, authentication, deployment, production load, or independent security-assessment gates.

## Database foundation status (verified)

The local PostgreSQL 17 foundation was verified on this Windows machine using a user-scoped cluster created from the official PostgreSQL 17 binary archive. Verified on Node.js v24.22.2 and pnpm 10.34.9:

| Command/check | Outcome |
| --- | --- |
| `C:\Users\Admin\PostgreSQL\pgsql\bin\initdb.exe --version` | Passed; PostgreSQL 17.11. |
| `pg_ctl -D C:\Users\Admin\PostgreSQL\pgsql\data start` | Passed; cluster started and `pg_isready` reported `127.0.0.1:5432 - accepting connections`. |
| `psql -h 127.0.0.1 -U postgres -d postgres -c "SELECT version();"` | Passed; PostgreSQL 17.11 on x86_64-windows. |
| `pnpm --filter @nukhabapay/database test` | Passed; 3 config tests covering local loopback rules, distinct migration/runtime roles, and bounded settings. |
| `pnpm --filter @nukhabapay/database migrate` | Passed; migration applied to the disposable `nukhabapay_dev` database under the migrator role. |
| `pnpm --filter @nukhabapay/database test:integration` | Passed; 2 live PostgreSQL integration tests passed covering runtime restrictions, migration repeatability, and transactional rollback cleanup. |

The verification included separate migration and runtime roles, a disposable development database, migration replay validation, and a failing fixture that rolled back cleanly without leaving schema state behind. No security settings were disabled and the DB work remains constrained to the local foundation only.

## Brick 2B recovery and final acceptance (10 November 2026)

Environment used: native Windows PowerShell, Node.js `v24.22.2`, pnpm `10.34.9`, CPython `3.13.17`, and the existing loopback PostgreSQL `17.11` cluster. Database URLs and passwords are intentionally not recorded here.

### Commands and outcomes

| Command | Observed result |
| --- | --- |
| `pnpm.cmd install` | Passed after adding the pinned TypeScript `6.0.2` development dependency for `@nukhabapay/application`; lockfile updated without downloads. |
| `pnpm.cmd install --frozen-lockfile` | Passed; lockfile up to date. |
| `pnpm.cmd --filter @nukhabapay/database test` | 9 passed, 0 failed, 0 skipped. The test script strictly compiles package source and tests before running. |
| `pnpm.cmd --filter @nukhabapay/database test:integration` | 9 passed, 0 failed, 0 skipped against local PostgreSQL. |
| `pnpm.cmd --filter @nukhabapay/database build` and `... typecheck` | Passed. |
| `pnpm.cmd application:build`, `application:typecheck`, `application:test` | Passed; the application use-case forwarding test passed 1/1. |
| `pnpm.cmd api:build`, `api:typecheck`, `api:test` | Passed; API tests 3/3. |
| `node --experimental-strip-types scripts/demo.ts` | Passed; customer total AED 102.00 and expected contribution AED 2.77. |
| `node --experimental-strip-types --test packages/domain/test/*.test.ts packages/provider-adapters/test/*.test.ts` | 19 passed, 0 failed. |
| `C:\Users\Admin\AppData\Local\Programs\Python\Python313\python.exe -m unittest discover -s apps/ai-service/tests -v` | 9 test methods passed. |
| `C:\Users\Admin\AppData\Local\Programs\Python\Python313\python.exe scripts/check_structure.py` | Passed; 20 JSON files plus documented public-field/import checks. |
| `pnpm.cmd --filter @nukhabapay/database migrate` | Applied migrations `002_import_role_privileges` and `003_import_role_read_access` to the existing `nukhabapay_dev` database. No database or cluster recreation. |

### Confirmed repair causes and evidence

- **Identical replay conflict:** input and repeated input were equivalent. PostgreSQL `timestamptz` read-back produced JavaScript `Date` values, while comparison used string representations; product identity read-back was also incomplete. Comparison now canonicalizes timestamps to UTC and includes all persisted product/offer fields, source version, observation time, and effective time. Identical replay returns `created: false` with the original snapshot ID and no duplicates. Changed source version or offer amounts produce `CatalogImportConflictError`; a separate read verifies the original amount and offer remain unchanged.
- **Approval/rollback assertions:** the previous would-be review mapping was hidden by an earlier invalid snapshot reference, so it never reached mapping approval. Snapshot mismatch, provider-input review status, missing mappings, proposed mappings, and conflicting approved mappings now have separate coverage. A test-only PostgreSQL trigger fails on the second offer insert after the first insert succeeds. A separate restricted runtime connection verifies zero failed-snapshot/offer rows and unchanged accepted-baseline query results.
- **Concurrency:** the initial six-way duplicate import exposed a pool deadlock because the winning transaction held a connection while read-back tried to acquire another. Repository read-back now uses the same checked-out connection. Six simultaneous identical imports produce exactly one `created: true` result and return the same snapshot ID.
- **Provider contract and local command:** application orchestration now consumes the existing provider-contract `ProviderOffer`/`CatalogProvider` types. The script behind the documented `pnpm.cmd catalog:import:synthetic` command was exercised end-to-end against a disposable database using explicit tenant/account IDs and the restricted import role. The persisted complete snapshot was then read via the runtime role.
- **Effective role permissions in `nukhabapay_dev`:** import SELECT on snapshots/mappings was verified true; INSERT on offers true; DELETE on offers false; UPDATE on snapshot completion status true; UPDATE on snapshot identity key false; runtime INSERT on offers false. Live acceptance tests also confirm all three roles are distinct and none is superuser, database/role creator, or inheriting privileges. Runtime queries succeed while runtime writes fail.
- **Structure-check environment issue:** after package dependencies were present, the Windows structure checker attempted to decode dependency `.d.ts` files using the default cp1252 encoding. It now skips `node_modules`, `dist`, and `dist-test` while retaining checks on project source; the final check passes.

The acceptance suite creates random, uniquely named databases on loopback and drops only those it created. It does not target `nukhabapay_dev` for test cleanup. The disposable database left by the first deadlocked attempt and two older databases whose generated names and `alpha`/`beta`/`gamma` fixture tenants identified them as stale test databases were verified to have no active sessions and explicitly dropped by exact name. No developer data was removed. PostgreSQL was not reinstalled, reset, or replaced.

### Scope and remaining limits

Brick 2B import/read acceptance is complete for the local synthetic, complete-snapshot workflow. It is not an authenticated catalog API, delta-feed implementation, mapping-approval workflow, price-publication system, real provider connection, worker, AI integration, or payment/order system. The local synthetic CLI requires a previously registered product and approved mapping. This verification is not a production security assessment or a claim that the platform is breach-proof.

## Brick 3A provider-independent staff foundation (11 November 2026)

Environment: Node.js `v24.22.2`, pnpm `10.34.9`, CPython `3.13.17`, and the existing local PostgreSQL `17.11` cluster. Database URL values and passwords are not recorded. The local identity-reader and identity-writer login roles were created by `packages/database/roles/provision_identity_roles.sql`. A role catalog query confirmed both are LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOINHERIT, NOBYPASSRLS, with no role memberships.

### Commands and results

| Command | Observed result |
| --- | --- |
| `pnpm.cmd install --frozen-lockfile` | Passed; all workspace projects up to date. |
| `psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d postgres -f packages\database\roles\provision_identity_roles.sql` | Passed; created or verified only the two isolated identity login roles. No passwords were set by the script. |
| `pnpm.cmd --filter @nukhabapay/application test` | 11 passed, 0 failed, 0 skipped. |
| `pnpm.cmd --filter @nukhabapay/application build` | Passed. |
| `pnpm.cmd --filter @nukhabapay/application typecheck` | Passed. |
| `pnpm.cmd --filter @nukhabapay/database build` | Passed. |
| `pnpm.cmd --filter @nukhabapay/database typecheck` | Passed. |
| `pnpm.cmd --filter @nukhabapay/database test` | 11 passed, 0 failed, 0 skipped. Includes Brick 2B real PostgreSQL import tests and Brick 3A IAM acceptance. |
| `pnpm.cmd --filter @nukhabapay/database test:integration` | 11 passed, 0 failed, 0 skipped. |
| `pnpm.cmd api:build` | Passed. |
| `pnpm.cmd api:typecheck` | Passed. |
| `pnpm.cmd api:test` | 3 passed, 0 failed, 0 skipped. |
| `pnpm.cmd demo` | Passed; synthetic AED 102.00 customer total and AED 2.77 expected contribution, explicitly non-executable. |
| `pnpm.cmd test` | 19 passed, 0 failed, 0 skipped across domain/provider suites. |
| `C:\Users\Admin\AppData\Local\Programs\Python\Python313\python.exe -m unittest discover -s apps/ai-service/tests -v` | 9 test methods passed. |
| `C:\Users\Admin\AppData\Local\Programs\Python\Python313\python.exe scripts/check_structure.py` | Passed; 21 JSON files, public-field separation, and selected dependency-boundary checks. |

Database acceptance creates random loopback disposable databases. It exercised migration 004 on fresh databases, ran migrations a second time without changes, then removed only those test databases. Querying the existing `nukhabapay_dev` history afterward still showed only migrations `001_catalog`, `002_import_role_privileges`, and `003_import_role_read_access`; the data directory and development database were not recreated or migrated. The cluster stopped unexpectedly during one interrupted parallel verification attempt; it was restarted from its existing data directory and completed PostgreSQL crash recovery. No database reset or reinitialization was performed.

### Brick 3A PostgreSQL acceptance evidence

- Fresh and repeat migration application succeeded. Seeded fixed catalog counts matched 12 roles, 23 permissions, and 32 role-permission mappings.
- Synthetic staff, exact issuer/subject identities, memberships, and grants round-tripped. Case-sensitive identity lookup behaved exactly; duplicate issuer/subject binding, cross-tenant membership/grant association, and platform/tenant role-scope mismatches were rejected by database constraints.
- Authorization allowed only the active 3A self permission in its own scope. Unknown/disabled identities, suspended staff, suspended membership, expired/revoked grants, unknown/inactive permissions, tenant/object mismatch, platform-only grants used for tenant access, conflicting catalogue roles, and internal-staff self-approval were denied by application tests or PostgreSQL-backed read resolution. Repository database errors propagate rather than allowing.
- The actual identity-reader login had no membership or tenant-grant rows without tenant context. With transaction-local tenant A context, it read only tenant A memberships, grants, and audit rows. Releasing/rolling back the pooled connection left no tenant context for the next checkout.
- Column-limited SELECTs denied staff email and permission-definition reads. Reader writes to grants/definitions/audit, audit UPDATE/DELETE, and DDL were rejected. The writer could append bounded audit events but could not read audits, write grants, change definitions, update/delete audits, or perform DDL. Existing catalog runtime and importer identities could not mutate audit rows.
- Audit rows have no arbitrary metadata/free-text field; fixed vocabularies and typed identifiers are enforced. UPDATE/DELETE triggers reject mutations. A two-event audit batch was forced to fail on its second insert after the first event had been written; a separate administrator read showed neither failed-batch event persisted and both previously committed baseline events remained unchanged.

No required Brick 3A test was skipped. Synthetic identity tests establish only the local provider-independent foundation; they do not prove Auth0 or any other provider login, token verification, browser flow, production tenant authorization, or production security. Brick 2B's prior status and limitations remain unchanged.

### Brick 3B prerequisites still open

Auth0 remains the proposed reference provider, not an approved or configured service. Issuer URL, API audience, registered client and callback details, deployment region/jurisdiction, procurement and account ownership, identity lifecycle, and whether a KissAux/NubbaPay login system is reusable all await owner confirmation. No external accounts or service were provisioned. Do not begin token validation or expose business endpoints until these decisions and the provider-backed acceptance plan are approved.

## Bounded recovery acceptance ? 11 November 2026

Scope: only the three takeover defects and related regression/documentation repairs. No Brick 3B/4, Auth0, business endpoint, live provider, financial execution, development migration, database reset, role provisioning or system-setting changes.

### Checkpoint and target verification

No `.git` entry exists in this or any enclosing directory through `C:/`; Git was not on PATH or at the standard system/per-user installation paths. [Git's official Windows installation page](https://git-scm.com/install/windows) identifies the standalone and portable distributions and `winget install --id Git.Git -e --source winget`. No installer was run and nothing was published remotely. The checkpoint is an archive, not a Git commit or database backup.

Before source edits, 139 reviewed files were archived to `../recovery-checkpoints/before-recovery-20261111T070239Z.zip` (path relative to the repository root). Its adjacent `.manifest.json` records every included file's SHA-256 and exclusions. Every archive entry was read back and hash-verified; archive SHA-256: `a1d08f74ac857f1116025cf28d3f931378976e93908cde08d9b6653023644227`.

Credential-pattern findings were reviewed as synthetic configuration-test values or SQL references to environment variables. All environment files, including the template, were excluded, as were dependencies, database/data directories, caches, build/test output and generated provider-contract source outputs. No detected live credentials were included; this review is not a guarantee of comprehensive secret detection. Existing environment files and generated source artifacts were preserved in place.

Read-only pre/post queries verified PostgreSQL 17.11 on `127.0.0.1:5432`, database `nukhabapay_dev`, using the migrator only for migration metadata. Both checks returned exactly `001_catalog`, `002_import_role_privileges`, `003_import_role_read_access`; the database inventory was identical before and after each acceptance run. Migration 004 remains unapplied to development. Its pending SQL was amended; migrations 001?003 were not changed.

The existing loopback PostgreSQL `trust` configuration was unchanged. Test URL shape checks used process-local random nonfunctional password values; they are not deployment credentials. No URLs/passwords were logged or persisted. The test administrator was used only for disposable database lifecycle, fixtures and privileged inspection; application paths used their intended restricted logins. Harnesses generated unique target names and dropped only databases they created.

### Root causes and corrective evidence

1. **Replay transaction:** the identical-content branch returned before COMMIT, and `release()` does not end a transaction. It now commits before returning. Acceptance repeats the import three more times, verifies the reused backend has state `idle`, null `xact_start` and zero advisory locks via a separate importer login, and acquires the same advisory lock independently. Existing six-way concurrency, stable snapshot identity, conflict rejection, unchanged historical amounts, tenant ownership and post-write rollback checks pass.
2. **Migration rollback assertion:** failure targeted a generated database but absence was checked in maintenance database `postgres`. The assertion now connects to the exact failed target and asserts `current_database()`. The failure must actually be division by zero; both `rollback_probe` and the failed migration-history row must be absent there.
3. **IAM default grants:** migrations 001?003 left schema-level automatic SELECT grants for catalogue roles on new migrator-owned tables. Pending 004 now removes those default table grants before IAM creation, explicitly revokes all catalogue/PUBLIC access on the nine IAM tables, and keeps existing catalogue grants. Real catalogue logins get SQLSTATE 42501 for all nine IAM reads and have no column SELECT. A table created afterward by the actual migrator receives no automatic workload read/write grants. Exact IAM column rights, lack of extra table rights, all three forced-RLS flags, tenant context and audit behavior are checked. The down migration restores the pre-004 catalogue SELECT defaults after dropping IAM tables.

### Commands and actual outcomes

Installed versions: Node `v24.22.2`, pnpm `10.34.9`, CPython `3.13.17`, PostgreSQL `17.11`; existing pinned TypeScript `6.0.2` and dependencies were used. No dependency installation or lockfile change was needed.

Commands ran from the repository root, with the required database environment supplied only to child processes. Sanitized full output and per-command exit statuses are in the sibling `recovery-checkpoints/verification.log`, `verification-results.json`, and `verification-database-final.log` / `verification-results-database-final.json`. The local helper `verify-recovery.mjs` contains no stored credentials; it verifies target/history and inventory around execution and rejects skipped database acceptance.

| Command | Actual result |
| --- | --- |
| `pnpm.cmd db:build` | Passed |
| `pnpm.cmd db:typecheck` | Passed |
| `node packages/database/node_modules/typescript/bin/tsc -p packages/database/tsconfig.test.json` | Passed |
| `node --test --test-concurrency=1 packages/database/dist-test/database/test/*.spec.js` | 11 passed, 0 failed, 0 skipped; real disposable PostgreSQL |
| `pnpm.cmd db:test` after strengthening the migration-error assertion | 11 passed, 0 failed, 0 skipped; fresh source/test compilation and real disposable PostgreSQL |
| `pnpm.cmd application:build` | Passed |
| `pnpm.cmd application:typecheck` | Passed |
| `pnpm.cmd application:test` | 11 passed, 0 failed, 0 skipped |
| `pnpm.cmd api:build` | Passed |
| `pnpm.cmd api:typecheck` | Passed |
| `pnpm.cmd api:test` | Fresh build/strict test compilation; 3 passed, 0 failed, 0 skipped |
| `pnpm.cmd test` | Financial/domain/provider suite: 19 passed, 0 failed, 0 skipped |
| `pnpm.cmd demo` | Synthetic total AED 102.00, contribution AED 2.77, executable false |
| `python -B -m unittest discover -s apps/ai-service/tests -v` | 9 methods passed |
| `python -B scripts/check_structure.py` | Passed; 21 JSON files and documented boundary checks |

The database `test` and `test:integration` scripts currently have identical compile/run bodies; the full suite was executed as above without treating skipped integration cases as acceptance. Test counts remain 11 because the new assertions extend the existing real-database scenarios. The final ordinary package-script run includes the stricter division-by-zero assertion. All commands exited zero. A documentation-only structure check was also rerun after documentation updates.

### Database privilege conclusions

- Catalogue runtime: catalogue SELECT only; IAM SELECT denied on all nine tables, including staff contact details and exact external identities.
- Catalogue importer: existing catalogue SELECT, snapshot/offer INSERT and completion-column UPDATE preserved; DELETE, snapshot identity/product writes and DDL still denied; IAM SELECT denied on all nine tables.
- IAM reader: exact column allowlist only; no staff contact-email or definition-table reads; no IAM writes or extra table privileges. Forced RLS restricts memberships, tenant grants and audit reads; missing context returns no tenant rows and pooled context is cleared.
- Audit writer: audit INSERT only; no IAM reads, grant/definition changes, audit UPDATE/DELETE, extra table privileges or DDL. Audit rows remain immutable and failed batches roll back without changing accepted baseline rows.
- New migrator-owned table probe: no automatic SELECT or DML for any of the four workload roles. No changes to existing catalogue permissions are needed to obtain this isolation.

### Maintained files changed

- `packages/database/src/repositories/catalog-repository.ts`
- `packages/database/test/catalog-import.spec.ts`
- `packages/database/test/integration.spec.ts`
- `packages/database/test/identity-integration.spec.ts`
- `packages/database/migrations/004_staff_identity_foundation.ts`
- `packages/database/migrations/README.md`
- `README.md`
- `ARCHITECTURE.md`
- `docs/progress.md`
- `docs/verification.md`
- `docs/project-structure.md`
- `docs/data-model.md`
- `docs/security/requirements.md`
- `docs/security/trust-boundaries.md`
- `docs/adr/0004-transactional-catalog-import.md`
- `docs/adr/0006-brick-3a-staff-authorization-foundation.md`

Builds also regenerated ignored `dist`/`dist-test` outputs. Checkpoint/helper/log/metadata artifacts live outside the project in sibling `recovery-checkpoints`; no Git repository or root `AGENTS.md` was created. The original handover remains a historical read-only snapshot; this recovery record supersedes its unqualified completion evidence.

### Completion and remaining limitations

Bricks 2B and 3A are verified again for local synthetic complete-snapshot import/read and provider-independent staff authorization respectively. Migration 004 is corrected and accepted on disposable PostgreSQL, not applied to development or production. No required test failed or was skipped in the completed runs.

Git installation/version-control setup remains outstanding; the archive is the local recovery point. Existing generated files under provider-contract source were preserved, not cleaned up. RLS uses application-set context; local trust authentication, audit retention/export, deployment secrets, provider identity/lifecycle and production security remain unresolved. Auth0 remains proposed and unconfigured. Bricks 3B and 4 have not started and require their own authorization. Root `AGENTS.md` remains a prior proposal for review.

## Brick 3B-1 isolated verifier acceptance

Date: 11 November 2026, Asia/Dubai. Scope: isolated signed staff access-token foundation only, using synthetic identities and ephemeral library-generated keys. No Auth0 account/resource, live trust setting, guard/controller, staff enrollment, database integration, permission activation, browser login or later brick was implemented.

### Checkpoint and unchanged boundaries

The existing `before-recovery-20261111T070239Z.zip` and every manifest entry were revalidated by SHA-256, with no replacement or deletion. Before coding, a separate reviewed 139-file checkpoint was created at `../recovery-checkpoints/before-brick3b1-20261111T073759Z.zip` (relative to the repository root). Its SHA-256 is `1092f214c71062b0ddf31975c64fc0b44f8815519d5bac06c64e801cde04238a`; its adjacent manifest records all file hashes and exclusions. All archive entries were read back and verified. Environment files, databases/data, private-key files, dependencies, generated outputs and caches were excluded. Credential URL matches remained confined to the previously reviewed synthetic database fixtures.

Git remains unavailable and was not installed. The source checkpoint procedure was used without changing global settings. The first pnpm add attempt encountered the existing-store mismatch. Installation succeeded after approval using the original external pnpm store, without changing its global configuration. `jose` 6.2.17 is pinned exactly in the API package and lockfile, including package integrity; diff review confirmed no unrelated dependency version changed.

The recovery replay COMMIT, failed-target rollback assertion and corrected IAM privilege/default-grant migration remain present. All database/application/domain/provider maintained source files and migrations are unchanged from the new checkpoint. Read-only history inspection after verification confirmed `nukhabapay_dev` at `127.0.0.1:5432` still records only 001_catalog, 002_import_role_privileges and 003_import_role_read_access. No migration or database mutation was performed.

### Implemented security controls

The framework-independent verifier interface and immutable output live in the API identity boundary. Strict configuration requires exact explicit canonical HTTPS issuer/JWKS URLs on one origin, an HTTPS/URN API audience, RS256-only approved algorithms, approved clients, a narrow `rfc9068-staff-v1` profile and a signed namespaced human-principal claim. Only development/test configuration is accepted; there are no fallback trust values or environment-selected synthetic key sources.

`jose.jwtVerify` checks signatures, claims and times; `createRemoteJWKSet` selects/imports trusted keys and caches/coalesces retrieval. Additional validation requires nonnegative integer NumericDates, bounded subject/token ID, proper ordering, nominal lifetime and age <=300 seconds, optional not-before, and <=30 seconds clock tolerance. ID/default-profile tokens, unapproved clients, machine/delegated/agent evidence, unapproved algorithms and token-supplied key/certificate locations reject.

Authorization input is capped at 8192 ASCII bytes including Bearer prefix. Parsing detects duplicate raw headers, array/comma-joined credentials, whitespace including trailing newlines, malformed compact tokens and oversized input. The final verifier returns only exact issuer/subject and frozen allowlisted security evidence; arbitrary claims, email, roles, raw token and token ID are not returned. Unmapped MFA/authentication-time claims do not establish assurance.

Trusted JWKS transport rejects redirects, changed destinations, credentials, non-JSON/error responses and malformed/private/symmetric key material. It bounds transport and streaming by the same abort deadline, key strength to RSA 2048-4096 bits, response to 64 KiB, chunks to 1024 and keys to 32. Cache lifetime, cooldown, failure backoff, timeout and response caps have validated limits. Fresh cached keys can work during an outage; expired/missing trusted material cannot be accepted indefinitely. Unknown keys after successful retrieval are invalid; retrieval/key-material failures report unavailable trust. Errors have fixed codes/messages with no retained underlying cause or network detail.

### Exact commands and completed results

Toolchain: Node v24.22.2, pnpm 10.34.9, TypeScript 6.0.2, CPython 3.13.17, API `jose` 6.2.17. No system software was installed.

| Command | Result |
| --- | --- |
| `pnpm.cmd --filter @nukhabapay/api add jose@6.2.17 --save-exact --store-dir C:\Users\Admin\AppData\Local\pnpm\store` | Passed after store-path approval; exact dependency/lock changes reviewed |
| `node node_modules/typescript/bin/tsc -p tsconfig.test.json` from `apps/api` | Passed after fixture compatibility correction |
| `node --test dist-test/test/identity-config.spec.js dist-test/test/authorization-header.spec.js dist-test/test/access-token-verifier.spec.js` from `apps/api` | 24 passed, 0 failed, 0 skipped |
| `pnpm.cmd api:build` | Passed |
| `pnpm.cmd api:typecheck` | Passed |
| `pnpm.cmd api:test` | Fresh build/test compile: 27 passed, 0 failed, 0 skipped (24 new + existing 3) |
| `pnpm.cmd application:build` | Passed |
| `pnpm.cmd application:typecheck` | Passed |
| `pnpm.cmd application:test` | 11 passed, 0 failed, 0 skipped |
| `pnpm.cmd db:build` | Passed; no connection/migration |
| `pnpm.cmd db:typecheck` | Passed |
| `node packages/database/node_modules/typescript/bin/tsc -p packages/database/tsconfig.test.json` | Passed; compile only |
| `node --test packages/database/dist-test/database/test/config.spec.js` | 4 passed, 0 failed, 0 skipped; no PostgreSQL connection |
| `pnpm.cmd test` | 19 financial/domain/provider tests passed, 0 failed, 0 skipped |
| `pnpm.cmd demo` | Passed: AED 102.00 total, AED 2.77 contribution, executable false |
| `python -B -m unittest discover -s apps/ai-service/tests -v` | 9 methods passed |
| `python -B scripts/check_structure.py` | Passed; 21 JSON files plus public-field and selected import checks |

The final full run used the finished source including newline rejection. Sanitized output and command exit statuses are in sibling `recovery-checkpoints/brick3b1-verification-20261111T080245490Z.log` and `.results.json`; the helper `verify-brick3b1.mjs` runs only the listed non-destructive checks. Documentation-only structure validation was repeated after documentation updates.

### Synthetic test evidence and resolved development failures

The 24 new tests cover valid exact identity/evidence, audience arrays, wrong issuer/audience, ID/Management API token rejection, missing/ill-typed claims, expiry/issuance/not-before ordering and skew boundaries, unapproved clients, non-human/delegated profiles, malformed/oversized/unsigned tokens, HMAC algorithm confusion, malicious key headers and critical extensions, forged signatures, unknown keys/cooldown, overlapping rotation, outage/cache expiry/recovery, removed keys, concurrent fetch coalescing, sanitized errors/failure backoff, malformed/private/ambiguous/oversized key material, aborted transport, separate configured trust, and deterministic deadlines for stalled transport/body streams. Keys exist only in memory. No real issuer was contacted; transport and clocks are injected explicitly in test code.

An initial new test failed because malformed short RSA material reached signature validation and was classified as an invalid bearer token. Explicit public-key parameter checks now classify unusable trust material as unavailable and the unchanged assertion passes. One test-helper compile attempt used Promise.withResolvers beyond the repository's ES2022 type target; the helper was replaced with a compatible deferred promise, preserving the compiler target. Neither issue required weakened assertions or skipped tests. The completed suites above have no failures/skips.

### Not performed and remaining risks

Real Auth0 issuance, discovery, JWKS networking/rotation, user/client configuration, human-claim mapping, MFA/passkeys, recovery, lifecycle and deployed environment isolation are not verified. The actual provider may not emit this narrow profile until approved configuration exists. A signed human claim still needs validated provider issuance policy; it is not local staff membership. Assurance is deliberately not established. Runtime discovery is not implemented; exact trust locations must later be approved from genuine metadata.

No PostgreSQL integration/disposable-database acceptance was run because those harnesses create/drop databases. Their previous recovery evidence remains historical. No migration 004 application, protected HTTP authentication, IAM-context wiring, production authentication or end-to-end tenant authorization claim is made. The running API is liveness-only. The verifier has no enrollment or grant writes.

Fresh cached keys remain trusted for their bounded lifetime; emergency invalidation, rate limits, DNS/egress controls, deployment secrets and operational ownership remain future gates. HTTPS/host validation does not pin DNS or defend a compromised configured issuer. Constructor injection cannot be selected by a token or environment setting and is not wired to deployed routes.

Brick 3B-1 is complete for the authorized local synthetic verifier foundation. Proposed next bounded increment, requiring separate approval: restricted IAM runtime configuration and internal verified-identity/context integration with existing Brick 3A, keeping permissions inactive and adding no business route. No Brick 3B-2, 3C or 4 work was started.

### Exact maintained files created or modified in Brick 3B-1

Created:

- `apps/api/src/modules/identity/access-token-verifier.ts`
- `apps/api/src/modules/identity/authorization-header.ts`
- `apps/api/src/modules/identity/identity.config.ts`
- `apps/api/src/modules/identity/oidc-access-token.verifier.ts`
- `apps/api/src/modules/identity/trusted-jwks.ts`
- `apps/api/test/access-token-verifier.spec.ts`
- `apps/api/test/authorization-header.spec.ts`
- `apps/api/test/fixtures/oidc-test-issuer.ts`
- `apps/api/test/identity-config.spec.ts`
- `docs/adr/0007-staff-access-token-verification-foundation.md`
- `docs/governance/pending-management-approvals.md`

Modified:

- `ARCHITECTURE.md`
- `README.md`
- `apps/api/package.json`
- `apps/api/src/modules/identity/README.md`
- `docs/adr/0005-trusted-identity-provider.md`
- `docs/build-sequence.md`
- `docs/progress.md`
- `docs/project-structure.md`
- `docs/security/requirements.md`
- `docs/verification.md`
- `pnpm-lock.yaml`

Builds refreshed ignored output directories; the checkpoint/helper/log artifacts are outside the repository in sibling `recovery-checkpoints`. No file was deleted.

The externally supplied `docs/governance.md` appeared during final review, was read and preserved without edits, and is not an agent-authored file. Its management-register/progress-note requirements were documented without expanding coding scope or granting approvals. The register marks all unresolved management decisions PENDING.

## Brick 3B-2 restricted IAM and internal identity acceptance

Date: 11 November 2026, Asia/Dubai. Scope: restricted IAM runtime initialization and internal verified-identity integration with the existing Brick 3A policy. Only synthetic staff/token identities and ephemeral signing keys were used. No Auth0 setup, real staff onboarding, browser login, guard/controller, business endpoint, reserved-permission activation, production/shared database change or later brick occurred.

### Checkpoint and package review

Existing recovery/3B-1 archive entries and archive SHA-256 values were verified and preserved. Before editing, 151 reviewed maintained files were saved to `../recovery-checkpoints/before-brick3b2-20261111T082312Z.zip` with an adjacent manifest (paths relative to repository root). SHA-256: `af54a7d6e76abf079f206a0b2b8b535f9d4571c14eb7d628402b5346de165bca`. Every included archive entry was read back and checked. Environment/data/key/dependency/generated/cache artifacts were excluded; credential URL matches were confined to previously reviewed synthetic fixtures. Git remains unavailable and was not installed. No backup was replaced or deleted.

Compiled application/database entry points and local workspace links were added for strict package integration. The API uses application at runtime and database/pg only for test infrastructure in this increment. `pg` and its types use the already existing exact 8.23.1 version; `jose` remains exactly 6.2.17. Offline installation/linking used the existing store after approval, with scripts disabled and no downloads. Lockfile package/snapshot sections are byte-identical to the checkpoint; only importer/workspace links changed. Root API builds and API test commands now build their dependencies before compilation.

### Implemented functionality and safeguards

- The IAM-only parser reads only reader/writer URLs, optional canonical role names and IAM pool settings. It does not read migration, importer, catalogue runtime or test-admin credentials. It compares exact loopback host, effective port (including omitted/default 5432), database and workload role, rejects system databases/options/invalid values and bounds pools/timeouts. URLs are hidden from ordinary JSON/inspection; errors contain names only, not values or retained causes.
- Explicit async runtime initialization verifies the actual login identity, LOGIN/no-superuser/no-createdb/no-createrole/no-inherit/no-BYPASSRLS flags, absence of role memberships, schema-CREATE and database ownership. It creates only restricted pools/repositories, closes them on initialization failure and provides idempotent shutdown. Startup checks do not claim full ongoing ACL monitoring; effective IAM grants/RLS are tested separately.
- The shared opaque verified identity contract is attested by the existing verifier after cryptographic/profile validation. A nominal symbol, immutable allowlisted fields and process-local provenance check prevent structural/JSON clones entering authorization as verified identity. The trusted attestation factory is not token verification and must not be called with unverified request claims. It is not a defense against malicious trusted code or proof that can be serialized across processes.
- The internal bridge verifies raw-header credentials and calls `readAuthorizedStaffSelf`. It registers no route or pool in bootstrap. The operation uses current exact issuer/subject staff resolution on every call; no email linking, enrollment or positive authorization cache exists. Requested tenant summaries require active matching server-side membership and object scope. Missing permissions, expired/revoked grants, inactive reserved permissions and platform-to-tenant inheritance remain denied.
- Only self read may succeed, with a final operation-specific gate in addition to the existing policy. Department roles are not needed to read one's own active identity; revoking a department role does not itself suspend that self permission. A tenant summary still requires active membership. Output is minimal frozen staff ID/authz version and optional own membership IDs/version, with no bearer/email/role or arbitrary claim data.
- Success requires a committed audit append before output. Reader failure and required allow-audit failure throw sanitized unavailable errors. A denied request stays denied if audit is unavailable, returning only a bounded failure flag for future operational telemetry. Existing audit vocabularies, append-only behavior, tenant RLS and separate workload roles are unchanged. This read operation does not implement atomic authorization for a future privileged write.

### Commands and actual completed results

Toolchain: Node v24.22.2, pnpm 10.34.9, TypeScript 6.0.2, Python 3.13.17, existing loopback PostgreSQL 17.11. Required test configuration was provided only in child-process environment; random nonfunctional password values satisfy the URL parser on the existing unchanged local trust-authenticated cluster. No values or complete database URLs were logged or persisted.

| Command | Actual result |
| --- | --- |
| `pnpm.cmd install --offline --ignore-scripts --store-dir C:\Users\Admin\AppData\Local\pnpm\store` | Passed for local workspace/test links; no downloads/version upgrades/global setting changes |
| `pnpm.cmd application:build` | Passed |
| `pnpm.cmd application:typecheck` | Passed |
| `pnpm.cmd application:test` | 18 passed, 0 failed, 0 skipped |
| `pnpm.cmd db:build` | Passed |
| `pnpm.cmd db:typecheck` | Passed |
| `node packages/database/node_modules/typescript/bin/tsc -p packages/database/tsconfig.test.json` | Passed |
| `node --test --test-concurrency=1 packages/database/dist-test/database/test/*.spec.js` | 15 passed, 0 failed, 0 skipped; full existing catalogue/IAM acceptance plus four new parser tests |
| `pnpm.cmd api:build` | Passed with compiled dependency build order |
| `pnpm.cmd api:typecheck` | Passed |
| `pnpm.cmd api:test` | 27 passed, 0 failed, 0 skipped; all existing 24 verifier tests and three API tests retained |
| `pnpm.cmd --filter @nukhabapay/api test:identity:integration` | 10 passed, 0 failed, 0 skipped (parent plus nine subtests), using real restricted PostgreSQL connections and synthetic signed tokens |
| `pnpm.cmd test` | 19 passed, 0 failed, 0 skipped |
| `pnpm.cmd demo` | Passed: AED 102.00 total, AED 2.77 contribution, executable false |
| `python -B -m unittest discover -s apps/ai-service/tests -v` | 9 test methods passed |
| `python -B scripts/check_structure.py` | Passed; 21 JSON files plus public-field/selected import checks |

The ordinary API suite remains non-destructive. The separate identity integration command requires its explicit fixture configuration and has no skip fallback. Database `test` and `test:integration` still have identical compile/run bodies; the full compiled database suite was executed directly with serialized test files to bound database activity. No assertions were disabled or skipped. Documentation-only structure validation was repeated after documentation updates.

Sanitized logs, exit statuses and pre/post metadata are in sibling `recovery-checkpoints/brick3b2-verification-20261111T083942141Z.log`, `.results.json`, `.before.json` and `.after.json`. The local helper `verify-brick3b2.mjs` constructs process-only test configuration, rejects any skipped required suite and compares database history/inventory around execution.

### Actual database targets and privilege evidence

All database acceptance targeted the verified existing PostgreSQL 17.11 loopback cluster at `127.0.0.1:5432`. Maintenance database `postgres` was used only for disposable lifecycle/role inspection. `nukhabapay_dev` was inspected only using read-only metadata transactions; history before/after is exactly 001_catalog, 002_import_role_privileges, 003_import_role_read_access. No migration 004, fixture write or application operation targeted development.

The new passing integration target was `nukhabapay_b3b2_cf727cc46a6a4ab0b55a4579af665455`. Its initial development-test target was `nukhabapay_b3b2_68a624918eeb4230871da1a755b4f0f8`. Both were generated by this fixture and dropped after connections closed and ownership/session checks passed. Existing regression harnesses additionally used their generated `nukhabapay_i_`, `nukhabapay_cli_`, `nukhabapay_r_`, `nukhabapay_iam_`, `nukhabapay_db_` and `nukhabapay_fail_` targets; those harnesses do not log individual generated names. No name is inferred as a developer-data cleanup target.

Before and after the completed run, the entire database list was unchanged: `nukhabapay_dev`, `postgres`, `template0`, `template1`. No disposable database remained, including after the initial new-test failure. Migrator credentials were used only for disposable migrations/metadata; the test administrator seeded synthetic fixtures because forced RLS also constrains owners. Ordinary operations used only IAM reader/writer.

The new end-to-end scenarios proved active exact-bound identities, unknown/case-mismatched/alternate-issuer/suspended/disabled identities, no enrollment, inactive/revoked/absent membership, cross-tenant denial, expired/revoked grants, missing/reserved permission denial, platform non-inheritance, immediate next-call suspension visibility with the same credential, rejected identity clones/invalid tokens and committed audit before success. Reader/writer unavailability was simulated by closing a separately initialized runtime's actual pools on the disposable target, while the counterpart restricted component remained usable; this is not a production outage/restart drill. No successful output or allow audit occurred when the required writer was unavailable; already-denied identities remained denied with audit failure flagged.

Catalogue runtime/importer reads failed on all nine IAM tables. Explicit ACL queries separately confirmed no catalogue DELETE or product UPDATE capability; actual writes remained rejected. Runtime's read-only session setting is an additional restriction, not a substitute for ACL checks. Importer snapshot/offer insertion and completion-column updates remained granted. Actual IAM reader denied contact-email access, writer denied reads and staff changes, all three forced-RLS flags remained true, and missing tenant context read no membership rows. Full prior database acceptance retained exact column rights, tenant/pool cleanup, append-only audit/rollback, catalogue replay/concurrency/history and failed-migration target checks.

### Resolved development checks

An initial compile caught a test fixture explicitly setting an optional permission to undefined under exactOptionalPropertyTypes. The missing-field fixture now omits the property, preserving compiler strictness. The first new integration run passed the identity/audit scenarios but expected permission-denied SQLSTATE 42501 for a catalogue-runtime write that PostgreSQL rejected earlier as read-only SQLSTATE 25006. The new assertion now requires the exact intended read-only code for runtime, permission-denied code for importer, and independently checks both underlying ACL denials. No authentication setting, database grant or existing assertion was weakened to accommodate the test. The fixture was cleaned up and the full completed run passed.

### Completion, remaining limits and approvals

Brick 3B-2 is complete for restricted local IAM runtime and internal synthetic verification/authorization only. All migrations, the permission catalogue, original policy evaluator, financial/provider source and running API bootstrap/routes remain byte-identical to the checkpoint. No production/shared database or external identity service was modified.

The real provider, signed human-claim issuance, assurance, onboarding, region/residency/commercial requirements, operations/monitoring, secret handling, production authentication and any non-disposable migration remain PENDING in the management register. Loopback trust authentication is unchanged; RLS still uses application-set transaction-local tenant context, not protection against a compromised trusted application. The attestation factory is trusted-code infrastructure, not a cryptographic sandbox. Audit denial flags have no deployed alert consumer, and authorization for future sensitive writes needs its own transaction/consistency design.

No Brick 3B-3, 3C or 4 work was started. Another bounded authorization is required before the next increment; no external setup or live token acceptance is implied by these results.

### Exact maintained files changed in Brick 3B-2

Created:

- `apps/api/src/modules/identity/internal-staff-access.ts`
- `apps/api/test/fixtures/disposable-iam-database.ts`
- `apps/api/test/internal-staff-access.integration.ts`
- `docs/adr/0008-internal-verified-staff-authorization.md`
- `packages/application/src/identity/read-authorized-staff-self.ts`
- `packages/application/src/identity/verified-staff-identity.ts`
- `packages/application/test/verified-staff-self.test.ts`
- `packages/database/src/identity-runtime.config.ts`
- `packages/database/src/identity-runtime.ts`
- `packages/database/test/identity-runtime-config.spec.ts`

Modified:

- `ARCHITECTURE.md`
- `README.md`
- `apps/api/package.json`
- `apps/api/src/modules/identity/README.md`
- `apps/api/src/modules/identity/access-token-verifier.ts`
- `apps/api/src/modules/identity/oidc-access-token.verifier.ts`
- `docs/adr/0007-staff-access-token-verification-foundation.md`
- `docs/build-sequence.md`
- `docs/governance/pending-management-approvals.md`
- `docs/progress.md`
- `docs/project-structure.md`
- `docs/security/requirements.md`
- `docs/verification.md`
- `package.json`
- `packages/application/README.md`
- `packages/application/package.json`
- `packages/application/src/index.ts`
- `packages/database/README.md`
- `packages/database/package.json`
- `packages/database/src/pool.ts`
- `pnpm-lock.yaml`

No maintained file was deleted. Existing test files, migrations, database roles, financial/provider source, original staff policy/permission catalogue, API bootstrap/routes and supplied governance policy were preserved. Builds refreshed ignored compiled artifacts; checkpoint/helper/log/metadata files are in the sibling `recovery-checkpoints` directory.

## Brick 3B-3 global HTTP guard acceptance

Date: 11 November 2026, Asia/Dubai. Scope: global staff authentication/authorization guards and internal test-only HTTP acceptance. Synthetic staff identities, in-memory ephemeral signing keys and explicitly verified disposable PostgreSQL targets only. No real Auth0/external resource, browser login, deployed staff/business endpoint, permission activation, non-disposable migration, production/shared database or live financial operation was added. Stop after this increment.

### Checkpoint and existing-work review

No applicable AGENTS.md was found in this repository or its ancestors. Current ADRs, security requirements, governance/register, latest progress/verification and the existing verifier/IAM/bootstrap/tests were reviewed. The catalogue replay COMMIT, actual-target failed-migration rollback check and corrected pending migration 004 default/explicit grants remain present; their full PostgreSQL acceptance passed again.

Git remains unavailable with no enclosing Git metadata. No software was installed or repository published. Previous archives and every entry hash were verified before coding and preserved. A new reviewed 161-file checkpoint was written and read back before changes: `../recovery-checkpoints/before-brick3b3-20261111T090947Z.zip`, adjacent `.manifest.json`, SHA-256 `ae1513b9c295bab6ac2a0e6015f27e149d6d7af6f6d2be78e62cc9a16812a89f`. Environment files including the template, data/database/key material, dependencies, caches and generated outputs were excluded; pre-existing URL-pattern hits were limited to reviewed synthetic configuration fixtures. No backup was overwritten or removed.

### Implementation and security evidence

- The common Nest factory installs authentication followed by authorization globally. It accepts trusted-code dependencies only; no environment flag selects an acceptance module or authentication bypass. Default startup configures no verifier/pools and registers only the unchanged production HealthController. Added protected handlers fail closed without required services.
- Public exemption requires the exact reviewed health class/handler, exact `/health/live` path and GET. A public decorator alone is insufficient. Express strict/case-sensitive routing is configured before adapter construction. Health aliases, HEAD, OPTIONS, alternate methods and method-override headers cannot obtain public/protected GET authority. Unmatched paths return generic 404 without echoing a path/query.
- Authentication consumes the original raw header pairs, reuses the existing bounded Bearer parser and actual jose verifier, and requires original opaque identity provenance. No duplicate JWT cryptography or trust from unverified claims is added. Missing/invalid/unapproved credentials produce generic 401 with a Bearer challenge; verifier/required-JWKS failure produces sanitized 503.
- Method-level explicit permission/scope/GET metadata is required. Missing metadata uses the unchanged policy with no permission and denies; inactive reserved permissions and platform overrides remain denied. Only `staff.self.read` can pass the existing application gate. Private per-request WeakMaps carry verified identity and committed-audit result, never client-supplied req.user/identity/tenant claims.
- Current exact issuer/subject lookup, active staff/binding/membership, matching object scope and grant lifecycle checks remain fresh on every request. Same-token committed staff suspension and membership suspension/revocation deny on the next request. Unknown/case-mismatched/pending/suspended/disabled identities do not enroll or link by email. Cross-tenant HTTP tests supply two active memberships plus spoofed tenant/permission claims, with object ownership fixed independently by trusted test application logic; access still denies.
- Successful HTTP handlers run only after audit commit through the restricted writer. Real closed reader/writer pools return sanitized 503, never successful data or an allow audit. Already-denied identities remain 403 when auditing fails, with a fixed warning and no private detail. Existing policy/audit vocabularies and transactions are unchanged.
- The test controller is only under `test/fixtures` and registered only by test bootstrap; production compilation excludes it. Protected output contains only self ID/authz version and optional own membership IDs/version, with bigint versions serialized as decimal strings. Error responses and captured framework/application logs are tested against every generated token plus private identity/dependency sentinels. No-store, JSON size/compression limits, header cap and HTTP timeouts are preserved.

### Exact commands and actual completed results

Toolchain unchanged: Node v24.22.2, pnpm 10.34.9, NestJS 12.4.2, TypeScript 6.0.2, Python 3.13.17 and loopback PostgreSQL 17.11. No dependency version, lockfile or installation changed. Test database configuration was constructed in child-process memory only, using random nonfunctional password fields on the existing unchanged local trust-authenticated cluster. Credentials/full URLs/raw tokens were not persisted or printed.

The complete sequence was run by `node ../recovery-checkpoints/verify-brick3b3.mjs`, which records redacted output/exit statuses and compares read-only development history/inventory before and after:

| Command | Actual result |
| --- | --- |
| `pnpm.cmd application:build` | Passed |
| `pnpm.cmd application:typecheck` | Passed |
| `pnpm.cmd application:test` | 18 passed, 0 failed, 0 skipped |
| `pnpm.cmd db:build` | Passed |
| `pnpm.cmd db:typecheck` | Passed |
| `node packages/database/node_modules/typescript/bin/tsc -p packages/database/tsconfig.test.json` | Passed |
| `node --test --test-concurrency=1 packages/database/dist-test/database/test/*.spec.js` | 15 passed, 0 failed, 0 skipped; full catalogue/IAM acceptance |
| `pnpm.cmd api:build` | Passed; production output excludes acceptance controllers |
| `pnpm.cmd api:typecheck` | Passed |
| `pnpm.cmd api:test` | 40 passed, 0 failed, 0 skipped: existing 27 including all 24 verifier tests plus 13 new HTTP guard cases (parent/subtests included) |
| `pnpm.cmd --filter @nukhabapay/api test:identity:integration` | 21 passed, 0 failed, 0 skipped: existing 10 internal plus 11 test-only HTTP PostgreSQL cases (parent/subtests included) |
| `pnpm.cmd test` | 19 domain/financial/provider tests passed, 0 failed, 0 skipped |
| `pnpm.cmd demo` | Passed: AED 102.00 total, AED 2.77 contribution, executable false |
| `python -B -m unittest discover -s apps/ai-service/tests -v` | 9 test methods passed |
| `python -B scripts/check_structure.py` | Passed; 21 JSON files plus public-field/selected import checks |

Ordinary API tests remain non-destructive. The explicit identity integration script now serializes its two files and requires reviewed fixture configuration; there is no skip fallback. Full database acceptance was compiled/run directly with serialized files, using the unchanged database test bodies. All existing assertions remain; the shared disposable IAM fixture only adds a validated `b3b3` prefix alongside `b3b2`, retaining target/role/owner/session guards. No test was disabled or skipped.

The completed redacted log is `../recovery-checkpoints/brick3b3-verification-20261111T092302774Z.log`, with `.results.json`, `.before.json` and `.after.json`. The separate helper and these artifacts preserve earlier recovery/verification files. Final maintained-file/checkpoint comparison and documentation structure validation were also performed after documentation changes using `python -B ../recovery-checkpoints/review-brick3b3.py` and `python -B scripts/check_structure.py`.

### Actual database targets and privilege verification

All acceptance used the verified existing local PostgreSQL 17.11 cluster at `127.0.0.1:5432`. The maintenance database `postgres` was used for lifecycle/role inspection only; ordinary IAM work used separate restricted reader/writer logins. The test administrator seeded only generated disposable fixtures, and migration credentials applied 001–004 only to those generated databases.

Passing internal/HTTP targets:

- `nukhabapay_b3b2_a69728a0dbd44c829f906774dcc91b47`
- `nukhabapay_b3b3_3f015a89a0cd4bae9306acf726d164ac`

The first development-test run used `nukhabapay_b3b2_25bcfc14552048cdace60e4c7ce06ee4` and `nukhabapay_b3b3_8816792d680a453d82492fd87c9e4382`. Every one was closed and dropped by its owning fixture after generated-name/ownership/session checks. Existing full database harnesses also used their own generated `nukhabapay_i_`, `nukhabapay_cli_`, `nukhabapay_r_`, `nukhabapay_iam_`, `nukhabapay_db_` and `nukhabapay_fail_` targets; those unchanged harnesses do not print each individual generated name. No unrelated database was a cleanup target.

The pre/post database inventory is exactly `nukhabapay_dev`, `postgres`, `template0`, `template1`. Development was inspected only in read-only metadata transactions. Its actual history remains exactly `001_catalog`, `002_import_role_privileges`, `003_import_role_read_access`; migration 004 remains unapplied. No test fixture or application write targeted development.

Actual-role regression confirms catalogue runtime/importer cannot read any of the nine IAM tables; importer snapshot/offer INSERT and completion-column UPDATE remain available with no DELETE/product-UPDATE expansion. IAM reader remains column-limited and cannot read staff contact email; audit writer cannot read IAM/audit data or mutate staff/grants and retains only intended audit INSERT rights. All three forced-RLS flags, no-context denial, tenant/pool isolation, append-only audit/rollback and absence of unintended migrator default grants remain verified by the full unchanged database acceptance. Catalogue replay/concurrency/history, post-write rollback and failed-migration actual-target assertions pass.

Reader/writer outages were simulated using closed actual restricted pools against the disposable target, with the counterpart component still available. Required JWKS outages used an uncached verifier and synthetic failed transport. No real PostgreSQL shutdown, production failover or real provider outage was performed. Existing deterministic verifier tests retain signing-key rotation, overlap/removal, fresh-cache/expired-cache behavior, invalid key material, deadline/backoff and algorithm-confusion coverage.

### Resolved development failures

Initial test compilation caught an incorrect test-fixture import path and explicit undefined optional subject under strict exactOptionalPropertyTypes. These fixtures were corrected without changing compiler options. The first isolated HTTP run reported two failed subtests (three failures counting their parent): Express had already initialized its router before strict/case settings were applied, and the raw duplicate-header fixture omitted the HTTP Host header, causing Node to reject it before the guards. The application now configures Express before adapter construction; the fixture sends Host so it verifies guard-level duplicate rejection. Assertions were retained.

The initial integration run passed 19/21 including its internal parent but failed the new success-version assertion (and its parent): migration 004 defaults authz_version to zero while the fixture assumed one. The fixture now explicitly seeds a non-default version seven and requires exactly that server-returned value. This strengthens the intended mapping check without changing database/application behavior. Both initial disposable databases were cleaned up. The complete final run above passed with no failures, cancellations or skips; no current test blocker remains.

### Completion, remaining risks and approvals

Brick 3B-3 is complete only for the authorized local guards/test-only HTTP scope. Checkpoint comparison preserves all application/database source, migrations, original verifier and tests (apart from the bounded fixture-prefix extension), permission catalogue, financial/provider code, lockfile, AppModule/main and supplied governance policy. No maintained file was deleted; production output contains no acceptance controller. Builds refreshed ignored outputs only.

Real Auth0 trust/profile issuance, MFA/assurance, onboarding and runtime activation are unverified/unconfigured. Region/residency/commercial terms, operational ownership, environment separation, token/key/recovery objectives, non-disposable migration target/execution, network/secrets/TLS/rate controls, monitoring/audit retention/export and financial approvals remain PENDING in the register. Fresh cached signing keys retain the previous bounded acceptance during an outage; emergency invalidation is not implemented. Local PostgreSQL trust is unchanged; application-set tenant GUC/provenance factories do not defend against a compromised trusted application. Separate lookup/audit transactions do not serialize a future sensitive write against concurrent revocation. No production load, independent security assessment or actual-provider acceptance was performed.

Proposed next bounded work: a read-only activation/approval package naming the exact non-production provider profile, IAM database target/migration process and accountable owners. Actual runtime activation, new endpoints or another brick requires separate authorization. No Brick 3C/4 or external setup is started.

### Exact maintained files changed in Brick 3B-3

Created:

- `apps/api/src/modules/identity/authentication.guard.ts`
- `apps/api/src/modules/identity/authorization.guard.ts`
- `apps/api/src/modules/identity/identity-boundary.ts`
- `apps/api/src/modules/identity/reviewed-public-route.ts`
- `apps/api/src/modules/identity/route-security.ts`
- `apps/api/src/modules/identity/staff-request-context.ts`
- `apps/api/test/fixtures/staff-http-acceptance.ts`
- `apps/api/test/identity-guards.spec.ts`
- `apps/api/test/staff-http.integration.ts`
- `docs/adr/0009-global-staff-http-guards.md`

Modified:

- `ARCHITECTURE.md`
- `README.md`
- `apps/api/README.md`
- `apps/api/package.json`
- `apps/api/src/health.controller.ts`
- `apps/api/src/http-application.ts`
- `apps/api/src/modules/identity/README.md`
- `apps/api/src/safe-exception.filter.ts`
- `apps/api/test/fixtures/disposable-iam-database.ts`
- `docs/adr/0005-trusted-identity-provider.md`
- `docs/adr/0007-staff-access-token-verification-foundation.md`
- `docs/adr/0008-internal-verified-staff-authorization.md`
- `docs/build-sequence.md`
- `docs/governance/pending-management-approvals.md`
- `docs/progress.md`
- `docs/project-structure.md`
- `docs/security/requirements.md`
- `docs/security/trust-boundaries.md`
- `docs/verification.md`

The separate `verify-brick3b3.mjs` and `review-brick3b3.py` helpers, reviewed checkpoint/manifest and redacted test/metadata artifacts are local recovery evidence outside the repository. All older backups/artifacts are preserved. No root AGENTS.md, environment value, dependency installation or external resource was added.

## Local synthetic runtime lifecycle acceptance

Date: 11 November 2026, Asia/Dubai. Separately authorized after the Brick 3B-4 read-only operational review, which was delivered in conversation without documentation writes. Scope: explicit synthetic verifier/IAM/guard composition, strict startup, internal readiness, graceful cleanup and local recovery tests only. ADR 0010 records the design. No external provider, real staff, deployed protected/readiness route, reserved permission, existing-database migration, browser/later brick or financial execution is added.

### Checkpoint, isolation and implementation

Current instructions, governance/register, ADRs, progress/verification, security requirements and existing implementation/tests were inspected. No applicable AGENTS.md or enclosing Git metadata was found; Git is unavailable and was not installed. Earlier archives and every entry hash were verified/preserved. Before source changes, 171 reviewed maintained files were archived and read back: `../recovery-checkpoints/before-local-runtime-20261111T094917Z.zip`, adjacent manifest, SHA-256 `5792942f309cdaf53f894e2f3f2e23140b8d8678a89cfe84d179b72e4f3e5a33`. Environment/template, data/key/database, dependency/generated/cache files were excluded. The scan stopped on an additional pre-existing synthetic IAM configuration test; its generated in-memory test URLs were reviewed before inclusion. Only the three reviewed synthetic configuration/debug files contained URL-pattern hits. No credential/full URL was printed or backup replaced.

The new lifecycle factory validates `API_STAFF_AUTH_MODE`, listener and existing identity/IAM parsers. Default disabled rejects defined identity settings and opens no resources. Enabled local-synthetic requires loopback, `.invalid` issuer and injected synthetic JWKS transport; CLI configuration alone cannot activate authentication or connect a real provider. Only allowlisted restricted IAM fields reach its factory; proxy tests forbid migration/importer/catalogue/admin credential access. Database moves to an API runtime workspace dependency; the existing workspace link and all versions are reused, with no install/download. Lockfile package/snapshot content is unchanged.

Enabled dependencies must pass readiness before app initialization/listening. Internal coalesced boolean-only checks use bounded public-key validation and actual restricted role/schema/column/INSERT/RLS checks without staff rows or audit writes. Status is recomputed, never authorization authority; disabled readiness concerns its empty dependency set only. Existing required audit/policy checks remain per request. Startup errors discard raw configuration/causes; CLI logs a fixed message.

Nest hooks stop new verification, cancel active JWKS transport/body work, drain HTTP and close IAM pools. Direct and managed close are tested; repeated/concurrent managed close releases resources once. Listener failure cleans actual pools and restores signal listener counts. Lost idle reader connections reconnect; closed pools require a new runtime. No readiness HTTP route or background timer is created. Startup readiness is not exhaustive continuous ACL inspection, migration-history proof or future audit durability assurance. Native Windows signal delivery and service-manager shutdown are not tested.

### Exact commands and completed results

Toolchain remains Node v24.22.2, pnpm 10.34.9, TypeScript 6.0.2, Python 3.13.17 and loopback PostgreSQL 17.11. The separate helper `node ../recovery-checkpoints/verify-local-runtime.mjs` constructs child-process-only test configuration using random nonfunctional password fields for the existing local trust-authenticated cluster. Output is redacted; no secrets/full URLs/tokens are persisted. All required test suites ran without skip fallbacks.

| Command | Actual result |
| --- | --- |
| `pnpm.cmd application:build` | Passed |
| `pnpm.cmd application:typecheck` | Passed |
| `pnpm.cmd application:test` | 18 passed, 0 failed/skipped |
| `pnpm.cmd db:build` | Passed |
| `pnpm.cmd db:typecheck` | Passed |
| `node packages/database/node_modules/typescript/bin/tsc -p packages/database/tsconfig.test.json` | Passed |
| `node --test --test-concurrency=1 packages/database/dist-test/database/test/*.spec.js` | 15 passed, 0 failed/skipped; full catalogue/IAM acceptance |
| `pnpm.cmd api:build` | Passed; no acceptance controller in production output |
| `pnpm.cmd api:typecheck` | Passed |
| `pnpm.cmd api:test` | 44 passed, 0 failed/skipped: previous 40 including all 24 verifier tests, plus four lifecycle tests |
| `pnpm.cmd --filter @nukhabapay/api test:identity:integration` | 29 passed, 0 failed/skipped: previous 21 plus eight lifecycle parent/subtests |
| `pnpm.cmd test` | 19 financial/domain/provider tests passed, 0 failed/skipped |
| `pnpm.cmd demo` | Passed: AED 102.00 total, AED 2.77 contribution, executable false |
| `python -B -m unittest discover -s apps/ai-service/tests -v` | 9 test methods passed |
| `python -B scripts/check_structure.py` | Passed; 21 JSON files and selected public-field/import checks |

An isolated `node --test apps/api/dist-test/test/local-api-runtime.spec.js` passed 4/4. The integration-only helper rerun passed 29/29 before the complete sequence. No assertion was removed, weakened or skipped; previous test source remains byte-identical. Documentation-only structure validation and final checkpoint/file comparison followed the completed run.

Complete redacted evidence: `../recovery-checkpoints/local-runtime-verification-20261111T100034301Z.log`, `.results.json`, `.before.json`, `.after.json`. Earlier failed/successful integration trial artifacts and all prior backups remain preserved. No dependency installation, authentication setting or global system setting changed.

### Actual targets, failure/recovery and privileges

All database work used the verified PostgreSQL 17.11 loopback cluster at `127.0.0.1:5432`. Development was inspected only in read-only metadata transactions as the migrator. Actual pre/post history is exactly 001_catalog, 002_import_role_privileges, 003_import_role_read_access. Migration 004 remains unapplied. Database inventory before/after is exactly nukhabapay_dev, postgres, template0, template1; no disposable database remains. Maintenance postgres serves fixture lifecycle/role inspection only.

Full-run targets:

- Internal IAM: `nukhabapay_b3b2_89d452ca4238468e8bef39030df73dd2`
- New lifecycle: `nukhabapay_b3b3_79dbca483e3c43c2896c9f9529cba186`
- Existing HTTP: `nukhabapay_b3b3_e0bb657799564379a56fdeeea9c3829e`

The successful integration-only run used b3b2_786bf48c95c5404791da287142a8b8f5, lifecycle b3b3_a79b6c5825134dc6a2d868fc107eeed7 and HTTP b3b3_41b9a6aae9f4456d85ad8e264a2f9529 (each prefixed `nukhabapay_`). The initial trial used b3b2_9096ec88b769451e8cfb435ada613084, lifecycle b3b3_0db1d75183ad4eb5afbdcd9d6da42bc7 and HTTP b3b3_1071cf44804e4878986d58d54c858527 with the same prefix. All were owned/generated/cleaned by their fixture. Existing database harnesses used their own generated targets; those unchanged harnesses do not print individual names.

New acceptance proves failed JWKS startup releases both actual pools; missing IAM schema rejects without migration; writer CONNECT denial after reader startup releases the connected counterpart; a verified nonexistent database remains absent; listener conflict cleans pools and removes signal hooks; real crypto-to-guard-to-IAM self access commits audit; terminated idle reader reconnects on bounded subsequent probes; closed IAM denies protected HTTP with 503 while health stays live; restart recovers. Each case checks session cleanup; final fixture cleanup checks zero target sessions before dropping only its generated database.

Schema rename/restore, temporary CONNECT revoke/restore and reader backend termination occur only on the verified generated lifecycle target. No cluster role or development grant is changed. Ordinary operations use only separate IAM reader/writer; administrator credentials seed/alter disposable fixtures, migration credentials apply 001–004 only there. Expected idle-connection termination produces only the existing fixed sanitized warning, not a test failure.

Full regressions retain catalogue-role denial on all IAM tables, exact restricted IAM column/writer rights, importer restrictions, forced RLS/context cleanup, absence of unintended default grants, immutable audit/rollback, catalogue replay lock cleanup/concurrency/history and failed-migration actual-target checks. No migration, role provisioning, permission catalogue, financial calculation or previous test assertion changed.

### Resolved failures, completion and remaining risks

Initial strict compilation rejected a test factory typed as the concrete PostgreSQL repositories and a fixture map indexed without an explicit record type. The lifecycle boundary now depends on existing application ports and the fixture has a precise map type; no compiler settings were relaxed. The first integration trial failed one parent before lifecycle subtests because synthetic staff seeding omitted required contact_email. Adding a synthetic `.invalid` address corrected fixture data without changing schema/assertions. Existing 21 internal/HTTP tests passed in that trial; the fixture was cleaned. The final complete run has zero failures, cancellations or skips.

This local lifecycle increment is complete. AppModule/controller registration, application/domain/provider source, migrations, role provisioning, catalogue recovery and all previous tests remain preserved. Real provider issuance/MFA/assurance, production/remote configuration, real staff bootstrap write/audit path, secret/network/TLS controls, monitoring/retention, emergency key invalidation, backup/restore and non-disposable migration remain PENDING. Cached keys retain the prior bounded outage policy. Local trust and application-set tenant context are not production isolation. No production load/failover/restore drill or real Auth0 integration was performed.

Proposed next bounded increment: local synthetic bootstrap/suspension and audit design/acceptance specification, under separate authorization and with no provisioning or deployed route expansion. Stop here; no Brick 3C/4 or financial execution is started.

### Exact maintained files changed in the local lifecycle increment

Created:

- `apps/api/src/local-api-runtime.ts`
- `apps/api/test/local-api-runtime.integration.ts`
- `apps/api/test/local-api-runtime.spec.ts`
- `docs/adr/0010-local-synthetic-runtime-lifecycle.md`

Modified:

- `ARCHITECTURE.md`
- `README.md`
- `apps/api/README.md`
- `apps/api/package.json`
- `apps/api/src/http-application.ts`
- `apps/api/src/main.ts`
- `apps/api/src/modules/identity/README.md`
- `apps/api/src/modules/identity/oidc-access-token.verifier.ts`
- `apps/api/src/modules/identity/trusted-jwks.ts`
- `docs/adr/0009-global-staff-http-guards.md`
- `docs/build-sequence.md`
- `docs/governance/pending-management-approvals.md`
- `docs/progress.md`
- `docs/project-structure.md`
- `docs/security/requirements.md`
- `docs/verification.md`
- `packages/database/README.md`
- `packages/database/src/identity-runtime.ts`
- `pnpm-lock.yaml`

Final review command: `python -B ../recovery-checkpoints/review-local-runtime.py`. It confirms four created/19 modified/no deleted maintained files; all previous tests, migrations/role scripts, application/domain/provider boundaries, catalogue repository and supplied governance remain byte-identical. The original cryptographic/profile verifier core is byte-identical apart from the new lifecycle methods. Lockfile package/snapshot versions are unchanged; only the database workspace dependency moves scope. Archive hashes are unchanged, production output contains no acceptance controller, and final `python -B scripts/check_structure.py` passes. The new review/verification helpers and timestamped JSON/log/metadata artifacts remain outside the repository in recovery-checkpoints; no existing backup/artifact is overwritten.

## Pure staff lifecycle policy foundation acceptance

Date: 11 November 2026, Asia/Dubai. Scope: deterministic application-only lifecycle/request/approval planning and tests. No workflow executor, account creation, database connection/write/migration, provider integration, active permission, new HTTP endpoint or production operation. ADR 0011 records exact operations, state graph, rules and limits.

### Checkpoint and preserved boundaries

Current instructions, ADRs, security, governance/register and implementation were inspected. No applicable AGENTS.md was found and Git remains unavailable; no installation or repository publication occurred. All older archive/entry hashes were verified and preserved. Before changes, 175 reviewed maintained files were archived/read back as `../recovery-checkpoints/before-staff-policy-20261111T102152Z.zip`, with adjacent manifest. SHA-256: `ec7eb1a0204b8bc0db30011b7ae011172e5d29fcda3d11db7f3bd937d9c30f0b`. Environment/templates, data/database/key files, dependencies, caches and generated outputs were excluded; existing synthetic configuration URL-pattern sources were reviewed without printing secrets.

Only two existing application build/source files change: index exports and explicit existing Node type inclusion for the standard-library hash. New policy/test modules are separate from the existing authorization evaluator, permission catalogue, verified identity and self-operation. Those files, all previous tests, API/runtime source, database/migrations/role scripts, financial/provider logic, manifests/lockfile and supplied governance policy remain unchanged. No existing assertion is weakened or skipped. Builds refresh ignored outputs only.

### Implemented rules and safe outcomes

Typed operations describe create/activate/suspend/revoke/reactivate/disable/recover; typed scope separates staff/global, membership/tenant and grant targets. Exact request states are DRAFT, SUBMITTED, APPROVED, REJECTED, CANCELLED, EXPIRED, SUPERSEDED, APPLIED. State/event proposals enforce the enumerated graph and terminal states. APPLY is unavailable everywhere. No status, grant or request is persisted.

All results are frozen minimal PLAN/REJECTED/TRANSITION objects with NOT_AUTHORIZED and the same immutable blockers: ASSURANCE_NOT_ESTABLISHED, RESERVED_PERMISSION_INACTIVE, NO_EXECUTOR. A present quorum is not MFA, current authorization or a successful committed workflow. No established-assurance type or attestation path is added. Tests preserve the real permission evaluator's rejection of reserved platform.staff.suspend while existing identity evidence remains not-established.

The fixed delegation policy distinguishes the two explicit low-risk roles from all other tenant/platform authority, including non-privileged-labelled platform auditors. Normal requests require an active ACCESS_ADMIN; own-tenant low-risk paths require active TENANT_ADMIN membership/grants. Immediate containment remains only a plan and cannot confer grant powers. Independent security/governance slots exclude requester, beneficiary and duplicate canonical staff IDs. Tenant administrators cannot affect protected own-tenant/platform targets. Role conflicts include unrevoked future/expired assignments; restrictive removal can resolve conflict without adding authority.

Approvals bind request ID/version/policy/intent digest and current approver authority version. The standard SHA-256 digest covers the allowlisted operation/target/scope/role/expected-version/time fields, excluding bookkeeping state; it is not signature verification or approval provenance. Stale content/versions, rejected/expired approvals, future/expired/revoked authority, malformed scopes and terminal/conflicting transitions reject. Explicit epoch milliseconds make boundary tests deterministic, with request/approval windows bounded to 30 minutes.

Future grant cancellation accepts actual revocation before scheduled validity in the pure model. Migration 004's contrary existing ordering constraint is deliberately unchanged and remains a future persistence requirement. Recovery leaves staff suspended; reactivation cannot restore revoked memberships or disabled staff. Re-enrollment, identity binding, one-time bootstrap, database concurrency, atomic audit, receipts and outbox remain unimplemented.

### Commands and actual completed results

The separate helper `node ../recovery-checkpoints/verify-staff-policy.mjs` runs only non-destructive checks, captures redacted output/exit status and rejects skipped required Node suites. It opens no PostgreSQL connection and constructs no database lifecycle fixture. Toolchain/dependencies remain unchanged: Node v24.22.2, pnpm 10.34.9, TypeScript 6.0.2 and Python 3.13.17. No installation/download occurred.

| Command | Actual result |
| --- | --- |
| `pnpm.cmd application:build` | Passed |
| `pnpm.cmd application:typecheck` | Passed |
| `pnpm.cmd application:test` | 45 passed, 0 failed/skipped: previous 18 plus 27 new deterministic cases |
| `pnpm.cmd db:build` | Passed |
| `pnpm.cmd db:typecheck` | Passed |
| `node packages/database/node_modules/typescript/bin/tsc -p packages/database/tsconfig.test.json` | Passed; compilation only |
| `node --test packages/database/dist-test/database/test/config.spec.js packages/database/dist-test/database/test/identity-runtime-config.spec.js` | 8 pure configuration tests passed, 0 failed/skipped |
| `pnpm.cmd api:build` | Passed |
| `pnpm.cmd api:typecheck` | Passed |
| `pnpm.cmd api:test` | 44 passed, 0 failed/skipped; all existing verifier, guard and synthetic runtime checks |
| `pnpm.cmd test` | 19 financial/domain/provider tests passed, 0 failed/skipped |
| `pnpm.cmd demo` | Passed: AED 102.00 total, AED 2.77 contribution, executable false |
| `python -B -m unittest discover -s apps/ai-service/tests -v` | 9 test methods passed |
| `python -B scripts/check_structure.py` | Passed; 21 JSON files plus selected public-field/import checks |

Redacted evidence: `../recovery-checkpoints/staff-policy-verification-20261111T103443374Z.log` and `.results.json`. Existing helper/log/checkpoint artifacts are preserved. The completed run has zero test failures/cancellations/skips. Documentation-only structure validation and final checkpoint comparison follow the documentation changes.

### Checks deliberately not performed

Full PostgreSQL integration and `test:identity:integration` were not executed because they create/write/migrate disposable databases, outside this increment's explicit no-write/no-migration boundary. They are not marked skipped or disabled in code; previous tests/assertions remain untouched. No target database, database grant, session or staff record was accessed. Development migration history was not rechecked; previous 001–003/004-pending evidence is historical, not a fresh check. No migration was applied and no database was created or removed. Existing source preservation plus current non-destructive tests do not replace future real-PostgreSQL acceptance of a writer.

### Resolved development checks and remaining risks

An initial application typecheck required explicit `types: [node]` for the already installed Node standard-library types used by SHA-256. A later compile rejected a rejection helper's broad union return after state-graph tightening; its return now specifies the rejection branch precisely. Compiler strictness/assertions were preserved. The initial 25 new cases passed; review added exhaustive state/event and self-containment/malformed-target cases, giving the final 27 new tests. No runtime assertion failure remains.

Trusted snapshots, canonical staff-person mapping and approval provenance remain assumptions of a pure planner, not verified evidence. A digest is not a signature. No caller may treat PLAN, proposed ACTIVE/APPROVED or quorum PRESENT as authorization. Real independent administration, MFA/assurance, bootstrap, future cancellation persistence, audited atomic execution, revocation/session recovery, external/production configuration and operational ownership remain PENDING. No staff workflow or later brick is started.

This pure policy foundation is complete. Proposed next bounded increment: pure atomic command/audit/receipt contracts and in-memory failure/idempotency tests without persistence, executor, permission activation or endpoints. Separate authorization remains required.

### Exact maintained files changed in the policy foundation

Created:

- `docs/adr/0011-staff-lifecycle-policy-foundation.md`
- `packages/application/src/identity/access-change-policy.ts`
- `packages/application/src/identity/staff-lifecycle.ts`
- `packages/application/test/staff-lifecycle.test.ts`

Modified:

- `ARCHITECTURE.md`
- `README.md`
- `docs/build-sequence.md`
- `docs/governance/pending-management-approvals.md`
- `docs/progress.md`
- `docs/project-structure.md`
- `docs/security/requirements.md`
- `docs/verification.md`
- `packages/application/README.md`
- `packages/application/src/index.ts`
- `packages/application/tsconfig.json`

Final comparison command: `python -B ../recovery-checkpoints/review-staff-policy.py`. It verifies four created/11 modified/no deleted maintained files, all previous tests and existing security/financial source byte-identical, no policy I/O dependency and preserved archive hashes. Final `python -B scripts/check_structure.py` passes. The separate new verification/review helpers, timestamped redacted logs/results and review JSON remain in sibling recovery-checkpoints; no existing backup or evidence file is overwritten. No source under API/database/domain/providers, migration, role script, existing permission/assurance evaluator, dependency manifest or lockfile is changed.

## Pure staff command/audit/receipt contract acceptance

Date: 11 November 2026, Asia/Dubai. Scope: pure immutable staff command/audit/receipt/idempotency contracts and deterministic test-only transaction/failure models. No APPLY, privileged executor, database connection/write/migration, provider, staff account, HTTP endpoint, reserved-permission activation or financial operation. ADR 0012 describes the exact boundary and limitations.

### Checkpoint and preserved implementation

Current instructions, ADRs, security, governance/register and existing policy/contracts were reviewed. No applicable AGENTS.md was found and Git remains unavailable. Before edits, older archive/entry hashes were verified/preserved and 179 reviewed files were archived/read back as `../recovery-checkpoints/before-staff-contracts-20261111T114725Z.zip`, adjacent manifest, SHA-256 `dc6b919fb0b429c1fd348a5760a3a81052dfca0d5e9c7dbc7ff910c8c550a400`. Environment/template, key/data/database, dependency/generated/cache files were excluded. Existing synthetic configuration URL-pattern files were reviewed without printing credentials. No installation, dependency/lockfile change, backup replacement or remote publication occurred.

The only existing application source change is index exports. New pure modules define nominal immutable candidates, safe audit intents/receipts, scoped lookup and erased ports. The real lifecycle planner, permission catalogue, assurance/identity contract, authorization/audit implementation, all prior tests, API/runtime/database/migrations/role scripts and financial/provider source remain byte-identical. The in-memory coordinator and fixtures are under test only and excluded from production output. No production transaction adapter or orchestration exists.

### Implemented contracts and acceptance behavior

Candidates rerun the unchanged planner for a SUBMITTED/APPROVED request and copy only allowlisted actor/target/request/scope/role/operation/timing references. Operation IDs use canonical actor/key plus fixed version/local domain; scope deliberately belongs in the payload digest so changing target/tenant under one actor/key conflicts. Request and validated approval digests bind exact role/person/version/time intent, independent of ordering. Digests/lookup hints are not signatures, authentication, fresh assurance or authorization.

All candidate/bundle/intent/receipt/result objects retain NOT_AUTHORIZED and ASSURANCE_NOT_ESTABLISHED, RESERVED_PERMISSION_INACTIVE, NO_EXECUTOR blockers. A present quorum and a recorded simulation cannot remove those blockers. Fixed audit names are STAFF_CREATE_INTENT, STAFF_ACTIVATE_INTENT, STAFF_SUSPEND_INTENT, STAFF_REVOKE_INTENT, STAFF_REACTIVATE_INTENT, STAFF_DISABLE_INTENT, STAFF_RECOVER_INTENT. SIMULATION_ONLY records contain typed UUID/scope/catalogue/time fields with no token, email, arbitrary metadata, raw errors or real staff lifecycle success. Receipt outcome is only SIMULATION_RECORDED. Nested values are frozen; structural candidate clones cannot describe bundles. Receipt comparison checks actor/key namespace, payload, target, scope, event ID and lifetime, and reconstitutes an immutable safe allowlist.

The test-only boundary reserves/serializes a key, inspects replay, stages intent/audit/receipt in order, validates the complete tuple/deadline and publishes atomically using one synchronous Map update. It never mutates a staff directory. Identical replay creates no new tuple; changed role/target/tenant/approval payload conflicts. Concurrent duplicates record once/replay; conflicts cannot both record. Prior history survives failures. Errors before publication produce no receipt or partial visible tuple. Cleanup releases reservations, enabling bounded deterministic retry.

Commit acknowledgement distinguishes acknowledged simulation from UNKNOWN. Tests model lost acknowledgement after publication and without publication; caller gets UNCERTAIN and no receipt. Scoped lookup distinguishes RECORDED_SIMULATION, NOT_FOUND (reservation required before retry), PENDING, LOOKUP_UNAVAILABLE, CONFLICT and malformed contracts. Missing alone is not proof of rollback. Serialized retry rechecks receipts under the same key. Recorded simulation can be reconciled after command expiry without another intent. Real database driver/rollback uncertainty, durability, restart and multi-process coordination are explicitly unimplemented.

### Exact commands and completed results

The new helper `node ../recovery-checkpoints/verify-staff-contracts.mjs` executes only applicable non-destructive commands, records redacted output/status and rejects skipped required Node suites. It opens no PostgreSQL connection and creates no lifecycle database fixture. Toolchain/dependency versions remain unchanged from the preceding verification record.

| Command | Actual result |
| --- | --- |
| `pnpm.cmd application:build` | Passed |
| `pnpm.cmd application:typecheck` | Passed |
| `pnpm.cmd application:test` | 71 passed, 0 failed/skipped: previous 45 plus 26 deterministic command/transaction cases |
| `pnpm.cmd db:build` | Passed |
| `pnpm.cmd db:typecheck` | Passed |
| `node packages/database/node_modules/typescript/bin/tsc -p packages/database/tsconfig.test.json` | Passed; compilation only |
| `node --test packages/database/dist-test/database/test/config.spec.js packages/database/dist-test/database/test/identity-runtime-config.spec.js` | 8 pure configuration tests passed, 0 failed/skipped |
| `pnpm.cmd api:build` | Passed |
| `pnpm.cmd api:typecheck` | Passed |
| `pnpm.cmd api:test` | 44 passed, 0 failed/skipped; existing verifier/guard/synthetic runtime checks retained |
| `pnpm.cmd test` | 19 financial/domain/provider tests passed, 0 failed/skipped |
| `pnpm.cmd demo` | Passed: AED 102.00 total, AED 2.77 contribution, executable false |
| `python -B -m unittest discover -s apps/ai-service/tests -v` | 9 test methods passed |
| `python -B scripts/check_structure.py` | Passed; 21 JSON files and selected public-field/import checks |

Redacted evidence: `../recovery-checkpoints/staff-contracts-verification-20261111T115650923Z.log` and `.results.json`. All older artifacts are preserved. The complete run has zero failures, cancellations or skipped tests. Final source/checkpoint comparison and documentation-only structure validation follow documentation updates.

### Failures, omissions and remaining limits

The first new-test compilation caught one unused FailurePoint import; removing the unused import preserved strictness. No runtime assertion failed and no old test assertion was edited, weakened or skipped. New tests use explicit synthetic time/UUIDs and promise barriers, without sleeps or random scheduling assumptions. Faults cover begin/read/intent/audit/receipt/precommit/cleanup acknowledgements, complete tuple substitution, concurrent failure/retry, unknown commit, pending/unavailable lookup and expiry while paused.

Full PostgreSQL and real identity integration remain unrun because they create/write/migrate databases, prohibited in this increment. No database/role/session/staff record was accessed, created, changed or removed, and migration history was not rechecked. Earlier disposable acceptance and 004-pending development status remain historical evidence, not fresh claims. No Auth0/external identity or real employee data was used.

This increment is complete only for pure contracts and the test model. Real authenticated actor/approval provenance, canonical person mapping, MFA/assurance, idempotency retention, durable receipts, atomic staff/audit/outbox persistence, revocation, operator reconciliation, bootstrap and production controls remain PENDING. Nominal candidate provenance is process-local; safe persisted rehydration is not implemented. SHA-256 is not approval proof and receipt lookup hints do not authenticate a caller. Simulation atomicity does not establish PostgreSQL, failover, restart/restore or multi-process guarantees. All management rows remain PENDING.

Proposed next bounded increment: read-only persistence/transaction threat-model and migration acceptance specification, with no SQL execution, grants, provisioning, provider connections or permission activation. Stop here; no subsequent implementation or later brick is authorized.

### Exact maintained files changed in the pure contract increment

Created:

- `docs/adr/0012-staff-command-audit-receipt-contracts.md`
- `packages/application/src/identity/staff-command-contracts.ts`
- `packages/application/src/identity/staff-command-ports.ts`
- `packages/application/test/fixtures/staff-command-fixtures.ts`
- `packages/application/test/fixtures/staff-command-simulation.ts`
- `packages/application/test/staff-command-contracts.test.ts`

Modified:

- `ARCHITECTURE.md`
- `README.md`
- `docs/build-sequence.md`
- `docs/governance/pending-management-approvals.md`
- `docs/progress.md`
- `docs/project-structure.md`
- `docs/security/requirements.md`
- `docs/verification.md`
- `packages/application/README.md`
- `packages/application/src/index.ts`

Final review command: `python -B ../recovery-checkpoints/review-staff-contracts.py`. It confirms six created/10 modified/no deleted maintained files, previous tests/policy/security/financial source byte-identical, no contract I/O dependencies, test simulator absent from production output and all archive hashes preserved. Final `python -B scripts/check_structure.py` passes. New verification/review helpers and timestamped redacted log/result/review files remain in sibling recovery-checkpoints; no older backup or artifact is overwritten. No dependency, lockfile, compiler setting, API/runtime, database/migration/role script or existing authorization/assurance/audit implementation changes.
