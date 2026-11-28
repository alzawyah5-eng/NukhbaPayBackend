# Product matching

This boundary links a provider SKU and offer revision to a canonical product.
A canonical product defines what the customer buys. Multiple provider offers
can refer to it and carry their own cost, availability and validity.

- **Inputs** — validated provider observations with source identity, canonical
  product specifications, and any existing mapping review.
- **Outputs** — a candidate, a review requirement, or a rejection with the
  relevant source and canonical IDs. Pricing consumes an approved mapping
  revision.
- **Dependencies** — [provider contracts](../../../../provider-contracts/README.md),
  [catalogue repositories](../../../../database/src/repositories/README.md),
  and optional [advisory matching](../../../../../apps/ai-service/README.md).

Compare product type, destination or redemption country, denomination, face
currency, delivery method and applicable restrictions. Keep the provider's
source identifiers and observation reference on the mapping. Existing
[`synthetic-provider-import.ts`](../synthetic-provider-import.ts) consumes
approved mappings and remains the reference for the current AED import path.
