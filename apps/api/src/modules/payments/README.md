# payments

Status: planned transport module.

Accept payment-provider callbacks, validate signatures and references, and call controlled payment transitions. Payment initiation and capture/refund behavior are rail-specific.

Use cases live in `packages/application`. This module will own controllers, request DTOs and dependency wiring, rather than duplicate business rules.

