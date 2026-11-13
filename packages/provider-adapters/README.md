# Provider adapters

Only an in-memory synthetic catalog provider exists. The example is offline and cannot execute a purchase, top-up, transfer, refund, or payment.

Future real adapters belong in separate directories here, one per provider, behind the contracts package. Own provider authentication, schema validation, throttling, timeout semantics, callback verification, and provider-specific error translation in that adapter. Keep provider credentials and raw private data out of public API contracts and AI jobs.

Register adapters in the backend/worker composition root. For write operations, design a separate fulfillment contract with stable request identifiers, provider idempotency, status lookup, and explicit unknown outcomes. Do not assume the read-only catalog interface describes transactional safety.

The synthetic prices are AED 97.00 for A, AED 96.50 plus AED 0.80 for B, and AED 95.80 for unavailable C. A is selected by effective eligible cost.
