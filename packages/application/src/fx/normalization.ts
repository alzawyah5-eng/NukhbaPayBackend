import { AED_RATE_DIRECTION, calculateAedAcquisitionCost, parseAcquisitionDecimal } from '../../../domain/src/acquisition-cost.js';
import { pricingInstantMs } from '../../../domain/src/pricing.js';
import type {
  AcquisitionCostReference, AcquisitionCostSource, AcquisitionPolicy, AcquisitionResultStore, AcquisitionScope,
  FxRateSource, FxSnapshot, NormalizationOutcome, PreparedNormalization, ValuationUse, VerifiedAcquisitionCost,
} from './contracts.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const reference = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const currency = /^[A-Z]{3}$/;
const uses: readonly ValuationUse[] = ['LAYER_2_PRICING', 'INTERNAL_REVIEW'];
const preparedResults = new WeakSet<PreparedNormalization>();
const dates = (value: string) => pricingInstantMs(value, 'acquisition evidence time');

export class AcquisitionBlocked extends Error {}
function requireEvidence(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new AcquisitionBlocked(reason);
}

export function acquisitionScopeKey(scope: AcquisitionScope) {
  requireEvidence(typeof scope.tenantId === 'string' && typeof scope.providerAccountId === 'string' &&
    uuid.test(scope.tenantId) && uuid.test(scope.providerAccountId), 'INVALID_SCOPE');
  return scope.tenantId + ':' + scope.providerAccountId;
}

export function assertPreparedNormalization(value: PreparedNormalization) {
  requireEvidence(preparedResults.has(value), 'UNVERIFIED_NORMALIZATION');
}

export function validateAcquisitionPolicy(policy: AcquisitionPolicy) {
  requireEvidence(referenceId(policy.version) && Number.isSafeInteger(policy.revision) && policy.revision > 0 &&
    policy.revision <= 2147483647 && ['LIVE', 'SYNTHETIC'].includes(policy.provenance) &&
    referenceId(policy.approvedCostSource) &&
    (policy.approvedFxSource === null || (referenceId(policy.approvedFxSource) && policy.approvedFxSource !== 'AED_IDENTITY')) &&
    [policy.maxCostAgeMs, policy.maxRateAgeMs, policy.refreshIntervalMs]
      .every(value => Number.isSafeInteger(value) && value > 0 && value <= 31_536_000_000) &&
    Number.isInteger(policy.rateScale) && policy.rateScale >= 0 && policy.rateScale <= 12 && policy.rounding === 'HALF_UP' &&
    Array.isArray(policy.permittedUses) && policy.permittedUses.length > 0 &&
    policy.permittedUses.every(use => uses.includes(use)) &&
    new Set(policy.permittedUses).size === policy.permittedUses.length &&
    policy.currencyScales['AED'] === 2 && Object.keys(policy.currencyScales).length <= 250 &&
    Object.entries(policy.currencyScales).every(([code, scale]) =>
      currency.test(code) && Number.isInteger(scale) && scale >= 0 && scale <= 8) &&
    dates(policy.effectiveFrom) < dates(policy.validUntil), 'INVALID_POLICY');
}

function copyPolicy(raw: AcquisitionPolicy) {
  const policy = Object.freeze({
    version: raw.version, revision: raw.revision, provenance: raw.provenance, effectiveFrom: raw.effectiveFrom,
    validUntil: raw.validUntil, approvedCostSource: raw.approvedCostSource, approvedFxSource: raw.approvedFxSource, maxRateAgeMs: raw.maxRateAgeMs,
    maxCostAgeMs: raw.maxCostAgeMs, refreshIntervalMs: raw.refreshIntervalMs, rateScale: raw.rateScale,
    rounding: raw.rounding, currencyScales: Object.freeze({ ...raw.currencyScales }),
    permittedUses: Object.freeze([...raw.permittedUses].sort()),
  });
  validateAcquisitionPolicy(policy);
  return policy;
}

function exactAmount(value: { amount: string; currency: string }, policy: AcquisitionPolicy, allowZero: boolean) {
  const scale = Object.hasOwn(policy.currencyScales, value.currency) ? policy.currencyScales[value.currency] : undefined;
  requireEvidence(currency.test(value.currency) && scale !== undefined, 'UNSUPPORTED_CURRENCY');
  const decimal = parseAcquisitionDecimal(value.amount, scale, 15);
  requireEvidence(allowZero || decimal.coefficient > 0n, 'ZERO_AMOUNT');
  return Object.freeze({ amount: value.amount, currency: value.currency });
}

function sameReference(left: AcquisitionCostReference, right: AcquisitionCostReference) {
  return acquisitionScopeKey(left) === acquisitionScopeKey(right) && left.offerKey === right.offerKey &&
    left.offerVersionId === right.offerVersionId && left.catalogue.snapshotId === right.catalogue.snapshotId &&
    left.catalogue.sourceVersion === right.catalogue.sourceVersion && left.catalogue.completeness === right.catalogue.completeness;
}

export function validateAcquisitionReference(value: AcquisitionCostReference) {
  acquisitionScopeKey(value);
  requireEvidence(uuid.test(value.offerVersionId) && referenceId(value.offerKey) &&
    uuid.test(value.catalogue.snapshotId) && referenceId(value.catalogue.sourceVersion) &&
    ['COMPLETE', 'PARTIAL', 'UNKNOWN'].includes(value.catalogue.completeness), 'INVALID_OFFER_REFERENCE');
}

/** Project a queue reference without copying optional or sensitive source payloads. */
export function acquisitionReference(value: AcquisitionCostReference): AcquisitionCostReference {
  validateAcquisitionReference(value);
  return Object.freeze({
    tenantId: value.tenantId, providerAccountId: value.providerAccountId,
    offerVersionId: value.offerVersionId, offerKey: value.offerKey,
    catalogue: Object.freeze({
      snapshotId: value.catalogue.snapshotId,
      sourceVersion: value.catalogue.sourceVersion,
      completeness: value.catalogue.completeness,
    }),
  });
}

export function nextAcquisitionRefreshAt(policy: AcquisitionPolicy, scheduledAt: string): string | null {
  validateAcquisitionPolicy(policy);
  const slot = dates(scheduledAt);
  requireEvidence(slot >= dates(policy.effectiveFrom), 'POLICY_NOT_CURRENT');
  const next = slot + policy.refreshIntervalMs;
  return next < dates(policy.validUntil) ? new Date(next).toISOString() : null;
}

/** Bound an external read even when the adapter ignores cancellation. Late reads have no write authority. */
export async function awaitAcquisitionDependency<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([cancelled, Promise.resolve().then(() => {
      signal.throwIfAborted();
      return work();
    })]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

function identityRate(cost: AcquisitionScope, policy: AcquisitionPolicy): FxSnapshot {
  return {
    tenantId: cost.tenantId, providerAccountId: cost.providerAccountId, id: 'identity:' + policy.version,
    direction: AED_RATE_DIRECTION, basis: 'AED_IDENTITY', sourceCurrency: 'AED', targetCurrency: 'AED',
    rate: '1', source: 'AED_IDENTITY', sourceReference: policy.version, approvalReference: policy.version,
    effectiveAt: policy.effectiveFrom, retrievedAt: policy.effectiveFrom, validUntil: policy.validUntil,
    policyVersion: policy.version, provenance: policy.provenance,
  };
}

export function prepareNormalization(
  input: VerifiedAcquisitionCost, rate: FxSnapshot | null, rawPolicy: AcquisitionPolicy, use: ValuationUse, asOf: string,
): PreparedNormalization {
  const policy = copyPolicy(rawPolicy);
  validateAcquisitionReference(input);
  const now = dates(asOf), observed = dates(input.observedAt), retrieved = dates(input.retrievedAt);
  requireEvidence(policy.permittedUses.includes(use), 'VALUATION_USE_DENIED');
  requireEvidence(dates(policy.effectiveFrom) <= now && now < dates(policy.validUntil), 'POLICY_NOT_CURRENT');
  requireEvidence(uuid.test(input.costSnapshotId) && referenceId(input.sourceReference) && input.source === policy.approvedCostSource &&
    policy.provenance === input.provenance &&
    (input.basis === 'VERIFIED_WALLET_DEBIT' || input.basis === 'VERIFIED_ACCOUNT_QUOTE'), 'UNVERIFIED_COST');
  requireEvidence(observed <= retrieved && retrieved <= now && now < dates(input.validUntil) &&
    now - observed < policy.maxCostAgeMs, 'COST_STALE_OR_INVALID');

  const acquisition = exactAmount(input.acquisition, policy, false);
  const billed = input.billedAedDebit;
  if (billed) {
    requireEvidence(billed.currency === 'AED' && referenceId(billed.sourceReference), 'INVALID_BILLED_AED_DEBIT');
    exactAmount(billed, policy, false);
  }
  const review = input.commercialReview;
  if (review) requireEvidence(referenceId(review.exportReference) && referenceId(review.reviewReference) &&
    referenceId(review.policyApprovalReference), 'INVALID_COMMERCIAL_REVIEW');
  const cost = Object.freeze({
    tenantId: input.tenantId, providerAccountId: input.providerAccountId, offerKey: input.offerKey,
    offerVersionId: input.offerVersionId, catalogue: Object.freeze({
      snapshotId: input.catalogue.snapshotId, sourceVersion: input.catalogue.sourceVersion,
      completeness: input.catalogue.completeness,
    }), costSnapshotId: input.costSnapshotId, source: input.source, provenance: input.provenance, basis: input.basis, acquisition,
    faceValue: exactAmount(input.faceValue, policy, false),
    settlement: input.settlement === null ? null : exactAmount(input.settlement, policy, true),
    ...(billed && { billedAedDebit: Object.freeze({
      amount: billed.amount, currency: billed.currency, sourceReference: billed.sourceReference,
    }) }),
    retail: input.retail === null ? null : exactAmount(input.retail, policy, true),
    observedAt: input.observedAt, retrievedAt: input.retrievedAt, validUntil: input.validUntil,
    sourceReference: input.sourceReference,
    ...(review && { commercialReview: Object.freeze({
      exportReference: review.exportReference, reviewReference: review.reviewReference,
      policyApprovalReference: review.policyApprovalReference,
    }) }),
  });
  const identity = acquisition.currency === 'AED';
  requireEvidence(!identity || rate === null, 'UNEXPECTED_IDENTITY_RATE');
  const quote = identity ? identityRate(cost, policy) : rate;
  requireEvidence(quote, 'APPROVED_RATE_MISSING');
  const effective = dates(quote.effectiveAt), rateRetrieved = dates(quote.retrievedAt);
  requireEvidence(acquisitionScopeKey(quote) === acquisitionScopeKey(cost) &&
    quote.sourceCurrency === acquisition.currency && quote.targetCurrency === 'AED' &&
    quote.direction === AED_RATE_DIRECTION && quote.policyVersion === policy.version &&
    quote.provenance === policy.provenance && referenceId(quote.sourceReference) &&
    referenceId(quote.approvalReference) &&
    (identity || (uuid.test(quote.id) && quote.basis === 'APPROVED_DIRECT' && quote.source === policy.approvedFxSource)),
    'FX_BINDING_INVALID');
  requireEvidence(effective <= rateRetrieved && rateRetrieved <= now &&
    now < dates(quote.validUntil) && (identity || now - effective < policy.maxRateAgeMs), 'FX_STALE_OR_INVALID');
  const fx = Object.freeze({
    tenantId: quote.tenantId, providerAccountId: quote.providerAccountId, id: quote.id, direction: quote.direction,
    basis: quote.basis, sourceCurrency: quote.sourceCurrency, targetCurrency: quote.targetCurrency, rate: quote.rate,
    source: quote.source, sourceReference: quote.sourceReference, approvalReference: quote.approvalReference,
    effectiveAt: quote.effectiveAt, retrievedAt: quote.retrievedAt, validUntil: quote.validUntil,
    policyVersion: quote.policyVersion, provenance: quote.provenance,
  });
  const calculation = calculateAedAcquisitionCost({
    amount: acquisition.amount, sourceScale: policy.currencyScales[acquisition.currency]!, rate: fx.rate,
    rateScale: policy.rateScale, direction: fx.direction, rounding: policy.rounding,
  });
  const validUntil = new Date(Math.min(dates(cost.validUntil), observed + policy.maxCostAgeMs,
    dates(fx.validUntil), identity ? Infinity : effective + policy.maxRateAgeMs, dates(policy.validUntil))).toISOString();
  const prepared = Object.freeze({ cost, fx, policy, calculation, normalizedAt: new Date(now).toISOString(), validUntil });
  preparedResults.add(prepared);
  return prepared;
}

export class AcquisitionNormalization {
  readonly #scopes: ReadonlySet<string>;
  constructor(private readonly deps: {
    scopes: readonly AcquisitionScope[];
    readPolicy(scope: AcquisitionScope): Promise<AcquisitionPolicy | null>;
    costSource: AcquisitionCostSource;
    fxSources: ReadonlyMap<string, FxRateSource>;
    store: AcquisitionResultStore;
    now: () => Date;
  }) {
    this.#scopes = new Set(deps.scopes.map(acquisitionScopeKey));
  }

  async normalize(input: AcquisitionCostReference, use: ValuationUse, correlationId: string,
    signal: AbortSignal): Promise<NormalizationOutcome> {
    try {
      const reference = acquisitionReference(input);
      requireEvidence(this.#scopes.has(acquisitionScopeKey(reference)), 'SCOPE_DENIED');
      requireEvidence(referenceId(correlationId), 'INVALID_CORRELATION_ID');
      signal.throwIfAborted();
      const scope = { tenantId: reference.tenantId, providerAccountId: reference.providerAccountId };
      const configured = await awaitAcquisitionDependency(() => this.deps.readPolicy(scope), signal);
      requireEvidence(configured, 'COMMERCIAL_POLICY_MISSING');
      const policy = copyPolicy(configured);
      const asOf = this.deps.now().toISOString();
      requireEvidence(policy.permittedUses.includes(use), 'VALUATION_USE_DENIED');
      requireEvidence(dates(policy.effectiveFrom) <= dates(asOf) && dates(asOf) < dates(policy.validUntil), 'POLICY_NOT_CURRENT');
      requireEvidence(this.deps.costSource.source === policy.approvedCostSource, 'APPROVED_COST_SOURCE_NOT_CONFIGURED');
      const cost = structuredClone(await awaitAcquisitionDependency(() => this.deps.costSource.readCost(reference, signal), signal));
      signal.throwIfAborted();
      requireEvidence(sameReference(cost, reference) && cost.provenance === policy.provenance && cost.source === policy.approvedCostSource, 'COST_SCOPE_MISMATCH');
      if (!('acquisition' in cost)) {
        requireEvidence(cost.basis === 'QUOTE_REQUIRED' || cost.basis === 'COST_UNCONFIRMED', 'UNVERIFIED_COST');
        return { status: cost.basis, reason: 'VERIFIED_ACQUISITION_COST_MISSING' };
      }
      exactAmount(cost.acquisition, policy, false);
      let rate: FxSnapshot | null = null;
      if (cost.acquisition.currency !== 'AED') {
        requireEvidence(policy.approvedFxSource, 'APPROVED_SOURCE_MISSING');
        const source = this.deps.fxSources.get(policy.approvedFxSource);
        requireEvidence(source?.source === policy.approvedFxSource, 'APPROVED_SOURCE_NOT_CONFIGURED');
        rate = await awaitAcquisitionDependency(() => source.readApprovedRate({
          tenantId: reference.tenantId, providerAccountId: reference.providerAccountId,
          currency: cost.acquisition.currency, policyVersion: policy.version, asOf,
        }, signal), signal);
      }
      signal.throwIfAborted();
      return await this.deps.store.save(
        prepareNormalization(cost, rate, policy, use, this.deps.now().toISOString()), correlationId);
    } catch (error) {
      if (error instanceof AcquisitionBlocked) return { status: 'BLOCKED', reason: error.message };
      if (error instanceof RangeError || error instanceof TypeError) return { status: 'BLOCKED', reason: 'INVALID_INPUT' };
      return { status: 'RETRY_PENDING', reason: 'NORMALIZATION_DEPENDENCY_UNAVAILABLE' };
    }
  }
}

function referenceId(value: string) {
  return typeof value === 'string' && reference.test(value);
}
