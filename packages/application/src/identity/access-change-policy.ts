import { createHash } from "node:crypto";
import { findRoleDefinition } from "./permission-catalog.js";
import {
  classifyLifecycleGrant, LIFECYCLE_EXECUTION_BLOCKERS, STAFF_LIFECYCLE_POLICY_VERSION, validLifecycleTime,
  type AccessChangeRequest, type AccessRequestEvent, type AccessRequestState, type ApprovalSlot,
  type LifecycleActor, type LifecycleGrant, type LifecyclePolicyContext, type LifecyclePolicyReason,
  type LifecyclePolicyResult, type LifecycleScope, type PlanningBoundary,
} from "./staff-lifecycle.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id = (value: unknown): value is string => typeof value === "string" && uuid.test(value) && value === value.toLowerCase();
const version = (value: unknown): value is bigint => typeof value === "bigint" && value >= 0n;
const windowMs = 30 * 60 * 1000;
const lowRisk = new Set(["SUPPORT_AGENT", "CATALOG_OPERATOR"]);
const boundary: PlanningBoundary = Object.freeze({ execution: "NOT_AUTHORIZED", executionBlockers: LIFECYCLE_EXECUTION_BLOCKERS });
const reject = (reason: LifecyclePolicyReason): Extract<LifecyclePolicyResult, { kind: "REJECTED" }> => Object.freeze({ ...boundary, kind: "REJECTED", reason });
const scopeValid = (scope: LifecycleScope): boolean => scope?.kind === "PLATFORM"
  ? !("tenantId" in scope) : scope?.kind === "TENANT" && id(scope.tenantId);
const sameScope = (a: LifecycleScope, b: LifecycleScope): boolean => a.kind === b.kind &&
  (a.kind === "PLATFORM" || (b.kind === "TENANT" && a.tenantId === b.tenantId));
const states: readonly AccessRequestState[] = ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "CANCELLED", "EXPIRED", "SUPERSEDED", "APPLIED"];
const open = (state: AccessRequestState): boolean => ["DRAFT", "SUBMITTED", "APPROVED"].includes(state);

/** Standard-library digest of versioned intent, excluding mutable bookkeeping state. Not an approval signature. */
export function accessChangeRequestDigest(r: AccessChangeRequest): string {
  return createHash("sha256").update(JSON.stringify([
    STAFF_LIFECYCLE_POLICY_VERSION, r.id, r.version.toString(), r.policyVersion, r.operation.kind, r.operation.target,
    r.operation.target === "GRANT" ? r.operation.grantId : null, r.scope.kind,
    r.scope.kind === "TENANT" ? r.scope.tenantId : null, r.requesterStaffId, r.targetStaffId,
    r.expectedAuthzVersion.toString(), r.expectedMembershipVersion?.toString() ?? null,
    [...r.proposedRoles].sort(), r.createdAtMs, r.expiresAtMs,
  ])).digest("hex");
}

function grantsValid(grants: readonly LifecycleGrant[], staffId: string, now: number): boolean {
  return Array.isArray(grants) && grants.length <= 100 && new Set(grants.map((g) => g.id)).size === grants.length && grants.every((g) =>
    id(g.id) && g.staffId === staffId && scopeValid(g.scope) && findRoleDefinition(g.roleCode)?.scope === g.scope.kind &&
    classifyLifecycleGrant(g, now) !== "INVALID");
}
function conflict(roles: ReadonlySet<string>, platform: boolean): boolean {
  return platform ? ["GOVERNANCE_OWNER", "SECURITY_ADMIN", "ACCESS_ADMIN"].filter((r) => roles.has(r)).length > 1 :
    (roles.has("CATALOG_OPERATOR") && roles.has("CATALOG_REVIEWER")) || (roles.has("PRICING_EDITOR") && roles.has("PRICING_APPROVER"));
}
function conflicts(grants: readonly LifecycleGrant[], intent: readonly string[] = [], scope?: LifecycleScope): boolean {
  const groups = new Map<string, Set<string>>();
  const add = (role: string, target: LifecycleScope) => {
    const key = target.kind === "PLATFORM" ? "PLATFORM" : target.tenantId;
    const group = groups.get(key) ?? new Set<string>(); group.add(role); groups.set(key, group);
  };
  for (const grant of grants) if (grant.revokedAtMs === null) add(grant.roleCode, grant.scope);
  if (scope !== undefined) for (const role of intent) add(role, scope);
  return [...groups].some(([key, roles]) => conflict(roles, key === "PLATFORM"));
}
function actorValid(actor: LifecycleActor, now: number): boolean {
  return id(actor?.staffId) && ["PENDING", "ACTIVE", "SUSPENDED", "DISABLED"].includes(actor.status) && version(actor.authzVersion) &&
    grantsValid(actor.grants, actor.staffId, now) && Array.isArray(actor.memberships) && actor.memberships.length <= 100 &&
    new Set(actor.memberships.map((m) => m.tenantId)).size === actor.memberships.length && actor.memberships.every((m) =>
      id(m.tenantId) && ["ACTIVE", "SUSPENDED", "REVOKED"].includes(m.status));
}
function holds(actor: LifecycleActor, role: string, scope: LifecycleScope, now: number): boolean {
  return actor.status === "ACTIVE" && !conflicts(actor.grants) &&
    (scope.kind === "PLATFORM" || actor.memberships.some((m) => m.tenantId === scope.tenantId && m.status === "ACTIVE")) &&
    actor.grants.some((g) => g.roleCode === role && sameScope(g.scope, scope) && classifyLifecycleGrant(g, now) === "ACTIVE");
}

/** Validate trusted snapshots and describe a future change; never authorize or execute it. */
export function planStaffLifecycle(request: AccessChangeRequest, context: LifecyclePolicyContext, nowMs: number): LifecyclePolicyResult {
  try { return plan(request, context, nowMs); } catch { return reject("INVALID_INPUT"); }
}
function plan(r: AccessChangeRequest, c: LifecyclePolicyContext, now: number): LifecyclePolicyResult {
  if (!validLifecycleTime(now) || !id(r.id) || !version(r.version) || r.version < 1n || !states.includes(r.state) ||
      !id(r.requesterStaffId) || !id(r.targetStaffId) || !version(r.expectedAuthzVersion) ||
      !version(c.currentRequestVersion) || !actorValid(c.requester, now) || !id(c.target.staffId) || !version(c.target.authzVersion) ||
      !["ABSENT", "PENDING", "ACTIVE", "SUSPENDED", "DISABLED"].includes(c.target.status) || !grantsValid(c.target.grants, c.target.staffId, now) ||
      !Array.isArray(c.approvers) || c.approvers.length > 16 || !c.approvers.every((a) => actorValid(a, now)) ||
      new Set(c.approvers.map((a) => a.staffId)).size !== c.approvers.length || !Array.isArray(c.approvals) || c.approvals.length > 2 ||
      !Array.isArray(c.knownTenantIds) || c.knownTenantIds.length > 1000 || !c.knownTenantIds.every(id) ||
      !validLifecycleTime(r.createdAtMs) || !validLifecycleTime(r.expiresAtMs) || r.expiresAtMs <= r.createdAtMs ||
      r.expiresAtMs - r.createdAtMs > windowMs || now < r.createdAtMs ||
      !Array.isArray(r.proposedRoles) || r.proposedRoles.length > 12 || new Set(r.proposedRoles).size !== r.proposedRoles.length) return reject("INVALID_INPUT");
  if (r.policyVersion !== STAFF_LIFECYCLE_POLICY_VERSION || r.version !== c.currentRequestVersion ||
      r.expectedAuthzVersion !== c.target.authzVersion || c.currentRequestDigest !== accessChangeRequestDigest(r)) return reject("STALE_REQUEST");
  if (!open(r.state)) return reject("INVALID_STATE");
  if (now >= r.expiresAtMs) return reject("REQUEST_EXPIRED");
  if (r.requesterStaffId !== c.requester.staffId || r.targetStaffId !== c.target.staffId) return reject("INVALID_INPUT");
  if (!scopeValid(r.scope)) return reject("INVALID_SCOPE");
  const membership = c.target.membership;
  if (r.scope.kind === "TENANT") {
    if (!c.knownTenantIds.includes(r.scope.tenantId) || c.objectTenantId !== r.scope.tenantId || membership?.tenantId !== r.scope.tenantId ||
        !["ACTIVE", "SUSPENDED", "REVOKED"].includes(membership.status) || !version(membership.version) || membership.version < 1n) return reject("INVALID_SCOPE");
    if (r.expectedMembershipVersion !== membership.version) return reject("STALE_REQUEST");
  } else if (c.objectTenantId !== null || r.expectedMembershipVersion !== null || membership !== null) return reject("INVALID_SCOPE");
  if (r.proposedRoles.some((role) => findRoleDefinition(role)?.scope !== r.scope.kind)) return reject("INVALID_SCOPE");
  const op = r.operation;
  const operationShape: { kind: string; target: string } = op;
  if (!op || !["CREATE", "ACTIVATE", "SUSPEND", "REVOKE", "REACTIVATE", "DISABLE", "RECOVER"].includes(op.kind)) return reject("INVALID_INPUT");
  if ((op.target === "STAFF" && r.scope.kind !== "PLATFORM") || (op.target === "MEMBERSHIP" && r.scope.kind !== "TENANT") ||
      !["STAFF", "MEMBERSHIP", "GRANT"].includes(op.target) ||
      (["CREATE", "ACTIVATE", "DISABLE", "RECOVER"].includes(op.kind) && op.target !== "STAFF") ||
      (["SUSPEND", "REACTIVATE"].includes(op.kind) && op.target === "GRANT") || (op.kind === "REVOKE" && operationShape.target === "STAFF")) return reject("INVALID_SCOPE");
  const restrictive = ["SUSPEND", "REVOKE", "DISABLE"].includes(op.kind);
  if (["SUSPEND", "REVOKE"].includes(op.kind) && r.requesterStaffId === r.targetStaffId) return reject("SELF_APPROVAL");
  if ((restrictive || op.kind === "CREATE" || op.kind === "RECOVER") && r.proposedRoles.length !== 0) return reject("INVALID_INPUT");
  if (!restrictive && conflicts(c.target.grants, r.proposedRoles, r.scope)) return reject("ROLE_CONFLICT");
  if (conflicts(c.requester.grants)) return reject("ROLE_CONFLICT");
  const staff = c.target.status;
  let proposedStatus: "PENDING" | "ACTIVE" | "SUSPENDED" | "DISABLED" | "REVOKED";
  switch (op.kind) {
    case "CREATE":
      if (staff !== "ABSENT" || c.target.authzVersion !== 0n || c.target.grants.length !== 0) return reject("INVALID_TRANSITION");
      proposedStatus = "PENDING"; break;
    case "ACTIVATE":
      if (staff !== "PENDING") return reject("INVALID_TRANSITION");
      proposedStatus = "ACTIVE"; break;
    case "SUSPEND":
      if (staff !== "ACTIVE" || (op.target === "MEMBERSHIP" && membership?.status !== "ACTIVE")) return reject("INVALID_TRANSITION");
      if (r.requesterStaffId === r.targetStaffId) return reject("SELF_APPROVAL");
      proposedStatus = "SUSPENDED"; break;
    case "REACTIVATE":
      if (op.target === "STAFF" ? staff !== "SUSPENDED" : staff !== "ACTIVE" || membership?.status !== "SUSPENDED") return reject("INVALID_TRANSITION");
      proposedStatus = "ACTIVE"; break;
    case "RECOVER":
      if (staff !== "SUSPENDED") return reject("INVALID_TRANSITION");
      proposedStatus = "SUSPENDED"; break; // Recovery verification alone never reactivates.
    case "DISABLE":
      if (!["PENDING", "ACTIVE", "SUSPENDED"].includes(staff)) return reject("INVALID_TRANSITION");
      proposedStatus = "DISABLED"; break;
    case "REVOKE": {
      if (!["ACTIVE", "SUSPENDED"].includes(staff)) return reject("INVALID_TRANSITION");
      if (op.target === "MEMBERSHIP") {
        if (!["ACTIVE", "SUSPENDED"].includes(membership?.status ?? "")) return reject("INVALID_TRANSITION");
      } else {
        const grant = c.target.grants.find((g) => g.id === op.grantId);
        if (!grant || !sameScope(grant.scope, r.scope)) return reject("INVALID_SCOPE");
        if (classifyLifecycleGrant(grant, now) === "REVOKED") return reject("INVALID_TRANSITION");
      }
      proposedStatus = "REVOKED"; break;
    }
  }
  const platform: LifecycleScope = { kind: "PLATFORM" };
  const roles = [...c.target.grants.filter((g) => g.revokedAtMs === null && (op.target === "STAFF" || g.scope.kind === "PLATFORM" || sameScope(g.scope, r.scope))).map((g) => g.roleCode), ...r.proposedRoles];
  const protectedTarget = roles.some((role) => !lowRisk.has(role));
  const accessAdmin = holds(c.requester, "ACCESS_ADMIN", platform, now);
  const tenantAdmin = r.scope.kind === "TENANT" && holds(c.requester, "TENANT_ADMIN", r.scope, now);
  let slots: readonly ApprovalSlot[];
  if (op.kind === "SUSPEND" && op.target === "STAFF") {
    if (!holds(c.requester, "SECURITY_ADMIN", platform, now)) return reject("REQUESTER_NOT_AUTHORIZED");
    slots = [];
  } else if (tenantAdmin && !accessAdmin) {
    if (protectedTarget) return reject("TARGET_PROTECTED");
    slots = (op.kind === "SUSPEND" || op.kind === "REVOKE") ? [] : ["SECURITY_ADMIN"];
  } else {
    if (!accessAdmin) return reject("REQUESTER_NOT_AUTHORIZED");
    slots = protectedTarget || op.kind === "DISABLE" || op.kind === "RECOVER"
      ? ["SECURITY_ADMIN", "GOVERNANCE_OWNER"] : ["SECURITY_ADMIN"];
  }
  const seen = new Set<string>(); const filled = new Set<ApprovalSlot>();
  for (const approval of c.approvals) {
    if (!id(approval.approverStaffId) || !["APPROVE", "REJECT"].includes(approval.decision) || !slots.includes(approval.slot)) return reject("INVALID_INPUT");
    if (approval.approverStaffId === r.requesterStaffId || approval.approverStaffId === r.targetStaffId) return reject("SELF_APPROVAL");
    if (seen.has(approval.approverStaffId) || filled.has(approval.slot)) return reject("DUPLICATE_APPROVER");
    seen.add(approval.approverStaffId); filled.add(approval.slot);
    if (approval.requestId !== r.id || approval.requestVersion !== r.version || approval.policyVersion !== r.policyVersion ||
        approval.requestDigest !== accessChangeRequestDigest(r)) return reject("STALE_APPROVAL");
    if (!validLifecycleTime(approval.decidedAtMs) || !validLifecycleTime(approval.expiresAtMs) || approval.decidedAtMs < r.createdAtMs ||
        approval.decidedAtMs > now || approval.expiresAtMs <= approval.decidedAtMs || approval.expiresAtMs > r.expiresAtMs ||
        approval.expiresAtMs - approval.decidedAtMs > windowMs) return reject("INVALID_INPUT");
    if (approval.expiresAtMs <= now) return reject("APPROVAL_EXPIRED");
    const actor = c.approvers.find((a) => a.staffId === approval.approverStaffId);
    if (!actor || !holds(actor, approval.slot, platform, now)) return reject("APPROVER_NOT_AUTHORIZED");
    if (actor.authzVersion !== approval.approverAuthzVersion) return reject("STALE_APPROVAL");
    if (approval.decision === "REJECT") return reject("APPROVAL_REJECTED");
  }
  if (r.state === "DRAFT" && c.approvals.length > 0) return reject("INVALID_STATE");
  const quorum = filled.size === slots.length ? "PRESENT" : "PENDING";
  if (r.state === "APPROVED" && quorum !== "PRESENT") return reject("QUORUM_MISSING");
  return Object.freeze({ ...boundary, kind: "PLAN", requiredApprovals: Object.freeze([...slots]), quorum, proposedStatus,
    preconditions: Object.freeze(op.kind === "RECOVER" ? ["INDEPENDENT_IDENTITY_AND_FACTOR_REVIEW", "NO_AUTOMATIC_REACTIVATION"] :
      ["CREATE", "ACTIVATE", "REACTIVATE"].includes(op.kind) ? ["VERIFIED_EXACT_IDENTITY_BINDING", "APPROVED_MFA", "NO_RESTORATION_OF_REVOKED_GRANTS"] : []) });
}

export type RequestTransitionResult = PlanningBoundary & (Readonly<{ kind: "TRANSITION"; proposedState: AccessRequestState }> |
  Readonly<{ kind: "REJECTED"; reason: LifecyclePolicyReason }>);

const requestEvents: Readonly<Record<AccessRequestState, readonly AccessRequestEvent[]>> = Object.freeze({
  DRAFT: ["SUBMIT", "CANCEL", "EXPIRE", "SUPERSEDE"],
  SUBMITTED: ["RECORD_APPROVALS", "REJECT", "CANCEL", "EXPIRE", "SUPERSEDE"],
  APPROVED: ["CANCEL", "EXPIRE", "SUPERSEDE"],
  REJECTED: [], CANCELLED: [], EXPIRED: [], SUPERSEDED: [], APPLIED: [],
});

/** Proposes request bookkeeping only. APPLY is deliberately unavailable. */
export function proposeAccessRequestTransition(r: AccessChangeRequest, c: LifecyclePolicyContext, event: AccessRequestEvent, now: number): RequestTransitionResult {
  if (event === "APPLY") return Object.freeze({ ...boundary, kind: "REJECTED", reason: "EXECUTION_UNAVAILABLE" });
  const result = planStaffLifecycle(r, c, now);
  if (!r || !states.includes(r.state)) return reject("INVALID_INPUT");
  if (!requestEvents[r.state].includes(event)) return reject("INVALID_TRANSITION");
  if (event === "REJECT" && result.kind === "REJECTED" && result.reason === "APPROVAL_REJECTED") {
    return Object.freeze({ ...boundary, kind: "TRANSITION", proposedState: "REJECTED" });
  }
  if (event === "EXPIRE" && result.kind === "REJECTED" && result.reason === "REQUEST_EXPIRED") {
    return Object.freeze({ ...boundary, kind: "TRANSITION", proposedState: "EXPIRED" });
  }
  if (result.kind === "REJECTED") return result;
  let next: AccessRequestState | undefined;
  if (event === "SUBMIT" && r.state === "DRAFT") next = "SUBMITTED";
  if (event === "RECORD_APPROVALS" && r.state === "SUBMITTED" && result.quorum === "PRESENT") next = "APPROVED";
  if (event === "CANCEL" || event === "SUPERSEDE") next = event === "CANCEL" ? "CANCELLED" : "SUPERSEDED";
  return next === undefined ? Object.freeze({ ...boundary, kind: "REJECTED", reason: event === "RECORD_APPROVALS" ? "QUORUM_MISSING" : "INVALID_TRANSITION" }) :
    Object.freeze({ ...boundary, kind: "TRANSITION", proposedState: next });
}
