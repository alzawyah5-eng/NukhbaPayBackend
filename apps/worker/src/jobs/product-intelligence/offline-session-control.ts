import { randomUUID } from "node:crypto";
import { aiDigest, validateAiJobRequest, BoundedAiAdmission, VersionedAiOwnership, type AiAdmissionPermit, type AiJobRequest, type AiJobScope } from "@nukhbapay/application";
import { ControlBudget, MockOperations, OfflineControlAudit, OfflineControlError, PROPOSED_MOCK_TIMING as T,
  controlled, systemControlClock, type ControlClock, type ControlCode } from "./offline-control-primitives.js";

const TARGET = Object.freeze({ host: "127.0.0.1", port: 55437, systemId: "7709060202177449724" });
const drivers = new WeakSet<object>(), authorities = new WeakSet<object>();
const driverOwners = new WeakSet<object>();
const startupPermits = new WeakMap<object, { driver: MockSessionDriver; next: number }>();
interface Principal { readonly client: string; readonly tenant: string; readonly expires: number; readonly monotonicExpiry: number; readonly version: number; readonly scope: AiJobScope; }

/** Opaque mock credentials, NEVER a cryptographic or Brick 3 authentication adapter. */
export class MockControlAuthority {
  #tokens = new Map<string, Principal>();
  #bindings = new Map<string, { tenant: string; version: number; enabled: boolean }>();
  constructor(readonly clock: ControlClock) { authorities.add(this); }
  issue(client: string, tenant: string, lifetimeMs = 300_000, scope: AiJobScope = "ai.jobs.process"): string {
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 300_000 ||
        !Number.isFinite(this.clock.wall()) || !Number.isFinite(this.clock.now())) throw new OfflineControlError("AUTHENTICATION");
    const binding = this.#bindings.get(client) ?? { tenant, version: 1, enabled: true };
    if (binding.tenant !== tenant) throw new OfflineControlError("AUTHORIZATION");
    this.#bindings.set(client, binding);
    const token = "mock-" + randomUUID();
    this.#tokens.set(token, Object.freeze({ client, tenant, version: binding.version, scope,
      expires: this.clock.wall() + lifetimeMs, monotonicExpiry: this.clock.now() + lifetimeMs }));
    return token;
  }
  disable(client: string): void { const b = this.#bindings.get(client); if (b) { b.enabled = false; b.version++; } }
  verify(token: string): Principal {
    const p = this.#tokens.get(token);
    if (!p || !Number.isFinite(this.clock.wall()) || !Number.isFinite(this.clock.now()) ||
        p.scope !== "ai.jobs.process" || p.expires <= this.clock.wall() || p.monotonicExpiry <= this.clock.now()) throw new OfflineControlError("AUTHENTICATION");
    const b = this.#bindings.get(p.client);
    if (!b?.enabled || b.tenant !== p.tenant || b.version !== p.version) throw new OfflineControlError("AUTHORIZATION");
    return p;
  }
}

interface MockSession {
  readonly id: string; readonly kind: "jobs" | "source";
  host: string; port: number; systemId: string; role: string; expires: number; monotonicExpiry: number;
  open: boolean; tenant: string | null; lease: string | null; transaction: boolean;
}
export interface MockControlReceipt {
  readonly operationId: string; readonly tenant: string; readonly snapshot: string;
  readonly manualReview: true; readonly can_publish: false;
  readonly provenance: "OFFLINE_SESSION_CONTROL_ONLY_NO_AI_INFERENCE";
}
interface Committed { readonly digest: string; readonly ownershipEpoch: number; readonly receipt: MockControlReceipt; }

/** Finite owned mock operations; this module imports no database/network driver. */
export class MockSessionDriver {
  readonly operations = new MockOperations();
  readonly sessions: MockSession[] = [];
  readonly committed = new Map<string, Committed>();
  readonly snapshots = new VersionedAiOwnership();
  #expiryListeners = new Set<() => void>();
  connectCalls = 0;
  proofSystemId: string = TARGET.systemId;
  proofExpired = false;
  beforeSocketDelayMs = 0;
  constructor(readonly clock: ControlClock) { drivers.add(this); }
  onExpiryChange(callback: () => void): () => void { this.#expiryListeners.add(callback); return () => { this.#expiryListeners.delete(callback); }; }
  expireSessionsNow(): void {
    for (const s of this.sessions) { s.expires = this.clock.wall(); s.monotonicExpiry = this.clock.now(); }
    for (const listener of this.#expiryListeners) listener();
  }
  async open(index: number, parent: ControlBudget, permit?: object): Promise<MockSession> {
    const allowed = permit && startupPermits.get(permit);
    if (!allowed || allowed.driver !== this || allowed.next !== index || index < 0 || index > 3) throw new OfflineControlError("STATE");
    allowed.next++;
    return controlled(new ControlBudget(this.clock, T.connectionSetupMs, parent), async setup => {
        let observedAt = -Infinity;
        await controlled(new ControlBudget(this.clock, T.preflightMs, setup), async preflight => {
            await this.operations.run("hashes", preflight);
            await controlled(new ControlBudget(this.clock, T.physicalMs, preflight), physical => this.operations.run("physical", physical, T.stallMs));
            if (this.proofSystemId !== TARGET.systemId || this.proofExpired) throw new OfflineControlError("IDENTITY");
            observedAt = this.clock.now();
        });
        if (this.beforeSocketDelayMs) {
          this.operations.plan("beforeSocket", { delayMs: this.beforeSocketDelayMs });
          await this.operations.run("beforeSocket", setup);
        }
        setup.check();
        if (this.clock.now() - observedAt > T.finalObservationAgeMs) throw new OfflineControlError("EXPIRED");
        this.connectCalls++;
        await controlled(new ControlBudget(this.clock, T.networkMs, setup), network => this.operations.run("network", network));
        await controlled(new ControlBudget(this.clock, T.assertionMs, setup), assertion => this.operations.run("assertion", assertion));
        setup.check();
        if (this.proofSystemId !== TARGET.systemId || this.proofExpired) throw new OfflineControlError("IDENTITY");
        const kind = index < 2 ? "jobs" : "source";
        const session: MockSession = { id: randomUUID(), kind, ...TARGET, role: "mock-ai-" + kind,
          expires: this.clock.wall() + T.sessionLifetimeMs, monotonicExpiry: this.clock.now() + T.sessionLifetimeMs,
          open: true, tenant: null, lease: null, transaction: false };
        this.sessions.push(session); return session;
    });
  }
  valid(s: MockSession, minimumLifetime = 0): boolean {
    return !this.proofExpired && this.proofSystemId === TARGET.systemId && s.open && s.host === TARGET.host && s.port === TARGET.port && s.systemId === TARGET.systemId &&
      s.role === "mock-ai-" + s.kind && s.expires > this.clock.wall() + minimumLifetime && s.monotonicExpiry > this.clock.now() + minimumLifetime;
  }
  closeAll(): void { for (const s of this.sessions) { s.open = false; s.tenant = null; s.lease = null; s.transaction = false; } }
}

interface Pair { readonly sessions: readonly MockSession[]; busy: boolean; }
function boundedRequest(value: unknown): boolean {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const fields = ["schemaVersion", "idempotencyKey", "snapshotId", "sourceVersion", "offerId", "candidateProductId"];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.keys(descriptors).length === fields.length && Object.keys(descriptors).every(k => fields.includes(k) &&
    "value" in descriptors[k]! && typeof descriptors[k]!.value === "string" && (descriptors[k]!.value as string).length <= 128);
}

/** Mock-only implementation of the PROPOSED policy. Not wired into the E2E CLI,
 * pg adapter, real authentication, real session startup or publication. */
export class OfflineSessionController {
  #state: "NEW" | "STARTING" | "READY" | "DRAINING" | "FAILED" | "CLOSED" = "NEW";
  #root: ControlBudget;
  #pairs: Pair[] = [];
  #inFlight = new Set<string>();
  #active = new Set<Promise<MockControlReceipt>>();
  #admission: BoundedAiAdmission;
  #shutdown = new AbortController();
  #cancelExpiry: () => void = () => {};
  #removeExpiryListener: () => void = () => {};
  #draining: Promise<void> | undefined;
  constructor(readonly config: { capability: "OFFLINE_MOCK_SESSION_CONTROL_ONLY"; clock?: ControlClock;
    authority: MockControlAuthority; driver: MockSessionDriver; audit: OfflineControlAudit }) {
    if (config.capability !== "OFFLINE_MOCK_SESSION_CONTROL_ONLY" || !drivers.has(config.driver) ||
        !authorities.has(config.authority)) throw new OfflineControlError("STATE");
    const clock = config.clock ?? systemControlClock;
    if (clock !== config.driver.clock || clock !== config.authority.clock || driverOwners.has(config.driver)) throw new OfflineControlError("STATE");
    driverOwners.add(config.driver);
    this.#root = new ControlBudget(clock, T.runMs);
    this.#admission = new BoundedAiAdmission(clock, T.admittedConcurrency, T.queueDepth, T.queueMs,
      kind => new OfflineControlError(kind === "CANCELLED" ? "CANCELLED" : "POOL_EXHAUSTED"));
    this.#root.controller.signal.addEventListener("abort", () => this.fatal("DEADLINE"), { once: true });
    this.#removeExpiryListener = config.driver.onExpiryChange(() => this.armExpiration());
  }
  get state(): string { return this.#state; }
  get queued(): number { return this.#admission.queued; }
  get activeRequests(): number { return this.#active.size; }
  get admittedRequests(): number { return this.#admission.active; }
  get terminalConfirmed(): boolean { return (this.#state === "CLOSED" || this.#state === "FAILED") && this.#active.size === 0 &&
    this.config.driver.operations.active === 0 && this.#admission.queued === 0 && this.config.driver.sessions.every(s => !s.open && !s.transaction && s.tenant === null); }
  private armExpiration(): void {
    this.#cancelExpiry();
    if (this.#state !== "READY") return;
    const clock = this.#root.clock;
    const remaining = Math.min(...this.config.driver.sessions.map(s => Math.min(s.expires - clock.wall(), s.monotonicExpiry - clock.now())));
    this.#cancelExpiry = clock.after(Math.max(0, remaining), () => this.beginDrain());
  }
  private beginDrain(): void {
    if (this.#state !== "READY") return;
    this.#state = "DRAINING"; this.#cancelExpiry();
    try { this.config.audit.append("DRAINING", "EXPIRED"); } catch { this.fatal("AUDIT"); return; }
    this.#shutdown.abort(new OfflineControlError("EXPIRED"));
    this.#admission.close();
    this.#draining = (async () => {
      await Promise.allSettled([...this.#active]); this.config.driver.closeAll();
      if (this.#state !== "FAILED") { this.#state = "CLOSED"; try { this.config.audit.append("CLOSED", "EXPIRED"); } catch { this.#state = "FAILED"; } }
      this.#root.dispose(); this.#removeExpiryListener();
    })();
  }
  async waitForTerminal(): Promise<void> { await this.#draining; if (!this.terminalConfirmed) throw new OfflineControlError("CLEANUP"); }
  private fatal(code: ControlCode): void {
    if (this.#state === "FAILED" || this.#state === "CLOSED") return;
    this.#state = "FAILED"; this.#cancelExpiry(); this.#root.abort(code); this.config.driver.closeAll();
    this.#admission.close();
    try { this.config.audit.append("QUARANTINE", code); } catch { /* Fail closed even when audit storage failed. */ }
  }
  async startup(): Promise<void> {
    if (this.#state !== "NEW") throw new OfflineControlError("STATE");
    this.#state = "STARTING";
    try {
      this.config.audit.append("STARTUP");
      await controlled(new ControlBudget(this.#root.clock, T.startupMs, this.#root), async startup => {
        const permit = Object.freeze({}); startupPermits.set(permit, { driver: this.config.driver, next: 0 });
        try { for (let i = 0; i < 4; i++) await this.config.driver.open(i, startup, permit); }
        finally { startupPermits.delete(permit); }
      });
      this.#pairs = [0, 1].map(i => ({ sessions: [this.config.driver.sessions[i]!, this.config.driver.sessions[i + 2]!], busy: false }));
      if (this.config.driver.sessions.length !== 4 || new Set(this.config.driver.sessions.map(s => s.id)).size !== 4) throw new OfflineControlError("IDENTITY");
      if (this.#pairs.some(p => p.sessions.some(s => !this.config.driver.valid(s, T.requestMs)))) throw new OfflineControlError("EXPIRED");
      this.config.audit.append("READY"); this.#state = "READY"; this.armExpiration();
    } catch (error) { this.fatal(error instanceof OfflineControlError ? error.code : "STATE"); throw error; }
  }
  private acquire(budget: ControlBudget): Pair {
    budget.check();
    if (this.#state !== "READY") throw new OfflineControlError("STATE");
    const pair = this.#pairs.find(p => !p.busy);
    if (!pair) throw new OfflineControlError("POOL_EXHAUSTED");
    pair.busy = true; return pair;
  }
  execute(token: string, payload: unknown, signal?: AbortSignal): Promise<MockControlReceipt> {
    // Reject before allocating budgets, starting authentication or retaining payloads.
    if (this.#state !== "READY" || signal?.aborted || typeof token !== "string" || Buffer.byteLength(token) > T.maximumTokenBytes || !boundedRequest(payload) ||
        !this.#admission.hasCapacity)
      return Promise.reject(new OfflineControlError("POOL_EXHAUSTED"));
    const overall = new ControlBudget(this.#root.clock, T.requestMs, this.#root,
      AbortSignal.any([this.#shutdown.signal, ...(signal ? [signal] : [])]));
    let permit: AiAdmissionPermit | undefined;
    const pending = (async () => {
      try { permit = await this.#admission.acquire(overall.deadline, overall.controller.signal); return await this.request(token, payload, overall); }
      finally { if (permit) this.#admission.release(permit); overall.dispose(); }
    })();
    this.#active.add(pending);
    void pending.then(() => this.#active.delete(pending), () => this.#active.delete(pending));
    return pending;
  }
  private async request(token: string, payload: unknown, overall: ControlBudget): Promise<MockControlReceipt> {
    const { driver, authority, audit } = this.config, clock = this.#root.clock;
    const work = new ControlBudget(clock, Math.max(0, overall.deadline - clock.now() - T.cleanupMs), overall);
    let pair: Pair | undefined, key: string | undefined, nonce: string | undefined;
    let answer: MockControlReceipt | undefined, failure: OfflineControlError | undefined;
    let ownershipEpoch = 0, approvedSnapshot: string | undefined, requestDigest: string | undefined;
    try {
      if (this.#state !== "READY") throw new OfflineControlError("STATE");
      audit.append("REQUEST");
      await controlled(new ControlBudget(clock, T.authenticationMs, work), async auth => {
        await driver.operations.run("authentication", auth); authority.verify(token);
      });
      const principal = authority.verify(token);
      const request: AiJobRequest = validateAiJobRequest(payload);
      if (driver.snapshots.get(request.snapshotId) !== principal.tenant) throw new OfflineControlError("AUTHORIZATION");
      ownershipEpoch = driver.snapshots.epoch(request.snapshotId); approvedSnapshot = request.snapshotId;
      requestDigest = aiDigest(request);
      key = aiDigest([principal.tenant, principal.client, request.idempotencyKey]);
      if (this.#inFlight.has(key)) throw new OfflineControlError("DUPLICATE");
      this.#inFlight.add(key); nonce = randomUUID();
      pair = this.acquire(work);
      const lease = pair;
      const check = () => {
        work.check(); const current = authority.verify(token);
        if (current.tenant !== principal.tenant || current.client !== principal.client || driver.snapshots.get(request.snapshotId) !== principal.tenant ||
            driver.snapshots.epoch(request.snapshotId) !== ownershipEpoch)
          throw new OfflineControlError("AUTHORIZATION");
        for (const s of lease.sessions) if (!driver.valid(s) || s.lease !== nonce || s.tenant !== principal.tenant) throw new OfflineControlError("IDENTITY");
      };
      for (const s of pair.sessions) {
        if (!driver.valid(s, T.requestMs) || s.tenant !== null || s.transaction || s.lease !== null) throw new OfflineControlError("EXPIRED");
        s.tenant = principal.tenant; s.lease = nonce;
      }
      audit.append("LEASE"); check();
      const digest = aiDigest(request), previous = driver.committed.get(key);
      if (previous) {
        if (previous.digest !== digest) throw new OfflineControlError("DUPLICATE");
        if (previous.ownershipEpoch !== ownershipEpoch) throw new OfflineControlError("AUTHORIZATION");
        const r = previous.receipt;
        const fields = ["operationId", "tenant", "snapshot", "manualReview", "can_publish", "provenance"];
        if (Object.keys(r).length !== 6 || Object.keys(r).some(k => !fields.includes(k)) ||
            typeof r.operationId !== "string" || !/^[0-9a-f-]{36}$/.test(r.operationId) ||
            r.manualReview !== true || r.can_publish !== false || r.tenant !== principal.tenant ||
            r.snapshot !== request.snapshotId || r.provenance !== "OFFLINE_SESSION_CONTROL_ONLY_NO_AI_INFERENCE") throw new OfflineControlError("OUTPUT");
        audit.append("REPLAY"); answer = previous.receipt;
      } else {
        pair.sessions[0]!.transaction = true;
        await controlled(new ControlBudget(clock, T.serviceMs, work), async service => {
          await controlled(new ControlBudget(clock, T.transactionMs, service), async transaction => {
            await driver.operations.run("work", transaction, T.stallMs); check();
            await driver.operations.run("commit", transaction); check();
            const receipt = Object.freeze({ operationId: randomUUID(), tenant: principal.tenant, snapshot: request.snapshotId,
              manualReview: true as const, can_publish: false as const, provenance: "OFFLINE_SESSION_CONTROL_ONLY_NO_AI_INFERENCE" as const });
            audit.append("COMMIT"); driver.committed.set(key!, Object.freeze({ digest, ownershipEpoch, receipt }));
            pair!.sessions[0]!.transaction = false; answer = receipt;
          });
          await driver.operations.run("afterCommit", service); check();
        });
      }
    } catch (e) {
      failure = e instanceof OfflineControlError ? e : new OfflineControlError("OUTPUT");
      if (["NETWORK", "IDENTITY", "EXPIRED", "AUDIT"].includes(failure.code)) this.fatal(failure.code);
      try { audit.append("REJECT", failure.code); } catch { failure = new OfflineControlError("AUDIT"); this.fatal("AUDIT"); }
    } finally {
      work.dispose();
      // Cancellation is already propagated and every owned operation joined.
      // Cleanup has a separate reserved slice, never extends overall/run caps.
      if (pair) {
        const remaining = Math.min(T.cleanupMs, overall.deadline - clock.now(), this.#root.deadline - clock.now());
        const cleanup = new ControlBudget(clock, Math.max(0, remaining), this.#root);
        try {
          if (this.#state === "READY" || this.#state === "DRAINING") {
            if (pair.sessions.some(s => s.transaction)) { await driver.operations.run("rollback", cleanup); audit.append("ROLLBACK"); }
            await driver.operations.run("reset", cleanup);
            for (const s of pair.sessions) { s.transaction = false; s.tenant = null; s.lease = null; }
            if (this.#state === "READY" && pair.sessions.some(s => !driver.valid(s))) throw new OfflineControlError("IDENTITY");
            audit.append("RESET");
          }
        } catch { failure = new OfflineControlError("CLEANUP"); this.fatal("CLEANUP"); }
        finally { cleanup.dispose(); pair.busy = false; }
      }
      if (key && nonce) this.#inFlight.delete(key);
    }
    if (failure) throw failure;
    try {
      // One synchronous mock-authority/epoch/receipt check and disclosure transition;
      // no await permits cleanup-stage revocation (including ABA) to be ignored.
      overall.check(); const current = authority.verify(token);
      const committed = key && driver.committed.get(key);
      if (this.#state !== "READY" || !approvedSnapshot || driver.snapshots.get(approvedSnapshot) !== current.tenant ||
          driver.snapshots.epoch(approvedSnapshot) !== ownershipEpoch || !committed ||
          committed.digest !== requestDigest || committed.ownershipEpoch !== ownershipEpoch || committed.receipt !== answer)
        throw new OfflineControlError("AUTHORIZATION");
      audit.append("DISCLOSED");
    }
    catch (e) {
      const code = e instanceof OfflineControlError ? e.code : "AUTHENTICATION";
      try { audit.append("REJECT", code); } catch { this.fatal("AUDIT"); throw new OfflineControlError("AUDIT"); }
      throw e;
    }
    if (!answer) throw new OfflineControlError("STATE");
    return answer;
  }
  async close(): Promise<void> {
    this.#cancelExpiry(); this.#removeExpiryListener();
    if (this.#draining) { await this.#draining; return; }
    if (this.#state !== "FAILED") { this.#state = "CLOSED"; this.#root.abort("CANCELLED"); }
    this.#admission.close();
    this.config.driver.closeAll(); await Promise.allSettled([...this.#active]); this.#root.dispose();
    try { this.config.audit.append("CLOSED"); } catch { /* Already fail closed. */ }
  }
}
