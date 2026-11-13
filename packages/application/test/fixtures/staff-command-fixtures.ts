import { accessChangeRequestDigest, planStaffLifecycle } from "../../src/identity/access-change-policy.js";
import { prepareStaffCommand } from "../../src/identity/staff-command-contracts.js";
import { STAFF_LIFECYCLE_POLICY_VERSION, type AccessChangeRequest, type LifecycleActor, type LifecycleApproval,
  type LifecyclePolicyContext, type StaffLifecycleOperation } from "../../src/identity/staff-lifecycle.js";

export const NOW = Date.UTC(2026, 10, 11, 11);
export const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export function actor(n: number, role: string): LifecycleActor {
  return { staffId: uid(n), status: "ACTIVE", authzVersion: 1n, memberships: [], grants: [{ id: uid(n + 100), staffId: uid(n), roleCode: role,
    scope: { kind: "PLATFORM" }, grantedAtMs: NOW - 1000, expiresAtMs: null, revokedAtMs: null }] };
}
export function commandFixture(kind: StaffLifecycleOperation["kind"] = "ACTIVATE") {
  const operation: StaffLifecycleOperation = kind === "REVOKE" ? { kind, target: "GRANT", grantId: uid(104) } : { kind, target: "STAFF" };
  const request: AccessChangeRequest = { id: uid(50), version: 1n, policyVersion: STAFF_LIFECYCLE_POLICY_VERSION, state: "SUBMITTED", operation,
    scope: { kind: "PLATFORM" }, requesterStaffId: uid(1), targetStaffId: uid(4), expectedAuthzVersion: kind === "CREATE" ? 0n : 1n,
    expectedMembershipVersion: null, proposedRoles: ["ACTIVATE", "REACTIVATE"].includes(kind) ? ["PLATFORM_AUDITOR"] : [],
    createdAtMs: NOW - 2000, expiresAtMs: NOW + 60_000 };
  const context: LifecyclePolicyContext = { currentRequestVersion: 1n, currentRequestDigest: accessChangeRequestDigest(request),
    requester: actor(1, kind === "SUSPEND" ? "SECURITY_ADMIN" : "ACCESS_ADMIN"),
    target: { staffId: uid(4), status: kind === "CREATE" ? "ABSENT" : kind === "ACTIVATE" ? "PENDING" : ["REACTIVATE", "RECOVER"].includes(kind) ? "SUSPENDED" : "ACTIVE",
      authzVersion: request.expectedAuthzVersion, membership: null, grants: kind === "REVOKE" ? actor(4, "PLATFORM_AUDITOR").grants : [] },
    approvers: [actor(2, "SECURITY_ADMIN"), actor(3, "GOVERNANCE_OWNER")], approvals: [], knownTenantIds: [uid(20), uid(21)], objectTenantId: null };
  return refresh({ request, context });
}
export function refresh(f: { request: AccessChangeRequest; context: LifecyclePolicyContext }) {
  const context = { ...f.context, currentRequestDigest: accessChangeRequestDigest(f.request), approvals: [] as readonly LifecycleApproval[] };
  const plan = planStaffLifecycle(f.request, context, NOW);
  if (plan.kind !== "PLAN") throw new Error("Invalid synthetic command fixture");
  context.approvals = plan.requiredApprovals.map((slot) => {
    const approver = context.approvers.find((a) => a.grants.some((g) => g.roleCode === slot))!;
    return { requestId: f.request.id, requestVersion: f.request.version, requestDigest: context.currentRequestDigest, policyVersion: STAFF_LIFECYCLE_POLICY_VERSION,
      slot, approverStaffId: approver.staffId, approverAuthzVersion: approver.authzVersion, decision: "APPROVE", decidedAtMs: NOW - 1000, expiresAtMs: NOW + 30_000 };
  });
  return { request: f.request, context };
}
export function candidate(f = commandFixture(), key = uid(70)) {
  const result = prepareStaffCommand(f.request, f.context, key, NOW);
  if (result.kind !== "CANDIDATE") throw new Error("Synthetic candidate preparation failed");
  return result.command;
}
