# Provider contracts

Backend-only normalized types between connectors and the financial domain. No credentials or client UI imports belong here.

The implemented contract deliberately covers only the synthetic AED gift-card example: an approved product mapping, exact redemption attributes, a wholesale debit with an already-netted upfront discount, separate additional fees, and explicit freshness.

Production connectors need runtime schema validation, authenticated source provenance, funding/eligibility checks, provider-specific full/delta snapshot semantics, and contract tests. Additional service categories need dedicated contracts; a bill or remittance must not be squeezed into this gift-card model. `eligible` and `mappingStatus` are trusted backend conclusions in a production adapter, never customer-supplied fields.

No fulfillment, payment, refund, or live provider integration is implemented.
