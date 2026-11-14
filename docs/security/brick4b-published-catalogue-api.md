# Brick 4B synthetic published catalogue APIs

Scope: complete isolated synthetic Brick 4B read boundary on top of ac117f6. Operational clients, Auth0/IAM activation, pricing permissions, persistent deployment, real providers and live financial execution remain disabled. No credentials are embedded in browser sources, configuration or responses. All third-party provider access remains behind the platform; these endpoints neither call nor expose provider APIs.

## HTTP contracts

GET /v1/payment/catalogue and GET /v1/payment/catalogue/:productId serve a trusted payment application backend. GET /v1/kiosks/:kioskId/catalogue and GET /v1/kiosks/:kioskId/catalogue/:productId serve a separately authenticated kiosk machine. UUID paths use canonical lowercase supported UUIDs. No tenant path, tenant query, enrollment route or mutation method exists. Product detail returns the same page envelope with exactly one item, or a generic 404. A tenant without active publications receives an empty list; missing, unpublished and foreign products are indistinguishable 404s.

The page envelope has exactly catalogue_version (SHA-256 snapshot identifier), items, and next_cursor (opaque token or null). Each item follows the existing public CatalogProductV1 allowlist: product_id, name, category, price_status, catalog_version, display_total and currency. category is DIGITAL_PIN, price_status remains INDICATIVE, currency is AED, display_total is an exact two-decimal string, and item catalog_version is the immutable publication-event UUID. Provider IDs, canonical inputs, draft IDs, cost, margin, actor identity, audit contents and execution authority are absent. The new published-catalogue-page.schema.json defines the envelope and references the existing item schema.

List parameters are limit (default 20, integer 1-50) and cursor only. Duplicate/unknown keys, malformed cursors and product-detail pagination are rejected. Reader snapshots are bounded to 1,000 active products; larger snapshots return 503 without partial disclosure. Items sort deterministically by product UUID. All reads use a single REPEATABLE READ READ ONLY database snapshot. Pagination tokens have 256 bits of randomness, are private server-side one-use capabilities, expire within 60 seconds/token lifetime, and bind the client/tenant/kiosk mapping version, page size and catalogue fingerprint. Reuse, process restart, expiry or catalogue change returns 409; consumers restart pagination. A token presented by a different binding is rejected without consuming the owner's token. A new publication or rollback changes the per-item event ID even when the displayed price is identical. Each subsequent page re-reads current heads and reauthorizes rather than exposing an older deactivated head. Concurrent first-page reads may see either committed snapshot and always report its version; they do not mix revisions within one SQL snapshot.

## Client trust and authorization

SyntheticCatalogueTokenVerifier accepts only trusted locally supplied public RSA keys and HTTPS .invalid issuers. It verifies RS256 signatures, at+jwt type, exact issuer/audience, kid, exp/iat/jti, a maximum 300-second token age, machine principal_kind, and synthetic-catalogue-client-v1 profile. No token-selected key URL, embedded key, delegation, staff ID, tenant/kiosk ID, roles or permission claims can substitute for the contract. Payment audience is urn:nukhbapay:synthetic:payment-catalogue and kiosk audience is urn:nukhbapay:synthetic:kiosk-catalogue. Payment scope is catalog.published.read:payment; kiosk scope is catalog.published.read:kiosk. Scopes must match exactly; privileged or combined scopes are denied. A verified client object has process-local provenance separate from VerifiedStaffIdentity and cannot authorize submission, approval, activation or rollback.

A trusted binding repository resolves exact issuer, subject, client ID and client kind to enabled tenant ownership, kiosk ID (required only for kiosks), explicit allowed scope and mapping version. No browser/header/query data establishes these bindings. Unknown, disabled or mismatched bindings deny. Mapping availability and freshness are checked before storage and before/after committed read audit; there is no positive authorization cache. Ordinary application bootstrap configures neither verifier nor binding/reader/audit dependencies. Synthetic composition is programmatic only and does not register or activate any real client.

Only the four exact controller methods enter this client boundary. Staff routes retain existing authentication/authorization guards; a marker, subclass, unknown method or unrelated handler cannot inherit consumer access. HEAD is denied, OPTIONS stays generic 404, and POST has no catalogue/price mutation handler. Request tenant/client/kiosk/role and forwarded-IP headers are not authority. Bearer parsing preserves duplicate-header rejection and the existing size bound. Application-level client attribution comes only after cryptographic verification and binding lookup.

## Reader and audit isolation

Pending 010 is additive, unregistered, loopback/disposable-only, owner/gate/history/ACL-checked, and requires the existing publication ledger. Migrations 007, 008, 009 and registered sources are unchanged. The public security-barrier view first chooses the latest revision per tenant/product, then joins immutable candidate, synthetic approval and matching publication audit evidence. It filters expiry only after head selection, so it cannot fall back to an older version. Tenant scoping is enforced in the view and underlying FORCE-RLS publication tables through transaction-local scope. The observation timestamp comes from the trusted server clock through an opaque one-use read ticket, never request input.

A separate ephemeral nukh_catalogue_* role receives column SELECT only on product_id, name, publication_id, total_amount_minor and valid_until in that view. It cannot read the ledger, candidates, source inputs, internal audit, IAM, providers or economics, and cannot write. Its pool defaults to read-only transactions. Startup rejects privileged/member roles, wrong targets, schema/database creation, excess relation/function rights and unsafe view ownership/settings. The application adapter consumes a registered one-use ticket, sets tenant/time scope locally, queries in deterministic order, commits and revalidates. Arbitrary adapter objects are reconstructed into frozen public allowlists before disclosure.

A distinct nukh_read_audit_* role has INSERT only on the FORCE-RLS append-only published_catalogue_read_audit table. It cannot SELECT catalogue or private data. Each successful response requires committed audit with request UUID, client digest, tenant/kiosk binding, snapshot version and time. Audit failure or mid-request client revocation returns no catalogue data. No token or confidential credential is persisted. Denied requests never return public data; unknown unauthenticated principals cannot be attributed to a tenant audit record. Audit append uses a separate restricted writer, never reader write access.

## Bounds and errors

All responses, including body-parser errors, use Cache-Control: no-store. Existing 16 KiB JSON body and header/time limits remain; catalogue GET requests reject nonempty bodies, transfer encodings and URLs over 1,024 characters. Limits are applied to the actual socket address before token verification (240 requests/minute per ingress address, bounded 1,024 entries) and to the server-resolved client before database access (60/minute by default, fixture-configurable 1-200; bounded 1,000 entries). X-Forwarded-For cannot select the limiter identity. Cursor state is bounded to 1,000 entries. 400/401/403/404/409/429 errors are generic; unavailable authentication, binding storage, publication storage or required audit returns sanitized 503. Errors never include tokens, SQL, connection details or private identity values.

## Operational dependencies

Real machine trust configuration, secret provisioning in trusted backends, durable client/kiosk ownership administration, operational audit policy, distributed rate/cursor coordination for multiple workers, TLS/proxy deployment and persistent migration review remain future activation work. The React browser would call its trusted backend; it receives no confidential machine credentials. These synthetic endpoints confer no quote, payment or provider-execution authority.

## Validation evidence

Completed suites: API/security 48 passed; application 96 passed; publication/catalogue/disposable HTTP integration 9 passed; database 18 passed; migration/security/restore 34 passed; financial/provider 19 passed. No completed suite failed, cancelled or skipped a test. Application/database/API typechecks, backend/frontend builds, browser boundary checks, structure checker (31 JSON contracts), frozen migration-source verification and git whitespace checks passed.

The first full API build was blocked by sandboxed esbuild parent-directory access. The same unchanged build/test command succeeded outside the sandbox with the required permission. No timeouts, guards or checks were weakened. The final compiled regression runner verified unchanged persistent development 001-003 history, database inventory, ephemeral role inventory and disposable connection evidence. All new reader/audit roles were cleaned up. No persistent data, client, IAM, provider or operational pricing access was activated.

The tests use actual synthetic RS256 credentials and disposable PostgreSQL views/roles through the HTTP application. They cover missing, malformed, forged, expired, wrong-audience and wrong-principal credentials; exact scope and payment/kiosk separation; unknown/disabled clients; foreign tenant/product/kiosk access; forged identity/tenant/role headers; approved-but-unpublished and draft-only visibility; exact public fields; unknown, duplicate and invalid pagination; cursor owner binding, expiry, reuse and stale snapshots; concurrent publication reads; request bounds, rate limits and non-GET denial; reader privilege excess, raw table denial and runtime permission loss; committed audit failure and mid-response revocation; default disabled composition; and expired-head filtering. The application unit test also proves that catalogue identity is not staff identity and rejects structural identity/ticket clones.

GO for complete isolated synthetic Brick 4B acceptance. Operational rollout remains disabled and requires the dependencies above.

## Changed files

- apps/api/src/app.module.ts
- apps/api/src/http-application.ts
- apps/api/src/modules/catalog/README.md
- apps/api/src/modules/catalog/published-catalogue-http.ts
- apps/api/test/catalogue-publication.integration.ts
- apps/api/test/fixtures/published-catalogue-http.ts
- packages/application/src/index.ts
- packages/application/src/catalog/published-catalogue.ts
- packages/application/test/published-catalogue.test.ts
- packages/database/src/index.ts
- packages/database/src/published-catalogue-reader.ts
- packages/database/pending-migrations/010_synthetic_published_catalogue.sql
- packages/database/roles/grant_published_catalogue_clients.sql
- packages/contracts/public/published-catalogue-page.schema.json
- scripts/test/run-catalogue-publication-acceptance.mjs
- docs/security/brick4b-published-catalogue-api.md

Frozen pending SHA-256 bytes retained: 007 c4ed1ef748dabdfeb16cfc8cc40b667cb0106e944c5d97547677671ac064a2c9; 008 c9427445d9b7f29c3a7b6b7cf249d6714cb9dd89a45735f45e0492589f26d4f2; 009 06472c8787f08631964fb57256813d3b7c1e67610ef66b4fbeb2901bcb0998d0.
