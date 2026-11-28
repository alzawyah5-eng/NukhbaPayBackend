# Product buckets and publication

A product bucket is the approved, versioned catalogue projection for a tenant
and its permitted sales channels. This boundary validates draft entries,
manages approval, activation and history, and prepares distribution.

- **Inputs** — canonical product version, selected offer and source snapshot,
  FX and pricing rule versions, selection decision, validity window and trusted
  approval context.
- **Outputs** — immutable internal publication evidence and a customer-safe
  view of the active version. Delivery uses a stable publication identity so
  downstream retries can be deduplicated.
- **Dependencies** — existing [draft](../publication-candidate.ts) and
  [workflow](../publication-workflow.ts) modules, [PostgreSQL draft storage](../../../../database/src/catalogue-publication-draft-store.ts),
  [delivery outbox](../../../../database/src/publication-delivery-outbox.ts),
  and the [catalogue API](../../../../../apps/api/src/modules/catalog/README.md).

Keep acquisition costs, pricing breakdown, offer and decision evidence in
restricted storage and staff interfaces. Payment and kiosk reads expose the
active catalogue revision, validity rules and safe product and price fields.
Suspension when eligible offers are exhausted belongs to publication policy.
At checkout, the [quotes boundary](../../quotes/README.md) must revalidate the
offer, price, mapping and version and apply the approved fallback policy.
Current building blocks cover synthetic publication and scoped catalogue reads.
