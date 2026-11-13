# Trust boundaries

Status: target requirements plus local catalogue/staff foundations, synthetic token verification, restricted internal IAM integration and global staff HTTP guards. The 11 November 2026 recovery verified transaction cleanup and corrected IAM privilege isolation on disposable databases. Migration 004 remains pending on development. Real identity services and production runtime enforcement remain unconfigured; protected HTTP acceptance uses test-only controllers and disposable databases.

| Boundary | Untrusted input | Required control |
| --- | --- | --- |
| Client -> API | IDs, amounts, channel, tenant fields | Verified identity, object authorization, server pricing and scoped quotes |
| Provider -> connector | Catalog payloads, statuses and callbacks | Schema/amount validation, allowed egress, callback authenticity and replay controls |
| Connector -> publication | Incomplete/stale/mismatched offers | Completeness/freshness checks, approved mappings and immutable rule versions |
| AI -> application | Matches, attributes, explanations | Strict schema, evidence, hard constraints and controlled acceptance |
| CRM -> privileged commands | Rule edits, refunds, approvals | Roles, separation of duties, approval policy and audit |
| Queue -> worker | Repeated/reordered jobs | Authenticated provenance, stable event IDs, transactional deduplication |
| Kiosk -> customer session | Physical access and stale local state | Device revocation, session clearing, managed OS and central authorization |

The API foundation binds to IPv4 loopback by default, validates explicit address/port configuration, caps JSON request bodies, applies finite HTTP timeouts, and returns sanitized parser/framework errors. Its liveness route reports only process liveness. Global authentication/authorization guards honor only the exact reviewed GET health binding as public, require explicit protected permission metadata and commit audit before success. They reuse the existing verifier and current server-side self policy; client identity/tenant claims do not grant authority. Default startup has no configured verifier or IAM connection, and deployed AppModule has no protected staff/business route. Synthetic/disposable tests do not establish real provider integration, dependency health, production readiness or resistance to compromise. See ADR 0009.

Local database boundaries use separate migrator, catalogue runtime, importer, IAM reader and audit writer logins. Corrected migration 004 gives catalogue roles no IAM table access and removes automatic catalogue grants on new tables while preserving existing catalogue grants. IAM reads are column-limited; tenant memberships, tenant grants and audit records use forced RLS and transaction-local context. PostgreSQL acceptance verifies the actual restricted logins, new-table defaults and pooled cleanup. This does not turn the application-set tenant context or the local loopback `trust` authentication configuration into a production identity boundary.
