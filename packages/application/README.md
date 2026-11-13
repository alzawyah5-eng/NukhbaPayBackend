# Shared application use cases

Brick 4A adds `generateDraftPublicationCandidate`, a pure deterministic use case over explicit COMPLETE snapshot/offer evidence. It reuses domain bigint pricing and produces only immutable DRAFT/NOT_AUTHORIZED candidates; structural copies are not accepted by the local persistence bridge. `classifyAdvisoryPublicationEvidence` records model output as advisory-only and cannot affect arithmetic or authority. See ADR 0026.

The next pure foundation adds staff command candidates, fixed audit intents, simulation receipts, scoped idempotency/lookup contracts and erased transaction ports (ADR 0012). They retain NOT_AUTHORIZED and all assurance/phase blockers. Transaction orchestration exists only in test fixtures and records intent tuples without staff mutation. A simulation receipt is neither authorization nor durable staff/audit evidence. No database/provider calls, APPLY or runtime adapter is added.

The pure staff lifecycle foundation adds `planStaffLifecycle`, `proposeAccessRequestTransition`, typed operations/requests/approvals and `classifyLifecycleGrant`. These produce immutable non-executable proposals only: every result is NOT_AUTHORIZED with assurance/phase/executor blockers, and APPLY is unavailable. Standard-library `accessChangeRequestDigest` binds versioned intent but is not approval proof. No repository, provider, audit write or account is created. Inputs must be complete trusted snapshots; future execution needs independent identity/assurance verification and locked state. See ADR 0011 and verification for exact delegation, state graph, deterministic tests and persistence gaps.

The package contains framework-independent orchestration and narrow persistence/provider ports. The synthetic catalog import accepts an explicit internal tenant and provider-account context; it is not exposed as an unauthenticated API.

The importer consumes the normalized `CatalogProvider` and `ProviderOffer` contracts from `packages/provider-contracts`. PostgreSQL implementation details remain in `packages/database`; financial-domain code has no persistence or network dependency.

Run `pnpm.cmd application:build` and `pnpm.cmd application:typecheck` from the repository root to compile the application package. The local complete-snapshot example is `pnpm.cmd catalog:import:synthetic`; see `packages/application/src/catalog/README.md` for prerequisites.

The internal `identity/` module contains the provider-independent Brick 3A
staff identity and authorization boundary: exact trusted issuer/subject lookup
ports, staff/membership resolution, a fixed scoped permission catalogue,
deny-by-default decisions, and bounded security-audit input validation.
It does not authenticate callers or accept HTTP/header credentials. No
business routes or staff/grant management operations are exposed. Only
`staff.self.read` is active in Brick 3A; later-phase permissions remain
reserved and denied. Run `pnpm.cmd application:test` for the pure policy,
resolution, audit validation, and catalog-import tests.

Brick 3B-2 adds `readAuthorizedStaffSelf`: an internal operation accepting only the opaque process-local verified identity contract. It reuses exact identity resolution and the existing policy, reads active staff/membership every time, permits only `staff.self.read`, and requires a committed audit before returning minimal self data. Reader and allow-audit failures are sanitized and fail closed; a denied request remains denied with an audit-failure flag if persistence is unavailable. No local enrollment, email linking, positive permission cache, new active permission or HTTP endpoint is introduced.

The compiled `@nukhbapay/application/verified-identity` contract exposes an attestation factory only for trusted verifier adapters after signature/profile validation. Its nominal symbol and runtime provenance check reject JSON/plain-object impersonation; the factory is not verification and must never receive unverified request claims. Use a single package module instance and do not deserialize identity objects as proof. Unit tests mark their synthetic attestation explicitly; real integration tests obtain it through the existing jose verifier. See ADR 0008 for the trust and audit boundaries.
