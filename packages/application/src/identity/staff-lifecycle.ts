import type { StaffStatus, StaffMembershipStatus } from "./staff-access.js";

export const STAFF_LIFECYCLE_POLICY_VERSION = "staff-lifecycle-v1" as const;
export type LifecycleScope = Readonly<{ kind: "PLATFORM" }> | Readonly<{ kind: "TENANT"; tenantId: string }>;
export type StaffLifecycleOperation =
  | Readonly<{ kind: "CREATE" | "ACTIVATE" | "DISABLE" | "RECOVER"; target: "STAFF" }>
  | Readonly<{ kind: "SUSPEND" | "REACTIVATE"; target: "STAFF" | "MEMBERSHIP" }>
  | Readonly<{ kind: "REVOKE"; target: "MEMBERSHIP" }>
  | Readonly<{ kind: "REVOKE"; target: "GRANT"; grantId: string }>;

/** Every accepted effect selector must be represented in the canonical intent digest. */
export function hasStaffLifecycleOperationFields(operation: StaffLifecycleOperation): boolean {
  const keys = operation.target === "GRANT" ? ["kind", "target", "grantId"] : ["kind", "target"];
  return Reflect.ownKeys(operation).length === keys.length && keys.every(key => Object.hasOwn(operation, key));
}
export type AccessRequestState = "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED" | "CANCELLED" | "EXPIRED" | "SUPERSEDED" | "APPLIED";
export type AccessRequestEvent = "SUBMIT" | "RECORD_APPROVALS" | "REJECT" | "CANCEL" | "EXPIRE" | "SUPERSEDE" | "APPLY";
export type ApprovalSlot = "SECURITY_ADMIN" | "GOVERNANCE_OWNER";

export interface LifecycleGrant {
  readonly id: string;
  readonly staffId: string;
  readonly roleCode: string;
  readonly scope: LifecycleScope;
  readonly grantedAtMs: number;
  readonly expiresAtMs: number | null;
  readonly revokedAtMs: number | null;
}
export interface LifecycleActor {
  /** Canonical internal person ID, shared by all of that person's login bindings. */
  readonly staffId: string;
  readonly status: StaffStatus;
  readonly authzVersion: bigint;
  readonly grants: readonly LifecycleGrant[];
  readonly memberships: readonly Readonly<{ tenantId: string; status: StaffMembershipStatus }>[];
}
export interface LifecycleTarget {
  readonly staffId: string;
  readonly status: StaffStatus | "ABSENT";
  readonly authzVersion: bigint;
  readonly grants: readonly LifecycleGrant[];
  readonly membership: Readonly<{ tenantId: string; status: StaffMembershipStatus; version: bigint }> | null;
}
export interface AccessChangeRequest {
  readonly id: string;
  readonly version: bigint;
  readonly policyVersion: typeof STAFF_LIFECYCLE_POLICY_VERSION;
  readonly state: AccessRequestState;
  readonly operation: StaffLifecycleOperation;
  readonly scope: LifecycleScope;
  readonly requesterStaffId: string;
  readonly targetStaffId: string;
  readonly expectedAuthzVersion: bigint;
  readonly expectedMembershipVersion: bigint | null;
  /** Role intent for planning/classification only; no grant operation is emitted. */
  readonly proposedRoles: readonly string[];
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}
export interface LifecycleApproval {
  readonly requestId: string;
  readonly requestVersion: bigint;
  readonly requestDigest: string;
  readonly policyVersion: typeof STAFF_LIFECYCLE_POLICY_VERSION;
  readonly slot: ApprovalSlot;
  readonly approverStaffId: string;
  readonly approverAuthzVersion: bigint;
  readonly decision: "APPROVE" | "REJECT";
  readonly decidedAtMs: number;
  readonly expiresAtMs: number;
}
export interface LifecyclePolicyContext {
  readonly currentRequestVersion: bigint;
  readonly currentRequestDigest: string;
  readonly requester: LifecycleActor;
  readonly target: LifecycleTarget;
  readonly approvers: readonly LifecycleActor[];
  readonly approvals: readonly LifecycleApproval[];
  readonly knownTenantIds: readonly string[];
  /** Independently resolved target scope, never an assertion from a request. */
  readonly objectTenantId: string | null;
}

export type LifecyclePolicyReason = "INVALID_INPUT" | "STALE_REQUEST" | "REQUEST_EXPIRED" | "INVALID_STATE" |
  "INVALID_SCOPE" | "ROLE_CONFLICT" | "REQUESTER_NOT_AUTHORIZED" | "TARGET_PROTECTED" | "INVALID_TRANSITION" |
  "SELF_APPROVAL" | "DUPLICATE_APPROVER" | "APPROVER_NOT_AUTHORIZED" | "APPROVAL_EXPIRED" |
  "STALE_APPROVAL" | "APPROVAL_REJECTED" | "QUORUM_MISSING" | "EXECUTION_UNAVAILABLE";
export const LIFECYCLE_EXECUTION_BLOCKERS = Object.freeze([
  "ASSURANCE_NOT_ESTABLISHED", "RESERVED_PERMISSION_INACTIVE", "NO_EXECUTOR",
] as const);
export interface PlanningBoundary {
  readonly execution: "NOT_AUTHORIZED";
  readonly executionBlockers: typeof LIFECYCLE_EXECUTION_BLOCKERS;
}
export type LifecyclePolicyResult = PlanningBoundary & (
  | Readonly<{ kind: "REJECTED"; reason: LifecyclePolicyReason }>
  | Readonly<{ kind: "PLAN"; requiredApprovals: readonly ApprovalSlot[]; quorum: "PENDING" | "PRESENT";
      proposedStatus: StaffStatus | StaffMembershipStatus | "REVOKED"; preconditions: readonly string[] }>
);

export function validLifecycleTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

/** No wall clock and no database timestamp-order assumptions. Cancellation may precede validity. */
export function classifyLifecycleGrant(grant: LifecycleGrant, nowMs: number): "FUTURE" | "ACTIVE" | "EXPIRED" | "REVOKED" | "INVALID" {
  if (!validLifecycleTime(nowMs) || !validLifecycleTime(grant.grantedAtMs) ||
      (grant.expiresAtMs !== null && (!validLifecycleTime(grant.expiresAtMs) || grant.expiresAtMs <= grant.grantedAtMs)) ||
      (grant.revokedAtMs !== null && (!validLifecycleTime(grant.revokedAtMs) || grant.revokedAtMs > nowMs))) return "INVALID";
  if (grant.revokedAtMs !== null) return "REVOKED";
  if (grant.grantedAtMs > nowMs) return "FUTURE";
  return grant.expiresAtMs !== null && grant.expiresAtMs <= nowMs ? "EXPIRED" : "ACTIVE";
}
