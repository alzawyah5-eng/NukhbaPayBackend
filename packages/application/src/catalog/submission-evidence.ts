import { createHash } from "node:crypto";
import { generateDraftPublicationCandidate, generatedCandidateCanonicalEvidence } from "./publication-candidate.js";
import type { DraftPublicationCandidate, DraftPublicationRequest } from "./publication-candidate.js";
import { isVerifiedStaffIdentity } from "../identity/verified-staff-identity.js";
import type { VerifiedStaffIdentity } from "../identity/verified-staff-identity.js";
import { rolePermissionCodes, resolveStaffTenantContext } from "../identity/staff-access.js";
import type { StaffAuthorizationRepository } from "../identity/staff-access.js";
import type { SecurityAuditWriter } from "../identity/security-audit.js";
import { recordSecurityAuditEvents } from "../identity/security-audit.js";

/** Reserved contracts only: no permission is activated by this module. */
export const PUBLICATION_PERMISSION_CONTRACTS = Object.freeze({
  submission: Object.freeze({permission:"pricing.submit",role:"PRICING_EDITOR",scope:"TENANT",active:false}),
  approval: Object.freeze({permission:"pricing.approve",role:"PRICING_APPROVER",scope:"TENANT",active:false,distinctCreator:true}),
  activation: Object.freeze({permission:"pricing.activate",role:"PUBLICATION_OPERATOR",scope:"TENANT",active:false,distinctCreator:true,distinctApprover:true}),
  rollback: Object.freeze({permission:"publication.rollback",role:"PUBLICATION_OPERATOR",scope:"TENANT",active:false,reasonRequired:true}),
  read: Object.freeze({permission:"catalog.published.read",scope:"TENANT",active:false,separateApplicationAndKioskClients:true}),
});
export const SUBMISSION_CANONICALIZATION = "BRICK4A_ORDERED_ARRAY_JSON_V1";
export const submissionDigest = (bytes:string):string => createHash("sha256").update(bytes,"utf8").digest("hex");
export interface SubmissionEvidence {
  readonly candidate: DraftPublicationCandidate;
  readonly canonicalPayload:string;
  readonly algorithm:"SHA-256";
  readonly canonicalization:typeof SUBMISSION_CANONICALIZATION;
  readonly creatorStaffId:string;
  readonly issuer:string;
  readonly subject:string;
  readonly tenantId:string;
  readonly authzVersion:string;
  readonly membershipVersion:string;
  readonly submittedAt:string;
  readonly provenance:"VERIFIED_SYNTHETIC_STAFF_SUBMISSION_V1";
  readonly execution:"NOT_AUTHORIZED";
  readonly acceptedApproval:false;
  revalidate():Promise<boolean>;
}
const tickets = new WeakSet<object>();
export function consumeSubmissionEvidence(value:unknown):SubmissionEvidence {
  if(typeof value!=="object"||value===null||!tickets.has(value))throw new Error("Untrusted submission evidence");
  tickets.delete(value); return value as SubmissionEvidence;
}
/** DI is trusted composition. This port cannot accept real issuers or activate permissions. */
export async function prepareSyntheticPriceSubmission(deps:{
  repository:StaffAuthorizationRepository; auditWriter:SecurityAuditWriter; now:()=>Date;
  capability:"ISOLATED_SYNTHETIC_SUBMISSION_ONLY";
}, identity:VerifiedStaffIdentity, request:DraftPublicationRequest):Promise<SubmissionEvidence> {
  if(deps.capability!=="ISOLATED_SYNTHETIC_SUBMISSION_ONLY"||!isVerifiedStaffIdentity(identity)||
    !new URL(identity.issuer).hostname.endsWith(".invalid"))throw new Error("Submission denied");
  if(["creatorStaffId","creatorId","creator","submittedAt","provenance"].some(k=>Object.hasOwn(request,k)))throw new Error("Submission denied");
  // 4A hashes the product identity once, rather than each offer identity.
  // Evidenced submissions must therefore require every offer to have that exact identity.
  const identityFields=["canonicalProductId","brand","redemptionCountry","currency","faceValueMinor","fulfillmentMethod","termsVersion"] as const;
  if(request.offers.some(o=>identityFields.some(k=>o.identity[k]!==request.product[k])))throw new Error("Offer identity evidence mismatch");
  // Copy financial inputs synchronously before any repository or audit await.
  const candidate=generateDraftPublicationCandidate(request),canonicalPayload=generatedCandidateCanonicalEvidence(candidate);
  const tenantId=candidate.tenantId;
  const resolve=async()=>{
    const now=deps.now().getTime();
    if(!Number.isFinite(now)||now>=identity.security.expiresAt*1000||now<identity.security.issuedAt*1000||
      identity.security.principalKind!=="human"||identity.security.profile!=="rfc9068-staff-v1")throw new Error("Submission denied");
    const c=await resolveStaffTenantContext(deps.repository,identity,tenantId);
    const m=c.membership,p=c.principal;
    if(!p||p.staffStatus!=="ACTIVE"||p.identityStatus!=="ACTIVE"||!m||m.status!=="ACTIVE"||m.tenantId!==tenantId||
      !/^[0-9a-f-]{36}$/.test(p.staffId))throw new Error("Submission denied");
    const checkedAt=deps.now().getTime();
    if(!Number.isFinite(checkedAt)||checkedAt<now||checkedAt>=identity.security.expiresAt*1000)throw new Error("Submission denied");
    const assigned=m.roleGrants.filter(g=>g.revokedAt===null);
    if(assigned.some(g=>g.scope!=="TENANT"||rolePermissionCodes(g.roleCode)===null||g.roleCode==="PRICING_APPROVER")||!assigned.some(g=>g.roleCode==="PRICING_EDITOR"&&
      Date.parse(g.grantedAt)<=now&&(g.expiresAt===null||Date.parse(g.expiresAt)>checkedAt)))throw new Error("Submission denied");
    return c;
  };
  const context=await resolve(),stamp=JSON.stringify(context,(_,v:unknown)=>typeof v==="bigint"?v.toString():v);
  const submittedAt=deps.now().toISOString(),deadline=Math.min(Date.parse(submittedAt)+5000,identity.security.expiresAt*1000);
  const revalidate=async()=>{
    try {
      if(!(deps.now().getTime()<deadline))return false;
      const current=await resolve(),checkedAt=deps.now().getTime();
      return checkedAt>=Date.parse(submittedAt)&&checkedAt<deadline&&JSON.stringify(current,(_,v:unknown)=>typeof v==="bigint"?v.toString():v)===stamp;
    } catch {return false;}
  };
  await recordSecurityAuditEvents(deps.auditWriter,[{occurredAt:submittedAt,actorStaffId:context.principal!.staffId,tenantId,
    action:"AUTHORIZATION_DECISION",outcome:"SUCCESS",targetType:"AUTHORIZATION",targetId:null,requestId:null,reasonCode:"NONE"}]);
  if(!await revalidate())throw new Error("Submission denied");
  const evidence:SubmissionEvidence=Object.freeze({candidate,canonicalPayload,algorithm:"SHA-256",canonicalization:SUBMISSION_CANONICALIZATION,
    creatorStaffId:context.principal!.staffId,issuer:identity.issuer,subject:identity.subject,tenantId,
    authzVersion:context.principal!.authzVersion.toString(),membershipVersion:context.membership!.version.toString(),submittedAt,
    provenance:"VERIFIED_SYNTHETIC_STAFF_SUBMISSION_V1",execution:"NOT_AUTHORIZED",acceptedApproval:false,revalidate});
  tickets.add(evidence);return evidence;
}
