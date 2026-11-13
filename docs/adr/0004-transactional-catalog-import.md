# ADR 0004: Transactional catalog imports use approved mappings

Status: accepted for the local synthetic-import increment.

The application import path may create a complete provider snapshot and its offers only when the tenant/provider account is valid, the canonical product already exists, and the provider SKU has an approved mapping to that exact product. Provider payloads never create or approve mappings. Unmapped and non-approved mappings are rejected for separate review.

Snapshot identity is scoped by tenant, provider account, and the provider source snapshot key. Imports serialize on that identity inside a PostgreSQL transaction, with the schema's unique constraint as a second line of defense. Equivalent content is replay-safe; a different source version, timestamp, or offer set conflicts without changing the accepted history. Opaque source versions are compared for equality only.

The import role is distinct from migration and read-only runtime roles. It receives reads across catalog tables, inserts only snapshots and offers, and may update only snapshot completion columns. It receives no deletion, catalog/mapping write, DDL, or role-management privilege. Schema changes remain migration-role work.

Reason: a provider payload is evidence, not approval authority. Complete-snapshot acceptance must be atomic, replayable, and unable to silently rewrite historical accepted data.

Consequences: catalog product and mapping registration must happen through a separately controlled process before import. This increment does not implement that approval workflow, an authenticated API, delta feeds, or live-provider connectivity.

## Recovery clarification — 11 November 2026

Every successful import, including identical replay, must commit before releasing its connection. Failure paths roll back or discard an unusable connection. Returning an accepted replay result does not end its PostgreSQL transaction or release its transaction advisory lock by itself.

Real PostgreSQL acceptance now checks repeated replay through a reused connection, observes no open transaction or advisory lock from an independent restricted connection, and proves that connection can acquire the same lock. Existing conflict/concurrency/tenant/history/rollback checks remain. Migration-failure cleanup is checked in the actual failed disposable database, with the intended division-by-zero failure required; an absence check in maintenance database `postgres` is not evidence of rollback.
