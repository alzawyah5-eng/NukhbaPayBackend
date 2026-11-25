# Provider sandbox qualification

**Status** `WAITING_FOR_VERIFIED_SANDBOX_TARGETS`  
**Authorized scope** Read-only SSL Wireless and IronGate discovery using exact approved sandbox bindings.

Verify provider-specific scope, documented catalogue endpoints, versioned schemas and explicit availability. Use approved sandbox authentication with the designated secret store. The coverage below updates the November 19 [provider gap register](../../providers/development-gap-register.json).

## API coverage in the repository

The provider pack covers Finxplor Connect, IronGate Digital, SSL Wireless and iPay/Qore3. SSL and IronGate have backend catalogue discovery with loopback verification. Live qualification requires an approved origin, tenant, provider account and credential reference. Finxplor's machine-readable schemas are pending. The iPay SOAP adapter has mock coverage and needs the assigned WSDL and account authorization before live qualification. [Pack provenance, endpoint inventory and data contracts](../../providers/provider-api-pack-1.3.md)

- **SSL Wireless** — Supply the account-pinned origin, category/operator allowlists, optional sub-channel and secret-store references. Confirm source identity, currency, actual debit and fees before priced ingestion. [Exact adapter configuration](../../providers/ssl-wireless-common-api.md#sandbox-configuration)
- **IronGate Digital** — Supply the owner-approved HTTPS origin, pinned tenant/account, read scopes and confirmed wire success code for each read. Bind the username/API-key resolver to that account. Confirm the prepaid currency, optional domestic eSIM operator, account availability, debit/fee semantics and egress or source-IP restrictions. The POST allowlist covers catalogue operations.
- **Synthetic catalogue** — Existing pricing and publication qualification uses the AE/AED digital PIN fixture and exact minor units. Provider discovery cannot supply those normalized offers without an approved mapping. [Contract](../../../packages/provider-contracts/src/catalog-provider.ts) · [Tests](../../../packages/provider-adapters/test/mock-provider.test.ts)

## Local configuration and check

Use the provider block in `backend/.env.example` as the template for the ignored `backend/.env`. Keep `NUKHBAPAY_PROVIDER_SANDBOX_ENABLED=false` during setup. Set `NUKHBAPAY_PROVIDER_SANDBOX_TENANT_ID` to the canonical tenant UUID. The catalogue database must have an active `provider_accounts` record for that tenant with the configured account UUID and provider code (`SSL_WIRELESS` or `IRONGATE`). The command uses the saved Windows catalogue reader profile for this check.

The pack supplies the SSL demo origin, separate IronGate prepaid sandbox and postpaid test origins, and the iPay UAT SOAP endpoint. IronGate documents `IDR` as the default prepaid currency and accepts `en` or `id` for international eSIM metadata. Compare those settings with the vendor grant for the assigned account before enabling a read. Account credentials, category scope, operator scope, and transaction products come from the vendor grant. [Pack coverage and outstanding inputs](../../providers/provider-api-inventory.md)

Supply `BASE_URL`, `PROVIDER_ACCOUNT_ID` and `CREDENTIAL_REFERENCE` under the prefix for each account. `BASE_URL` is the exact approved HTTPS sandbox origin. `CREDENTIAL_REFERENCE` identifies the credential assignment for that sandbox account. Enter the vendor credential values privately in `.env`.

| `-Provider` | `-Operation` | Environment prefix | Additional settings |
| --- | --- | --- | --- |
| `ssl-topup` | `service-list`, `package-list` | `NUKHBAPAY_SSL_TOPUP_` | `STK_CODE`, `AUTH_KEY`, comma-separated `ALLOWED_CATEGORIES`. `ALLOWED_OPERATOR_IDS` is required for `package-list`. `SUB_CHANNEL_ID` is optional. |
| `ssl-utilities` | `service-list` | `NUKHBAPAY_SSL_UTILITIES_` | `STK_CODE`, `AUTH_KEY`, comma-separated `ALLOWED_CATEGORIES`. `SUB_CHANNEL_ID` is optional. |
| `irongate` | `prepaid` | `NUKHBAPAY_IRONGATE_PREPAID_` | `USERNAME`, `API_KEY`, `SUCCESS_CODE`, `CURRENCY` (`IDR` or `USD`). Optional `STATUS` accepts `all`, `active` or `non active`. |
| `irongate` | `postpaid` | `NUKHBAPAY_IRONGATE_POSTPAID_` | `USERNAME`, `API_KEY`, `SUCCESS_CODE`. Optional `STATUS` accepts `all`, `active` or `non-active`. `PROVINCE` is optional. |
| `irongate` | `games`, `esim-indonesia`, `esim-international` | `NUKHBAPAY_IRONGATE_PREPAID_` | `USERNAME`, `API_KEY` and the corresponding `GAMES_SUCCESS_CODE`, `ESIM_INDONESIA_SUCCESS_CODE` or `ESIM_INTERNATIONAL_SUCCESS_CODE`. `ESIM_OPERATOR` is required for Indonesia. `ESIM_LANGUAGE` (`en` or `id`) is optional for international. |
| `irongate` | `game-format`, `game-servers` | `NUKHBAPAY_IRONGATE_PREPAID_` | `USERNAME`, `API_KEY`, an approved `GAME_CODE`, and the corresponding `GAME_FORMAT_SUCCESS_CODE` or `GAME_SERVERS_SUCCESS_CODE`. |

Run the configuration check from `backend`. It reports missing or invalid key names and makes zero requests.

```powershell
corepack.cmd pnpm provider:sandbox -Provider ssl-topup -Operation service-list
```

After the account, origin and read scope are approved, build the database package with `corepack.cmd pnpm --filter @nukhbapay/database build`. Set `NUKHBAPAY_PROVIDER_SANDBOX_ENABLED=true` privately and run the same command with `-Read` to qualify one operation. The command checks the active account and reports a sanitized outcome and counts. It leaves imported data, prices and publications untouched. Return the switch to `false` after the authorized reads.

## Sandbox qualification sequence

1. Obtain the exact owner-approved vendor revision and a sandbox credential reference with read-only catalogue access. Confirm host, egress, TLS trust, rate limit, secret rotation and permitted countries and services. Match the credential grant to the specific methods and paths in the contract before connecting.
2. Record a sanitized request/response example for each approved endpoint, including invalid data, unavailable products, currency precision, pagination, expiry and provider failures. Implement and exercise request validation and response normalization in the backend adapter before the results reach the catalogue or pricing engine.
3. Verify tenant/account binding, exact monetary normalization, fixed failure codes, freshness and unavailable-service handling. Compare the normalized output with the backend preview. Provider credentials and transport belong to NukhbaPay's backend. The payment app and kiosk use the central published catalogue API.

Collect normalized response references, money/currency precision examples, invalid schema cases, repeated request results, upstream timeouts, rate bounds, reconnect recovery and redaction evidence. Exercise catalogue reads and draft preview. Financial operations require their own acceptance decision and authorization.

Use `qualifySslCatalogueRead` or `qualifyIronGateCatalogueRead` in the trusted backend composition for one approved operation at a time. Pass the matching vendor contract, exact HTTPS origin, tenant/account, method and path, credential reference, account selectors and allowed request budget. The SSL package read requires a pinned operator list. Each IronGate POST needs an exact success code and permits one upstream request. The built-in transport checks the final method and target before sending. The result reports only schema outcome and counts. Obtain monetary meanings and account availability separately before approving any priced mapping. Record the sanitized result against the exact approved scope. [Sandbox preflight](../../../packages/provider-adapters/src/sandbox-catalogue-qualification.ts)

Offline preflight uses `pnpm.cmd development:test:offline`. Candidate review preparation uses `python scripts/reconcile-r6-offline.py`.
