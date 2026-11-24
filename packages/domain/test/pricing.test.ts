import assert from "node:assert/strict";
import test from "node:test";
import { selectOffer, simulatePrice } from "../src/index.ts";
import type { PricingPolicy } from "../src/index.ts";
import type { ProviderOffer } from "../../provider-contracts/src/index.ts";
import { SYNTHETIC_NOW, SYNTHETIC_PRODUCT } from "../../provider-adapters/src/index.ts";
import { POLICY, offers } from "./fixtures.ts";

test("provider choice and price waterfall reproduce the agreed AED 102 / AED 2.77 example", async () => {
  const result = simulatePrice(SYNTHETIC_PRODUCT, await offers(), POLICY, SYNTHETIC_NOW);
  assert.equal(result.publicPrice.total_amount, "102.00");
  assert.equal(result.internalTrace.provider_id, "synthetic-provider-a");
  assert.equal(result.internalTrace.provider_debit, "97.00");
  assert.equal(result.internalTrace.upfront_discount_already_netted, "3.00");
  assert.equal(result.internalTrace.payment_fee, "1.73");
  assert.equal(result.internalTrace.agent_commission, "0.50");
  assert.equal(result.internalTrace.expected_contribution, "2.77");
  assert.equal(result.publicPrice.executable, false);
});

test("additional provider fees affect comparison and unavailable cheap offers are excluded", async () => {
  const input = await offers();
  const selected = selectOffer(SYNTHETIC_PRODUCT, input, POLICY, SYNTHETIC_NOW);
  assert.equal(selected.selected.providerId, "synthetic-provider-a");
  assert.equal(selected.rejections[0]!.providerId, "synthetic-provider-c");
  assert.match(selected.rejections[0]!.reason, /unavailable/);
  const withoutExtraFee = input.map((offer) => offer.providerId.endsWith("-b") ? { ...offer, additionalProviderFeeMinor: 0n } : offer);
  assert.equal(selectOffer(SYNTHETIC_PRODUCT, withoutExtraFee, POLICY, SYNTHETIC_NOW).selected.providerId, "synthetic-provider-b");
});

test("expired, stale, future-observed, and ineligible offers cannot win", async () => {
  const input = await offers();
  for (const changed of [
    { ...input[0]!, validUntil: SYNTHETIC_NOW },
    { ...input[0]!, observedAt: "2026-11-07T09:00:00Z" },
    { ...input[0]!, observedAt: "2026-11-09T10:01:00Z" },
    { ...input[0]!, eligible: false },
  ]) {
    const result = selectOffer(SYNTHETIC_PRODUCT, [changed, input[1]!], POLICY, SYNTHETIC_NOW);
    assert.equal(result.selected.providerId, "synthetic-provider-b");
    assert.equal(result.rejections.length, 1);
  }
});

test("product near-matches and unapproved mappings cannot be compared as the same benefit", async () => {
  const input = await offers();
  const mismatches: ProviderOffer[] = [
    { ...input[0]!, identity: { ...input[0]!.identity, brand: "ANOTHER_BRAND" } },
    { ...input[0]!, identity: { ...input[0]!.identity, faceValueMinor: 5_000n } },
    { ...input[0]!, identity: { ...input[0]!.identity, termsVersion: "different-restrictions" } },
    { ...input[0]!, identity: { ...input[0]!.identity, currency: "USD" } } as unknown as ProviderOffer,
    { ...input[0]!, mappingStatus: "REVIEW_REQUIRED" },
  ];
  for (const mismatch of mismatches) {
    const result = selectOffer(SYNTHETIC_PRODUCT, [mismatch, input[1]!], POLICY, SYNTHETIC_NOW);
    assert.equal(result.selected.providerId, "synthetic-provider-b");
  }
});

test("missing explicit tax and non-bigint financial policy inputs fail closed", async () => {
  const input = await offers();
  const { taxAmountMinor: _, ...missingTax } = POLICY;
  assert.throws(() => simulatePrice(SYNTHETIC_PRODUCT, input, missingTax as PricingPolicy, SYNTHETIC_NOW), /taxAmountMinor/);
  assert.throws(() => simulatePrice(SYNTHETIC_PRODUCT, input, { ...POLICY, serviceFeeMinor: 200 as unknown as bigint }, SYNTHETIC_NOW), /serviceFeeMinor/);
});

test("negative contribution and excess service fees block price publication", async () => {
  const input = await offers();
  assert.throws(() => simulatePrice(SYNTHETIC_PRODUCT, input, { ...POLICY, agentCommissionMinor: 1_000n }, SYNTHETIC_NOW), /below the approved minimum/);
  assert.throws(() => simulatePrice(SYNTHETIC_PRODUCT, input, { ...POLICY, serviceFeeMinor: 201n }, SYNTHETIC_NOW), /cap/);
});

test("an inconsistent discount cannot create a second commission benefit", async () => {
  const input = await offers();
  const inconsistent = { ...input[0]!, upfrontDiscountMinor: 600n };
  const result = selectOffer(SYNTHETIC_PRODUCT, [inconsistent, input[1]!], POLICY, SYNTHETIC_NOW);
  assert.equal(result.selected.providerId, "synthetic-provider-b");
  assert.match(result.rejections[0]!.reason, /discount/);
});

test("tax remains a pass-through while collection fees use the charged total", async () => {
  const result = simulatePrice(SYNTHETIC_PRODUCT, await offers(), { ...POLICY, taxAmountMinor: 100n }, SYNTHETIC_NOW);
  assert.equal(result.publicPrice.total_amount, "103.00");
  assert.equal(result.internalTrace.payment_fee, "1.75");
  assert.equal(result.internalTrace.expected_contribution, "2.75");
});

test("inputs are not mutated and returned financial views cannot be edited", async () => {
  const input = Object.freeze(await offers());
  const orderBefore = input.map((offer) => offer.providerId);
  const result = simulatePrice(SYNTHETIC_PRODUCT, input, POLICY, SYNTHETIC_NOW);
  assert.deepEqual(input.map((offer) => offer.providerId), orderBefore);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.publicPrice));
  assert.ok(Object.isFrozen(result.internalTrace));
  assert.ok(Object.isFrozen(result.internalTrace.rejected_offers));
  assert.throws(() => { (result.publicPrice as unknown as { total_amount: string }).total_amount = "1.00"; }, TypeError);
});

test("customer display excludes provider economics and remains explicitly non-executable", async () => {
  const result = simulatePrice(SYNTHETIC_PRODUCT, await offers(), POLICY, SYNTHETIC_NOW);
  const publicJson = JSON.stringify(result.publicPrice);
  for (const field of ["provider_id", "provider_debit", "expected_contribution", "agent_commission"]) {
    assert.equal(publicJson.includes(field), false);
  }
  assert.equal(result.publicPrice.status, "SIMULATION");
  assert.equal(result.publicPrice.executable, false);
});

test("exhausted valid offers and ambiguous duplicate offer identities fail closed", async () => {
  const input = await offers();
  assert.throws(() => selectOffer(SYNTHETIC_PRODUCT, input.map((offer) => ({ ...offer, available: false })), POLICY, SYNTHETIC_NOW), /No eligible/);
  assert.throws(() => selectOffer(SYNTHETIC_PRODUCT, [input[0]!, input[0]!], POLICY, SYNTHETIC_NOW), /Duplicate/);
});

test("impossible calendar dates cannot be normalized into accepted provider timestamps", async () => {
  const input = await offers();
  for (const now of ["2026-02-30T10:00:00Z", "2026-02-29T10:00:00Z", "1900-02-29T10:00:00Z", "2026-04-31T10:00:00Z"]) {
    assert.throws(() => selectOffer(SYNTHETIC_PRODUCT, input, POLICY, now), /real Gregorian calendar date/);
  }
  const result = selectOffer(SYNTHETIC_PRODUCT, [{ ...input[0]!, observedAt: "2026-02-30T09:00:00Z" }, input[1]!], POLICY, SYNTHETIC_NOW);
  assert.equal(result.selected.providerId, "synthetic-provider-b");
  assert.match(result.rejections[0]!.reason, /real Gregorian calendar date/);
});

test("timestamp bounds, clock time, timezone, and fractional precision are enforced", async () => {
  const input = await offers();
  for (const now of [
    "2026-11-09T10:00:00", "2026-11-09T24:00:00Z", "2026-11-09T10:00:60Z",
    "2026-11-09T10:00:00+14:01", "2026-11-09T10:00:00+24:00", "2026-11-09T10:00:00+04:60",
    "2026-11-09T10:00:00-00:00", "2026-11-09T10:00:00.1234Z", `${"0".repeat(10_000)}Z`,
  ]) {
    assert.throws(() => selectOffer(SYNTHETIC_PRODUCT, input, POLICY, now), TypeError);
  }
});

test("valid numeric offsets, optional milliseconds, and Gregorian leap days remain accepted", async () => {
  const input = await offers();
  assert.equal(selectOffer(SYNTHETIC_PRODUCT, input, POLICY, "2026-11-09T14:00:00.000+04:00").selected.providerId, "synthetic-provider-a");
  for (const year of [2000, 2024]) {
    const leapDayOffer = { ...input[0]!, observedAt: `${year}-02-29T09:00:00Z`, validUntil: `${year}-02-29T11:00:00Z` };
    assert.equal(selectOffer(SYNTHETIC_PRODUCT, [leapDayOffer], POLICY, `${year}-02-29T10:00:00Z`).selected.providerId, "synthetic-provider-a");
  }
});

test("equal-cost offer choice is independent of input order", async () => {
  const input = await offers();
  const a = input[0]!;
  const b = { ...a, providerId: "synthetic-provider-b", offerId: "equal-cost-b" };
  for (const candidates of [[a, b], [b, a]]) {
    assert.equal(selectOffer(SYNTHETIC_PRODUCT, candidates, POLICY, SYNTHETIC_NOW).selected.providerId, a.providerId);
  }
});

test("offer freshness accepts the exact age limit and rejects one millisecond beyond it", async () => {
  const [offer] = await offers();
  const observedAt = new Date(Date.parse(SYNTHETIC_NOW) - POLICY.maximumOfferAgeMs).toISOString();
  const boundary = { ...offer!, observedAt };
  assert.equal(selectOffer(SYNTHETIC_PRODUCT, [boundary], POLICY, SYNTHETIC_NOW).selected.offerId, offer!.offerId);
  assert.throws(() => selectOffer(SYNTHETIC_PRODUCT, [{ ...boundary,
    observedAt: new Date(Date.parse(observedAt) - 1).toISOString(),
  }], POLICY, SYNTHETIC_NOW), /No eligible/);
});

test("the minimum contribution is inclusive and one minor unit below is blocked", async () => {
  const input = await offers();
  assert.equal(simulatePrice(SYNTHETIC_PRODUCT, input, { ...POLICY, minimumContributionMinor: 277n }, SYNTHETIC_NOW)
    .internalTrace.expected_contribution, "2.77");
  assert.throws(() => simulatePrice(SYNTHETIC_PRODUCT, input, { ...POLICY, minimumContributionMinor: 278n }, SYNTHETIC_NOW),
    /below the approved minimum/);
});

test("fractional basis points and negative provider charges cannot enter financial arithmetic", async () => {
  const input = await offers();
  assert.throws(() => simulatePrice(SYNTHETIC_PRODUCT, input, { ...POLICY, paymentFeeBasisPoints: 150.5 }, SYNTHETIC_NOW),
    /basisPoints/);
  const result = selectOffer(SYNTHETIC_PRODUCT, [{ ...input[0]!, additionalProviderFeeMinor: -1n }, input[1]!], POLICY, SYNTHETIC_NOW);
  assert.equal(result.selected.providerId, "synthetic-provider-b");
  assert.match(result.rejections[0]!.reason, /additionalProviderFeeMinor/);
});
