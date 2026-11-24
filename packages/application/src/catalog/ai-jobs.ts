import { createHash, randomUUID } from "node:crypto";
import { pricingInstantMs } from "../../../domain/src/index.js";

export const AI_JOB_AUDIENCE = "urn:nukhbapay:synthetic:ai-jobs";
export type AiJobScope = "ai.jobs.submit" | "ai.jobs.process" | "ai.jobs.read";
export const AI_JOB_CUSTOMER_TECHNICAL_MESSAGE = "We couldn't complete your request due to a temporary technical issue. Please try again.\n\nIf your account was charged or you are unsure about the transaction status, please contact our support team before submitting another request.";
export class AiJobError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 409 | 503) { super("AI job unavailable"); }
  /** Presentation contract only. Never describes uncertain finances as failed,
   * exposes internal diagnostics, or triggers automatic payment execution. */
  get customerMessage(){return AI_JOB_CUSTOMER_TECHNICAL_MESSAGE;}
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const aiDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value, (_key, item: unknown) =>
  item !== null && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, (item as Record<string, unknown>)[key]])) : item)).digest("hex");
export interface AiServiceIdentity {
  readonly issuer: string; readonly subject: string; readonly clientId: string;
  readonly audience: typeof AI_JOB_AUDIENCE; readonly scope: AiJobScope;
  readonly issuedAt: number; readonly expiresAt: number;
}
const identities = new WeakSet<object>();
/** Trusted cryptographic verifier adapters only; never deserialize request JSON here. */
export function attestAiServiceIdentity(evidence: AiServiceIdentity): AiServiceIdentity {
  const value = Object.freeze({ ...evidence }); identities.add(value); return value;
}
export interface AiServiceBinding {
  readonly issuer: string; readonly subject: string; readonly clientId: string;
  readonly tenantId: string; readonly scope: AiJobScope; readonly version: string; readonly enabled: boolean;
}
export interface AiBindingRepository { find(identity: AiServiceIdentity): Promise<AiServiceBinding | null>; }
export interface AiJobRequest {
  readonly schemaVersion: "ai-job-v1"; readonly idempotencyKey: string;
  readonly snapshotId: string; readonly sourceVersion: string;
  readonly offerId: string; readonly candidateProductId: string;
}
export interface AiProduct {
  readonly record_id: string; readonly category: "gift_card" | "prepaid_airtime";
  readonly country: string | null; readonly currency: string | null; readonly issuer_id: string | null;
  readonly denomination_minor: string | null; readonly redemption_region: string | null;
  readonly validity: string | null; readonly fulfillment_method: string | null;
  readonly restriction_codes: readonly string[] | null;
}
export interface AiApprovedPair {
  /** Fixture-only durable catalogue generation, included in sourceDigest. */
  readonly ownershipEpoch?: string;
  readonly tenantId: string; readonly snapshotId: string; readonly sourceVersion: string;
  readonly offerId: string; readonly candidateProductId: string;
  readonly approved: true; readonly status: "COMPLETE"; readonly accountActive: true;
  readonly observedAt: string; readonly completedAt: string; readonly validUntil: string;
  readonly provider: AiProduct; readonly candidate: AiProduct;
}
export interface AiSourceReader { read(tenantId: string, request: AiJobRequest): Promise<AiApprovedPair | null>; }
export interface AiEngineInput {
  readonly schema_version: "1.0"; readonly job_id: string; readonly tenant_id: string;
  readonly correlation_id: string; readonly source_snapshot_id: string; readonly canonical_catalog_version: string;
  readonly provider_record: AiProduct; readonly candidate_record: AiProduct;
}
export interface AiProviderEvent {
  readonly schema_version: "hybrid-audit-v1"; readonly provider: "openai" | "anthropic" | "gemini";
  readonly model_version: string; readonly prompt_version: "product-match-mock-v1";
  readonly attempt: number; readonly outcome: "VALIDATED" | "TIMEOUT" | "INVALID_OUTPUT" | "PROVIDER_FAILURE" | "CIRCUIT_OPEN";
}
export interface AiSummary {
  readonly provider: "openai" | "anthropic" | "gemini" | null;
  readonly modelVersion: string | null; readonly promptVersion: "product-match-mock-v1";
  readonly rulesVersion: "equivalence-v1"; readonly decision: "CANDIDATE" | "REQUIRES_REVIEW" | "REJECTED";
  readonly confidenceBps: number; readonly duplicateCandidate: boolean;
  readonly manualReview: true; readonly can_publish: false;
}
export interface AiEngine { run(input: AiEngineInput, signal: AbortSignal): Promise<{ summary: AiSummary; events: readonly AiProviderEvent[] }>; }
export type AiJobState = "QUEUED" | "RUNNING" | "RETRYABLE" | "FAILED" | "SUCCEEDED";
export interface AiJobRecord {
  readonly id: string; readonly tenantId: string; readonly clientDigest: string;
  readonly request: AiJobRequest; readonly digest: string; readonly sourceDigest: string;
  readonly state: AiJobState; readonly attempts: number; readonly retryAt: string | null;
  readonly summary: AiSummary | null;
}
export interface AiJobAudit {
  readonly jobId: string; readonly tenantId: string; readonly snapshotId: string;
  readonly occurredAt: string; readonly attempt: number;
  readonly outcome: "SUBMITTED" | "STARTED" | "RETRYABLE" | "FAILED" | "SUCCEEDED" | AiProviderEvent["outcome"];
  readonly provider: AiProviderEvent["provider"] | null; readonly providerAttempt: number | null;
  readonly modelVersion: string | null; readonly manualReview: true; readonly can_publish: false;
}
export interface AiEngineReservation { readonly token:string|null; readonly ordinal:number; readonly status:"OPEN"|"TERMINAL"|"EXHAUSTED"; }
export interface AiJobTransaction {
  assertAttempt?(token:string):Promise<void>;
  find(id: string): Promise<AiJobRecord | null>;
  findKey(clientDigest: string, key: string): Promise<AiJobRecord | null>;
  insert(job: AiJobRecord): Promise<void>;
  save(job: AiJobRecord): Promise<void>;
  append(event: AiJobAudit): Promise<void>;
}
export interface AiJobTicket { readonly tenantId: string; readonly lockKey: string; revalidate(): Promise<boolean>; }
const tickets = new WeakSet<object>();
export function consumeAiJobTicket(value: AiJobTicket): AiJobTicket {
  if (!value || !tickets.delete(value)) throw new AiJobError(403); return value;
}
/** Adapter must commit state and audit together, serialize lockKey, and disclose only after COMMIT. */
export interface AiJobStore {
  readonly attempts?: {reserve(ticket:AiJobTicket,jobId:string):Promise<AiEngineReservation>;settle(ticket:AiJobTicket,reservation:AiEngineReservation,committed:boolean):Promise<void>};
  transaction<T>(ticket: AiJobTicket, work: (tx: AiJobTransaction) => Promise<T>): Promise<T>; }

function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length ||
    Object.keys(value).some(k => !keys.includes(k))) throw new AiJobError(400);
}
export function validateAiJobRequest(value: unknown): AiJobRequest {
  exact(value, ["schemaVersion", "idempotencyKey", "snapshotId", "sourceVersion", "offerId", "candidateProductId"]);
  if (value["schemaVersion"] !== "ai-job-v1" ||
    !["idempotencyKey", "snapshotId", "offerId", "candidateProductId"].every(k => typeof value[k] === "string" && uuid.test(value[k])) ||
    typeof value["sourceVersion"] !== "string" || !identifier.test(value["sourceVersion"])) throw new AiJobError(400);
  return Object.freeze({ ...value }) as unknown as AiJobRequest;
}
function product(value: AiProduct): AiProduct {
  exact(value, ["record_id", "category", "country", "currency", "issuer_id", "denomination_minor", "redemption_region", "validity", "fulfillment_method", "restriction_codes"]);
  const text = (v: unknown, pattern: RegExp) => v === null || typeof v === "string" && pattern.test(v);
  if (typeof value.record_id !== "string" || !identifier.test(value.record_id) || !["gift_card", "prepaid_airtime"].includes(value.category) ||
    !text(value.country, /^[A-Z]{2}$/) || !text(value.currency, /^[A-Z]{3}$/) || !text(value.issuer_id, identifier) ||
    !text(value.denomination_minor, /^[1-9][0-9]{0,17}$/) || !text(value.redemption_region, /^[A-Z][A-Z0-9_-]{1,31}$/) ||
    !text(value.validity, /^(NO_EXPIRY|P[1-9][0-9]{0,5}D)$/) || !text(value.fulfillment_method, /^(PIN|DIRECT_RECHARGE|DIGITAL_CODE)$/) ||
    !(value.restriction_codes === null || Array.isArray(value.restriction_codes) && value.restriction_codes.length <= 100 && value.restriction_codes.every(v => typeof v === "string" && identifier.test(v)))) throw new AiJobError(503);
  return Object.freeze({ ...value, restriction_codes: value.restriction_codes === null ? null : Object.freeze([...new Set(value.restriction_codes)].sort()) });
}
export function validateAiSummary(value:unknown):AiSummary {
  const s=value;
  exact(s, ["provider", "modelVersion", "promptVersion", "rulesVersion", "decision", "confidenceBps", "duplicateCandidate", "manualReview", "can_publish"]);
  const providers = ["openai", "anthropic", "gemini"], decisions = ["CANDIDATE", "REQUIRES_REVIEW", "REJECTED"];
  if (!(s["provider"] === null || providers.includes(s["provider"] as string)) ||
    s["modelVersion"] !== (s["provider"] === null ? null : `mock-${s["provider"]}-v1`) ||
    s["promptVersion"] !== "product-match-mock-v1" || s["rulesVersion"] !== "equivalence-v1" || !decisions.includes(s["decision"] as string) ||
    !Number.isSafeInteger(s["confidenceBps"]) || (s["confidenceBps"] as number) < 0 || (s["confidenceBps"] as number) > 10000 ||
    typeof s["duplicateCandidate"] !== "boolean" || s["manualReview"] !== true || s["can_publish"] !== false) throw new AiJobError(503);
  return Object.freeze({...s}) as unknown as AiSummary;
}
export function validateAiEngineResult(value: unknown, input: AiEngineInput): { summary: AiSummary; events: readonly AiProviderEvent[] } {
  exact(value, ["summary", "events"]);
  const s = value["summary"];
  exact(s, ["provider", "modelVersion", "promptVersion", "rulesVersion", "decision", "confidenceBps", "duplicateCandidate", "manualReview", "can_publish"]);
  validateAiSummary(s);
  const providers=["openai", "anthropic", "gemini"];
  const fields = ["category", "country", "currency", "issuer_id", "denomination_minor", "redemption_region", "validity", "fulfillment_method", "restriction_codes"] as const;
  const mismatch = fields.some(k => input.provider_record[k] !== null && input.candidate_record[k] !== null && aiDigest(input.provider_record[k]) !== aiDigest(input.candidate_record[k]));
  const missing = fields.some(k => input.provider_record[k] === null || input.candidate_record[k] === null);
  if (mismatch && s["decision"] !== "REJECTED" || (missing || mismatch) && (s["decision"] === "CANDIDATE" || s["duplicateCandidate"] === true) ||
    s["decision"] === "CANDIDATE" && (s["provider"] === null || s["confidenceBps"] as number < 9500 || !s["duplicateCandidate"])) throw new AiJobError(503);
  const events = value["events"];
  if (!Array.isArray(events) || events.length < 1 || events.length > 9) throw new AiJobError(503);
  const safe = events.map(e => {
    exact(e, ["schema_version", "provider", "model_version", "prompt_version", "attempt", "outcome"]);
    if (e["schema_version"] !== "hybrid-audit-v1" || !providers.includes(e["provider"] as string) || e["model_version"] !== `mock-${e["provider"]}-v1` ||
      e["prompt_version"] !== "product-match-mock-v1" || !Number.isSafeInteger(e["attempt"]) || (e["attempt"] as number) < 0 || (e["attempt"] as number) > 3 ||
      !["VALIDATED", "TIMEOUT", "INVALID_OUTPUT", "PROVIDER_FAILURE", "CIRCUIT_OPEN"].includes(e["outcome"] as string) ||
      (e["outcome"] === "CIRCUIT_OPEN") !== (e["attempt"] === 0)) throw new AiJobError(503);
    return Object.freeze({ ...e }) as unknown as AiProviderEvent;
  });
  if (s["provider"] !== null && !safe.some(e => e.provider === s["provider"] && e.outcome === "VALIDATED")) throw new AiJobError(503);
  return Object.freeze({ summary: Object.freeze({ ...s }) as unknown as AiSummary, events: Object.freeze(safe) });
}

export interface AiJobDependencies {
  readonly capability: "ISOLATED_SYNTHETIC_AI_JOBS_ONLY"; readonly bindings: AiBindingRepository;
  readonly sources: AiSourceReader; readonly store: AiJobStore; readonly engine: AiEngine; readonly now: () => Date;
  readonly executionControl?: { readonly capability: "OFFLINE_PREPARED_AI_JOBS_ONLY" | "REVIEWED_FIXED_AI_JOBS_55437_ONLY"; currentSignal(): AbortSignal | undefined; cancel?():void; };
}
export class AiJobService {
  constructor(private readonly deps?: AiJobDependencies) {
    if (deps && deps.capability !== "ISOLATED_SYNTHETIC_AI_JOBS_ONLY") throw new AiJobError(503);
    if (deps?.executionControl && !["OFFLINE_PREPARED_AI_JOBS_ONLY","REVIEWED_FIXED_AI_JOBS_55437_ONLY"].includes(deps.executionControl.capability)) throw new AiJobError(503);
  }
  private time(): number { const n = this.deps!.now().getTime(); if (!Number.isFinite(n)) throw new AiJobError(503); return n; }
  private async authorize(identity: AiServiceIdentity, scope: AiJobScope): Promise<AiServiceBinding> {
    if (!this.deps) throw new AiJobError(503);
    if (!identity || !identities.has(identity)) throw new AiJobError(401);
    const issuer = new URL(identity.issuer), now = this.time();
    if (issuer.protocol !== "https:" || !issuer.hostname.endsWith(".invalid") || identity.audience !== AI_JOB_AUDIENCE || identity.scope !== scope ||
      !Number.isSafeInteger(identity.issuedAt) || !Number.isSafeInteger(identity.expiresAt) || now < identity.issuedAt * 1000 || now >= identity.expiresAt * 1000) throw new AiJobError(403);
    const b = await this.deps.bindings.find(identity);
    if (!b || !b.enabled || b.issuer !== identity.issuer || b.subject !== identity.subject || b.clientId !== identity.clientId || b.scope !== scope ||
      !uuid.test(b.tenantId) || !/^[1-9][0-9]{0,18}$/.test(b.version)) throw new AiJobError(403);
    return Object.freeze({ ...b });
  }
  private async source(tenantId: string, r: AiJobRequest): Promise<AiApprovedPair> {
    const p = await this.deps!.sources.read(tenantId, r), now = this.time();
    let observed: number, completed: number, expires: number;
    try { observed = pricingInstantMs(p!.observedAt, "AI source observedAt"); completed = pricingInstantMs(p!.completedAt, "AI source completedAt"); expires = pricingInstantMs(p!.validUntil, "AI source validUntil"); }
    catch { throw new AiJobError(403); }
    if (!p || p.ownershipEpoch !== undefined && !/^(0|[1-9][0-9]{0,18})([.](0|[1-9][0-9]{0,18}))?$/.test(p.ownershipEpoch) || p.tenantId !== tenantId || p.snapshotId !== r.snapshotId || p.offerId !== r.offerId || p.candidateProductId !== r.candidateProductId ||
      p.sourceVersion !== r.sourceVersion || p.approved !== true || p.status !== "COMPLETE" || p.accountActive !== true ||
      observed > completed || completed > now || now - observed > 86400000 || expires <= now) throw new AiJobError(403);
    return Object.freeze({ ...p, provider: product(p.provider), candidate: product(p.candidate) });
  }
  private async boundary<T>(identity: AiServiceIdentity, scope: AiJobScope, work: (b: AiServiceBinding, fresh: () => Promise<boolean>, signal: AbortSignal) => Promise<T>): Promise<T> {
    try {
      // Entire boundary, including authorization/ownership/storage waits, has a deadline.
      const controller = new AbortController();
      const parent = this.deps?.executionControl?.currentSignal();
      if (this.deps?.executionControl && !parent) throw new AiJobError(503);
      const cancel = () => controller.abort(); parent?.addEventListener("abort", cancel, { once: true });
      if (parent?.aborted) cancel();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); this.deps?.executionControl?.cancel?.(); reject(new AiJobError(503)); }, 10000); });
      let operation:Promise<T>|undefined;
      try {
        operation=(async () => {
          const b = await this.authorize(identity, scope), stamp = aiDigest(b);
          const fresh = async () => { if (controller.signal.aborted) return false; const current = await this.authorize(identity, scope); return !controller.signal.aborted && aiDigest(current) === stamp; };
          if (controller.signal.aborted) throw new AiJobError(503);
          const result = await work(b, fresh, controller.signal);
          if (!await fresh()) throw new AiJobError(403); return result;
        })();return await Promise.race([timeout,operation]);
      } finally { controller.abort();clearTimeout(timer); parent?.removeEventListener("abort", cancel);
        // Controlled release cannot acknowledge completion while downstream
        // work is pending. A noncooperative transport is killed by the native
        // owner; the lease remains unavailable until that terminal outcome.
        if(this.deps?.executionControl)await operation?.catch(()=>undefined);
      }
    } catch (e) { if (e instanceof AiJobError) throw e; throw new AiJobError(503); }
  }
  private ticket(tenantId: string, lockKey: string, fresh: () => Promise<boolean>): AiJobTicket {
    const t = Object.freeze({ tenantId, lockKey, revalidate: fresh }); tickets.add(t); return t;
  }
  async submit(identity: AiServiceIdentity, payload: unknown): Promise<AiJobRecord> {
    return this.boundary(identity, "ai.jobs.submit", async (b, fresh) => {
      const request = validateAiJobRequest(payload), source = await this.source(b.tenantId, request);
      const clientDigest = aiDigest([b.issuer, b.subject, b.clientId]), digest = aiDigest(request), sourceDigest = aiDigest(source);
      const ticket = this.ticket(b.tenantId, aiDigest([b.tenantId, clientDigest, request.idempotencyKey]), fresh);
      const saved = await this.deps!.store.transaction(ticket, async tx => {
        if (!await fresh()) throw new AiJobError(403);
        const previous = await tx.findKey(clientDigest, request.idempotencyKey);
        if (previous) { if (previous.digest !== digest || previous.sourceDigest !== sourceDigest) throw new AiJobError(409); return previous; }
        const job: AiJobRecord = Object.freeze({ id: randomUUID(), tenantId: b.tenantId, clientDigest, request, digest, sourceDigest, state: "QUEUED", attempts: 0, retryAt: null, summary: null });
        await tx.insert(job); await tx.append(this.audit(job, "SUBMITTED"));
        if (!await fresh()) throw new AiJobError(403); return job;
      });
      if (aiDigest(await this.source(b.tenantId, request)) !== sourceDigest) throw new AiJobError(403);
      return saved;
    });
  }
  async read(identity: AiServiceIdentity, jobId: string): Promise<AiJobRecord> {
    return this.boundary(identity, "ai.jobs.read", async (b, fresh) => {
      if (typeof jobId !== "string" || !uuid.test(jobId)) throw new AiJobError(400);
      const clientDigest = aiDigest([b.issuer, b.subject, b.clientId]);
      const saved = await this.deps!.store.transaction(this.ticket(b.tenantId, aiDigest([b.tenantId, jobId]), fresh), async tx => {
        const job = await tx.find(jobId);
        if (!job || job.tenantId !== b.tenantId || job.clientDigest !== clientDigest) throw new AiJobError(403);
        if (aiDigest(await this.source(b.tenantId, job.request)) !== job.sourceDigest || !await fresh()) throw new AiJobError(403);
        return job;
      });
      if (aiDigest(await this.source(b.tenantId, saved.request)) !== saved.sourceDigest) throw new AiJobError(403);
      return saved;
    });
  }
  private audit(job: AiJobRecord, outcome: AiJobAudit["outcome"], event?: AiProviderEvent): AiJobAudit {
    return Object.freeze({ jobId: job.id, tenantId: job.tenantId, snapshotId: job.request.snapshotId,
      occurredAt: new Date(this.time()).toISOString(), attempt: job.attempts, outcome,
      provider: event?.provider ?? job.summary?.provider ?? null, providerAttempt: event?.attempt ?? null,
      modelVersion: event?.model_version ?? job.summary?.modelVersion ?? null, manualReview: true, can_publish: false });
  }
  async process(identity: AiServiceIdentity, jobId: string): Promise<AiJobRecord> {
    return this.boundary(identity, "ai.jobs.process", async (b, fresh, requestSignal) => {
      if (typeof jobId !== "string" || !uuid.test(jobId)) throw new AiJobError(400);
      const attempts=this.deps!.store.attempts;
      const reservation=await attempts?.reserve(this.ticket(b.tenantId,aiDigest([b.tenantId,jobId]),fresh),jobId);
      if(reservation?.status==='EXHAUSTED')throw new AiJobError(503);
      try{
      const saved = await this.deps!.store.transaction(this.ticket(b.tenantId, aiDigest([b.tenantId, jobId]), fresh), async tx => {
        let job = await tx.find(jobId);
        if (!job || job.tenantId !== b.tenantId) throw new AiJobError(403);
        const source = await this.source(b.tenantId, job.request);
        if (aiDigest(source) !== job.sourceDigest || !await fresh()) throw new AiJobError(403);
        if (job.state === "SUCCEEDED" || job.state === "FAILED") return job;
        if (job.state === "RUNNING" || job.attempts >= 2) throw new AiJobError(409);
        if (job.retryAt && Date.parse(job.retryAt) > this.time()) throw new AiJobError(409);
        if(attempts){if(reservation?.status!=='OPEN'||!reservation.token||!tx.assertAttempt)throw new AiJobError(503);await tx.assertAttempt(reservation.token);}
        job = Object.freeze({ ...job, state: "RUNNING", retryAt: null, attempts: job.attempts + 1 });
        await tx.save(job);
        await tx.append(this.audit(job, "STARTED"));
        const input: AiEngineInput = Object.freeze({ schema_version: "1.0", job_id: job.id, tenant_id: job.tenantId,
          correlation_id: job.id, source_snapshot_id: job.request.snapshotId, canonical_catalog_version: job.request.sourceVersion,
          provider_record: source.provider, candidate_record: source.candidate });
        let result: Awaited<ReturnType<AiEngine["run"]>> | null = null;
        const controller = new AbortController();
        const cancelEngine = () => controller.abort(); requestSignal.addEventListener("abort", cancelEngine, { once: true });
        if (requestSignal.aborted) cancelEngine();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new AiJobError(503)); }, 4500); });
        const execution=this.deps!.engine.run(input, controller.signal);
        try { result = validateAiEngineResult(await Promise.race([execution, timeout]), input); }
        catch { /* No raw engine/transport error or unexpected output is stored. */ }
        finally { controller.abort();clearTimeout(timer); requestSignal.removeEventListener("abort", cancelEngine);if(this.deps?.executionControl)await execution.catch(()=>undefined); }
        if (!await fresh() || aiDigest(await this.source(b.tenantId, job.request)) !== job.sourceDigest) throw new AiJobError(403);
        if (result) {
          for (const event of result.events) await tx.append(this.audit(job, event.outcome, event));
          // Provider exhaustion is a retryable job failure, never a successful mapping.
          if (result.summary.provider !== null) job = Object.freeze({ ...job, state: "SUCCEEDED", retryAt: null, summary: result.summary });
          else result = null;
        }
        if (!result) job = Object.freeze({ ...job, state: job.attempts >= 2 ? "FAILED" : "RETRYABLE", retryAt: job.attempts >= 2 ? null : new Date(this.time() + 1000).toISOString(), summary: null });
        if(attempts&&reservation?.token)await tx.assertAttempt!(reservation.token);
        await tx.save(job); await tx.append(this.audit(job, job.state as "SUCCEEDED" | "RETRYABLE" | "FAILED"));
        if (!await fresh()) throw new AiJobError(403); return job;
      });
      if(attempts&&reservation?.token)await attempts.settle(this.ticket(b.tenantId,aiDigest([b.tenantId,jobId]),fresh),reservation,true);
      if (aiDigest(await this.source(b.tenantId, saved.request)) !== saved.sourceDigest) throw new AiJobError(403);
      return saved;
      }catch(error){
       // A rollback never refunds an invocation. Uncertain settlement remains
       // OPEN in the database, which forbids another reservation after restart.
       if(attempts&&reservation?.token)await attempts.settle(this.ticket(b.tenantId,aiDigest([b.tenantId,jobId]),fresh),reservation,false).catch(()=>{});
       throw error;
      }
    });
  }
}
