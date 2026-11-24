import { canonicalDigest } from "./durable-staff-request.js";
import { classifyLifecycleGrant, validLifecycleTime, type ApprovalSlot, type LifecycleActor } from "./staff-lifecycle.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isId = (value: unknown): value is string => typeof value === "string" && uuid.test(value);
const version = (value: unknown): value is bigint => typeof value === "bigint" && value >= 0n && value <= 9223372036854775807n;
const policy = "platform-staff-v1";
const maxAgeMs = 30 * 60_000;
const proposals = new WeakSet<object>();
const singleQuorum = Object.freeze(["SECURITY_ADMIN"] as const);
const broadQuorum = Object.freeze(["SECURITY_ADMIN", "GOVERNANCE_OWNER"] as const);
const profiles = Object.freeze({
  SUSPEND_STAFF: Object.freeze({ proposedPermission: "platform.staff.suspend", quorum: broadQuorum }),
  REVOKE_SESSION: Object.freeze({ proposedPermission: "platform.sessions.revoke", quorum: singleQuorum }),
  REVOKE_ALL_SESSIONS: Object.freeze({ proposedPermission: "platform.sessions.revoke_all", quorum: broadQuorum }),
} as const);

type CommandKind = keyof typeof profiles;
type StaffTarget = Readonly<{ staffId: string; authzVersion: bigint }>;
type Target =
  | Readonly<{ kind: "REVOKE_SESSION"; staffId: string; authzVersion: bigint; sessionId: string; creationOperationId: string; sessionScope: string }>
  | (StaffTarget & Readonly<{ kind: "SUSPEND_STAFF" | "REVOKE_ALL_SESSIONS"; currentCutoffMs: number | null }>);

export interface PlatformStaffProposal {
  readonly phase: "3D";
  readonly execution: "NOT_AUTHORIZED";
  readonly scope: "PLATFORM";
  readonly requestId: string;
  readonly requestVersion: bigint;
  readonly requesterStaffId: string;
  readonly requesterAuthzVersion: bigint;
  readonly target: Target;
  readonly requestedAtMs: number;
  readonly expiresAtMs: number;
  readonly requestDigest: string;
  readonly proposedPermission: typeof profiles[CommandKind]["proposedPermission"];
  readonly quorum: readonly ApprovalSlot[];
}

function fields(input: unknown, names: readonly string[]): input is Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Reflect.ownKeys(input).length !== names.length) return false;
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return names.every(name => Object.hasOwn(Object.getOwnPropertyDescriptor(input, name) ?? {}, "value"));
}

function targetFields(input: unknown): Target | null {
  const base = ["kind", "staffId", "authzVersion"];
  if (fields(input, [...base, "sessionId", "creationOperationId", "sessionScope"]) && input['kind'] === "REVOKE_SESSION" &&
      isId(input['staffId']) && version(input['authzVersion']) && isId(input['sessionId']) && isId(input['creationOperationId']) &&
      (input['sessionScope'] === "PLATFORM" || isId(input['sessionScope']))) {
    return Object.freeze({ kind: input['kind'], staffId: input['staffId'], authzVersion: input['authzVersion'],
      sessionId: input['sessionId'], creationOperationId: input['creationOperationId'], sessionScope: input['sessionScope'] });
  }
  if (fields(input, [...base, "currentCutoffMs"]) && (input['kind'] === "SUSPEND_STAFF" || input['kind'] === "REVOKE_ALL_SESSIONS") &&
      isId(input['staffId']) && version(input['authzVersion']) &&
      (input['currentCutoffMs'] === null || validLifecycleTime(input['currentCutoffMs']))) {
    return Object.freeze({ kind: input['kind'], staffId: input['staffId'], authzVersion: input['authzVersion'], currentCutoffMs: input['currentCutoffMs'] });
  }
  return null;
}

/** Reconstitute and hash a proposed persisted intent. This produces no command capability. */
export function preparePlatformStaffProposal(input: unknown, nowMs: number): PlatformStaffProposal | null {
  if (!fields(input, ["scope", "requestId", "requestVersion", "requesterStaffId", "requesterAuthzVersion", "target", "requestedAtMs", "expiresAtMs"])) return null;
  const { scope, requestId, requestVersion, requesterStaffId, requesterAuthzVersion, requestedAtMs, expiresAtMs } = input;
  const target = targetFields(input['target']);
  if (scope !== "PLATFORM" || !isId(requestId) || !version(requestVersion) || requestVersion === 0n || !isId(requesterStaffId) || !version(requesterAuthzVersion) ||
      !target || target.staffId === requesterStaffId || !validLifecycleTime(nowMs) || !validLifecycleTime(requestedAtMs) ||
      !validLifecycleTime(expiresAtMs) || requestedAtMs > nowMs || nowMs >= expiresAtMs || expiresAtMs - requestedAtMs > maxAgeMs) return null;
  const { proposedPermission, quorum } = profiles[target.kind];
  const requestDigest = canonicalDigest([policy, scope, requestId, requestVersion, requesterStaffId, requesterAuthzVersion, target, requestedAtMs, expiresAtMs]);
  const proposal: PlatformStaffProposal = Object.freeze({ phase: "3D", execution: "NOT_AUTHORIZED", scope, requestId, requestVersion, requesterStaffId,
    requesterAuthzVersion, target, requestedAtMs, expiresAtMs, requestDigest, proposedPermission, quorum });
  proposals.add(proposal);
  return proposal;
}

export interface PlatformStaffApprovalObservation {
  readonly requestDigest: string;
  readonly reviewerStaffId: string;
  readonly reviewerAuthzVersion: bigint;
  readonly grantId: string;
  readonly decision: "APPROVE" | "REJECT";
  readonly approvedAtMs: number;
  readonly expiresAtMs: number;
  readonly reviewer: LifecycleActor;
}

/** Check trusted, persisted approvals against fresh canonical reviewer records. No effect authority. */
export function hasPlatformStaffProposalQuorum(proposal: PlatformStaffProposal, approvals: readonly PlatformStaffApprovalObservation[], nowMs: number): boolean {
  if (!proposals.has(proposal) || !validLifecycleTime(nowMs) || nowMs < proposal.requestedAtMs || nowMs >= proposal.expiresAtMs ||
      approvals.length !== proposal.quorum.length) return false;
  const people = new Set([proposal.requesterStaffId, proposal.target.staffId]);
  const roles = new Set<string>();
  for (const approval of approvals) {
    const { reviewer, reviewerStaffId, approvedAtMs, expiresAtMs } = approval;
    if (approval.decision !== "APPROVE" || approval.requestDigest !== proposal.requestDigest || !isId(reviewerStaffId) || people.has(reviewerStaffId) ||
        reviewer.staffId !== reviewerStaffId || reviewer.status !== "ACTIVE" || reviewer.authzVersion !== approval.reviewerAuthzVersion ||
        !validLifecycleTime(approvedAtMs) || !validLifecycleTime(expiresAtMs) || approvedAtMs < proposal.requestedAtMs ||
        approvedAtMs > nowMs || expiresAtMs <= nowMs || expiresAtMs > proposal.expiresAtMs) return false;
    const grant = reviewer.grants.find(candidate => candidate.id === approval.grantId);
    if (!grant || grant.staffId !== reviewerStaffId || grant.scope.kind !== "PLATFORM" || roles.has(grant.roleCode) ||
        !proposal.quorum.some(role => role === grant.roleCode) || classifyLifecycleGrant(grant, approvedAtMs) !== "ACTIVE" ||
        classifyLifecycleGrant(grant, nowMs) !== "ACTIVE") return false;
    people.add(reviewerStaffId);
    roles.add(grant.roleCode);
  }
  return true;
}

export interface PlatformStaffCommitObservation {
  readonly request: Readonly<{ id: string; version: bigint; digest: string; scope: string; state: string }>;
  readonly requester: LifecycleActor;
  readonly target: unknown;
  readonly approvals: readonly PlatformStaffApprovalObservation[];
}

/** Compare a canonical observation made inside a future transaction. It does not validate MFA or confer permission. */
export function isPlatformStaffProposalCurrent(proposal: PlatformStaffProposal, current: PlatformStaffCommitObservation, nowMs: number): boolean {
  if (!proposals.has(proposal)) return false;
  const target = targetFields(current.target), request = current.request;
  return target !== null && canonicalDigest(target) === canonicalDigest(proposal.target) &&
    request.scope === proposal.scope && request.state === "APPROVED" && request.id === proposal.requestId &&
    request.version === proposal.requestVersion && request.digest === proposal.requestDigest &&
    current.requester.staffId === proposal.requesterStaffId && current.requester.status === "ACTIVE" &&
    current.requester.authzVersion === proposal.requesterAuthzVersion && hasPlatformStaffProposalQuorum(proposal, current.approvals, nowMs);
}
