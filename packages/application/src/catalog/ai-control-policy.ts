/** Proposed values for disabled/offline prepared-session integration only. */
export const PROPOSED_AI_CONTROL_POLICY = Object.freeze({
  active: false, runMs: 1_200_000, startupMs: 180_000, connectionSetupMs: 32_000,
  preflightMs: 20_000, physicalMs: 15_000, stallMs: 10_000, networkMs: 6500, assertionMs: 4000,
  finalObservationAgeMs: 1000, requestMs: 14_000, authenticationMs: 1000, queueMs: 1000,
  serviceMs: 10_000, transactionMs: 8500, cleanupMs: 2000, sessionLifetimeMs: 300_000, queueDepth: 8,
  admittedConcurrency: 2, maximumTokenBytes: 8192, maximumAuditRecords: 4096,
});
/** Mock epoch contract. Durable ownership/dispatch requires separate DB acceptance. */
export class VersionedAiOwnership extends Map<string, string> {
  #epochs = new Map<string, number>();
  epoch(key: string): number { return this.#epochs.get(key) ?? 0; }
  override set(key: string, tenant: string): this { this.#epochs.set(key, this.epoch(key) + 1); return super.set(key, tenant); }
  override delete(key: string): boolean { this.#epochs.set(key, this.epoch(key) + 1); return super.delete(key); }
  override clear(): void { for (const key of this.keys()) this.#epochs.set(key, this.epoch(key) + 1); super.clear(); }
}
