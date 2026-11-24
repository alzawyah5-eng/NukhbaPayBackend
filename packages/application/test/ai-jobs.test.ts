import assert from "node:assert/strict";
import test from "node:test";
import { AiJobError, AiJobService, aiDigest, attestAiServiceIdentity, consumeAiJobTicket, validateAiEngineResult, type AiApprovedPair, type AiEngineInput, type AiEngine } from "../src/catalog/ai-jobs.js";
import { aiFixture } from "./fixtures/ai-jobs.js";

const denied = (status: number) => (e: unknown) => e instanceof AiJobError && e.status === status && e.message === "AI job unavailable";
test("result reads require their own scope, submitting client, tenant and current ownership", async () => {
  const f = aiFixture(), job = await f.service.submit(f.submitter, f.request);
  await f.service.process(f.worker, job.id);
  await assert.rejects(f.service.read(f.submitter, job.id), denied(403));
  const reader = attestAiServiceIdentity({ ...f.submitter, scope: "ai.jobs.read" });
  const binding = { ...f.bindings.get(reader.clientId)!, scope: "ai.jobs.read" as const };
  f.bindings.set(reader.clientId, binding);
  assert.equal((await f.service.read(reader, job.id)).summary!.can_publish, false);
  const other = attestAiServiceIdentity({ ...reader, subject: "other", clientId: "other" });
  f.bindings.set(other.clientId, { ...binding, subject: "other", clientId: "other" });
  await assert.rejects(f.service.read(other, job.id), denied(403));
  f.bindings.set(reader.clientId, { ...binding, tenantId: f.otherTenant });
  await assert.rejects(f.service.read(reader, job.id), denied(403));
  f.bindings.set(reader.clientId, binding); f.state.source = null;
  await assert.rejects(f.service.read(reader, job.id), denied(403));
});
test("AI jobs default disabled; structural, anonymous and wrong-scope identities cannot authorize", async () => {
  const f = aiFixture();
  await assert.rejects(new AiJobService().submit(f.submitter, f.request), denied(503));
  for (const identity of [null, {}, { ...f.submitter }]) await assert.rejects(f.service.submit(identity as typeof f.submitter, f.request), denied(401));
  await assert.rejects(f.service.submit(f.worker, f.request), denied(403));
  assert.equal(f.store.jobs.size, 0);
  assert.throws(() => consumeAiJobTicket({ tenantId: f.tenant, lockKey: "forged", revalidate: async () => true }), denied(403));
});
test("reference-only submissions reject tenant, price, publication, prompts and batch injection", async () => {
  const f = aiFixture();
  for (const extra of [{ tenantId: f.otherTenant }, { price: "0.01" }, { can_publish: true }, { publish: true }, { prompt: "SECRET" }, { products: Array(101).fill({}) }])
    await assert.rejects(f.service.submit(f.submitter, { ...f.request, ...extra }), denied(400));
  for (const patch of [{ sourceVersion: "x".repeat(129) }, { snapshotId: "forged" }, { schemaVersion: "v2" }, { offerId: null }])
    await assert.rejects(f.service.submit(f.submitter, { ...f.request, ...patch }), denied(400));
  assert.equal(f.store.jobs.size, 0);
});
test("tenant and every approved source reference must agree with trusted ownership evidence", async () => {
  const f = aiFixture();
  for (const patch of [{ tenantId: f.otherTenant }, { sourceVersion: "different" }, { offerId: f.otherTenant }, { candidateProductId: f.otherTenant },
    { snapshotId: f.otherTenant }, { approved: false }, { status: "FAILED" }, { accountActive: false },
    { observedAt: "2026-11-15T09:00:00Z" }, { completedAt: "2026-11-18T09:00:00Z" }, { validUntil: "2026-11-17T09:00:00Z" }, { validUntil: "2026-11-31T09:00:00Z" }]) {
    f.state.source = { ...f.source, ...patch } as AiApprovedPair;
    await assert.rejects(f.service.submit(f.submitter, f.request), denied(403));
  }
  f.state.source = null; await assert.rejects(f.service.submit(f.submitter, f.request), denied(403));
});
test("trusted product projections still enforce strict attribute and restriction bounds", async () => {
  const f = aiFixture();
  for (const patch of [{ denomination_minor: "100.00" }, { restriction_codes: Array(101).fill("X") }, { issuer_id: "x".repeat(129) }, { price: "1.00" }]) {
    f.state.source = { ...f.source, provider: { ...f.source.provider, ...patch } } as AiApprovedPair;
    await assert.rejects(f.service.submit(f.submitter, f.request));
  }
  assert.equal(f.store.jobs.size, 0);
});
test("idempotent replay returns one queued job and conflicting content is rejected", async () => {
  const f = aiFixture(), first = await f.service.submit(f.submitter, f.request), again = await f.service.submit(f.submitter, f.request);
  assert.equal(first.id, again.id); assert.equal(first.state, "QUEUED"); assert.equal(f.store.events.length, 1);
  const reordered = Object.fromEntries(Object.entries(f.request).reverse());
  assert.equal((await f.service.submit(f.submitter, reordered)).id, first.id);
  f.state.source = { ...f.source, sourceVersion: "synthetic-v2" };
  await assert.rejects(f.service.submit(f.submitter, { ...f.request, sourceVersion: "synthetic-v2" }), denied(409));
});
test("concurrent submissions converge after busy retry without duplicate processing", async () => {
  const f = aiFixture(), results = await Promise.allSettled(Array.from({ length: 8 }, () => f.service.submit(f.submitter, f.request)));
  const successful = results.filter(r => r.status === "fulfilled");
  assert.ok(successful.length >= 1); assert.equal(f.store.jobs.size, 1); assert.equal(f.store.events.length, 1);
  for (const r of results) if (r.status === "rejected") assert.ok(denied(409)(r.reason));
  const replay = await f.service.submit(f.submitter, f.request); assert.equal(replay.id, [...f.store.jobs.keys()][0]);
});
test("processing preserves advisory provenance and terminal replay never reruns the engine", async () => {
  const f = aiFixture(), job = await f.service.submit(f.submitter, f.request);
  const result = await f.service.process(f.worker, job.id);
  assert.equal(result.state, "SUCCEEDED"); assert.equal(result.attempts, 1);
  assert.equal(result.summary!.can_publish, false); assert.equal(result.summary!.manualReview, true);
  assert.equal((await f.service.process(f.worker, job.id)).id, job.id); assert.equal(f.state.calls, 1);
  assert.deepEqual(f.store.events.map(e => e.outcome), ["SUBMITTED", "STARTED", "VALIDATED", "SUCCEEDED"]);
});
test("concurrent workers execute a job once", async () => {
  const f = aiFixture(), job = await f.service.submit(f.submitter, f.request);
  const results = await Promise.allSettled([f.service.process(f.worker, job.id), f.service.process(f.worker, job.id)]);
  assert.equal(f.state.calls, 1); assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const rejected = results.find(r => r.status === "rejected"); assert.ok(rejected?.status === "rejected" && denied(409)(rejected.reason));
});
test("cross-tenant processing and source drift are denied even for a formerly valid job", async () => {
  const f = aiFixture(), job = await f.service.submit(f.submitter, f.request), binding = f.bindings.get(f.worker.clientId)!;
  f.bindings.set(f.worker.clientId, { ...binding, tenantId: f.otherTenant });
  await assert.rejects(f.service.process(f.worker, job.id), denied(403));
  f.bindings.set(f.worker.clientId, binding); f.state.source = { ...f.source, provider: { ...f.source.provider, issuer_id: "changed" } };
  await assert.rejects(f.service.process(f.worker, job.id), denied(403)); assert.equal(f.state.calls, 0);
});
test("revocation during processing rolls back job state and audit with no result disclosure", async () => {
  const f = aiFixture(), job = await f.service.submit(f.submitter, f.request), original = f.deps.engine;
  const service = new AiJobService({ ...f.deps, engine: { async run(input, signal) {
    const result = await original.run(input, signal); f.bindings.delete(f.worker.clientId); return result;
  } } });
  await assert.rejects(service.process(f.worker, job.id));
  assert.equal(f.store.jobs.get(job.id)!.state, "QUEUED"); assert.equal(f.store.events.length, 1);
});
test("missing ownership and unavailable authorization stores fail closed with sanitized errors", async () => {
  const f = aiFixture(); f.state.authFailure = true;
  await assert.rejects(f.service.submit(f.submitter, f.request), denied(503));
  f.state.authFailure = false; f.state.ownershipFailure = true;
  await assert.rejects(f.service.submit(f.submitter, f.request), denied(503)); assert.equal(f.store.jobs.size, 0);
});
test("audit or commit failure rolls back submission and processing", async () => {
  const f = aiFixture(); f.store.auditFailure = true;
  await assert.rejects(f.service.submit(f.submitter, f.request), denied(503)); assert.equal(f.store.jobs.size, 0);
  f.store.auditFailure = false; f.store.commitFailure = true;
  await assert.rejects(f.service.submit(f.submitter, f.request), denied(503)); assert.equal(f.store.jobs.size, 0);
  f.store.commitFailure = false; const job = await f.service.submit(f.submitter, f.request);
  f.store.auditFailure = true; await assert.rejects(f.service.process(f.worker, job.id), denied(503));
  assert.equal(f.state.calls, 0); assert.equal(f.store.jobs.get(job.id)!.attempts, 0);
});
test("engine failures use bounded safe retries and terminate after two attempts", async () => {
  const f = aiFixture({ async run() { throw new Error("SECRET provider API failure"); } }), job = await f.service.submit(f.submitter, f.request);
  assert.equal((await f.service.process(f.worker, job.id)).state, "RETRYABLE");
  await assert.rejects(f.service.process(f.worker, job.id), denied(409));
  f.now.value += 1000;
  assert.equal((await f.service.process(f.worker, job.id)).state, "FAILED");
  assert.equal((await f.service.process(f.worker, job.id)).attempts, 2);
  assert.ok(!JSON.stringify(f.store.events).includes("SECRET"));
});
test("lost commit acknowledgements recover by replay without repeating processing", async () => {
  const f = aiFixture(); let lose = true;
  const store: typeof f.deps.store = { async transaction(ticket, work) {
    const result = await f.store.transaction(ticket, work);
    if (lose) { lose = false; throw new Error("SECRET lost acknowledgement"); }
    return result;
  } };
  const service = new AiJobService({ ...f.deps, store });
  await assert.rejects(service.submit(f.submitter, f.request), denied(503));
  const job = await service.submit(f.submitter, f.request); assert.equal(f.store.jobs.size, 1);
  lose = true; await assert.rejects(service.process(f.worker, job.id), denied(503));
  assert.equal((await service.process(f.worker, job.id)).state, "SUCCEEDED"); assert.equal(f.state.calls, 1);
});
test("ownership revocation during commit acknowledgement prevents response disclosure", async () => {
  const f = aiFixture(); let revoke = false;
  const store: typeof f.deps.store = { async transaction(ticket, work) {
    const result = await f.store.transaction(ticket, work); if (revoke) f.state.source = null; return result;
  } };
  const service = new AiJobService({ ...f.deps, store }), job = await service.submit(f.submitter, f.request);
  revoke = true; await assert.rejects(service.process(f.worker, job.id), denied(403));
  assert.equal(f.store.jobs.get(job.id)!.state, "SUCCEEDED");
  await assert.rejects(service.process(f.worker, job.id), denied(403));
});
test("engine that ignores cancellation is still bounded and cannot commit a late result", async () => {
  const f = aiFixture({ run: () => new Promise(() => {}) }), job = await f.service.submit(f.submitter, f.request);
  const result = await f.service.process(f.worker, job.id); assert.equal(result.state, "RETRYABLE"); assert.equal(result.summary, null);
});
test("unexpected output, financial fields and publication flags never enter stored results", async () => {
  const f = aiFixture(), engine = f.deps.engine;
  for (const patch of [{ can_publish: true }, { manualReview: false }, { confidenceBps: 1.5 }, { confidenceBps: 10001 }, { price: "0.01" }, { provider: "unknown" }]) {
    const service = new AiJobService({ ...f.deps, engine: { async run(i, s) { const r = await engine.run(i, s); return { ...r, summary: { ...r.summary, ...patch } } as Awaited<ReturnType<AiEngine["run"]>>; } } });
    const j = await service.submit(f.submitter, { ...f.request, idempotencyKey: crypto.randomUUID() });
    const result = await service.process(f.worker, j.id); assert.equal(result.state, "RETRYABLE"); assert.equal(result.summary, null);
  }
});
test("audit contains only allowlisted references, provider metadata and outcomes", async () => {
  const f = aiFixture(), job = await f.service.submit(f.submitter, f.request); await f.service.process(f.worker, job.id);
  const encoded = JSON.stringify(f.store.events);
  for (const value of ["denomination_minor", "issuer_id", "synthetic-brand", "prompt", "token", f.submitter.subject]) assert.equal(encoded.includes(value), false);
  assert.ok(encoded.includes(job.id)); assert.ok(encoded.includes(f.tenant)); assert.ok(encoded.includes(job.request.snapshotId));
});
test("independent result validation rejects hard-constraint overrides and missing provider evidence", async () => {
  const f = aiFixture(), input: AiEngineInput = { schema_version: "1.0", job_id: crypto.randomUUID(), tenant_id: f.tenant, correlation_id: "synthetic", source_snapshot_id: f.request.snapshotId, canonical_catalog_version: f.request.sourceVersion, provider_record: f.source.provider, candidate_record: f.source.candidate };
  const result = await f.deps.engine.run(input, new AbortController().signal);
  assert.throws(() => validateAiEngineResult({ ...result, events: [] }, input));
  assert.throws(() => validateAiEngineResult(result, { ...input, candidate_record: { ...input.candidate_record, currency: "USD" } }));
  assert.equal(aiDigest(f.request), aiDigest({ ...f.request }));
});
