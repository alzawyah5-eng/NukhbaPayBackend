import assert from "node:assert/strict";
import test from "node:test";
import { accessChangeRequestDigest, planStaffLifecycle, proposeAccessRequestTransition } from "../src/identity/access-change-policy.js";
import { classifyLifecycleGrant, STAFF_LIFECYCLE_POLICY_VERSION, type AccessChangeRequest, type ApprovalSlot, type LifecycleActor,
  type LifecycleApproval, type LifecycleGrant, type LifecyclePolicyContext, type LifecyclePolicyReason, type LifecycleScope,
  type StaffLifecycleOperation } from "../src/identity/staff-lifecycle.js";
import { authorizeStaffAccess } from "../src/identity/staff-access.js";
import { attestVerifiedStaffIdentity } from "../src/identity/verified-staff-identity.js";

const NOW = Date.UTC(2026, 10, 11, 10);
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const platform: LifecycleScope = { kind: "PLATFORM" };
const tenant: LifecycleScope = { kind: "TENANT", tenantId: uid(20) };
function grant(staffId: string, roleCode: string, scope: LifecycleScope = platform, id = uid(100)): LifecycleGrant {
  return { id, staffId, roleCode, scope, grantedAtMs: NOW - 100_000, expiresAtMs: null, revokedAtMs: null };
}
function actor(n: number, role: string, scope: LifecycleScope = platform): LifecycleActor {
  return { staffId: uid(n), status: "ACTIVE", authzVersion: 1n, grants: [grant(uid(n), role, scope)],
    memberships: scope.kind === "TENANT" ? [{ tenantId: scope.tenantId, status: "ACTIVE" }] : [] };
}
type Fixture = { request: AccessChangeRequest; context: LifecyclePolicyContext };
function fixture(operation: StaffLifecycleOperation = { kind: "ACTIVATE", target: "STAFF" }, scope: LifecycleScope = platform): Fixture {
  const request: AccessChangeRequest = { id: uid(50), version: 1n, policyVersion: STAFF_LIFECYCLE_POLICY_VERSION, state: "SUBMITTED", operation, scope,
    requesterStaffId: uid(1), targetStaffId: uid(4), expectedAuthzVersion: operation.kind === "CREATE" ? 0n : 2n,
    expectedMembershipVersion: scope.kind === "TENANT" ? 1n : null, proposedRoles: [], createdAtMs: NOW - 60_000, expiresAtMs: NOW + 600_000 };
  const context: LifecyclePolicyContext = { currentRequestVersion: 1n, currentRequestDigest: accessChangeRequestDigest(request), requester: actor(1, "ACCESS_ADMIN"),
    target: { staffId: uid(4), status: operation.kind === "CREATE" ? "ABSENT" : scope.kind === "TENANT" ? "ACTIVE" :
      ["REACTIVATE", "RECOVER"].includes(operation.kind) ? "SUSPENDED" : operation.kind === "ACTIVATE" ? "PENDING" : "ACTIVE",
      authzVersion: request.expectedAuthzVersion, grants: scope.kind === "TENANT" ? [grant(uid(4), "CATALOG_OPERATOR", scope, uid(104))] : [],
      membership: scope.kind === "TENANT" ? { tenantId: scope.tenantId, status: operation.kind === "REACTIVATE" ? "SUSPENDED" : "ACTIVE", version: 1n } : null },
    approvers: [actor(2, "SECURITY_ADMIN"), actor(3, "GOVERNANCE_OWNER")], approvals: [], knownTenantIds: [uid(20), uid(21)],
    objectTenantId: scope.kind === "TENANT" ? scope.tenantId : null };
  return { request, context };
}
function change(f: Fixture, request: Partial<AccessChangeRequest> = {}, context: Partial<LifecyclePolicyContext> = {}): Fixture {
  const r = { ...f.request, ...request };
  return { request: r, context: { ...f.context, currentRequestDigest: accessChangeRequestDigest(r), ...context } };
}
function approval(f: Fixture, slot: ApprovalSlot = "SECURITY_ADMIN"): LifecycleApproval {
  const approver = f.context.approvers.find((a) => a.grants.some((g) => g.roleCode === slot))!;
  return { requestId: f.request.id, requestVersion: f.request.version, requestDigest: accessChangeRequestDigest(f.request), policyVersion: STAFF_LIFECYCLE_POLICY_VERSION,
    slot, approverStaffId: approver.staffId, approverAuthzVersion: approver.authzVersion, decision: "APPROVE", decidedAtMs: NOW - 30_000, expiresAtMs: NOW + 300_000 };
}
const evaluate = (f: Fixture, now = NOW) => planStaffLifecycle(f.request, f.context, now);
function reason(f: Fixture, expected: LifecyclePolicyReason, now = NOW) {
  const result = evaluate(f, now); assert.equal(result.kind, "REJECTED");
  if (result.kind === "REJECTED") assert.equal(result.reason, expected);
  assert.equal(result.execution, "NOT_AUTHORIZED");
}
function slots(f: Fixture, expected: readonly ApprovalSlot[], status?: string) {
  const result = evaluate(f); assert.equal(result.kind, "PLAN");
  if (result.kind === "PLAN") {
    assert.deepEqual(result.requiredApprovals, expected);
    if (status !== undefined) assert.equal(result.proposedStatus, status);
  }
  assert.equal(result.execution, "NOT_AUTHORIZED"); return result;
}

test("creation proposes PENDING without roles and activation plans independent security approval", () => {
  slots(fixture({ kind: "CREATE", target: "STAFF" }), ["SECURITY_ADMIN"], "PENDING");
  slots(fixture(), ["SECURITY_ADMIN"], "ACTIVE");
  reason(change(fixture({ kind: "CREATE", target: "STAFF" }), { proposedRoles: ["GOVERNANCE_OWNER"] }), "INVALID_INPUT");
  reason(change(fixture({ kind: "CREATE", target: "STAFF" }), {}, { target: { ...fixture().context.target, status: "ACTIVE", authzVersion: 0n } }), "INVALID_TRANSITION");
});
test("every platform role, including auditor, requires separate security and governance approval", () => {
  for (const role of ["PLATFORM_AUDITOR", "GOVERNANCE_OWNER", "SECURITY_ADMIN", "ACCESS_ADMIN"]) {
    slots(change(fixture(), { proposedRoles: [role] }), ["SECURITY_ADMIN", "GOVERNANCE_OWNER"]);
  }
});
test("role intent uses the explicit low-risk list rather than the catalogue privileged flag", () => {
  for (const role of ["SUPPORT_AGENT", "CATALOG_OPERATOR"]) {
    const f = fixture({ kind: "REACTIVATE", target: "MEMBERSHIP" }, tenant);
    slots(change(f, { proposedRoles: [role] }), ["SECURITY_ADMIN"]);
  }
  const f = fixture({ kind: "REACTIVATE", target: "MEMBERSHIP" }, tenant);
  slots(change(f, { proposedRoles: ["PRICING_EDITOR"] }), ["SECURITY_ADMIN", "GOVERNANCE_OWNER"]);
});
test("global reactivation accounts for privileged roles in every tenant", () => {
  const f = fixture({ kind: "REACTIVATE", target: "STAFF" });
  slots(change(f, {}, { target: { ...f.context.target, grants: [grant(uid(4), "PRICING_APPROVER", tenant)] } }), ["SECURITY_ADMIN", "GOVERNANCE_OWNER"], "ACTIVE");
});
test("security containment proposes suspension immediately without making the actor an access administrator", () => {
  const f = fixture({ kind: "SUSPEND", target: "STAFF" });
  slots(change(f, {}, { requester: actor(1, "SECURITY_ADMIN") }), [], "SUSPENDED");
  reason(f, "REQUESTER_NOT_AUTHORIZED");
  reason(change(fixture(), {}, { requester: actor(1, "SECURITY_ADMIN") }), "REQUESTER_NOT_AUTHORIZED");
});
test("tenant administrator containment is confined to an active own-tenant low-risk membership", () => {
  for (const operation of [{ kind: "SUSPEND", target: "MEMBERSHIP" }, { kind: "REVOKE", target: "MEMBERSHIP" }] as const) {
    const f = fixture(operation, tenant);
    slots(change(f, {}, { requester: actor(1, "TENANT_ADMIN", tenant) }), [], operation.kind === "SUSPEND" ? "SUSPENDED" : "REVOKED");
    reason(change(f, {}, { requester: actor(1, "TENANT_ADMIN", { kind: "TENANT", tenantId: uid(21) }) }), "REQUESTER_NOT_AUTHORIZED");
    const requester = actor(1, "TENANT_ADMIN", tenant);
    reason(change(f, {}, { requester: { ...requester, memberships: [{ tenantId: uid(20), status: "REVOKED" }] } }), "REQUESTER_NOT_AUTHORIZED");
  }
});
test("tenant administrators cannot affect protected tenant or platform staff", () => {
  const f = fixture({ kind: "SUSPEND", target: "MEMBERSHIP" }, tenant);
  for (const role of ["TENANT_ADMIN", "CATALOG_REVIEWER", "PRICING_APPROVER", "SECURITY_ADMIN"]) {
    const scope = role === "SECURITY_ADMIN" ? platform : tenant;
    reason(change(f, {}, { requester: actor(1, "TENANT_ADMIN", tenant), target: { ...f.context.target, grants: [grant(uid(4), role, scope)] } }), "TARGET_PROTECTED");
  }
});
test("wrong tenant, unknown tenant and platform-to-tenant scope confusion reject", () => {
  const f = fixture({ kind: "SUSPEND", target: "MEMBERSHIP" }, tenant);
  reason(change(f, {}, { objectTenantId: uid(21) }), "INVALID_SCOPE");
  reason(change(f, {}, { knownTenantIds: [] }), "INVALID_SCOPE");
  reason(change(f, {}, { target: { ...f.context.target, membership: { tenantId: uid(21), status: "ACTIVE", version: 1n } } }), "INVALID_SCOPE");
  reason(change(f, { proposedRoles: ["SECURITY_ADMIN"] }), "INVALID_SCOPE");
  reason(change(fixture(), { proposedRoles: ["TENANT_ADMIN"] }), "INVALID_SCOPE");
  reason(change(f, { operation: { kind: "ACTIVATE", target: "STAFF" } }), "INVALID_SCOPE");
});
test("lifecycle planning rejects extra effect selectors that share an existing request digest", () => {
  const f = change(fixture({ kind: "SUSPEND", target: "STAFF" }), {}, { requester: actor(1, "SECURITY_ADMIN") });
  slots(f, [], "SUSPENDED");
  const operation = { ...f.request.operation, sessionId: uid(77), allSessions: false };
  const scope = { ...f.request.scope, allSessions: true };
  const ambiguousOperation = change(f, { operation }), ambiguousScope = change(f, { scope });
  assert.equal(ambiguousOperation.context.currentRequestDigest, f.context.currentRequestDigest);
  assert.equal(ambiguousScope.context.currentRequestDigest, f.context.currentRequestDigest);
  reason(ambiguousOperation, "INVALID_INPUT");
  reason(ambiguousScope, "INVALID_SCOPE");
  const session = { kind: "REVOKE", target: "SESSION" } as unknown as StaffLifecycleOperation;
  reason(change(f, { operation: session }), "INVALID_SCOPE");
});
test("role conflicts include future and expired unrevoked assignments, but cancellation can resolve them", () => {
  const f = fixture({ kind: "REACTIVATE", target: "MEMBERSHIP" }, tenant);
  for (const time of [{ grantedAtMs: NOW + 1000, expiresAtMs: null }, { grantedAtMs: NOW - 1000, expiresAtMs: NOW }]) {
    const g = { ...grant(uid(4), "CATALOG_REVIEWER", tenant), ...time };
    reason(change(f, {}, { target: { ...f.context.target, grants: [...f.context.target.grants, g] } }), "ROLE_CONFLICT");
  }
  const g = grant(uid(4), "CATALOG_REVIEWER", tenant);
  slots(change(f, {}, { target: { ...f.context.target, grants: [...f.context.target.grants, { ...g, revokedAtMs: NOW - 1 }] } }), ["SECURITY_ADMIN"]);
  const revoke = fixture({ kind: "REVOKE", target: "GRANT", grantId: uid(104) }, tenant);
  slots(change(revoke, {}, { target: { ...revoke.context.target, grants: [...revoke.context.target.grants, g] } }), ["SECURITY_ADMIN", "GOVERNANCE_OWNER"], "REVOKED");
});
test("conflicting platform administrators and pricing role pairs reject", () => {
  reason(change(fixture(), { proposedRoles: ["GOVERNANCE_OWNER", "SECURITY_ADMIN"] }), "ROLE_CONFLICT");
  const f = fixture({ kind: "REACTIVATE", target: "MEMBERSHIP" }, tenant);
  reason(change(f, { proposedRoles: ["PRICING_EDITOR", "PRICING_APPROVER"] }), "ROLE_CONFLICT");
  const requester = actor(1, "ACCESS_ADMIN");
  reason(change(fixture(), {}, { requester: { ...requester, grants: [...requester.grants, grant(uid(1), "SECURITY_ADMIN", platform, uid(101))] } }), "ROLE_CONFLICT");
});
test("revoked, future, expired, inactive and suspended requester authority cannot submit a valid plan", () => {
  const f = fixture();
  for (const partial of [{ revokedAtMs: NOW - 1 }, { grantedAtMs: NOW + 1 }, { expiresAtMs: NOW }]) {
    reason(change(f, {}, { requester: { ...f.context.requester, grants: [{ ...f.context.requester.grants[0]!, ...partial }] } }), "REQUESTER_NOT_AUTHORIZED");
  }
  for (const status of ["PENDING", "SUSPENDED", "DISABLED"] as const) reason(change(f, {}, { requester: { ...f.context.requester, status } }), "REQUESTER_NOT_AUTHORIZED");
});
test("independent approval quorum is planned, but does not authorize execution", () => {
  const f = change(fixture(), { proposedRoles: ["PLATFORM_AUDITOR"] });
  const pending = slots(change(f, {}, { approvals: [approval(f)] }), ["SECURITY_ADMIN", "GOVERNANCE_OWNER"]);
  if (pending.kind === "PLAN") assert.equal(pending.quorum, "PENDING");
  const complete = slots(change(f, {}, { approvals: [approval(f), approval(f, "GOVERNANCE_OWNER")] }), ["SECURITY_ADMIN", "GOVERNANCE_OWNER"]);
  if (complete.kind === "PLAN") assert.equal(complete.quorum, "PRESENT");
  assert.deepEqual(complete.executionBlockers, ["ASSURANCE_NOT_ESTABLISHED", "RESERVED_PERMISSION_INACTIVE", "NO_EXECUTOR"]);
});
test("requester and beneficiary cannot approve; one staff person cannot fill both slots", () => {
  const f = change(fixture(), { proposedRoles: ["PLATFORM_AUDITOR"] }); const a = approval(f);
  for (const person of [uid(1), uid(4)]) reason(change(f, {}, { approvals: [{ ...a, approverStaffId: person }] }), "SELF_APPROVAL");
  reason(change(f, {}, { approvals: [a, { ...a, slot: "GOVERNANCE_OWNER" }] }), "DUPLICATE_APPROVER");
  reason(change(f, {}, { approvals: [a, a] }), "DUPLICATE_APPROVER");
});
test("approver authority is fresh, active and scoped to its exact platform approval role", () => {
  const f = fixture(); const a = approval(f); const security = f.context.approvers[0]!;
  for (const actor of [{ ...security, status: "SUSPENDED" as const }, { ...security, grants: [grant(uid(2), "TENANT_ADMIN", tenant)] },
    { ...security, grants: [{ ...security.grants[0]!, grantedAtMs: NOW + 1 }] }, { ...security, grants: [{ ...security.grants[0]!, revokedAtMs: NOW }] }]) {
    reason(change(f, {}, { approvals: [a], approvers: [actor] }), "APPROVER_NOT_AUTHORIZED");
  }
  reason(change(f, {}, { approvals: [a], approvers: [{ ...security, authzVersion: 2n }] }), "STALE_APPROVAL");
});
test("request version, target authority and membership version mismatches reject", () => {
  const f = fixture();
  reason(change(f, {}, { currentRequestVersion: 2n }), "STALE_REQUEST");
  reason(change(f, {}, { target: { ...f.context.target, authzVersion: 3n } }), "STALE_REQUEST");
  const t = fixture({ kind: "REACTIVATE", target: "MEMBERSHIP" }, tenant);
  reason(change(t, {}, { target: { ...t.context.target, membership: { ...t.context.target.membership!, version: 2n } } }), "STALE_REQUEST");
});
test("material payload edits invalidate both the stored intent and existing approval records", () => {
  const f = change(fixture(), { proposedRoles: ["GOVERNANCE_OWNER"] }); const a = approval(f);
  const edited = { ...f.request, proposedRoles: ["SECURITY_ADMIN"] };
  reason({ request: edited, context: f.context }, "STALE_REQUEST");
  reason(change(f, { proposedRoles: ["SECURITY_ADMIN"] }, { approvals: [a] }), "STALE_APPROVAL");
  reason(change(f, { expiresAtMs: f.request.expiresAtMs - 1 }, { approvals: [a] }), "STALE_APPROVAL");
  assert.equal(accessChangeRequestDigest({ ...f.request, state: "APPROVED" }), accessChangeRequestDigest(f.request));
});
test("request and approval expiry boundaries and invalid times reject deterministically", () => {
  const f = fixture(); const a = approval(f);
  reason(f, "REQUEST_EXPIRED", f.request.expiresAtMs);
  reason(change(f, { createdAtMs: NOW + 1 }), "INVALID_INPUT");
  reason(change(f, { expiresAtMs: NOW + 1_800_001 }), "INVALID_INPUT");
  reason(change(f, {}, { approvals: [{ ...a, expiresAtMs: NOW }] }), "APPROVAL_EXPIRED");
  reason(change(f, {}, { approvals: [{ ...a, decidedAtMs: NOW + 1 }] }), "INVALID_INPUT");
  reason(change(f, {}, { approvals: [{ ...a, expiresAtMs: f.request.expiresAtMs + 1 }] }), "INVALID_INPUT");
  reason(f, "INVALID_INPUT", Number.NaN);
});
test("future-dated grant cancellation preserves actual time rather than moving revocation into the future", () => {
  const g = { ...grant(uid(4), "CATALOG_OPERATOR", tenant, uid(104)), grantedAtMs: NOW + 10_000 };
  assert.equal(classifyLifecycleGrant(g, NOW), "FUTURE");
  assert.equal(classifyLifecycleGrant({ ...g, revokedAtMs: NOW }, NOW), "REVOKED");
  assert.equal(classifyLifecycleGrant({ ...g, revokedAtMs: NOW + 1 }, NOW), "INVALID");
  const f = fixture({ kind: "REVOKE", target: "GRANT", grantId: uid(104) }, tenant);
  slots(change(f, {}, { target: { ...f.context.target, grants: [g] } }), ["SECURITY_ADMIN"], "REVOKED");
  reason(change(f, {}, { target: { ...f.context.target, grants: [{ ...g, revokedAtMs: NOW }] } }), "INVALID_TRANSITION");
});
test("grant lifecycle boundaries do not turn expiry or future scheduling into authority", () => {
  const g = grant(uid(4), "CATALOG_OPERATOR", tenant);
  assert.equal(classifyLifecycleGrant(g, NOW), "ACTIVE");
  assert.equal(classifyLifecycleGrant({ ...g, expiresAtMs: NOW }, NOW), "EXPIRED");
  assert.equal(classifyLifecycleGrant({ ...g, expiresAtMs: g.grantedAtMs }, NOW), "INVALID");
  const f = fixture({ kind: "REVOKE", target: "GRANT", grantId: uid(104) }, tenant);
  reason(change(f, { operation: { kind: "REVOKE", target: "GRANT", grantId: uid(999) } }), "INVALID_SCOPE");
});
test("recovery stays suspended, disable is terminal and revoked membership is not silently restored", () => {
  slots(fixture({ kind: "RECOVER", target: "STAFF" }), ["SECURITY_ADMIN", "GOVERNANCE_OWNER"], "SUSPENDED");
  slots(fixture({ kind: "DISABLE", target: "STAFF" }), ["SECURITY_ADMIN", "GOVERNANCE_OWNER"], "DISABLED");
  const f = fixture({ kind: "REACTIVATE", target: "STAFF" });
  reason(change(f, {}, { target: { ...f.context.target, status: "DISABLED" } }), "INVALID_TRANSITION");
  const t = fixture({ kind: "REACTIVATE", target: "MEMBERSHIP" }, tenant);
  reason(change(t, {}, { target: { ...t.context.target, membership: { ...t.context.target.membership!, status: "REVOKED" } } }), "INVALID_TRANSITION");
});
test("request bookkeeping transitions are explicit and APPLY is unavailable for every state", () => {
  const f = fixture(); const complete = change(f, {}, { approvals: [approval(f)] });
  assert.equal(proposeAccessRequestTransition(change(f, { state: "DRAFT" }).request, f.context, "SUBMIT", NOW).kind, "TRANSITION");
  for (const [event, target] of [["RECORD_APPROVALS", "APPROVED"], ["CANCEL", "CANCELLED"], ["SUPERSEDE", "SUPERSEDED"]] as const) {
    const result = proposeAccessRequestTransition(complete.request, complete.context, event, NOW);
    assert.equal(result.kind, "TRANSITION"); if (result.kind === "TRANSITION") assert.equal(result.proposedState, target);
  }
  const negative = change(f, {}, { approvals: [{ ...approval(f), decision: "REJECT" }] });
  const rejected = proposeAccessRequestTransition(negative.request, negative.context, "REJECT", NOW);
  assert.equal(rejected.kind, "TRANSITION"); if (rejected.kind === "TRANSITION") assert.equal(rejected.proposedState, "REJECTED");
  const expired = proposeAccessRequestTransition(f.request, f.context, "EXPIRE", f.request.expiresAtMs);
  assert.equal(expired.kind, "TRANSITION"); if (expired.kind === "TRANSITION") assert.equal(expired.proposedState, "EXPIRED");
  for (const state of ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "CANCELLED", "EXPIRED", "SUPERSEDED", "APPLIED"] as const) {
    const current = change(complete, { state });
    const result = proposeAccessRequestTransition(current.request, current.context, "APPLY", NOW);
    assert.deepEqual(result, { kind: "REJECTED", reason: "EXECUTION_UNAVAILABLE", execution: "NOT_AUTHORIZED",
      executionBlockers: ["ASSURANCE_NOT_ESTABLISHED", "RESERVED_PERMISSION_INACTIVE", "NO_EXECUTOR"] });
    if (["REJECTED", "CANCELLED", "EXPIRED", "SUPERSEDED", "APPLIED"].includes(state)) reason(current, "INVALID_STATE");
  }
});
test("missing quorum, fabricated APPROVED state and invalid transition events reject", () => {
  const f = fixture(); reason(change(f, { state: "APPROVED" }), "QUORUM_MISSING");
  assert.equal(proposeAccessRequestTransition(f.request, f.context, "RECORD_APPROVALS", NOW).kind, "REJECTED");
  assert.equal(proposeAccessRequestTransition(f.request, f.context, "SUBMIT", NOW).kind, "REJECTED");
  assert.equal(proposeAccessRequestTransition(f.request, f.context, "REJECT", NOW).kind, "REJECTED");
  reason(change(f, { state: "DRAFT" }, { approvals: [approval(f)] }), "INVALID_STATE");
  const declinedApproved = change(f, { state: "APPROVED" }, { approvals: [{ ...approval(f), decision: "REJECT" }] });
  const result = proposeAccessRequestTransition(declinedApproved.request, declinedApproved.context, "REJECT", NOW);
  assert.equal(result.kind, "REJECTED"); if (result.kind === "REJECTED") assert.equal(result.reason, "INVALID_TRANSITION");
});
test("all state/event edges are enumerated, terminal states stay terminal and incomplete approval cannot advance", () => {
  const f = fixture();
  const approved = change(f, {}, { approvals: [approval(f)] });
  const expected: Record<string, readonly string[]> = {
    DRAFT: ["SUBMIT", "CANCEL", "SUPERSEDE"], SUBMITTED: ["RECORD_APPROVALS", "CANCEL", "SUPERSEDE"],
    APPROVED: ["CANCEL", "SUPERSEDE"], REJECTED: [], CANCELLED: [], EXPIRED: [], SUPERSEDED: [], APPLIED: [],
  };
  for (const state of ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "CANCELLED", "EXPIRED", "SUPERSEDED", "APPLIED"] as const) {
    const current = state === "DRAFT" ? change(f, { state }) : change(approved, { state });
    for (const event of ["SUBMIT", "RECORD_APPROVALS", "REJECT", "CANCEL", "SUPERSEDE", "EXPIRE", "APPLY"] as const) {
      const result = proposeAccessRequestTransition(current.request, current.context, event, NOW);
      assert.equal(result.kind, expected[state]!.includes(event) ? "TRANSITION" : "REJECTED", state + ":" + event);
    }
  }
});
test("self-containment and malformed operation-target combinations cannot create a plan", () => {
  const f = fixture({ kind: "REVOKE", target: "MEMBERSHIP" }, tenant);
  const self = change(f, { requesterStaffId: uid(4) }, { requester: actor(4, "ACCESS_ADMIN") });
  reason(self, "SELF_APPROVAL");
  const bad = change(f, { operation: { kind: "DISABLE", target: "MEMBERSHIP" } as unknown as StaffLifecycleOperation });
  reason(bad, "INVALID_SCOPE");
});
test("malformed snapshots, unknown roles, aliases and excessive input fail closed without echoing input", () => {
  const f = fixture();
  reason(change(f, { proposedRoles: ["UNRECOGNIZED_ROLE"] }), "INVALID_SCOPE");
  reason(change(f, { proposedRoles: ["PLATFORM_AUDITOR", "PLATFORM_AUDITOR"] }), "INVALID_INPUT");
  reason(change(f, {}, { approvers: [f.context.approvers[0]!, f.context.approvers[0]!] }), "INVALID_INPUT");
  reason(change(f, {}, { requester: { ...f.context.requester, grants: [{ ...f.context.requester.grants[0]!, staffId: uid(999) }] } }), "INVALID_INPUT");
  const malformed = { ...f.request, operation: { kind: "private-input-marker", target: "STAFF" } } as unknown as AccessChangeRequest;
  const result = planStaffLifecycle(malformed, { ...f.context, currentRequestDigest: accessChangeRequestDigest(malformed) }, NOW);
  assert.equal(result.kind, "REJECTED"); assert.equal(JSON.stringify(result).includes("private-input-marker"), false);
  assert.equal(planStaffLifecycle(null as unknown as AccessChangeRequest, f.context, NOW).kind, "REJECTED");
});
test("results are minimal immutable plans and input snapshots are not mutated", () => {
  const f = fixture(); const before = structuredClone(f); const result = evaluate(f);
  assert.deepEqual(f, before); assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.executionBlockers));
  if (result.kind === "PLAN") {
    assert.deepEqual(Object.keys(result).sort(), ["execution", "executionBlockers", "kind", "preconditions", "proposedStatus", "quorum", "requiredApprovals"]);
    assert.ok(Object.isFrozen(result.preconditions)); assert.ok(Object.isFrozen(result.requiredApprovals));
    assert.throws(() => (result.requiredApprovals as string[]).push("GOVERNANCE_OWNER"), TypeError);
  }
  for (const value of [f.request.id, f.request.targetStaffId, f.request.requesterStaffId]) assert.equal(JSON.stringify(result).includes(value), false);
});
test("not-established authentication assurance and reserved permissions never become execution authority", () => {
  const identity = attestVerifiedStaffIdentity({ issuer: "https://staff.synthetic.invalid/", subject: "synthetic-person",
    security: { audience: "urn:synthetic:staff", clientId: "synthetic-client", profile: "rfc9068-staff-v1", principalKind: "human",
      issuedAt: NOW / 1000, expiresAt: NOW / 1000 + 300, assurance: "not-established" } });
  const f = fixture(); const plan = evaluate(change(f, {}, { approvals: [approval(f)] }));
  assert.equal(identity.security.assurance, "not-established"); assert.equal(plan.execution, "NOT_AUTHORIZED");
  assert.ok(plan.executionBlockers.includes("ASSURANCE_NOT_ESTABLISHED"));
  for (const permissionCode of ["platform.staff.suspend", "platform.sessions.revoke"]) {
    const decision = authorizeStaffAccess({ principal: { staffId: uid(2), staffStatus: "ACTIVE", identityStatus: "ACTIVE", tokensValidAfter: null, authzVersion: 1n }, membership: null,
      platformRoleGrants: [{ roleCode: "SECURITY_ADMIN", scope: "PLATFORM", grantedAt: new Date(NOW - 1000).toISOString(), expiresAt: null, revokedAt: null }] },
      { permissionCode, scope: "PLATFORM", now: new Date(NOW).toISOString() });
    assert.deepEqual(decision, { allowed: false, reason: "PERMISSION_INACTIVE" });
  }
});
