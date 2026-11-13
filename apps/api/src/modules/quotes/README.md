# quotes

Status: planned transport module.

Validate transaction inputs and call CreateQuote. Return persisted, expiring customer quotes once the use case is implemented. Never accept the client's total as authoritative.

Use cases live in `packages/application`. This module will own controllers, request DTOs and dependency wiring, rather than duplicate business rules.

