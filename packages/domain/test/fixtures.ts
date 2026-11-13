import type { PricingPolicy } from "../src/index.ts";
import type { ProviderOffer } from "../../provider-contracts/src/index.ts";
import { createSyntheticProviders } from "../../provider-adapters/src/index.ts";

export const POLICY: PricingPolicy = Object.freeze({
  version: "test-policy-v1",
  serviceFeeMinor: 200n,
  maximumServiceFeeMinor: 200n,
  taxAmountMinor: 0n,
  paymentFeeBasisPoints: 150,
  paymentFixedFeeMinor: 20n,
  agentCommissionMinor: 50n,
  minimumContributionMinor: 100n,
  maximumOfferAgeMs: 24 * 60 * 60 * 1000,
});

export async function offers(): Promise<readonly ProviderOffer[]> {
  return (await Promise.all(createSyntheticProviders().map((provider) => provider.fetchCatalog()))).flat();
}
