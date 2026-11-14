# Nukhbapay

13 November 2026: the final [browser/BFF security structure gate](docs/security/browser-bff-boundary.md) is verified, closing the three-branch local integration blocker. Structure validation requires the existing installed Node/TypeScript workspace tools as well as Python; it installs nothing. Local development acceptance is GO. Real Auth0 login, persistent IAM and privileged staff operations remain disabled.

13 November 2026 Brick 4A: [ADR 0026](docs/adr/0026-draft-catalogue-publication-candidates.md) adds deterministic immutable catalogue publication **drafts** from explicit synthetic snapshots. Candidates are always non-authorized and cannot be activated. Proposed migration 007 is unregistered, disposable-only and unapplied to development. No public catalogue route, live provider, real staff permission, quote, order or payment was added.

13 November 2026 registration: [ADR 0024](docs/adr/0024-registered-staff-session-migration.md) registers the already accepted transactional migration 006 wrapper in local source history. The reviewed SQL sidecars and frozen 004/005 migrations are unchanged. `pnpm db:verify:sources` is connection-free; guarded `db:migrate` and combined acceptance accept only verified random disposable targets and now execute registered 001–006. Nothing was applied to `nukhabapay_dev`.

The local staff foundation remains default-disabled and synthetic. [ADR 0022](docs/adr/0022-local-https-staff-server-sessions.md) supplies the minimal HTTPS BFF and actor/version-bound sessions; ADR 0023 supplies authority invalidation and migration security. Real Auth0 login, accepted approvals, APPLY, real staff onboarding and financial execution remain disabled. See the [migration runbook](docs/security/migration-security-rehearsal.md), [session runbook](docs/security/staff-server-sessions.md) and current verification evidence.

Current project naming is **Nukhbapay** / **nukhbapay** (ADR 0021). Packages use `@nukhbapay/*` and Python uses `nukhbapay_ai`. Fixed database/resource identifiers and historical evidence are preserved; see [the naming register](docs/naming-standardization.md).

An incremental platform for AI-assisted catalog, provider comparison and pricing, with planned payment-app, CRM and kiosk clients.

**Status: local Bricks 1, 2A, 2B and 3A verified; Brick 3B-1/3B-2 synthetic/internal integration and Brick 3B-3 global HTTP guards implemented.** Migration 004 is tested on disposable databases but is not applied to `nukhabapay_dev`, whose history remains 001–003. The deployed application registers only process liveness; protected acceptance operations exist only in test bootstrap. Real identity services, client interfaces, live integrations and financial execution remain unimplemented. Auth0 is preferred conditionally and unconfigured. Browser login and Brick 4 have not started. See [verification](docs/verification.md) for actual evidence and limitations.

## Start here

Latest follow-on: [ADR 0020](docs/adr/0020-gated-staff-approval-intake.md) implements gated internal synthetic approval intake and authoritative blocked-evidence reconciliation. It reuses 005's non-approved review/provenance/audit/receipt/outbox profile without a migration or grant change. Real MFA, accepted approvals, APPLY, real staff/provider login and deployed staff endpoints remain disabled. See verification.md for exact evidence and limitations.

Latest follow-on: [ADR 0019](docs/adr/0019-secure-staff-workflow-reads.md) adds internal participant-scoped request detail/status/revision/review reads, separate default-deny read authorization, a SELECT-only disposable backend and committed audit. No new deployed route, normal-runtime grant, accepted approval, real MFA or staff mutation. Migration 004/005 remain unapplied to development; see the latest verification record for actual evidence.

Latest local increment: registered migration 005 now provides restricted, immutable synthetic staff request/revision/review/provenance persistence and atomic audit/receipt/no-delivery outbox on verified disposable PostgreSQL targets. Existing IAM/catalogue credentials gain no rights; accepted privileged approvals, APPLY and operational MFA remain blocked. Neither 004 nor 005 is applied to development. See [ADR 0018](docs/adr/0018-registered-restricted-staff-workflow-persistence.md) and the latest [verification](docs/verification.md); earlier increment descriptions below are historical.

Pure staff command/audit/receipt/idempotency contracts now accompany the policy foundation. Deterministic test-only transactions model replay, failures and uncertain acknowledgement; every result remains NOT_AUTHORIZED. No staff mutation, persistence, provider or endpoint is enabled. ADR 0012 and verification record the exact scope and limits.

The separately authorized staff lifecycle policy foundation now models requests, independent approval requirements and lifecycle transitions in pure application code. Every result remains non-executable; current assurance and permission restrictions remain unchanged. No staff workflow, database command or endpoint is enabled. See ADR 0011 and the latest verification record.

Global guards connect the existing verifier to Brick 3A's audited self-only operation through explicit trusted-code dependencies. Only exact reviewed GET liveness is public; missing permissions or services fail closed. The local runtime now composes verifier/IAM, checks internal readiness and owns startup/shutdown cleanup in explicit `local-synthetic` mode. It requires a `.invalid` issuer, loopback listener and injected synthetic JWKS transport. Default `disabled` opens no pools and rejects stray identity settings. The test-only controller remains excluded from deployment. Real provider/runtime activation, browser login and later bricks require separate approval. See ADRs 0007–0010 and verification. Root `pnpm.cmd api:build` and API tests build workspace dependencies first.

1. Read [ARCHITECTURE.md](ARCHITECTURE.md) for runtime boundaries, workflows and design decisions.
2. Read [docs/project-structure.md](docs/project-structure.md) for the actual file inventory.
3. Run the synthetic price demonstration.
4. Run the supplied financial and matching checks.
5. Follow [docs/build-sequence.md](docs/build-sequence.md) for the current brick order and acceptance conditions. Brick 2B is complete within its documented local synthetic scope; Brick 3's identity-provider decision remains proposed and unconfigured.

## Run the offline examples

Use Node.js 24.x and Python 3.11 or later. The offline examples use standard libraries and require no package installation. The API uses the pinned pnpm workspace dependencies in `pnpm-lock.yaml`.

The repository pins Node.js 24.22.2 in `.node-version` and pnpm in the root `package.json`. With Corepack available, install and verify the API using:

```powershell
corepack.cmd pnpm install --frozen-lockfile
corepack.cmd pnpm api:build
corepack.cmd pnpm api:typecheck
corepack.cmd pnpm api:test
```

Start the liveness-only API with `corepack.cmd pnpm api:start`. It binds to `127.0.0.1:3000` by default. Configuration is limited to `API_HOST` (an IP address literal) and `API_PORT` (1-65535). On other shells, invoke `corepack pnpm` instead of `corepack.cmd pnpm`.

## Run the local staff frontend

From the repository root, run `corepack.cmd pnpm staff:dev`. This single command builds the frontend, reuses or creates a localhost HTTPS certificate without changing Windows trust, and starts the fictional UI preview at `https://localhost:3001/preview/overview`. Browser trust requires a separate explicit certificate-trust step; do not bypass certificate warnings. Staff sign-in remains disabled.

```bash
node --experimental-strip-types scripts/demo.ts
node --experimental-strip-types --test packages/domain/test/*.test.ts packages/provider-adapters/test/*.test.ts
python3 -m unittest discover -s apps/ai-service/tests -v
python3 scripts/check_structure.py
```

Equivalent npm scripts: `npm run demo`, `npm test`, `npm run test:ai`, and `npm run check:architecture`. On systems where Python is named `python` or `py`, substitute that command.

The price demonstration compares three synthetic offers for one AE/AED digital gift card. It selects an eligible AED 97.00 provider, displays AED 102.00 total and computes AED 2.77 contribution under explicitly supplied illustrative costs. It does not determine actual tax treatment.

## Included versus planned

| Area | Current state |
| --- | --- |
| Exact AED money and pricing example | Implemented and runnable |
| Synthetic catalog adapters | Implemented and runnable |
| Hard product-equivalence guard and advisory provenance | Implemented and runnable; no model calls |
| Public schemas and private example economics | Supplied design contracts |
| Architecture, data model and decisions | Documented |
| API | NestJS bootstrap, reviewed public liveness, global deny-by-default staff guards, bounded JSON parsing and test-only protected HTTP acceptance; identity services unconfigured by default |
| Worker, CRM, kiosk and mobile applications | Boundaries and module READMEs only |
| Shared application use cases | Internal synthetic import/read, staff identity resolution, authorization and audit ports implemented; downstream use cases planned |
| Database migrations and repositories | Catalogue 001–003 applied locally; corrected IAM 004 tested on disposable PostgreSQL only |
| Transactional outbox | Planned |
| Local PostgreSQL/Redis containers | Optional configuration; not required by the examples |
| API framework dependencies, pnpm lockfile and strict TypeScript checking | Pinned and verified for the API package; worker framework remains unimplemented |
| Production hosting and external accounts | Not provisioned |

## Repository layout

`apps/` contains runtime and client boundaries. `packages/` contains reusable backend logic, contracts and infrastructure. `infra/` describes environment setup. `docs/` records architecture and operations. `tests/` reserves integration, contract and security suites.

The offline examples need no package install. API/database/application dependencies are installed through the pnpm workspace and pinned by `pnpm-lock.yaml`; the pnpm workspace manifest also records package membership. No Git repository currently exists; the recovery used a reviewed local archive checkpoint. The Python AI project remains a separately managed runtime; add its dependency lock when model/HTTP dependencies are selected.

## Important limits

The TypeScript demonstration supports only the documented synthetic AED gift-card case. The Python guard supports gift-card and prepaid-airtime equivalence, not transfer, bill or ticket semantics. Model suggestions never grant financial authority. Node's native TypeScript execution does not perform a TypeScript compiler check. The liveness route checks no dependencies and establishes no production readiness.

Do not connect live credentials until identity, persistence, transaction integrity, provider-specific contracts and deployment controls are implemented and assessed.
