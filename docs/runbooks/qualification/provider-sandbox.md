# Provider sandbox qualification

**Status** `WAITING_FOR_VERIFIED_SANDBOX_TARGETS`  
**Authorized scope** Read-only SSL Wireless and IronGate discovery using exact approved sandbox bindings.

Verify provider-specific scope, documented catalogue endpoints, versioned schemas and explicit availability. Use approved sandbox authentication with the designated secret store. The coverage below updates the November 19 [provider gap register](../../providers/development-gap-register.json).

## API coverage in the repository

The provider pack covers Finxplor Connect, IronGate Digital, SSL Wireless and iPay/Qore3. SSL and IronGate have backend catalogue discovery with loopback verification. The IronGate documentation describes a test environment. The folders and current configuration do not establish an approved sandbox origin, tenant/account and credential-reference binding for either provider. Finxplor's expanded machine-readable schemas are pending. iPay/Qore3 is deferred by the owner and excluded from Brick 4 completion. [Pack provenance, endpoint inventory and data contracts](../../providers/provider-api-pack-1.3.md)

- **SSL Wireless** — Supply the account-pinned origin, category/operator allowlists, optional sub-channel and secret-store references. Confirm source identity, currency, actual debit and fees before priced ingestion. [Exact adapter configuration](../../providers/ssl-wireless-common-api.md#sandbox-configuration)
- **IronGate Digital** — Supply the owner-approved HTTPS origin, pinned tenant/account, read scopes and confirmed wire success code for each read. Bind the username/API-key resolver to that account. Confirm the prepaid currency, optional domestic eSIM operator, account availability, debit/fee semantics and egress or source-IP restrictions. The POST allowlist covers catalogue operations.
- **Synthetic catalogue** — Existing pricing and publication qualification uses the AE/AED digital PIN fixture and exact minor units. Provider discovery cannot supply those normalized offers without an approved mapping. [Contract](../../../packages/provider-contracts/src/catalog-provider.ts) · [Tests](../../../packages/provider-adapters/test/mock-provider.test.ts)

## Sandbox qualification sequence

1. Obtain the exact owner-approved vendor revision and a sandbox credential reference with read-only catalogue access. Confirm host, egress, TLS trust, rate limit, secret rotation and permitted countries and services. Match the credential grant to the specific methods and paths in the contract before connecting.
2. Record a sanitized request/response example for each approved endpoint, including invalid data, unavailable products, currency precision, pagination, expiry and provider failures. Implement and exercise request validation and response normalization in the backend adapter before the results reach the catalogue or pricing engine.
3. Verify tenant/account binding, exact monetary normalization, fixed failure codes, freshness and unavailable-service handling. Compare the normalized output with the backend preview. Provider credentials and transport belong to NukhbaPay's backend. The payment app and kiosk use the central published catalogue API.

Collect normalized response references, money/currency precision examples, invalid schema cases, repeated request results, upstream timeouts, rate bounds, reconnect recovery and redaction evidence. Exercise catalogue reads and draft preview. Financial operations require their own acceptance decision and authorization.

Use `qualifySslCatalogueRead` or `qualifyIronGateCatalogueRead` in the trusted backend composition for one approved operation at a time. Pass the matching vendor contract, exact HTTPS origin, tenant/account, method and path, credential reference, account selectors and allowed request budget. The SSL package read requires a pinned operator list. Each IronGate POST needs an exact success code and permits one upstream request. The built-in transport checks the final method and target before sending. The result reports only schema outcome and counts. Obtain monetary meanings and account availability separately before approving any priced mapping. Record the sanitized result against the exact approved scope. [Sandbox preflight](../../../packages/provider-adapters/src/sandbox-catalogue-qualification.ts)

Offline preflight uses `pnpm.cmd development:test:offline`. Candidate review preparation uses `python scripts/reconcile-r6-offline.py`.
