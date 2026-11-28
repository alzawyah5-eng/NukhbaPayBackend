import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAedCommercialPriceObservation } from '../src/catalog/commercial-price-observation.js';
import { prepareAedCommercialPriceDraft } from '../src/catalog/commercial-price-draft.js';
import { AedNormalizationUnavailableError } from '../src/fx/normalization-unavailable.js';
import type { DraftPublicationRequest } from '../src/catalog/publication-candidate.js';

const now = new Date('2026-11-26T08:00:00Z');
const twelveHours = 12 * 60 * 60 * 1000;
const binding = {
  tenantId: '00112233-4455-4667-8899-000000000001',
  providerAccountId: '00112233-4455-4667-8899-000000000002',
  discoveryId: '00112233-4455-4667-8899-000000000003',
  sourceProductId: 'sandbox-sku-10',
  country: 'ARE',
  currency: 'AED',
  denominations: ['10.000', '20'],
  scanCompletedAt: new Date('2026-11-26T06:30:00Z'),
};
const evidence = {
  version: 1, tenantId: binding.tenantId, providerAccountId: binding.providerAccountId, discoveryId: binding.discoveryId,
  sourceProductId: binding.sourceProductId, market: 'ARE', denomination: '10.00', settlementCurrency: 'AED',
  walletDebit: '9.37', additionalFee: '0.13', available: true, evidenceReference: 'test-fixture-only',
  observedAt: '2026-11-26T07:00:00Z', validUntil: '2026-11-26T10:00:00Z',
};
const validate = (input: unknown = evidence, source = binding) =>
  validateAedCommercialPriceObservation(input, source, now, twelveHours);

test('AED cost sums the exact wallet debit and additional fee without using denomination as cost', { skip: 'Previous Layer 1 implementation disabled' }, () => {
  const cost = validate();
  assert.equal(cost.denominationMinor, 1000n);
  assert.equal(cost.walletDebitMinor, 937n);
  assert.equal(cost.additionalFeeMinor, 13n);
  assert.equal(cost.effectiveCostMinor, 950n);
  assert.equal(Object.hasOwn(cost, 'sellingPrice'), false);
  assert.equal(validate({ ...evidence, additionalFee: '0.00' }).effectiveCostMinor, 937n);
});

test('replay is stable across input key order and equivalent Dubai and UTC timestamps', { skip: 'Previous Layer 1 implementation disabled' }, () => {
  const replay = { ...evidence, observedAt: '2026-11-26T11:00:00+04:00' };
  assert.equal(validate(Object.fromEntries(Object.entries(replay).reverse())).digest, validate().digest);
  assert.notEqual(validate({ ...evidence, additionalFee: '0.14' }).digest, validate().digest);
});

test('commercial evidence cannot cross tenants, accounts, discovery versions or product IDs', { skip: 'Previous Layer 1 implementation disabled' }, () => {
  const otherId = '00112233-4455-4667-8899-000000000004';
  for (const change of [{ tenantId: otherId }, { providerAccountId: otherId }, { discoveryId: otherId },
    { sourceProductId: 'different-sku' }, { denomination: '11.00' }]) {
    assert.throws(() => validate({ ...evidence, ...change }));
  }
  assert.throws(() => validate(evidence, { ...binding, denominations: ['10.001'] }));
});

test('expiry and evidence freshness are independent of the discovery scan', { skip: 'Previous Layer 1 implementation disabled' }, () => {
  for (const change of [{ observedAt: '2026-11-25T20:00:00Z' }, { observedAt: '2026-11-26T08:00:01Z' },
    { validUntil: '2026-11-26T08:00:00Z' }, { validUntil: '2026-02-30T12:00:00Z' }]) {
    assert.throws(() => validate({ ...evidence, ...change }));
  }
  assert.throws(() => validate(evidence, { ...binding, scanCompletedAt: new Date('2026-11-25T20:00:00Z') }));
});

test('reject unavailable offers, missing fees, foreign settlement and numeric or malformed amounts', { skip: 'Previous Layer 1 implementation disabled' }, () => {
  const { additionalFee: _fee, ...missingFee } = evidence;
  assert.throws(() => validate(missingFee));
  for (const change of [{ available: false }, { settlementCurrency: 'USD' }, { market: 'BGD' }, { fxRate: '1' },
    { walletDebit: 9.37 }, { walletDebit: '0.00' }, { walletDebit: '09.37' }, { additionalFee: '0.001' },
    { walletDebit: '1000000.00', additionalFee: '0.01' }]) {
    assert.throws(() => validate({ ...evidence, ...change }));
  }
});

const draftBinding = {
  ...binding,
  productId: '00112233-4455-4667-8899-000000000004',
  snapshotId: '00112233-4455-4667-8899-000000000005',
  offerId: 'sandbox-offer',
  providerId: 'FINXPLOR',
};
const fixtureProduct = {
  canonicalProductId: 'synthetic-gift-pin', brand: 'Demo Brand', redemptionCountry: 'AE', currency: 'AED',
  faceValueMinor: 1000n, fulfillmentMethod: 'DIGITAL_PIN', termsVersion: 'fixture-terms-v1',
} as const;
const fixtureSnapshot = {
  snapshotId: draftBinding.snapshotId, providerAccountId: binding.providerAccountId, snapshotKey: 'fixture-snapshot',
  sourceVersion: 'fixture-v1', observedAt: evidence.observedAt, completedAt: '2026-11-26T07:01:00Z', status: 'COMPLETE',
} as const;
const fixtureOffer = {
  providerId: draftBinding.providerId, offerId: draftBinding.offerId, snapshotId: draftBinding.snapshotId,
  identity: fixtureProduct, mappingStatus: 'APPROVED', available: true, eligible: true,
  providerDebitMinor: 937n, upfrontDiscountMinor: 63n, additionalProviderFeeMinor: 13n,
  observedAt: evidence.observedAt, validUntil: evidence.validUntil,
} as const;
const fixtureRequest: DraftPublicationRequest = {
  tenantId: draftBinding.tenantId, productId: draftBinding.productId, product: fixtureProduct,
  sourceSnapshots: [fixtureSnapshot], offers: [fixtureOffer],
  evaluatedAt: '2026-11-26T07:15:00Z', expectedPreviousVersion: 0,
  idempotencyKey: '00112233-4455-4667-8899-000000000006',
  pricingPolicy: { version: 'fixture-policy-v1', serviceFeeMinor: 200n, maximumServiceFeeMinor: 200n,
    taxAmountMinor: 0n, paymentFixedFeeMinor: 0n, paymentFeeBasisPoints: 0, agentCommissionMinor: 50n,
    minimumContributionMinor: 100n, maximumOfferAgeMs: twelveHours },
};

test('commercial evidence and an approved canonical offer produce one exact non-executable draft', { skip: 'Previous Layer 1 implementation disabled' }, () => {
  const review = prepareAedCommercialPriceDraft(evidence, draftBinding, fixtureRequest, now, twelveHours);
  assert.equal(review.draft.providerCostMinor, 950n);
  assert.equal(review.draft.totalAmountMinor, 1200n);
  assert.equal(review.draft.expectedContributionMinor, 200n);
  assert.equal(review.draft.status, 'DRAFT');
  assert.equal(review.draft.execution, 'NOT_AUTHORIZED');
  assert.equal(review.draft.activationAllowed, false);
  assert.ok(Object.isFrozen(review));
});

test('draft review replays exactly and distinguishes different commercial evidence', { skip: 'Previous Layer 1 implementation disabled' }, () => {
  const first = prepareAedCommercialPriceDraft(evidence, draftBinding, fixtureRequest, now, twelveHours);
  const retry = prepareAedCommercialPriceDraft({ ...evidence }, draftBinding, fixtureRequest,
    new Date('2026-11-26T08:30:00Z'), twelveHours);
  const updated = prepareAedCommercialPriceDraft({ ...evidence, evidenceReference: 'fixture-quote-b' },
    draftBinding, fixtureRequest, now, twelveHours);
  assert.equal(first.reviewDigest, retry.reviewDigest);
  assert.equal(first.commercialEvidenceDigest, retry.commercialEvidenceDigest);
  assert.equal(first.draft.operationId, updated.draft.operationId);
  assert.notEqual(first.reviewDigest, updated.reviewDigest);
});

test('draft review denies changed amounts, unapproved mappings and mismatched scope', { skip: 'Previous Layer 1 implementation disabled' }, () => {
  for (const change of [
    { tenantId: '00112233-4455-4667-8899-000000000009' },
    { productId: '00112233-4455-4667-8899-000000000009' },
    { sourceSnapshots: [{ ...fixtureSnapshot, providerAccountId: '00112233-4455-4667-8899-000000000009' }] },
    { offers: [{ ...fixtureOffer, offerId: 'wrong' }] },
    { offers: [{ ...fixtureOffer, providerDebitMinor: 938n, upfrontDiscountMinor: 62n }] },
    { offers: [{ ...fixtureOffer, additionalProviderFeeMinor: 0n }] },
    { offers: [{ ...fixtureOffer, mappingStatus: 'REVIEW_REQUIRED' as const }] },
    { offers: [fixtureOffer, fixtureOffer] },
  ]) {
    assert.throws(() => prepareAedCommercialPriceDraft(evidence, draftBinding,
      { ...fixtureRequest, ...change }, now, twelveHours));
  }
});

test('draft review denies expired quotes even when the original evaluation time was valid', { skip: 'Previous Layer 1 implementation disabled' }, () => {
  assert.throws(() => prepareAedCommercialPriceDraft(evidence, draftBinding, fixtureRequest,
    new Date(evidence.validUntil), twelveHours));
  assert.throws(() => prepareAedCommercialPriceDraft(evidence, draftBinding,
    { ...fixtureRequest, sourceSnapshots: [{ ...fixtureSnapshot, observedAt: '2026-11-25T20:00:00Z' }] }, now, twelveHours));
  assert.throws(() => prepareAedCommercialPriceDraft(evidence, draftBinding, fixtureRequest, now, Infinity));
});

const usdBinding = { ...draftBinding, denominations: ['50'] };
const usdQuote = {
  ...evidence, version: 2, settlementCurrency: 'USD', denomination: '50.00', walletDebit: '11.63',
  additionalFee: '0.00', fxRateReference: 'rate-fixture-v1',
};
const fx = {
  expectedSource: 'approved-fixture-source',
  evidence: {
    tenantId: usdBinding.tenantId, providerAccountId: usdBinding.providerAccountId,
    commercialEvidenceReference: usdQuote.evidenceReference, rateReference: usdQuote.fxRateReference,
    source: 'approved-fixture-source', baseCurrency: 'USD', quoteCurrency: 'AED', aedPerUsd: '3.6725',
    observedAt: '2026-11-26T06:59:00Z', validUntil: '2026-11-26T09:00:00Z',
  },
};

test('USD wallet evidence converts through the supplied rate and preserves the original currency and debit', { skip: 'Previous Layer 1 implementation disabled' }, () => {
  const cost = validateAedCommercialPriceObservation(usdQuote, usdBinding, now, twelveHours, fx);
  assert.equal(cost.settlementCurrency, 'USD');
  assert.equal(cost.settlementDebitMinor, 1163n);
  assert.equal(cost.effectiveCostMinor, 4271n);
  assert.equal(cost.validUntil, '2026-11-26T09:00:00.000Z');
  const historicalRate = validateAedCommercialPriceObservation(usdQuote, usdBinding, now, twelveHours,
    { ...fx, evidence: { ...fx.evidence, aedPerUsd: '4.3' } });
  assert.equal(historicalRate.effectiveCostMinor, 5001n);
  assert.notEqual(cost.digest, historicalRate.digest);
  const equivalentRate = validateAedCommercialPriceObservation(usdQuote, usdBinding, now, twelveHours,
    { ...fx, evidence: { ...fx.evidence, aedPerUsd: '3.672500' } });
  assert.equal(equivalentRate.digest, cost.digest);
});

test('USD fees and debit retain one rounded AED total', { skip: 'Previous Layer 1 implementation disabled' }, () => {
  const cost = validateAedCommercialPriceObservation({ ...usdQuote, walletDebit: '0.02', additionalFee: '0.03' },
    usdBinding, now, twelveHours, { ...fx, evidence: { ...fx.evidence, aedPerUsd: '3.72' } });
  assert.equal(cost.walletDebitMinor, 7n);
  assert.equal(cost.additionalFeeMinor, 12n);
  assert.equal(cost.effectiveCostMinor, 19n);
});

test('USD validation denies missing, untrusted, reversed, stale or invalid FX evidence', { skip: 'Previous Layer 1 implementation disabled' }, () => {
  const check = (input: unknown, evidenceInput?: typeof fx) =>
    validateAedCommercialPriceObservation(input, usdBinding, now, twelveHours, evidenceInput);
  assert.throws(() => check(usdQuote));
  assert.throws(() => check({ ...usdQuote, version: 1 }, fx));
  assert.throws(() => check({ ...usdQuote, fxRateReference: 'another-rate' }, fx));
  assert.throws(() => check({ ...usdQuote, settlementCurrency: 'AED' }, fx));
  assert.throws(() => check(usdQuote, { ...fx, expectedSource: 'another-source' }));
  for (const change of [
    { tenantId: '00112233-4455-4667-8899-000000000009' },
    { providerAccountId: '00112233-4455-4667-8899-000000000009' },
    { commercialEvidenceReference: 'another-quote' },
    { baseCurrency: 'AED', quoteCurrency: 'USD' },
    { observedAt: '2026-11-26T07:00:01Z' },
    { observedAt: '2026-11-25T19:00:00Z' },
    { validUntil: '2026-11-26T08:00:00Z' },
    { aedPerUsd: '0.00' },
    { aedPerUsd: '4.3e0' },
    { aedPerUsd: '0.000000000001' },
  ]) {
    assert.throws(() => check(usdQuote, { ...fx, evidence: { ...fx.evidence, ...change } }));
  }
});

test('converted cost uses the canonical AED draft policy and expiry without changing reconciliation rules', { skip: 'Previous Layer 1 implementation disabled' }, () => {
  const product = { ...fixtureProduct, faceValueMinor: 5000n };
  const offer = { ...fixtureOffer, identity: product, providerDebitMinor: 4271n, upfrontDiscountMinor: 729n,
    additionalProviderFeeMinor: 0n, validUntil: fx.evidence.validUntil };
  const request = { ...fixtureRequest, product, offers: [offer] };
  const result = prepareAedCommercialPriceDraft(usdQuote, usdBinding, request, now, twelveHours, fx);
  assert.equal(result.draft.currency, 'AED');
  assert.equal(result.draft.totalAmountMinor, 5200n);
  assert.equal(result.draft.providerCostMinor, 4271n);
  assert.equal(result.draft.expectedContributionMinor, 879n);
  assert.equal(result.draft.activationAllowed, false);
  assert.throws(() => prepareAedCommercialPriceDraft(usdQuote, usdBinding,
    { ...request, offers: [{ ...offer, validUntil: usdQuote.validUntil }] }, now, twelveHours, fx));
  assert.throws(() => prepareAedCommercialPriceDraft(usdQuote, usdBinding,
    { ...request, offers: [{ ...offer, providerDebitMinor: 5001n, upfrontDiscountMinor: 0n }] }, now, twelveHours,
    { ...fx, evidence: { ...fx.evidence, aedPerUsd: '4.3' } }));
});


test('commercial normalization and draft preparation fail closed for AED and USD', () => {
  const unavailable = { name: AedNormalizationUnavailableError.name, code: 'AED_NORMALIZATION_UNAVAILABLE' };
  assert.throws(() => validate(), unavailable);
  assert.throws(() => validateAedCommercialPriceObservation(usdQuote, usdBinding, now, twelveHours, fx), unavailable);
  assert.throws(() => prepareAedCommercialPriceDraft(evidence, draftBinding, fixtureRequest, now, twelveHours), unavailable);
  assert.throws(() => prepareAedCommercialPriceDraft(usdQuote, usdBinding, fixtureRequest, now, twelveHours, fx), unavailable);
});
