# API and event contracts

Status: illustrative versioned schemas and examples; no server endpoints are generated or deployed.

- `public/`: customer-safe catalog and quote fields.
- `admin/`: privileged economics; authorization is enforced by the API, not by a folder name.
- `internal/`: worker/AI job envelopes and event conventions.

Clients receive decimal strings and currency codes. Exact currency scale, arithmetic and rounding are server rules. DTOs are not database entities. Keep provider costs and secrets out of public contracts.

The current package exports only explicit public schemas. Admin/internal generated clients, if added, need separate controlled entry points. API definitions and generated clients are versioned together when the HTTP layer is implemented.

