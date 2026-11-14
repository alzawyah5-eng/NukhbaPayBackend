import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {attestVerifiedStaffIdentity} from "../src/identity/verified-staff-identity.js";
import {prepareSyntheticPriceSubmission,consumeSubmissionEvidence,submissionDigest,PUBLICATION_PERMISSION_CONTRACTS} from "../src/catalog/submission-evidence.js";
import {SYNTHETIC_NOW,SYNTHETIC_PRODUCT,createSyntheticProviders} from "../../provider-adapters/src/index.js";

test("submission evidence binds verified creator, complete canonical inputs and tenant without activating permissions",async()=>{
 const tenantId=randomUUID(),staffId=randomUUID(),membershipId=randomUUID(),now=()=>new Date(SYNTHETIC_NOW);
 const identity=attestVerifiedStaffIdentity({issuer:"https://staff.invalid/",subject:"staff-subject",security:{audience:"test",clientId:"test",profile:"rfc9068-staff-v1",principalKind:"human",
 issuedAt:now().getTime()/1000-60,expiresAt:now().getTime()/1000+3600,assurance:"not-established"}});
 let permitted=true,failAudit=false,crossTenant=false;
 const deps={capability:"ISOLATED_SYNTHETIC_SUBMISSION_ONLY" as const,now,repository:{
 findByTrustedIdentity:async()=>({staffId,staffStatus:"ACTIVE" as const,identityStatus:"ACTIVE" as const,authzVersion:1n,tokensValidAfter:null}),
 findPlatformRoleGrants:async()=>[],findTenantMembership:async()=>({membershipId,tenantId:crossTenant?randomUUID():tenantId,status:"ACTIVE" as const,version:1n,
 roleGrants:permitted?[{roleCode:"PRICING_EDITOR",scope:"TENANT" as const,grantedAt:"2026-01-01T00:00:00Z",expiresAt:null,revokedAt:null}]:[]})},
 auditWriter:{appendSecurityAuditEvents:async()=>{if(failAudit)throw new Error("audit unavailable");}}};
 const offers=(await Promise.all(createSyntheticProviders().map(p=>p.fetchCatalog()))).flat().map(o=>({...o,snapshotId:randomUUID()}));
 const request={tenantId,productId:randomUUID(),product:SYNTHETIC_PRODUCT,offers,sourceSnapshots:offers.map((o,i)=>({snapshotId:o.snapshotId,providerAccountId:randomUUID(),snapshotKey:`s${i}`,
 sourceVersion:"v1",observedAt:o.observedAt,completedAt:o.observedAt,status:"COMPLETE" as const})),evaluatedAt:SYNTHETIC_NOW,expectedPreviousVersion:0,idempotencyKey:randomUUID(),
 pricingPolicy:{version:"v1",serviceFeeMinor:200n,maximumServiceFeeMinor:200n,taxAmountMinor:0n,paymentFeeBasisPoints:150,paymentFixedFeeMinor:20n,agentCommissionMinor:50n,minimumContributionMinor:100n,maximumOfferAgeMs:86400000}};
 await assert.rejects(()=>prepareSyntheticPriceSubmission(deps,{...identity},request),/denied/);
 permitted=false;await assert.rejects(()=>prepareSyntheticPriceSubmission(deps,identity,request),/denied/);permitted=true;
 crossTenant=true;await assert.rejects(()=>prepareSyntheticPriceSubmission(deps,identity,request),/denied/);crossTenant=false;
 failAudit=true;await assert.rejects(()=>prepareSyntheticPriceSubmission(deps,identity,request),/audit unavailable/);failAudit=false;
 await assert.rejects(()=>prepareSyntheticPriceSubmission(deps,identity,{...request,sourceSnapshots:[]}),/snapshots/);
 await assert.rejects(()=>prepareSyntheticPriceSubmission(deps,identity,{...request,creatorStaffId:randomUUID()} as typeof request),/denied/);
 await assert.rejects(()=>prepareSyntheticPriceSubmission(deps,identity,{...request,offers:request.offers.map((o,i)=>i===0?{...o,identity:{...o.identity,termsVersion:"forged"}}:o)}),/identity evidence mismatch/);
 const proof=await prepareSyntheticPriceSubmission(deps,identity,request);
 assert.equal(proof.creatorStaffId,staffId);assert.equal(submissionDigest(proof.canonicalPayload),proof.candidate.candidateDigest);
 const canonical=JSON.parse(proof.canonicalPayload) as unknown[];
 assert.equal(canonical[0],"NUKHBAPAY_CATALOGUE_PUBLICATION_CANDIDATE_V1");assert.equal(canonical.length,16);
 assert.notEqual(submissionDigest(proof.canonicalPayload+" "),proof.candidate.candidateDigest);
 assert.throws(()=>consumeSubmissionEvidence({...proof}),/Untrusted/);
 assert.equal(consumeSubmissionEvidence(proof),proof);assert.throws(()=>consumeSubmissionEvidence(proof),/Untrusted/);
 assert.ok(Object.isFrozen(proof));assert.equal(proof.acceptedApproval,false);assert.equal(proof.execution,"NOT_AUTHORIZED");
 assert.ok(Object.values(PUBLICATION_PERMISSION_CONTRACTS).every(p=>!p.active&&p.scope==="TENANT"));
});
