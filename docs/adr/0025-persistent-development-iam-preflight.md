# ADR 0025: Persistent development IAM preflight remains separate and non-executing

Date: 13 November 2026. Status: implemented and locally verified; persistent migration remains NO-GO.

## Decision

Add a distinct `persistent-development-preflight-v1` profile for the approved eventual target `127.0.0.1:5432/nukhabapay_dev`. It is disabled unless every explicit environment gate is present. It has no migration-apply function or CLI mode. The existing disposable migration runner and registered migration sources remain unchanged.

The preflight binds operator authorization to an approval identifier, exact database name, database OID, PostgreSQL system identifier, canonical migrator and workload roles, and the SHA-256 of the verified `REGISTERED_MIGRATIONS_V1` manifest. Target evidence is collected inside a repeatable-read, read-only transaction. It rejects production-like environment labels, test-administrator settings, disposable-target settings, non-loopback connections, ambiguous URL options, absent credentials, unexpected history, role memberships/unsafe flags, database, schema, default or object ACLs, prepared transactions, project connections and pre-existing IAM/session objects.

The preflight also makes a second connection with an intentionally incorrect password. Only SQLSTATE `28P01` proves that password authentication rejected it. A successful connection under loopback `trust`, or any different transport/authentication result, fails closed. The configured password itself is never logged or returned.

## Session configuration

The database package now contains a separate disabled-by-default persistent-development session parser. Enabling it requires exact local/development labels, literal loopback port 5432, `nukhabapay_dev`, canonical role `nukhabapay_session_backend`, target OID/system identifier, a non-empty credential and bounded pool/connection/query/statement timeouts. Stray persistence settings in disabled mode reject. The connection string is non-enumerable and redacted during inspection. This parser is not registered in deployed runtime dependency injection, so durable session mode remains disabled.

## Privilege preparation

`proposed_persistent_iam_connection_grants.sql` is a non-registered, owner-operated proposal for the post-migration transaction. It grants only database CONNECT and schema USAGE to the existing identity reader and audit writer after checking exact target, approval, role attributes, memberships, history objects and baseline database ACLs. It explicitly verifies that neither role receives CREATE/TEMP/schema CREATE and that the catalogue importer remains outside this envelope. It is not authorized for execution in this increment.

## Compatibility and remaining gate

Registered migrations 004, 005 and 006 and their manifest hashes remain byte-for-byte unchanged. Their internal target guards still reject `nukhabapay_dev`. Consequently, a separately reviewed immutable activation wrapper or newly registered source transition is required before any apply authorization. Silently editing historical hashes, renaming a disposable database or bypassing the guards is prohibited.

The current PostgreSQL loopback `trust` rules are independently proven to make the new preflight reject. SCRAM-SHA-256 conversion, credential provisioning, HBA validation, restored-backup rehearsal, a persistent session-role grant recipe, and named operator/backup/recovery approvals remain deployment blockers.
