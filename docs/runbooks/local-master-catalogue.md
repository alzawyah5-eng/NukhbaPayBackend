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
