import type { ProductIdentity, ProviderOffer } from "../../provider-contracts/src/index.ts";
import { assertMinorAmount, formatAed, percentageFeeMinor } from "./money.ts";

export interface PricingPolicy {
  readonly version: string;
  readonly serviceFeeMinor: bigint;
  readonly maximumServiceFeeMinor: bigint;
  /** Required explicitly. This prototype neither determines taxability nor calculates tax. */
  readonly taxAmountMinor: bigint;
  readonly paymentFeeBasisPoints: number;
  readonly paymentFixedFeeMinor: bigint;
  readonly agentCommissionMinor: bigint;
  readonly minimumContributionMinor: bigint;
  readonly maximumOfferAgeMs: number;
}

export interface OfferRejection {
  readonly providerId: string;
  readonly offerId: string;
  readonly reason: string;
}

export function pricingInstantMs(value: string, name: string): number {
  if (typeof value !== "string" || value.length < 20 || value.length > 29) {
    throw new TypeError(`${name} must be a bounded RFC3339 timestamp with seconds and an explicit timezone`);
  }
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!parts) {
    throw new TypeError(`${name} must include seconds, optional milliseconds, and Z or a numeric timezone`);
  }
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const hour = Number(parts[4]);
  const minute = Number(parts[5]);
  const second = Number(parts[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > monthLengths[month - 1]!) {
    throw new TypeError(`${name} must contain a real Gregorian calendar date`);
  }
  if (hour > 23 || minute > 59 || second > 59) {
    throw new TypeError(`${name} must contain a valid clock time without leap seconds`);
  }
  if (parts[8] !== "Z") {
    const offsetHours = Number(parts[10]);
    const offsetMinutes = Number(parts[11]);
    if (offsetHours > 14 || offsetMinutes > 59 || (offsetHours === 14 && offsetMinutes !== 0) || parts[8] === "-00:00") {
      throw new TypeError(`${name} must contain a known timezone offset within plus or minus 14:00`);
    }
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError(`${name} must be a valid timestamp`);
  return timestamp;
}

function validateIdentity(identity: ProductIdentity): void {
  if (identity.currency !== "AED" || identity.redemptionCountry !== "AE" || identity.fulfillmentMethod !== "DIGITAL_PIN") {
    throw new TypeError("Only AED, AE-redemption, digital PIN products are supported by this prototype");
  }
  for (const value of [identity.canonicalProductId, identity.brand, identity.termsVersion]) {
    if (typeof value !== "string" || !value.trim()) throw new TypeError("Product identity fields must be present");
  }
  assertMinorAmount(identity.faceValueMinor, "faceValueMinor");
  if (identity.faceValueMinor === 0n) throw new TypeError("Product face value must be positive");
}

function validatePolicy(policy: PricingPolicy): void {
  if (typeof policy.version !== "string" || !policy.version.trim()) throw new TypeError("Policy version is required");
  for (const name of ["serviceFeeMinor", "maximumServiceFeeMinor", "taxAmountMinor", "paymentFixedFeeMinor", "agentCommissionMinor", "minimumContributionMinor"] as const) {
    assertMinorAmount(policy[name], name);
  }
  percentageFeeMinor(0n, policy.paymentFeeBasisPoints);
  if (policy.serviceFeeMinor > policy.maximumServiceFeeMinor) throw new RangeError("Service fee exceeds policy cap");
  if (!Number.isSafeInteger(policy.maximumOfferAgeMs) || policy.maximumOfferAgeMs <= 0) {
    throw new TypeError("maximumOfferAgeMs must be a positive safe integer");
  }
}

function offerRejection(offer: ProviderOffer, product: ProductIdentity, policy: PricingPolicy, nowMs: number): string | undefined {
  try {
    validateIdentity(offer.identity);
    for (const field of ["canonicalProductId", "brand", "redemptionCountry", "currency", "faceValueMinor", "fulfillmentMethod", "termsVersion"] as const) {
      if (offer.identity[field] !== product[field]) return `Product mismatch: ${field}`;
    }
    if (offer.mappingStatus !== "APPROVED") return "Product mapping requires review";
    if (offer.eligible !== true) return "Provider is ineligible";
    if (offer.available !== true) return "Offer is unavailable";
    for (const field of ["providerId", "offerId", "snapshotId"] as const) {
      if (typeof offer[field] !== "string" || !offer[field].trim()) return `Missing ${field}`;
    }
    for (const field of ["providerDebitMinor", "upfrontDiscountMinor", "additionalProviderFeeMinor"] as const) {
      assertMinorAmount(offer[field], field);
    }
    if (offer.providerDebitMinor === 0n) return "Zero provider debit requires review";
    if (offer.providerDebitMinor + offer.upfrontDiscountMinor !== product.faceValueMinor) {
      return "Upfront discount does not reconcile with the already-netted provider debit";
    }
    const observed = pricingInstantMs(offer.observedAt, "observedAt");
    const expires = pricingInstantMs(offer.validUntil, "validUntil");
    if (observed > nowMs) return "Provider observation is in the future";
    if (expires <= observed) return "Offer validity interval is invalid";
    if (expires <= nowMs) return "Offer has expired";
    if (nowMs - observed > policy.maximumOfferAgeMs) return "Offer observation is stale";
    assertMinorAmount(offer.providerDebitMinor + offer.additionalProviderFeeMinor, "effective provider cost");
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid offer";
  }
}

/** Pure comparison. The caller supplies time; no I/O or model output can alter the calculation. */
export function selectOffer(product: ProductIdentity, offers: readonly ProviderOffer[], policy: PricingPolicy, now: string) {
  validateIdentity(product);
  validatePolicy(policy);
  const nowMs = pricingInstantMs(now, "now");
  const eligible: ProviderOffer[] = [];
  const rejections: OfferRejection[] = [];
  const identities = new Set<string>();
  for (const offer of offers) {
    const key = JSON.stringify([offer.providerId, offer.offerId]);
    if (identities.has(key)) throw new Error("Duplicate provider offer identity in comparison input");
    identities.add(key);
    const reason = offerRejection(offer, product, policy, nowMs);
    if (reason) rejections.push(Object.freeze({ providerId: offer.providerId, offerId: offer.offerId, reason }));
    else eligible.push(offer);
  }
  eligible.sort((left, right) => {
    const leftCost = left.providerDebitMinor + left.additionalProviderFeeMinor;
    const rightCost = right.providerDebitMinor + right.additionalProviderFeeMinor;
    if (leftCost !== rightCost) return leftCost < rightCost ? -1 : 1;
    const leftKey = `${left.providerId}\u0000${left.offerId}`;
    const rightKey = `${right.providerId}\u0000${right.offerId}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  if (!eligible.length) throw new Error("No eligible, valid provider offer is available");
  const selected = Object.freeze({ ...eligible[0]!, identity: Object.freeze({ ...eligible[0]!.identity }) });
  return Object.freeze({ selected, rejections: Object.freeze(rejections) });
}

/** A price simulation, not a persisted or executable quote. No order or charge is created. */
export function simulatePrice(product: ProductIdentity, offers: readonly ProviderOffer[], policy: PricingPolicy, now: string) {
  const { selected, rejections } = selectOffer(product, offers, policy, now);
  const totalMinor = product.faceValueMinor + policy.serviceFeeMinor + policy.taxAmountMinor;
  assertMinorAmount(totalMinor, "customer total");
  const paymentFeeMinor = percentageFeeMinor(totalMinor, policy.paymentFeeBasisPoints) + policy.paymentFixedFeeMinor;
  assertMinorAmount(paymentFeeMinor, "payment fee");
  const providerCostMinor = selected.providerDebitMinor + selected.additionalProviderFeeMinor;
  // The upfront discount is already in the debit: never subtract it a second time.
  const contributionMinor = totalMinor - policy.taxAmountMinor - providerCostMinor - paymentFeeMinor - policy.agentCommissionMinor;
  if (contributionMinor < policy.minimumContributionMinor) {
    throw new RangeError("Expected contribution is below the approved minimum; publication is blocked");
  }
  const publicPrice = Object.freeze({
    product_id: product.canonicalProductId,
    currency: "AED" as const,
    face_value: formatAed(product.faceValueMinor),
    base_amount: formatAed(product.faceValueMinor),
    service_fee: formatAed(policy.serviceFeeMinor),
    tax_amount: formatAed(policy.taxAmountMinor),
    total_amount: formatAed(totalMinor),
    status: "SIMULATION" as const,
    executable: false as const,
  });
  const internalTrace = Object.freeze({
    provider_id: selected.providerId,
    offer_id: selected.offerId,
    provider_snapshot_id: selected.snapshotId,
    policy_version: policy.version,
    evaluated_at: now,
    observed_at: selected.observedAt,
    valid_until: selected.validUntil,
    provider_debit: formatAed(selected.providerDebitMinor),
    upfront_discount_already_netted: formatAed(selected.upfrontDiscountMinor),
    additional_provider_fee: formatAed(selected.additionalProviderFeeMinor),
    effective_provider_cost: formatAed(providerCostMinor),
    payment_fee: formatAed(paymentFeeMinor),
    agent_commission: formatAed(policy.agentCommissionMinor),
    expected_contribution: formatAed(contributionMinor),
    rounding_policy: "AED_MINOR_UNIT_HALF_UP_NONNEGATIVE" as const,
    rejected_offers: rejections,
  });
  return Object.freeze({ publicPrice, internalTrace });
}
