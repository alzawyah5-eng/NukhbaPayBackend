# API application

Local lifecycle update: `createLocalApiRuntime` composes the existing verifier, guards and restricted IAM in explicit `API_STAFF_AUTH_MODE=local-synthetic`, requiring complete configuration, loopback listener, `.invalid` issuer and trusted injected synthetic JWKS transport. Default `disabled` rejects stray identity settings. CLI has no synthetic transport and cannot activate a real provider. Routes remain liveness only. Internal `checkReadiness()`/idempotent `close()` expose no configuration or endpoints. Failed startup unwinds resources; Nest shutdown drains HTTP and closes pools. See ADR 0010 and verification.

Status: Brick 3B-3 global HTTP authentication/authorization guards. The deployed application registers only `GET /health/live`, which reports process liveness and does not check dependencies. Protected staff acceptance controllers exist only under `test/` and are excluded from production compilation.

The listener defaults to `127.0.0.1:3000`. `API_HOST` must be an IPv4 or IPv6 address literal; `API_PORT` must be an integer from 1 through 65535. JSON request bodies are capped at 16 KiB, and error responses omit parser and internal exception details.

Build and verify from the repository root with the pinned package manager:

```powershell
corepack.cmd pnpm install --frozen-lockfile
corepack.cmd pnpm api:build
corepack.cmd pnpm api:typecheck
corepack.cmd pnpm api:test
```

Run the local API with `corepack.cmd pnpm api:start`. Set `API_HOST` or `API_PORT` only when intentionally changing the local listener. Default startup opens no database pools and configures no identity verifier. Added protected routes fail closed without explicitly composed trusted identity dependencies. No real provider, business endpoint or payment behavior is enabled; this is not a production service.

The common application factory installs authentication followed by authorization globally. Public exemption requires the exact reviewed health handler/path and GET method. Protected handlers need explicit permission/scope/GET metadata and a committed authorization audit. Missing metadata, unreviewed public markers, implicit HEAD and alternate methods cannot inherit authority. OPTIONS and unmatched paths return generic 404. Error responses never contain token/identity/dependency details. See ADR 0009 and the identity module README.

`pnpm.cmd api:test` runs non-destructive synthetic HTTP/verifier checks. The separate `pnpm.cmd --filter @nukhbapay/api test:identity:integration` requires reviewed explicit disposable-test configuration and runs internal plus HTTP acceptance with real restricted PostgreSQL roles; it has no skip fallback. Never point it at shared/production databases. Migration 004 is not applied to development by either runtime startup or this increment.

The API owns authentication, request validation, per-object authorization, transport DTOs and dependency wiring. Reusable policy/use cases stay in `packages/application`; PostgreSQL adapters stay in `packages/database`; business arithmetic stays in `packages/domain`. Never trust client-supplied prices, tenant IDs or channel identities.
