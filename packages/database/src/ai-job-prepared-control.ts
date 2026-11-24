import { AsyncLocalStorage } from "node:async_hooks";
import { AiJobError, BoundedAiAdmission, VersionedAiOwnership, PROPOSED_AI_CONTROL_POLICY as T, type AiAdmissionPermit } from "@nukhbapay/application";

export interface AiJobSqlResult { rows: Record<string, unknown>[]; rowCount: number | null; command: string; }
export interface AiJobSqlClient { query(sql: string, values?: unknown[]): Promise<AiJobSqlResult>; release(broken?: boolean): void; }
export interface AiJobSqlPool { connect(): Promise<AiJobSqlClient>; end(): Promise<void>; }
type Kind = "jobs" | "source";
interface Session { readonly kind: Kind; readonly id: number; expires: number; open: boolean; tenant: string | null; transaction: boolean; checkedOut: boolean; reserved: Scope | null; }
interface Scope { readonly tenant: string; readonly snapshot: string; readonly epoch: number; readonly controller: AbortController;
  readonly deadline: number; readonly pair: readonly Session[]; cleanupDeadline?: number; uncertain: boolean; }
interface Fault { fragment: string; delayMs?: number; fail?: boolean; }
const preparedMocks = new WeakSet<object>();
const unavailable = () => new AiJobError(503);
const clock = { now: () => performance.now(), after(ms: number, fn: () => void) { const t = setTimeout(fn, ms); return () => clearTimeout(t); } };

/** Disabled-profile transport. Fixed mock sessions and scripted results only;
 * no pg import, socket, password, arbitrary async transport or activation flag. */
export class MockPreparedAiTransport {
  readonly ownership = new VersionedAiOwnership();
  readonly sessions: Session[] = [];
  readonly observed: { kind: Kind; command: string; tenant: string; }[] = [];
  readonly events: string[] = [];
  readonly jobs: AiJobSqlPool;
  readonly sources: AiJobSqlPool;
  #storage = new AsyncLocalStorage<Scope>();
  #admission = new BoundedAiAdmission(clock, T.admittedConcurrency, T.queueDepth, T.queueMs, () => unavailable());
  #answers: { fragment: string; result: AiJobSqlResult }[] = [];
  #faults: Fault[] = [];
  #pending = new Set<() => void>();
  #active = new Set<Promise<unknown>>();
  #scopes = new Set<Scope>();
  #ready = false; #closed = false; #expiry: ReturnType<typeof setTimeout> | undefined;
  constructor(readonly target: { host: string; port: number; systemIdentifier: string; database: string; role: string }) {
    if (target.host !== "127.0.0.1" || target.port !== 55437 || target.systemIdentifier !== "7709060202177449724" ||
        !/^nukhabapay_b4ai_[0-9a-f]{32}$/.test(target.database) || !/^nukh_ai_jobs_[0-9a-f]{20}$/.test(target.role)) throw unavailable();
    this.target = Object.freeze({ ...target });
    preparedMocks.add(this);
    this.jobs = this.pool("jobs"); this.sources = this.pool("source");
  }
  get currentSignal(): AbortSignal | undefined { return this.#storage.getStore()?.controller.signal; }
  get pendingOperations(): number { return this.#pending.size; }
  get terminalConfirmed(): boolean { return this.#closed && this.#active.size === 0 && this.#scopes.size === 0 && this.#pending.size === 0 && this.sessions.every(s => !s.open && !s.transaction && !s.checkedOut && s.reserved === null && s.tenant === null); }
  answer(fragment: string, rows: Record<string, unknown>[], rowCount = rows.length): void {
    this.#answers = this.#answers.filter(a => a.fragment !== fragment);
    this.#answers.push({ fragment, result: { rows, rowCount, command: "MOCK" } });
  }
  fault(fault: Fault): void { this.#faults.push(fault); }
  prepareOffline(): void {
    if (this.#ready || this.#closed) throw unavailable();
    for (let i = 0; i < 4; i++) this.sessions.push({ id: i, kind: i < 2 ? "jobs" : "source", expires: performance.now() + T.sessionLifetimeMs,
      open: true, tenant: null, transaction: false, checkedOut: false, reserved: null });
    this.#ready = true; this.#expiry = setTimeout(() => { void this.close(); }, T.sessionLifetimeMs);
  }
  private scope(): Scope { const s = this.#storage.getStore(); if (!s) throw unavailable(); return s; }
  assertActive(tenant?: string): void {
    const s = this.scope();
    if (!this.#ready || this.#closed || s.controller.signal.aborted || performance.now() >= s.deadline - T.cleanupMs ||
        s.pair.some(session => !session.open || session.expires <= performance.now() || session.reserved !== s) ||
        tenant !== undefined && tenant !== s.tenant || this.ownership.get(s.snapshot) !== s.tenant || this.ownership.epoch(s.snapshot) !== s.epoch) throw unavailable();
  }
  private pool(kind: Kind): AiJobSqlPool { return { connect: async () => {
    this.assertActive(); const scope = this.scope(), session = scope.pair.find(s => s.kind === kind)!;
    if (!session.open || session.reserved !== scope || session.expires <= performance.now() || session.checkedOut || session.tenant !== null) throw unavailable();
    session.checkedOut = true;
    return { query: (sql, values) => this.query(session, sql, values ?? []), release: broken => {
      session.checkedOut = false; if (broken) { session.open = false; void this.close(); }
    } };
  }, end: () => this.close() }; }
  private async query(session: Session, sql: string, values: unknown[]): Promise<AiJobSqlResult> {
    const scope = this.scope(), cleanup = sql === "ROLLBACK" || sql === "RESET ALL";
    if (!cleanup) this.assertActive();
    if (cleanup && scope.cleanupDeadline === undefined) scope.cleanupDeadline = Math.min(scope.deadline, performance.now() + T.cleanupMs);
    if (!session.open || session.reserved !== scope || performance.now() >= (cleanup ? scope.cleanupDeadline! : scope.deadline - T.cleanupMs)) throw unavailable();
    if (sql.includes("set_config('nukhabapay.ai_job_tenant'")) { if (values[0] !== scope.tenant) throw unavailable(); session.tenant = scope.tenant; }
    if (session.kind === "source" && /^(INSERT|UPDATE|DELETE|TRUNCATE)/.test(sql)) throw unavailable();
    if (!/^(BEGIN|COMMIT|ROLLBACK|RESET|SET)/.test(sql) && !sql.includes("set_config(") && session.tenant !== scope.tenant) throw unavailable();
    const index = this.#faults.findIndex(f => sql.includes(f.fragment)), fault = index < 0 ? undefined : this.#faults.splice(index, 1)[0];
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (error = false) => { if (done) return; done = true; clearTimeout(timer); clearTimeout(limit);
        scope.controller.signal.removeEventListener("abort", cancel); this.#pending.delete(cancel); if (error) reject(unavailable()); else resolve(); };
      const cancel = () => finish(true);
      const timer = setTimeout(() => { if (fault?.fail) scope.uncertain = true; finish(fault?.fail === true); }, fault?.delayMs ?? 0);
      const limit = setTimeout(cancel, Math.max(0, (cleanup ? scope.cleanupDeadline! : scope.deadline - T.cleanupMs) - performance.now()));
      this.#pending.add(cancel); if (!cleanup) scope.controller.signal.addEventListener("abort", cancel, { once: true });
      if (!cleanup && scope.controller.signal.aborted) cancel();
    });
    if (!cleanup) this.assertActive();
    const command = sql.split(/\s+/)[0]!;
    this.observed.push({ kind: session.kind, command, tenant: scope.tenant });
    if (command === "BEGIN") session.transaction = true;
    if (command === "COMMIT" || command === "ROLLBACK") { session.transaction = false; session.tenant = null; }
    if (command === "RESET") { session.transaction = false; session.tenant = null; }
    const answer = this.#answers.find(a => sql.includes(a.fragment));
    return answer ? structuredClone(answer.result) : { rows: sql.includes("pg_try_advisory_xact_lock") ? [{ locked: true }] : [], rowCount: 1, command };
  }
  /** Restriction, not identity authority: signed AiJobService still authenticates
   * and supplies tenant-bound tickets to the reused adapter query paths. */
  runScoped<T>(tenant: string, snapshot: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!this.#ready || this.#closed || !this.#admission.hasCapacity) return Promise.reject(unavailable());
    const controller = new AbortController(), deadline = performance.now() + T.requestMs;
    const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    let permit: AiAdmissionPermit | undefined;
    const pending = (async () => {
      let scope: Scope | undefined;
      try {
        permit = await this.#admission.acquire(deadline, controller.signal);
        const pair = [0, 1].map(i => [this.sessions[i]!, this.sessions[i + 2]!]).find(p => p.every(s => s.open && !s.reserved && !s.checkedOut && s.tenant === null && s.expires > deadline));
        if (!pair || this.ownership.get(snapshot) !== tenant) throw unavailable();
        // Hold both purposes for the whole authenticated operation, including cleanup.
        scope = { tenant, snapshot, epoch: this.ownership.epoch(snapshot), controller, deadline, pair, uncertain: false };
        this.#scopes.add(scope); for (const s of pair) s.reserved = scope;
        return await this.#storage.run(scope, async () => {
          const timer = setTimeout(abort, Math.max(0, deadline - T.cleanupMs - performance.now()));
          let result: T;
          try { result = await work(); }
          catch (error) { this.events.push("WORK_REJECTED"); throw error; }
          finally {
            clearTimeout(timer);
            try { for (const s of pair) {
                if (s.transaction) await this.query(s, "ROLLBACK", []);
                await this.query(s, "RESET ALL", []); s.checkedOut = false;
              }
            } catch (error) { scope!.uncertain = true; this.events.push("CLEANUP_REJECTED"); throw error; }
          }
          // Synchronous mock authority/epoch fence. No real DB atomic dispatch
          // guarantee is claimed; the real prepared factory always rejects.
          this.assertActive(tenant); return result;
        });
      } catch (e) { if (scope && (scope.uncertain || scope.pair.some(s => s.transaction || !s.open || s.expires <= performance.now()))) await this.quarantine(); throw e; }
      finally { if (scope) { this.#scopes.delete(scope); for (const s of scope.pair) s.reserved = null; } if (permit) this.#admission.release(permit); signal?.removeEventListener("abort", abort); }
    })();
    this.#active.add(pending); void pending.then(() => this.#active.delete(pending), () => this.#active.delete(pending)); return pending;
  }
  private async quarantine(): Promise<void> {
    this.#closed = true; this.#ready = false; this.#admission.close(); clearTimeout(this.#expiry);
    for (const scope of this.#scopes) scope.controller.abort(); for (const cancel of [...this.#pending]) cancel();
    for (const s of this.sessions) { s.open = false; s.transaction = false; s.tenant = null; s.checkedOut = false; }
  }
  async close(): Promise<void> { await this.quarantine(); await Promise.allSettled([...this.#active]); }
}
export function requirePreparedMock(value: unknown): asserts value is MockPreparedAiTransport {
  if (!value || typeof value !== "object" || !preparedMocks.has(value)) throw unavailable();
}
