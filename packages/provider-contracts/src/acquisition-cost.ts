export interface AcquisitionScope {
  readonly tenantId: string;
  readonly providerAccountId: string;
}

export interface ExactCurrencyAmount {
  readonly amount: string;
  readonly currency: string;
}

export interface SourceCatalogueEvidence {
  readonly snapshotId: string;
  readonly sourceVersion: string;
  readonly completeness: 'COMPLETE' | 'PARTIAL' | 'UNKNOWN';
}

export interface AcquisitionCostReference extends AcquisitionScope {
  readonly offerKey: string;
  /** The immutable provider_offers.id, not the canonical product ID. */
  readonly offerVersionId: string;
  readonly catalogue: SourceCatalogueEvidence;
}

export type ProviderCostEvidence = Readonly<{
  basis: 'VERIFIED_ACCOUNT_QUOTE' | 'VERIFIED_WALLET_DEBIT';
  acquisition: ExactCurrencyAmount;
  /** Separate observed figures, when supplied. They are never FX calculation operands. */
  faceValue: ExactCurrencyAmount;
  settlement: ExactCurrencyAmount | null;
  /** Only when the provider independently confirms an AED amount it actually bills. */
  billedAedDebit?: Readonly<{ amount: string; currency: 'AED'; sourceReference: string }>;
  retail: ExactCurrencyAmount | null;
  sourceReference: string;
}> | Readonly<{
  basis: 'QUOTE_REQUIRED' | 'COST_UNCONFIRMED';
  sourceReference: string;
}>;

/** Returned only by a trusted, account-bound commercial adapter. */
export type AcquisitionCostSnapshot = AcquisitionCostReference & Readonly<{
  costSnapshotId: string;
  source: string;
  commercialReview?: Readonly<{ exportReference: string; reviewReference: string; policyApprovalReference: string }>;
  provenance: 'LIVE' | 'SYNTHETIC';
  observedAt: string;
  retrievedAt: string;
  validUntil: string;
}> & ProviderCostEvidence;

export interface AcquisitionCostSource {
  readonly source: string;
  readCost(reference: AcquisitionCostReference, signal: AbortSignal): Promise<AcquisitionCostSnapshot>;
}
