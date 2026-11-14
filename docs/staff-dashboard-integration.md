# Staff dashboard frontend integration

Track C integrates the supplied React frontend into `apps/admin-web`, on `brick3/staff-dashboard`. It does not change API authentication, IAM, database migrations, financial logic, or other applications.

## Sources inspected

- `frontend-handover/nukhbapay-staff-react`: React 19, TypeScript, Vite 6, React Router 7 and Lucide. Thirteen route views in `DashboardPages.tsx`, shared `AppShell`/`UI`, CSS brand tokens, original logo, fictional data and local demo context. No real auth client or API service was supplied.
- `frontend-handover/STAFF MANAGEMENT DESIGN NUKHBAPAY`: all thirteen numbered 1440 × 900 reference PNGs, UI kit `.fig`, foundation PNG, primary/secondary button PNGs, success badge, logo and handoff document. Overview and sign-in reference images were visually inspected. The source screen/component/CSS implementation is retained; browser screenshot parity has not been established.
- `apps/admin-web`: existing HTTPS BFF with host/origin checks, no-store, restrictive CSP, HttpOnly secure session cookie and CSRF-protected logout. Default CLI disables identity/session activation.
- `apps/api`: only the health controller is registered in `AppModule`. Internal authorization/workflow foundations are not browser HTTP endpoints. Proposed `/staff-api/v1/...` routes in the handover are not implemented contracts.

## Integration boundaries

`staff:build` now compiles both server and client. Startup loads only built HTML, JS, CSS and the supplied logo into an asset map; request paths never map directly to the filesystem. Explicit screen routes support browser reload and directory search queries. Unknown APIs, source files, maps, encoded paths and traversal receive 404. Host/origin checks run before assets and auth routes. CSP allows same-origin assets and forbids inline script/style; the existing report's bar heights now use CSS classes.

The normal application contacts only the same-origin BFF: `GET /auth/config`, `GET /auth/session`, `GET /auth/me` and `POST /auth/logout`. CSRF stays in memory; access tokens, actor/tenant selection and client secrets are absent. Denied, expired, unavailable, malformed and offline session/profile responses do not produce a staff identity. Logout redirects only after confirmed local revocation, using either a 204 local landing or an exact server-allowlisted provider destination. No email/password is collected by React. The 2026-11-14 [synthetic integration](runbooks/staff-auth0-synthetic-integration.md) wires login availability, minimal self profile, self-only navigation and expiry handling; real login and persistent session activation remain disabled.

The normal application renders no mock metrics, roles, staff or permissions. Unsupported management operations remain unavailable. The supplied thirteen-screen preview is explicitly namespaced under `/preview`, lazy loaded, clearly labeled and entirely in browser memory. It provides visual review of the integrated assets without implying working backend operations.

## Verification

Commands are the existing `pnpm.cmd staff:typecheck`, `pnpm.cmd staff:build` and `pnpm.cmd staff:test`. Added focused tests cover asset/deep-link boundaries, session error handling and confirmed CSRF logout. Existing HTTPS tests still require the documented explicit test certificate settings; session integration requires the disposable PostgreSQL fixture. No certificate trust changes or TLS verification bypasses are part of this change.

Verified locally: staff typecheck passed; the production bundle built successfully; all nine staff tests passed without skips, including the five HTTPS/security tests. The test run supplied a fresh one-day localhost-only CA=false OpenSSL certificate/PFX through the existing explicit test environment variables, pinned that certificate per client, and removed its temporary key/certificate directory afterwards. Windows trust was unchanged. The build required execution outside the filesystem sandbox because esbuild's configuration resolution probes ancestor directories. Database/session integration was not run because no API, IAM, migration or financial security modules changed.

Browser screenshots, formal accessibility checks, real OIDC/MFA, permission-driven navigation, staff read/mutation APIs and live integration acceptance remain outstanding. This is an integrated frontend and session boundary, not a completed live staff-management service.

## Final preview safeguard

Preview access requires both server environment variables `NODE_ENV=development` and `NUKHBAPAY_STAFF_UI_PREVIEW=enabled`. It is disabled by default and denied in production even with the opt-in flag. The Vite manifest identifies the entry's static dependency closure; other JavaScript/CSS chunks require the development preview policy. Disabled preview routes and direct demo chunk URLs return 404. The manifest itself is never served. Query parameters and headers cannot enable preview. Default-denied and production-denied behavior, including demo asset requests, is covered by the HTTPS suite.

## Exact integration commit file list

- `apps/admin-web/README.md`
- `apps/admin-web/client/index.html`
- `apps/admin-web/client/public/nukhbapay-original-logo-reference.png`
- `apps/admin-web/client/src/App.tsx`
- `apps/admin-web/client/src/PlatformApp.tsx`
- `apps/admin-web/client/src/components/AppShell.tsx`
- `apps/admin-web/client/src/components/UI.tsx`
- `apps/admin-web/client/src/data/DemoContext.tsx`
- `apps/admin-web/client/src/data/mockData.ts`
- `apps/admin-web/client/src/lib/utils.ts`
- `apps/admin-web/client/src/main.tsx`
- `apps/admin-web/client/src/pages/DashboardPages.tsx`
- `apps/admin-web/client/src/session.ts`
- `apps/admin-web/client/src/styles.css`
- `apps/admin-web/client/src/vite-env.d.ts`
- `apps/admin-web/client/tsconfig.json`
- `apps/admin-web/package.json`
- `apps/admin-web/src/browser-assets.ts`
- `apps/admin-web/src/main.ts`
- `apps/admin-web/src/portal.ts`
- `apps/admin-web/test/browser-assets.spec.ts`
- `apps/admin-web/test/portal.spec.ts`
- `apps/admin-web/test/session-client.spec.ts`
- `apps/admin-web/vite.config.ts`
- `docs/staff-dashboard-integration.md`
- `frontend-handover/STAFF MANAGEMENT DESIGN NUKHBAPAY/00 · Design System/Foundations.png`
- `frontend-handover/STAFF MANAGEMENT DESIGN NUKHBAPAY/Badge/Success.png`
- `frontend-handover/STAFF MANAGEMENT DESIGN NUKHBAPAY/Button/Primary.png`
- `frontend-handover/STAFF MANAGEMENT DESIGN NUKHBAPAY/Button/Secondary.png`
- `frontend-handover/STAFF MANAGEMENT DESIGN NUKHBAPAY/NukhbaPay — Staff Management Dashboard • UI Kit & 13 Screens.fig`
- `frontend-handover/STAFF MANAGEMENT DESIGN NUKHBAPAY/NukhbaPay/Original logo.png`
- `frontend-handover/STAFF MANAGEMENT DESIGN NUKHBAPAY/NukhbaPay_Developer_Handoff.md`
- `frontend-handover/STAFF MANAGEMENT DESIGN NUKHBAPAY/SCREEN 01 · Staff overview.png`
- `frontend-handover/STAFF MANAGEMENT DESIGN NUKHBAPAY/SCREEN 02 · Staff directory.png`
- `frontend-handover/STAFF MANAGEMENT DESIGN NUKHBAPAY/SCREEN 03 · Invite new staff.png`
- `frontend-handover/STAFF MANAGEMENT DESIGN NUKHBAPAY/SCREEN 04 · Staff profile.png`
- `frontend-handover/STAFF MANAGEMENT DESIGN NUKHBAPAY/SCREEN 05 · Roles & permissions.png`
- `frontend-handover/STAFF MANAGEMENT DESIGN NUKHBAPAY/SCREEN 06 · Departments & teams.png`
- `frontend-handover/STAFF MANAGEMENT DESIGN NUKHBAPAY/SCREEN 07 · Access requests.png`
- `frontend-handover/STAFF MANAGEMENT DESIGN NUKHBAPAY/SCREEN 08 · Security center.png`
- `frontend-handover/STAFF MANAGEMENT DESIGN NUKHBAPAY/SCREEN 09 · Sessions & devices.png`
- `frontend-handover/STAFF MANAGEMENT DESIGN NUKHBAPAY/SCREEN 10 · Audit logs.png`
- `frontend-handover/STAFF MANAGEMENT DESIGN NUKHBAPAY/SCREEN 11 · Staff reports.png`
- `frontend-handover/STAFF MANAGEMENT DESIGN NUKHBAPAY/SCREEN 12 · Workspace settings.png`
- `frontend-handover/STAFF MANAGEMENT DESIGN NUKHBAPAY/SCREEN 13 · Secure staff sign in.png`
- `frontend-handover/nukhbapay-staff-react/.gitignore`
- `frontend-handover/nukhbapay-staff-react/README.md`
- `frontend-handover/nukhbapay-staff-react/docs/DEVELOPER_HANDOFF.md`
- `frontend-handover/nukhbapay-staff-react/docs/IMPLEMENTATION_CHECKLIST.md`
- `frontend-handover/nukhbapay-staff-react/index.html`
- `frontend-handover/nukhbapay-staff-react/package.json`
- `frontend-handover/nukhbapay-staff-react/public/nukhbapay-original-logo-reference.png`
- `frontend-handover/nukhbapay-staff-react/src/App.tsx`
- `frontend-handover/nukhbapay-staff-react/src/components/AppShell.tsx`
- `frontend-handover/nukhbapay-staff-react/src/components/UI.tsx`
- `frontend-handover/nukhbapay-staff-react/src/data/DemoContext.tsx`
- `frontend-handover/nukhbapay-staff-react/src/data/mockData.ts`
- `frontend-handover/nukhbapay-staff-react/src/lib/utils.ts`
- `frontend-handover/nukhbapay-staff-react/src/main.tsx`
- `frontend-handover/nukhbapay-staff-react/src/pages/DashboardPages.tsx`
- `frontend-handover/nukhbapay-staff-react/src/styles.css`
- `frontend-handover/nukhbapay-staff-react/tsconfig.json`
- `frontend-handover/nukhbapay-staff-react/vite.config.ts`
- `pnpm-lock.yaml`
