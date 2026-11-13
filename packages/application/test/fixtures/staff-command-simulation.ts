import { describeStaffCommandBundle, resolveStaffReceipt, staffReceiptLookup, type StaffCommandCandidate, type StaffCommandBundle,
  type StaffMutationIntent, type StaffCommandAuditIntent, type StaffCommandReceipt } from "../../src/identity/staff-command-contracts.js";
import type { StaffSimulationBoundary, StaffSimulationTransaction, StaffBoundaryLookup } from "../../src/identity/staff-command-ports.js";
import { LIFECYCLE_EXECUTION_BLOCKERS, type PlanningBoundary } from "../../src/identity/staff-lifecycle.js";

const boundary: PlanningBoundary = Object.freeze({ execution: "NOT_AUTHORIZED", executionBlockers: LIFECYCLE_EXECUTION_BLOCKERS });
export type FailurePoint = "BEGIN" | "AFTER_READ" | "AFTER_INTENT" | "AFTER_AUDIT" | "AFTER_RECEIPT" | "BEFORE_COMMIT" | "ROLLBACK" |
  "ACK_LOST_AFTER_COMMIT" | "ACK_LOST_WITHOUT_COMMIT";
export type SimulationOutcome = PlanningBoundary & (
  Readonly<{ kind: "RECORDED" | "REPLAYED"; receipt: StaffCommandReceipt }> |
  Readonly<{ kind: "REJECTED"; reason: "IDEMPOTENCY_CONFLICT" | "INVALID_RECEIPT" }> |
  Readonly<{ kind: "FAILED"; stage: string }> |
  Readonly<{ kind: "UNCERTAIN"; operationId: string; lookupRequired: true }>
);
/** Test-only model: publishes immutable intent bundles, never staff records. */
export class InMemoryStaffSimulation implements StaffSimulationBoundary {
  private readonly bundles = new Map<string, StaffCommandBundle>();
  private readonly tails = new Map<string, Promise<void>>();
  lookupUnavailable = false;
  constructor(private readonly now: () => number) {}
  stats() { return Object.freeze({ intents: this.bundles.size, audits: this.bundles.size, receipts: this.bundles.size, reservations: this.tails.size }); }
  async lookup(lookup: Parameters<StaffSimulationBoundary["lookup"]>[0]): Promise<StaffBoundaryLookup> {
    if (this.lookupUnavailable) return Object.freeze({ ...boundary, kind: "LOOKUP_UNAVAILABLE" });
    const result = resolveStaffReceipt(lookup, this.bundles.get(lookup.operationId)?.receipt ?? null);
    return result.kind === "NOT_FOUND" && this.tails.has(lookup.operationId) ? Object.freeze({ ...boundary, kind: "PENDING" }) : result;
  }
  async begin(command: StaffCommandCandidate): Promise<StaffSimulationTransaction> {
    // Only an original immutable candidate can reserve a key; clones are not authorization proof.
    const lookup = staffReceiptLookup(command);
    const previous = this.tails.get(command.operationId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate); this.tails.set(command.operationId, tail);
    await previous;
    let phase: "NEW" | "READ" | "INTENT" | "AUDIT" | "RECEIPT" | "CLOSED" = "NEW";
    let empty = false;
    let mutationIntent: StaffMutationIntent | undefined;
    let auditIntent: StaffCommandAuditIntent | undefined;
    let receipt: StaffCommandReceipt | undefined;
    const close = () => {
      phase = "CLOSED"; mutationIntent = undefined; auditIntent = undefined; receipt = undefined;
      release(); if (this.tails.get(command.operationId) === tail) this.tails.delete(command.operationId);
    };
    const requirePhase = (expected: typeof phase) => { if (phase !== expected) throw new Error("Invalid simulation transaction stage"); };
    return {
      execution: "NOT_AUTHORIZED",
      inspectReceipt: async () => {
        requirePhase("NEW"); phase = "READ";
        const result = resolveStaffReceipt(lookup, this.bundles.get(command.operationId)?.receipt ?? null);
        empty = result.kind === "NOT_FOUND"; return result;
      },
      stageIntent: async (intent) => { requirePhase("READ"); if (!empty) throw new Error("Receipt already exists"); mutationIntent = intent; phase = "INTENT"; },
      stageAudit: async (audit) => { requirePhase("INTENT"); auditIntent = audit; phase = "AUDIT"; },
      stageReceipt: async (value) => { requirePhase("AUDIT"); receipt = value; phase = "RECEIPT"; },
      commit: async () => {
        requirePhase("RECEIPT");
        if (!mutationIntent || !auditIntent || !receipt || this.now() >= command.expiresAtMs) throw new Error("Incomplete or expired simulation");
        const expected = describeStaffCommandBundle(command, receipt.recordedAtMs);
        const staged = { ...boundary, mutationIntent, auditIntent, receipt };
        if (JSON.stringify(staged) !== JSON.stringify(expected)) throw new Error("Simulation bundle binding mismatch");
        // One synchronous publication: readers can observe either no bundle or the entire tuple.
        this.bundles.set(command.operationId, expected);
        const recorded = expected.receipt; close();
        return Object.freeze({ ...boundary, kind: "ACKNOWLEDGED_SIMULATION", receipt: recorded });
      },
      rollback: async () => { if (phase !== "CLOSED") close(); },
    };
  }
  async simulate(command: StaffCommandCandidate, options: { failure?: FailurePoint; beforeCommit?: () => Promise<void> } = {}): Promise<SimulationOutcome> {
    let transaction: StaffSimulationTransaction | undefined; let stage = "BEGIN";
    const fault = (point: FailurePoint) => { stage = point; if (options.failure === point) throw new Error("synthetic private failure detail"); };
    try {
      fault("BEGIN"); transaction = await this.begin(command);
      const previous = await transaction.inspectReceipt(); fault("AFTER_READ");
      if (previous.kind !== "NOT_FOUND") {
        await transaction.rollback();
        return previous.kind === "RECORDED_SIMULATION" ? Object.freeze({ ...boundary, kind: "REPLAYED", receipt: previous.receipt }) :
          Object.freeze({ ...boundary, kind: "REJECTED", reason: previous.kind === "CONFLICT" ? "IDEMPOTENCY_CONFLICT" : "INVALID_RECEIPT" });
      }
      const bundle = describeStaffCommandBundle(command, this.now());
      await transaction.stageIntent(bundle.mutationIntent); fault("AFTER_INTENT");
      await transaction.stageAudit(bundle.auditIntent); fault("AFTER_AUDIT");
      await transaction.stageReceipt(bundle.receipt); fault("AFTER_RECEIPT");
      await options.beforeCommit?.(); fault("BEFORE_COMMIT");
      if (options.failure === "ROLLBACK") { stage = "ROLLBACK"; throw new Error("synthetic rollback trigger"); }
      if (options.failure === "ACK_LOST_WITHOUT_COMMIT") {
        await transaction.rollback();
        return Object.freeze({ ...boundary, kind: "UNCERTAIN", operationId: command.operationId, lookupRequired: true });
      }
      const acknowledgement = await transaction.commit();
      if (options.failure === "ACK_LOST_AFTER_COMMIT" || acknowledgement.kind === "UNKNOWN") {
        return Object.freeze({ ...boundary, kind: "UNCERTAIN", operationId: command.operationId, lookupRequired: true });
      }
      return Object.freeze({ ...boundary, kind: "RECORDED", receipt: acknowledgement.receipt });
    } catch {
      try { await transaction?.rollback(); if (options.failure === "ROLLBACK") throw new Error("synthetic cleanup acknowledgement lost"); } catch { /* no staged records published */ }
      return Object.freeze({ ...boundary, kind: "FAILED", stage });
    }
  }
}

export function barrier() {
  let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release };
}
