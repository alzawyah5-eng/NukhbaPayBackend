/** Backend-only normalized contract for the synthetic AED gift-card example. */
export interface ProductIdentity {
  readonly canonicalProductId: string;
  readonly brand: string;
  readonly redemptionCountry: "AE";
  readonly currency: "AED";
  readonly faceValueMinor: bigint;
  readonly fulfillmentMethod: "DIGITAL_PIN";
  readonly termsVersion: string;
}

export interface ProviderOffer {
  readonly providerId: string;
  readonly offerId: string;
  readonly snapshotId: string;
  readonly identity: ProductIdentity;
  readonly mappingStatus: "APPROVED" | "REVIEW_REQUIRED";
  /** Actual debit, already reduced by the upfront discount below. */
  readonly providerDebitMinor: bigint;
  readonly upfrontDiscountMinor: bigint;
  readonly additionalProviderFeeMinor: bigint;
  readonly available: boolean;
  readonly eligible: boolean;
  readonly observedAt: string;
  readonly validUntil: string;
}

/** Production adapters must validate their external input before emitting this contract. */
export interface CatalogProvider {
  readonly providerId: string;
  fetchCatalog(signal?: AbortSignal): Promise<readonly ProviderOffer[]>;
}
