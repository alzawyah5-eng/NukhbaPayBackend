# Staff browser and Node BFF module boundary

13 November 2026, Asia/Dubai. This implements the final structure gate for the already merged local Brick 3 source. Operational activation is separate.

## Explicit classification

The trusted Node BFF is `apps/admin-web/src/`, compiled by its existing TypeScript configuration with `rootDir=src` and `include=src/**/*.ts`. `apps/admin-web/test/` contains server tests, including synthetic identity fixtures. The root `vite.config.ts` is trusted build configuration. These are directory/entry-point classifications, not exceptions for particular reported filenames.

Vite's reviewed root is `apps/admin-web/client/`; its `index.html` declares the module entry in `client/src/`. Every other authored module under admin-web, including new or unclassified directories, is treated as browser code. Nested names such as client/src/test or client/dist do not confer server trust. Browser imports reaching BFF source, server tests, build configuration, another application or privileged backend packages are rejected even through aliases or re-exports.

The source gate uses the existing pinned TypeScript compiler API to parse imports and resolve aliases and relative modules. It inspects all browser modules, not only currently reachable entry files, and recursively inspects shared dependencies outside the browser directory. Only the reviewed browser packages (React, React DOM, React Router DOM and lucide-react) are accepted as external application imports. Backend package names in either project spelling, Node built-ins, jose/pg and other unapproved packages reject. Type-only imports, re-exports, import-equals, literal dynamic imports and require calls receive the same checks. Computed loaders, Node globals, build/server environment access, dynamic code and unreviewed worker entries reject.

Credential/private-key patterns, secret-named values, private configuration imports, unsupported dependency file types, opaque CSS loading, active public assets, symlinked sources, inline/external HTML script entries and unreviewed Vite root/alias/define/environment overrides also reject. Errors contain rule categories and paths, not secret values. Missing tools, unresolved modules, malformed syntax/configuration or absent build evidence fail closed. There is no warning-only or test-mode exemption in production checking.

## Actual production build

`browserBoundaryPlugin()` runs the source gate at Vite build start and examines Rollup's actual module graph before output. This is independent of TypeScript's source resolution and catches privileged modules brought in through build resolution. It rejects external/Node/backend modules and scans emitted text for credential/private-key evidence.

The generated `dist/client/browser-boundary-report.json` lists the inspected graph. It contains module references only; it is not authority or authenticated staff evidence. Runtime asset serving remains an explicit allowlist; neither this report, the internal Vite manifest, BFF sources nor fixtures is served. `node scripts/browser-boundary.mjs --verify-build` requires graph evidence and inspects actual emitted text. The staff HTTPS tests verify HTTP denial for these paths.

This guard is a reproducible static/build security gate, not a proof against arbitrary obfuscated malicious JavaScript or a replacement for review, dependency integrity, CSP, backend authorization and secret custody. New browser dependencies or build capabilities require explicit policy changes and negative tests. No broad admin-web exclusion is permitted.

## Regression coverage and commands

The Node tests create isolated synthetic source graphs, while the Python tests execute the existing inventory/package/domain/mobile/kiosk/public-schema assertions with only the separately tested graph subprocess mocked. This isolates legacy rule regression; production checking always invokes the real graph gate.

```powershell
python -B scripts/check_structure.py
node --test scripts/test/browser-boundary.test.mjs
python -B -m unittest discover -s scripts/test -p test_structure_legacy.py -v
pnpm.cmd staff:build
pnpm.cmd staff:typecheck
pnpm.cmd staff:test
node scripts/browser-boundary.mjs --verify-build
pnpm.cmd db:verify:sources
```

The structure gate now requires the existing installed Node/TypeScript workspace toolchain; it installs nothing. Staff HTTPS tests use ephemeral localhost certificates pinned by the clients, with normal TLS and hostname verification. Windows trust, PostgreSQL, Auth0, migrations, reserved permissions and financial behavior are outside this change.

Final validation: 56 boundary cases, 10 legacy-rule cases and 22 staff cases passed (88 total), with no failures or skips. Source structure, staff build/typecheck, actual graph/output and connection-free migration checks passed. The production graph contains 1,600 inspected modules, including zero BFF or privileged backend modules. Detailed command results are in docs/verification.md.

Maintained files changed: scripts/check_structure.py, scripts/browser-boundary.mjs, scripts/test/browser-boundary.test.mjs, scripts/test/test_structure_legacy.py, apps/admin-web/vite.config.ts, apps/admin-web/test/portal.spec.ts, README.md, docs/progress.md, docs/verification.md, docs/security/requirements.md, docs/security/three-branch-integration.md and this document. No package/dependency, migration, manifest or authentication/runtime configuration changed.
