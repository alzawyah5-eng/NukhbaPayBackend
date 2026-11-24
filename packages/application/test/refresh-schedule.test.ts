import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {ScheduledCatalogRefresh,CatalogRefreshReadUnavailable,type CatalogRefreshSchedule} from '../src/catalog/refresh-schedule.js';
import type {CatalogSnapshotReadResult} from '../src/catalog/synthetic-provider-import.js';
import type {DraftPublicationCandidate} from '../src/catalog/publication-candidate.js';
import {createSyntheticProviders,SYNTHETIC_PRODUCT} from '../../provider-adapters/src/index.js';
import {aiFixture} from './fixtures/ai-jobs.js';
import type {ProviderOffer} from '../../provider-contracts/src/index.js';

async function fixture() {
  let now=Date.parse('2026-11-09T10:00:00Z'),fetches=0,imports=0,failSave=false;
  const provider=createSyntheticProviders()[0]!,initial=await provider.fetchCatalog(),productId=randomUUID();
  let current:CatalogRefreshSchedule={id:randomUUID(),tenantId:randomUUID(),providerAccountId:randomUUID(),providerId:provider.providerId,
    sourceVersion:'synthetic-v1',version:'1',enabled:true,firstRunAtMs:now,intervalMs:60000};
  let fetcher=async(_signal?:AbortSignal)=>initial;
  const snapshots=new Map<string,CatalogSnapshotReadResult>(),offers=new Map<string,readonly ProviderOffer[]>(),saved=new Map<string,DraftPublicationCandidate>();
  const deps={capability:'ISOLATED_SYNTHETIC_CATALOG_REFRESH_ONLY' as const,now:()=>new Date(now),concurrency:1,
    schedules:{find:async()=>current},providers:new Map([[provider.providerId,{providerId:provider.providerId,fetchCatalog:async(signal?:AbortSignal)=>{fetches++;return fetcher(signal);}}]]),
    catalog:{readSnapshot:async(_tenant:string,_account:string,key:string)=>snapshots.get(key)??null,
      importSyntheticSnapshot:async(context:{tenantId:string;providerAccountId:string;snapshotKey:string;sourceVersion:string;observedAt:string},rows:readonly ProviderOffer[])=>{
        imports++;const id=randomUUID();
        const snapshot={id,...context,effectiveAt:null,status:'COMPLETE' as const,rowCount:rows.length,startedAt:new Date(now).toISOString(),completedAt:new Date(now).toISOString()};
        snapshots.set(context.snapshotKey,{snapshot,offers:[]});offers.set(id,rows.map(row=>({...row,snapshotId:id})));
        return {...context,snapshotId:id,status:'COMPLETE' as const,created:true,counts:{products:1,mappings:1,offers:rows.length},acceptedAt:new Date(now).toISOString()};
      }},
    drafts:{prepare:async(source:CatalogSnapshotReadResult)=>[{
      tenantId:source.snapshot.tenantId,productId,product:SYNTHETIC_PRODUCT,offers:offers.get(source.snapshot.id)!,
      sourceSnapshots:[{snapshotId:source.snapshot.id,providerAccountId:source.snapshot.providerAccountId,snapshotKey:source.snapshot.snapshotKey,
        sourceVersion:source.snapshot.sourceVersion,observedAt:source.snapshot.observedAt,completedAt:source.snapshot.completedAt!,status:'COMPLETE' as const}],
      pricingPolicy:{version:'policy-v1',serviceFeeMinor:200n,maximumServiceFeeMinor:200n,taxAmountMinor:0n,paymentFeeBasisPoints:150,
        paymentFixedFeeMinor:20n,agentCommissionMinor:50n,minimumContributionMinor:100n,maximumOfferAgeMs:86400000},
      evaluatedAt:new Date(now).toISOString(),expectedPreviousVersion:0,idempotencyKey:randomUUID()}],
      save:async(candidate:DraftPublicationCandidate)=>{if(failSave)throw new Error('private database failure');saved.set(candidate.candidateId,candidate);
        return {candidateId:candidate.candidateId,priceVersion:candidate.priceVersion,execution:'NOT_AUTHORIZED' as const};}},
  };
  return {deps,worker:new ScheduledCatalogRefresh(deps),id:current.id,saved,snapshots,fetches:()=>fetches,imports:()=>imports,
    advance:(ms:number)=>{now+=ms;},disable:()=>{current={...current,enabled:false};},failSave:(value:boolean)=>{failSave=value;},
    setFetcher:(f:typeof fetcher)=>{fetcher=f;},initial};
}
const signal=()=>new AbortController().signal;

test('scheduled import and exact draft recalculation replay without refetch, republish or changing immutable versions',async()=>{
  const f=await fixture();const first=await f.worker.runDue(f.id,signal());assert.equal(first.state,'REFRESHED');
  const draft=[...f.saved.values()][0]!;assert.equal(draft.totalAmountMinor,10200n);assert.equal(draft.expectedContributionMinor,277n);
  assert.equal(draft.activationAllowed,false);assert.equal(draft.status,'DRAFT');assert.equal(draft.priceVersion,1);
  f.advance(1000);const replay=await f.worker.runDue(f.id,signal());assert.equal(replay.state,'REPLAYED');
  assert.deepEqual(first.draftIds,replay.draftIds);assert.equal(f.saved.size,1);assert.equal(f.fetches(),1);assert.equal(f.imports(),1);
});

test('recovery after draft persistence failure resumes the accepted import without another provider invocation',async()=>{
  const f=await fixture();f.failSave(true);
  await assert.rejects(()=>f.worker.runDue(f.id,signal()),{status:503,message:'Scheduled catalogue refresh unavailable'});
  assert.equal(f.saved.size,0);assert.equal(f.snapshots.size,1);f.failSave(false);f.advance(1000);
  assert.equal((await f.worker.runDue(f.id,signal())).state,'REPLAYED');
  assert.equal(f.fetches(),1);assert.equal(f.imports(),1);assert.equal(f.saved.size,1);
});

test('fresh schedule authorization and cancellation prevent writes after provider fetch',async()=>{
  for(const mode of ['disable','cancel'] as const){
    const f=await fixture(),abort=new AbortController();let entered!:()=>void,resume!:()=>void;
    const waiting=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{resume=r;});
    f.setFetcher(async()=>{entered();await gate;return f.initial;});
    const pending=f.worker.runDue(f.id,abort.signal);const rejected=assert.rejects(pending,{status:mode==='disable'?403:503});
    await waiting;if(mode==='disable')f.disable();else abort.abort();resume();await rejected;
    assert.equal(f.imports(),0);assert.equal(f.saved.size,0);
  }
});

test('per-account overlap is rejected and the slot is released after cancellation',async()=>{
  const f=await fixture(),abort=new AbortController();let entered!:()=>void,resume!:()=>void;
  const waiting=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{resume=r;});
  f.setFetcher(async()=>{entered();await gate;return f.initial;});
  const pending=f.worker.runDue(f.id,abort.signal);const rejected=assert.rejects(pending,{status:503});await waiting;
  await assert.rejects(()=>f.worker.runDue(f.id,signal()),{status:409});abort.abort();resume();await rejected;
  f.setFetcher(async()=>f.initial);assert.equal((await f.worker.runDue(f.id,signal())).state,'REFRESHED');
});

test('future schedules and disabled registrations never call providers or mutate catalogue data',async()=>{
  const f=await fixture();f.advance(-1);assert.equal((await f.worker.runDue(f.id,signal())).state,'NOT_DUE');
  assert.equal(f.fetches(),0);f.disable();await assert.rejects(()=>f.worker.runDue(f.id,signal()),{status:403});
  assert.equal(f.imports(),0);
});

test('foreign import evidence and tenant-substituted pricing requests cannot create drafts',async()=>{
  const f=await fixture();await f.worker.runDue(f.id,signal());f.saved.clear();
  const source=[...f.snapshots.values()][0]!;
  f.snapshots.set(source.snapshot.snapshotKey,{...source,snapshot:{...source.snapshot,tenantId:randomUUID()}});
  await assert.rejects(()=>f.worker.runDue(f.id,signal()),{status:409});assert.equal(f.saved.size,0);
  const g=await fixture(),prepare=g.deps.drafts.prepare;
  g.deps.drafts.prepare=async snapshot=>(await prepare(snapshot)).map(request=>({...request,tenantId:randomUUID()}));
  await assert.rejects(()=>g.worker.runDue(g.id,signal()),{status:403});assert.equal(g.saved.size,0);
});


test('only provider read failure is classified safe to retry, with no import or draft writes',async()=>{
 const f=await fixture();f.setFetcher(async()=>{throw new Error('PRIVATE provider outage');});
 await assert.rejects(f.worker.runDue(f.id,signal()),e=>e instanceof CatalogRefreshReadUnavailable);
 assert.equal(f.imports(),0);assert.equal(f.saved.size,0);
 const g=await fixture();g.failSave(true);await assert.rejects(g.worker.runDue(g.id,signal()),e=>!(e instanceof CatalogRefreshReadUnavailable));
});
test('durable retry pins an old slot, rejects expired offers and rejects a substituted version before provider access',async()=>{
 const f=await fixture(),registration=await f.deps.schedules.find();f.advance(86400000);
 await assert.rejects(f.worker.runDue(f.id,signal(),{version:registration.version,slotAtMs:registration.firstRunAtMs}),{status:503});
 assert.equal(f.saved.size,0);
 const accepted=[...f.snapshots.values()][0]!;assert.equal(accepted.snapshot.observedAt,new Date(registration.firstRunAtMs).toISOString());
 const g=await fixture();await assert.rejects(g.worker.runDue(g.id,signal(),{version:'forged',slotAtMs:registration.firstRunAtMs}),{status:409});assert.equal(g.fetches(),0);
});

test('exhausted AI advisory failures do not interrupt exact refresh pricing or authorize publication',async()=>{
 const ai=aiFixture({async run(){throw new Error('PRIVATE all advisory providers unavailable');}}),job=await ai.service.submit(ai.submitter,ai.request);
 assert.equal((await ai.service.process(ai.worker,job.id)).state,'RETRYABLE');ai.now.value+=1000;
 assert.equal((await ai.service.process(ai.worker,job.id)).state,'FAILED');
 const f=await fixture(),result=await f.worker.runDue(f.id,signal());assert.equal(result.state,'REFRESHED');assert.equal(result.execution,'NOT_AUTHORIZED');
 const draft=[...f.saved.values()][0]!;assert.equal(draft.totalAmountMinor,10200n);assert.equal(draft.expectedContributionMinor,277n);assert.equal(draft.activationAllowed,false);assert.equal(draft.status,'DRAFT');
 assert.equal(JSON.stringify(ai.store.events).includes('PRIVATE'),false);
});


test('durable refresh rejects a foreign tenant pin and lease expiry during provider read before writes', async () => {
 const f = await fixture();
 const registration = await f.deps.schedules.find();
 const pin = { version: registration.version, slotAtMs: registration.firstRunAtMs,
   tenantId: registration.tenantId, leaseUntilMs: registration.firstRunAtMs + 1000 };
 await assert.rejects(f.worker.runDue(f.id, signal(), { ...pin, tenantId: randomUUID() }), { status: 403 });
 assert.equal(f.fetches(), 0);
 f.setFetcher(async () => { f.advance(1000); return f.initial; });
 await assert.rejects(f.worker.runDue(f.id, signal(), pin), { status: 503 });
 assert.equal(f.fetches(), 1);
 assert.equal(f.imports(), 0);
 assert.equal(f.saved.size, 0);
});

test('database-backed refresh requires and passes the same exact claim to both write adapters', async () => {
 const f = await fixture();
 const registration = await f.deps.schedules.find();
 const claim = { tenantId:registration.tenantId, scheduleId:f.id, version:registration.version,
   slotAtMs:registration.firstRunAtMs, leaseUntilMs:registration.firstRunAtMs + 1000, token:randomUUID(), attempt:1 };
 const expected = { ...claim, claim, checkLease:async () => true };
 await assert.rejects(f.worker.runDue(f.id, signal(), expected), { status:403 });
 assert.equal(f.fetches(), 0);
 const fences:string[] = [];
 const fenced = new ScheduledCatalogRefresh({
   ...f.deps,
   catalog:{
     ...f.deps.catalog,
     importFencedSnapshot:async (context, rows, lease) => {
       assert.equal(lease, claim);
       fences.push('import');
       return f.deps.catalog.importSyntheticSnapshot(context, rows);
     },
   },
   drafts:{
     ...f.deps.drafts,
     saveFenced:async (candidate, lease) => {
       assert.equal(lease, claim);
       fences.push('draft');
       return f.deps.drafts.save(candidate);
     },
   },
 });
 await assert.rejects(fenced.runDue(f.id, signal(), { ...expected, claim:{...claim, slotAtMs:claim.slotAtMs+1} }), { status:403 });
 const result = await fenced.runDue(f.id, signal(), expected);
 assert.equal(result.state, 'REFRESHED');
 assert.equal(result.execution, 'NOT_AUTHORIZED');
 assert.deepEqual(fences, ['import','draft']);
});
