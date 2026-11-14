# Brick 4B submission evidence foundation

Scope: isolated synthetic foundation only. No approval, activation, rollback or catalogue route is implemented. Production permissions and real staff operations remain disabled.

## Existing evidence gaps

007 contains no staff creator ID, issuer/subject, authority version, membership version or submitted-at provenance. Its sources preserve snapshot metadata, but it does not persist all product identity inputs, policy parameters, or the complete offer set used in hashing. A candidate digest alone cannot reconstruct these values. Existing staff observations and synthetic assurance explicitly remain acceptedApproval=false and NOT_AUTHORIZED. The global authorization phase remains 3A; pricing.submit and pricing.approve are reserved phase 4 permissions.

## Exact digest contract

The generated-object-only WeakMap retains the original JSON.stringify bytes of the ordered Brick 4A V1 array. SHA-256 is computed over UTF-8, without whitespace rewriting, timestamp normalization, object-key sorting or reparsing. The canonicalization ID is BRICK4A_ORDERED_ARRAY_JSON_V1. Top-level order:

1. NUKHBAPAY_CATALOGUE_PUBLICATION_CANDIDATE_V1
2. tenant UUID, product UUID, canonical product key, brand, redemption country, currency, face value integer string, fulfillment method, terms version
3. expected previous version, new price version
4. financial policy array: version, service fee, maximum service fee, tax, payment basis points, fixed payment fee, agent commission, minimum contribution, maximum offer age
5. evaluation timestamp
6. snapshot arrays sorted using the existing generator comparator: snapshot ID, provider account ID, key, source version, observed-at, completed-at
7. offer arrays sorted using the existing generator comparator: provider ID, offer ID, snapshot ID, debit, discount, additional fee, available, eligible, observed-at, valid-until, mapping status

All monetary values use decimal bigint strings. This preserves 4A hashes and financial calculations exactly. PostgreSQL independently checks encode(sha256(convert_to(canonical_payload,'UTF8')),'hex') against the candidate ID. Creator provenance is linked immutable evidence, outside the historical financial digest.

## Submission and legacy rejection

prepareSyntheticPriceSubmission accepts only verifier-registered identities from .invalid issuers through explicit trusted ISOLATED_SYNTHETIC_SUBMISSION_ONLY composition. The repository resolves the internal staff ID and tenant membership. Active editor role, grant times, revocation, conflicts and authority versions are checked. Caller creator fields and cloned identities are rejected. A committed authorization audit precedes a one-use process-local ticket. Fresh authority is checked again in the database transaction and before commit.

Pending 008 adds price_submission_births, price_submission_evidence and price_submission_events. All use FORCE RLS and mutation-rejection triggers. An owner-controlled candidate INSERT trigger records its creation transaction. Submission must reference that same transaction and candidate/tenant/product tuple. There is no backfill: candidates predating 008, and candidates committed without evidence, cannot acquire submission evidence later. No absence of evidence can be interpreted as approval eligibility. A deferred constraint requires matching immutable audit evidence.

The existing tenant/product advisory lock covers candidate and submission creation. Same creator/key retries return the original evidence; different attribution, changed payload or legacy records fail. An audit insert or authority failure rolls back candidate, sources, request, birth, evidence and events together. The separate writer recipe grants only SELECT/INSERT on evidence/events; it grants no birth access or update/delete/truncate privileges. Existing workload roles receive no grants.

## Reserved permission contracts

PUBLICATION_PERMISSION_CONTRACTS defines tenant-scoped pricing.submit, pricing.approve, pricing.activate, publication.rollback and catalog.published.read. None is active. Approval requires a distinct creator; activation reserves a separate operator and distinct creator/approver. Rollback requires a reason. Published reads require separately authenticated application and kiosk clients. These descriptors grant no permission and do not modify the global permission catalog, existing grants, Auth0, IAM or runtime wiring.

## Validation and deployment

008 is unregistered, restricted to loopback random b3b3 fixtures after exact registered 001-006 history and existing 007 tables. It rejects unapproved target/configuration and hostile ACL/default privileges. Neither migration is applied to persistent development. 007 must retain SHA-256 c4ed1ef748dabdfeb16cfc8cc40b667cb0106e944c5d97547677671ac064a2c9.

Build backend and test outputs before using run-catalogue-publication-acceptance.mjs --compiled --regression. The compiled mode preserves persistent read-only before/after checks, existing 3-second connection deadlines and 240-second command deadlines. It separates frontend/build time from database tests and logs stages without passwords. No timeout was increased.

Offer identity is represented once by the canonical product fields. Because legacy 4A could exclude mismatched offers without hashing their individual identities, the new submission boundary explicitly rejects any offer whose seven product identity fields differ. This invariant makes identity evidence complete for newly admitted submissions without changing historical digests or arithmetic.

## Timeout diagnosis and validation evidence

Observed connection failures occur during the existing 3-second handshake, including the runner baseline before any disposable database or SQL transaction is created. Read-only diagnostics found only the diagnostic connection in pg_stat_activity, no lingering sessions or lock waits, and successful equivalent connections in 32-2193ms. Sandboxed process/file operations also stalled while outside-sandbox checks succeeded. The evidence supports an environmental/intermittent connection-startup failure, not a publication SQL deadlock or incomplete cleanup. The precise OS-level scheduling cause is not established. No server setting, HBA rule, persistent record or timeout was changed.

A separate reproducible code defect was found in the synthetic import CLI: three imports used the obsolete database/dist layout. They now use database/dist/database/src, as emitted by the existing compiler configuration. The compiled suite subsequently passed all 18 database checks. The successful combined runner verified unchanged persistent 001-003 history and database inventory and cleaned all disposable resources.

Validation: application 95, financial/provider 19, publication/foundation 7, database 18, registered migration/security/restore 34, HTTP guard/header 14 tests passed; structure and frozen manifest checks passed. New submission evidence remains NOT_AUTHORIZED and acceptedApproval=false. These results permit further isolated synthetic implementation work only; they do not authorize an operational approval, publication, permission activation or external consumer.
