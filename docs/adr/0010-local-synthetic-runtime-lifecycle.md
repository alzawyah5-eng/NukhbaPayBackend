# ADR 0010: Explicit local synthetic API runtime lifecycle

Status: implemented for the separately authorized local lifecycle increment
Date: 11 November 2026

## Scope and configuration

Compose the existing verifier, restricted IAM reader/audit writer and global guards through trusted dependencies. Preserve AppModule and liveness-only deployed route registration. No readiness HTTP endpoint, staff controller, provider setup, real staff, existing-database migration, reserved permission or later brick is added. Brick 3B-4 was a read-only readiness report in conversation; it changed no files.

`createLocalApiRuntime(env, dependencies)` validates listener configuration and `API_STAFF_AUTH_MODE`. Default `disabled` opens no pools/verifier and rejects defined `IDENTITY_*`/`DB_IDENTITY_*` settings, avoiding silently ignored partial configuration. Unknown modes reject. Existing guards continue denying any added protected handler without dependencies.

`local-synthetic` requires complete existing identity/IAM configuration, a loopback HTTP listener, a reserved `.invalid` issuer and explicitly injected synthetic JWKS transport. No environment variable/request can supply transport or choose a test module. The real verifier and restricted IAM runtime are composed without replacing cryptography, enrollment or policy. Real Auth0 issuers and production configuration reject. CLI startup has no synthetic transport, so mode/configuration alone cannot activate authentication; programmatic acceptance supplies ephemeral keys and synthetic transport through trusted dependencies.

Only allowlisted IAM settings reach the IAM factory; migration/importer/catalogue/test-admin credentials are never read or forwarded. Existing canonical roles and matching loopback target validation remain unchanged. The API now declares database as a runtime workspace dependency using its existing version/link; no package upgrade/download is needed.

## Startup and internal readiness

Enabled startup requires both verifier and IAM readiness before application construction/initialization. Failed configuration or dependencies open no listener and unwind initialized resources. Underlying errors/configuration/causes are discarded; the public error is only `Local API runtime unavailable`. CLI logging is fixed. Nest uses `abortOnError: false` so cleanup can run.

`checkReadiness(): Promise<{ready:boolean}>` is internal, coalesces concurrent probes and recomputes afterward. Disabled mode means its empty dependency set is ready, not that staff authentication is enabled. There is no route, polling timer or positive authorization cache, and readiness never grants access.

IAM readiness validates actual role identity/flags/ownership, parses permitted repository columns with `WHERE false` (no staff data), verifies intended audit INSERT with no writer SELECT/UPDATE/DELETE and confirms all three forced-RLS flags. It performs no audit INSERT or fixture write. Missing schema/closed or unavailable pools fail readiness using existing deadlines. This is not exhaustive ongoing ACL monitoring, proof of future disk durability or migration-history verification; actual history remains a separate operator/acceptance check.

Verifier readiness uses the same bounded JWKS transport/cache/backoff, reloads only when cache is not fresh, and requires usable RSA public signing material through jose and existing parameter checks. No token is accepted or identity attested by readiness. Fresh trusted cache may remain usable during an outage; missing/invalid required keys fail closed. Existing rotation/expiry/cooldown behavior remains intact.

## Shutdown and recovery

The composed Nest module owns lifecycle hooks. Before shutdown it marks stopping and closes the verifier, aborting active key fetch/body reads. Nest drains/closes HTTP; the shutdown hook then closes restricted pools. Returned `close()` is idempotent/concurrency-safe and guarantees resource cleanup even if application close fails. Direct `app.close()` uses the same hooks. Bootstrap enables SIGINT/SIGTERM shutdown hooks and closes runtime/removes hooks after listener failure. Tests exercise Nest close and listener-failure hook removal, not native Windows service-manager signal delivery.

Readiness is false while stopping/closed; new token verification cannot admit requests after stopping. Existing authorized operations may drain before pool closure; future sensitive-write serialization remains unimplemented. Lost idle connections can reconnect on subsequent bounded probes; closed pools need a new runtime. Startup can recover through a fresh runtime after restoring dependencies. No shared-server restart, cluster-role mutation or authentication bypass is used.

## Acceptance and gates

Unit tests cover modes/configuration, missing transport, external/production rejection, credential isolation, readiness coalescing/recovery, crypto-to-guard integration, cancelled JWKS work and repeated Nest/runtime cleanup. Disposable acceptance covers failed JWKS startup, missing schema, partial IAM initialization, absent database, listener conflict, audited HTTP self access, lost reader connection recovery, closed-pool denial/restart and zero remaining IAM sessions.

Fixture schema rename, temporary database CONNECT denial and backend termination are limited to its verified generated target and restored/cleaned in finally blocks. Existing tests/assertions, migrations, role provisioning, permission activation and financial behavior remain intact. Verification records exact commands/results/targets/failures/skips.

External test/production region/residency/commercial terms, human profile/MFA, audited initial staff bootstrap, operational ownership, secrets/network/TLS, database authentication/restore readiness, monitoring/retention, emergency key invalidation and non-disposable migration remain PENDING. Local trust and application-set tenant context are not production isolation. Stop after this authorized increment; no Brick 3C/4 is approved.
