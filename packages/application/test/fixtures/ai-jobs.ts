import { randomUUID } from "node:crypto";
import { AiJobError, AiJobService, AI_JOB_AUDIENCE, attestAiServiceIdentity, consumeAiJobTicket,
  type AiApprovedPair, type AiJobAudit, type AiJobRecord, type AiJobRequest, type AiJobStore, type AiJobScope, type AiJobTicket, type AiJobTransaction,
  type AiEngine, type AiServiceBinding, type AiServiceIdentity, type AiJobDependencies } from "../../src/catalog/ai-jobs.js";

/** Transactional in-memory test double; never an operational composition. */
export class MemoryAiJobs implements AiJobStore {
  jobs = new Map<string, AiJobRecord>(); events: AiJobAudit[] = [];
  auditFailure = false; commitFailure = false; readonly locks = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  async transaction<T>(value: AiJobTicket, work: (tx: AiJobTransaction) => Promise<T>): Promise<T> {
    const ticket = consumeAiJobTicket(value);
    if (this.locks.has(ticket.lockKey)) throw new AiJobError(409);
    this.locks.add(ticket.lockKey);
    const previous = this.tail; let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const jobs = new Map(this.jobs), events = [...this.events];
    try {
      if (!await ticket.revalidate()) throw new AiJobError(403);
      const result = await work({
        find: async id => { const j = jobs.get(id); return j?.tenantId === ticket.tenantId ? j : null; },
        findKey: async (client, key) => [...jobs.values()].find(j => j.tenantId === ticket.tenantId && j.clientDigest === client && j.request.idempotencyKey === key) ?? null,
        insert: async j => { jobs.set(j.id, j); }, save: async j => { jobs.set(j.id, j); },
        append: async e => { if (this.auditFailure) throw new Error("SECRET audit connection"); events.push(e); },
      });
      if (this.commitFailure || !await ticket.revalidate()) throw new AiJobError(503);
      this.jobs = jobs; this.events = events; return result as T;
    } finally { release(); this.locks.delete(ticket.lockKey); }
  }
}
export function aiFixture(engineOverride?: AiEngine) {
  const now = { value: Date.parse("2026-11-17T10:00:00Z") }, tenant = randomUUID(), otherTenant = randomUUID();
  const request: AiJobRequest = { schemaVersion: "ai-job-v1", idempotencyKey: randomUUID(), snapshotId: randomUUID(), sourceVersion: "synthetic-v1", offerId: randomUUID(), candidateProductId: randomUUID() };
  const p = Object.freeze({ record_id: "synthetic-provider-record", category: "gift_card" as const, country: "AE", currency: "AED", issuer_id: "synthetic-brand", denomination_minor: "10000", redemption_region: "AE", validity: "P365D", fulfillment_method: "PIN", restriction_codes: Object.freeze([] as string[]) });
  const source: AiApprovedPair = { tenantId: tenant, snapshotId: request.snapshotId, sourceVersion: request.sourceVersion, offerId: request.offerId,
    candidateProductId: request.candidateProductId, approved: true, status: "COMPLETE", accountActive: true,
    observedAt: "2026-11-17T09:00:00Z", completedAt: "2026-11-17T09:05:00Z", validUntil: "2026-11-17T12:00:00Z",
    provider: p, candidate: { ...p, record_id: "synthetic-canonical-record" } };
  const identities = new Map<AiJobScope, AiServiceIdentity>();
  const bindings = new Map<string, AiServiceBinding>();
  for (const scope of ["ai.jobs.submit", "ai.jobs.process"] as const) {
    const id = attestAiServiceIdentity({ issuer: "https://ai.synthetic.invalid/", subject: scope, clientId: scope, scope, audience: AI_JOB_AUDIENCE, issuedAt: now.value / 1000, expiresAt: now.value / 1000 + 300 });
    identities.set(scope, id); bindings.set(id.clientId, { issuer: id.issuer, subject: id.subject, clientId: id.clientId, scope, tenantId: tenant, enabled: true, version: "1" });
  }
  const store = new MemoryAiJobs(), state = { calls: 0, source: source as AiApprovedPair | null, authFailure: false, ownershipFailure: false };
  const engine: AiEngine = engineOverride ?? { async run() { state.calls++; return { summary: { provider: "openai", modelVersion: "mock-openai-v1", promptVersion: "product-match-mock-v1", rulesVersion: "equivalence-v1", decision: "CANDIDATE", confidenceBps: 9800, duplicateCandidate: true, manualReview: true, can_publish: false },
    events: [{ schema_version: "hybrid-audit-v1", provider: "openai", model_version: "mock-openai-v1", prompt_version: "product-match-mock-v1", attempt: 1, outcome: "VALIDATED" }] }; } };
  const deps: AiJobDependencies = { capability: "ISOLATED_SYNTHETIC_AI_JOBS_ONLY", store, engine, now: () => new Date(now.value),
    bindings: { async find(id) { if (state.authFailure) throw new Error("SECRET binding store"); return bindings.get(id.clientId) ?? null; } },
    sources: { async read() { if (state.ownershipFailure) throw new Error("SECRET source store"); return state.source; } } };
  return { service: new AiJobService(deps), deps, now, tenant, otherTenant, request, source, state, store, bindings,
    submitter: identities.get("ai.jobs.submit")!, worker: identities.get("ai.jobs.process")! };
}
