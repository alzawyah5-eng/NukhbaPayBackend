# ADR 0005: Proposed trusted identity provider and first access scope

Status: **proposed; awaiting owner approval and deployment information**  
Last reviewed: 10 November 2026

Current local implementation note, 11 November 2026: separately authorized Bricks 3B-1–3B-3 add synthetic token verification, restricted internal IAM integration and global guards with test-only HTTP acceptance (ADRs 0007–0009). No real provider or operational activation is approved/configured. The original provider proposal/context below is historical; the management approval register governs the remaining external decisions.

Owner update, 11 November 2026: Auth0 is the preferred direction for a staff-only non-production pilot, conditional on final region, residency, commercial and operational ownership verification. Only isolated Brick 3B-1 coding was authorized; its synthetic verifier is recorded in ADR 0007. No provider account/resource, live trust configuration, browser login, database migration or production authentication is approved or configured. The operational prerequisites below remain open.

This record proposes the provider-backed identity direction; it does not
provision an identity provider or implement authentication/token validation.
The provider-independent local staff identity, membership, and authorization
foundation is implemented separately under
[`0006-brick-3a-staff-authorization-foundation.md`](0006-brick-3a-staff-authorization-foundation.md).
No business routes are implemented. Brick 2B remains complete within its
documented local synthetic complete-snapshot scope.

## Context and repository evidence

The API currently serves only `GET /health/live`; its README says the API will
own transport authentication and per-object authorization. The API identity
module, admin web client, and device module are planning READMEs, not working
login systems. Shared orchestration belongs in `packages/application`,
PostgreSQL adapters in `packages/database`, and financial rules in
`packages/domain`. The security register records authentication and
external-caller tenant authorization as unimplemented.

A repository-wide search found no configured issuer, audience, identity
provider, authentication flow, or login implementation for KissAux or
NubbaPay. This is not evidence that no such system exists outside this
workspace. The owners of those systems must confirm whether either has a
supported, operational OIDC provider and stable subject identifiers before
this proposal is approved.

## Proposed recommendation

Use **Auth0 as a managed OIDC/OAuth authorization server** for the first
interactive staff identity integration, subject to the open information and
approval gates below. Keep tenant membership and application permissions in
Nukhabapay's trusted server-side authorization store; Auth0 authenticates the
staff principal but does not define the application's tenant ownership.

This is a provisional preference, not a selected or configured service.
Managed hosting avoids operating a separate identity server, its production
database, TLS/proxy configuration, upgrades, backups, and high availability.
Auth0 documents API-side access-token validation, custom API audiences, and
Authorization Code with PKCE for public clients. The tradeoff is dependence
on a SaaS vendor, its commercial terms, supported regions/data handling,
availability, and lifecycle behavior. Those factors have not been verified
against launch jurisdiction, procurement, or any existing KissAux/NubbaPay
identity service.

### Options compared

| Option | Benefits for this scope | Costs and limitations | Status |
| --- | --- | --- | --- |
| **Auth0 managed OIDC** | Avoids operating the authorization server; supports standard OIDC/OAuth flows; official API guidance covers signature/claim/audience/scope validation and PKCE. | External SaaS, vendor and plan dependency; region, residency, contractual, cost, existing-system integration, and outage requirements are unknown. | **Proposed recommendation; awaiting information and approval.** |
| **Keycloak self-hosted OIDC** | Open-source deployment under project/operator control; standard OIDC/OAuth; can integrate with upstream identity systems. | The project would own secure hosting, public hostname/TLS and proxy, database, backups, upgrades, monitoring, capacity, and high availability. No such production platform/operator is evidenced here. | **Alternative; not selected; awaiting hosting/operations evidence.** |

Official documentation reviewed on 10 November 2026:

- Auth0, [Validate Access Tokens](https://auth0.com/docs/secure/tokens/access-tokens/validate-access-tokens): API-side validation, API audience, and permissions/scopes.
- Auth0, [Authorization Code Flow with PKCE](https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow-with-pkce): PKCE for public clients that cannot protect a client secret.
- Auth0, [Validate JSON Web Tokens](https://auth0.com/docs/secure/tokens/json-web-tokens/validate-json-web-tokens): use an established middleware/library and verify signatures and claims; do not hand-roll JWT verification.
- Auth0, [Token Best Practices](https://auth0.com/docs/secure/tokens/token-best-practices): expiry, HTTPS, and safe token handling.
- Keycloak, [Server Administration Guide](https://www.keycloak.org/docs/latest/server_admin/): OIDC/OAuth, realms, users, roles, and session/revocation capabilities.
- Keycloak, [Configuring Keycloak for Production](https://www.keycloak.org/server/configuration-production): TLS, hostname/proxy, database, load, and cluster operational requirements.

These sources establish product capabilities and operational topics, not the
provider's suitability, commercial terms, data location, or a deployed
configuration for this project.

## First access scope

**Proposed first caller:** a named, human Nukhabapay staff member using a
first-party staff browser application. The repository's `apps/admin-web` is
only a placeholder; no client or staff endpoint is authorized by this record.
Brick 3A tests the local provider-independent authorization foundation.
Provider-backed authentication remains a separate Brick 3B increment and
must expose no business route.

**Proposed flow:** OpenID Connect Authorization Code with PKCE for the
interactive browser client. The API accepts only an access token issued for
its API audience; an ID token is not an API credential. No resource-owner
password flow, custom token issuance, tenant-header trust, or public business
endpoint is in scope. Client token/session storage and whether the browser
uses a backend-for-frontend remain subject to the actual `apps/admin-web`
deployment design.

Deferred callers:

- **Partner applications:** defer until partner identity lifecycle,
  organization boundaries, and client-credential/on-behalf-of requirements
  are known.
- **Customers:** defer until customer account lifecycle, consent, recovery,
  and customer-session needs are designed.
- **Devices/kiosks:** defer to a dedicated device-enrollment and revocation
  design; never share a universal device credential.
- **Background services/workers:** defer to workload identity and
  service-to-service credential design; staff tokens are not service
  credentials.

## Proposed identity and tenancy decisions

| Decision | Proposed design | Status |
| --- | --- | --- |
| Identity provider and hosting | Auth0-managed OIDC, conditional on jurisdiction, vendor, existing-system, and operational review. | **Proposed; awaiting approval/information.** |
| Protocol and staff flow | OIDC/OAuth Authorization Code with PKCE; API validates access tokens, never ID tokens. | **Proposed; awaiting approval.** |
| Actual issuer | After an authorized Auth0 environment is provisioned, take the exact issuer from that environment's OIDC discovery metadata and verify it against the deployed configuration. Do not construct or guess a domain. | **Awaiting information/configuration.** |
| API audience | Register a unique API identifier in that environment, set it as the requested audience, and configure the API to require that exact value. Do not invent an identifier or accept a generic/default audience. | **Awaiting information/configuration.** |
| Stable identity key | Map the exact `(issuer, subject)` pair to an internal immutable principal ID. Treat `sub` as opaque; do not key membership by email, username, or a display name. | **Proposed; awaiting approval.** |
| Tenant meaning | A tenant is the contractual/business security boundary that owns its Nukhabapay account relationship, memberships, catalog/provider accounts, and policies. A merchant may itself be a tenant or be a member under a parent business/group tenant. A branch or kiosk is not a tenant by default; model it as a subordinate scope/device unless an explicit legal/account boundary requires otherwise. | **Proposed; awaiting confirmation of the actual commercial model.** |
| Membership and permissions | Authoritative in Nukhabapay server-side records keyed by internal principal and tenant. Provider claims can establish the authenticated issuer/subject but do not override tenant membership or application permissions. Provider-independent schema and policy foundation are implemented locally under ADR 0006; production authority/ownership remains open. | **Local Brick 3A foundation implemented; production authority awaiting approval.** |
| Grant/revoke authority | A designated platform operator creates a tenant and appoints its initial tenant administrator. That tenant administrator may grant/revoke staff membership only within that tenant, subject to an auditable policy. A platform identity/security operator can suspend a principal globally. No self-service elevation or cross-tenant grant. | **Proposed; awaiting role-owner and business-process confirmation.** |
| Token and change effectiveness | Proposed API access-token lifetime is at most 5 minutes. API authorization checks active principal, membership, and permissions on every protected operation; if cached, revocation must be visible within 30 seconds. Local suspension/revocation fails closed. Provider-side account suspension prevents future login/token renewal according to provider behavior, while an already issued JWT may remain cryptographically valid until expiry; the server-side active-state check must deny it sooner. | **Proposed targets; awaiting provider capability and operational SLO approval.** |
| Environments | Separate development, acceptance-test, and production IdP environments, clients, API audiences, issuer configuration, and signing-key trust. Never accept production tokens in non-production or reuse production users/credentials as fixtures. | **Proposed; awaiting environment/operations approval.** |

No issuer URL, API audience, client ID, secret, signing key, Auth0 tenant,
or external account has been created or selected. Example identifiers in
future code/configuration must be explicitly local placeholders and must not
be described as deployed settings.

## Package and security boundaries

- `apps/api`: future OIDC middleware/guard, request authentication, transport
  wiring, and creation of a verified principal context. It must not infer
  trusted identity or tenant ownership from request-provided tenant fields.
- `packages/application`: framework-independent principal/tenant context,
  authorization policy/use cases, and narrow identity/membership repository
  ports.
- `packages/database`: parameterized persistence and explicit conversion for
  identity/membership lookup if PostgreSQL is selected as the authoritative
  store. Grant only the reads/writes needed by those use cases; do not expand
  the catalog importer role or reuse migration credentials.
- `packages/domain`: pure business rules, with no token, network, or database
  dependencies.
- `apps/admin-web`: future staff login client only after its hosting/session
  model is selected. It is not implemented by this record.

## Acceptance tests for the provider-backed Brick 3B increment

1. A valid test-environment access token yields the expected immutable
   `(issuer, subject)` mapping and an active server-derived tenant context.
2. Reject absent, malformed, tampered, wrong-issuer, wrong-audience,
   expired, not-yet-valid, disallowed-algorithm, and unknown-key tokens.
   Verify signing-key rotation using trusted metadata/JWKS; reject an unknown
   key when refresh fails, and fail closed when no valid trusted verification
   material exists.
3. Reject unknown, disabled, or revoked principals and inactive/revoked
   memberships. A body, query, or header tenant ID cannot create or override
   authorized context.
4. Prove deny-by-default role/action decisions, allowed and denied
   role/action pairs, and cross-tenant object rejection.
5. After a committed membership/permission revocation or principal
   suspension, the next request (or no later than the approved cache bound)
   is denied. If the identity store is unavailable, authorization fails
   closed.
6. Test-only harnesses cover the protected use case without adding a
   customer-facing/business route. `GET /health/live` remains process-only.
7. Verify dev, test, and production trust configuration cannot accept one
   another's tokens. Verify any identity database access uses a deliberately
   restricted identity, separate from migration, runtime, and import roles.
8. Re-run the Brick 2B acceptance suite unchanged and verify importer grants
   and import behavior are unchanged.

## Information and setup required before implementation

The project owner must provide or decide:

1. Launch jurisdictions, data-residency/processor requirements, procurement
   constraints, and who will own identity-provider operations.
2. Whether KissAux or any NubbaPay deployment already has an IdP. If so,
   provide its non-secret provider/product name, supported OIDC discovery
   endpoint/issuer, intended API audience/client model, subject stability
   guarantees, user deactivation behavior, and owner. Do not send secrets.
3. Whether a tenant is a legal merchant, parent company, reseller, or another
   contracting entity; who operates each tenant and who may appoint tenant
   administrators.
4. Initial staff categories, invitation/provisioning process, global
   suspension owner, audit/approval requirements, and the revocation SLO.
5. Hosting and session architecture for the future staff browser client and
   the required dev/test/prod isolation.
6. Explicit approval to create/configure an identity-provider test
   environment. No external account or service is provisioned by this ADR.

**Next implementable step after approval:** provision a dedicated non-production
environment through an authorized owner; register a staff browser client and
an API resource; record their real discovery issuer and API audience; then
implement only API token validation plus server-side principal/membership
resolution and deny-by-default authorization tests. Do not add business
endpoints, customer/device/partner authentication, importer grants, or Brick 4.
