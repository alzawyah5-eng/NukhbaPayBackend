# webhooks

Status: planned transport module.

Validate provider callback authenticity, deduplicate event IDs, reconcile out-of-order messages and hand off to provider-specific normalized events.

Use cases live in `packages/application`. This module will own controllers, request DTOs and dependency wiring, rather than duplicate business rules.

