# Local Master Catalogue database

> **Current Finxplor Layer 1 workflow.** The staff catalogue reads source and
> AED customer prices from PostgreSQL. See
> [Refresh Finxplor customer prices in AED](#refresh-finxplor-customer-prices-in-aed)
> for the provider feed and the refresh schedule.

The local-development target is `nukhbapay_catalogue` on the registered Windows PostgreSQL 18 service at `127.0.0.1:5432`. The setup uses the verified Windows cluster inspection and checks for database and role name conflicts. Staff authentication and membership stay in `nukhbapay_staff`. The catalogue workload roles have no `CONNECT` grant on that database.

Start the catalogue-enabled backend from the `backend` folder in Windows PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\staff-local.ps1 -Catalogue
```

During first-time setup, enter the current `postgres` password at the hidden prompt. The launcher generates and protects the three role credentials using Windows DPAPI at `%LOCALAPPDATA%\Nukhbapay\staff-portal\windows-catalogue.clixml`. On later starts, the launcher uses the saved migrator role in a separate process before starting the HTTPS listener. The portal process receives only the catalogue reader credential.

| Role | Scope |
| --- | --- |
| `nukhbapay_catalogue_migrator` | Owns the dedicated database and installs the reviewed local schema. |
| `nukhbapay_catalogue_reader` | Reads the approved catalogue projections under forced row-level security. |
| `nukhbapay_catalogue_runtime` | Reads scoped catalogue data and can append snapshots and offers and advance allowed snapshot fields. |

The installer verifies the registered hashes for `001_catalog`, `002_import_role_privileges` and `003_import_role_read_access`. It applies those sources and the local isolation migration in a single transaction. The local isolation migration enforces tenant scoping on the six foundation tables, exposes shared products only through approved mappings and removes automatic future table grants. The tenant qualification inserts temporary rows in a transaction and rolls them back. The backend reader opens a bounded read-only pool against the verified database OID and role. The ignored `.local/windows-catalogue-result.json` records only step results.

Register each reviewed schema change as the next numbered transactional SQL file under `packages/database/local-catalogue/`. Append its name, filename and SHA-256 of the UTF-8 source with LF line endings to `manifest.json`. The startup step verifies source hashes and the existing migration history, serializes concurrent startup migrations, and commits pending schema and history together. Leave transaction control to the runner. A failure stops startup. Keep initial data imports in their authorized workflows.

The local manifest covers products, accounts, mappings, snapshots, offers, refresh storage, pricing drafts, submission and publication evidence, the transactional outbox and the published read projection. Local migration `010_commercial_draft_evidence.sql` adds immutable, tenant-scoped quote and FX evidence tied to the original draft transaction, request and creation audit. The schema owner alone has access to this table until a persistent draft writer is qualified. `setup-windows-catalogue.ps1 -Rehearse` uses the saved migration role to verify evidence, the draft, approval, publication and outbox transaction, then rolls back its schema changes and test rows. The original disposable installers retain their target guards. This local catalogue package uses independent publication schema changes and pins the unchanged refresh and delivery SQL dependencies. Publication, delivery, channel access and refresh execution still require qualified workload and authority contracts.

Append `-Check` for a read-only preflight with saved credentials and no listener. It reports pending migrations so the normal startup command can apply them. Only the server-selected staff tenant may obtain a catalogue transaction scope, and IAM must authorize `catalog.read` before the catalogue appears in the workspace. Catalogue reads retain the existing staff audit requirement. The initial installation configures no provider availability or staff permission grants.

## Finxplor discovery pilot

Inspect the real provider feed and its saved scans without importing anything. Use the saved catalogue settings and the same Finxplor API credential as the importer.

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File .\scripts\setup-windows-catalogue.ps1 -InspectFinxplor -ProductId 1002_20249
```

On 26 November 2026, Finxplor returned nonempty later pages after reporting `totalPages: 1` and `hasNextPage: false`. The active importer uses these fields to stop. Its most recent scan consequently contains only 100 unfiltered records and omits UAE products. The inspection compares those saved scans with the API, checks country and category variants, and distinguishes pagination failures from row normalization failures. Use scoped terminal-page and duplicate checks to qualify the replacement importer before it updates the current scan. [Incident findings](stage-6-pricing-delivery-tracker.md#finxplor-catalogue-coverage-incident)

After guarded catalogue setup, run the one-product sandbox import from the backend folder:

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\setup-windows-catalogue.ps1 -ImportFinxplor
```

The importer requires the verified Finxplor sandbox origin, the enrolled local tenant, and its disabled provider account binding. It requests one product and writes an immutable discovery using the catalogue runtime role. Repeating the same observation returns the original discovery ID. The portal shows it under **Provider discoveries** to staff authorized for the Master Catalogue. The discovery and its rule-based review reason leave pricing, availability for sale, and publication to their existing authorization workflows.

Add `-Full` for the authorized `ARE / Gift Card` market. The importer verifies Finxplor's observed per-page metadata, checks two consecutive empty pages and repeats the entire walk to confirm content, order and termination. The cap is 3,900 products per scope. The two passes and all retry attempts run within a fixed deadline. An empty initial page, a duplicate, a changing response, a contradictory response or a decrease below the latest verified product count stops admission.

A successful scoped import commits the discoveries, scan and digest together. An identical refresh preserves the scan and records a separate immutable confirmation with a UTC timestamp. Earlier unfiltered scans retain their original data and receive append-only unverified-coverage corrections. Earlier discoveries outside the verified market remain visible. The local Staff Portal uses indexed database keyset pagination for discovery cards.

To qualify the current feed and database without committing staged discoveries, add `-RehearseImport`. It also exercises protocol failures using in-memory copies of authorized provider responses. After the manual import, verify the stored scope and navigation in the real Catalogue database.

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File .\scripts\setup-windows-catalogue.ps1 -ImportFinxplor -Full -RehearseImport
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File .\scripts\setup-windows-catalogue.ps1 -VerifyFinxplorCoverage -ProductId 1002_20249
```

Register the local refresh from the `backend` directory after verifying a full sandbox import:

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\schedule-finxplor-refresh.ps1
Get-ScheduledTaskInfo -TaskName 'NukhbaPay Finxplor Catalogue Refresh'
```

The task runs at 08:00 and 20:00 Windows local time while the current Windows user is signed in. This workstation uses Dubai time. It uses the same guarded importer and encrypted catalogue runtime credential as a manual run. The import refreshes product and denomination observations. Customer prices remain governed by approved mapping, commercial terms, and the pricing workflow.

Each scoped refresh writes receipts under `.local/finxplor-refresh/`. The run ID joins start and completion entries. `COMMITTED` requires an acknowledged transaction. `REHEARSED` confirms rollback. `STOPPED` reports a sanitized phase and may include an HTTP status or SQLSTATE. `OUTCOME_UNCONFIRMED` requires checking the latest committed coverage before retrying. Receipts record UTC timestamps, requested and completed scope, pages, requests, product counts, rejected rows and the scan digest on success. Task Scheduler result `0` and a corresponding `COMMITTED` receipt together confirm that a scheduled invocation completed.

### Check the first UAE/AED commercial price input

Run from `backend` using the saved local catalogue settings:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File .\scripts\setup-windows-catalogue.ps1 -CheckFinxplorCost
```

With no cost file, the command reports `COMMERCIAL_INPUT_REQUIRED` and the number of UAE/AED entries in the latest saved Finxplor scan. Add `-ProductId 1002_20249` to narrow the result to that SKU and check its mapping status, offer snapshot and current mapped offer. This check queries PostgreSQL only. The saved scan on 26 November 2026 contained zero UAE/AED entries. The provider inspection found the Apple SKU through the country-filtered API and confirmed the scan coverage issue. Finxplor still needs to supply a versioned commercial quote or authenticated export. The settlement wallet can be AED or USD.

After verifying the vendor evidence, use the exact saved scope and current discovery UUID to prepare `.local/finxplor-commercial-cost.json`. The private file accepts a single observation with these fields:

| Field | Required source or value |
| --- | --- |
| `version` | Integer `1` for existing AED inputs. Use `2` for inputs that carry an FX reference. |
| `tenantId`, `providerAccountId`, `discoveryId`, `sourceProductId` | Exact IDs from the local binding and latest completed scan. |
| `market`, `settlementCurrency` | Market `ARE`. Settlement is `AED` or `USD`. The provider denomination on the bound discovery remains AED. |
| `denomination`, `walletDebit`, `additionalFee` | Decimal strings with two places. Supply denomination in AED and wallet debit and provider fee in the settlement currency. Use `"0.00"` when the confirmed additional fee is zero. |
| `fxRateReference` | Version 2 only. Use the exact rate reference for USD, or `null` for AED. |
| `available`, `evidenceReference` | Confirmed Boolean `true` and a bounded commercial evidence reference. Keep credentials out of the observation. |
| `observedAt`, `validUntil` | Provider evidence timestamps in RFC 3339 with an explicit timezone. The check requires an unexpired quote, a fresh scan, and a fresh price observation. The window `NUKHBAPAY_FINXPLOR_COMMERCIAL_MAX_AGE_MINUTES` defaults to 720 and can be tightened. |

For USD, set `NUKHBAPAY_FINXPLOR_COMMERCIAL_FX_SOURCE` in the private backend `.env` to the source identifier approved for the provider account. Place the independently verified FX record in `.local/finxplor-commercial-fx.json`. Match the following fields to the commercial quote:

| Field | Required source or value |
| --- | --- |
| `tenantId`, `providerAccountId`, `commercialEvidenceReference`, `rateReference` | Exact tenant, account, quote evidence reference and quote FX reference. |
| `source`, `baseCurrency`, `quoteCurrency` | The configured source identifier, `USD`, and `AED`. |
| `aedPerUsd` | Positive decimal string with up to 12 decimal places from the approved FX evidence. |
| `observedAt`, `validUntil` | RFC 3339 rate observation and expiry. The rate must be known at quote observation, fresh under the local window, and unexpired. |

The application uses integer arithmetic and rounds the combined provider debit and settlement fee to AED fils once. It records the original USD amounts and derives the AED fee projection as the rounded total less the rounded debit. Both quote and FX expiry constrain the AED draft. The canonical pricing engine still requires documented discount and debit reconciliation against face value. Discrepancies require review.

With a valid file and a matching current entry, the check reports `COMMERCIAL_INPUT_VALIDATED`, a reproducible digest, settlement currency, effective expiry and `authority: NONE`. This is local format, freshness, scope and arithmetic verification. Vendor authenticity, canonical mapping, pricing policy and publication approval have their own gates. The check uses a read-only database transaction and makes no provider request.

Select Finxplor in Provider discoveries to see provider denominations and sale-price readiness. The provider API inventory records the implemented listing and detail routes and their verification status. [Finxplor API inventory](../providers/provider-api-inventory.md#finxplor-connect)

Compare a product from the latest saved full scan with the sandbox detail response:

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\setup-windows-catalogue.ps1 -ImportFinxplor -ProductId 1002_1643
```

The command reads the bound tenant and account, prints the validated catalogue fields and reports differences from the saved scan. Product detail checks leave the stored scan and pricing workflow intact.

The hybrid price review joins a succeeded advisory job to the exact tenant, canonical product, approved offer, and completed source snapshot. The deterministic price policy calculates the unpublished draft. The offline worker tests exercise the local Python mock fallback with approved synthetic source data. The local staff database reader has discovery observations and has no qualified Finxplor advisory job or commercial price evidence to return. Real pricing requires verified account debit and fees, the approved canonical mapping, and a configured price policy.

The Windows launcher can also honor an explicitly authorized local-only Catalogue read grant in `.local/windows-catalogue-preview-grant.json`. It binds the enrolled Auth0 identity, canonical staff ID, tenant, and verified database. The read requires an active Tenant Staff Manager role and the selected manager position. The production authorization catalogue and pricing and publication permissions retain their existing gates.

## View Finxplor prices and denominations

Sign in at [local staff management](https://localhost:3001/management/catalogue).
Choose Finxplor and search by source product ID. For example, `1002_1643` shows
the provider's 398 BDT face value with its AED conversion status.

The earlier sender-cost and selling-price pilot used a demo rate and is retired.
The current cards read the values saved by the customer-price refresh.

Product cards use the exact catalogue brand names and same-origin PNG tiles assembled from reviewed artwork. The tiles include the browser icons of the operators' own public sites and the public marks on the Glo, Indomaret, La Torre, and Meralco sites. The portal also serves brand-matched site icons, app publisher artwork and official card issuer images. A successful global sync saves Finxplor-provided artwork URLs for the same account and product. Unavailable artwork leaves the brand name visible. [Glo](https://www.gloworld.com/ng) · [Indomaret](https://www.indomaret.co.id/brand-kami/) · [La Torre](https://www.latorre.com.gt/terminos-y-condiciones) · [Meralco](https://www.meralco.com.ph/governance/annual-reports/2024/about-the-company)

Additional tile sources include the Airtel Bangladesh, Robi, Alfamart and Maroc Telecom images on Wikimedia Commons. The Atlas tiles preserve the original marks while resizing and padding them to the card dimensions. The Alfamart and Maroc Telecom tiles retain the cited CC BY-SA 4.0 attribution and licence for their image content. [Airtel Bangladesh](https://commons.wikimedia.org/wiki/File:Airtel_new_logo_%E0%A6%8F%E0%A6%AF%E0%A6%BC%E0%A6%BE%E0%A6%B0%E0%A6%9F%E0%A7%87%E0%A6%B2_%E0%A6%A8%E0%A6%A4%E0%A7%81%E0%A6%A8_%E0%A6%B2%E0%A7%8B%E0%A6%97%E0%A7%8B_airtel_(Powered_by_Robi).jpg) · [Robi Axiata](https://commons.wikimedia.org/wiki/File:Robi_Axiata_logo.svg) · [Alfamart, credited to Alfamart](https://commons.wikimedia.org/wiki/File:ALFAMART_LOGO_BARU.png) · [Maroc Telecom, uploaded by Houssam Atlas](https://commons.wikimedia.org/wiki/File:Maroc_Telecom_logo.png) · [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)


## Sync every Finxplor country

Sign in as Tenant Staff Manager and use **Sync all Finxplor products**. The
server checkpoints validated pages for the configured account. After a
transient provider error, it saves the products received so far, preserves
previously observed products, refreshes Layer 1, and labels the catalogue as
partial. The next sync resumes at the failed page. The portal reports the
number of saved products and the next page when available.

The first empty terminal page saves the observed catalogue. Complete coverage
requires an independent traversal with the same unique product identities and details. The checkpoint also saves verification progress. If the two
traversals return different products, the portal keeps the products observed
across both passes and continues to label coverage as partial. A subsequent
sync starts a new checkpoint.
Neither partial discovery nor the complete catalogue grants permission to sell
or publish products.

The equivalent command from `backend` is:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File .\scripts\setup-windows-catalogue.ps1 -Global
```

The normal startup applies migration `015_global_discovery_coverage.sql`. Sync receipts are saved under `.local/finxplor-refresh`; successful global receipts contain `completedCoverage: ALL_COUNTRIES` and `persisted: true`. The provider remains the configured Finxplor sandbox, so completeness covers products exposed to that account. Same-origin company artwork is matched by exact brand or recognized brand family; unrecognized brands retain their provider name.

## Refresh Finxplor customer prices in AED

The [staff catalogue](https://localhost:3001/management/catalogue) reads the saved
Finxplor source and AED amounts from the local PostgreSQL database. Migration
019 stores them in separate exact `NUMERIC` columns, `source_amount` and
`converted_aed`. `acquisition_cost_aed` stays NULL. Layer 1 does not calculate
a margin or a resale price.

A Finxplor customer price must come from an explicit, verified price source.
The available sandbox product responses supply fixed face values and variable
face-value bounds. The catalogue labels these as face values and indicates
when no customer price is present.

Put an approved Finxplor customer-price export in
`backend/.local/finxplor-customer-prices.json`. The JSON object contains
`version: 1`, `tenantId`, `providerAccountId` and a `prices` array.
Each price has the following fields.

| Field | Meaning |
| --- | --- |
| `discoveryId`, `sourceId` | Local discovery UUID and matching Finxplor source product ID |
| `priceKey`, `sourceReference` | Stable price identifier and provider evidence reference |
| `amount`, `currency` | Positive decimal string and uppercase currency code for the customer price |
| `observedAt`, `validUntil` | Provider observation and expiry timestamps with a UTC offset |

Configure `NUKHBAPAY_CURRENCY_API_KEY` in the private backend `.env`. The refresh
uses the [CurrencyApi.net v2 rates endpoint](https://currencyapi.net/documentation/rates/)
to get a USD-based rate table in one request. It divides the AED-per-USD quote
by the source-currency-per-USD quote and stores both legs with the provider
timestamp. The derived rate is rounded half-up to 12 decimal places.
PostgreSQL multiplies the source amount by the derived rate without rounding
to fils. AED amounts use rate 1 locally. A missing, expired or invalid rate
leaves the conversion pending. The refresh accepts rates whose source
timestamps are at most 72 hours old.

Run the guarded local development launcher from `backend`:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File .\scripts\setup-windows-catalogue.ps1 -ForStartup
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File .\scripts\setup-windows-catalogue.ps1 -RefreshFinxplorPrices
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File .\scripts\schedule-finxplor-customer-prices.ps1
```

The Windows task runs daily at 00:00 and 12:00 Dubai time as the current user.
Keep that Windows session signed in for the protected database credential.
Successful scheduled quotes are reused until the next cycle. A tenant staff
manager can click **Refresh exchange rates** beside **Sign out** to request new
quotes at any time. The refresh records each new quote separately and
updates the displayed AED amounts. If Currency API fails for a currency, a saved
quote for that currency in the current cycle stays available. The older
acquisition-evidence tables and historical rows remain available to their
existing restricted readers.

## Verify the approved Finxplor account for Layer 1

From the backend workspace, run the protected launcher:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File .\scripts\setup-windows-catalogue.ps1 -VerifyFinxplorLayer1
```

This confirms the read-only local database target and sandbox registration,
then requests two product pages and up to six product details. The sanitized
JSON receipt in `.local/` distinguishes observed HTTP pages from pages accepted
by the strict adapter and reports unique IDs and detail failures. The sample is
partial. Catalogue values are classified as `QUOTE_REQUIRED`. The command
leaves commercial evidence and publication tables untouched.

Compare the catalogue database major version from the receipt with the
disposable acceptance target. The separate `pnpm layer1:test:postgres`
command exercises exact pricing reads, identity arithmetic and historical
replay on PostgreSQL 18 with synthetic inputs. Migration 018 adds exact v2
valuation checks and preserves legacy evidence.
