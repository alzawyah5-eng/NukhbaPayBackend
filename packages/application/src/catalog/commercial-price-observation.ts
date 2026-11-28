import { AedNormalizationUnavailableError } from '../fx/normalization-unavailable.js';

// Previous Layer 1 implementation — disabled while rebuilding according to the new approved architecture.
// import { createHash } from 'node:crypto';
// import { assertMinorAmount, parseAed, parseTwoDecimalAmount, pricingInstantMs } from '../../../domain/src/index.js';
//
// const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
// const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
// const fields = [
//   'version', 'tenantId', 'providerAccountId', 'sourceProductId', 'discoveryId', 'market', 'denomination',
//   'settlementCurrency', 'walletDebit', 'additionalFee', 'available', 'evidenceReference', 'observedAt', 'validUntil',
// ] as const;
// const fieldsWithFx = [...fields, 'fxRateReference'] as const;
// const fxFields = [
//   'tenantId', 'providerAccountId', 'commercialEvidenceReference', 'rateReference', 'source',
//   'baseCurrency', 'quoteCurrency', 'aedPerUsd', 'observedAt', 'validUntil',
// ] as const;
// const invalid = () => new TypeError('Commercial price observation could not be validated');

export interface AedCommercialPriceBinding {
  readonly tenantId: string;
  readonly providerAccountId: string;
  readonly sourceProductId: string;
  readonly discoveryId: string;
  readonly country: string;
  readonly currency: string;
  readonly denominations: readonly string[];
  readonly scanCompletedAt: Date;
}

/** Supplied by the trusted caller for this account, independently of the quote. */
export interface AedCommercialFxInput {
  readonly expectedSource: string;
  readonly evidence: unknown;
}

// Previous Layer 1 implementation — disabled while rebuilding according to the new approved architecture.
// function hasExactFields<Key extends string>(input: unknown, keys: readonly Key[]): input is Record<Key, unknown> {
//   return !!input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === keys.length &&
//     keys.every(key => Object.hasOwn(input, key));
// }
//
// function validateUsdFx(input: AedCommercialFxInput | undefined, binding: AedCommercialPriceBinding,
//   commercialEvidenceReference: string, rateReference: unknown, quoteObserved: number, time: number, maximumAgeMs: number) {
//   if (typeof rateReference !== 'string' || !identifier.test(rateReference) ||
//       !input || typeof input.expectedSource !== 'string' || !identifier.test(input.expectedSource) ||
//       !hasExactFields(input.evidence, fxFields)) throw invalid();
//   const rate = input.evidence;
//   if (rate.tenantId !== binding.tenantId || rate.providerAccountId !== binding.providerAccountId ||
//       rate.commercialEvidenceReference !== commercialEvidenceReference || rate.rateReference !== rateReference ||
//       rate.source !== input.expectedSource || rate.baseCurrency !== 'USD' || rate.quoteCurrency !== 'AED' ||
//       typeof rate.aedPerUsd !== 'string' || typeof rate.observedAt !== 'string' || typeof rate.validUntil !== 'string') throw invalid();
//   const match = /^(0|[1-9]\d{0,6})(?:\.(\d{1,12}))?$/.exec(rate.aedPerUsd);
//   if (!match) throw invalid();
//   const fraction = (match[2] ?? '').replace(/0+$/, '');
//   const denominator = 10n ** BigInt(fraction.length);
//   const numerator = BigInt(match[1]!) * denominator + BigInt(fraction || '0');
//   const observed = pricingInstantMs(rate.observedAt, 'FX observedAt');
//   const expires = pricingInstantMs(rate.validUntil, 'FX validUntil');
//   if (numerator === 0n || observed > quoteObserved || time - observed >= maximumAgeMs || expires <= time) throw invalid();
//   return {
//     expires,
//     canonical: [rate.source, rateReference, rate.baseCurrency, rate.quoteCurrency, numerator.toString(),
//       denominator.toString(), observed, expires],
//     convert: (amount: bigint) => (amount * numerator + denominator / 2n) / denominator,
//   };
// }
//
// /** Exact equality for provider amounts encoded with optional trailing zeros. */
// function matchesDenomination(input: string, amount: bigint) {
//   const match = /^(0|[1-9]\d{0,6})(?:\.(\d{1,2})0*)?$/.exec(input);
//   return match !== null && BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0')) === amount;
// }
//
// /** Validates a normalized, evidence-backed AED pilot input against the current saved discovery.
//  * The caller owns evidence provenance and policy. Successful validation confers no mapping, publication or payment authority. */
// export function validateAedCommercialPriceObservation(input: unknown, binding: AedCommercialPriceBinding,
//   now: Date, maximumAgeMs: number, fxInput?: AedCommercialFxInput) {
//   const versionIsTwo = hasExactFields(input, fieldsWithFx) && input.version === 2;
//   if (!versionIsTwo && (!hasExactFields(input, fields) || input.version !== 1)) throw invalid();
//   const fxReference = versionIsTwo ? input.fxRateReference : undefined;
//   const {
//     tenantId, providerAccountId, sourceProductId, discoveryId, market, denomination,
//     settlementCurrency, walletDebit, additionalFee, available, evidenceReference, observedAt, validUntil,
//   } = input;
//   if (market !== 'ARE' || (settlementCurrency !== 'AED' && settlementCurrency !== 'USD') || available !== true ||
//       binding.country !== market || binding.currency !== 'AED' ||
//       (settlementCurrency === 'USD' ? !versionIsTwo : (versionIsTwo && fxReference !== null) || fxInput !== undefined) ||
//       typeof tenantId !== 'string' || !uuid.test(tenantId) || tenantId !== binding.tenantId ||
//       typeof providerAccountId !== 'string' || !uuid.test(providerAccountId) || providerAccountId !== binding.providerAccountId ||
//       typeof discoveryId !== 'string' || !uuid.test(discoveryId) || discoveryId !== binding.discoveryId ||
//       typeof sourceProductId !== 'string' || !identifier.test(sourceProductId) || sourceProductId !== binding.sourceProductId ||
//       typeof evidenceReference !== 'string' || !identifier.test(evidenceReference) ||
//       typeof denomination !== 'string' || typeof walletDebit !== 'string' || typeof additionalFee !== 'string' ||
//       typeof observedAt !== 'string' || typeof validUntil !== 'string') throw invalid();
//
//   const time = now.getTime();
//   const scanTime = binding.scanCompletedAt.getTime();
//   const observed = pricingInstantMs(observedAt, 'cost observedAt');
//   const expires = pricingInstantMs(validUntil, 'cost validUntil');
//   if (!Number.isSafeInteger(time) || !Number.isSafeInteger(scanTime) || !Number.isSafeInteger(maximumAgeMs) ||
//       maximumAgeMs < 1 || scanTime > time || time - scanTime >= maximumAgeMs ||
//       observed > time || time - observed >= maximumAgeMs || expires <= time) throw invalid();
//
//   const denominationMinor = parseAed(denomination);
//   const settlementDebitMinor = parseTwoDecimalAmount(walletDebit, settlementCurrency);
//   const settlementFeeMinor = parseTwoDecimalAmount(additionalFee, settlementCurrency);
//   if (denominationMinor === 0n || settlementDebitMinor === 0n ||
//       !binding.denominations.some(value => matchesDenomination(value, denominationMinor))) throw invalid();
//   const fx = settlementCurrency === 'USD'
//     ? validateUsdFx(fxInput, binding, evidenceReference, fxReference, observed, time, maximumAgeMs)
//     : undefined;
//   const settlementTotalMinor = settlementDebitMinor + settlementFeeMinor;
//   assertMinorAmount(settlementTotalMinor, 'settlement cost');
//   // Round the combined cost once. Assign the rounding residual to the AED fee projection.
//   const walletDebitMinor = fx?.convert(settlementDebitMinor) ?? settlementDebitMinor;
//   const effectiveCostMinor = fx?.convert(settlementTotalMinor) ?? settlementTotalMinor;
//   const additionalFeeMinor = effectiveCostMinor - walletDebitMinor;
//   if (walletDebitMinor === 0n) throw invalid();
//   assertMinorAmount(effectiveCostMinor, 'effective cost');
//
//   const canonicalPayload = JSON.stringify([
//     versionIsTwo ? 'AED_COMMERCIAL_PRICE_OBSERVATION_V2' : 'AED_COMMERCIAL_PRICE_OBSERVATION_V1',
//     tenantId, providerAccountId, sourceProductId, discoveryId, market, denomination,
//     settlementCurrency, walletDebit, additionalFee, available, evidenceReference, observed, expires,
//     ...(versionIsTwo ? [fx?.canonical ?? null] : []),
//   ]);
//   const digest = createHash('sha256').update(canonicalPayload).digest('hex');
//   return Object.freeze({ digest, canonicalPayload, tenantId, providerAccountId, sourceProductId, discoveryId,
//     settlementCurrency, settlementDebitMinor, settlementFeeMinor,
//     denominationMinor, walletDebitMinor, additionalFeeMinor, effectiveCostMinor,
//     observedAt: new Date(observed).toISOString(), validUntil: new Date(Math.min(expires, fx?.expires ?? expires)).toISOString() });
// }

/** Existing commercial draft and storage shape, retained for the rebuild. */
export interface AedCommercialPriceObservation {
  readonly digest: string;
  readonly canonicalPayload: string;
  readonly tenantId: string;
  readonly providerAccountId: string;
  readonly sourceProductId: string;
  readonly discoveryId: string;
  readonly settlementCurrency: 'AED' | 'USD';
  readonly settlementDebitMinor: bigint;
  readonly settlementFeeMinor: bigint;
  readonly denominationMinor: bigint;
  readonly walletDebitMinor: bigint;
  readonly additionalFeeMinor: bigint;
  readonly effectiveCostMinor: bigint;
  readonly observedAt: string;
  readonly validUntil: string;
}

/** Fail closed before a caller can build or persist a draft from a normalized cost. */
export function validateAedCommercialPriceObservation(
  _input: unknown,
  _binding: AedCommercialPriceBinding,
  _now: Date,
  _maximumAgeMs: number,
  _fxInput?: AedCommercialFxInput,
): AedCommercialPriceObservation {
  throw new AedNormalizationUnavailableError();
}
