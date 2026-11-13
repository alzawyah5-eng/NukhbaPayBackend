# Background workers

Status: planned TypeScript runtime. Queue clients and schedules are not implemented.

Workers import use cases from `packages/application`, never services from `apps/api`. They provide queue/scheduler integration and dependency wiring. Jobs require authenticated provenance, tenant context, schema version, correlation ID and stable deduplication identity.

Catalog imports and safe reads can retry with bounded backoff. Financial submission jobs follow provider-specific idempotency and uncertainty rules; timeouts do not automatically authorize a second submission or a different provider.

Write outbox events in the same database transaction as their business state; publish them through the outbox relay. Consumers deduplicate in their own transaction. A durable queue does not imply exactly-once external effects.

