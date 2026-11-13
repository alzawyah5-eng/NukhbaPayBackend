# ADR 0023: Reviewed migration rehearsal and authority invalidation

Date: 13 November 2026. Status: implemented for local synthetic acceptance. The registration gate was later satisfied by ADR 0024; operational activation remains gated.

The owner authorizes corrections and combined disposable acceptance only. Registered migrations 001–005 remain byte-for-byte frozen. Proposed 006 is not copied into the registered directory. No real Auth0, operational staff mutation, accepted approval, reserved permission, HTTP endpoint, certificate installation or financial operation is authorized.

## Migration integrity and execution

`packages/database/migration-manifest.json` records SHA-256 for five frozen migrations and five explicit additive/candidate inputs. `scripts/rehearse-reviewed-migrations.mjs` verifies all bytes before connecting, additionally pins the five historical hashes in code, constrains dynamic workload-role configuration to the existing canonical roles, and stages a private, uniquely named temporary snapshot. It never regenerates a manifest, accepts arbitrary paths, fakes history or invokes down. Its own source and the manifest are review artifacts covered by the recovery/change manifests; this is a reviewed local deployment manifest, not a cryptographic signature from an external authority.

The runner admits only literal 127.0.0.1:5432, generated disposable b3b2/b3b3 database names, the actual isolated migration role and verified owner. It holds the installed migrator's advisory lock on the same connection across preflight and migration. The default `db:migrate` invokes this guarded path through registered 005 only. It rejects `nukhabapay_dev` before a connection is created. Tests may explicitly include the candidate 006; no environment switch promotes it into normal registration.

The read-only `004_identity_default_acl_preflight.sql` rejects unreviewed owner table/function/schema/sequence defaults and hostile IAM schema rights. It permits only reviewed legacy in-schema catalogue SELECT defaults and the ordinary PUBLIC function-execution default, which 005 removes before new workflow functions. Existing grants/defaults are never silently repaired by preflight. An unknown grantee requires a reviewed correction and a new attempt. Only the verified migration owner may change defaults; privileged administrator interference is outside this lock's protection.

The candidate TypeScript 006 wrapper checks exact 001–005 history and verified SQL sidecars, then includes additive authority safeguards and session schema in the migrator's single transaction. The runner records 006 only inside the disposable rehearsal. Failed up rolls back DDL, privileges, defaults and migration rows. The migrator may create an empty history table before its transaction; absence of history rows, rather than absence of that empty table, is the recovery assertion. Sequence counters are not gap-free transaction evidence.

## Authority and token invalidation

`tokens_valid_after` is now a required internal principal field. Only the restricted IAM reader gains one additional SELECT column, for 28 previously reviewed IAM/audit columns in total. No contact or identity-write privilege is added; the workflow backend's 27-column grant is unchanged. Ordinary client responses do not contain the cutoff.

Identity resolution requires a genuine verifier-registered identity with signed integer `issuedAt` strictly greater than a non-null cutoff. Equality, earlier issuance, missing/malformed cutoff or structural identity evidence deny. Null remains the explicit initial no-cutoff state. Malformed database timestamps cause sanitized dependency failure. No clock-skew allowance extends a revoked token; a new token issued in the cutoff's second may need to wait until the next second. Session resolution reuses this boundary on every freshness check.

The additive `004_identity_activation_safeguards.sql`, transactionally owned by candidate 006, installs SECURITY INVOKER triggers with fixed pg_catalog search paths. It does not change or re-register 004/005. There is no new writer role, privileged command, approval acceptance or executable authorization evidence.

An already-authorized future writer must use the following database contract:

- Staff status/cutoff changes and explicit emergency version advancement increment staff authz_version exactly once and advance the cutoff to at least database clock time. Versions/cutoffs cannot decrease or be cleared; display/contact-only updates do not invalidate authority.
- Identity creation/status changes and membership creation/status/version changes advance canonical staff authority. Identity and membership bindings remain immutable; deletion cannot erase their history.
- Platform grant changes advance staff authority. Tenant grant changes advance membership version and thereby staff authority. Revoked grants cannot be silently unrevoked or moved backwards. Future-dated changes also invalidate snapshots immediately; this does not activate their permissions.
- Fixed role/permission/mapping vocabulary cannot change through runtime DML. Changes require a separately reviewed migration. Existing reserved permissions remain inactive.
- Trigger propagation must affect exactly one canonical parent; RLS/permission failures roll back the child mutation. Concurrent row updates serialize increments; failures roll back version, cutoff and mutation together. Multi-object privileged executors, if ever approved, must additionally acquire canonical locks in order, retry the entire transaction after serialization/deadlock failures, revalidate independent approvals and commit mutation/audit/receipt/outbox atomically. These triggers are not such an executor and cannot prove approval authority.

Existing historical 004/005 fixtures add only the new validity projection so their original assertions remain executable. The complete trigger contract is exercised in combined 001–006 fixtures. No normal runtime may claim operational invalidation readiness merely because the extra column grant exists.

## Sessions, audit and recovery

Candidate 006 rejects NULL network metadata, including the Unix-socket representation, and unexpected schema defaults/actual schema ACLs as well as table/function ACLs. Both session tables remain FORCE RLS, append-only and bound to canonical identity/tenant. The session backend remains exactly 27 SELECT-column and 23 INSERT-column grants, without IAM access or mutation permissions.

Durable revocation preserves the trusted ticket reason, including AUTHORITY_CHANGED. A denied old rotated/logout credential invalidates that credential; it does not poison a still-current sibling actor. Observed authority loss still blocks that actor and its known generations permanently. Rotation, audit completeness, expiry, uncertain acknowledgement, concurrent revocation and connection cleanup preserve their existing fail-closed behavior.

Cold processes do not reconstruct verified actors from persisted rows. Restarted pools can reuse a live in-process actor registry; a cold registry rejects old cookies. Persistence is durable evidence, not executable authentication. HA, refresh, retention and the 1,000-issued-entry limit remain activation requirements.

Acceptance uses real pg_dump custom archives and pg_restore --single-transaction --exit-on-error, only between verified synthetic disposable targets. It verifies history, session evidence digests, owners, grants, immutable triggers and FORCE RLS. A restore conflict leaves no partial restored schema. Source archives are not database backups, and these tests do not prove an operational RPO/RTO, crash/failover or media-loss recovery capability.

## Registration and activation gate

This section records the pre-registration gate. ADR 0024 later registers the final wrapper after confirming the wrapper/sidecar paths, exact manifest, additive IAM objects/one-column reader grant, target restrictions, role matrix, migration order and tested recovery procedure. The 004/005 hashes and SQL sidecar bytes remain unchanged. Registration does not treat rehearsal history as development history or authorize any persistent target.

Real Auth0 login additionally needs a separately authorized OIDC/BFF increment, exact issuer/client/human-token compatibility, approved staff bootstrap and persistent targets, browser-trusted HTTPS, operational secret/monitoring/recovery ownership and provider acceptance. Privileged assurance remains not-established; accepted approvals and APPLY remain blocked. No management approval is inferred from synthetic acceptance.
