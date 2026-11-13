# Nukhbapay staff portal BFF

Minimal Node 24 HTTPS server and strict TypeScript, using no new runtime framework. The API remains 127.0.0.1:3000; this BFF targets https://localhost:3001 on loopback. Real Auth0 sign-in and session activation are disabled in the CLI.

Run `pnpm.cmd staff:build`, then follow [development certificate setup](../../docs/security/staff-server-sessions.md). Private certificates and DPAPI-protected passphrases belong outside OneDrive/source/checkpoints. Windows trust was intentionally left unchanged. Use the documented explicit pinned-client-only launcher mode with clients that trust the exact public certificate; browser trust is not established. The normal launcher otherwise requires the reviewed current-user trust entry. Never disable certificate verification.

The browser receives no Auth0 access token, client secret or backend source. Its fixed same-origin script can read audited session status and perform CSRF-protected logout only when a trusted internal synthetic test bootstrap supplies the session port. No HTTP route creates sessions from IDs, JSON actors or synthetic assurance.

The internal session lifecycle and proposed PostgreSQL candidate live in the existing application/database packages, not browser code. Existing API authentication modes/JWT checks, IAM/catalogue restrictions and financial logic remain unchanged. See ADR 0022 and current verification for actual evidence and activation blockers.

Commands: `pnpm.cmd staff:build`, `pnpm.cmd staff:typecheck`, `pnpm.cmd staff:test`, `pnpm.cmd staff:sessions:test:integration`. HTTPS tests require explicitly supplied local test certificate settings; integration additionally requires the existing verified disposable PostgreSQL fixture settings. Missing configuration fails rather than skipping tests.
