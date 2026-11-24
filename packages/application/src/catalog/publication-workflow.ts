import { createHash } from "node:crypto";
import { generateDraftPublicationCandidate, generatedCandidateCanonicalEvidence } from "./publication-candidate.js";
import type { DraftPublicationRequest } from "./publication-candidate.js";
import { isVerifiedStaffIdentity } from "../identity/verified-staff-identity.js";
import type { VerifiedStaffIdentity } from "../identity/verified-staff-identity.js";
import { findRoleDefinition } from "../identity/permission-catalog.js";
import { resolveStaffTenantContext } from "../identity/staff-access.js";
import type { StaffAuthorizationContext, StaffAuthorizationRepository } from "../identity/staff-access.js";
import { recordSecurityAuditEvents } from "../identity/security-audit.js";
import type { SecurityAuditWriter } from "../identity/security-audit.js";

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hex=/^[0-9a-f]{64}$/;
export type PublicationAction="APPROVE"|"ACTIVATE"|"ROLLBACK";
export type SyntheticPublicationPermission="pricing.approve"|"pricing.activate"|"publication.rollback";
export interface PublicationCommand {
 readonly action:PublicationAction; readonly tenantId:string; readonly productId:string; readonly candidateId:string;
 readonly candidateVersion:number; readonly expectedActiveId:string|null; readonly rollbackSourceId:string|null;
 readonly idempotencyKey:string; readonly reason:string|null;
}
export interface PublicationCommandTicket {
 readonly command:PublicationCommand; readonly staffId:string; readonly issuer:string; readonly subject:string;
 readonly permission:SyntheticPublicationPermission; readonly authzVersion:string; readonly membershipVersion:string;
 readonly occurredAt:string; readonly commandDigest:string; readonly execution:"NOT_AUTHORIZED";
 currentTimeMs():number; revalidate():Promise<boolean>;
}
const tickets=new WeakSet<object>();
export function consumePublicationCommand(value:unknown):PublicationCommandTicket {
 if(typeof value!=="object"||value===null||!tickets.has(value))throw new Error("Untrusted publication command");
 tickets.delete(value);return value as PublicationCommandTicket;
}
export interface SyntheticPublicationAuthority {
 readonly capability:"ISOLATED_SYNTHETIC_PUBLICATION_ONLY";
 readonly repository:StaffAuthorizationRepository; readonly auditWriter:SecurityAuditWriter; readonly now:()=>Date;
 /** Trusted fixture composition only. No environment or request-selected permission override. */
 allows(context:StaffAuthorizationContext,permission:SyntheticPublicationPermission):Promise<boolean>;
}
export function normalizePublicationCommand(input:unknown):PublicationCommand {
 const keys=["action","tenantId","productId","candidateId","candidateVersion","expectedActiveId","rollbackSourceId","idempotencyKey","reason"];
 if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).length!==keys.length||keys.some(k=>!Object.hasOwn(input,k)))throw new Error("Invalid publication command");
 const {action,tenantId,productId,candidateId,candidateVersion,expectedActiveId,rollbackSourceId,idempotencyKey,reason}=input as PublicationCommand;
 const c=Object.freeze({action,tenantId,productId,candidateId,candidateVersion,expectedActiveId,rollbackSourceId,idempotencyKey,reason});
 if(!["APPROVE","ACTIVATE","ROLLBACK"].includes(c.action)||![c.tenantId,c.productId,c.idempotencyKey].every(v=>typeof v==="string"&&uuid.test(v))||
 (typeof c.candidateId!=="string"||!hex.test(c.candidateId))||!Number.isSafeInteger(c.candidateVersion)||c.candidateVersion<1||
 (c.expectedActiveId!==null&&(typeof c.expectedActiveId!=="string"||!uuid.test(c.expectedActiveId)))||
 (c.rollbackSourceId!==null&&(typeof c.rollbackSourceId!=="string"||!uuid.test(c.rollbackSourceId)))||
 (c.action==="ROLLBACK"?(!c.rollbackSourceId||!c.expectedActiveId||typeof c.reason!=="string"||c.reason.trim()!==c.reason||c.reason.length<3||c.reason.length>256||/[\x00-\x1f\x7f]/.test(c.reason)):
 (c.rollbackSourceId!==null||c.reason!==null))||(c.action==="APPROVE"&&c.expectedActiveId!==null))throw new Error("Invalid publication command");
 return c;
}

/** The admission result contains no mutation ticket. */
export async function inspectSyntheticPublicationCommand(deps:SyntheticPublicationAuthority,identity:VerifiedStaffIdentity,input:unknown){
 if(deps.capability!=="ISOLATED_SYNTHETIC_PUBLICATION_ONLY"||!isVerifiedStaffIdentity(identity)||!new URL(identity.issuer).hostname.endsWith(".invalid"))throw new Error("Publication denied");
 const c=normalizePublicationCommand(input);
 const permission:SyntheticPublicationPermission=c.action==="APPROVE"?"pricing.approve":c.action==="ACTIVATE"?"pricing.activate":"publication.rollback";
 const role=c.action==="APPROVE"?"PRICING_APPROVER":"PUBLICATION_OPERATOR";
 const fresh=async()=>{
  const time=deps.now().getTime();
  if(!Number.isFinite(time)||time<identity.security.issuedAt*1000||time>=identity.security.expiresAt*1000||identity.security.principalKind!=="human"||identity.security.profile!=="rfc9068-staff-v1"||identity.security.assurance!=="not-established")throw new Error("Publication denied");
  const context=await resolveStaffTenantContext(deps.repository,identity,c.tenantId),p=context.principal,m=context.membership;
  if(!p||!uuid.test(p.staffId)||p.staffStatus!=="ACTIVE"||p.identityStatus!=="ACTIVE"||!m||m.status!=="ACTIVE"||m.tenantId!==c.tenantId)throw new Error("Publication denied");
  const assigned=m.roleGrants.filter(g=>g.revokedAt===null);
  if(assigned.some(g=>g.scope!=="TENANT"||(g.roleCode!=="PUBLICATION_OPERATOR"&&findRoleDefinition(g.roleCode)?.scope!=="TENANT")||["PRICING_EDITOR",role==="PRICING_APPROVER"?"PUBLICATION_OPERATOR":"PRICING_APPROVER"].includes(g.roleCode))||
   !await deps.allows(context,permission))throw new Error("Publication denied");
  const checkedAt=deps.now().getTime();
  if(!Number.isFinite(checkedAt)||checkedAt<time||checkedAt>=identity.security.expiresAt*1000||
   !assigned.some(g=>g.roleCode===role&&Date.parse(g.grantedAt)<=time&&(g.expiresAt===null||Date.parse(g.expiresAt)>checkedAt)))
    throw new Error("Publication denied");
  return context;
 };
 const context=await fresh();
 const stamp=(v:unknown)=>JSON.stringify(v,(_,x:unknown)=>typeof x==="bigint"?x.toString():x),initial=stamp(context);
 const staffId=context.principal!.staffId;
 const authorityDigest=createHash("sha256").update(initial).digest("hex");
 const commandDigest=createHash("sha256").update(JSON.stringify(["SYNTHETIC_PUBLICATION_COMMAND_V1",c.action,c.tenantId,c.productId,c.candidateId,c.candidateVersion,c.expectedActiveId,c.rollbackSourceId,c.idempotencyKey,c.reason,staffId,identity.issuer,identity.subject])).digest("hex");
 return Object.freeze({command:c,staffId,permission,authorityDigest,commandDigest,authzVersion:context.principal!.authzVersion.toString(),
  membershipVersion:context.membership!.version.toString(),revalidate:async()=>stamp(await fresh())===initial});
}

export async function prepareSyntheticPublicationCommand(deps:SyntheticPublicationAuthority,identity:VerifiedStaffIdentity,input:PublicationCommand,
 browser?:Readonly<{commandDigest:string;authorityDigest:string;revalidate():Promise<boolean>}>):Promise<PublicationCommandTicket>{
 const admission=await inspectSyntheticPublicationCommand(deps,identity,input);
 const {command:c,staffId,permission,commandDigest,authzVersion,membershipVersion}=admission;
 if(browser&&(browser.commandDigest!==commandDigest||browser.authorityDigest!==admission.authorityDigest))throw new Error("Publication denied");
 const occurredAt=deps.now().toISOString(),deadline=Math.min(Date.parse(occurredAt)+5000,identity.security.expiresAt*1000);
 const revalidate=async()=>{
  try {
   if (!(deps.now().getTime()<deadline)) return false;
   if (!await admission.revalidate() || (browser && !await browser.revalidate())) return false;
   const checkedAt=deps.now().getTime();
   return checkedAt>=Date.parse(occurredAt)&&checkedAt<deadline;
  } catch {return false;}
 };
 if(browser&&!await browser.revalidate())throw new Error("Publication denied");
 await recordSecurityAuditEvents(deps.auditWriter,[{occurredAt,actorStaffId:staffId,tenantId:c.tenantId,action:"AUTHORIZATION_DECISION",outcome:"SUCCESS",targetType:"AUTHORIZATION",targetId:null,requestId:c.idempotencyKey,reasonCode:"NONE"}]);
 if(!await revalidate())throw new Error("Publication denied");
 const ticket=Object.freeze({command:c,staffId,issuer:identity.issuer,subject:identity.subject,permission,authzVersion,membershipVersion,
  occurredAt,commandDigest,execution:"NOT_AUTHORIZED" as const,currentTimeMs:()=>deps.now().getTime(),revalidate});
 tickets.add(ticket);return ticket;
}

/** Rebuild through the original financial engine, rather than trusting persisted totals. */
export function independentlyVerifyPublicationPayload(payload:string,idempotencyKey:string,expectedDigest:string){
 const arr=(v:unknown,n?:number):unknown[]=>{if(!Array.isArray(v)||(n!==undefined&&v.length!==n))throw new Error("Invalid canonical evidence");return v;};
 const str=(v:unknown):string=>{if(typeof v!=="string")throw new Error("Invalid canonical evidence");return v;};
 const num=(v:unknown):number=>{if(typeof v!=="number"||!Number.isSafeInteger(v))throw new Error("Invalid canonical evidence");return v;};
 const money=(v:unknown):bigint=>{const s=str(v);if(!/^(0|[1-9][0-9]{0,18})$/.test(s))throw new Error("Invalid canonical money");return BigInt(s);};
 const bool=(v:unknown):boolean=>{if(typeof v!=="boolean")throw new Error("Invalid canonical evidence");return v;};
 const a=arr(JSON.parse(payload),16),p=arr(a[12],9);
 if(a[0]!=="NUKHBAPAY_CATALOGUE_PUBLICATION_CANDIDATE_V1"||a[5]!=="AE"||a[6]!=="AED"||a[8]!=="DIGITAL_PIN")throw new Error("Invalid canonical profile");
 const product={canonicalProductId:str(a[3]),brand:str(a[4]),redemptionCountry:"AE" as const,currency:"AED" as const,faceValueMinor:money(a[7]),fulfillmentMethod:"DIGITAL_PIN" as const,termsVersion:str(a[9])};
 const request:DraftPublicationRequest={tenantId:str(a[1]),productId:str(a[2]),product,expectedPreviousVersion:num(a[10]),idempotencyKey,evaluatedAt:str(a[13]),
 pricingPolicy:{version:str(p[0]),serviceFeeMinor:money(p[1]),maximumServiceFeeMinor:money(p[2]),taxAmountMinor:money(p[3]),paymentFeeBasisPoints:num(p[4]),paymentFixedFeeMinor:money(p[5]),agentCommissionMinor:money(p[6]),minimumContributionMinor:money(p[7]),maximumOfferAgeMs:num(p[8])},
 sourceSnapshots:arr(a[14]).map(v=>{const s=arr(v,6);return {snapshotId:str(s[0]),providerAccountId:str(s[1]),snapshotKey:str(s[2]),sourceVersion:str(s[3]),observedAt:str(s[4]),completedAt:str(s[5]),status:"COMPLETE" as const};}),
 offers:arr(a[15]).map(v=>{const o=arr(v,11);if(o[10]!=="APPROVED"||!bool(o[7]))throw new Error("Unverifiable offer mapping");return {providerId:str(o[0]),offerId:str(o[1]),snapshotId:str(o[2]),identity:product,providerDebitMinor:money(o[3]),upfrontDiscountMinor:money(o[4]),additionalProviderFeeMinor:money(o[5]),available:bool(o[6]),eligible:true,mappingStatus:"APPROVED" as const,observedAt:str(o[8]),validUntil:str(o[9])};})};
 const candidate=generateDraftPublicationCandidate(request);
 if(candidate.candidateId!==expectedDigest)throw new Error("Invalid canonical digest");
 if(candidate.priceVersion!==a[11]||generatedCandidateCanonicalEvidence(candidate)!==payload)throw new Error("Noncanonical publication evidence");
 return Object.freeze({candidate,request});
}
