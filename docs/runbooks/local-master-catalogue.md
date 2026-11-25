# Local Master Catalogue database

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

The local manifest covers products, accounts, mappings, snapshots, offers, refresh storage, pricing drafts, submission and publication evidence, the transactional outbox and the published read projection. `setup-windows-catalogue.ps1 -Rehearse` uses the saved migration role to verify the initial draft, approval, publication and outbox transaction and roll back its schema changes and test rows. The original disposable `007`–`010` installers retain their target guards. This local catalogue package uses independent publication schema changes and pins the unchanged refresh and delivery SQL dependencies. Publication, delivery, channel access and refresh execution still require qualified workload and authority contracts.

Append `-Check` for a read-only preflight with saved credentials and no listener. It reports pending migrations so the normal startup command can apply them. Only the server-selected staff tenant may obtain a catalogue transaction scope, and IAM must authorize `catalog.read` before the catalogue appears in the workspace. Catalogue reads retain the existing staff audit requirement. The initial installation configures no provider availability or staff permission grants.

## Finxplor discovery pilot

After guarded catalogue setup, run the one-product sandbox import from the backend folder:

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\setup-windows-catalogue.ps1 -ImportFinxplor
```

The importer requires the verified Finxplor sandbox origin, the enrolled local tenant, and its disabled provider account binding. It requests one product and writes an immutable discovery using the catalogue runtime role. Repeating the same observation returns the original discovery ID. The portal shows it under **Provider discoveries** to staff authorized for the Master Catalogue. The discovery and its rule-based review reason leave pricing, availability for sale, and publication to their existing authorization workflows.

Add `-Full` to traverse all reported pages, validate their total and unique product IDs, and commit the discoveries as one batch. The local pilot accepts up to 1,000 products.

A successful full import commits a scan and its exact set of observations in the same transaction. The catalogue displays the latest full scan for each account, including products that reverted to a previously observed denomination. Products omitted from a later complete scan leave the current list. Earlier observations and scans remain available as history. Failed or incomplete imports preserve the previous scan. Before the first full scan on an account, the page displays its existing discoveries.

Register the local refresh from the `backend` directory after verifying a full sandbox import:

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\schedule-finxplor-refresh.ps1
Get-ScheduledTaskInfo -TaskName 'NukhbaPay Finxplor Catalogue Refresh'
```

The task runs at 08:00 and 20:00 Windows local time while the current Windows user is signed in. It uses the same guarded importer and encrypted catalogue runtime credential as a manual run. A skipped or failed run can be checked in Task Scheduler. The import refreshes product and denomination observations. Customer prices remain governed by approved mapping, commercial terms, and the pricing workflow.

Select Finxplor in Provider discoveries to see provider denominations and sale-price readiness. The provider API inventory records the implemented listing and detail routes and their verification status. [Finxplor API inventory](../providers/provider-api-inventory.md#finxplor-connect)

Compare a product from the latest saved full scan with the sandbox detail response:

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\setup-windows-catalogue.ps1 -ImportFinxplor -ProductId 1002_1643
```

The command reads the bound tenant and account, prints the validated catalogue fields and reports differences from the saved scan. Product detail checks leave the stored scan and pricing workflow intact.

The hybrid price review joins a succeeded advisory job to the exact tenant, canonical product, approved offer, and completed source snapshot. The deterministic price policy calculates the unpublished draft. The offline worker tests exercise the local Python mock fallback with approved synthetic source data. The local staff database reader has discovery observations and has no qualified Finxplor advisory job or commercial price evidence to return. Real pricing requires verified account debit and fees, the approved canonical mapping, and a configured price policy.

The Windows launcher can also honor an explicitly authorized local-only Catalogue read grant in `.local/windows-catalogue-preview-grant.json`. It binds the enrolled Auth0 identity, canonical staff ID, tenant, and verified database. The read requires an active Tenant Staff Manager role and the selected manager position. The production authorization catalogue and pricing and publication permissions retain their existing gates.

## Show the catalogue and AED price preview

Sign in at [local staff management](https://localhost:3001/management/catalogue). Choose Finxplor and Bangladesh, then search for `1002_1643`. The **15 GB 30 Days** card shows the saved 398 BDT denomination and the server-calculated AED demo estimate. **Preview AED price** opens the read-only breakdown with the fixed 2.00 AED platform fee and 0.50 AED commission.

The ignored `.local/windows-catalogue-price-preview.json` file holds one owner-provided observation for the demo. It is bound to the verified database setup, staff tenant and current discovery ID. If a new source version replaces the discovery or a product lacks a captured sender cost, the preview shows the missing evidence. For the pilot, Finxplor displayed a 3.17 GBP sender cost. With the demo rate of 4.70, the estimated cost is 14.90 AED and the price preview is 17.40 AED. Real prices require confirmed wallet debit, fees and settlement currency, an approved FX rate and price policy, and an eligible mapping.

Product cards use the exact catalogue brand names and same-origin PNG tiles assembled from reviewed artwork. The tiles include the browser icons of the operators' own public sites and the public marks on the Glo, Indomaret, La Torre, and Meralco sites. New brands display their catalogue name until a corresponding logo is reviewed. [Glo](https://www.gloworld.com/ng) · [Indomaret](https://www.indomaret.co.id/brand-kami/) · [La Torre](https://www.latorre.com.gt/terminos-y-condiciones) · [Meralco](https://www.meralco.com.ph/governance/annual-reports/2024/about-the-company)

Additional tile sources include the Airtel Bangladesh, Robi, Alfamart and Maroc Telecom images on Wikimedia Commons. The Atlas tiles preserve the original marks while resizing and padding them to the card dimensions. The Alfamart and Maroc Telecom tiles retain the cited CC BY-SA 4.0 attribution and licence for their image content. [Airtel Bangladesh](https://commons.wikimedia.org/wiki/File:Airtel_new_logo_%E0%A6%8F%E0%A6%AF%E0%A6%BC%E0%A6%BE%E0%A6%B0%E0%A6%9F%E0%A7%87%E0%A6%B2_%E0%A6%A8%E0%A6%A4%E0%A7%81%E0%A6%A8_%E0%A6%B2%E0%A7%8B%E0%A6%97%E0%A7%8B_airtel_(Powered_by_Robi).jpg) · [Robi Axiata](https://commons.wikimedia.org/wiki/File:Robi_Axiata_logo.svg) · [Alfamart, credited to Alfamart](https://commons.wikimedia.org/wiki/File:ALFAMART_LOGO_BARU.png) · [Maroc Telecom, uploaded by Houssam Atlas](https://commons.wikimedia.org/wiki/File:Maroc_Telecom_logo.png) · [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
