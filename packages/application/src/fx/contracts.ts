import type { AcquisitionScope, AcquisitionCostSnapshot, ExactCurrencyAmount } from '../../../provider-contracts/src/acquisition-cost.js';
import type { calculateAedAcquisitionCost } from '../../../domain/src/acquisition-cost.js';

export type { AcquisitionScope, AcquisitionCostReference, AcquisitionCostSnapshot, AcquisitionCostSource, SourceCatalogueEvidence } from '../../../provider-contracts/src/acquisition-cost.js';

export type ValuationUse = 'LAYER_2_PRICING' | 'INTERNAL_REVIEW';

export interface AcquisitionPolicy {
  readonly version: string;
  readonly revision: number;
  readonly provenance: 'LIVE' | 'SYNTHETIC';
  readonly effectiveFrom: string;
  readonly validUntil: string;
  readonly approvedCostSource: string;
  readonly approvedFxSource: string | null;
  readonly maxRateAgeMs: number;
  readonly maxCostAgeMs: number;
  readonly currencyScales: Readonly<Record<string, number>>;
  readonly rateScale: number;
  readonly rounding: 'HALF_UP';
  readonly permittedUses: readonly ValuationUse[];
  readonly refreshIntervalMs: number;
}

export interface FxSnapshot extends AcquisitionScope {
  readonly id: string;
  readonly direction: 'AED_PER_SOURCE_UNIT';
  readonly basis: 'APPROVED_DIRECT' | 'AED_IDENTITY';
  readonly sourceCurrency: string;
  readonly targetCurrency: 'AED';
  readonly rate: string;
  readonly source: string;
  readonly sourceReference: string;
  readonly approvalReference: string;
  readonly effectiveAt: string;
  readonly retrievedAt: string;
  readonly validUntil: string;
  readonly policyVersion: string;
  readonly provenance: 'LIVE' | 'SYNTHETIC';
}

export interface FxRateSource {
  readonly source: string;
  readApprovedRate(request: AcquisitionScope & {
    currency: string; policyVersion: string; asOf: string;
  }, signal: AbortSignal): Promise<FxSnapshot | null>;
}

export type VerifiedAcquisitionCost = Extract<AcquisitionCostSnapshot, { acquisition: ExactCurrencyAmount }>;

export interface PreparedNormalization {
  readonly cost: VerifiedAcquisitionCost;
  readonly fx: FxSnapshot;
  readonly policy: AcquisitionPolicy;
  readonly calculation: ReturnType<typeof calculateAedAcquisitionCost>;
  readonly normalizedAt: string;
  readonly validUntil: string;
}

export interface NormalizedAcquisitionCost extends PreparedNormalization {
  readonly resultId: string;
}

export interface AcquisitionNormalizedEvent {
  readonly schema_version: 1;
  readonly type: 'provider.acquisition-cost.normalized.v1';
  readonly provenance: AcquisitionPolicy['provenance'];
  readonly origin: 'nukhbapay.layer1';
  readonly event_id: string;
  readonly tenant_id: string;
  readonly provider_account_id: string;
  readonly correlation_id: string;
  readonly result_id: string;
  readonly offer_version_id: string;
  readonly permitted_uses: readonly ValuationUse[];
  readonly occurred_at: string;
}

export type NormalizationOutcome =
  | { readonly status: 'NORMALIZED' | 'ALREADY_PROCESSED'; readonly result: NormalizedAcquisitionCost }
  | { readonly status: 'QUOTE_REQUIRED' | 'COST_UNCONFIRMED' | 'BLOCKED' | 'RETRY_PENDING'; readonly reason: string };

export interface AcquisitionResultReader {
  readResult(scope: AcquisitionScope, resultId: string, use: ValuationUse): Promise<NormalizedAcquisitionCost | null>;
  readCurrent(scope: AcquisitionScope, offerKey: string, use: ValuationUse): Promise<NormalizedAcquisitionCost | null>;
}

export interface AcquisitionResultStore extends AcquisitionResultReader {
  save(prepared: PreparedNormalization, correlationId: string): Promise<Extract<NormalizationOutcome, { result: NormalizedAcquisitionCost }>>;
}

export interface AcquisitionDelivery {
  readonly event: AcquisitionNormalizedEvent;
  readonly lease: string;
}

export interface AcquisitionOutbox {
  claim(scope: AcquisitionScope, leaseMs: number): Promise<AcquisitionDelivery | null>;
  settle(delivery: AcquisitionDelivery, delivered: boolean): Promise<boolean>;
}

/** Staff catalogue projection. Contains only current, reviewed commercial amounts. */
export type FinxplorAcquisitionSummary =
  | Readonly<{ status: 'QUOTE_REQUIRED' | 'EXPIRED' | 'UNAVAILABLE' | 'VERIFIED' }>
  | Readonly<{ status: 'NORMALIZED'; amounts: readonly Readonly<{
    aedAmount: string; faceAmount: string; faceCurrency: string; validUntil: string;
  }>[] }>;

/** Source-side customer prices and separately labelled catalogue denominations. */
export interface FinxplorLayer1Price {
  readonly basis: 'CUSTOMER_PRICE' | 'DENOMINATION' | 'FACE_MIN' | 'FACE_MAX';
  readonly sourceKey: string;
  readonly sourceCurrency: string;
  readonly sourceAmount: string;
  readonly convertedAed: string | null;
  readonly rateSource: 'XE' | 'CURRENCY_API' | 'AED_IDENTITY' | null;
}
