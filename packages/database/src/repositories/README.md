# Repositories

PostgreSQL owns tenant-scoped persistence for canonical products, source
snapshots, mappings and offers. Repository inputs are scoped IDs and narrow
application requests. Outputs are saved versions or read projections. The
current schema starts in [catalogue migration 001](../../migrations/001_catalog.ts)
and the repository uses the existing restricted connection pool.

Future exact FX, pricing policy and selection evidence should reference the
immutable input versions they used. Store currency amounts with integral
minor units where scale is fixed or PostgreSQL `NUMERIC` for decimals. Keep
tenant ownership, foreign keys, row security and write permissions in the
database design. Add schema proposals to `pending-migrations/` for review
through the [existing registration process](../../migrations/README.md).

Catalogue and IAM repositories are implemented through narrow application ports and restricted pools. The IAM principal projection now includes the existing tokens_valid_after column, enforced against verifier-registered issuance in the application boundary (ADR 0023). Contact fields and privileged mutations remain inaccessible. Avoid exposing a generic unrestricted SQL client to modules; no repository result or database credential establishes human authorization.

