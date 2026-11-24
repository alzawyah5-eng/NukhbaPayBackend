import { createHash, randomUUID } from "node:crypto";
import { PROPOSED_AI_CONTROL_POLICY } from "@nukhbapay/application";

/** Proposed values used ONLY by the mock fixture. No runtime/environment activation. */
export const PROPOSED_MOCK_TIMING = PROPOSED_AI_CONTROL_POLICY;
export type ControlCode = "AUTHENTICATION" | "AUTHORIZATION" | "CANCELLED" | "DEADLINE" | "STALL" |
  "IDENTITY" | "EXPIRED" | "STATE" | "POOL_EXHAUSTED" | "DUPLICATE" | "NETWORK" | "AUDIT" | "OUTPUT" | "CLEANUP";
const codes = new Set<unknown>(["AUTHENTICATION", "AUTHORIZATION", "CANCELLED", "DEADLINE", "STALL", "IDENTITY", "EXPIRED",
  "STATE", "POOL_EXHAUSTED", "DUPLICATE", "NETWORK", "AUDIT", "OUTPUT", "CLEANUP"]);
export class OfflineControlError extends Error {
  readonly code: ControlCode;
  constructor(code: ControlCode) { super("Offline control rejected"); this.code = codes.has(code) ? code : "STATE"; Object.freeze(this); }
}
export interface ControlClock {
  now(): number;
  wall(): number;
  after(ms: number, callback: () => void): () => void;
}
export const systemControlClock: ControlClock = {
  now: () => performance.now(), wall: () => Date.now(),
  after(ms, callback) { const timer = setTimeout(callback, Math.max(0, ms)); return () => clearTimeout(timer); },
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type ControlEvent = "STARTUP" | "READY" | "REQUEST" | "LEASE" | "COMMIT" | "REPLAY" | "ROLLBACK" |
  "RESET" | "REJECT" | "QUARANTINE" | "CLOSED" | "DRAINING" | "DISCLOSED";
const events = new Set<unknown>(["STARTUP", "READY", "REQUEST", "LEASE", "COMMIT", "REPLAY", "ROLLBACK", "RESET", "REJECT", "QUARANTINE", "CLOSED", "DRAINING", "DISCLOSED"]);
export class OfflineControlAudit {
  readonly runId = randomUUID();
  #records: Readonly<Record<string, unknown>>[] = [];
  fail = false;
  append(event: ControlEvent, code: ControlCode | null = null): void {
    if (this.fail || this.#records.length >= PROPOSED_MOCK_TIMING.maximumAuditRecords || !events.has(event) || code !== null && !codes.has(code)) throw new OfflineControlError("AUDIT");
    const record = { sequence: this.#records.length + 1, runId: this.runId, event, code,
      previous: this.#records.at(-1)?.["hash"] ?? "0".repeat(64), mockOnly: true };
    this.#records.push(Object.freeze({ ...record, hash: digest(record) }));
  }
  records(): readonly Readonly<Record<string, unknown>>[] { return Object.freeze([...this.#records]); }
}

/** A child can only shorten its parent's absolute monotonic deadline. */
export class ControlBudget {
  readonly controller = new AbortController();
  readonly deadline: number;
  #disposeTimer: () => void;
  #unlink: () => void;
  constructor(readonly clock: ControlClock, cap: number, parent?: ControlBudget, signal?: AbortSignal) {
    if (!Number.isFinite(cap) || cap < 0 || !Number.isFinite(clock.now())) throw new OfflineControlError("STATE");
    this.deadline = Math.min(clock.now() + cap, parent?.deadline ?? Infinity);
    const sources = [parent?.controller.signal, signal].filter((s): s is AbortSignal => s !== undefined);
    const abort = () => {
      const reason: unknown = sources.find(s => s.aborted)?.reason;
      this.abort(reason instanceof OfflineControlError ? reason.code : "CANCELLED");
    };
    for (const s of sources) s.addEventListener("abort", abort, { once: true });
    this.#unlink = () => { for (const s of sources) s.removeEventListener("abort", abort); };
    this.#disposeTimer = clock.after(this.deadline - clock.now(), () => this.abort("DEADLINE"));
    if (sources.some(s => s.aborted)) abort();
  }
  abort(code: ControlCode): void { if (!this.controller.signal.aborted) this.controller.abort(new OfflineControlError(code)); }
  check(): void {
    if (this.clock.now() >= this.deadline) this.abort("DEADLINE");
    if (this.controller.signal.aborted) throw this.controller.signal.reason as OfflineControlError;
  }
  dispose(): void { this.#disposeTimer(); this.#unlink(); }
}

export interface MockOperationPlan {
  readonly delayMs?: number;
  readonly failure?: ControlCode;
  readonly ignoreCancellation?: boolean;
  /** Trusted test instrumentation; duplicate/out-of-order checkpoints do not count. */
  readonly progress?: readonly { readonly atMs: number; readonly step: number }[];
}

/** Closed, cancellable mock operation: cancellation clears every scheduled callback.
 * No arbitrary user callback or real I/O can be injected into this fixture. */
export class MockOperations {
  #plans = new Map<string, MockOperationPlan[]>();
  active = 0;
  cancelled = 0;
  forced = 0;
  plan(stage: string, plan: MockOperationPlan): void {
    this.#plans.set(stage, [...(this.#plans.get(stage) ?? []), plan]);
  }
  async run(stage: string, budget: ControlBudget, stallMs?: number): Promise<void> {
    budget.check();
    const plan = this.#plans.get(stage)?.shift() ?? {};
    this.active++;
    try {
      await new Promise<void>((resolve, reject) => {
        let done = false, lastStep = 0, cancelStall = () => {};
        const cancels: (() => void)[] = [];
        const finish = (error?: OfflineControlError) => {
          if (done) return; done = true;
          cancels.forEach(cancel => cancel()); cancelStall();
          budget.controller.signal.removeEventListener("abort", abort);
          if (error) reject(error); else resolve();
        };
        const abort = () => {
          this.cancelled++;
          // Simulate an uncooperative adapter, then force-close its owned
          // operation. All callbacks are removed before the promise settles.
          if (plan.ignoreCancellation) this.forced++;
          finish(budget.controller.signal.reason as OfflineControlError);
        };
        const armStall = () => {
          cancelStall();
          if (stallMs !== undefined) cancelStall = budget.clock.after(stallMs, () => finish(new OfflineControlError("STALL")));
        };
        budget.controller.signal.addEventListener("abort", abort, { once: true });
        armStall();
        for (const tick of plan.progress ?? []) cancels.push(budget.clock.after(tick.atMs, () => {
          if (Number.isInteger(tick.step) && tick.step === lastStep + 1 && tick.step <= 4) { lastStep = tick.step; armStall(); }
        }));
        const complete = () => {
          try { budget.check(); finish(plan.failure ? new OfflineControlError(plan.failure) : undefined); }
          catch (error) { finish(error as OfflineControlError); }
        };
        if ((plan.delayMs ?? 0) === 0) queueMicrotask(complete);
        else cancels.push(budget.clock.after(plan.delayMs!, complete));
        if (budget.controller.signal.aborted) abort();
      });
      budget.check();
    } finally { this.active--; }
  }
}

export async function controlled<T>(budget: ControlBudget, work: (scope: ControlBudget) => Promise<T>): Promise<T> {
  try { budget.check(); const result = await work(budget); budget.check(); return result; }
  finally { budget.dispose(); }
}
