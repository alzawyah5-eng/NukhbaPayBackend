# Catalogue refresh migration 012 review

Review outcome **changes required before registration**. The proposal remains frozen for review. SQL execution and PostgreSQL validation are pending. See [012 proposal](../../packages/database/pending-migrations/012_catalogue_refresh_PROPOSAL.sql).

| Finding | Required correction or evidence |
| --- | --- |
| Schedules carry tenant and provider account independently | Bind the pair to the existing provider-account key and validate account/provider binding before claim. Decide whether one schedule per account is sufficient and enforce the rule durably. Multiple schedules for the same account currently can run on different processes. |
| Schedule version changes lack enforceable history | Require immutable versioned configuration and prevent silent changes to a claimed version. Define cancellation of parked retries when a schedule changes. |
| Lease times come from the host clock | Define a database-owned clock and a measured drift policy. Compare expiry, mutation fences and settlement against the authoritative clock. Exercise two workers with skewed clocks. |
| The job state checks validate labels but permit illegal transitions | Bind state to reason, attempt, token and time. Validate allowed transitions and make audit creation mandatory for each transition in the durable design. |
| Tenant GUC and grants assume a trusted workload | Verify restricted role, exact target, effective/default grants and FORCE RLS. The assignment of a GUC by the workload must be backed by the approved fixed tenant allowlist and credential boundary. |
| Expiry sweep can update many rows and hold locks | Add workload-specific timeouts, bounded batches, and indexes for claim and expiry. Validate retry and settlement lock ordering under load. |
| Outages and lost acknowledgements require reconciliation | Prepare separately authorized receipt inspection, lease-token evidence, immutable repair audit and crash recovery. Quarantined outcomes require an explicit disposition. |
| Audit is append-only and has a schema trigger | Verify effective UPDATE, DELETE and TRUNCATE denial, ownership, default ACLs, and audited retention policy. Establish least-privilege access for a separate status reader. |

The worker now checks the claim lease before dispatch and carries tenant, version and expiry through the refresh coordinator. Settlement checks the attempt alongside the token and slot. These safeguards are covered offline. Cross-process clock, account scheduling uniqueness, durable state transitions and database-role proof are release gates.

## 20 November — R2 disposable evidence

The original proposal and the frozen R2 SQL remain in place. The [R2 proposal](../../packages/database/pending-migrations/012_catalogue_refresh_R2_PROPOSAL.sql) addresses account keying, the database clock, transition enforcement, audit and expiry. A [separate write-fence addendum](../../packages/database/pending-migrations/012_catalogue_refresh_write_fence_PROPOSAL.sql) protects scheduled import and draft transactions and includes no operational grants. Both were exercised on disposable PostgreSQL only. Actual workload roles, draft composition, publication, ambiguous commit recovery and authorized reconciliation are open. See the [continuation report](../brick-3-4-continuation-20261120.md).
