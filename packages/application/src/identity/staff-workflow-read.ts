import { authorizeStaffAccess, type StaffAuthorizationContext } from "./staff-access.js";
import { findRoleDefinition } from "./permission-catalog.js";
import type { StaffLifecycleOperation } from "./staff-lifecycle.js";

declare const cursorBrand: unique symbol;
/** Process-local continuation; never a bearer credential or a JSON cursor. */
export interface StaffWorkflowReadCursor { readonly [cursorBrand]: true }
export type StaffWorkflowView = "REQUESTER" | "REVIEWER";
export type StaffWorkflowReadInput = Readonly<{kind:"DETAIL"|"STATUS"|"REVISIONS"|"REVIEWS";id:string;operationId:string;view:StaffWorkflowView;
  version?:bigint;limit?:number;cursor?:StaffWorkflowReadCursor}>;
export interface WorkflowPosition {readonly head:string;readonly version:string;readonly observedAtMs:number;readonly operationId:string}
export type StaffWorkflowQuery = Readonly<{kind:StaffWorkflowReadInput["kind"];id:string;operationId:string;view:StaffWorkflowView;
  version?:string;limit:number;position?:WorkflowPosition}>;
declare const queryBrand: unique symbol;
export interface AuthorizedStaffWorkflowRead {
  readonly [queryBrand]:true;readonly staffId:string;readonly tenantId:string|null;readonly query:StaffWorkflowQuery;
  readonly nowMs:number;readonly validUntilMs:number;
  revalidate():Promise<boolean>;
}
export interface StaffRequestDetail {
  readonly version:string;readonly targetStaffId:string;readonly operation:StaffLifecycleOperation;readonly proposedRoles:readonly string[];
  readonly requestDigest:string;readonly previousDigest:string|null;readonly expectedAuthzVersion:string;readonly expectedMembershipVersion:string|null;
  readonly policyVersion:"staff-lifecycle-v1";
  readonly createdAtMs:number;readonly expiresAtMs:number;readonly state:"SUBMITTED";
}
export interface StaffReviewSummary {readonly version:string;readonly observedAtMs:number;readonly acceptedApproval:false;readonly assurance:"not-established"}
export type WorkflowReadData = Readonly<{requestId:string;view:StaffWorkflowView;visibleHeadVersion:string;state:"SUBMITTED";
  status:"SUBMITTED"|"EXPIRED";expiresAtMs:number;
  detail?:StaffRequestDetail;revisions?:readonly StaffRequestDetail[];reviews?:readonly StaffReviewSummary[]}>;
/** Internal adapter response. Private continuation fields are stripped by the actor boundary. */
export interface StaffWorkflowPage {readonly binding:Readonly<{staffId:string;tenantId:string|null;query:StaffWorkflowQuery}>;
  readonly data:WorkflowReadData;readonly next?:WorkflowPosition}
export interface SyntheticStaffWorkflowReads {
  readonly capability:"NON_AUTHORIZED_STAFF_WORKFLOW_READ";
  allows(context:StaffAuthorizationContext,query:StaffWorkflowQuery):Promise<boolean>;
  read(ticket:AuthorizedStaffWorkflowRead):Promise<StaffWorkflowPage|"NOT_AVAILABLE"|"UNAVAILABLE">;
}
export type StaffWorkflowReadResult = Readonly<{allowed:false;reason:"READ_DENIED"|"UNAVAILABLE";execution:"NOT_AUTHORIZED"}> |
  Readonly<{allowed:true;data:WorkflowReadData;cursor?:StaffWorkflowReadCursor;execution:"NOT_AUTHORIZED";acceptedApproval:false}>;
export const workflowUuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const workflowHex=/^[0-9a-f]{64}$/;
const validVersion=(value:unknown):value is string=>typeof value==="string" && /^[1-9][0-9]{0,6}$/.test(value) && BigInt(value)<=1000000n;
const authorityVersion=(value:unknown,positive=false):value is string=>typeof value==="string" && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value)<9223372036854775808n && (!positive || BigInt(value)>0n);

export function normalizeWorkflowRead(input:StaffWorkflowReadInput):StaffWorkflowQuery {
  if(!input || !["DETAIL","STATUS","REVISIONS","REVIEWS"].includes(input.kind) || !workflowUuid.test(input.id) || !workflowHex.test(input.operationId) ||
    !["REQUESTER","REVIEWER"].includes(input.view) || (input.version!==undefined && (typeof input.version!=="bigint" || !validVersion(String(input.version)))) ||
    ((input.kind==="STATUS" || input.kind==="REVISIONS") && input.version!==undefined) ||
    (input.limit!==undefined && (!Number.isInteger(input.limit) || input.limit<1 || input.limit>25)) ||
    (input.cursor!==undefined && !["REVISIONS","REVIEWS"].includes(input.kind)))throw new Error("Invalid workflow read");
  return Object.freeze({kind:input.kind,id:input.id,operationId:input.operationId,view:input.view,limit:input.limit??10,
    ...(input.version===undefined?{}:{version:String(input.version)})});
}

/** Role/time/conflict eligibility only. Reserved permissions still deny; the separate artifact policy must allow. */
export function eligibleWorkflowRead(context:StaffAuthorizationContext,query:StaffWorkflowQuery,nowMs:number):boolean {
  const tenant=context.membership?.tenantId;
  const permissions=tenant ? ["tenant.access.request"] : query.view==="REQUESTER"
    ? ["platform.access.request","platform.staff.suspend"] : ["platform.access.approve","platform.access.approve_privileged"];
  return permissions.some(permission=>authorizeStaffAccess(context,{permissionCode:permission,scope:tenant?"TENANT":"PLATFORM",now:new Date(nowMs).toISOString(),
    ...(tenant?{tenantId:tenant,objectTenantId:tenant}:{})}).reason==="PERMISSION_INACTIVE");
}

/** Copy an allowlist, validate the private adapter result and never return arbitrary JSON/evidence. */
export function safeWorkflowPage(page:StaffWorkflowPage,ticket:AuthorizedStaffWorkflowRead):{data:WorkflowReadData;next?:WorkflowPosition} {
  const q=ticket.query,b=page.binding,d=page.data;
  if(!b || b.staffId!==ticket.staffId || b.tenantId!==ticket.tenantId || JSON.stringify(b.query)!==JSON.stringify(q) || !d ||
    d.requestId!==q.id || d.view!==q.view || !validVersion(d.visibleHeadVersion) || d.state!=="SUBMITTED" ||
    !Number.isSafeInteger(d.expiresAtMs) || d.expiresAtMs<0 || d.status!==(ticket.nowMs>=d.expiresAtMs?"EXPIRED":"SUBMITTED"))throw new Error("Invalid workflow result");
  const head=BigInt(d.visibleHeadVersion);
  if((q.position && q.position.head!==d.visibleHeadVersion) || (q.kind==="REVISIONS" && !Array.isArray(d.revisions)) ||
    (q.kind==="REVIEWS" && !Array.isArray(d.reviews)))throw new Error("Invalid workflow page");
  const detail=(row:StaffRequestDetail):StaffRequestDetail=>{
    if(!row || !validVersion(row.version) || BigInt(row.version)>head || !workflowUuid.test(row.targetStaffId) || row.state!=="SUBMITTED" ||
      !workflowHex.test(row.requestDigest) || (row.version==="1"?row.previousDigest!==null:!workflowHex.test(row.previousDigest??"")) || row.policyVersion!=="staff-lifecycle-v1" ||
      !authorityVersion(row.expectedAuthzVersion) || (ticket.tenantId===null?row.expectedMembershipVersion!==null:!authorityVersion(row.expectedMembershipVersion,true)) ||
      !Number.isSafeInteger(row.createdAtMs) || row.createdAtMs<0 || !Number.isSafeInteger(row.expiresAtMs) || row.expiresAtMs<=row.createdAtMs || row.expiresAtMs-row.createdAtMs>1800000 ||
      !Array.isArray(row.proposedRoles) || row.proposedRoles.length>12 || new Set(row.proposedRoles).size!==row.proposedRoles.length ||
      row.proposedRoles.some(role=>findRoleDefinition(role)?.scope!==(ticket.tenantId===null?"PLATFORM":"TENANT")))throw new Error("Invalid workflow detail");
    const op=row.operation;
    if(!op || !["CREATE","ACTIVATE","SUSPEND","REVOKE","REACTIVATE","DISABLE","RECOVER"].includes(op.kind) || !["STAFF","MEMBERSHIP","GRANT"].includes(op.target) ||
      (op.target==="GRANT" && !workflowUuid.test(op.grantId)) ||
      (["CREATE","ACTIVATE","DISABLE","RECOVER"].includes(op.kind) && op.target!=="STAFF") ||
      (["SUSPEND","REACTIVATE"].includes(op.kind) && op.target==="GRANT") || (op.kind==="REVOKE" && String(op.target)==="STAFF"))throw new Error("Invalid workflow operation");
    return Object.freeze({version:row.version,targetStaffId:row.targetStaffId,operation:Object.freeze(op.target==="GRANT"?{kind:op.kind,target:op.target,grantId:op.grantId}:{kind:op.kind,target:op.target}) as StaffLifecycleOperation,
      proposedRoles:Object.freeze([...row.proposedRoles]),requestDigest:row.requestDigest,previousDigest:row.previousDigest,expectedAuthzVersion:row.expectedAuthzVersion,
      expectedMembershipVersion:row.expectedMembershipVersion,policyVersion:"staff-lifecycle-v1",createdAtMs:row.createdAtMs,expiresAtMs:row.expiresAtMs,state:"SUBMITTED"});
  };
  const data:WorkflowReadData={requestId:q.id,view:q.view,visibleHeadVersion:d.visibleHeadVersion,state:"SUBMITTED",status:d.status,expiresAtMs:d.expiresAtMs,
    ...(q.kind==="DETAIL"?{detail:detail(d.detail!)}:{}),
    ...(q.kind==="REVISIONS"?{revisions:Object.freeze((d.revisions??[]).map(detail))}:{}),
    ...(q.kind==="REVIEWS"?{reviews:Object.freeze((d.reviews??[]).map(row=>{
      if(!validVersion(row.version) || BigInt(row.version)>head || !Number.isSafeInteger(row.observedAtMs) || row.observedAtMs<0 || row.acceptedApproval!==false || row.assurance!=="not-established")throw new Error("Invalid review summary");
      return Object.freeze({version:row.version,observedAtMs:row.observedAtMs,acceptedApproval:false as const,assurance:"not-established" as const});
    }))}:{})};
  if((data.revisions?.length??0)>q.limit || (data.reviews?.length??0)>q.limit || (q.version!==undefined &&
    (data.detail?.version!==undefined && data.detail.version!==q.version || data.reviews?.some(row=>row.version!==q.version))))throw new Error("Invalid workflow bounds");
  if(page.next && (!["REVISIONS","REVIEWS"].includes(q.kind) || page.next.head!==d.visibleHeadVersion || !validVersion(page.next.version) ||
    BigInt(page.next.version)>head || !Number.isSafeInteger(page.next.observedAtMs) || page.next.observedAtMs<0 || !workflowHex.test(page.next.operationId)))throw new Error("Invalid workflow continuation");
  return {data:Object.freeze(data),...(page.next?{next:Object.freeze({...page.next})}:{})};
}
