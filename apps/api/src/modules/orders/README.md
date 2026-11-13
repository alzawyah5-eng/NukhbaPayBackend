# orders

Status: planned transport module.

Create an order against an accepted valid quote with scoped idempotency. Expose separate payment and fulfillment state; enforce ownership on every order read.

Use cases live in `packages/application`. This module will own controllers, request DTOs and dependency wiring, rather than duplicate business rules.

