import { createHash } from "node:crypto";
import { parseAed, pricingInstantMs, simulatePrice } from "../../../domain/src/index.js";
import type { PricingPolicy } from "../../../domain/src/index.js";
import type { ProductIdentity, ProviderOffer } from "../../../provider-contracts/src/index.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const TEXT = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const generatedCandidates = new WeakSet<object>();
const canonicalEvidence = new WeakMap<object, string>();
/** Only a generated object can reveal its original canonical hashing bytes. */
export function generatedCandidateCanonicalEvidence(value: unknown): string {
  assertGeneratedDraftPublicationCandidate(value);
  return canonicalEvidence.get(value as object)!;
}

export interface PublicationSourceSnapshot {
  readonly snapshotId: string;
  readonly providerAccountId: string;
  readonly snapshotKey: string;
  readonly sourceVersion: string;
  readonly observedAt: string;
  readonly completedAt: string;
  readonly status: "COMPLETE";
}

export interface DraftPublicationRequest {
  readonly tenantId: string;
  readonly productId: string;
  readonly product: ProductIdentity;
  readonly sourceSnapshots: readonly PublicationSourceSnapshot[];
  readonly offers: readonly ProviderOffer[];
  readonly pricingPolicy: PricingPolicy;
  readonly evaluatedAt: string;
  readonly expectedPreviousVersion: number;
  readonly idempotencyKey: string;
}

export interface DraftPublicationCandidate {
  readonly candidateId: string;
  readonly operationId: string;
  readonly candidateDigest: string;
  readonly tenantId: string;
  readonly productId: string;
  readonly canonicalProductId: string;
  readonly priceVersion: number;
  readonly expectedPreviousVersion: number;
  readonly currency: "AED";
  readonly baseAmountMinor: bigint;
  readonly serviceFeeMinor: bigint;
  readonly taxAmountMinor: bigint;
  readonly totalAmountMinor: bigint;
  readonly providerCostMinor: bigint;
  readonly paymentFeeMinor: bigint;
  readonly agentCommissionMinor: bigint;
  readonly expectedContributionMinor: bigint;
  readonly pricingPolicyVersion: string;
  readonly roundingPolicy: "AED_MINOR_UNIT_HALF_UP_NONNEGATIVE";
  readonly selectedProviderId: string;
  readonly selectedOfferId: string;
  readonly selectedSnapshotId: string;
  readonly sourceSnapshots: readonly PublicationSourceSnapshot[];
  readonly evaluatedAt: string;
  readonly validUntil: string;
  readonly idempotencyKey: string;
  readonly status: "DRAFT";
  readonly execution: "NOT_AUTHORIZED";
  readonly activationAllowed: false;
  readonly audit: Readonly<{
    eventName: "CATALOGUE_PUBLICATION_CANDIDATE_CREATED";
    candidateId: string;
    operationId: string;
    tenantId: string;
    productId: string;
    priceVersion: number;
    candidateDigest: string;
    execution: "NOT_AUTHORIZED";
  }>;
}

export interface AdvisoryPublicationEvidence {
  readonly reference: string;
  readonly suggestionDigest: string;
  readonly classification: "ADVISORY_ONLY";
  readonly canAuthorize: false;
  readonly canChangeArithmetic: false;
  readonly canOverridePolicy: false;
}

function requiredUuid(value: string, name: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`${name} must be a UUID`);
  return value.toLowerCase();
}

function requiredText(value: string, name: string): string {
  if (typeof value !== "string" || !TEXT.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function financialPolicyRecord(policy: PricingPolicy): readonly unknown[] {
  return Object.freeze([
    requiredText(policy.version, "pricingPolicy.version"),
    policy.serviceFeeMinor.toString(), policy.maximumServiceFeeMinor.toString(), policy.taxAmountMinor.toString(),
    policy.paymentFeeBasisPoints, policy.paymentFixedFeeMinor.toString(), policy.agentCommissionMinor.toString(),
    policy.minimumContributionMinor.toString(), policy.maximumOfferAgeMs,
  ]);
}

/** AI/model output is recorded separately and has no path into candidate arithmetic or authority. */
export function classifyAdvisoryPublicationEvidence(reference: string, suggestionDigest: string): AdvisoryPublicationEvidence {
  requiredText(reference, "reference");
  if (typeof suggestionDigest !== "string" || !DIGEST.test(suggestionDigest)) throw new TypeError("suggestionDigest is invalid");
  return Object.freeze({reference,suggestionDigest,classification:"ADVISORY_ONLY",canAuthorize:false,canChangeArithmetic:false,canOverridePolicy:false});
}

/** Trusted-code bridge for persistence; structural/JSON clones are rejected. */
export function assertGeneratedDraftPublicationCandidate(value: unknown): DraftPublicationCandidate {
  if(typeof value!=="object"||value===null||!generatedCandidates.has(value))throw new TypeError("Untrusted publication candidate");
  return value as DraftPublicationCandidate;
}

/** Pure, deterministic draft construction. It neither authorizes nor publishes a price. */
export function generateDraftPublicationCandidate(request: DraftPublicationRequest): DraftPublicationCandidate {
  const tenantId=requiredUuid(request.tenantId,"tenantId"),productId=requiredUuid(request.productId,"productId");
  const idempotencyKey=requiredUuid(request.idempotencyKey,"idempotencyKey");
  if(!Number.isSafeInteger(request.expectedPreviousVersion)||request.expectedPreviousVersion<0)
    throw new TypeError("expectedPreviousVersion must be a nonnegative safe integer");
  const priceVersion=request.expectedPreviousVersion+1;
  if(!Number.isSafeInteger(priceVersion))throw new RangeError("priceVersion exceeds the safe integer range");
  if(request.product.currency!=="AED")throw new TypeError("Publication currency must be AED");
  const evaluatedMs=pricingInstantMs(request.evaluatedAt,"evaluatedAt");
  if(request.sourceSnapshots.length===0||request.sourceSnapshots.length>32)
    throw new TypeError("Between one and 32 complete source snapshots is required");

  const sources=[...request.sourceSnapshots].map(source=>{
    const snapshotId=requiredUuid(source.snapshotId,"source snapshotId");
    const providerAccountId=requiredUuid(source.providerAccountId,"source providerAccountId");
    if(source.status!=="COMPLETE")throw new TypeError("Only complete source snapshots may be published");
    const observedMs=pricingInstantMs(source.observedAt,"source observedAt");
    const completedMs=pricingInstantMs(source.completedAt,"source completedAt");
    if(observedMs>completedMs||completedMs>evaluatedMs)throw new TypeError("Source snapshot chronology is invalid");
    if(evaluatedMs-observedMs>request.pricingPolicy.maximumOfferAgeMs)throw new RangeError("Source snapshot is stale");
    return Object.freeze({snapshotId,providerAccountId,snapshotKey:requiredText(source.snapshotKey,"snapshotKey"),
      sourceVersion:requiredText(source.sourceVersion,"sourceVersion"),observedAt:source.observedAt,completedAt:source.completedAt,status:"COMPLETE" as const});
  }).sort((a,b)=>a.snapshotId.localeCompare(b.snapshotId));
  if(new Set(sources.map(source=>source.snapshotId)).size!==sources.length)throw new Error("Duplicate source snapshot");

  const offers=[...request.offers].map(offer=>Object.freeze({...offer,identity:Object.freeze({...offer.identity})}))
    .sort((a,b)=>`${a.providerId}\u0000${a.offerId}`.localeCompare(`${b.providerId}\u0000${b.offerId}`));
  const offerSnapshotIds=new Set(offers.map(offer=>offer.snapshotId));
  const sourceIds=new Set(sources.map(source=>source.snapshotId));
  if(offers.length===0||offerSnapshotIds.size!==sourceIds.size||[...offerSnapshotIds].some(id=>!sourceIds.has(id)))
    throw new Error("Offers must reference exactly the declared source snapshots");

  const simulation=simulatePrice(request.product,offers,request.pricingPolicy,request.evaluatedAt);
  if(!sourceIds.has(simulation.internalTrace.provider_snapshot_id))throw new Error("Selected offer lacks source snapshot evidence");
  const canonical=["NUKHBAPAY_CATALOGUE_PUBLICATION_CANDIDATE_V1",tenantId,productId,request.product.canonicalProductId,
    request.product.brand,request.product.redemptionCountry,request.product.currency,request.product.faceValueMinor.toString(),
    request.product.fulfillmentMethod,request.product.termsVersion,request.expectedPreviousVersion,priceVersion,
    financialPolicyRecord(request.pricingPolicy),request.evaluatedAt,
    sources.map(source=>[source.snapshotId,source.providerAccountId,source.snapshotKey,source.sourceVersion,source.observedAt,source.completedAt]),
    offers.map(offer=>[offer.providerId,offer.offerId,offer.snapshotId,offer.providerDebitMinor.toString(),offer.upfrontDiscountMinor.toString(),
      offer.additionalProviderFeeMinor.toString(),offer.available,offer.eligible,offer.observedAt,offer.validUntil,offer.mappingStatus])];
  const candidateDigest=digest(canonical),candidateId=candidateDigest;
  const operationId=digest(["NUKHBAPAY_CATALOGUE_PUBLICATION_OPERATION_V1",tenantId,productId,idempotencyKey,candidateDigest]);
  const candidate={candidateId,operationId,candidateDigest,tenantId,productId,canonicalProductId:request.product.canonicalProductId,
    priceVersion,expectedPreviousVersion:request.expectedPreviousVersion,currency:"AED" as const,
    baseAmountMinor:parseAed(simulation.publicPrice.base_amount),serviceFeeMinor:parseAed(simulation.publicPrice.service_fee),
    taxAmountMinor:parseAed(simulation.publicPrice.tax_amount),totalAmountMinor:parseAed(simulation.publicPrice.total_amount),
    providerCostMinor:parseAed(simulation.internalTrace.effective_provider_cost),paymentFeeMinor:parseAed(simulation.internalTrace.payment_fee),
    agentCommissionMinor:parseAed(simulation.internalTrace.agent_commission),expectedContributionMinor:parseAed(simulation.internalTrace.expected_contribution),
    pricingPolicyVersion:request.pricingPolicy.version,roundingPolicy:"AED_MINOR_UNIT_HALF_UP_NONNEGATIVE" as const,
    selectedProviderId:simulation.internalTrace.provider_id,selectedOfferId:simulation.internalTrace.offer_id,
    selectedSnapshotId:simulation.internalTrace.provider_snapshot_id,sourceSnapshots:Object.freeze(sources),evaluatedAt:request.evaluatedAt,
    validUntil:simulation.internalTrace.valid_until,idempotencyKey,status:"DRAFT" as const,execution:"NOT_AUTHORIZED" as const,
    activationAllowed:false as const};
  const audit=Object.freeze({eventName:"CATALOGUE_PUBLICATION_CANDIDATE_CREATED" as const,candidateId,operationId,tenantId,productId,
    priceVersion,candidateDigest,execution:"NOT_AUTHORIZED" as const});
  const result=Object.freeze({...candidate,audit});
  generatedCandidates.add(result);
  canonicalEvidence.set(result, JSON.stringify(canonical));
  return result;
}
