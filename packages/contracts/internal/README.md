# Internal contracts

Status: envelope conventions; concrete queue and model contracts follow implementation.

Every job/event includes `schema_version`, `event_id` or `job_id`, authenticated `tenant_id`, `correlation_id`, timestamp, origin identity and narrow payload references. These IDs provide context, not authentication by themselves.

Suggested event names:
- `provider.snapshot.ingested.v1`
- `ai.match.suggested.v1`
- `catalog.publication.activated.v1`
- `order.fulfillment.unknown.v1`
- `settlement.reconciliation.failed.v1`

Use stable event IDs across redelivery and transactional inbox deduplication. AI envelopes contain sanitized catalog metadata; no customer payment data, credentials or raw beneficiary identifiers.



Layer 1 supplies [restricted acquisition-cost snapshots and result types](../../application/src/fx/contracts.ts).
Its `provider.acquisition-cost.normalized.v1` event includes a stable event ID,
scope, correlation ID, result and offer version references, permitted uses,
provenance mode, and timestamp. Consumers obtain amounts through the internal
result reader. See the [Layer 1 contract and workflow](../../application/src/fx/README.md).
