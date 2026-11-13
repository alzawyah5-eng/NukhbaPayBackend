import type { CatalogProvider, ProductIdentity, ProviderOffer } from "../../provider-contracts/src/index.ts";

export const SYNTHETIC_PRODUCT: ProductIdentity = Object.freeze({
  canonicalProductId: "synthetic_brand_x_ae_aed_100",
  brand: "SYNTHETIC_BRAND_X",
  redemptionCountry: "AE",
  currency: "AED",
  faceValueMinor: 10_000n,
  fulfillmentMethod: "DIGITAL_PIN",
  termsVersion: "synthetic-terms-v1",
});

/** Fixed synthetic fixture time makes the example reproducible on any date. */
export const SYNTHETIC_NOW = "2026-11-09T10:00:00Z";

export class SyntheticCatalogProvider implements CatalogProvider {
  readonly providerId: string;
  private readonly offers: readonly ProviderOffer[];

  constructor(providerId: string, debitMinor: bigint, extraFeeMinor: bigint, available: boolean) {
    this.providerId = providerId;
    this.offers = Object.freeze([Object.freeze({
      providerId,
      offerId: `${providerId}-gift-100`,
      snapshotId: `${providerId}-synthetic-snapshot-v1`,
      identity: SYNTHETIC_PRODUCT,
      mappingStatus: "APPROVED" as const,
      providerDebitMinor: debitMinor,
      upfrontDiscountMinor: SYNTHETIC_PRODUCT.faceValueMinor - debitMinor,
      additionalProviderFeeMinor: extraFeeMinor,
      available,
      eligible: true,
      observedAt: "2026-11-09T09:00:00Z",
      validUntil: "2026-11-09T11:00:00Z",
    })]);
  }

  async fetchCatalog(): Promise<readonly ProviderOffer[]> {
    return this.offers;
  }
}

/** No provider endpoints, credentials, HTTP calls, or payment/fulfillment methods exist here. */
export function createSyntheticProviders(): readonly CatalogProvider[] {
  return Object.freeze([
    new SyntheticCatalogProvider("synthetic-provider-a", 9_700n, 0n, true),
    new SyntheticCatalogProvider("synthetic-provider-b", 9_650n, 80n, true),
    new SyntheticCatalogProvider("synthetic-provider-c", 9_580n, 0n, false),
  ]);
}
