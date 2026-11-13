Naukhbapay technical handover
Audit date: 11 November 2026
Scope: Read-only inspection of the current workspace and PostgreSQL metadata. No files were changed, no migration was applied, and no integration tests were run for this handover because the integration harness creates and drops disposable databases. Test results below are from the immediately preceding verification run, not a rerun during this read-only inspection. No secrets or complete connection URLs are included.

Executive status
Brick	Status and verified scope
1 — Offline architecture and examples	Implemented within the synthetic starter scope: exact AED money/pricing simulation, synthetic provider adapters, and a deterministic advisory product-equivalence guard. No real providers, AI calls, orders, payments, or executable quotes.
2A — Local PostgreSQL foundation	Previously reported and verified: PostgreSQL 17.11, local catalog database, and distinct migrator/runtime identities.
2B — Persistent synthetic catalog import/read	Complete for the tested local, synthetic, complete-snapshot workflow: approved mappings required; replay, conflict, concurrency, rollback, read-back, and importer boundaries tested. Not a live-provider or authenticated catalog service.
3A — Provider-independent staff foundation	Implemented and passed local disposable-PostgreSQL acceptance. Exact identity bindings, memberships, fixed scoped permissions, deny-by-default policy, RLS, and append-only audit persistence. Not authentication.
3B — Provider-backed identity	Not started. Auth0 is proposed, not selected/configured. Provider, deployment, issuer, audience, client, operations, and provisioning decisions remain open.
4 — Controlled publication and authorized catalog API	Not started; remains after Brick 3.
Development database: migration 004 is not applied
I queried the live local PostgreSQL 17.11 instance read-only. The target database is nukhabapay_dev; its migration history is exactly:

001_catalog
002_import_role_privileges
003_import_role_read_access
The development database contains the six catalog tables (tenants, products, provider_accounts, provider_snapshots, product_mappings, provider_offers) plus schema_migrations. It has zero Brick 3A IAM tables, no forced-RLS tables, and neither identity role has schema usage or table grants in that database.

Conclusion: migration 004 is not applied to nukhabapay_dev. It was exercised on disposable databases by the recorded acceptance tests. The local cluster has identity-reader and identity-writer login roles, but those roles do not yet have privileges in nukhabapay_dev. The database and cluster were not reset or recreated.

All five workload roles currently exist and have LOGIN enabled; the observed role flags show no superuser, database/role creation, inheritance, or BYPASSRLS capability. The role-creation script itself does not set passwords. The existing loopback PostgreSQL configuration uses trust authentication; do not treat the non-production test connection settings as deployment credentials.

Architecture and implementation
Brick 1: domain and advisory functionality
money.ts uses integer minor units (bigint), bounded AED parsing, formatting, and explicit half-up fee rounding.
pricing.ts validates product/offer equivalence, mapping approval, availability, eligibility, freshness, timestamps, fees, and contribution. It selects and simulates a price; it does not persist or create a quote.
mock-provider.ts contains three immutable synthetic offers; there are no provider endpoints or credentials.
catalog-provider.ts defines the read-only normalized catalog contract.
guard.py applies deterministic field-by-field equivalence checks: mismatches reject, missing data requires review, and complete matches are candidates only. It cannot publish.
The demo retains the synthetic AED 102.00 customer total and AED 2.77 expected contribution. It explicitly labels the result non-executable.
Brick 2A/2B: PostgreSQL catalog
The six catalog tables are defined in 001_catalog.ts. Tenant/provider ownership is protected by composite references; provider offers retain snapshot, mapping, product, amount, and validity fields.

002_import_role_privileges.ts narrows importer writes to snapshot/offer insertion and column-limited snapshot completion updates. 003_import_role_read_access.ts restores required importer reads. The live development grants show runtime SELECT-only access; importer SELECT access, INSERT on offers/snapshots, and UPDATE only on snapshot status, row_count, and completed_at. Importer product and mapping writes and deletes are not granted.

synthetic-provider-import.ts provides the internal import/read use-case boundary. catalog-repository.ts implements PostgreSQL import and read behavior, including replay comparison and transaction handling. The workflow requires a pre-existing canonical product and approved mapping; it does not create an approval from provider input.

Brick 3A: staff identity and authorization
004_staff_identity_foundation.ts defines nine intended tables: staff_users, staff_identities, staff_memberships, iam_roles, iam_permissions, iam_role_permissions, platform_role_grants, tenant_role_grants, and security_audit_events.
permission-catalog.ts defines 12 roles, 23 permissions, and 32 role-permission mappings. Only staff.self.read is active in 3A; later-phase permissions are seeded/reserved but denied.
staff-access.ts resolves exact issuer/subject identities through a repository port and evaluates deny-by-default access. No email linking, first-login enrollment, wildcard, or role hierarchy. Platform grants do not grant tenant access. Conflicting role combinations are rejected; self-approval uses internal staff IDs.
staff-identity-repository.ts implements parameterized reads, transaction-local tenant context, and audit append operations.
security-audit.ts restricts events to fixed vocabularies and typed identifiers, with bounded batch and UUID/timestamp validation.
Forced RLS is specified for memberships, tenant grants, and tenant-associated audit events. The tenant context is transaction-local on the same connection. It mitigates accidental unscoped reads; because the trusted application can set the custom GUC, it is not protection against a compromised application or leaked reader credential.
The identity reader has column-limited read grants; the audit writer is intended to have INSERT-only access to the audit table. No identity writer for staff, membership, or grant management exists. Migration 004 has not granted any of these in nukhabapay_dev.
Decision records: ADR 0006 records the local 3A choices; ADR 0005 keeps Auth0 and provider setup proposed and unresolved.

Technology and package boundaries
Runtime/toolchain: Node.js 24.22.2, pnpm 10.34.9, TypeScript 6.0.2; Python 3.13.17 was used for matching tests; PostgreSQL 17.11.
API: NestJS/Express; currently only GET /health/live. api.config.ts defaults to IPv4 loopback; http-application.ts bounds request bodies and timeouts; safe-exception.filter.ts sanitizes errors. There is no authentication or authorization middleware.
Database: pg 8.23.1 and node-pg-migrate 9.0.0. config.ts constrains current database URLs to loopback and bounds pool/timeouts. pool.ts defines separate pools for runtime, importer, identity reader, and audit writer.
Python: standard-library dataclasses and strict schema-like parsing; no configured model calls or production AI service.
Workspace: pnpm monorepo. Worker, admin web, kiosk, and mobile areas are predominantly planning READMEs.
Current source layout
This is the live source inventory, excluding node_modules, dist, dist-test, and Python cache output. Some links are folder-level to keep the inventory readable.

Root: README.md, ARCHITECTURE.md, package.json, pnpm-workspace.yaml, pnpm-lock.yaml, .node-version, .env.example, .gitignore, and .editorconfig.
Apps: apps/api/ has its Nest bootstrap/configuration, liveness controller, HTTP setup, exception filter, two tests, and package/TypeScript config. apps/ai-service/ contains matching schemas/guard/tests, evaluation fixtures, prompt and model-gateway placeholder. apps/worker/, apps/admin-web/, apps/kiosk-client/, and apps/mobile/ are boundaries/placeholders.
Packages: packages/domain/ contains money/pricing code and tests. packages/provider-contracts/ and packages/provider-adapters/ contain provider interfaces, synthetic adapters, and tests. packages/application/ contains the import use case, identity policy/audit code, tests, and planned domain READMEs. packages/database/ contains migrations 001–004, role scripts, catalog and identity repositories, config/pools, database tests, and package TypeScript config. packages/contracts/ contains public JSON schemas and an admin pricing example.
Infrastructure/scripts/tests: infra/local/ has optional Compose and PostgreSQL role initialization; infra/deployment/ is documentation only. scripts/ contains the pricing demo, synthetic import entry point, and structure check. tests/ has contract/integration/security README placeholders.
Docs: docs/adr/ contains ADRs 0001–0006; docs/security/ contains the login blueprint, security requirements, and trust-boundary record. Also present are build-sequence.md, data-model.md, progress.md, verification.md, project-structure.md, and the unknown-provider-outcome runbook.
The supplied inventory in project-structure.md predates 3A: it says database persistence is planned and omits the identity files and ADR 0005/0006. It is not a complete current inventory. Generated dist/dist-test directories and Python __pycache__ files are present locally; additionally, generated .js, .d.ts, and .map outputs were found under packages/provider-contracts/src/. No Git metadata exists at the workspace root, so a Git status/diff or tracked-vs-untracked determination was unavailable. No applicable root/parent AGENTS.md was found.

Verification evidence
The most recent recorded complete runs on 11 November were:

Command	Result
pnpm.cmd --filter @nukhabapay/database test	11 passed, 0 failed, 0 skipped; includes Brick 2B import tests and 3A disposable PostgreSQL acceptance.
pnpm.cmd --filter @nukhabapay/database test:integration	11 passed, 0 failed, 0 skipped.
pnpm.cmd --filter @nukhabapay/application test	11 passed, 0 failed, 0 skipped.
Application build and typecheck; database build and typecheck	Passed.
pnpm.cmd api:build, api:typecheck, api:test	Passed; API suite 3/3.
pnpm.cmd demo	Passed; AED 102.00 / AED 2.77 synthetic result.
pnpm.cmd test	19 passed, 0 failed, 0 skipped.
Python unittest discovery	9 tests passed.
scripts/check_structure.py	Passed; 21 JSON files plus documented public-field and selected dependency-boundary checks.
pnpm.cmd install --frozen-lockfile	Passed; lockfile up to date.
The PostgreSQL acceptance checked fresh and repeat migration application in disposable databases, role/permission seed counts, identity uniqueness, tenant and role-scope constraints, RLS with and without context, pooled context cleanup, reader/writer ACLs, audit immutability and rollback. A prior interrupted parallel verification coincided with the existing cluster stopping; it was restarted from its existing data directory, completed crash recovery, and the final full database runs passed. The current read-only health check shows the cluster accepting connections.

Remaining risks and limitations
3A is a local foundation, not an operating identity system. No trusted verifier feeds the issuer/subject values; no route accepts synthetic identities.
Migration 004 is absent from nukhabapay_dev. The intended IAM DB grants and RLS are therefore also absent there.
No application-level invitation, identity enrollment, membership/grant administration, revocation workflow, or initial staff bootstrap process exists. Schema rows remain migration-controlled.
Current RLS context is a custom application-settable PostgreSQL setting; it does not defend against a compromised application or stolen reader credential.
Audit rows are append-only for application roles via grants and triggers; this is not tamper-proof against database owners/superusers, and production retention/export/monitoring is undefined.
There are no provider, deployment, secret-management, production TLS, rate-limiting, monitoring, recovery, or independent security-assessment controls.
README.md, project-structure.md, and trust-boundaries.md retain older statements that database persistence/identity work is planned or broadly unimplemented. Use the newer progress, verification, ADR 0006, and build-sequence records for 3A status.
Exact next tasks for Brick 3B
Obtain owner decisions before provider work: confirm launch jurisdiction/data-residency and procurement constraints; whether KissAux or NubbaPay already has a suitable supported OIDC provider; identity-provider operations owner; the actual business/tenant model; staff enrollment and suspension authority; and acceptable token/revocation targets.
Approve or replace the proposed provider. Auth0 is only a recommendation. Do not create an account, client, issuer, audience, or external identity without explicit authorization.
With an authorized owner, provision a dedicated non-production identity environment. Register the staff browser/BFF client and API resource; establish redirect/logout settings and the real issuer from discovery metadata; register and approve the actual API audience. Keep dev, acceptance-test, and production trust configuration separate. Confirm MFA, account suspension, session, and key-rotation capabilities.
Agree on the staff session design and lifecycle. ADR 0005 proposes a browser BFF, Authorization Code with PKCE, a five-minute API token target, and server-side authoritative membership. Verify these against the chosen provider and deployment; settle the proposed 30-second revocation visibility target rather than treating it as approved.
Before relying on database records, decide how migration 004 reaches the selected development/acceptance databases. It is tested but not applied to nukhabapay_dev. Use an explicitly selected target and approved migration process; configure the separate reader/writer credentials through approved local/deployment secret handling. Do not reuse the development database merely because it exists.
Implement only the trusted staff boundary in apps/api. Use a maintained OIDC/JWT library and trusted metadata/JWKS handling. Validate signature and allowed algorithm, exact configured issuer/audience, expiry/not-before, and key rotation; fail closed. Do not implement custom token cryptography, password collection, email linking, first-login provisioning, or tenant-header authorization.
Connect verified (issuer, subject) to the existing internal staff record and server-side active membership/permission. Pass an explicit verified context to the application layer; keep database access narrow and importer permissions unchanged. Do not expose a customer-facing or other business endpoint.
Run Brick 3B acceptance: valid test token; missing/malformed/tampered/wrong issuer/audience/expired/not-yet-valid/disallowed algorithm; JWKS rotation and refresh failure; unknown/disabled/suspended staff and inactive membership; tenant-header spoofing and cross-tenant object denial; revocation/suspension propagation; provider/database outage fail-closed behavior; and dev/test/prod token separation. Re-run Brick 2B and the existing API/application/domain/database checks.
Brick 4 remains explicitly deferred until Brick 3 is complete.