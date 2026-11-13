# identity

13 November 2026: the existing application resolver enforces persisted tokens_valid_after against the original verified signed issuance evidence. Stale or unavailable IAM state still fails closed; session freshness reuses this boundary. The additive version/cutoff trigger contract is tested only in combined candidate migration rehearsal. No live-provider mode, approved MFA or privileged execution is enabled by these corrections (ADR 0023).

Local lifecycle follow-on: `local-api-runtime.ts` composes these ports with restricted IAM using trusted dependencies. Enabled synthetic startup checks config/keys/schema before application initialization. Verifier `checkReadiness()` uses bounded key retrieval/cache and existing public-key validation without accepting a token; `close()` cancels active retrieval and prevents reuse. No real provider or new route is enabled. See ADR 0010.

Status: Brick 3B-1 verifier, Brick 3B-2 internal IAM/self authorization and Brick 3B-3 global HTTP guards implemented. Guards are registered by the common API factory; real identity services remain unconfigured. Only liveness is deployed. Protected staff acceptance controllers exist only under test bootstrap, with synthetic identities and disposable restricted IAM connections. No enrollment is added.

Verify authentication, resolve tenant/merchant/device context, enforce roles and permissions. Authentication headers never directly become trusted context without verification.

Use cases live in `packages/application`. This module will own controllers, request DTOs and dependency wiring, rather than duplicate business rules.

## Current foundation

`access-token-verifier.ts` re-exports the shared provider-independent contract/evidence and defines fixed failure codes. `oidc-access-token.verifier.ts` uses pinned `jose` 6.2.17. `authorization-header.ts` handles bounded Bearer parsing and duplicate detection from raw headers. `identity.config.ts` requires explicit non-production trust. `trusted-jwks.ts` bounds key retrieval, cache/rotation and failures. These controls are reused without new cryptographic validation by the global guards; no real trust values or pools are automatically configured from process environment.

## HTTP boundary

`authentication.guard.ts` verifies raw-header credentials and requires the original opaque verifier output. `authorization.guard.ts` calls the unchanged application self operation and requires committed audit before allowing a handler. `staff-request-context.ts` keeps verified/authorized results in private per-request WeakMaps; client identity or tenant fields cannot write that state. `identity-boundary.ts` defines explicit trusted-code dependencies for composition. Missing services fail closed.

`route-security.ts` requires explicit method-level permission, scope and GET metadata. `reviewed-public-route.ts` honors a public marker only for the exact health class/handler/path and GET method. HEAD does not inherit GET authority, route aliases retain guards, OPTIONS/unmatched paths return generic 404 and method-override headers do not grant access. Only self read is active. Missing metadata denies through the existing audited policy; there is no wildcard or administrator override. Requested tenant scope is checked against server membership and independently resolved object ownership, never accepted as ownership evidence.

Errors use fixed 401/403/503 responses (and generic 400/404 where applicable), no-store and a Bearer challenge on 401. Required reader/writer/JWKS failure never executes a protected handler. A denial with failed audit remains denied and emits only a fixed warning. The deployed `AppModule` registers no staff controller. See ADR 0009 for exact method/public rules, composition and remaining deployment limits.

The initial profile is `rfc9068-staff-v1`, RS256, `typ=at+jwt`, approved `client_id`, required standard claims and a configured signed principal-kind claim equal to `human`. It deliberately rejects default Auth0/ID-token profiles, unapproved clients, non-human/delegated/agent profiles and token-provided trust material. Actual Auth0 emission of this profile is unverified; an authorized administrator must approve and demonstrate it before integration.

The verifier returns exact issuer/subject plus allowlisted security evidence only. It does not return raw tokens, email, permissions or arbitrary claims. Assurance remains `not-established` even if unmapped MFA claims are present. Verification grants no local staff or tenant access.

## Configuration contract

Brick 3B-2 moves the interface/evidence type to the shared compiled application contract and adds opaque runtime provenance after verification. `internal-staff-access.ts` composes raw-header parsing, the existing verifier, and `readAuthorizedStaffSelf` through injected restricted repository/audit ports. It opens no pools, registers no routes, and performs no enrollment. The separately authorized local lifecycle factory now owns explicit runtime creation, and database is an API runtime workspace dependency. A JSON clone of verifier output is not trusted identity.

The local operation requires current active staff/identity and, for requested tenant summaries, active matching membership. Department/tenant permissions remain inactive. Allow-audit failure prevents successful output; already-denied requests remain denied with a bounded audit flag. No authz cache or platform-to-tenant inheritance is added. Run the separate `pnpm.cmd --filter @nukhbapay/api test:identity:integration` with explicit disposable-test configuration for real PostgreSQL acceptance; `pnpm.cmd api:test` preserves the ordinary non-destructive verifier/API suite. See ADR 0008.

All required values below must be supplied explicitly to `parseIdentityConfiguration` or the verifier constructor. No live issuer, audience or client value is supplied by the project. Array values are JSON arrays of strings, not comma-separated input.

| Name | Requirement |
| --- | --- |
| `IDENTITY_ENVIRONMENT` | Required: `development` or `test`; production rejected |
| `IDENTITY_ISSUER_URL` | Required exact canonical HTTPS issuer, including its approved trailing slash/path |
| `IDENTITY_API_AUDIENCE` | Required exact HTTPS/URN API identifier, never a client ID |
| `IDENTITY_JWKS_URL` | Required approved canonical HTTPS key endpoint on the issuer's origin; discovery approval remains an administrator task |
| `IDENTITY_ALLOWED_ALGORITHMS` | Required JSON array containing only `RS256` |
| `IDENTITY_ALLOWED_CLIENT_IDS` | Required JSON array of 1–16 unique approved client IDs |
| `IDENTITY_TOKEN_PROFILE` | Required: `rfc9068-staff-v1` |
| `IDENTITY_STAFF_KIND_CLAIM` | Required canonical HTTPS claim namespace/path whose verified token value must equal `human` |
| `IDENTITY_MAX_TOKEN_AGE_SECONDS` | Default 300; allowed 30–300, also limits nominal lifetime |
| `IDENTITY_CLOCK_TOLERANCE_SECONDS` | Default 30; allowed 0–30 |
| `IDENTITY_JWKS_CACHE_MS` | Default 300000; allowed 1000–300000 |
| `IDENTITY_JWKS_COOLDOWN_MS` | Default 30000; allowed 1000–60000 and no greater than cache lifetime; also bounds failure retries |
| `IDENTITY_JWKS_TIMEOUT_MS` | Default 3000; allowed 100–5000 |
| `IDENTITY_JWKS_MAX_BYTES` | Default 65536; allowed 1024–65536 |

URL credentials, query/fragment, non-default ports, IP literals and local destinations reject. Canonical URL spelling is required, and issuer/audience matching does not normalize received claims. Private DNS/egress protection still requires deployment controls. No database, client secret, Management API token or signing private key is needed by the verifier.

`readBearerAuthorization` receives the server's raw header pairs in the authentication guard. `parseBearerAuthorizationHeader` rejects array/comma-joined credentials, ambiguous whitespace and non-JWT formats. Neither function reads cookies, query strings or request bodies. The final verifier output never contains the bearer input.

Errors are sanitized `MISSING_CREDENTIALS`, `INVALID_TOKEN` and `KEYS_UNAVAILABLE`; no underlying cause or response details are retained. `createRemoteJWKSet` maintains a bounded cache and coalesces fetches. Fresh trusted keys can work during an outage; missing/expired verification material cannot. Redirects, private key material, invalid key strength and oversized/empty key sets are rejected. Constructor transport/clock injection is only a code dependency for tests; no environment variable enables a synthetic issuer or bypass.

See ADRs 0007–0009 and the latest verification record. The 3B-3 authorization covers global guards and local test-only acceptance only. Browser login, real provider/runtime activation, staff/business endpoints and Brick 4 remain deferred and require separate authorization.

