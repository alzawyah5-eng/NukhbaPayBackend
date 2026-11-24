import { createHash } from "node:crypto";
import type { StaffAuthorizationContext } from "./staff-access.js";
import { hasStaffLifecycleOperationFields, type StaffLifecycleOperation } from "./staff-lifecycle.js";

export type StaffRequestCommand = Readonly<{ kind: "SUBMIT"; key: string; id: string; version: bigint; previousDigest: string | null;
  targetStaffId: string; operation: StaffLifecycleOperation; proposedRoles: readonly string[];
  expectedAuthzVersion: bigint; expectedMembershipVersion: bigint | null; expiresAtMs: number }> |
  Readonly<{ kind: "REVIEW"; key: string; id: string; version: bigint; requestDigest: string }> |
  Readonly<{ kind: "CANCEL"; key: string; id: string; version: bigint; requestDigest: string }> |
  Readonly<{ kind: "LOOKUP"; key: string; id: string; version: bigint }>;
export type StaffRequestResult = Readonly<{ kind: "RECORDED" | "REPLAYED" | "DENIED" | "CONFLICT" | "UNRESOLVED";
  execution: "NOT_AUTHORIZED"; acceptedApproval: false; reason?: string; operationId?: string; requestId?: string; version?: string; requestDigest?: string }>;
export const staffRequestResult = (kind: StaffRequestResult["kind"], fields: Omit<StaffRequestResult, "kind" | "execution" | "acceptedApproval"> = {}): StaffRequestResult =>
  Object.freeze({ ...fields, kind, execution: "NOT_AUTHORIZED", acceptedApproval: false });
export const canonicalDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value, (_, item: unknown) => typeof item === "bigint" ? item.toString() : item)).digest("hex");
export function staffAuthorityDigest(c: StaffAuthorizationContext): string {
  const grants = (values: StaffAuthorizationContext["platformRoleGrants"]) => values.map(g => [g.roleCode,g.scope,g.grantedAt,g.expiresAt,g.revokedAt]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b),"en"));
  return canonicalDigest([c.principal?.staffId,c.principal?.staffStatus,c.principal?.identityStatus,c.principal?.authzVersion,
    c.membership ? [c.membership.membershipId,c.membership.tenantId,c.membership.status,c.membership.version,grants(c.membership.roleGrants)] : null,
    grants(c.platformRoleGrants)]);
}
/** Copy a bounded allowlist; no caller-provided actor/scope/approval/MFA/state fields. */
export function normalizeStaffRequestCommand(input: StaffRequestCommand): StaffRequestCommand {
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const hex=/^[0-9a-f]{64}$/;
  if (!input || !uuid.test(input.key) || !uuid.test(input.id) || typeof input.version!=="bigint" || input.version<1n || input.version>1000000n) throw new Error("Invalid request command");
  const common={key:input.key,id:input.id,version:input.version};
  if(input.kind==="LOOKUP") return Object.freeze({kind:input.kind,...common});
  if((input.kind==="REVIEW" || input.kind==="CANCEL") && typeof input.requestDigest==="string" && hex.test(input.requestDigest)) return Object.freeze({kind:input.kind,...common,requestDigest:input.requestDigest});
  if(input.kind!=="SUBMIT" || !uuid.test(input.targetStaffId) || !Array.isArray(input.proposedRoles) || input.proposedRoles.length>12 ||
    !input.proposedRoles.every(role=>typeof role==="string" && /^[A-Z_]{1,40}$/.test(role)) || new Set(input.proposedRoles).size!==input.proposedRoles.length ||
    typeof input.expectedAuthzVersion!=="bigint" || input.expectedAuthzVersion<0n ||
    (input.expectedMembershipVersion!==null && (typeof input.expectedMembershipVersion!=="bigint" || input.expectedMembershipVersion<1n)) ||
    !Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs<0 ||
    (input.version===1n ? input.previousDigest!==null : !hex.test(input.previousDigest??""))) throw new Error("Invalid request intent");
  const op=input.operation;
  if(!op || !["CREATE","ACTIVATE","SUSPEND","REVOKE","REACTIVATE","DISABLE","RECOVER"].includes(op.kind) || !["STAFF","MEMBERSHIP","GRANT"].includes(op.target) ||
    !hasStaffLifecycleOperationFields(op) || (op.target==="GRANT" && !uuid.test(op.grantId))) throw new Error("Invalid operation");
  return Object.freeze({kind:"SUBMIT",...common,previousDigest:input.previousDigest,targetStaffId:input.targetStaffId,
    operation:Object.freeze(op.target==="GRANT" ? {kind:op.kind,target:op.target,grantId:op.grantId} : {kind:op.kind,target:op.target}) as StaffLifecycleOperation,
    proposedRoles:Object.freeze([...input.proposedRoles].sort()),expectedAuthzVersion:input.expectedAuthzVersion,
    expectedMembershipVersion:input.expectedMembershipVersion,expiresAtMs:input.expiresAtMs});
}
export interface SyntheticStaffRequestStore {
  readonly capability: "NON_AUTHORIZED_STAFF_REQUESTS";
  allows(context: StaffAuthorizationContext, action: StaffRequestCommand["kind"]): Promise<boolean>;
  execute(ticket: import("./trusted-staff-actor.js").AuthorizedStaffRequest): Promise<StaffRequestResult>;
}
