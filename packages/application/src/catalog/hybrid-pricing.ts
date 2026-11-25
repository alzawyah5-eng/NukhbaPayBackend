import { pricingInstantMs } from '../../../domain/src/pricing.js';
import { aiDigest, validateAiJobRequest, validateAiSummary, type AiApprovedPair, type AiJobRecord } from './ai-jobs.js';
import { classifyAdvisoryPublicationEvidence, generateDraftPublicationCandidate, type DraftPublicationRequest } from './publication-candidate.js';

export interface HybridPricingEvidence {
  /** Both inputs come from trusted catalogue and committed job readers. */
  readonly pair: AiApprovedPair;
  readonly job: AiJobRecord;
}

/** Joins a committed advisory job to one approved, current offer. The advisory
 * is recorded alongside the draft and never enters the price calculation. */
export function reviewHybridPricing(request: DraftPublicationRequest, evidence: HybridPricingEvidence, now: Date) {
  const { pair, job } = evidence;
  const proof = validateAiJobRequest(job.request);
  const summary = validateAiSummary(job.summary);
  const snapshot = request.sourceSnapshots.find(row => row.snapshotId === proof.snapshotId);
  const offer = request.offers.find(row => row.offerId === proof.offerId && row.snapshotId === proof.snapshotId);
  const time = now.getTime();
  const product = request.product;
  if (!Number.isSafeInteger(time) || job.state !== 'SUCCEEDED' || summary.decision !== 'CANDIDATE' ||
      !summary.duplicateCandidate || summary.provider === null || summary.confidenceBps < 9500 ||
      job.digest !== aiDigest(proof) || job.sourceDigest !== aiDigest(pair) ||
      job.tenantId !== request.tenantId || pair.tenantId !== request.tenantId ||
      pair.approved !== true || pair.accountActive !== true || pair.status !== 'COMPLETE' ||
      pair.offerId !== proof.offerId || pair.candidateProductId !== proof.candidateProductId ||
      proof.candidateProductId !== request.productId || pair.snapshotId !== proof.snapshotId ||
      pair.sourceVersion !== proof.sourceVersion || snapshot?.sourceVersion !== proof.sourceVersion ||
      !offer || pricingInstantMs(pair.observedAt, 'pair observed') !== pricingInstantMs(offer.observedAt, 'offer observed') ||
      pricingInstantMs(pair.completedAt, 'pair completed') !== pricingInstantMs(snapshot!.completedAt, 'snapshot completed') ||
      pricingInstantMs(pair.validUntil, 'pair expires') !== pricingInstantMs(offer.validUntil, 'offer expires') ||
      pricingInstantMs(pair.validUntil, 'pair expires') <= time ||
      [pair.provider, pair.candidate].some(row => row.country !== product.redemptionCountry ||
        row.currency !== product.currency || row.denomination_minor !== product.faceValueMinor.toString())) {
    throw new TypeError('Hybrid pricing evidence is incomplete or stale');
  }
  const draft = generateDraftPublicationCandidate(request);
  if (draft.selectedOfferId !== offer.offerId || draft.selectedSnapshotId !== snapshot!.snapshotId ||
      pricingInstantMs(draft.evaluatedAt, 'draft evaluated') > time || pricingInstantMs(draft.validUntil, 'draft expires') <= time) {
    throw new TypeError('Hybrid pricing draft no longer matches the reviewed offer');
  }
  return Object.freeze({ draft, advisory: classifyAdvisoryPublicationEvidence(job.id, aiDigest(summary)) });
}
