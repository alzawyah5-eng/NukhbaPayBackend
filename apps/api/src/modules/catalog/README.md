# catalog

Status: planned transport module.

Serve customer-safe catalog DTOs from the active publication, with version-aware caching and freshness indicators. Exclude provider costs and personalized bill inquiries from shared catalog caches.

Use cases live in `packages/application`. This module will own controllers, request DTOs and dependency wiring, rather than duplicate business rules.

