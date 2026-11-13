import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {test} from "node:test";
import {normalizeApprovalIntake,safeApprovalIntakeResult,failedApprovalIntake,eligibleApprovalIntake,type StaffApprovalIntakeCommand} from "../src/identity/staff-approval-intake.js";
import {canonicalDigest,staffRequestResult} from "../src/identity/durable-staff-request.js";
import type {StaffAuthorizationContext,StaffRoleGrant} from "../src/identity/staff-access.js";

const command=():StaffApprovalIntakeCommand=>({kind:"ATTEMPT",key:randomUUID(),id:randomUUID(),version:1n,requestDigest:"a".repeat(64),policyVersion:"staff-lifecycle-v1"});
test("approval intake accepts only a copied fixed command and rejects authority fields without invoking accessors",()=>{
  const input=command(),normalized=normalizeApprovalIntake(input);assert.deepEqual(normalized,input);assert.notEqual(normalized,input);assert.equal(Object.isFrozen(normalized),true);
  for(const extra of [{mfa:true},{approved:true},{actorStaffId:randomUUID()},{tenantId:randomUUID()},{receipt:{outcome:"SIMULATION_RECORDED"}},{assurance:"strong"}])assert.throws(()=>normalizeApprovalIntake({...input,...extra}));
  let invoked=false;const getter={...input};Object.defineProperty(getter,"requestDigest",{get:()=>{invoked=true;return input.requestDigest;}});assert.throws(()=>normalizeApprovalIntake(getter));assert.equal(invoked,false);
  assert.throws(()=>normalizeApprovalIntake(Object.assign(Object.create({mfa:true}),input)));
});
test("approval intake validates exact policy identity version digest and command kind",()=>{
  const input=command();for(const change of [{kind:"ACCEPT"},{kind:"APPLY"},{version:0n},{version:1000001n},{version:1},{id:"invalid"},{key:"invalid"},{requestDigest:"x".repeat(64)},{policyVersion:"unapproved"}])
    assert.throws(()=>normalizeApprovalIntake({...input,...change} as StaffApprovalIntakeCommand));
  assert.equal(normalizeApprovalIntake({...input,kind:"RECONCILE"}).kind,"RECONCILE");
});
test("approval intake result cannot promote receipts and uncertain outcomes never disclose a partial receipt",()=>{
  const input=command(),staff=randomUUID(),fields={requestId:input.id,version:"1",requestDigest:input.requestDigest,operationId:canonicalDigest(["staff-request-operation-v1",staff,input.key])};
  const result=safeApprovalIntakeResult(staffRequestResult("RECORDED",fields),input,staff);assert.equal(result.kind,"RECORDED");assert.equal(result.acceptedApproval,false);assert.equal(result.privilegedApproval,"BLOCKED");assert.equal(Object.isFrozen(result),true);
  for(const change of [{requestId:randomUUID()},{version:"2"},{requestDigest:"b".repeat(64)},{operationId:"b".repeat(64)},{acceptedApproval:true},{execution:"AUTHORIZED"}])
    assert.deepEqual(safeApprovalIntakeResult({...staffRequestResult("RECORDED",fields),...change} as never,input,staff),failedApprovalIntake("UNRESOLVED"));
  for(const kind of ["DENIED","CONFLICT","UNRESOLVED"] as const){const value=safeApprovalIntakeResult({...staffRequestResult(kind,fields),reason:"private-diagnostic"},input,staff);assert.equal("operationId" in value,false);assert.equal("requestDigest" in value,false);assert.doesNotMatch(JSON.stringify(value),/private-diagnostic/);}
});
test("approval intake role eligibility keeps active scope separation conflict and expiry rules without activating permissions",()=>{
  const now=Date.parse("2026-11-12T08:00:00Z"),staff=randomUUID(),tenant=randomUUID();
  const grant=(roleCode:string,scope:"PLATFORM"|"TENANT"="PLATFORM"):StaffRoleGrant=>({roleCode,scope,grantedAt:"2025-01-01T00:00:00Z",expiresAt:null,revokedAt:null});
  const context:StaffAuthorizationContext={principal:{staffId:staff,staffStatus:"ACTIVE",identityStatus:"ACTIVE",tokensValidAfter: null, authzVersion:0n},membership:null,platformRoleGrants:[grant("SECURITY_ADMIN")]};
  assert.equal(eligibleApprovalIntake(context,now),true);assert.equal(eligibleApprovalIntake({...context,platformRoleGrants:[]},now),false);
  assert.equal(eligibleApprovalIntake({...context,platformRoleGrants:[grant("SECURITY_ADMIN"),grant("ACCESS_ADMIN")]},now),false);
  assert.equal(eligibleApprovalIntake({...context,platformRoleGrants:[{...grant("SECURITY_ADMIN"),expiresAt:new Date(now).toISOString()}]},now),false);
  const membership={membershipId:randomUUID(),tenantId:tenant,status:"ACTIVE" as const,version:1n,roleGrants:[] as StaffRoleGrant[]};
  assert.equal(eligibleApprovalIntake({...context,membership},now),false);
  assert.equal(eligibleApprovalIntake({...context,membership:{...membership,roleGrants:[grant("TENANT_ADMIN","TENANT")]}},now),true);
});
