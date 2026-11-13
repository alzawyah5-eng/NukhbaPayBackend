# Data model

13 November 2026 additive candidate safeguards (ADR 0023): existing staff_users.tokens_valid_after is now enforced against verified token issuance. Candidate 006 installs invoker triggers enforcing monotonic staff/membership versions and cutoffs on authority changes, immutable identity/scope bindings and fixed IAM vocabulary. The restricted IAM reader gains SELECT on this one existing column; workflow/catalogue grants do not expand. No new staff mutation or accepted-approval model exists. Registered 004/005 bytes are preserved.

Session foundation (ADRs 0022/0024): registered migration 006 adds separate `nukhbapay_sessions.sessions`/`events` append-only FORCE-RLS records and a canonical-identity consistency index on the existing IAM identity table. Session hash/issuer/subject/staff/tenant/version/digest/idle/absolute/original-identity expiry are immutable; creation/use/revocation audit is atomic and no session row authorizes a privileged action. Existing IAM/catalogue grants and frozen 004/005 are unchanged. Only disposable PostgreSQL tests may exercise registered 006; development is not migrated.

Naming follow-on (ADR 0021): current source/package names use the canonical spelling. Database schema, roles, RLS settings, registered migrations and durable records retain their existing identifiers; no data-model or persistence behavior changes. See [the naming register](naming-standardization.md).

Intake follow-on (ADR 0020): no schema/migration changes. An actor-bound intake uses the existing REVIEW + SYNTHETIC_TEST_EVENT provenance profile, with accepted_approval=false, not-established and NOT_AUTHORIZED and the same atomic audit/receipt/outbox. Its typed result says privilegedApproval=BLOCKED; this is not a distinct accepted-approval or attempt-log table/event. Reconciliation must verify that exact stored profile and own actor/request/version/digest/scope, rejecting ordinary submission/plain-review receipts. Existing person/version uniqueness disallows upgrading/duplicating prior participation. Separate repeat-attempt classifications, accepted quorum/approval states and privileged execution require a later reviewed migration; 004/005 remain frozen and unapplied to development.

Read follow-on (ADR 0019): the existing operations/requests/reviews tables now support actor-owned participant reads through a separate 34-column SELECT-only role. No table, migration or persistent policy is added; existing FORCE RLS remains unchanged. Details/status/revisions/review summaries are safe internal projections, not accepted approvals. Derived EXPIRED status does not mutate persisted SUBMITTED state. Private cursors pin a visible head per scan, with per-page consistent snapshots and fresh authorization. Existing IAM/catalogue roles and development history remain unchanged; approval/execution and operational activation are still blocked.

Current registered local workflow foundation (12 November 2026): migration 005 adds the eleven artifact tables inventoried in ADR 0018. Four compatibility simulation tables preserve recovery contracts; seven canonical request/operation/review/audit/receipt/outbox/synthetic-provenance tables preserve immutable intent, scope, canonical actors, version/expiry and atomic completion. Non-CREATE targets reference existing staff; CREATE intent may name a future UUID without creating anyone. All review/provenance values remain non-approved/not-established/NOT_AUTHORIZED; requests remain SUBMITTED and outbox NO_EXTERNAL_DELIVERY. Eleven FORCE-RLS scope policies and twelve append/independence triggers apply. No effective staff/grant mutation, privileged approval/executor or deployed endpoint is modeled as implemented. Tested only on disposable PostgreSQL; development history remains 001–003. Downstream target-model descriptions below are not activation claims.

The rows below describe the wider target model. Migrations 001–003 implement the local catalog foundation; migration 004 adds the provider-independent Brick 3A staff identity and authorization foundation. Downstream policy, publication, quote, order, payment, ledger, reconciliation, and AI-job tables remain unimplemented.

| Records | Owner | Key constraints and purpose |
| --- | --- | --- |
| tenants, merchants, devices | Identity/device modules | Verified ownership, revocable device keys and scoped permissions |
| staff_users, staff_identities, staff_memberships, iam_roles, iam_permissions, role grants | Identity | Exact `(issuer, subject)` mapping to an internal staff ID, explicit tenant membership and separately scoped platform/tenant grants |
| products, product_attributes | Catalog | Canonical customer benefit; global reference identity where appropriate |
| product_mappings | Catalog | Approved provider-to-product mapping, evidence, approver and version |
| provider_contracts | Provider management | Tenant agreement, supported capabilities, settlement/commission rules; credential references only |
| provider_snapshots | Catalog import | Provider source version, observed/effective time, completeness and raw evidence reference |
| provider_offers | Catalog | Tenant/provider/product/snapshot identity, actual debit and fees, availability and validity |
| pricing_policies | Pricing | Immutable approved rule versions, channel eligibility, fee caps, tax/rounding references |
| price_publications, publication_items | Pricing/catalog | Immutable candidate set and atomic active-publication reference |
| quotes | Quotes | Bound owner/session, inputs, price components, expiry, source/rule versions and consumption state |
| orders | Orders | Scoped idempotency identity, request hash, accepted quote and separate payment/fulfillment state |
| payment_attempts | Payments | Processor reference and state, authorized/captured/refunded values |
| fulfillment_attempts | Orders/providers | Stable pre-recorded provider reference, submission/status/UNKNOWN resolution |
| ledger_journals, ledger_entries | Ledger | Unique source event, append-only balanced journals per currency, explicit reversals |
| commission_accruals | Finance | Expected/earned/paid/reversed provider and agent commissions |
| settlements, reconciliation_cases | Reconciliation | Provider/processor settlement evidence, matched amounts and controlled exceptions |
| ai_jobs, ai_suggestions | Catalog review | Sanitized input references and rules/model provenance; no financial authority |
| audit_events | Audit | Actor, action, reason, source record and version; access-controlled retention |
| outbox_events, inbox_receipts | Infrastructure | Same-transaction publication intent and deduplicated consumer application |

## Implemented catalog constraints

- Tenant/provider-account consistency is enforced with composite foreign keys.
- Snapshots are unique by tenant, provider account, and provider snapshot key; provider offers are unique within a snapshot by provider offer key.
- Product mapping records retain status, version, provenance, source-snapshot reference, and provider SKU. The import operation accepts only a pre-existing approved mapping to the exact canonical product.
- Snapshot imports are complete-snapshot transactions. Identical accepted source identity/content replays without duplication; changed content conflicts. Historical accepted snapshots are retained.
- Financial values use integer minor-unit columns and are converted to `bigint` in TypeScript.
- The runtime DB role is read-only. The import DB role can read catalog records, insert snapshots/offers, and update only snapshot completion columns.

## Implemented Brick 3A identity foundation

- Migration 004 adds staff users, unique exact issuer/subject bindings, memberships, fixed role/permission definitions, explicit role-permission mappings, distinct platform/tenant grants, and append-only security-audit events. It uses the existing tenant table; merchants, branches, and kiosks are not automatically separate tenants.
- Email is not an identity key. No first-login account creation, implicit owner assignment, or email-based linking exists.
- Authorization is deny-by-default with exact permission codes/scopes, explicit tenant/object matching, active staff and membership checks, and grant-time/revocation checks. No role inheritance, wildcard, or positive permission cache is used. Self-approval compares internal staff IDs.
- Platform-role assignments cannot be stored as tenant roles and vice versa. Composite foreign keys enforce tenant-to-membership and role/permission scope consistency. Expiry is evaluated at request time; no permanent check constraint depends on `now()`.
- Tenant memberships, tenant grants, and tenant-associated audit events have forced RLS. Reader queries set the tenant context transaction-locally on one checked-out connection; pooled requests do not retain it. RLS protects against accidental unscoped queries but not a compromised trusted application or stolen reader credential.
- The identity reader has column-limited reads and no write access to grants or fixed definitions. The identity writer can append bounded audit events only. Both are separate from migration, catalog runtime, and importer database roles. No staff/grant writer or management workflow is implemented.
- Corrected pending migration 004 removes automatic catalogue-role table grants before IAM creation and explicitly denies catalogue/PUBLIC IAM table access. Existing catalogue grants remain intact; new module tables require explicit reviewed grants. This was verified on disposable PostgreSQL only; development migration history remains 001–003.
- Audit events use fixed action, outcome, target, and reason codes plus typed IDs/timestamps; arbitrary metadata, secrets, tokens, and full URLs have no storage field. Database triggers reject audit updates/deletes.
- The trusted verifier, issuer/audience/client settings, browser login, staff provisioning, membership changes, and tenant business routes are not implemented. Synthetic identities are internal test inputs, not an HTTP authentication mechanism.

## Cross-cutting target constraints

- Enforce tenant-consistent associations in the database and application. A foreign key on an ID alone is insufficient if IDs can be associated across tenants without an ownership constraint.
- Use integer minor units for posted amounts and exact numeric/decimal for rates/intermediate precision. Define the currency and rounding policy for every monetary value.
- Separate estimated economics from recognized revenue, actual settlement and customer principal.
- Keep payment/fulfillment state machines distinct; UNKNOWN is not FAILED.
- Reject idempotency-key reuse with a different request hash.
- Consume a valid quote and create its order under an appropriate atomic transaction/constraint.
- Keep approved snapshots, policies and publication inputs reproducible.
- Restrict direct writes to ledger/publication tables. Migrations use a separate role.
- AI has no financial database credentials. If suggestions are persisted in the same cluster, the controlled backend writes them through a narrow use case.
