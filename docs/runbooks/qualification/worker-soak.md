# Catalogue worker soak qualification

**Status** `NOT_RUN` ? **Execution authorization** `NOT_GRANTED`

Use the reviewed 012 schema, exact disposable database and restricted worker/reader principal. Define the interval, soak duration, concurrency, backoff and clock skew thresholds before starting. Use an approved read-only synthetic provider and capture baseline idle/active connections.

Run two workers against competing schedules, stop and restart during fetch/import/draft/settlement, and simulate a lost acknowledgement through the approved fixture. Compare durable claim and audit counts, retry bounds, lease expiry, quarantined outcomes, final connection count and teardown. Verify deterministic draft amounts and retention of immutable publication evidence.

Record the approved manifest digest, target and scope, reviewer, authorization reference, observed results, deviations, sanitized evidence references, teardown and acceptance decision in the owner execution record. A separate scoped decision is required for execution.

Offline preflight uses `pnpm.cmd development:test:offline`. Candidate review preparation uses `python scripts/reconcile-r6-offline.py`.
