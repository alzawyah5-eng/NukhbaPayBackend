import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { AI_JOB_AUDIENCE, AiJobService, AiJobError, consumeAiJobTicket, reviewHybridPricing,
  type AiApprovedPair, type DraftPublicationRequest, type AiJobRecord, type AiJobAudit, type AiServiceBinding,
  type AiJobStore, type AiJobScope, type AiEngineInput, type AiJobRequest, type AiEngine } from "@nukhbapay/application";
import { InternalAiJobBoundary, SyntheticAiServiceVerifier } from "../src/jobs/product-intelligence/boundary.js";
import { MockPythonAiEngine } from "../src/jobs/product-intelligence/python-engine.js";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const python = process.env["NUKHBAPAY_AI_TEST_PYTHON"] ?? (process.platform === "win32"
  ? path.join(process.env["LOCALAPPDATA"]!, "Programs/Python/Python313/python.exe") : "/usr/bin/python3");
const now = new Date("2026-11-17T10:00:00Z"), issuer = "https://ai.synthetic.invalid/";
test("Python cancellation acknowledges termination only after the child close event",async()=>{
 const original=childProcess.spawn;let closed=false,spawned=false;
 childProcess.spawn=((...args:Parameters<typeof childProcess.spawn>)=>{const child=original(...args);spawned=true;child.once('close',()=>{closed=true;});return child;}) as typeof childProcess.spawn;
 syncBuiltinESMExports();
 try{const engine=new MockPythonAiEngine({repositoryRoot:root,pythonExecutable:python,mockScenario:'worker_timeout'}),abort=new AbortController();
  const pending=engine.run({schema_version:'1.0'} as AiEngineInput,abort.signal);setTimeout(()=>abort.abort(),100);
  await assert.rejects(pending);assert.equal(spawned,true);assert.equal(closed,true);
 }finally{childProcess.spawn=original;syncBuiltinESMExports();}
});
const keys = await generateKeyPair("RS256"), jwk = { ...await exportJWK(keys.publicKey), kid: "synthetic-ai-key", use: "sig", alg: "RS256" };
async function token(scope: AiJobScope = "ai.jobs.submit", patch: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  return new SignJWT({ sub: scope, client_id: scope, scope, principal_kind: "machine", client_profile: "synthetic-ai-worker-v1", ...patch })
    .setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid: jwk.kid, ...header }).setIssuer(issuer).setAudience(AI_JOB_AUDIENCE)
    .setIssuedAt(now.getTime() / 1000).setExpirationTime(now.getTime() / 1000 + 300).setJti(randomUUID()).sign(keys.privateKey);
}
function fixture(scenario?: ConstructorParameters<typeof MockPythonAiEngine>[0]["mockScenario"], override?: AiEngine) {
  const tenant = randomUUID(), jobs = new Map<string, AiJobRecord>(), audit: AiJobAudit[] = [], state = { deniedAudit: false, enabled: true, sourceTenant: tenant, time: now.getTime() };
  const request: AiJobRequest = { schemaVersion: "ai-job-v1", idempotencyKey: randomUUID(), snapshotId: randomUUID(), sourceVersion: "synthetic-v1", offerId: randomUUID(), candidateProductId: randomUUID() };
  const p = { record_id: "synthetic-provider", category: "gift_card" as const, country: "AE", currency: "AED", issuer_id: "synthetic-brand", denomination_minor: "10000", redemption_region: "AE", validity: "P365D", fulfillment_method: "PIN", restriction_codes: [] };
  const store: AiJobStore = { async transaction(value, work) {
    const ticket = consumeAiJobTicket(value), pending = new Map(jobs), events: AiJobAudit[] = [];
    const result = await work({ find: async id => pending.get(id) ?? null,
      findKey: async (client, key) => [...pending.values()].find(j => j.clientDigest === client && j.request.idempotencyKey === key) ?? null,
      insert: async j => { pending.set(j.id, j); }, save: async j => { pending.set(j.id, j); },
      append: async e => { if (state.deniedAudit) throw new Error("SECRET audit unavailable"); events.push(e); } });
    if (!await ticket.revalidate()) throw new AiJobError(403);
    jobs.clear(); for (const [id, j] of pending) jobs.set(id, j); audit.push(...events); return result;
  } };
  const engine = override ?? new MockPythonAiEngine({ repositoryRoot: root, pythonExecutable: python, ...(scenario ? { mockScenario: scenario } : {}) });
  const source=():AiApprovedPair=>({tenantId:state.sourceTenant,snapshotId:request.snapshotId,sourceVersion:request.sourceVersion,offerId:request.offerId,
    candidateProductId:request.candidateProductId,approved:true,status:'COMPLETE',accountActive:true,
    observedAt:'2026-11-17T09:00:00Z',completedAt:'2026-11-17T09:01:00Z',validUntil:'2026-11-17T12:00:00Z',
    provider:p,candidate:{...p,record_id:'synthetic-canonical'}});
  const service = new AiJobService({ capability: "ISOLATED_SYNTHETIC_AI_JOBS_ONLY", engine, store, now: () => new Date(state.time),
    bindings: { async find(id): Promise<AiServiceBinding> { return { issuer, subject: id.subject, clientId: id.clientId, tenantId: tenant, scope: id.scope, enabled: state.enabled, version: "1" }; } },
    sources: { async read() { return source(); } } });
  const boundary = new InternalAiJobBoundary({ verifier: new SyntheticAiServiceVerifier(issuer, [jwk], () => new Date(state.time)), service });
  return { boundary, request, jobs, audit, state, engine, tenant, source };
}
async function finish(f: ReturnType<typeof fixture>, id: string) {
  let result = await f.boundary.process(await token("ai.jobs.process"), id);
  // Cold OS/interpreter startup can consume the process deadline. Exercise the
  // actual bounded job retry, without relaxing any provider or process timeout.
  if (result.state === "RETRYABLE") { f.state.time += 1000; result = await f.boundary.process(await token("ai.jobs.process"), id); }
  return result;
}
test('committed hybrid advice binds an exact deterministic price draft to one verified offer',async()=>{
  const f=fixture('primary_failure'),pair=f.source();
  const product:DraftPublicationRequest['product']={canonicalProductId:'fixture-gift',brand:'synthetic-brand',
    redemptionCountry:'AE',currency:'AED',faceValueMinor:10000n,fulfillmentMethod:'DIGITAL_PIN',termsVersion:'v1'};
  const draft:DraftPublicationRequest={tenantId:f.tenant,productId:pair.candidateProductId,product,
    sourceSnapshots:[{snapshotId:pair.snapshotId,providerAccountId:randomUUID(),snapshotKey:'fixture',sourceVersion:pair.sourceVersion,
      observedAt:pair.observedAt,completedAt:pair.completedAt,status:'COMPLETE'}],
    offers:[{providerId:'FINXPLOR',offerId:pair.offerId,snapshotId:pair.snapshotId,identity:product,providerDebitMinor:9700n,
      upfrontDiscountMinor:300n,additionalProviderFeeMinor:0n,available:true,eligible:true,mappingStatus:'APPROVED',
      observedAt:pair.observedAt,validUntil:pair.validUntil}],
    pricingPolicy:{version:'fixture-v1',serviceFeeMinor:200n,maximumServiceFeeMinor:200n,taxAmountMinor:0n,
      paymentFeeBasisPoints:150,paymentFixedFeeMinor:20n,agentCommissionMinor:50n,minimumContributionMinor:100n,maximumOfferAgeMs:86400000},
    evaluatedAt:now.toISOString(),expectedPreviousVersion:0,idempotencyKey:randomUUID()};
  const start=await f.boundary.submit(await token(),f.request);
  assert.equal((await finish(f,start.id)).state,'SUCCEEDED');
  const job=f.jobs.get(start.id)!;
  assert.equal(job.summary?.provider,'anthropic');
  const value=reviewHybridPricing(draft,{job,pair},new Date(f.state.time));
  assert.equal(value.draft.totalAmountMinor,10200n);
  assert.equal(value.draft.expectedContributionMinor,277n);
  assert.equal(value.advisory.canAuthorize,false);
  assert.equal(value.draft.activationAllowed,false);
  assert.throws(()=>reviewHybridPricing(draft,{job,pair:{...pair,tenantId:randomUUID()}},now));
  assert.throws(()=>reviewHybridPricing(draft,{job,pair},new Date(pair.validUntil)));
});
test("default internal worker has no enabled authorization composition", async () => {
  await assert.rejects(new InternalAiJobBoundary().submit("", {}), (e: unknown) => e instanceof AiJobError && e.status === 503);
  assert.throws(() => new SyntheticAiServiceVerifier("https://production.example/", [jwk], () => now));
});
test("missing, forged, wrong-profile, delegated and tenant-bearing credentials deny before storage", async () => {
  const f = fixture();
  const good = await token();
  for (const bad of ["", "not-a-token", `${good.slice(0, good.lastIndexOf('.') + 1)}forged`,
    await token("ai.jobs.submit", { principal_kind: "human" }), await token("ai.jobs.submit", { client_profile: "synthetic-catalogue-client-v1" }),
    await token("ai.jobs.submit", { tenant_id: f.tenant }), await token("ai.jobs.submit", { roles: ["admin"] }), await token("ai.jobs.submit", { act: { sub: "other" } }),
    await token("ai.jobs.submit", {}, { jku: "https://keys.invalid/" })]) await assert.rejects(f.boundary.submit(bad, f.request));
  assert.equal(f.jobs.size, 0);
});
test("signed submit and worker scopes are independent; disabled bindings and foreign sources deny", async () => {
  const f = fixture();
  await assert.rejects(f.boundary.submit(await token("ai.jobs.process"), f.request));
  f.state.enabled = false; await assert.rejects(f.boundary.submit(await token(), f.request));
  f.state.enabled = true; f.state.sourceTenant = randomUUID(); await assert.rejects(f.boundary.submit(await token(), f.request));
});
test("worker tokens require exact audience and live issuance/expiry; remote key URLs cannot be configured", async () => {
  const verifier = new SyntheticAiServiceVerifier(issuer, [jwk], () => now), valid = await token();
  const wrongAudience = await new SignJWT({ sub: "synthetic", client_id: "synthetic", scope: "ai.jobs.submit", principal_kind: "machine", client_profile: "synthetic-ai-worker-v1" })
    .setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid: jwk.kid }).setIssuer(issuer).setAudience("urn:nukhbapay:synthetic:payment-catalogue")
    .setIssuedAt(now.getTime()/1000).setExpirationTime(now.getTime()/1000+300).setJti(randomUUID()).sign(keys.privateKey);
  await assert.rejects(verifier.verify(wrongAudience, "ai.jobs.submit"));
  await assert.rejects(new SyntheticAiServiceVerifier(issuer, [jwk], () => new Date(now.getTime()+300000)).verify(valid, "ai.jobs.submit"));
  await assert.rejects(new SyntheticAiServiceVerifier(issuer, [jwk], () => new Date(now.getTime()-1000)).verify(valid, "ai.jobs.submit"));
  const remoteKey = { ...jwk, jku: "https://untrusted.invalid/" };
  assert.throws(() => new SyntheticAiServiceVerifier(issuer, [remoteKey], () => now));
});
test("signed internal boundary executes existing Python mock engine with committed advisory provenance", async () => {
  const f = fixture(), submitted = await f.boundary.submit(await token(), f.request);
  await assert.rejects(f.boundary.process(await token(), submitted.id));
  const result = await finish(f, submitted.id);
  assert.equal(result.state, "SUCCEEDED"); assert.equal(result.summary!.provider, "openai");
  assert.equal(result.summary!.can_publish, false); assert.equal(result.summary!.manualReview, true);
  assert.equal(f.audit.filter(e => e.outcome === "SUBMITTED").length, 1);
  assert.deepEqual(f.audit.map(e => e.outcome).slice(-3), ["STARTED", "VALIDATED", "SUCCEEDED"]);
  assert.equal((await f.boundary.submit(await token(), f.request)).id, result.id);
});
test("real subprocess preserves fallback, timeout and invalid-output events in job audit", async () => {
  for (const [scenario, expected] of [["primary_failure", "PROVIDER_FAILURE"], ["primary_timeout", "TIMEOUT"], ["invalid_primary_output", "INVALID_OUTPUT"]] as const) {
    const f = fixture(scenario), job = await f.boundary.submit(await token(), f.request);
    const result = await finish(f, job.id);
    assert.equal(result.summary!.provider, "anthropic"); assert.equal(result.summary!.can_publish, false);
    assert.ok(f.audit.some(e => e.provider === "openai" && e.outcome === expected));
    assert.ok(f.audit.some(e => e.provider === "anthropic" && e.outcome === "VALIDATED"));
  }
});
test("provider exhaustion becomes a retryable job; audit failure discloses no suggestion", async () => {
  const f = fixture("all_failure"), job = await f.boundary.submit(await token(), f.request);
  const result = await f.boundary.process(await token("ai.jobs.process"), job.id);
  assert.equal(result.state, "RETRYABLE"); assert.equal(result.summary, null);
  const failed = fixture(), other = await failed.boundary.submit(await token(), failed.request);
  failed.state.deniedAudit = true; await assert.rejects(failed.boundary.process(await token("ai.jobs.process"), other.id));
  assert.equal(failed.jobs.get(other.id)!.state, "QUEUED");
});
test("authority injection cannot pass either the job boundary or Python contract", async () => {
  const f = fixture();
  for (const extra of [{ price: "1.00" }, { can_publish: true }, { mockScenario: "primary_failure" }])
    await assert.rejects(f.boundary.submit(await token(), { ...f.request, ...extra }));
  const input = { schema_version: "1.0", job_id: randomUUID(), tenant_id: f.tenant, correlation_id: "synthetic", source_snapshot_id: f.request.snapshotId, canonical_catalog_version: "synthetic-v1", price: "SECRET" };
  await assert.rejects(f.engine.run(input as unknown as AiEngineInput, new AbortController().signal), (e: unknown) => e instanceof AiJobError && e.message === "AI job unavailable");
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(f.engine.run(input as unknown as AiEngineInput, aborted.signal));
});
