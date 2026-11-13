# Controlled three-branch local integration

13 November 2026, Asia/Dubai. Baseline: `560e12bb90bbc79073858c05ad77149240a40a71`.

## History and scope

| Track | Reviewed branch tip | Integration merge |
| --- | --- | --- |
| A: database security | `1bd04ccd626454087fe152abe42c3bac53eb690c` | `2bd5993cb0123aa33049bd7be41fb95efec38ebd` |
| B: gated Auth0 source | `ef1fe7394350c695d2ba8d924e39c5ecad59c04f` | `56d13efdfda344c55d814c0c643585397dd271fe` |
| C: staff dashboard | `c6aa1b8742d09c67e1aea2457cc7f55ec8d1c75b` | `5e7e932f4c1a762d52716197d94f6a962000e194` |

All merges preserve both parents. Additional commit `e2db251bf883b2b9eb4dacfdd01e6420a9c95bcc` explicitly pins protected checkout bytes. No database configuration, persistent migration, Auth0 configuration, staff mutation, privileged permission or financial behavior was changed. Real login and persistent session/IAM runtime composition remain disabled.

## Conflict resolutions

Five shared paths were resolved: `apps/admin-web/README.md`, `apps/admin-web/package.json`, `apps/admin-web/src/portal.ts`, `apps/admin-web/test/portal.spec.ts`, and `pnpm-lock.yaml`. Root package scripts retain Track B's dependency-aware build/test sequencing. The admin-web package combines the authentication exports/dependencies with Track C's browser compilation and pinned React/Vite dependencies.

The portal keeps the narrow provider callback/logged-out navigation exceptions before the SPA fallback, strict host/origin checks, existing secure cookie attributes, CSRF, bounded request handling, cancellation, audited session-store revocation and shutdown cleanup. Track C's server environment gate and manifest-based asset projections remain intact. The normal CLI selects no login or session service.

Logout supports 204 for confirmed local revocation and 200 for the exact configured provider destination after confirmed revocation. Trusted server composition renders that public destination into an HTML meta element. The React client rejects missing/duplicate policy, mismatched destination, changed client or return URL, fragments, credentials, unexpected parameters, non-HTTPS URLs and malformed results. A logout response cannot choose a new destination. The fallback script also compares against its exact server-configured destination. Only public issuer/client/return parameters enter the browser; tokens and secrets do not.

Focused combined tests use actual Vite outputs, synthetic signed identity and pinned local HTTPS. They verify callback precedence/replay, both logout contracts, malicious destination rejection, failure of session persistence, server policy, cross-origin denial, no demo person in ordinary JavaScript chunks and 404 responses for preview/dynamic chunks with preview disabled or production configured. Original branch assertions remain present. Reference handover files are never part of the runtime asset map.

## Migration bytes and dependencies

Registered sources, SQL sidecars and the migration manifest are unchanged. `.gitattributes` pins the three LF and seven CRLF manifest inputs individually, and pending 007 to LF. A temporary index checkout with `core.autocrlf=false` passed the unchanged raw-byte verifier and pending 007 hash; the temporary checkout was removed. No checksum was regenerated and no migration source was normalized to conceal a mismatch.

Pending 007 SHA-256: `c4ed1ef748dabdfeb16cfc8cc40b667cb0106e944c5d97547677671ac064a2c9`.

The operator approved separate `pnpm.cmd install --frozen-lockfile --ignore-scripts` runs for B and C. B adds only an existing pinned jose importer and application workspace link. C's 114 additional package and snapshot entries match its reviewed lockfile exactly; all existing package/snapshot records retain their versions, dependency edges and integrity metadata. No install scripts or dependency upgrades ran, and the resolved lockfile stayed unchanged during installation.

The initial C download was blocked by network-sandbox EACCES. The approved elevated frozen install required non-interactive CI mode to recreate generated node_modules and then completed from cached packages. Vite's configuration resolver also required execution outside the filesystem sandbox. A PowerShell OpenSSL launcher stopped on progress output before tests; a Node launcher captured it correctly. These were environment/launcher failures, not passing tests or reasons to weaken checks.

## Verification status

Track A passed source verification, non-executing preparation and 7 deterministic tests. Before C, Track B passed staff build/typecheck, 14 staff tests, 94 application tests and 48 API tests. After C resolution, staff build/typecheck and 22 staff, 94 application and 48 API tests passed with zero failures or skips. TLS used temporary localhost-only certificates with normal hostname and chain validation; temporary private material was removed and Windows trust remained unchanged.

Final executable suites passed: publication 6, database 18, combined migration/security/restore 34, identity/HTTP/workflow 123, PostgreSQL sessions 18, domain/provider 19 and Python 9. Together with the focused 22 staff, 94 application, 48 API and 7 preparation cases, this is 398 distinct passing tests with zero failed/cancelled/skipped test cases. Application/database/API typechecks and the deterministic AED 102.00/AED 2.77 demonstration passed. Persistent development history remained 001-003; database and generated-role inventories were identical before and after. Temporary TLS material was removed.

**Final integration acceptance: NO-GO.** The last required command, `python -B scripts/check_structure.py`, failed. Its generic client rule scans every file under apps/admin-web, including the trusted Node BFF and server test fixtures, and reports application-package imports in `src/auth0.ts`, `test/auth0.spec.ts` and `test/fixtures/auth0-fixture.ts`. Those imports implement the reviewed server identity boundary, but the existing checker has no BFF/browser distinction. The checker was not changed, suppressed or exempted to force a pass. Implementation stops at this gate with all successful merge commits preserved.

Required follow-up is a reviewed architecture-check correction distinguishing trusted BFF source/server tests from the actual browser client, while continuing to reject backend imports from browser code (including transitive bundling). It needs positive BFF and negative browser-import acceptance; a blanket admin-web exemption would be unacceptable. This is an unresolved verification boundary, not evidence that real authentication is ready.

The external verification launcher records redacted per-command output and statuses in `../recovery-checkpoints/threebranch-final-20261113T155832281Z.log` and adjacent results. It never commits certificate material or credentials. No final suite was skipped or weakened; the failed structure command remains explicitly recorded as exit code 1.

## Operational gates and rollback

Persistent IAM remains NO-GO pending approved SCRAM/role secret and HBA operations, restored-backup acceptance, exact-target activation source transition, restricted session credentials and operational ownership. Real login additionally needs demonstrated provider token/MFA claims, exact trust/configuration, browser-trusted TLS and approved runtime composition. Staff management still needs approved onboarding, independent privileged approval and an execution boundary. No reserved permission, accepted approval or APPLY is enabled by integration.

Rollback uses explicit Git reverts of merge commits in reverse order (`git revert -m 1 <merge>`), plus ordinary reverts for independent fix commits when needed. Never reset completed merges automatically, rewrite historical checksums, run migration downs or change the database as part of source rollback. Retain the three branch worktrees and all existing recovery checkpoints.
