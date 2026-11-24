# Payment and kiosk catalogue access qualification

**Status** `NOT_RUN` ? **Execution authorization** `NOT_GRANTED`

The project owner supplies two separately approved machine client registrations, their issuers, audiences, subjects and client IDs, approved signing key sources and rotation, authoritative tenant bindings, and the exact kiosk UUID for each kiosk binding. The owner also supplies an approved published catalogue revision and authorizes each client and target. Provision client credentials through the approved server secret store. The React payment client receives only its own application response from the backend.

| Channel | Existing read endpoints | Scope used by the contract | Binding and current fixture audience |
| --- | --- | --- | --- |
| Payment | `GET /v1/payment/catalogue` and `GET /v1/payment/catalogue/{productId}` | `catalog.published.read:payment` | Exact issuer, subject, client ID, enabled binding version and tenant. Kiosk binding is empty. Fixture audience `urn:nukhbapay:synthetic:payment-catalogue`. |
| Kiosk | `GET /v1/kiosks/{kioskId}/catalogue` and `GET /v1/kiosks/{kioskId}/catalogue/{productId}` | `catalog.published.read:kiosk` | Exact issuer, subject, client ID, enabled binding version and tenant. Path kiosk must match the bound UUID. Fixture audience `urn:nukhbapay:synthetic:kiosk-catalogue`. |

The current provider keys, audiences and verifier profile are scoped to synthetic `.invalid` issuers. Operational composition requires the approved machine-token profile, authority source and trusted issuer/audience configuration, with the same channel, lifetime, tenant and read-audit guarantees. The scopes above express the existing read contract. Confirm any operational scope mapping explicitly before provisioning. See the [HTTP verifier and routes](../../../apps/api/src/modules/catalog/published-catalogue-http.ts) and [channel policy](../../../packages/application/src/catalog/published-catalogue.ts).

## Qualify each authorized client

1. Verify the signed machine token binds to the configured issuer, audience, client kind, subject and scope. Confirm short-lived credentials and separate grants. Resolve the tenant and kiosk through the authoritative server binding and keep the published reader and audit writer credentials separate.
2. Read a known published product and a filtered list. Check `country`, `region`, `service`, `search`, `limit`, and `cursor`, and verify that detail reads reject query parameters. Confirm committed read audit and immutable revision readback. Confirm the exact decimal display amount and indicative status. Exercise currency/service availability using the approved snapshot.
3. Verify wrong channel, client, tenant, kiosk, audience and scope deny. Cover human tokens, expiry during reader or audit work, revoked bindings, cursor replay and use with another filter or binding, and draft, staff and private pricing access. Compare the observed status and sanitized body against the contract for each channel.

The prior disposable tests verified signed fixture tokens and channel isolation. Record separate evidence from the approved payment and kiosk clients for operational acceptance.

Record the approved manifest digest, target and scope, reviewer, authorization reference, observed results, deviations, sanitized evidence references, teardown and acceptance decision in the owner execution record. A separate scoped decision is required for execution.

Offline preflight uses `pnpm.cmd development:test:offline`. Candidate review preparation uses `python scripts/reconcile-r6-offline.py`.
