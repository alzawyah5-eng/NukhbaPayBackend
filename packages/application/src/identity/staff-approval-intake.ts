import {STAFF_LIFECYCLE_POLICY_VERSION} from "./staff-lifecycle.js";
import {canonicalDigest,type StaffRequestResult} from "./durable-staff-request.js";
import {authorizeStaffAccess,type StaffAuthorizationContext} from "./staff-access.js";
import type {AuthorizedStaffRequest} from "./trusted-staff-actor.js";

/** Intake records blocked synthetic evidence only. No ACCEPT/APPLY command exists. */
export interface StaffApprovalIntakeCommand {
  readonly kind:"ATTEMPT"|"RECONCILE";readonly key:string;readonly id:string;readonly version:bigint;
  readonly requestDigest:string;readonly policyVersion:typeof STAFF_LIFECYCLE_POLICY_VERSION;
  readonly decision?:"APPROVE"|"REJECT";
}
export interface ApprovalIntakeBinding {readonly profile:"BLOCKED_SYNTHETIC_REVIEW";readonly requestDigest:string;readonly policyVersion:typeof STAFF_LIFECYCLE_POLICY_VERSION;readonly decision?:"APPROVE"|"REJECT"}
export interface SyntheticStaffApprovalIntake {
  readonly capability:"NON_AUTHORIZED_STAFF_APPROVAL_INTAKE";
  allows(context:StaffAuthorizationContext,action:StaffApprovalIntakeCommand["kind"]):Promise<boolean>;
  execute(ticket:AuthorizedStaffRequest):Promise<StaffRequestResult>;
}
type FixedResult = Readonly<{acceptedApproval:false;privilegedApproval:"BLOCKED";operationalAssurance:"not-established";execution:"NOT_AUTHORIZED"}>;
export type StaffApprovalIntakeResult = FixedResult & (
  Readonly<{kind:"RECORDED"|"REPLAYED";evidenceKind:"SYNTHETIC_TEST_EVENT";operationId:string;requestId:string;version:string;requestDigest:string}> |
  Readonly<{kind:"DENIED"|"CONFLICT"|"UNRESOLVED";reason:"INTAKE_DENIED"|"IDEMPOTENCY_CONFLICT"|"RECONCILIATION_REQUIRED"}>
);
const fixed={acceptedApproval:false,privilegedApproval:"BLOCKED",operationalAssurance:"not-established",execution:"NOT_AUTHORIZED"} as const;
export function failedApprovalIntake(kind:"DENIED"|"CONFLICT"|"UNRESOLVED"="DENIED"):StaffApprovalIntakeResult {
  return Object.freeze({...fixed,kind,reason:kind==="DENIED"?"INTAKE_DENIED":kind==="CONFLICT"?"IDEMPOTENCY_CONFLICT":"RECONCILIATION_REQUIRED"});
}
/** Strict allowlist: caller authority/MFA/receipt fields are rejected, never interpreted. */
export function normalizeApprovalIntake(input:StaffApprovalIntakeCommand):StaffApprovalIntakeCommand {
  const fields=["kind","key","id","version","requestDigest","policyVersion","decision"];
  if(!input || typeof input!=="object" || ![Object.prototype,null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).some(key=>typeof key!=="string" || !fields.includes(key)) ||
    Object.values(Object.getOwnPropertyDescriptors(input)).some(d=>d.get!==undefined || d.set!==undefined))throw new Error("Invalid approval intake");
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if(!["ATTEMPT","RECONCILE"].includes(input.kind) || !uuid.test(input.key) || !uuid.test(input.id) ||
    typeof input.version!=="bigint" || input.version<1n || input.version>1000000n || !/^[0-9a-f]{64}$/.test(input.requestDigest) ||
    input.policyVersion!==STAFF_LIFECYCLE_POLICY_VERSION ||
     input.decision!==undefined && (input.kind!=="ATTEMPT" || !["APPROVE","REJECT"].includes(input.decision)))throw new Error("Invalid approval intake");
  return Object.freeze({kind:input.kind,key:input.key,id:input.id,version:input.version,requestDigest:input.requestDigest,policyVersion:STAFF_LIFECYCLE_POLICY_VERSION,...(input.decision && {decision:input.decision})});
}
/** Fresh current role/time/conflict eligibility, never activation of a reserved permission. */
export function eligibleApprovalIntake(context:StaffAuthorizationContext,nowMs:number):boolean {
  const tenant=context.membership?.tenantId;
  return (tenant?["tenant.access.request"]:["platform.access.approve","platform.access.approve_privileged"]).some(permission=>
    authorizeStaffAccess(context,{permissionCode:permission,scope:tenant?"TENANT":"PLATFORM",now:new Date(nowMs).toISOString(),
      ...(tenant?{tenantId:tenant,objectTenantId:tenant}:{})}).reason==="PERMISSION_INACTIVE");
}
export function safeApprovalIntakeResult(result:StaffRequestResult,command:StaffApprovalIntakeCommand,staffId:string):StaffApprovalIntakeResult {
  if(result.kind==="RECORDED" || result.kind==="REPLAYED"){
    if(result.acceptedApproval!==false || result.execution!=="NOT_AUTHORIZED" || result.requestId!==command.id || result.version!==String(command.version) ||
      result.requestDigest!==command.requestDigest || result.operationId!==canonicalDigest(["staff-request-operation-v1",staffId,command.key]))return failedApprovalIntake("UNRESOLVED");
    return Object.freeze({...fixed,kind:result.kind,evidenceKind:"SYNTHETIC_TEST_EVENT",operationId:result.operationId,requestId:command.id,version:String(command.version),requestDigest:command.requestDigest});
  }
  return failedApprovalIntake(result.kind==="CONFLICT"?"CONFLICT":result.kind==="UNRESOLVED"?"UNRESOLVED":"DENIED");
}
