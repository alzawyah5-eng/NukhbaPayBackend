# Attended Auth0 staff login on localhost

The login-only launcher uses the existing React staff UI, Auth0 OIDC BFF, canonical IAM reader and audit writer, and guarded durable session store. It exposes the signed-in staff and tenant summary. The existing local preview uses the same UI. The checkout's default `staff:start` behavior still offers the sign-in-disabled preview.

## Existing Auth0 test application

| Auth0 setting | Exact value |
| --- | --- |
| Allowed Callback URLs | `https://localhost:3001/auth/callback` |
| Allowed Logout URLs | `https://localhost:3001/auth/logged-out` |
| Allowed Web Origins | `https://localhost:3001` |

The browser UI and BFF share `https://localhost:3001`. Open `https://localhost:3001/login`. The UI uses same-origin session APIs. Universal Login is opened by `/auth/login` and the confidential code exchange runs on the BFF. No Vite development port needs registration. Use the existing test Regular Web Application, Authorization Code with PKCE, and its compatible confidential token endpoint authentication method. The current exchange uses `client_secret_post`.

In the test tenant, verify that **NukhbaPay Staff MFA** is deployed and attached to the active Login flow between Start and Complete. Check the deployed Action version's `event.secrets` reference against its secret **name**. `NUKHABAPAY_STAFF_CLIENT_ID` and `NUKHBAPAY_STAFF_CLIENT_ID` are different names. Confirm the binding and the name in the Dashboard without sharing the value. [Auth0 application settings](https://auth0.com/docs/get-started/applications/application-settings)

In the Auth0 Development Staff API settings, choose **RFC 9068** under **JSON Web Token (JWT) Profile**. The persistent Windows Staff Portal accepts **600 seconds** for ordinary sign-in. Set **Maximum Access Token Lifetime (Seconds)** to **600** for this API, save, and sign in again. Keep the implicit/hybrid lifetime at or below the maximum. The session ends at the earliest of signed access-token expiry, signed ID-token expiry, or 10 minutes after authentication. The other local launchers and privileged step-up still require an access-token lifetime of **300 seconds** or less. [Auth0 API settings](https://auth0.com/docs/get-started/apis/api-settings) · [Auth0 access-token profile](https://auth0.com/docs/get-started/apis/configure-access-token-profile)

In the Auth0 test Staff application Settings, set **Maximum ID Token Lifetime** to **3600 seconds** or less. The BFF requires a fresh trusted ID token with `amr` containing `mfa`, plus exact issuer, client, nonce, subject and token checks. The API must issue the configured signed human-principal claim. The regular staff login establishes no command-specific MFA assurance. [Auth0 application settings](https://auth0.com/docs/get-started/applications/application-settings)

## Private process configuration

Supply the following settings in the PowerShell process that starts the app. Use the approved secret store or a hidden prompt for confidential values. Keep values out of files, command history and frontend configuration.

| Variable | Value source |
| --- | --- |
| `NUKHBAPAY_STAFF_AUTH0_ISSUER` | Approved canonical HTTPS issuer for the existing test tenant, with its terminating slash |
| `NUKHBAPAY_STAFF_AUTH0_CLIENT_ID` | Existing staff application's client ID |
| `NUKHBAPAY_STAFF_AUTH0_CLIENT_SECRET` | Staff application's confidential secret, injected into the BFF process only |
| `NUKHBAPAY_STAFF_AUTH0_AUDIENCE` | Reviewed staff API audience |
| `NUKHBAPAY_STAFF_AUTH0_STAFF_KIND_CLAIM` | Exact signed HTTPS human-principal claim name |
| `NUKHBAPAY_STAFF_AUTH0_TENANT_ID` | UUID of the existing approved NukhbaPay test tenant membership |
| `NUKHBAPAY_STAFF_AUTH0_ACCESS_TOKEN_AUDIENCE_MODE` | Default `api-only`. The private launcher for the verified isolated Auth0 enrollment uses `api-and-userinfo` for the Staff API requested with `openid`. This permits the exact Staff API and issuer `/userinfo` pair. [Auth0 audience behavior](https://auth0.com/docs/secure/tokens/access-tokens/get-access-tokens) |
| `DB_IDENTITY_READER_URL`, `DB_IDENTITY_WRITER_URL` | Approved existing guarded test DB and separate restricted IAM/audit role credential references |
| `DB_STAFF_SESSION_URL`, `DB_STAFF_SESSION_ROLE` | Approved guarded session store connection and its `nukh_session_…` role on that same database |
| `DB_STAFF_SESSION_EXPECTED_DATABASE_OID` | Existing approved test database OID from its deployment metadata |

Supply an already provisioned test database and canonical enrollment for the intended test staff identity. The approved target uses the existing guarded session namespace on IPv4 loopback port 5432 and a reviewed `nukhabapay_b3b2_…` or `nukhabapay_b3b3_…` database. The launcher checks the database OID and exact roles before exposing sign-in. The guard does not select a database automatically. An Auth0 identity without its exact issuer/subject enrollment and active NukhbaPay tenant membership is denied dashboard access.

If the approved secret store does not inject into this shell, the following prompts place the four confidential values in this PowerShell process without echoing them or typing the values into commands. Supply the other settings from the approved test configuration in the same process.

```powershell
foreach ($name in @('NUKHBAPAY_STAFF_AUTH0_CLIENT_SECRET', 'DB_IDENTITY_READER_URL', 'DB_IDENTITY_WRITER_URL', 'DB_STAFF_SESSION_URL')) {
    $secret = Read-Host "Enter approved value for $name" -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    try {
        [Environment]::SetEnvironmentVariable($name, [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer), 'Process')
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        $secret.Dispose()
    }
}
```

## Start

Use the repo's existing reviewed localhost certificate. If Windows does not already trust it, inspect the exact public thumbprint. The existing `setup-staff-development-https.ps1 -Action Trust -Thumbprint <reviewed-thumbprint>` command performs the separate current-user trust action when you choose to approve that certificate. The login launcher leaves certificate trust untouched and requires a certificate already trusted by that browser user. [Local HTTPS setup script](../../scripts/setup-staff-development-https.ps1)

Stop the earlier staff preview if it owns port 3001. From the repository root and the same PowerShell session containing the approved settings, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\dev-staff-portal.ps1 -Auth0TestLogin
```

The same-origin application stays in the foreground. Use `Ctrl+C` to shut it down. The launcher does not enroll users, apply migrations, add roles, enable the demo preview, or supply staff effect ports. The process owns the OIDC transaction state and session-bound CSRF key. Browser storage holds no OAuth tokens. After a server restart, sign in again.

## Manual check

1. Open `https://localhost:3001/login` in Chrome or Edge and select **Continue with secure sign in**.
2. On the approved Auth0 Universal Login page, enter the test staff credentials and complete the enrolled OTP or WebAuthn challenge.
3. Check that the portal opens the authenticated staff view with the expected canonical staff identity and NukhbaPay tenant.
4. Sign out and confirm that reloading the staff portal requires a new login.
5. Report whether Universal Login appeared, MFA was requested and succeeded, and the portal opened. Include any error after removing confidential details.

## Persistent Windows staff database

For an already enrolled Windows development database, open your own PowerShell terminal in the backend repository and run:

```powershell
corepack.cmd pnpm staff:local
```

On the first run, the launcher asks privately for the enrolled Auth0 User ID, the Staff Portal Client Secret, and the three existing PostgreSQL role passwords. It selects the staff tenant from the existing enrollment receipt. After the guarded preflight passes, it saves the private inputs with Windows DPAPI under the current user's LocalAppData folder. Later starts reuse the saved settings. Open `https://localhost:3001/login` when the launcher prints the link.

Run `powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\staff-local.ps1 -Check` to verify a saved setup without starting a listener. Use `-Configure` after a credential rotation or enrollment change.

For initial provisioning of `nukhbapay_staff`, use the following commands from the repository root in a private PowerShell window.

1. Run `powershell.exe -NoProfile -File .\scripts\inspect-windows-staff-database.ps1`. Enter the local PostgreSQL administrator password at the hidden prompt. The inspection checks the registered Windows service, database owner, OID and cluster identifier, then records which workload roles and schemas are present.
2. Run `powershell.exe -NoProfile -File .\scripts\connect-windows-staff-database.ps1` to grant database CONNECT to the existing restricted IAM reader and writer. Enter each role's own PostgreSQL password when prompted. To repeat only the login checks, append `-VerifyOnly`.
3. For a new empty Windows staff database, run `powershell.exe -NoProfile -File .\scripts\backup-windows-staff-database.ps1`. It writes a custom-format backup under the current user's protected LocalAppData directory. Preserve the backup record for retries of the same installation.
4. Run `node scripts/test/windows-staff-migration-rehearsal.mjs`. It restores that archive into a private PostgreSQL 18 cluster on a separate port and exercises rollback, replay, role permissions, enrollment, tenant isolation and audited sessions. The result binds the backup, source cluster, database OID and candidate files.
5. Run `powershell.exe -NoProfile -File .\scripts\apply-windows-staff-schema.ps1` for the qualified native installation. The owner creates the IAM, session and workspace objects in one transaction. The session role starts with login disabled. The private PostgreSQL password prompt activates its separate SCRAM credential. A retry with the same candidate reconciles its committed history. Keep the original backup and candidate available.
6. For first enrollment, pass `-EnrollFirstStaff -RosterDigest <approved-sha256>` and optionally `-LaunchPortal`. The roster digest covers the UTF-8 JSON array of tenant key, exact work name and lowercase work email. The operator supplies the approved staff member's Auth0 User ID privately. First enrollment creates the tenant, one active identity and membership, the six departments and an immutable receipt. Each role grant requires its own authorization.
7. To repeat the connection checks, run `powershell.exe -NoProfile -File .\scripts\start-windows-staff-portal.ps1 -StorageOnly`. For the full login preflight use `-PreflightOnly`. It also verifies the specified enrollment, browser assets and localhost TLS. Omit both switches to start the HTTPS portal. The bookmark at `http://127.0.0.1:3010/preview/overview` redirects after live storage readiness succeeds. The user completes Auth0 MFA in their browser.

### Use an existing pgAdmin administrator session

If pgAdmin already has a SCRAM-authenticated connection as `postgres` to the registered Windows development database, it can run the schema step. The PowerShell and pgAdmin paths execute the same transaction under the same target and role checks. After the backup and restore rehearsal pass, run the following in PowerShell from the repository root.

```powershell
$registered = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\postgresql-x64-18' -Name ImagePath).ImagePath
$directory = [regex]::Match($registered, '(?i)\s-D\s+"([^"]+)"')
if (!$directory.Success -or (Get-Service postgresql-x64-18).Status -ne 'Running') { throw 'Registered PostgreSQL service unavailable.' }
$env:NUKHBAPAY_REGISTERED_PG_DIRECTORY = $directory.Groups[1].Value
node scripts/windows-staff-migration.mjs --prepare-pgadmin
```

Open the generated `.sql` file in Query Tool on `127.0.0.1:5432/nukhbapay_staff`. Use an idle connection with Auto commit on and execute the whole file. The file contains the checked schema, hashes, and target metadata. A result of `Windows staff schema verified`, version `1`, confirms the schema step. Credential provisioning, the named staff enrollment, and the portal connection check follow separately.

In the same repository PowerShell, with the registered directory set as above, run `node scripts/prepare-windows-staff-session.mjs`. In pgAdmin Desktop, select the connected database and open **Tools → PSQL Tool**. Use `\i 'C:/path/to/generated-file.psql'` with the printed filename. The existing session-role installer prompts twice for the new restricted role's password and records a nonsecret database inspection under `.local`. Choose a distinct password of at least 16 characters. A rerun preserves an already provisioned credential. Keep the authenticated PSQL Tool open for enrollment.

For the owner-approved first staff member, start `scripts/complete-windows-staff-enrollment.ps1` in private Windows PowerShell, supplying a fresh GUID in N format as `-RunId` and the approved roster SHA-256 as `-RosterDigest`. Enter the work name, work email, and Auth0 test User ID at the hidden prompts. Run the displayed `\i` command in the local PSQL Tool. The command reads the profile through a single-use local named pipe. It validates the installed candidate and roster, commits the membership, and returns the tenant UUID. The PowerShell window continues to the existing portal preflight for the three restricted database connections and test Auth0 application. Keep the window open while testing. A failed run can be retried with a fresh run ID and the same approved profile.

If pgAdmin's PSQL Tool fails to display a database prompt, an administrator can run `powershell.exe -NoProfile -File .\scripts\open-windows-staff-psql.ps1` from the repository root. This launches the installed PostgreSQL 18 client directly. Enter the existing Windows PostgreSQL `postgres` password in the private console. The launcher runs the same verified session-role script, then opens an authenticated database prompt for the enrollment command. Close the administrator session with `\q` after enrollment.
