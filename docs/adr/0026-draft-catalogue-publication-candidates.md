# ADR 0026: Draft catalogue publication candidates remain non-authorized

Date: 13 November 2026. Status: implemented for local synthetic and disposable acceptance only.

## Decision

Brick 4A introduces a pure application boundary that constructs immutable versioned catalogue publication candidates from explicit COMPLETE source snapshots and normalized offers. It reuses the existing exact-minor-unit pricing calculation and its half-up percentage-fee rule. Candidate identity is a stable SHA-256 digest over the allowlisted tenant, product, version, product identity, financial policy, evaluation time, sorted snapshot evidence and sorted offer evidence. Idempotency keys identify requests but do not alter candidate content identity.

Every candidate is `DRAFT`, `NOT_AUTHORIZED`, and `activationAllowed=false`. There is no activation function, public read, HTTP route or new permission. Model output is classified separately as `ADVISORY_ONLY`; it is not an input to candidate arithmetic or authority. Structural/JSON copies cannot enter the local persistence adapter as generated candidates.

## Proposed persistence

Pending migration 007 is deliberately unregistered. On an explicitly gated random disposable target after exact 001-006 history, it proposes four append-only tables: candidates, sources, idempotency requests and candidate-created events. All four use ENABLE/FORCE RLS, immutable triggers, exact DRAFT/non-authorized constraints and a deferred complete-evidence constraint. Hostile schema/default ACLs reject the transaction.

The proposed disposable-only writer is a separate ephemeral role. It gets column-limited SELECT over catalogue source evidence and SELECT/INSERT over the four draft tables. It has no UPDATE, DELETE, activation, IAM, security-audit, schema-create or role-management rights. Existing runtime, importer and IAM roles receive no access to the proposed tables.

The adapter validates its actual target/role/grants, sets tenant scope, takes a tenant/product transaction advisory lock and uses READ COMMITTED statements after lock acquisition. This deliberately gives a fresh snapshot after a concurrent holder commits. It rejects changed-payload idempotency replays, stale price versions, cross-tenant snapshots and mismatched canonical/provider evidence. Candidate, sources, request and event commit in one transaction; audit-event failure rolls everything back.

## Limits

This is a draft-generation and evidence foundation, not publication. Migration 007 must not be registered or applied to `nukhabapay_dev` without separate review. Brick 3 persistent IAM and real staff login remain disabled, so no human approval/activation boundary exists. Real providers, public/kiosk catalogue delivery, executable quotes, orders, payments and financial execution remain out of scope.
