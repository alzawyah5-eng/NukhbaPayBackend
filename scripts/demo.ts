import { simulatePrice } from "../packages/domain/src/index.ts";
import { createSyntheticProviders, SYNTHETIC_NOW, SYNTHETIC_PRODUCT } from "../packages/provider-adapters/src/index.ts";

const catalogs = await Promise.all(createSyntheticProviders().map((provider) => provider.fetchCatalog()));
const result = simulatePrice(SYNTHETIC_PRODUCT, catalogs.flat(), Object.freeze({
  version: "synthetic-policy-v1",
  serviceFeeMinor: 200n,
  maximumServiceFeeMinor: 200n,
  taxAmountMinor: 0n,
  paymentFeeBasisPoints: 150,
  paymentFixedFeeMinor: 20n,
  agentCommissionMinor: 50n,
  minimumContributionMinor: 100n,
  maximumOfferAgeMs: 24 * 60 * 60 * 1000,
}), SYNTHETIC_NOW);

console.log(JSON.stringify({
  mode: "OFFLINE_SYNTHETIC_SIMULATION",
  notice: "Not persisted, not an executable quote, and no order or payment is created. Tax is explicitly zero only for this example.",
  customer_display: result.publicPrice,
  backend_only_trace: result.internalTrace,
}, null, 2));
