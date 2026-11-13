# Financial domain starter

Pure, backend-only TypeScript functions with no database, HTTP, framework, AI, or credential dependency. Internal money uses `bigint` AED minor units. Public monetary values are decimal strings.

## Implemented example

- Fixed face-value AED gift cards for AE redemption, using approved exact product identities.
- Provider filtering for availability, eligibility, mapping approval, identity, explicit expiry, and maximum observation age.
- Ranking by wholesale debit plus separate provider fee; deterministic tie breaking.
- Explicit customer service fee and cap, explicit tax amount supplied by policy, percentage/fixed collection costs, agent share, and minimum contribution.
- Upfront discounts reconcile to the provider debit and are never deducted twice.
- Customer price and internal economic trace returned as separate immutable objects.
- Injected evaluation time and currency-specific half-up rounding.

This is a **simulation**, not an executable quote or a complete pricing engine. The prototype cap is AED 1,000,000.00. `taxAmountMinor` is required: the example explicitly supplies zero, which is not a legal tax classification. Tax jurisdiction/basis, deferred commissions, FX, refunds, bill inquiry, remittance, ticketing, variable denominations, contract authorization, and persistence are not implemented.

`maximumServiceFeeMinor`, approval, availability, and eligibility must come from trusted backend rules; this package does not authenticate those claims. The AI layer and clients must never invoke this as a way to bypass rule approval or quote authorization.

Production work should separate pure economic policies by category and use persisted quote, policy, source, and tax-rule versions. A money library for additional currencies needs documented decimal scales and rounding conventions; do not generalize AED's two decimal places to every currency.

## Input bounds

AED input strings are limited to the maximum decimal length permitted by `MAX_AMOUNT_MINOR` before any `BigInt` conversion. Timestamps use a strict bounded subset: `YYYY-MM-DDTHH:mm:ss`, optional one to three fractional-second digits, and `Z` or a numeric `±HH:MM` offset. Years are 0001–9999; calendar dates and leap years are validated before parsing. Clock times exclude hour 24 and leap seconds. Numeric offsets are limited to ±14:00; `-00:00` (unknown offset) is rejected. Inputs outside this subset require explicit normalization in a provider adapter.

Run the included checks from the repository root with Node 24:

```bash
node --experimental-strip-types --test packages/domain/test/*.test.ts packages/provider-adapters/test/*.test.ts
```
