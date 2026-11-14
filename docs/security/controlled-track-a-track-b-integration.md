# Controlled integration: synthetic Auth0 and Brick 4B

2026-11-14, Asia/Dubai. This is development source integration and synthetic acceptance only. No real Auth0, persistent IAM/session mode, provider, external client, operational pricing or financial execution was activated. Nothing was merged into main or pushed.

## Commits, baseline and worktree

- Accepted common committed baseline / unchanged main HEAD: `b28be43154563c8ccff568c9f2aed9df8e663cf4`.
- Track A prior HEAD: `5caccaf2b80b4b560a178883bec73def3cd359f4`, a reviewed gated IAM deployment-checklist documentation change only.
- Focused Track A Auth0 commit: `7f06b28b8af9d4b6842dc68989fce0e3c9bd785a`, 18 reviewed files. PostgreSQL testing/profile files were not staged or committed.
- Track B ancestry verified: baseline -> `b1703d5a7455bb0a9c21b6d45fe7f255d6e22997` -> `ac117f6c7da71c77001ee57c307c3b9e3acaf123` -> `2124bd89892cabfa87ef95cb3413c481b1077df7`. Objects/parents, clean Track B worktree, whitespace, file inventory and frozen-source preservation were checked; this is not a claim of externally signed commit provenance.
- Integration branch: `integration/brick3-auth0-brick4b`.
- Integration worktree: `C:\Users\Admin\OneDrive\Desktop\NAUKHBAPAY AI\nukhabapay-worktrees\brick3-auth0-brick4b-integration`.
- Integration merge: `d6218ff0c7941b7bf20ee8597b187398397af5e3`. Track B was fast-forwarded first, then reviewed Track A history merged without conflicts. Before the validation increment, the integration tree matched all 29 Track B files and all 18 accepted Auth0 files exactly. The validation increment clarifies two dashboard documents to reflect guarded catalogue route registration and the deployment checklist to acknowledge the pending parser/self-only UI; runtime source remains identical to the accepted tracks. The additional gated documentation ancestor was retained, not rewritten.

The final validation commit adds this report and `apps/api/test/published-catalogue-memory-http.spec.ts`, and corrects integration facts in `apps/admin-web/README.md`, `docs/staff-dashboard-integration.md` and `docs/runbooks/development-iam-deployment.md` without changing activation gates. The latter reuses the accepted HTTP assertions with explicit in-memory reader/audit fixtures. It changes no runtime code, authorization or migration bytes. No reset, stash, discard, main checkout, main merge or global Git configuration was used. Per-command safe.directory exceptions were scoped to the named worktrees.

## Preservation and excluded changes

Main's HEAD, original dirty status and all four original uncommitted file SHA-256 values were checked against the preflight inventory. Its preserved paths are `README.md`, `apps/admin-web/README.md`, `package.json` and untracked `scripts/dev-staff-portal.ps1`. These changes were neither copied into this branch nor committed. The admin-web README overlaps an integrated file; reconcile it in a separately controlled main integration step before merging.

Track B remains clean at its original HEAD. Track A retains exactly seven modified and nine untracked PostgreSQL-related paths, with every original file SHA-256 unchanged:

Modified, unstaged:

- `apps/api/test/fixtures/disposable-iam-database.ts`
- `apps/api/test/migration006.integration.ts`
- `packages/database/test/catalog-import.spec.ts`
- `packages/database/test/identity-integration.spec.ts`
- `packages/database/test/integration.spec.ts`
- `scripts/import-synthetic-catalog.ts`
- `scripts/rehearse-reviewed-migrations.mjs`

Untracked, not committed:

- `docs/runbooks/disposable-postgresql-testing.md`
- `docs/security/disposable-postgresql-port-transition-design.md`
- `docs/security/disposable-postgresql-source-profile-security-review.md`
- `packages/database/test/disposable-postgres-target.spec.ts`
- `packages/database/test/fixtures/disposable-postgres-target.ts`
- `scripts/test/disposable-migration-target.test.mjs`
- `scripts/test/disposable-postgres-safety.ps1`
- `scripts/test/disposable-postgres-safety.tests.ps1`
- `scripts/test/run-disposable-postgres-integration.ps1`

The integration import script contains Track B's independently committed output-path correction, not Track A's uncommitted alternative. No uncommitted database guard/profile change was imported. Local preflight HEAD/status/file-hash inventories remain outside Git under Track A's `.local/integration-prep-0943713900514122a5f6b466afa099eb/`. No secrets or temporary TLS credentials are in those inventories. The first inventory encoding caused a structure-check failure; it was corrected to UTF-8 without BOM and structure checks then passed.

## Security contracts and migration dependencies

Auth0 staff identity and machine catalogue identity remain separate provenance-bound types. The BFF returns only a freshly authorized self profile, CSRF token and self overview navigation; management authorization is not inferred from browser visibility. Default CLI login/persistent sessions remain disabled. Exact callback/logout settings are documented in the [Auth0 integration runbook](../runbooks/staff-auth0-synthetic-integration.md).

Only the four exact payment/kiosk catalogue controller methods enter Track B's distinct machine boundary. Staff handlers retain the original global staff guards. Synthetic verification, scope, client/tenant/kiosk binding, response allowlists, one-use pagination and committed read-audit requirements remain intact. Default application composition registers no machine verifier, bindings, reader or audit adapter. Synthetic approval/publication tickets remain `NOT_AUTHORIZED`; the operational permission catalogue is unchanged. No financial domain calculation changed.

| Source / recipe | Dependency / disposition |
| --- | --- |
| Registered 001-006 plus pinned 004/006 sidecars | Unchanged against baseline; original manifest and independent verifier unchanged. IAM 004 preflight and later guards still enforce port 5432. |
| Pending 007 catalogue publication drafts | Existing baseline source, unchanged; not registered/applied. |
| New pending 008 price submission evidence | Requires 007 draft/source objects, exact registered 001-006 history, owned local disposable target and explicit synthetic gate. Not registered/applied. |
| New pending 009 synthetic publication workflow | Requires 008 evidence and the same history/target contract. Adds synthetic ledger/transition safeguards only; not registered/applied. |
| New pending 010 synthetic published catalogue | Requires 009 ledger and existing history/target contract. Public projection plus separate append-only audit; not registered/applied. |
| Three new submission/publication/catalogue client grant recipes | Owner-operated recipes for restricted ephemeral synthetic roles; not executed, no persistent roles or client registry created. |

Fresh-checkout raw-byte SHA-256 evidence: 007 `c4ed1ef748dabdfeb16cfc8cc40b667cb0106e944c5d97547677671ac064a2c9`; 008 `c9427445d9b7f29c3a7b6b7cf249d6714cb9dd89a45735f45e0492589f26d4f2`; 009 `06472c8787f08631964fb57256813d3b7c1e67610ef66b4fbeb2901bcb0998d0`; 010 `23a5dfa0c1b00549d9c18f3ce993f145571a01659a5107996154ec21b37d9738`. Existing recorded 007-009 digests match. No checksum, manifest, frozen SQL or line-ending rule was changed.

## Combined validation

Dependencies were installed with `pnpm.cmd install --offline --frozen-lockfile --ignore-scripts`: local cache only, no downloads or lifecycle scripts. Builds/tests ran in this separate checkout with required filesystem permission; main and Track A dependency trees were not reused as linked workspace source.

| Check | Result |
| --- | --- |
| Existing Auth0/BFF, React client and pinned localhost HTTPS suite; actual browser production build | 25 passed, 0 failed/skipped; temporary keys/PFX removed and OS trust unchanged |
| Application regression including pricing candidate, submission evidence, catalogue service, IAM/session gates | 96 passed, 0 failed/skipped |
| API/security plus added in-memory published-catalogue HTTP isolation | 49 passed, 0 failed/skipped |
| Exact money, financial waterfall and synthetic provider normalization | 19 passed, 0 failed/skipped |
| Database configuration unit files only (no connections) | 11 passed, 0 failed/skipped |
| Existing source-only activation/preflight security tests | 7 passed, 0 failed/skipped |
| Existing advisory AI matching/authority guard tests | 9 passed, 0 failed/skipped |
| Recursive available workspace typechecks | Passed: application, database, BFF/React and API |
| Registered source integrity and original migration/manifest diff | Passed, no connection |
| Structure and browser/server dependency separation | Passed; 31 JSON contracts |
| Built browser secret boundary and reviewed commit credential-material scan | Passed; no server-only Auth0 configuration/client-secret exchange in browser assets and no committed private keys/JWT credentials |
| Git whitespace and merged-source comparisons | Passed |

Total executed tests: **216 passed, zero failed, zero skipped**. This total excludes every blocked database integration suite. No screenshot/accessibility or real-provider acceptance is claimed.

**Blocked, not passed and not silently skipped:** full PostgreSQL database integration; IAM/session persistence; registered 006 migration/restore; Brick 4B submission/publication/reader RLS, SQL privileges and database-backed HTTP/restore acceptance. The known frozen IAM SQL requires 5432, the isolated test cluster is designed for 55432, and the existing 5432 server must not be borrowed or modified. The separate test-profile design still has NO-GO security review. No such profile was implemented. The committed `run-catalogue-publication-acceptance.mjs` explicitly connects to persistent 5432 for baseline evidence and was therefore not run. Track B's historical database results are not fresh combined acceptance.

The new in-memory HTTP regression verifies actual routes, token/scope/tenant/kiosk separation, public-field filtering, cursor ownership/replay/staleness, rate limits, simulated reader/audit failure, mid-response revocation and default-disabled composition. It does not prove SQL view/RLS isolation, actual permission withdrawal or migration/restore behavior. Those claims remain blocked.

## Delivery decisions

**NO-GO for merging into the existing main worktree now.** The committed synthetic development integration is ready for review, but main's overlapping uncommitted changes must first be preserved and reconciled under a separate controlled step. A reviewer must explicitly accept the deferred database coverage before a source-only development merge, or require successful database acceptance after the security blocker is resolved. Do not infer operational approval from the passing unit/memory tests.

**GO for beginning Monday's Hybrid AI work only as isolated synthetic/advisory development.** The current AI guard tests and deterministic financial tests pass, and AI evidence remains non-authoritative. This permits design, mocked data contracts, guard/evaluation fixtures and advisory-only implementation on a new branch. It does not approve external models/clients, private/live data access, price decisions, publication authority, payments, real providers or dependency on the blocked persistent IAM/catalogue infrastructure. Those integration/activation paths remain NO-GO.

Other blockers remain real Auth0 issuer/client/audience/MFA compatibility, reviewed persistent IAM/session provisioning, browser-trusted operational TLS and operational recovery/monitoring/secret ownership. No operational permission or external client was enabled. No merge into main or push was performed.

## Integrated file inventory (relative to committed main baseline)
- .env.example
- apps/admin-web/client/src/PlatformApp.tsx
- apps/admin-web/client/src/session.ts
- apps/admin-web/README.md
- apps/admin-web/src/auth0.ts
- apps/admin-web/src/auth0-configuration.ts
- apps/admin-web/src/main.ts
- apps/admin-web/src/portal.ts
- apps/admin-web/test/auth0.spec.ts
- apps/admin-web/test/auth0-configuration.spec.ts
- apps/admin-web/test/fixtures/auth0-fixture.ts
- apps/admin-web/test/portal.spec.ts
- apps/admin-web/test/session-client.spec.ts
- apps/api/src/app.module.ts
- apps/api/src/http-application.ts
- apps/api/src/modules/catalog/published-catalogue-http.ts
- apps/api/src/modules/catalog/README.md
- apps/api/test/catalogue-publication.integration.ts
- apps/api/test/fixtures/published-catalogue-http.ts
- apps/api/test/published-catalogue-memory-http.spec.ts
- docs/runbooks/development-iam-deployment.md
- docs/runbooks/staff-auth0-synthetic-integration.md
- docs/security/brick4b-published-catalogue-api.md
- docs/security/brick4b-submission-foundation.md
- docs/security/brick4b-synthetic-publication.md
- docs/security/controlled-track-a-track-b-integration.md
- docs/security/staff-auth0-login.md
- docs/staff-dashboard-integration.md
- packages/application/src/catalog/publication-candidate.ts
- packages/application/src/catalog/publication-workflow.ts
- packages/application/src/catalog/published-catalogue.ts
- packages/application/src/catalog/submission-evidence.ts
- packages/application/src/identity/staff-session.ts
- packages/application/src/index.ts
- packages/application/test/published-catalogue.test.ts
- packages/application/test/submission-evidence.test.ts
- packages/contracts/public/published-catalogue-page.schema.json
- packages/database/pending-migrations/008_price_submission_evidence.sql
- packages/database/pending-migrations/009_synthetic_publication_workflow.sql
- packages/database/pending-migrations/010_synthetic_published_catalogue.sql
- packages/database/roles/grant_price_submission_writer.sql
- packages/database/roles/grant_published_catalogue_clients.sql
- packages/database/roles/grant_synthetic_publication_writer.sql
- packages/database/src/catalogue-publication-draft-store.ts
- packages/database/src/index.ts
- packages/database/src/published-catalogue-reader.ts
- packages/database/src/synthetic-publication-workflow.ts
- scripts/import-synthetic-catalog.ts
- scripts/test/run-catalogue-publication-acceptance.mjs
- scripts/test/run-staff-synthetic-tests.mjs
