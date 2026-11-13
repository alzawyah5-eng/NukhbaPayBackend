# NukhbaPay Staff Management — React UI Preview

A standalone **React + TypeScript + Vite** development preview implementing the **13 approved Figma staff-management screens**, with NukhbaPay's purple/green visual system. Uses *fictional data*, and **does not connect to any real staff, identity, transaction or provider API**.

[Open original editable Figma design](https://www.figma.com/design/1N5xohAzpz6aMY3YrVVNgg)  
[Open design and security handoff](docs/DEVELOPER_HANDOFF.md)

## Windows / VS Code: start in five steps

1. Extract `NukhbaPay_Staff_React_Demo.zip` to a safe local folder such as `C:\Projects\nukhbapay-staff-react`.
2. Open that folder in **VS Code** (File → Open Folder).
3. Open **Terminal → New Terminal** (PowerShell).
4. Run the following:

```powershell
node --version
npm --version
npm install
npm run dev
```

5. Open the local URL shown in the terminal, normally **http://localhost:5173** (configured to bind to `127.0.0.1`).

You need Node.js **20.19+ or 22+**, npm, and normal access to the npm registry on your PC. The developer's existing Node 24 setup is suitable. Do **not** run `index.html` by double-clicking it; Vite must serve this application.

### Verify for production handoff

```powershell
npm run typecheck
npm run build
npm run preview
```

> **Build verification status:** TypeScript syntax, local imports, CSS parsing, source asset and route inventory are statically checked here. **npm install and an actual Vite production build could not be run in the authoring workspace** because the npm registry packages were not cached and registry access was unavailable. Run the commands above on Windows and resolve any dependency/compiler issues before integrating.

## 13 screen routes

| # | Screen | URL |
|---|---|---|
| 01 | Overview | `/overview` |
| 02 | Staff directory | `/staff` |
| 03 | Invite staff | `/staff/invite` |
| 04 | Staff profile | `/staff/stf-1001` (demo record) |
| 05 | Roles and permissions | `/roles` |
| 06 | Departments and teams | `/departments` |
| 07 | Access requests | `/access-requests` |
| 08 | Security center | `/security` |
| 09 | Sessions and devices | `/sessions` |
| 10 | Audit logs | `/audit` |
| 11 | Staff reports | `/reports` |
| 12 | Workspace settings | `/settings` |
| 13 | Secure sign-in design | `/login` |

## Working preview interactions

- Responsive navigation (sidebar, mobile menu), search from toolbar to staff directory.
- Staff search, role/status filters, alphabetical sort, pagination, and profile navigation.
- Four-stage staff invitation form with validation; adds a **temporary fictional Pending row in browser memory only**.
- Select roles to view a **mock permission matrix**; a role change opens a non-operational request dialog.
- Review access requests with a required reason; **changes fictional data in memory only**.
- Simulate revoking a fictional session after a required reason; **no live sessions are touched**.
- Filter read-only audit history; reports and audit exports deliberately disabled pending real authorization.
- View policy and security indicators, demo preferences, status notices, and a sign-in mockup that intentionally **does not authenticate**.

All demo mutations reset when the page is refreshed. No cookies, OAuth tokens, payment credentials, API keys, or secrets are stored or transmitted by the preview.

## Project map

```text
nukhbapay-staff-react/
  public/
    nukhbapay-original-logo-reference.png   # User-supplied NukhbaPay logo reference
  src/
    components/
      AppShell.tsx                           # Shared header, sidebar and title
      UI.tsx                                 # Buttons, badges, tables, inputs, dialog
    data/
      mockData.ts                            # Fictional demo records and types
      DemoContext.tsx                        # In-memory UI preview state
    lib/
      utils.ts                               # UTC-to-local formatting helper
    pages/
      DashboardPages.tsx                     # 13 screen implementations
    App.tsx                                  # Client-side routes
    main.tsx                                 # React entry point
    styles.css                               # Figma-matched token and responsive styles
  docs/
    DEVELOPER_HANDOFF.md                     # Full architectural, UI & security handoff
  index.html
  package.json
  vite.config.ts
  tsconfig.json
```

## Security and integration boundaries

- This is **not a login system**, not authorization middleware, and not a production staff admin application.
- **Never** use the UI's mock `permissionsByRole` rules to authorize requests. A backend must validate user identity, tenant boundary, object ownership and permission on every request.
- Only call the **central NukhbaPay platform staff-facing API**, never third-party provider APIs or a kiosk vendor directly.
- Implement trusted OIDC Authorization Code + PKCE (preferred BFF pattern), phishing-resistant MFA, secure cookies, CSRF protection, server-side authorization, immutable audit events and separation of duties **before** any real staff action.
- Treat all endpoint names in the handoff as **proposed contracts**, not implemented URLs.
- A visual sign-in mockup is never evidence that MFA/OIDC has been implemented.
- Do not replace the existing NukhbaPay monorepo or any payment app source with this standalone preview. Review its existing packages and integrate only after mapping the architecture.
- Uses the original user-supplied logo as a local image, not a network URL. The stylesheet uses a locally available `Inter` font when present and otherwise a system font. No third-party font request is required.

## UI discrepancies to check against Figma

Figma is the visual source of truth. The React preview adapts absolute-positioned design layers into flexible CSS grid and responsive layouts. Check spacing and desktop visual fidelity, then screen reader and keyboard access, before production. This is an initial implementation, not a signed-off pixel-perfect build. The data values such as `128 staff` are illustrative numbers from the approved design and may not equal the smaller mock-table dataset.

## Development sequence

1. **Already delivered:** 13 visual React screens, reusable UI system, in-memory interactions, and handoff documentation.
2. **Next:** Run dependency install, typecheck, browser visual regression, and fix any issues on the Windows dev machine.
3. **Brick 3:** Implement staff OIDC + tenant/permission enforcement and run negative auth tests in the existing NukhbaPay platform.
4. Wire React screens to tested, scoped staff API endpoints; remove all demo data and disabled mutations.
5. Security/accessibility test and obtain approval before using real staff records or deploying.

No part of this package is approved to process real money, staff access grants, or provider integrations.
