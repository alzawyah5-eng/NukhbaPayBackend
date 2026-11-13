# ADR 0007: Isolated staff access-token verification foundation

Status: accepted and implemented for local synthetic Brick 3B-1 only
Date: 11 November 2026

Follow-on status: the separately authorized local Brick 3B-2 integration is recorded in ADR 0008. The verifier now attests an opaque shared application identity contract after the same cryptographic checks, and an internal function connects it to restricted repositories and the self-only policy. Brick 3B-3 adds global HTTP guards and test-only acceptance in ADR 0009. The original 3B-1 scope/evidence below remains historical; real provider setup and production authentication remain unconfigured.

## Scope

Add an isolated provider-independent `AccessTokenVerifier` contract and a pinned `jose` 6.2.17 implementation under `apps/api/src/modules/identity`. The owner accepted Auth0 as the preferred direction for a staff-only non-production pilot, conditional on region, residency, commercial and operational verification. That does not approve provisioning, a deployed trust configuration or production authentication.

The verifier is not imported into API bootstrap, controllers or guards. The deployed API still has only the public process-liveness route. No local staff resolution, database connection, enrollment, permission activation, browser login or external account is introduced. Bricks 3B-2, 3C and 4 require separate approval. ADR 0006 and its restricted database roles remain unchanged.

## Verification policy

- Explicit development/test configuration is required. Production is rejected. There is no fallback issuer, audience, client, key set or signing algorithm.
- Use `jose.jwtVerify` and `createRemoteJWKSet`, never custom signature cryptography. The initial algorithm allowlist is explicitly RS256 only; RSA public keys must have a 2048–4096 bit modulus.
- Accept the deliberately narrow `rfc9068-staff-v1` profile: exact `typ=at+jwt`, required issuer, subject, audience, expiry, issuance time, token ID and `client_id`. Require an approved client and a configured namespaced signed principal-kind claim equal to `human`. Reject incompatible `azp`/`gty`, delegation and agent-profile claims. This is not a universal adapter for every OIDC access-token format.
- The actual provider must later be configured and demonstrated to emit this human-token profile correctly. A signed human claim is provider evidence, not local staff enrollment or a membership grant. Standard ID tokens, machine tokens and different profiles do not qualify.
- Require exact approved issuer and API audience membership. Configuration uses canonical HTTPS URLs for issuer/key endpoint/claim namespace; the issuer and key endpoint must share an origin. No URL credentials, query, fragment, non-default port, IP literal, localhost or `.local` destination is allowed. API resource identifiers must use HTTPS or URN syntax. Configured values never come from unverified token fields.
- Token/header input is bounded to an 8192-byte ASCII Authorization value, with the Bearer prefix included. Raw-header parsing detects duplicates that Node normalized headers can hide. The compact token has exactly three nonempty base64url segments; whitespace, unsigned/encrypted/opaque forms and oversized input reject.
- Require integer nonnegative NumericDates, positive expiry/issuance ordering, nominal lifetime and maximum age at most 300 seconds, optional not-before before expiry, and clock tolerance at most 30 seconds. Library verification enforces time, signature and standard claims; additional profile checks only narrow acceptance.
- Token-provided key URLs, embedded keys/certificates and unsupported critical/header extensions reject before key lookup. The only destination is the explicitly configured HTTPS JWKS URL. Runtime discovery is deferred; an authorized administrator must later obtain and approve the exact discovery issuer and JWKS location.

## Bounded key retrieval

One resolver per verifier instance uses a five-minute cache, thirty-second successful-fetch cooldown and failure backoff, and a three-second deadline by default. Configuration bounds these values. Concurrent validations coalesce fetches. The same abort deadline covers transport and streamed body reading, even when a test transport ignores cancellation.

Only an HTTP 200 JSON public-key response is accepted. Redirects, changed response destinations and credentials are prohibited. Decompressed response size is capped at 64 KiB, with at most 1024 chunks and 32 keys. Empty, malformed, private/symmetric or ambiguous matching key material fails closed. Key selection/import/signature checking remain library operations.

Fresh cached keys may verify during an outage. Expired cache entries cannot be used indefinitely. Unknown keys reject after a successful refresh without a match; failed retrieval without usable trusted material reports `KEYS_UNAVAILABLE`. Known-key invalid signatures do not trigger a refresh loop. Rotation, overlap, removal and cooldown are tested with virtual time. Emergency key revocation still needs a future operational cache-invalidation procedure; there is no immediate provider-wide revocation guarantee.

## Output, failure and testing boundaries

Output is an immutable issuer/subject pair and a frozen allowlisted security object: approved audience/client/profile, signed human kind, issuance/expiry and `assurance=not-established`. Raw token, token ID, email, roles, scopes, arbitrary claims and unmapped MFA/authentication-time assertions are not returned. No log statements or underlying error causes retain bearer input or upstream response details.

Errors expose only `MISSING_CREDENTIALS`, `INVALID_TOKEN` or `KEYS_UNAVAILABLE` with fixed messages. A future HTTP adapter may map these to 401/503; this increment adds no HTTP behavior. Verification alone grants no application authority. Brick 3B-2 must still resolve the exact issuer/subject through active server-side staff/membership and deny-by-default policy; no reserved permission is activated here.

Tests use ephemeral library-generated RSA keys in memory, reserved synthetic HTTPS names, injected transport and clock, and no real network requests or external accounts. Injection is a constructor dependency, never a request field, environment-selected test issuer, runtime fallback or deployed login bypass. No private signing material is written to disk.

## Consequences and remaining gates

`jose` is pinned only in the API package and workspace lockfile; no unrelated dependency version changed. The existing API/application/database boundaries and recovery fixes are preserved. Actual Auth0 issuance, signed human admission, MFA/passkeys, lifecycle, trusted discovery, DNS/egress, rate controls, administrative ownership and environment isolation still need provider/deployment verification. HTTPS/name validation does not replace deployment network controls against DNS changes or a compromised approved host.

Migration 004 remains unapplied to development. Destructive PostgreSQL acceptance was not rerun in this increment. The local source archive procedure was used because Git remains unavailable; existing backups were verified and preserved. See `docs/verification.md` for exact commands, results and non-claims.

## Sources reviewed

- [jose maintained versions and verification API](https://github.com/panva/jose)
- [Pinned 6.2.17 package](https://github.com/panva/jose/tree/v6.2.17)
- [JWT verification options](https://github.com/panva/jose/blob/v6.2.17/docs/jwt/verify/interfaces/JWTVerifyOptions.md)
- [Remote JWKS implementation](https://github.com/panva/jose/blob/v6.2.17/src/jwks/remote.ts)
- [Auth0 access-token profiles](https://auth0.com/docs/secure/tokens/access-tokens/access-token-profiles)
