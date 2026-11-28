# Identity, tenant access and audit

Resolve trusted staff identity against current tenant membership and scope.

- **Inputs** — verified subject, requested operation and current membership,
  permission and session evidence.
- **Outputs** — an authorized tenant or platform context and the required
  audit evidence for the operation.
- **Dependencies** — the [HTTP identity boundary](../../../../apps/api/src/modules/identity/README.md),
  [staff access rules](staff-access.ts), [security audit port](security-audit.ts),
  and restricted [PostgreSQL repositories](../../../database/src/repositories/README.md).

Catalogue payment and kiosk identities use their own server-owned bindings in
[`published-catalogue.ts`](../catalog/published-catalogue.ts). Provider secret
references belong to server-owned adapter composition. Jobs and customer
responses carry scoped references and projections.
