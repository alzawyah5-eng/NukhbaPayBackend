# Implementation sequence

13 November 2026 registration (ADR 0024): the accepted migration 006 wrapper is registered in source history with exact manifest integrity and combined disposable 001–006 acceptance. Frozen 004/005 and reviewed SQL sidecars remain unchanged. No next brick or real login is authorized; applying 004–006 to development/shared targets remains prohibited.

12 November 2026 local Brick 3C foundation (ADR 0022, historical): minimal HTTPS staff BFF, default-disabled opaque-actor session lifecycle and audited disposable persistence. Real login/callback, provider trust, privileged execution and non-disposable migration activation are not started. Migration 006 was later registered by ADR 0024 but remains unapplied outside disposable acceptance.

12 November 2026 naming follow-on: ADR 0021 coordinates current package/module names and local synthetic fixtures. It adds no brick or staff capability. Previous evidence and fixed database identifiers remain unchanged; see [the naming register](naming-standardization.md). Stop for review after verification.

12 November 2026 latest increment: ADR 0020 implements gated synthetic approval intake and purpose-bound reconciliation. Valid synthetic attempts commit only blocked review/provenance/audit/receipt/outbox evidence; all approval/execution/MFA/permission/operational gates stay closed. Registered 004/005 and grants remain unchanged; distinct accepted approvals or repeated attempt-log states require a later reviewed schema. The next independently safe direct proposal is internal actor/version-bound server-session lifecycle and audited revocation persistence for Brick 3C, without browser/Auth0/real staff or privileged mutation. Accepted approvals require independently proven approved strong authentication and named approver authority before any activation. Stop for review.

12 November 2026 latest bounded implementation: ADR 0019 supplies secure internal detail/status/revision/review reads for existing synthetic participants. Explicit read policy, fresh actor/authority, owned operation/request/tenant binding, 34-column SELECT-only credentials, FORCE RLS, bounded opaque paging and committed audit are required. No deployment, real staff, accepted approvals, reserved permissions or migration application. The proposed next direct implementation is gated approval intake with atomic persistence/audit and blocked/rejected synthetic assurance; actual acceptance/execution remain blocked on independently proven approved MFA/approver trust. Do not start another reader or planning-only increment absent a demonstrated security need. Stop for review.

12 November 2026 current bounded step: registered migration 005 provides only durable non-authorized workflow artifacts on verified disposable targets (ADR 0018). Existing request/review/provenance/recovery tests use actual migration history. No accepted approval, APPLY, effective staff/grant mutation, real MFA, deployed endpoint or development migration. After owner review, the next proposed functional increment is internal actor-scoped request detail/status/review-history reads with explicit read authority and committed audit. Privileged/operational gates remain BLOCKED/PENDING; Brick 3 overall is incomplete and Brick 4 is not started. Earlier pending-schema statements below describe historical increments.

Day 4 bounded implementation (12 November 2026): ADR 0017 adds actor-bound immutable synthetic provenance and isolated signed test assurance, with disposable atomic persistence. Synthetic events are never operational MFA or accepted privileged approvals. Keep all reserved permissions/APPLY/staff mutation and external activation blocked; no deployed registration or development migration. Stop for review after this increment.

Latest functional increment: ADR 0016 durable local synthetic request versions, independent non-approved observations, atomic immutable audit/receipt/no-delivery outbox and recovery. Restricted credentials and additive schema are used only in disposable acceptance. No staff/grant mutation, approval acceptance, APPLY, reserved permission, runtime registration or development migration. Full Brick 3/operational activation remain incomplete; stop for owner review after verification.

Current bounded implementation: ADR 0015 restricted synthetic PostgreSQL receipt reader, integrated only in disposable acceptance through existing actors, explicit receipt policy and one-use query capabilities. No runtime/endpoint/migration/permission expansion. Existing trust/MFA/approval/privileged execution gates remain closed. Stop for review. Next functional proposal is local synthetic durable access-request submission/review, not another receipt preparation increment; actual approval/APPLY remains blocked.

Latest local actor/provenance increment: ADR 0014 implements opaque verified actor handles, fresh canonical staff/scope checks, immutable denied approval observations and explicitly scoped synthetic receipt acceptance. This does not activate any reserved permission or satisfy MFA/accepted-approval/privileged persistence requirements. Full Brick 3 and operational activation remain incomplete/BLOCKED. No migration or deployed endpoint changes; stop for owner review after verification.

## Current security amendment status — 11 November 2026

The latest owner authorization permits independently safe local Brick 3/3C code behind explicit gates; it supersedes older stop-after-design text, not security restrictions. ADR 0013 records completed non-authorized PostgreSQL tuple rehearsal and partial browser transport checks. Full migration 005, staff mutation, authenticated independent approval persistence and sensitive-action assurance remain BLOCKED. Browser/BFF login and operational identity activation remain BLOCKED. Brick 3 is incomplete; Brick 4 remains unstarted. No simulated approval, actor UUID or client MFA claim may satisfy these gates.

Do not register pending-migrations/005_staff_access_workflows.sql as the full privileged migration or apply it to development. Preserve 001–004 and the active staff.self.read-only policy. Next independent code can exercise connection-loss receipt reconciliation for non-authorized records; privileged coding/execution must satisfy ADR 0013's trustworthy authority, exact restricted privilege and atomic mutation acceptance gates.

## Handover status

### Brick 2B — persistent synthetic catalog import/read

**Complete for the tested local synthetic, complete-snapshot workflow.** It
persists snapshots and offers transactionally through approved mappings,
supports safe replay and internal reads, and uses distinct migration,
read-only runtime, and restricted importer roles. Its acceptance evidence is
recorded in `docs/verification.md`.

This is not an authenticated catalog API, delta-feed implementation, price
publication system, live-provider integration, or production-readiness claim.
Imports require pre-registered canonical products and approved mappings. These
limits remain in force; importer permissions must not be expanded as part of
the identity work.

The former milestone outline placed publication and customer reads before
identity. That ordering is superseded by the agreed handover below. Do not
start publication/customer catalogue endpoints until Brick 3 is complete.

## Brick 3 — trusted identity, tenant isolation, and authorization

### Brick 3A — provider-independent local foundation (complete)

Migration 004 and the application identity package implement exact staff
identity bindings, memberships, fixed scoped role/permission definitions,
separate platform/tenant grants, internal resolution operations,
deny-by-default pure authorization, forced tenant RLS, and bounded append-only
audit persistence. Real PostgreSQL acceptance uses disposable databases and
the restricted IAM reader/writer roles. This is not authentication: synthetic
issuer/subject values are internal test inputs only; no HTTP route accepts
them. The full scope, evidence, and limitations are recorded in
`docs/verification.md`.

The local identity-reader and audit-writer PostgreSQL roles are distinct from
the migrator, catalog runtime, and importer. The importer remains unchanged.
No staff/grant management operations or tenant-facing business endpoints were
added.

### Brick 3B-1 — isolated verifier foundation (synthetic acceptance complete)

The provider-independent verifier, strict non-production configuration, pinned `jose` adapter, bounded Bearer parsing and trusted JWKS handling are implemented. Synthetic ephemeral-key tests pass; real Auth0 issuance and operational behavior are unverified. ADR 0007 records the exact narrow token profile, security controls and limits. Migration 004 is still pending on development; no permission or business endpoint was added. Later 3B-3 guards consume the same verifier through explicit trusted dependencies.

### Brick 3B-2 — restricted IAM runtime and internal integration (complete locally)

The separately authorized increment adds IAM-only reader/writer configuration, runtime role checks, opaque verified identity and an audited application self-read operation. The API verifier feeds existing exact identity and membership resolution through an internal function; there is no endpoint or bootstrap registration. Only `staff.self.read` remains active. Synthetic crypto-to-real-PostgreSQL acceptance and existing catalogue/IAM regressions pass on verified disposable databases. Migration 004 remains pending on development. ADR 0008 and verification define the precise scope.

### Brick 3B-3 — global HTTP guards and test-only acceptance

The separately authorized increment installs global authentication and authorization in the common Nest factory. Only exact reviewed GET liveness is public. Protected handlers require explicit permission/scope/GET metadata and existing self-only policy plus committed audit. Missing metadata/services, inactive staff/membership/grants, cross-tenant scope, alternate methods and unreviewed public markers fail closed. The test controller is outside production source/AppModule. Synthetic HTTP acceptance uses ephemeral keys; integration uses generated disposable PostgreSQL with restricted roles. ADR 0009 and verification record the implementation, commands/results and limits. Default startup configures no identity services and still exposes only liveness. Stop after this increment; no external activation or subsequent brick is implied.

### Remaining Brick 3 work — provider/runtime activation (requires separate authorization)

Separately authorized pure command follow-on: immutable command/audit/receipt/idempotency contracts and deterministic test-only transaction/failure models are implemented (ADR 0012). All outcomes remain NOT_AUTHORIZED; no APPLY, adapter, database connection/migration, account or route is added. Stop after this increment. Proposed next work is a read-only persistence/transaction threat-model and migration acceptance specification; actual persistence/execution requires separate approval.

Separately authorized policy foundation: pure application lifecycle/approval/request-state planning and deterministic tests are implemented in ADR 0011. All results remain non-executable; current `not-established` assurance and inactive permissions are not bypassed. No workflow, account, migration, writer or endpoint is implemented. Stop after this increment. The next proposed bounded work is pure atomic command/audit/receipt contracts and in-memory failure/idempotency tests, without persistence or execution.

Separately authorized local lifecycle follow-on: `createLocalApiRuntime` composes synthetic verifier/IAM/guards, validates startup dependencies, exposes internal readiness and owns graceful cleanup. Only `disabled` and `local-synthetic` are accepted; enabled mode requires `.invalid` trust, loopback and injected synthetic transport. No external configuration, production mode, migration or route is activated. Brick 3B-4 was a read-only operational readiness report in conversation. ADR 0010 and verification record this local increment. Stop afterward; remaining operational activation below requires separate approval.

The token/identity/guard mechanisms below now exist locally through 3B-3;
their real-provider/deployment acceptance remains outstanding. After explicit
approval and deployment setup, establish one trusted staff caller
identity path at the API boundary and prove that it produces a server-derived
tenant-scoped authorization context. The first caller scope remains staff;
partners, customers, devices, and background services are deferred. The next
slice must:

1. Select and document a trusted identity provider/protocol before wiring
   token validation. Prefer a standard OIDC/OAuth authorization-server
   integration over custom credential or token-verification code.
2. Verify access-token signature and allowed algorithm, issuer, audience,
   expiry, and not-before claims using the selected provider's supported
   metadata/key-rotation mechanism. Reject missing or invalid credentials.
3. Resolve the verified `(issuer, subject)` to an active internal identity,
   tenant membership, and assigned role/permissions from trusted server-side
   data. Never take tenant ownership or permissions from request headers,
   query parameters, or body fields.
4. Apply deny-by-default authorization to a small internal/test operation and
   pass an explicit, verified principal/tenant context into its application
   use case. Keep transport authentication in `apps/api`, orchestration and
   narrow repository ports in `packages/application`, PostgreSQL adapters in
   `packages/database`, and financial rules in `packages/domain`.
5. Add only the persistence and least-privilege access required for identity
   lookup/membership if the selected design needs it. Keep importer grants
   unchanged. Do not add a customer-facing business endpoint in this brick.

### Acceptance tests

- Accept a valid token from the configured issuer and derive the expected
  internal subject, active tenant membership, and role.
- Reject absent, malformed, tampered, wrong-issuer, wrong-audience,
  expired, not-yet-valid, and disallowed-algorithm tokens. Verify signing-key
  rotation using trusted metadata/JWKS; reject unknown keys when refresh
  fails, and fail closed when no valid trusted verification material exists.
- Reject unknown, disabled, or revoked identities and inactive/revoked
  memberships. A caller-supplied tenant ID cannot substitute for or override
  the authorized tenant.
- Deny by default when no policy grants the requested operation. Verify
  allowed and denied role/action pairs and cross-tenant object access.
- Revoke membership or role access and verify the next authorization decision
  observes revocation within the documented cache/consistency behavior.
- Verify no business route is added and the liveness route remains
  unauthenticated and reports process liveness only. Exercise authorization
  through unit/integration harnesses rather than publishing a test business
  endpoint.
- Verify identity reads use the intended restricted database identity, if
  persisted lookup is used; migration/runtime/import identities remain
  distinct and importer permissions do not change.

### Open identity-provider decision

The proposed Auth0-managed OIDC option, comparison with self-hosted Keycloak,
first staff-only scope, tenant model, membership ownership, change-effect
targets, acceptance tests, and remaining prerequisites are recorded in
[`docs/adr/0005-trusted-identity-provider.md`](adr/0005-trusted-identity-provider.md).
The recommendation is **proposed, not approved or configured**. No identity
provider, issuer, API audience, client, or external account has been selected
or provisioned. Confirm the deployment environment, launch jurisdiction,
existing KissAux/NubbaPay identity systems, account lifecycle, and operational
ownership before implementation. Do not invent a local login, trust a tenant
header, accept unsigned/self-issued tokens, or write a custom token verifier
to bypass this decision.

**Exit:** only verified identities with active server-side tenant membership
and explicit permission can obtain a tenant-scoped application context;
invalid, revoked, and cross-tenant requests are denied. No business API is
published.

## Brick 4 — controlled price publication and authorized catalogue API

After Brick 3, introduce versioned pricing policy and publication records,
calculate a complete candidate from accepted catalog snapshots, and activate
it atomically through a narrowly authorized operation. Serve customer-safe
catalogue DTOs only from an active publication and enforce the Brick 3
principal, tenant, and authorization context. Keep provider costs, private
attributes, and internal evidence out of public responses.

Acceptance covers deterministic candidate calculation, incomplete/stale
input rejection, atomic activation and rollback, history/identity of
publications, authorization and tenant isolation, DTO schema and private-field
exclusion, and repeatable read behavior. No quotes, orders, payments, or
external funds movement are included.

### Implemented local Brick 4A boundary

ADR 0026 implements candidate generation and unregistered disposable draft persistence only. It is independently safe while Brick 3 operational activation remains blocked because it cannot approve, activate or expose a publication. Candidate results retain DRAFT/NOT_AUTHORIZED/activation-false markers, and no deployed endpoint or permission is added. Proposed migration 007 requires separate registration/deployment review.

The next Brick 4 increment must not silently turn these records into active prices. It requires an explicit Brick 3-derived publication permission, independently reviewed approval/assurance policy, atomic single-active-version transition, customer-safe projection and rollback/revocation semantics. Until those prerequisites exist, active/public catalogue work remains blocked.

## Later increments

- **Real provider integration:** only after provider contracts, data meanings,
  pricing rights, source freshness, egress controls, rate limits, and mapping
  review are established. AI matching remains advisory and cannot approve or
  publish uncertain mappings.
- **Authenticated quotes and CRM/device workflows:** only after Brick 3
  authorization is in place; define ownership, device revocation, staff roles,
  quote expiry/input binding, and approved rule versions before exposing them.
- **Payments and fulfillment:** separately define idempotency, uncertain
  outcomes, append-only balanced ledger, callbacks, outbox/inbox, and
  reconciliation, then independently review before live rollout.
- **Category and capacity expansion:** treat each new category/provider and
  scale target as separate contract, operational, and acceptance requirements.

Launch country/currencies, provider agreements, existing app/CRM stack, kiosk
hardware, licensed operating/funds-flow model, taxes, fees, and commissions
remain open business/operational decisions where applicable. None overrides
the Brick 3-before-Brick 4 ordering.
