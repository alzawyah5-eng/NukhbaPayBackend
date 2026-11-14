# Staff Auth0 integration: synthetic acceptance and activation boundary

2026-11-14, Asia/Dubai. Worktree `auth0-activation`, branch `brick3/auth0-activation`.

**Synthetic integration: GO for the tested fixture scope. Real development login activation: NO-GO.** The existing Auth0 development tenant and Regular Web Application are reused as the intended future configuration. No Auth0 account/application was created, inspected, changed or contacted. No real login or persistent session mode was enabled.

## Existing functionality retained

The existing BFF implements confidential Authorization Code Flow with S256 PKCE, Universal Login redirects, state/nonce/browser binding, one-use transactions, exact issuer/client/audience/callback checks, RSA signatures, bounded token/JWKS fetches, fresh signed MFA claims, fixed server-selected tenant resolution and no email linking. Local enrollment, staff/membership status and authority are checked independently of Auth0 claims.

The existing session lifecycle provides opaque 256-bit cookies, hash-only storage, fresh authority revalidation, identity/idle/absolute expiry, fixation-resistant rotation, replay denial, committed store outcomes, audited authorization, revocation and CSRF-protected logout. The React dashboard, supplied assets and isolated `/preview` branch remain in the existing application. No replacement dashboard or authentication project was created.

## Added functionality

- `GET /auth/config` returns only `{loginPath:"/auth/login"}` when trusted server composition supplies the existing login object, otherwise `{loginPath:null}`. It accepts no activation query/claim/environment switch. The default CLI continues to construct neither login nor identity/session adapters.
- `StaffSessionLifecycle.readProfile()` validates the server session/store, then rechecks branded actor evidence, authority binding and freshness before projecting only staff ID, server-selected tenant ID and absolute expiration. `GET /auth/me` exposes that projection plus a fixed self-only overview navigation capability. It never returns provider subject, email/contact information, token, cookie, authority digest or Auth0 role claims. Missing dependencies, unknown credentials, staff/tenant changes and audit/store failures deny.
- The existing React sign-in control uses only the explicit BFF login path and only from an anonymous state. The profile must load successfully after the CSRF/session check; any denial, malformed payload or outage clears the authenticated view. Navigation exposes only the implemented self overview. Direct management URLs show unavailable/unauthorized content and the BFF still exposes no management API. Backend authorization remains mandatory for every future operation.
- The browser rechecks on navigation and window focus and hides the session at its absolute identity/session deadline. It does not use background polling to keep an idle session alive. Idle/revocation enforcement remains server-side on each request; no instantaneous push notification of revocation is claimed for an idle open tab. A future protected-data request must handle 401/403/503 through this same fail-closed boundary.
- `readPendingAuth0Configuration()` validates server-only development configuration and derives its callback from the fixed listener. Returned configuration hides its secret from ordinary JSON/inspection. This parser is deliberately **not called by CLI composition**, so setting its environment variables cannot enable real login.
- `node scripts/test/run-staff-synthetic-tests.mjs` builds/tests the existing application with temporary one-day localhost TLS material, per-client certificate pinning, mocked Auth0 and in-memory repository/session fixtures. It clears inherited DB/libpq, Auth0 and TLS settings for the child tests, requires disabled persistent session mode, and removes its owned credential directory afterward. It installs no trust entry and never disables certificate verification. On Windows it uses the existing Git OpenSSL binary; Vite may require running outside the filesystem sandbox because of ancestor-directory probes.

Self-only navigation is not role-driven staff management. Backend staff-directory, role-management, payment, pricing, approval/APPLY and other privileged routes remain unavailable. The synthetic store proves application behavior; it is not evidence that PostgreSQL IAM/session persistence works.

## Configuration required from the existing Auth0 application

These are requirements for a future separately approved activation, not instructions to activate now. Reuse the existing development tenant/application; do not create another. Confirm the application type is Regular Web Application and use Auth0 Universal Login. The current confidential exchange submits credentials using `client_secret_post`; review that exact token endpoint authentication method for the existing application. Use Authorization Code with S256 PKCE; do not enable implicit/password grants or browser-held secrets. The code requests only `openid` and does not request offline access or accept refresh tokens.

Derived from `STAFF_PORTAL_PORT=3001` in `apps/admin-web/src/auth0-configuration.ts`, used by `src/main.ts`, and the fixed paths in `Auth0Login`:

| Setting / route | Exact URL |
| --- | --- |
| BFF origin | `https://localhost:3001` |
| Login initiation (BFF) | `https://localhost:3001/auth/login` |
| Allowed Callback URLs | `https://localhost:3001/auth/callback` |
| Allowed Logout URLs / fixed return target | `https://localhost:3001/auth/logged-out` |
| Local logout (CSRF-protected POST, not a callback allowlist entry) | `https://localhost:3001/auth/logout` |
| Current session / profile | `https://localhost:3001/auth/session` / `https://localhost:3001/auth/me` |

No wildcards, alternate host/IP aliases, trailing-slash variants, browser-supplied return targets or proxy-derived origins are accepted. The browser calls only the same-origin BFF; no cross-origin SPA token exchange/CORS configuration is required by this implementation. Tests use their actual ephemeral localhost port; those ports are not Auth0 Dashboard entries. Future environment/origin changes require a reviewed server configuration change and new exact provider allowlists.

Require an approved API audience and RFC 9068 access-token profile, RS256, `typ=at+jwt`, `client_id`, `jti` and the configured signed namespaced human-principal claim. Configure/review the existing application's trusted post-login claim policy; never derive staff authority from user-editable metadata. The current verifier accepts a **single exact audience**, no `azp` access-token profile and access tokens/token-response lifetimes no greater than 300 seconds. Real Auth0 may emit an additional userinfo audience: provider compatibility must be demonstrated later without relaxing validation here. Namespaced human classification does not enroll staff or grant roles.

Require mandatory MFA with an approved factor/recovery policy and evidence that the signed ID token contains `amr` including `mfa`, fresh `auth_time`, correct nonce and matching subject. `prompt=login`, `max_age=0` and a Dashboard policy alone do not prove the actual factor/claim contract. Missing MFA evidence denies. Privileged assurance remains `not-established` even after synthetic MFA acceptance.

Local session revocation must commit before the browser receives the fixed provider `/v2/logout` URL. That existing logout mechanism uses the public client ID and exact allowed `returnTo`; it does not claim upstream/federated logout if the browser/provider navigation fails. No secret or token is included in that URL.

Primary Auth0 references reviewed: [application settings](https://auth0.com/docs/get-started/applications/application-settings), [access-token profiles](https://auth0.com/docs/secure/tokens/access-tokens/access-token-profiles), [MFA configuration](https://auth0.com/docs/secure/multi-factor-authentication/enable-mfa), and [logout allowlisting](https://auth0.com/docs/authenticate/login/logout/redirect-users-after-logout). The stricter claim/lifetime rules above describe this repository's contract, not an assumption that Auth0 emits them by default.

## Server environment names (no secret values)

| Name | Purpose |
| --- | --- |
| `NUKHBAPAY_ENVIRONMENT` | Must identify development for the pending parser |
| `NUKHBAPAY_STAFF_AUTH0_ISSUER` | Exact canonical issuer from the existing tenant/application |
| `NUKHBAPAY_STAFF_AUTH0_CLIENT_ID` | Existing confidential Regular Web Application client |
| `NUKHBAPAY_STAFF_AUTH0_CLIENT_SECRET` | Server process-only secret injection; never React, VITE, source control or logs |
| `NUKHBAPAY_STAFF_AUTH0_AUDIENCE` | Exact reviewed staff API identifier |
| `NUKHBAPAY_STAFF_AUTH0_STAFF_KIND_CLAIM` | Exact namespaced trusted human-principal claim |
| `NUKHBAPAY_STAFF_AUTH0_TENANT_ID` | Server-selected **Nukhbapay tenant UUID**, not the Auth0 domain/tenant name |
| `NUKHBAPAY_STAFF_SESSION_MODE` | Remains `disabled`; CLI rejects all other values |
| `NUKHBAPAY_STAFF_TLS_PFX_PATH`, `NUKHBAPAY_STAFF_TLS_CERT_PATH`, `NUKHBAPAY_STAFF_TLS_PASSPHRASE` | Existing local HTTPS launcher inputs; passphrase is process-only |

No environment value is inferred from an incoming host/query/token, and no real client ID/issuer/audience/claim/secret was supplied or verified in this increment. Configuration preparation is not activation. Persistent `DB_IDENTITY_*` / `DB_STAFF_SESSION_*` provisioning remains blocked and is not selected by these names.

## Acceptance and blockers

Synthetic HTTPS/Auth0/browser-client suite: **25 passed, zero failed/skipped**. Covers successful confidential PKCE exchange; issuer/audience/signature/type/time/nonce/MFA failures; unknown, suspended and disabled identities; tenant denial; simulated identity DB/audit/session-store outages; rotation/fixation/replay; CSRF/logout/revocation; minimal profiles; hostile navigation and logout destinations; default CLI denial; real built-asset boundaries and preview isolation. Temporary TLS keys/PFX were removed. Build passed and the application regression suite passed **94 tests**, zero failed/skipped, including inactive permissions, cross-tenant isolation and session expiry/revocation behavior. The API regression suite passed **48 tests**, zero failed/skipped, including synthetic cryptographic verification, tenant/staff/permission gates, CSRF, outages and sanitized logs. Staff typechecks, structure checks, source-only migration verification and whitespace checks passed. The browser bundle contained no server-only Auth0 configuration names or confidential token-exchange code. These tests use mocked provider transport and synthetic repository/store ports; they are not real-provider or database integration acceptance. No interactive browser automation or screenshot/accessibility acceptance is claimed.

Real development login is **NO-GO** because:

1. The disposable source-profile security review remains NO-GO; its separate design/review documents remain preserved with the unfinished Track A database work and are excluded from the focused Auth0 integration commit. Do not implement that profile, change frozen 004–006/sidecars/manifests, bypass port guards, borrow port 5432 or apply persistent IAM migrations.
2. PostgreSQL IAM/session/restore acceptance is blocked; this increment launches no PostgreSQL runner and makes no persistent connection. The previously recorded 20-pass/1-fail result is historical evidence, not a fresh result or a passing prerequisite.
3. Real existing Auth0 issuer/client/audience/RFC9068/signed-human/MFA/token lifetime compatibility has not been demonstrated. The tenant/application exists per the owner, but its configuration has not been independently inspected or changed.
4. Trusted production/development composition, approved IAM enrollment and persistent audited session adapters, browser-trusted localhost TLS and operational secret/rate-limit/recovery/monitoring ownership still require separate review. No persistent mode is activated by the pending parser.

Only synthetic integration within the existing BFF/dashboard is accepted here. No live payments, operational pricing, Auth0 resources, IAM activation, commit, merge or push is part of this increment. All prior Track A uncommitted work remains preserved.
