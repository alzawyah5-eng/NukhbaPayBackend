# ADR 0006: Provider-independent staff authorization foundation

Status: accepted for local Brick 3A only; identity-provider choice remains
proposed  
Date: 10 November 2026

## Decision

Implement staff identity bindings, tenant memberships, a fixed role/permission
catalogue, internal read and authorization operations, and a bounded audit
append path before external identity-provider integration. This is not
authentication: only a future trusted verifier may supply an issuer/subject
pair. Brick 3A test inputs are synthetic and internal; no HTTP route accepts
them.

Use the exact issuer and subject strings as the unique external identity key
and map them to an internal immutable staff ID. Never link by email, create a
staff user on first login, or assign initial owner access implicitly.

Use the existing tenant table. A tenant is a contractual/business security
boundary; a merchant can be a tenant or belong under a parent business. A
branch or kiosk is not a tenant by default. Confirm the actual commercial
relationship before production provisioning.

Authorization is exact and deny-by-default. Roles do not inherit by name,
seniority, or organizational hierarchy. Platform roles permit only their
explicit platform permissions and never imply tenant data access. There is no
everyday wildcard Super Admin or bypass. Platform and tenant grants use
separate tables and foreign-key scope checks. Reject conflicting
catalogue operator/reviewer and pricing editor/approver grants at decision
time; self-approval compares internal staff IDs. Expired and revoked grants
deny. The initial evaluator performs no positive permission caching.

The database stores all blueprint role/permission definitions as fixed,
migration-controlled data. Only `staff.self.read` is active in 3A for the
internal self/membership-resolution foundation. Later-phase business
permissions are reserved and denied until their implementation phase; no
business routes, provider operations, or user-management workflows are added.

## Database boundaries

Migration 004 adds the core staff, identity, membership, role, permission,
grant, and security-audit records. Identity-reader and identity-writer
PostgreSQL roles are separate from migration, catalog runtime, and importer
identities. The reader receives only required IAM SELECTs, with RLS on
tenant-owned memberships, grants, and tenant audit events. The writer receives
INSERT on the bounded audit table only. It cannot read or modify grants or
definitions. Neither role owns schema/tables, has DDL, role-management,
superuser, `BYPASSRLS`, or inherited privileges.

Recovery clarification (11 November 2026): migrations 001–003 left automatic SELECT grants for catalogue runtime/importer roles on new migrator-owned tables. Pending migration 004 now removes those default table grants before creating IAM tables and explicitly revokes all IAM table access from catalogue roles and PUBLIC. Existing grants on the six catalogue tables are preserved. Future tables require explicit reviewed workload grants; there is no automatic catalogue access to new module tables. The down migration restores the pre-004 SELECT defaults after removing IAM tables.

Acceptance connects as both catalogue roles and denies reads on all nine IAM tables, checks every IAM reader/writer column privilege, retains forced-RLS/isolation/audit tests, and creates a probe table as the migrator to verify future defaults. Read-only migration history checks before and after recovery show 004 still absent from `nukhabapay_dev`; this correction amends only the pending migration, not applied history. The passing evidence applies to disposable PostgreSQL, not a deployed identity system.

RLS is implemented for tenant memberships, tenant role grants, and
tenant-associated audit events. The application sets the requested tenant
context transaction-locally on the same checked-out connection, then uses
parameterized scoped lookups. Missing context returns no tenant rows. This
guards against accidental unscoped queries; the database role itself can set
a custom context, so RLS is not a defense against a compromised trusted
application or leaked reader credential. No tenant-facing route is introduced
by 3A.

Audit events use fixed action/outcome/target/reason vocabularies and typed
identifiers rather than arbitrary metadata or free-form reason strings. This
deliberately narrows the blueprint's proposed metadata field so the 3A writer
cannot accept credentials, tokens, URLs, or arbitrary staff-supplied content.
Application roles cannot update or delete audit history.

No identity writer for staff, membership, role, or grant management is
created: there is no such current operation. Those records are
migration-controlled until an approved 3D access-change workflow exists.

## Provider decision and consequences

Auth0 remains the proposed reference provider from ADR 0005, not an approved
or configured service. This local work does not need an Auth0 account or
credentials and does not validate tokens. Jurisdiction, region/data handling,
procurement, existing KissAux/NubbaPay identity systems, ownership, and
provisioning remain open for Brick 3B.

The 3A repository operation is an internal boundary, not a login endpoint.
Before any tenant-facing route is added, verify authentication, tenant
membership and permission before calling a scoped repository operation, and
retain RLS and pooled-connection isolation tests.

