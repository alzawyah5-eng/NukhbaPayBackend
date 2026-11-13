import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { SYNTHETIC_NOW, SYNTHETIC_PRODUCT, createSyntheticProviders } from "../../provider-adapters/src/index.js";
import type { PricingPolicy } from "../../domain/src/index.js";
import type { ProviderOffer } from "../../provider-contracts/src/index.js";
import { classifyAdvisoryPublicationEvidence, generateDraftPublicationCandidate } from "../src/catalog/publication-candidate.js";
import type { DraftPublicationRequest, PublicationSourceSnapshot } from "../src/catalog/publication-candidate.js";

const POLICY:PricingPolicy=Object.freeze({version:"publication-policy-v1",serviceFeeMinor:200n,maximumServiceFeeMinor:200n,
  taxAmountMinor:0n,paymentFeeBasisPoints:150,paymentFixedFeeMinor:20n,agentCommissionMinor:50n,
  minimumContributionMinor:100n,maximumOfferAgeMs:24*60*60*1000});
const tenant=randomUUID(),productId=randomUUID(),snapshotIds=[randomUUID(),randomUUID(),randomUUID()];

async function fixture(overrides:Partial<DraftPublicationRequest>={}):Promise<DraftPublicationRequest>{
  const fetched=(await Promise.all(createSyntheticProviders().map(provider=>provider.fetchCatalog()))).flat();
  const offers=fetched.map((offer,index)=>Object.freeze({...offer,snapshotId:snapshotIds[index]!})) as readonly ProviderOffer[];
  const sources=snapshotIds.map((snapshotId,index)=>Object.freeze({snapshotId,providerAccountId:randomUUID(),
    snapshotKey:`synthetic-snapshot-${index+1}`,sourceVersion:"synthetic-v1",observedAt:"2026-11-09T09:00:00Z",
    completedAt:"2026-11-09T09:05:00Z",status:"COMPLETE" as const}));
  return {tenantId:tenant,productId,product:SYNTHETIC_PRODUCT,sourceSnapshots:sources,offers,pricingPolicy:POLICY,
    evaluatedAt:SYNTHETIC_NOW,expectedPreviousVersion:0,idempotencyKey:randomUUID(),...overrides};
}

test("draft candidate is deterministic, immutable, versioned and explicitly non-authorized",async()=>{
  const request=await fixture(),first=generateDraftPublicationCandidate(request);
  const reordered={...request,sourceSnapshots:[...request.sourceSnapshots].reverse(),offers:[...request.offers].reverse()};
  const second=generateDraftPublicationCandidate(reordered);
  assert.equal(first.candidateDigest,second.candidateDigest);assert.equal(first.operationId,second.operationId);
  assert.equal(first.priceVersion,1);assert.equal(first.status,"DRAFT");assert.equal(first.execution,"NOT_AUTHORIZED");
  assert.equal(first.activationAllowed,false);assert.equal(first.currency,"AED");assert.equal(first.totalAmountMinor,10_200n);
  assert.equal(first.expectedContributionMinor,277n);assert.equal(first.sourceSnapshots.length,3);
  assert.equal(first.audit.eventName,"CATALOGUE_PUBLICATION_CANDIDATE_CREATED");
  assert.ok(Object.isFrozen(first));assert.ok(Object.isFrozen(first.sourceSnapshots));assert.ok(Object.isFrozen(first.audit));
  assert.throws(()=>{(first as unknown as {status:string}).status="PUBLISHED";},TypeError);
});

test("AI evidence is advisory-only and has no candidate input or authority",async()=>{
  const evidence=classifyAdvisoryPublicationEvidence("synthetic-model-observation",createHash("sha256").update("suggestion").digest("hex"));
  assert.deepEqual(evidence,{reference:"synthetic-model-observation",suggestionDigest:createHash("sha256").update("suggestion").digest("hex"),
    classification:"ADVISORY_ONLY",canAuthorize:false,canChangeArithmetic:false,canOverridePolicy:false});
  assert.equal("advisoryEvidence" in generateDraftPublicationCandidate(await fixture()),false);
  assert.throws(()=>classifyAdvisoryPublicationEvidence("model", "not-a-digest"),/suggestionDigest/);
});

test("currency, contribution, policy cap and version inputs fail closed",async()=>{
  const request=await fixture();
  assert.throws(()=>generateDraftPublicationCandidate({...request,product:{...request.product,currency:"USD"} as unknown as typeof request.product}),/currency/);
  assert.throws(()=>generateDraftPublicationCandidate({...request,pricingPolicy:{...POLICY,agentCommissionMinor:1_000n}}),/below the approved minimum/);
  assert.throws(()=>generateDraftPublicationCandidate({...request,pricingPolicy:{...POLICY,serviceFeeMinor:201n}}),/cap/);
  assert.throws(()=>generateDraftPublicationCandidate({...request,expectedPreviousVersion:-1}),/expectedPreviousVersion/);
});

test("half-up pricing boundary is inherited from the exact domain calculation",async()=>{
  const request=await fixture({pricingPolicy:{...POLICY,serviceFeeMinor:0n,maximumServiceFeeMinor:0n,
    paymentFeeBasisPoints:50,paymentFixedFeeMinor:0n,agentCommissionMinor:0n,minimumContributionMinor:0n}});
  const candidate=generateDraftPublicationCandidate(request);
  assert.equal(candidate.totalAmountMinor,10_000n);assert.equal(candidate.paymentFeeMinor,50n);
  assert.equal(candidate.roundingPolicy,"AED_MINOR_UNIT_HALF_UP_NONNEGATIVE");
});

test("stale, incomplete, duplicated or unreferenced source evidence is rejected",async()=>{
  const request=await fixture(),first=request.sourceSnapshots[0]!;
  const stale:PublicationSourceSnapshot={...first,observedAt:"2026-11-07T09:00:00Z"};
  assert.throws(()=>generateDraftPublicationCandidate({...request,sourceSnapshots:[stale,...request.sourceSnapshots.slice(1)]}),/stale/);
  assert.throws(()=>generateDraftPublicationCandidate({...request,sourceSnapshots:[first,first,...request.sourceSnapshots.slice(1)]}),/Duplicate/);
  assert.throws(()=>generateDraftPublicationCandidate({...request,sourceSnapshots:request.sourceSnapshots.slice(0,2)}),/exactly/);
  assert.throws(()=>generateDraftPublicationCandidate({...request,sourceSnapshots:[{...first,status:"IN_PROGRESS" as "COMPLETE"},...request.sourceSnapshots.slice(1)]}),/complete/);
});

test("tenant scope and changed payloads produce distinct stable identities",async()=>{
  const request=await fixture(),first=generateDraftPublicationCandidate(request);
  const otherTenant=generateDraftPublicationCandidate({...request,tenantId:randomUUID()});
  const changedPolicy=generateDraftPublicationCandidate({...request,pricingPolicy:{...POLICY,version:"publication-policy-v2"}});
  assert.notEqual(first.candidateDigest,otherTenant.candidateDigest);assert.notEqual(first.operationId,otherTenant.operationId);
  assert.notEqual(first.candidateDigest,changedPolicy.candidateDigest);assert.notEqual(first.operationId,changedPolicy.operationId);
});

test("concurrent pure generation converges without shared mutable state",async()=>{
  const request=await fixture(),results=await Promise.all(Array.from({length:12},async()=>generateDraftPublicationCandidate(request)));
  assert.equal(new Set(results.map(result=>result.candidateId)).size,1);
  assert.ok(results.every(result=>result.execution==="NOT_AUTHORIZED"&&result.activationAllowed===false));
});
