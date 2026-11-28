# Provider selection

Compare offers for one canonical product using trusted backend inputs.

- **Inputs** — approved product mapping and offer revisions, AED-normalized
  economics, an effective selection policy and evaluation time, and any reviewed
  reliability evidence.
- **Outputs** — a selected offer or a no-eligible-offer result, reasons for
  rejection and selection, and references to the input offer, FX, pricing,
  selection and reliability versions used.
- **Dependencies** — [pricing](../pricing/README.md), [matching](../catalog/matching/README.md),
  and pure [domain rules](../../../domain/src/pricing.ts). PostgreSQL evidence
  belongs behind application ports.

Apply hard gates before ranking. Check destination and denomination, currency,
delivery and terms, availability, freshness, commercial or funding restrictions,
and minimum profitability. The initial ranking will use deterministic expected
net contribution with a stable tie-break. Its approved inputs cover success
likelihood, success economics and failure or reversal costs. Advisory estimates
can enter the calculation only as explicitly approved inputs.

The existing AED example ranks eligible offers by effective acquisition cost.
Expected-contribution ranking, volume allocation, and checkout fallback policy
are future work. OR-Tools can be considered for constrained allocation once
capacities and the objective are defined in [catalogue configuration](../../../../config/README.md).
