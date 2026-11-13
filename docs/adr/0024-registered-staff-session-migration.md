# ADR 0024: Registered staff-session migration source

Date: 13 November 2026. Status: implemented for local source history and disposable PostgreSQL acceptance; non-disposable activation remains gated.

## Decision

Register the already accepted migration 006 wrapper as `packages/database/migrations/006_staff_server_sessions.ts`. The reviewed SQL sidecars remain byte-for-byte unchanged under `packages/database/pending-migrations/` and are loaded only after SHA-256 verification. Frozen migrations 004 and 005 remain unchanged.

The source manifest profile is `REGISTERED_MIGRATIONS_V1`. It pins all six numbered migrations, the default-ACL preflight, the additive IAM authority safeguards, the session SQL sidecar and the one-column IAM reader grant recipe. The runner independently pins all six numbered migration hashes, so changing both 006 and its manifest entry still fails closed. The registered 006 wrapper SHA-256 is `035fa9bb914de3cb4094f8e98ce2fa9164dc4e6b5e11b40ddfdd55707bc98eed`.

## Execution contract

The normal package migration command now admits the complete registered 001–006 sequence, but only through the existing reviewed runner. Before connecting it verifies the immutable manifest and canonical role names. It then accepts only literal loopback port 5432, the canonical isolated migrator and an owned random `nukhabapay_b3b2_*` or `nukhabapay_b3b3_*` disposable database. `nukhabapay_dev`, remote/shared targets, unsafe role attributes and memberships remain rejected.

On the same owner connection the runner acquires the installed migrator advisory lock, runs the read-only default-ACL/schema preflight, stages exact verified source bytes, and invokes `node-pg-migrate` with order checking and one transaction. Migration 006 independently requires exact ordered 001–005 history and re-verifies both SQL sidecars. Failed up rolls back schema, ACL and history changes. Automatic down remains disabled; recovery requires a separately approved verified restore.

No candidate-mode CLI or environment switch remains. SQL/JSON sidecars are excluded from migration discovery, so only the numbered wrapper can create the 006 history row.

## Security consequences

Registration changes source history only. It creates no role, credential, database object, Auth0 resource, staff identity, permission activation or privileged executor. The reviewed session SQL, RLS, grant matrix, authority invalidation triggers and revocation evidence semantics are unchanged. Existing catalogue, IAM reader/writer and workflow privileges do not expand beyond the previously accepted one-column validity projection installed by 006.

Disposable acceptance verifies complete 001–006 order/replay, hostile defaults and schema ACL rejection, FORCE RLS, exact grants, transaction rollback and forward retry, concurrency, session creation/rotation/expiry/revocation, restart-relevant persistence, and single-transaction restore. It does not authorize applying 004–006 to `nukhabapay_dev` or any persistent target.

## Remaining activation gates

Applying 004–006 outside verified disposable acceptance still requires an explicitly approved target, backup and restore evidence, owner-controlled secrets, exact role provisioning, maintenance window, post-migration ACL/RLS/history checks and operational monitoring. Real Auth0 issuer/client/token compatibility, browser-trusted HTTPS, staff bootstrap, genuine MFA assurance, accepted approvals, privileged APPLY, session HA/retention/refresh and incident ownership remain separate blockers.
