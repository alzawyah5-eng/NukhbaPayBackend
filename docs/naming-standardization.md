# Nukhbapay naming standardization

12 November 2026. Official display name: **Nukhbapay**. Canonical technical spelling: **nukhbapay**. This is a naming change in the existing repository, with no new brick, effective staff permission, endpoint or financial behavior.

## Classification and scope

The maintained-source inventory was checked for Naukhbapay, Nuakhbapay, Nukhabapay and case variations, using a broader historical-spelling pattern. The baseline contained `Naukhbapay`, `NAUKHBAPAY`, `naukhbapay`, `Nukhabapay`, `NUKHABAPAY` and `nukhabapay`; no additional historical spelling was found. Negative trust tests also deliberately exercise Nuakhbapay variants.

| Classification | References | Treatment |
| --- | --- | --- |
| Safe to rename | Display prose, current package documentation, Python source directory, current staff blueprint filename | Canonical spelling; imports, links and structure inventory updated together |
| Coordinated compatibility change | Root/workspace package names, imports/exports, pnpm filters and lockfile, Python imports, synthetic token audiences, sample schema IDs, PostgreSQL client application labels, project-prefixed environment inputs | Updated as one source change, with package resolution, builds and regression acceptance; no legacy trust alias |
| Immutable history or fixed database contract | Registered migrations 001Ã¢â‚¬â€œ005, pending SQL rehearsals, provisioning/grant SQL, existing schema/RLS/GUC/role names, prior ADRs 0001Ã¢â‚¬â€œ0020, Copilot handover, prior progress/verification entries, checkpoint archives and evidence | Retained; current naming does not amend historic records, SQL grants or migration checksums |
| External or local resource locator | Existing development database, Compose project/volume namespace, checkout and enclosing directory, any registered provider identifier | Preserved; independent verified migration/relocation is required before changing a resource locator |

Dependencies, generated build output, package-manager stores and Python caches are not maintained source. Builds and package-manager linking regenerate applicable output; old logs, cache paths and recovery archives are not rewritten as branding. The exact maintained-file change inventory and per-reference classifications are recorded beside the recovery checkpoint, without source excerpts or credentials.

## Current project identifiers

| Previous | Current |
| --- | --- |
| Root package `nukhabapay` | `nukhbapay` |
| Scope `@nukhabapay/` | `@nukhbapay/` |
| Workspace package suffixes | `api`, `worker`, `application`, `contracts`, `database`, `domain`, `provider-adapters`, `provider-contracts` (unchanged) |
| Python module `nukhabapay_ai` | `nukhbapay_ai` |
| Project-owned environment prefix `NUKHABAPAY_` | `NUKHBAPAY_` |
| Client labels `nukhabapay-api`, `nukhabapay-import`, `nukhabapay-identity-reader`, `nukhabapay-identity-audit-writer` | Corresponding `nukhbapay-` labels |
| Synthetic access audience `urn:nukhabapay:synthetic:staff-api` | `urn:nukhbapay:synthetic:staff-api` |
| Synthetic development audience `urn:nukhabapay:synthetic:development-api` | `urn:nukhbapay:synthetic:development-api` |
| Synthetic assurance audience `urn:nukhabapay:synthetic:approval-provenance` | `urn:nukhbapay:synthetic:approval-provenance` |
| Example schema host `schemas.nukhabapay.example` | `schemas.nukhbapay.example` |

The schema IDs are unregistered `.example` fixtures; schema fields and financial rules are unchanged. Consumers of these local schema IDs must update exact references. Workspace packages are private: update imports and use the pinned pnpm workflow; do not publish packages or introduce compatibility packages. Python callers must import the canonical module. No legacy Python import shim is installed.

Only local synthetic audience fixtures change. Issuers, JWKS locations, approved client IDs and token-validation policy remain unchanged. Historical audience values are explicitly rejected under canonical test configuration. No real issuer/audience/client registration is inferred, renamed or accepted as an alias. Synthetic assurance remains `not-established`, never real MFA or privileged approval.

## Preserved identifiers and controlled follow-up

| Preserved value | Intended canonical value, if separately approved | Required controlled procedure |
| --- | --- | --- |
| `nukhabapay_dev` | `nukhbapay_dev` | Explicit target approval, inventory sessions/dependencies, verified backup and restore rehearsal, maintenance plan, connection/configuration updates, migration-history and privilege checks, rollback plan. No database rename in this task. |
| Schema `nukhabapay`, custom settings `nukhabapay.*`, and schema-migration table location | Canonical namespace only under a future reviewed migration | New numbered migration plus coordinated repository/query/configuration/RLS changes; verify policies, grants, search paths, functions, default privileges and recovery on disposable targets. Never edit registered migrations or recorded history. |
| `nukhabapay_migrator`, `nukhabapay_runtime`, `nukhabapay_importer`, `nukhabapay_identity_reader`, `nukhabapay_identity_writer` | Corresponding `nukhbapay_` roles only if separately approved | Reviewed provisioning/credential transition, explicit minimum grants, no inheritance or aliases as authority, workload rollout and hostile-role regression. Existing roles and grants remain authoritative. |
| Disposable database names beginning `nukhabapay_` and target guards in registered 005 | No immediate rename | Retain compatibility with frozen migration target checks and cleanup ownership guards. Naming alone never authorizes a destructive target. A future change needs reviewed target validation, not a relaxed guard. |
| Compose project `nukhabapay-local` and its existing volume namespace | `nukhbapay-local` | Inventory actual containers/volumes and data ownership, backup/restore, explicitly preserve or migrate volume bindings, test recovery before changing project name. Do not run `up`, `down`, or volume deletion as a naming operation. |
| Existing checkout `nukhabapay` inside `NAUKHBAPAY AI` | Optional `nukhbapay` checkout locator | Stop local processes; coordinate IDE/OneDrive/workspace ownership and backup paths, relink dependencies and rerun checks after an explicitly approved relocation. Current documentation uses repository-relative paths; the physical locator remains valid. |
| Container bootstrap keys `NUKHABAPAY_DB_MIGRATION_PASSWORD`, `NUKHABAPAY_DB_RUNTIME_PASSWORD` | Canonical host inputs already use `NUKHBAPAY_DB_*` | Compose explicitly maps canonical host input names to the fixed container keys consumed by preserved bootstrap SQL. Change the container contract only with separately reviewed bootstrap SQL; do not reinitialize existing storage. |
| Old environment input names in private local configuration | Corresponding `NUKHBAPAY_*` keys | Authorized owner updates key names in the local secret store without sharing values. No secret files are edited here. `DB_*`, `IDENTITY_*` and existing restricted-role values stay unchanged. |
| Any registered Auth0 issuer, tenant domain, audience, client ID or provider resource ID | No invented replacement | Inventory with the authorized owner; obtain region/commercial/security approvals; stage separately reviewed configuration and exact trust tests. Never silently alias old and new issuers/audiences. No authentication or business-provider resource was contacted or changed. |

For future unprovisioned Auth0 display names, use **Nukhbapay Staff Pilot** and environment-qualified Nukhbapay API/application labels. `urn:nukhbapay:staff-api` is only a proposed audience for administrator review, not a configured or approved trust value. All existing management gates remain PENDING.

## Source paths renamed

Six maintained files move from `apps/ai-service/src/nukhabapay_ai/` to `apps/ai-service/src/nukhbapay_ai/`, preserving their relative paths:

- `__init__.py`
- `anomalies/README.md`
- `api/README.md`
- `gateways/model_gateway.py`
- `matching/guard.py`
- `schemas/catalog.py`

`docs/security/naukhbapay-staff-login-blueprint.mds` becomes `docs/security/nukhbapay-staff-login-blueprint.mds`. Its existing `.mds` format is preserved.

## Recovery and verification

Git is unavailable; no repository/history rewrite, remote or system software installation is introduced. The prior reviewed checkpoint and tested-code hashes were verified. The new checkpoint is `../recovery-checkpoints/before-naming-standardization-20261112T094423Z.zip`, SHA-256 `1d8022b3daa28fb26499cf7c26f93fe7d62f3094e421c50e0e2fe030e94e13de`, with 223 maintained files and a verified manifest. Environment files, credentials, databases, dependencies and generated artifacts are excluded. Existing database/security evidence remains separately preserved.

Final commands/results, non-disposable migration history, privilege checks, cleanup and the exact changed-file inventory are recorded in the latest progress/verification entry and sibling `naming-standardization-*` evidence. Do not infer test success from this procedure description.

Operational MFA, accepted privileged approvals, APPLY, real staff onboarding and reserved permissions remain blocked. No deployed route, provider integration or normal-runtime grant is added. This increment authorizes no subsequent Brick 3 work.

## Exact maintained-file change inventory

Generated against the verified pre-rename checkpoint; source hashes and complete old/new mappings are in `../recovery-checkpoints/naming-standardization-changes.json`. The seven renamed files above are included here. Verification-only helpers and evidence are outside the repository.

- MODIFIED: `.env.example`
- MODIFIED: `ARCHITECTURE.md`
- MODIFIED: `README.md`
- MODIFIED: `apps/ai-service/README.md`
- RENAMED: `apps/ai-service/src/nukhbapay_ai/__init__.py` (from `apps/ai-service/src/nukhabapay_ai/__init__.py`)
- RENAMED: `apps/ai-service/src/nukhbapay_ai/anomalies/README.md` (from `apps/ai-service/src/nukhabapay_ai/anomalies/README.md`)
- RENAMED: `apps/ai-service/src/nukhbapay_ai/api/README.md` (from `apps/ai-service/src/nukhabapay_ai/api/README.md`)
- RENAMED: `apps/ai-service/src/nukhbapay_ai/gateways/model_gateway.py` (from `apps/ai-service/src/nukhabapay_ai/gateways/model_gateway.py`)
- RENAMED_AND_MODIFIED: `apps/ai-service/src/nukhbapay_ai/matching/guard.py` (from `apps/ai-service/src/nukhabapay_ai/matching/guard.py`)
- RENAMED: `apps/ai-service/src/nukhbapay_ai/schemas/catalog.py` (from `apps/ai-service/src/nukhabapay_ai/schemas/catalog.py`)
- MODIFIED: `apps/ai-service/tests/test_matching.py`
- MODIFIED: `apps/api/README.md`
- MODIFIED: `apps/api/package.json`
- MODIFIED: `apps/api/src/local-api-runtime.ts`
- MODIFIED: `apps/api/src/modules/identity/README.md`
- MODIFIED: `apps/api/src/modules/identity/access-token-verifier.ts`
- MODIFIED: `apps/api/src/modules/identity/authentication.guard.ts`
- MODIFIED: `apps/api/src/modules/identity/authorization.guard.ts`
- MODIFIED: `apps/api/src/modules/identity/identity-boundary.ts`
- MODIFIED: `apps/api/src/modules/identity/internal-staff-access.ts`
- MODIFIED: `apps/api/src/modules/identity/oidc-access-token.verifier.ts`
- MODIFIED: `apps/api/src/modules/identity/staff-request-context.ts`
- MODIFIED: `apps/api/src/modules/identity/synthetic-assurance-verifier.ts`
- MODIFIED: `apps/api/test/access-token-verifier.spec.ts`
- MODIFIED: `apps/api/test/fixtures/approval-intake-acceptance.ts`
- MODIFIED: `apps/api/test/fixtures/approval-provenance-acceptance.ts`
- MODIFIED: `apps/api/test/fixtures/disposable-iam-database.ts`
- MODIFIED: `apps/api/test/fixtures/durable-request-acceptance.ts`
- MODIFIED: `apps/api/test/fixtures/oidc-test-issuer.ts`
- MODIFIED: `apps/api/test/fixtures/receipt-reader-acceptance.ts`
- MODIFIED: `apps/api/test/fixtures/synthetic-assurance-provider.ts`
- MODIFIED: `apps/api/test/fixtures/trusted-actor-acceptance.ts`
- MODIFIED: `apps/api/test/fixtures/workflow-read-acceptance.ts`
- MODIFIED: `apps/api/test/identity-guards.spec.ts`
- MODIFIED: `apps/api/test/internal-staff-access.integration.ts`
- MODIFIED: `apps/api/test/local-api-runtime.integration.ts`
- MODIFIED: `apps/api/test/migration005.integration.ts`
- MODIFIED: `apps/api/test/staff-http.integration.ts`
- MODIFIED: `apps/worker/package.json`
- CREATED: `docs/adr/0021-canonical-project-naming.md`
- MODIFIED: `docs/build-sequence.md`
- MODIFIED: `docs/data-model.md`
- MODIFIED: `docs/governance.md`
- MODIFIED: `docs/governance/pending-management-approvals.md`
- CREATED: `docs/naming-standardization.md`
- MODIFIED: `docs/progress.md`
- MODIFIED: `docs/project-structure.md`
- RENAMED_AND_MODIFIED: `docs/security/nukhbapay-staff-login-blueprint.mds` (from `docs/security/naukhbapay-staff-login-blueprint.mds`)
- MODIFIED: `docs/security/requirements.md`
- MODIFIED: `docs/verification.md`
- MODIFIED: `infra/local/README.md`
- MODIFIED: `infra/local/compose.yaml`
- MODIFIED: `package.json`
- MODIFIED: `packages/application/README.md`
- MODIFIED: `packages/application/package.json`
- MODIFIED: `packages/application/src/catalog/README.md`
- MODIFIED: `packages/application/src/identity/synthetic-assurance.ts`
- MODIFIED: `packages/contracts/package.json`
- MODIFIED: `packages/contracts/public/catalog-product.schema.json`
- MODIFIED: `packages/contracts/public/quote.schema.json`
- MODIFIED: `packages/database/README.md`
- MODIFIED: `packages/database/package.json`
- MODIFIED: `packages/database/src/durable-staff-request-store.ts`
- MODIFIED: `packages/database/src/pool.ts`
- MODIFIED: `packages/database/src/staff-workflow-reader.ts`
- MODIFIED: `packages/database/src/synthetic-receipt-reader.ts`
- MODIFIED: `packages/database/test/catalog-import.spec.ts`
- MODIFIED: `packages/domain/package.json`
- MODIFIED: `packages/provider-adapters/package.json`
- MODIFIED: `packages/provider-contracts/package.json`
- MODIFIED: `pnpm-lock.yaml`
- MODIFIED: `scripts/check_structure.py`
- MODIFIED: `scripts/import-synthetic-catalog.ts`

Final spelling audit: 226 maintained/template files checked, 1,449 retained references explicitly classified, no unclassified legacy spelling or legacy maintained filename. All 1,758 original references have a recorded classification. Frozen migration CLI schema locations are preserved compatibility contracts. Dependency tarballs were fetched from the package registry as recorded in verification; no authentication or business-provider service was contacted.
