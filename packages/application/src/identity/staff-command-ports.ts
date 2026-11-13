import type { PlanningBoundary } from "./staff-lifecycle.js";
import type { StaffCommandCandidate, StaffMutationIntent, StaffCommandAuditIntent, StaffCommandReceipt, StaffReceiptLookup, StaffReceiptResolution } from "./staff-command-contracts.js";

/** Future adapter contract only. No production implementation or command executor is provided. */
export interface StaffSimulationTransaction {
  readonly execution: "NOT_AUTHORIZED";
  inspectReceipt(): Promise<StaffReceiptResolution>;
  stageIntent(intent: StaffMutationIntent): Promise<void>;
  stageAudit(audit: StaffCommandAuditIntent): Promise<void>;
  stageReceipt(receipt: StaffCommandReceipt): Promise<void>;
  /** Publish the complete simulation bundle atomically or report uncertain acknowledgement. */
  commit(): Promise<StaffCommitAcknowledgement>;
  rollback(): Promise<void>;
}
export type StaffCommitAcknowledgement = PlanningBoundary & (
  Readonly<{ kind: "ACKNOWLEDGED_SIMULATION"; receipt: StaffCommandReceipt }> |
  Readonly<{ kind: "UNKNOWN"; operationId: string; lookupRequired: true }>
);
export type StaffBoundaryLookup = StaffReceiptResolution | (PlanningBoundary & Readonly<{ kind: "PENDING" | "LOOKUP_UNAVAILABLE" }>);
export interface StaffSimulationBoundary {
  /** Reserve actor/key namespace, then read the receipt before staging anything. */
  begin(command: StaffCommandCandidate): Promise<StaffSimulationTransaction>;
  lookup(lookup: StaffReceiptLookup): Promise<StaffBoundaryLookup>;
}
