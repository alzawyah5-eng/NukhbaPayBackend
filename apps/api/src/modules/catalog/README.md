# Published catalogue

Synthetic read-only transport is implemented in published-catalogue-http.ts. Payment-backend and kiosk-machine identities have separate audiences/scopes and server-owned tenant/kiosk bindings. Only exact reviewed GET handlers use this authentication path. Ordinary bootstrap supplies no catalogue dependencies, so operational access remains disabled.

Public fields follow CatalogProductV1. Catalogue snapshots and one-use bound pagination fail closed on publication changes, storage failure, permission loss, or required audit failure. No provider API, draft economics, staff authority, mutation route, browser secret or live financial execution is exposed. See docs/security/brick4b-published-catalogue-api.md from the repository root for the full contract and acceptance evidence.
