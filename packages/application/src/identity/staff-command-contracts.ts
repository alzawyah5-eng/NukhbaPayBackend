import { createHash } from "node:crypto";
import { accessChangeRequestDigest, planStaffLifecycle } from "./access-change-policy.js";
import { LIFECYCLE_EXECUTION_BLOCKERS, validLifecycleTime, type AccessChangeRequest, type LifecyclePolicyContext,
  type LifecyclePolicyReason, type LifecycleScope, type PlanningBoundary, type StaffLifecycleOperation } from "./staff-lifecycle.js";

const brand: unique symbol = Symbol("StaffCommandCandidate");
const candidates = new WeakSet<object>();
const boundary: PlanningBoundary = Object.freeze({ execution: "NOT_AUTHORIZED", executionBlockers: LIFECYCLE_EXECUTION_BLOCKERS });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hex = /^[0-9a-f]{64}$/;
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const operationId = (actor: string, key: string): string => hash(["staff-command-v1", "LOCAL_SYNTHETIC", actor, key]);
const sameScope = (a: LifecycleScope, b: LifecycleScope): boolean => a.kind === b.kind &&
  (a.kind === "PLATFORM" || (b.kind === "TENANT" && a.tenantId === b.tenantId));

export interface StaffCommandCandidate extends PlanningBoundary {
  readonly [brand]: true;
  readonly recordKind: "SIMULATION_ONLY";
  readonly contractVersion: "staff-command-v1";
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly actorStaffId: string;
  readonly targetStaffId: string;
  readonly requestId: string;
  readonly requestVersion: bigint;
  readonly requestDigest: string;
  readonly commandDigest: string;
  readonly approvalDigest: string;
  readonly operation: StaffLifecycleOperation;
  readonly scope: LifecycleScope;
  readonly roleCodes: readonly string[];
  readonly proposedStatus: "PENDING" | "ACTIVE" | "SUSPENDED" | "DISABLED" | "REVOKED";
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}
export type StaffCommandPreparation = PlanningBoundary & (
  Readonly<{ kind: "CANDIDATE"; command: StaffCommandCandidate }> |
  Readonly<{ kind: "REJECTED"; reason: LifecyclePolicyReason | "INVALID_IDEMPOTENCY_KEY" }>
);

/** Pure proposal only; existing policy is re-evaluated and its blockers are never removed. */
export function prepareStaffCommand(request: AccessChangeRequest, context: LifecyclePolicyContext, key: string, nowMs: number): StaffCommandPreparation {
  if (typeof key !== "string" || !uuid.test(key)) return Object.freeze({ ...boundary, kind: "REJECTED", reason: "INVALID_IDEMPOTENCY_KEY" });
  const plan = planStaffLifecycle(request, context, nowMs);
  if (plan.kind === "REJECTED") return plan;
  if (request.state !== "SUBMITTED" && request.state !== "APPROVED") return Object.freeze({ ...boundary, kind: "REJECTED", reason: "INVALID_STATE" });
  const op = request.operation;
  const operation: StaffLifecycleOperation = Object.freeze(op.target === "GRANT"
    ? { kind: op.kind, target: op.target, grantId: op.grantId } : { kind: op.kind, target: op.target }) as StaffLifecycleOperation;
  const scope: LifecycleScope = Object.freeze(request.scope.kind === "PLATFORM" ? { kind: "PLATFORM" } : { kind: "TENANT", tenantId: request.scope.tenantId });
  const approvalDigest = hash(context.approvals.map((a) => [a.slot, a.approverStaffId, a.approverAuthzVersion.toString(),
    a.requestId, a.requestVersion.toString(), a.requestDigest, a.policyVersion, a.decision, a.decidedAtMs, a.expiresAtMs])
    .sort((a, b) => { const left = JSON.stringify(a); const right = JSON.stringify(b); return left < right ? -1 : left > right ? 1 : 0; }));
  const requestDigest = accessChangeRequestDigest(request);
  const id = operationId(request.requesterStaffId, key);
  const candidate = { ...boundary, recordKind: "SIMULATION_ONLY" as const, contractVersion: "staff-command-v1" as const,
    operationId: id, idempotencyKey: key, actorStaffId: request.requesterStaffId, targetStaffId: request.targetStaffId,
    requestId: request.id, requestVersion: request.version, requestDigest, approvalDigest,
    commandDigest: hash(["staff-command-v1", id, requestDigest, approvalDigest]), operation, scope,
    roleCodes: Object.freeze([...request.proposedRoles].sort()), proposedStatus: plan.proposedStatus, createdAtMs: request.createdAtMs, expiresAtMs: request.expiresAtMs };
  Object.defineProperty(candidate, brand, { value: true }); candidates.add(candidate);
  return Object.freeze({ ...boundary, kind: "CANDIDATE", command: Object.freeze(candidate) as StaffCommandCandidate });
}

const auditNames = Object.freeze({ CREATE: "STAFF_CREATE_INTENT", ACTIVATE: "STAFF_ACTIVATE_INTENT", SUSPEND: "STAFF_SUSPEND_INTENT",
  REVOKE: "STAFF_REVOKE_INTENT", REACTIVATE: "STAFF_REACTIVATE_INTENT", DISABLE: "STAFF_DISABLE_INTENT", RECOVER: "STAFF_RECOVER_INTENT" } as const);
export type StaffCommandAuditName = typeof auditNames[keyof typeof auditNames];
export interface StaffMutationIntent extends PlanningBoundary {
  readonly recordKind: "SIMULATION_ONLY";
  readonly operationId: string;
  readonly commandDigest: string;
  readonly targetStaffId: string;
  readonly operation: StaffLifecycleOperation;
  readonly scope: LifecycleScope;
  readonly proposedStatus: StaffCommandCandidate["proposedStatus"];
}
export interface StaffCommandAuditIntent extends PlanningBoundary {
  readonly recordKind: "SIMULATION_ONLY";
  readonly eventId: string;
  readonly eventName: StaffCommandAuditName;
  readonly operationId: string;
  readonly commandDigest: string;
  readonly requestId: string;
  readonly actorStaffId: string;
  readonly targetStaffId: string;
  readonly scope: LifecycleScope;
  readonly roleCodes: readonly string[];
  readonly occurredAtMs: number;
}
export interface StaffCommandReceipt extends PlanningBoundary {
  readonly recordKind: "SIMULATION_ONLY";
  readonly outcome: "SIMULATION_RECORDED";
  readonly operationId: string;
  readonly commandDigest: string;
  readonly actorStaffId: string;
  readonly targetStaffId: string;
  readonly scope: LifecycleScope;
  readonly auditEventId: string;
  readonly recordedAtMs: number;
}
export interface StaffCommandBundle extends PlanningBoundary {
  readonly mutationIntent: StaffMutationIntent;
  readonly auditIntent: StaffCommandAuditIntent;
  readonly receipt: StaffCommandReceipt;
}
export class StaffCommandContractError extends Error {
  constructor() { super("Invalid staff command contract"); }
}

/** Describes an atomic simulation bundle, never performs staff mutation or audit persistence. */
export function describeStaffCommandBundle(command: StaffCommandCandidate, nowMs: number): StaffCommandBundle {
  if (!candidates.has(command) || !validLifecycleTime(nowMs) || nowMs < command.createdAtMs || nowMs >= command.expiresAtMs) throw new StaffCommandContractError();
  const eventId = hash(["staff-audit-intent-v1", command.operationId, command.commandDigest]);
  const mutationIntent: StaffMutationIntent = Object.freeze({ ...boundary, recordKind: "SIMULATION_ONLY", operationId: command.operationId,
    commandDigest: command.commandDigest, targetStaffId: command.targetStaffId, operation: command.operation, scope: command.scope, proposedStatus: command.proposedStatus });
  const auditIntent: StaffCommandAuditIntent = Object.freeze({ ...boundary, recordKind: "SIMULATION_ONLY", eventId,
    eventName: auditNames[command.operation.kind], operationId: command.operationId, commandDigest: command.commandDigest,
    requestId: command.requestId, actorStaffId: command.actorStaffId, targetStaffId: command.targetStaffId,
    scope: command.scope, roleCodes: command.roleCodes, occurredAtMs: nowMs });
  const receipt: StaffCommandReceipt = Object.freeze({ ...boundary, recordKind: "SIMULATION_ONLY", outcome: "SIMULATION_RECORDED",
    operationId: command.operationId, commandDigest: command.commandDigest, actorStaffId: command.actorStaffId,
    targetStaffId: command.targetStaffId, scope: command.scope, auditEventId: eventId, recordedAtMs: nowMs });
  return Object.freeze({ ...boundary, mutationIntent, auditIntent, receipt });
}

export interface StaffReceiptLookup {
  readonly actorStaffId: string;
  readonly idempotencyKey: string;
  readonly operationId: string;
  readonly expectedCommandDigest: string;
  readonly targetStaffId: string;
  readonly scope: LifecycleScope;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}
export function staffReceiptLookup(command: StaffCommandCandidate): StaffReceiptLookup {
  if (!candidates.has(command)) throw new StaffCommandContractError();
  return Object.freeze({ actorStaffId: command.actorStaffId, idempotencyKey: command.idempotencyKey,
    operationId: command.operationId, expectedCommandDigest: command.commandDigest, targetStaffId: command.targetStaffId, scope: command.scope,
    createdAtMs: command.createdAtMs, expiresAtMs: command.expiresAtMs });
}
export type StaffReceiptResolution = PlanningBoundary & (
  Readonly<{ kind: "RECORDED_SIMULATION"; receipt: StaffCommandReceipt }> |
  Readonly<{ kind: "NOT_FOUND"; retryRequiresReservation: true }> |
  Readonly<{ kind: "CONFLICT" | "INVALID_LOOKUP" | "INVALID_RECEIPT" }>
);

/** Internal lookup hints are not proof of actor authentication or receipt durability. */
export function resolveStaffReceipt(lookup: StaffReceiptLookup, receipt: StaffCommandReceipt | null): StaffReceiptResolution {
  let validLookup = false;
  try {
    if (!uuid.test(lookup.actorStaffId) || !uuid.test(lookup.idempotencyKey) || !uuid.test(lookup.targetStaffId) || !hex.test(lookup.expectedCommandDigest) ||
        (lookup.scope.kind === "PLATFORM" ? "tenantId" in lookup.scope : lookup.scope.kind !== "TENANT" || !uuid.test(lookup.scope.tenantId)) ||
        !validLifecycleTime(lookup.createdAtMs) || !validLifecycleTime(lookup.expiresAtMs) || lookup.expiresAtMs <= lookup.createdAtMs ||
        lookup.operationId !== operationId(lookup.actorStaffId, lookup.idempotencyKey)) return Object.freeze({ ...boundary, kind: "INVALID_LOOKUP" });
    validLookup = true;
    if (receipt === null || receipt.actorStaffId !== lookup.actorStaffId || receipt.operationId !== lookup.operationId) {
      return Object.freeze({ ...boundary, kind: "NOT_FOUND", retryRequiresReservation: true });
    }
    if (receipt.recordKind !== "SIMULATION_ONLY" || receipt.outcome !== "SIMULATION_RECORDED" || receipt.execution !== "NOT_AUTHORIZED" ||
        !validLifecycleTime(receipt.recordedAtMs) || !uuid.test(receipt.targetStaffId) || !hex.test(receipt.commandDigest) ||
        receipt.auditEventId !== hash(["staff-audit-intent-v1", receipt.operationId, receipt.commandDigest]) ||
        (receipt.scope.kind === "PLATFORM" ? "tenantId" in receipt.scope : receipt.scope.kind !== "TENANT" || !uuid.test(receipt.scope.tenantId))) {
      return Object.freeze({ ...boundary, kind: "INVALID_RECEIPT" });
    }
    if (receipt.commandDigest !== lookup.expectedCommandDigest) return Object.freeze({ ...boundary, kind: "CONFLICT" });
    if (receipt.targetStaffId !== lookup.targetStaffId || !sameScope(receipt.scope, lookup.scope) || receipt.recordedAtMs < lookup.createdAtMs ||
        receipt.recordedAtMs >= lookup.expiresAtMs) return Object.freeze({ ...boundary, kind: "INVALID_RECEIPT" });
    // Reconstruct an allowlisted immutable value; never return adapter-provided extra fields.
    const scope: LifecycleScope = Object.freeze(receipt.scope.kind === "PLATFORM" ? { kind: "PLATFORM" } : { kind: "TENANT", tenantId: receipt.scope.tenantId });
    const safe: StaffCommandReceipt = Object.freeze({ ...boundary, recordKind: "SIMULATION_ONLY", outcome: "SIMULATION_RECORDED", operationId: receipt.operationId,
      commandDigest: receipt.commandDigest, actorStaffId: receipt.actorStaffId, targetStaffId: receipt.targetStaffId, scope,
      auditEventId: receipt.auditEventId, recordedAtMs: receipt.recordedAtMs });
    return Object.freeze({ ...boundary, kind: "RECORDED_SIMULATION", receipt: safe });
  } catch { return Object.freeze({ ...boundary, kind: validLookup ? "INVALID_RECEIPT" : "INVALID_LOOKUP" }); }
}

