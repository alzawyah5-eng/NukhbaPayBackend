# Pricing use cases

Apply effective commercial rules to normalized provider costs and produce a
customer price and a separate auditable economic breakdown.

- **Inputs** — [AED-normalized acquisition cost](../fx/README.md), offer and
  product versions, and effective rules scoped by tenant, channel, category,
  provider, destination and denomination. Rules include explicit rounding and
  effective dates.
- **Outputs** — proposed selling price and auditable components for acquisition
  cost, markup or target margin, earned provider commission, payable agent or
  kiosk commission, customer service fees, payment and settlement fees,
  tax and expected contribution.
- **Dependencies** — the deterministic [money and pricing domain](../../../domain/README.md)
  and approved policy sources. The [commercial draft](../catalog/commercial-price-draft.ts)
  and [pricing review](../catalog/catalogue-pricing-review.ts) provide existing
  AED pilot and review entry points.

Earned commission contributes to revenue according to its commercial terms.
Payable commission is a cost. Reconcile upfront discounts already reflected
in the provider debit before evaluating the breakdown. Keep indicative price
previews separate from approved rules and customer prices. AI results can
support review while approved rules determine the calculation.

