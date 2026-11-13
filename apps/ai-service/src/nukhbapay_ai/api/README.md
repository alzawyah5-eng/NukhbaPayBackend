# Planned internal API adapter

Implement a FastAPI adapter after installing and locking approved dependencies.
No HTTP service or authentication mechanism is implemented in this scaffold.

The future entry point accepts a bounded matching job from an authenticated
worker identity, checks tenant/job authorization, validates the internal schema,
and returns an advisory suggestion. Use service authentication, request size and
rate limits, timeouts, and correlation IDs. Do not expose this interface directly
to mobile applications, CRM browsers, or kiosks.

The deterministic guard already runs without FastAPI. HTTP schemas should reuse
the shared `packages/contracts/internal` contract and preserve hard checks.
Never accept `can_publish: true` as a model-controlled value. Only a separate
application use case can accept mappings or activate a price publication.
