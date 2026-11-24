# Controlled runtime qualification preparation

19 November 2026. Release decision: NO-GO. Source preparation and offline tests grant no external execution or deployment authority. The current R6 governance in the Brick4 platform worktree records candidate owner acceptance NOT_YET_RECORDED and execution NOT_GRANTED. Its release manifest SHA256 is 846289ea59e2af23aa7aec8a7def1f33d48597d9fe65d1ff983a2bf2c7f4ca96 (309801 bytes). The source-only preparation command checks that binding, all R6 source pins and snapshot pins, and emits a fresh main-source manifest without connecting anywhere.

## Safe reproducible commands

From the main repository in PowerShell:

```powershell
pnpm.cmd development:test:offline
node scripts/prepare-runtime-qualification.mjs --prepare
node scripts/rehearse-reviewed-migrations.mjs --verify-only
```

The first command runs actual available build/type/test/structure checks with sensitive configuration removed, recording every suite in a new .local/master-development-offline-* directory. The second writes .local/runtime-qualification-*/manifest.json. It has no execution option. No lint command or offline vulnerability database is configured. Pinned dependency/source checks are not a fresh online advisory scan. Never put credentials on a command line or in these manifests.

## R6 owner authorization checklist (all required before connection)

1. Technical Manager/Project Manager reviews and records acceptance for the exact R6 manifest, new SQL and unresolved findings. An implementation report is not owner sign-off.
2. Prepare the currently missing inactive-to-authorized execution binding and fresh exact target/source/SQL/executable manifest. Bind owner identity, scope, expiry, run nonce, operation allowlist, target cluster/database/roles, stop and preservation rules. Obtain separate explicit owner execution authorization. Historical approvals are insufficient. No live CLI or trusted startup authorization issuer currently exists; a runnable SQL execution command cannot honestly be supplied until this binding is implemented and reviewed.
3. Reverify protected source/executable hashes and fresh physical cluster/process creation/listener/ancestry/reparse identity before any PostgreSQL access. Historical port55437/system identifier/database/role names in the R6 report are comparison inputs, never authorization. Do not probe5432, Brick3 targets or unrelated worktrees. Credential identity, storage and rotation must be approved separately; never print credentials.
4. Preserve R6 startup60s (diagnostic15s), adapter remainder45s, integrity4s, setup32s, preflight20s, physical4.5s, network6.5s, assertion4s, request14s, service10s, transaction8.5s including2s cleanup, Python4s and the independent native process cap. Keep F1-F5, C06-C10, source freshness, tenant locks, cancellation, rollback/quarantine, outbox and audit controls. Do not widen deadlines to make acceptance pass. Detailed hierarchy remains in the pinned release manifest.
5. Execute all11 R6 PostgreSQL groups through the reviewed owned callable/controller/managed adapter only after its trusted authorizer exists. Required coverage is pinned in eleven-group-coverage.json. Capture actual grants/RLS, locks, concurrency, trigger/audit integrity, process/network interruption, source revocation, attempt reservation, uncertain COMMIT, cleanup/reset and delayed disclosure evidence. No paid providers, payments or publication.
6. Any error, missing evidence or uncertainty: STOP and preserve exact fixture, credentials and diagnostics for owner reconciliation. Do not auto-reset quarantined reservations. Cleanup only after all required acceptance passes, using exact ownership/session proof and reviewed cleanup logic. No FORCE cleanup or historical directory deletion.
7. New refresh012 SQL is a separate proposal and is absent from R6. It needs its own schema/role/timeout/retention/append-only audit review and disposable acceptance. Do not register007-012, fabricate history or modify001-006. Existing IAM reader lacks full audit-read grants; any new audit reader requires a separate least-privilege review.

There is deliberately no restricted SQL execution command in this package: the R6 owned entry and startup authorizer remain inactive. The exact safe commands above are runnable now. A future owner-approved launcher must consume the fresh bound manifest and explicit authorization, not environment flags or pasted approval JSON. Its implementation, review and exact invocation are NEXT engineering work.

## Separate acceptance procedures

Use the scoped instructions for [Auth0 MFA](qualification/auth0-mfa.md), [platform staff commands](qualification/platform-staff.md), [provider sandboxes and API coverage](qualification/provider-sandbox.md), [payment and kiosk access](qualification/kiosk-access.md), and [operational PostgreSQL and publication](qualification/postgresql.md).

| Procedure | Required inputs / authorization | Required actual evidence |
| --- | --- | --- |
| Auth0/OIDC and MFA | Approved tenant, human client/audience, callback/logout URLs, strong-auth semantics, test identities and explicit Auth0 test authorization | Signed tokens, factor/authentication-time semantics, key rotation, wrong issuer/audience/client denial, replay/expiry/logout/session revocation; no credentials in evidence |
| Privileged staff workflows | ADR0013 assurance adapter, independently authenticated approvals, canonical-person quorum, restricted atomic executor, permission-phase approval and reviewed migrations | Invite/onboard delivery, activate/suspend/deactivate, membership/grant/revoke, self/delegation denial, atomic audit/idempotency/version checks, immediate access invalidation, unknown-commit recovery; currently implementation BLOCKED |
| PostgreSQL R6 | Exact accepted R6, fresh separate authorization and bound target; launcher/authorizer above | All11 real groups, protected deadlines, source/physical proof, cleanup; currently NOT RUN |
| Provider sandboxes | Per-family approved API schemas, access, country/service matrix and approved secret injection | Sanitized normalized read results, malformed schema/limits/outage/timeout errors, idempotency and unknown-outcome reconciliation; payment/payout operations excluded |
| Persistent catalogue worker | Reviewed012 proposal, bounded restricted pool, approved synthetic/read-only provider, durable schedule/draft ports | Real process cold-start and restart, two-process duplicate claim, crash at each transaction boundary, expiry quarantine, stale fences, audit rollback, connection disappearance and owner-defined soak criteria |
| End-to-end staff API | Approved operational identity/permission activation, tenant-aware readers and committed audit ports; approved BFF identity forwarding if browser UI is enabled | Every route deny matrix, object/tenant isolation, sensitive projection checks, duplicate inputs, CSRF/origin/cookie policy, revocation during request and response caching |
| External kiosk isolation | Separate approved machine issuer/audience/client/scope binding and explicit kiosk sandbox test | Machine public-catalogue access only, no staff/admin access, wrong client/tenant/scopes deny, no private economics/costs or direct provider access |

Each procedure must record environment, exact source/manifest, owner authorization, start/end, actual pass/fail/skip totals, sanitized evidence and independent outcome. Missing implementation is BLOCKED; missing authorized runtime is NOT RUN. Mocks are never runtime acceptance. No procedure permits real-money transactions or deployment.

## Independent release classification

Implemented, offline tested, runtime tested, security qualified and deployment approved are independent fields. Current staff APIs are partial and gated; catalogue administration needs durable runtime composition; refresh has offline-tested source plus unapplied SQL; approved live provider adapters are absent. Existing authentication, pricing/publication, AI and kiosk boundaries have offline evidence but no new external acceptance. All runtime/security-qualification/deployment fields remain false. Development may continue; release remains NO-GO until required source and runtime gates pass and the owner separately approves deployment.


## Current integrity finding

The initial preparation run checked486 current R6 source/compiled/test pins and475 archived snapshot pins. All475 snapshots match;29 current source/build pins differ, including staff-session, trusted-staff-actor, published-catalogue, database config/identity/publication files and derived builds. Exact paths are retained in recovery-checkpoints/master-continuation-20261119/r6-integrity-check.json at the workspace root and the .local/runtime-qualification-* manifest. No files in the R6 worktree were edited by this continuation. Preparation returns exit1 for this drift; do not regenerate historical hashes or overwrite current security fixes to obtain a pass. Reconcile the actual changes and prepare a fresh owner-review candidate with exact source/executable/SQL pins before any scoped execution authorization. The archived snapshot remains historical evidence.
