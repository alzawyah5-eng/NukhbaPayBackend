# ADR 0008: Restricted IAM runtime and internal verified staff authorization

Status: implemented and verified for local synthetic Brick 3B-2 only
Date: 11 November 2026

Follow-on status: the separately authorized Brick 3B-3 installs global HTTP guards using these unchanged ports/policy, with staff HTTP operations only in test bootstrap. See ADR 0009. The 3B-2 scope/evidence below is historical; no real provider, non-disposable migration or deployed staff endpoint is enabled.

## Scope and trust flow

Use the existing Brick 3B-1 signed-token verifier and Brick 3A repositories/policy through a narrow internal composition function. The running API still exposes only `/health/live`; no controller, guard, browser login, external account or production authentication is added. Only `staff.self.read` remains active. Migration 004 and role grants are unchanged and it remains unapplied to `nukhabapay_dev`.

```text
raw Authorization headers
  -> existing bounded parsing and jose verification
  -> opaque immutable VerifiedStaffIdentity
  -> existing exact issuer/subject lookup through restricted IAM reader
  -> current staff/membership/grant and object-scope checks
  -> existing deny-by-default policy and self-only operation gate
  -> committed bounded audit append through separate audit writer
  -> minimal internal self/membership summary
```

## Shared verified-identity contract

The provider-independent interface and evidence type now live in `packages/application/src/identity/verified-staff-identity.ts`, with a compiled `@nukhabapay/application/verified-identity` export. The API re-exports its types and attests the existing verifier output only after signature/claims/profile checks. A private nominal symbol and process-local WeakSet distinguish original adapter-created objects from structural casts, JSON round trips and clones. The attestation factory copies only allowlisted fields and freezes the result; no bearer, email, token role or arbitrary claim is retained.

The factory is an explicitly trusted-adapter API, not a token verifier or request-deserialization function. This protects against accidental input laundering, not malicious trusted application code. A legitimate object must remain in the same contract-module instance/process; do not serialize it as authentication proof. Future HTTP wiring must reverify each credential and must not call the factory on unverified claims. Existing `jose` cryptography, client/profile constraints and error behavior remain intact.

## IAM-only runtime initialization

`@nukhabapay/database/identity-runtime` exposes `parseIdentityRuntimeConfiguration` and explicit async `createIdentityRuntime`. Neither reads catalogue runtime/importer, migration or test-administrator credentials. It requires only the two IAM URLs and optional bounded settings. Pools retain the existing reader read-only session setting, separate writer session, timeouts and transactional tenant context.

The local parser requires loopback host, matching host/effective port/database, non-system database, a password-bearing PostgreSQL URL without query/fragment, and exactly the existing reader/writer workload roles. Arbitrary or privileged role-name overrides reject. Credentials are nonenumerable and ordinary inspection is redacted. Validation errors contain field names only. Production/remote configuration is deliberately not implemented.

Initialization checks each actual login's identity, LOGIN capability, no superuser/database creation/role creation/inheritance/BYPASSRLS/membership/schema-CREATE/database ownership, and closes both pools if verification fails. It returns only repository, audit writer and an idempotent close function; no migration, provisioning, role change or schema mutation runs. Effective column privileges and RLS are verified by disposable PostgreSQL acceptance; startup role checks are not a complete continuous ACL monitor. All underlying initialization/authorization failures are sanitized without retained causes or URLs.

## Internal operation and audit policy

`readAuthorizedStaffSelf` accepts only the opaque verified type and checks runtime provenance and evidence expiry before lookup. It derives time from a trusted clock, not request metadata. It performs a fresh exact `(issuer, subject)` lookup on every call, rejects unknown/inactive identities and staff, and never links by email or enrolls anyone.

A requested tenant is only a scope to validate. Scoped self summaries require active server-side membership and matching supplied object scope. A self read needs no department role; revoking a catalogue role does not itself revoke the active person's own identity read. Tenant business requests still evaluate grants through the existing policy and remain denied: expired/revoked grants, platform-only grants, wrong scope and inactive reserved permissions cannot authorize tenant data. A final self-only gate prevents this function expanding if a future policy phase changes. Object ownership inputs must come from trusted application logic, never a client's assertion of ownership; no business-object operation exists here.

Allow requires successful audit transaction commit before any self summary is returned. Audit writer failure throws sanitized `AUDIT_UNAVAILABLE`; reader failure throws `IDENTITY_UNAVAILABLE` and attempts bounded dependency-failure evidence. An already-denied request stays denied if auditing is unavailable, with `auditRecorded=false` for bounded operational telemetry. No free-form error, token or reason enters audit persistence. Audit action/outcome/reason fields reuse the existing vocabulary; no schema permission or metadata field was added.

There is no positive authorization cache. Public signing-key caching remains the existing bounded verifier behavior. Committed local suspension is observed on the next call, even with the same bearer. Only internal read decisions are implemented: status/grant lookup and audit use separate restricted connections, not one atomic privileged-write transaction. Authorization serialization for future sensitive writes remains deferred. Assurance remains `not-established` and unused `tokens_valid_after` is not presented as session revocation.

## Package integration and tests

Application/database packages export their compiled backend entry points. The API depends on the application package and uses the database/pg packages only as test dependencies in this increment. Root API build and API tests build workspace dependencies before compilation, avoiding cross-package API source imports and duplicate verified-identity module instances. Existing source/package ownership and financial code are preserved; no dependency version was upgraded or downloaded.

Pure tests cover opaque provenance, minimal self reads, inactive staff/membership, missing/reserved permission and inactive grants, failure behavior and no positive cache. The separate `test:identity:integration` command runs the complete synthetic cryptographic-verifier-to-real-repository path on a uniquely named disposable database. It requires explicit test configuration and has no skip fallback. Existing API tests remain non-destructive and retain all 24 verifier tests.

The disposable fixture verifies the maintenance target and role flags before creation, migrates only its generated target using the migrator, seeds synthetic IAM data using the test administrator, executes ordinary operations with IAM reader/writer, and verifies target ownership/sessions before dropping only the database it created. Full previous catalogue/IAM acceptance, financial and advisory tests were also rerun. See verification for commands, actual target names and outcomes.

## Remaining gates

Auth0 remains conditionally preferred and unconfigured. Real token issuance/human-claim policy, onboarding, region/residency, MFA/recovery, operational ownership, secret handling, TLS/egress/rate limits, audit monitoring/export, production database authentication and any non-disposable migration remain PENDING. Local PostgreSQL trust authentication is unchanged. Successful synthetic integration is not deployed authentication or production readiness. Brick 3B-3, 3C and 4 require separate approval.
