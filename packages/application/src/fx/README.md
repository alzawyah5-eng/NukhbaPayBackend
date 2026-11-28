# Layer 1 acquisition-cost normalization

The worker accepts a trusted catalogue batch of account-scoped, persisted
offer-version references. The [acquisition contract](../../../provider-contracts/src/acquisition-cost.ts)
requires independently verified account quote or wallet debit evidence before
the offer can proceed. Finxplor catalogue values are denominations, and its
displayed sender cost and the earlier demo rate cannot establish a wallet
debit. The current Finxplor catalogue adapter classifies these rows as
`QUOTE_REQUIRED`. A reviewed quote must establish the account, SKU/version,
acquisition currency, complete payable cost or explicit fee treatment, and
its validity. Adapters use `COST_UNCONFIRMED` for ambiguous evidence.
The disabled pilot and preview remain historical references.

## Processing and current results

1. The [worker job](../../../../apps/worker/src/jobs/acquisition-normalization/worker.ts)
   checks the account, offer references, valuation use and catalogue snapshot
   metadata. Batch size is configurable up to 100. Reports retain completeness
   (`COMPLETE`, `PARTIAL`, or `UNKNOWN`) and count `NORMALIZED`,
   `ALREADY_PROCESSED`, `QUOTE_REQUIRED`, `COST_UNCONFIRMED`, `BLOCKED`, and
   `RETRY_PENDING`. They carry retry references and no commercial amounts.
   A trusted existing scheduler invokes `runScheduledBatch` for its claimed slot
   and uses `nextDueAt` from the versioned refresh interval. No timer starts on import.
2. The service resolves the account's effective policy, confirms the configured
   commercial source and obtains a verified snapshot. An approved FX adapter
   returns one direct `AED_PER_SOURCE_UNIT` rate for the same scope, currency
   and policy. Missing configuration and missing rates are explicit blocks.
   AED creates an identity snapshot with rate `"1"` and the policy validity.
3. The [domain calculator](../../../domain/src/acquisition-cost.ts) uses bounded
   decimal strings and bigint coefficients. The amount accepts up to 15 whole
   digits and the configured source scale up to 8. Rates accept up to 12 whole
   and 12 fractional digits. The exact product has up to 20 fractional digits
   and is the Layer 2 amount. Half-up at two AED decimals is only the staff
   display projection. A positive sub-fil valuation remains exact even if
   it displays as AED 0.00. The existing display amount cap remains in force.
   A separately evidenced AED billed debit is retained in the cost snapshot.
   Inverse and cross rates require future explicit quotation semantics.
4. The [PostgreSQL store](../../../database/src/layer1-acquisition-store.ts)
   pins the exact existing offer and source snapshot. It saves the original
   cost evidence, FX snapshot, immutable policy/results and one outbox event in
   a transaction. `NUMERIC` columns use explicit scale/range checks instead
   of assignment-time rounding. The exact v2 decimal string is retained in
   calculation evidence. The existing two-decimal column remains the staff
   projection. A v1 read derives the exact value from its immutable inputs
   and verifies its original display amount. Replay returns the original
   result ID and timestamp for the same calculator version. Current lookup is restricted to the newest offer version and
   ranks cost timestamps, policy revision and FX timestamps. An expired winner
   results in no current value. A delayed job can add history without replacing
   a newer current result.
5. The worker claims leased events, retries failures with bounded backoff, and
   acknowledges only durable receipt. The database consumer verifies the
   stored envelope and records its inbox key with the downstream database
   effect in the same transaction. It rechecks the current winner under the
   offer lock and marks older deliveries stale. A downstream network effect
   requires its own outbox. Layer 2 pricing is outside this integration.

## Layer 2 contract

[TypeScript definitions](contracts.ts) are the exact internal contract. The
normalization input is the approved `AcquisitionCostSnapshot`, an applicable
`AcquisitionPolicy`, and an approved `FxSnapshot` for foreign-currency
acquisition. Calculation also has an explicit evaluation instant and use.

| Value | Fields |
| --- | --- |
| Cost | `tenantId`, `providerAccountId`, `offerKey`, `offerVersionId`, `catalogue: {snapshotId, sourceVersion, completeness}`, `costSnapshotId`, `source`, `sourceReference`, `provenance`, `basis`, `observedAt`, `retrievedAt`, `validUntil`, and separate `acquisition`, `faceValue`, `retail`, `settlement` figures. An optional `billedAedDebit` is an independently verified AED amount with a source reference. `retail` and `settlement` may be null. Each figure is `{amount: decimal string, currency: ISO-style three-letter code}`. |
| FX | Scope, `id`, `sourceCurrency`, `targetCurrency: "AED"`, `rate` as a decimal string, `direction: "AED_PER_SOURCE_UNIT"`, `basis`, `source`, `sourceReference`, `approvalReference`, `effectiveAt`, `retrievedAt`, `validUntil`, `policyVersion`, and `provenance`. |
| Output | `NormalizedAcquisitionCost {resultId, cost, fx, policy, calculation, normalizedAt, validUntil}`. `calculation` has `amount` (exact AED decimal string), `currency`, `direction`, `workingScale`, and `calculatorVersion`. The separate display fields are `displayAmount`, `displayScale`, `rounding`, and `roundingBoundary: "DISPLAY_ONLY"`. Result validity is the earliest applicable cost, rate, policy or freshness deadline. |
| Event | `provider.acquisition-cost.normalized.v1` with `schema_version: 1`, `type`, `origin`, `provenance`, `event_id`, `tenant_id`, `provider_account_id`, `correlation_id`, `result_id`, `offer_version_id`, `permitted_uses`, and `occurred_at`. It carries references only. |

Layer 2 uses `readCurrent(scope, offerKey, "LAYER_2_PRICING")` for current
valuation and `readResult(scope, resultId, use)` for historical reproduction.
The historical reader can return expired evidence. The calculator can reproduce
the stored AED amount from the original decimal cost, applied rate and stored
policy precision. Use the transactional inbox to consume current work safely.

## Deployment and verification

The [configuration example](../../../../config/acquisition-normalization.example.json)
leaves live policy unset. It documents a synthetic policy and worker limits.
Live composition must supply an authenticated, reviewed commercial source,
a rate source and approved rate metadata, a current policy, an active account
with a matching offer version, and the existing trusted scheduler and event
transport. Provider specifications still need to confirm acquisition, separately
charged fees, FX quotation semantics and account-specific validity. No live
provider or FX source is bundled. The operational demo preview and old draft
path are still disabled.

The [local catalogue migration](../../../database/local-catalogue/016_acquisition_normalization.sql)
is registered in the checksummed local manifest. It has been exercised on
the disposable PostgreSQL 18 path. Apply through the existing local workflow
when enabling a designated development environment. A separately reviewed
[database grant recipe](../../../database/roles/grant_layer1_backend.sql) binds
a dedicated PostgreSQL login to an account. Its scope and mode are also
required in service composition. Existing catalogue reader/import roles have
no Layer 1 data access. No public API or browser endpoint exposes these amounts.

Use `pnpm -r build` followed by `pnpm layer1:test:postgres` on Windows with
PostgreSQL 18. Optionally set `NUKHBAPAY_LAYER1_PG_BIN` to the executable
directory. The test starts a private loopback cluster on a random port,
applies the checksummed migration with the existing installer, and removes
the cluster after verification. Application and provider tests are offline.
