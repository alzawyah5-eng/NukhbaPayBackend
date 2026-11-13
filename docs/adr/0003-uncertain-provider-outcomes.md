# ADR 0003: Preserve uncertain outcomes

Status: accepted as a requirement; execution not implemented.

A timeout after provider submission enters UNKNOWN/PENDING. Query and reconcile the existing attempt using a stable reference before retrying or selecting another provider.

Reason: the provider may already have delivered the service. A second submission could duplicate a top-up or transfer.

Consequence: payment and fulfillment need separate state, durable attempts, idempotency where supported, operational exceptions and reconciliation. Internal queue retries do not guarantee safe external repetition.

