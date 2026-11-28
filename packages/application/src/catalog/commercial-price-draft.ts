import { createHash } from 'node:crypto';
import { pricingInstantMs } from '../../../domain/src/index.js';
import { validateAedCommercialPriceObservation, type AedCommercialFxInput, type AedCommercialPriceBinding } from './commercial-price-observation.js';
import { financialPolicyRecord, generateDraftPublicationCandidate, type DraftPublicationRequest } from './publication-candidate.js';

const commercialReviews = new WeakSet<object>();

export type AedCommercialPriceDraft = ReturnType<typeof prepareAedCommercialPriceDraft>;

export function assertPreparedAedCommercialPriceDraft(value: unknown): asserts value is AedCommercialPriceDraft {
  if (typeof value !== 'object' || value === null || !commercialReviews.has(value)) {
    throw new TypeError('Untrusted commercial draft review');
  }
}

export interface AedCommercialDraftBinding extends AedCommercialPriceBinding {
  readonly productId: string;
  readonly providerId: string;
  readonly offerId: string;
  readonly snapshotId: string;
}

/** Rehearses a single offer. Trusted callers must source the binding and the
 * canonical request from independently approved mapping, policy and snapshot readers. */
export function prepareAedCommercialPriceDraft(input: unknown, binding: AedCommercialDraftBinding,
  request: DraftPublicationRequest, now: Date, maximumCommercialAgeMs: number, fxInput?: AedCommercialFxInput) {
  if (!Number.isSafeInteger(maximumCommercialAgeMs) || maximumCommercialAgeMs < 1) {
    throw new TypeError('A bounded commercial freshness window is required');
  }
  const maximumAgeMs = Math.min(maximumCommercialAgeMs, request.pricingPolicy.maximumOfferAgeMs);
  const cost = validateAedCommercialPriceObservation(input, binding, now, maximumAgeMs, fxInput);

  const [snapshot] = request.sourceSnapshots;
  const [offer] = request.offers;
  const evaluated = pricingInstantMs(request.evaluatedAt, 'draft evaluation');
  const time = now.getTime();
  if (request.tenantId !== binding.tenantId || request.productId !== binding.productId ||
      request.product.faceValueMinor !== cost.denominationMinor || evaluated > time ||
      evaluated < binding.scanCompletedAt.getTime() || request.sourceSnapshots.length !== 1 ||
      !snapshot || snapshot.snapshotId !== binding.snapshotId || snapshot.providerAccountId !== binding.providerAccountId ||
      time - pricingInstantMs(snapshot.observedAt, 'snapshot observation') >= maximumAgeMs ||
      request.offers.length !== 1 || !offer || offer.providerId !== binding.providerId || offer.offerId !== binding.offerId ||
      offer.snapshotId !== binding.snapshotId || offer.providerDebitMinor !== cost.walletDebitMinor ||
      offer.additionalProviderFeeMinor !== cost.additionalFeeMinor ||
      pricingInstantMs(offer.observedAt, 'offer observation') !== pricingInstantMs(cost.observedAt, 'commercial observation') ||
      pricingInstantMs(offer.validUntil, 'offer expiry') !== pricingInstantMs(cost.validUntil, 'commercial expiry')) {
    throw new TypeError('Commercial price evidence does not match the canonical draft inputs');
  }

  const draft = generateDraftPublicationCandidate(request);
  const validityDeadline = new Date(Math.min(pricingInstantMs(cost.validUntil, 'commercial expiry'),
    pricingInstantMs(cost.observedAt, 'commercial observation') + maximumAgeMs,
    pricingInstantMs(snapshot.observedAt, 'source observation') + maximumAgeMs,
    binding.scanCompletedAt.getTime() + maximumAgeMs)).toISOString();
  const reviewDigest = createHash('sha256').update(JSON.stringify([
    'AED_COMMERCIAL_PRICE_DRAFT_REVIEW_V2', cost.digest, draft.operationId, draft.candidateDigest, validityDeadline,
  ])).digest('hex');
  const pricingPolicyPayload = JSON.stringify(['AED_PRICING_POLICY_V1', draft.tenantId, financialPolicyRecord(request.pricingPolicy)]);
  const review = Object.freeze({ draft, cost, commercialEvidenceDigest: cost.digest, reviewDigest, validityDeadline, pricingPolicyPayload });
  commercialReviews.add(review);
  return review;
}
