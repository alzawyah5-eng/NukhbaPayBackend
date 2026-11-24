import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {CatalogRefreshReadUnavailable,dailyRefreshSchedule,type DurableRefreshStore,type RefreshClaim,type RefreshSettlement,type ScheduledCatalogRefresh} from '@nukhbapay/application';
import {CatalogueRefreshHost} from '../src/jobs/catalogue-refresh-host.js';

/** Deliberately a durable-state test double across host instances, not PG acceptance. */
function fixture(){
  let now=Date.parse('2026-11-19T10:00:00Z'),closed=0,calls=0;
  const schedule=dailyRefreshSchedule({id:randomUUID(),tenantId:randomUUID(),providerAccountId:randomUUID(),providerId:'synthetic',sourceVersion:'v1',version:'1',enabled:true},600,now);
  let claim:RefreshClaim|undefined,result:RefreshSettlement|undefined;
  const events:string[]=[];
  const store:DurableRefreshStore={find:async()=>schedule,close:async()=>{closed++;},
    expire:async at=>{if(claim&&!result&&claim.leaseUntilMs<=at){result={state:'UNCERTAIN',reason:'LEASE_EXPIRED',nextAttemptAtMs:null};events.push('UNCERTAIN');}},
    claim:async(at,lease)=>{if(claim&&(!result||result.state!=='RETRY_WAIT'||result.nextAttemptAtMs!>at))return null;
      claim={tenantId:schedule.tenantId,scheduleId:schedule.id,version:schedule.version,slotAtMs:schedule.firstRunAtMs,token:randomUUID(),attempt:(claim?.attempt??0)+1,leaseUntilMs:at+lease};result=undefined;events.push('CLAIMED');return claim;},
    settle:async(c,r,at)=>{assert.equal(c.token,claim?.token);assert.ok(c.leaseUntilMs>at);assert.equal(result,undefined);result=r;events.push(r.state);}};
  let work:Pick<ScheduledCatalogRefresh,'runDue'>['runDue']=async()=>({state:'REPLAYED',execution:'NOT_AUTHORIZED',snapshotId:randomUUID(),draftIds:[]});
  const refresh:Pick<ScheduledCatalogRefresh,'runDue'>={runDue:async(...args)=>{calls++;return work(...args);}};
  const options={concurrency:2,pollMs:10,timeoutMs:100,leaseMs:1100,ownsStore:false};
  const host=()=>new CatalogueRefreshHost({store,refresh,now:()=>new Date(now),options});
  return {host,store,schedule,options,events,setWork:(w:typeof work)=>{work=w;},advance:(ms:number)=>{now+=ms;},result:()=>result,claim:()=>claim,calls:()=>calls,closed:()=>closed};
}
const signal=()=>new AbortController().signal;
test('UTC daily schedule validates and host restart reuses durable success without duplicate refresh',async()=>{
 const f=fixture();await f.host().pollOnce(signal());assert.equal(f.result()?.state,'SUCCEEDED');
 await f.host().pollOnce(signal());assert.equal(f.calls(),1);assert.deepEqual(f.events,['CLAIMED','SUCCEEDED']);
 assert.equal(f.schedule.intervalMs,86400000);assert.equal(new Date(f.schedule.firstRunAtMs).toISOString(),'2026-11-19T10:00:00.000Z');
 assert.throws(()=>dailyRefreshSchedule(f.schedule,1440,0));
});
test('only known prewrite provider outages retry with bounded exponential backoff across restarts',async()=>{
 const f=fixture();f.setWork(async()=>{throw new CatalogRefreshReadUnavailable();});
 await f.host().pollOnce(signal());assert.equal(f.result()?.state,'RETRY_WAIT');
 await f.host().pollOnce(signal());assert.equal(f.calls(),1);
 f.advance(1000);await f.host().pollOnce(signal());assert.equal(f.claim()?.attempt,2);
 f.advance(1999);await f.host().pollOnce(signal());assert.equal(f.calls(),2);
 f.advance(1);await f.host().pollOnce(signal());assert.equal(f.result()?.state,'FAILED');assert.equal(f.claim()?.attempt,3);
 f.advance(10000);await f.host().pollOnce(signal());assert.equal(f.calls(),3);
});
test('unknown outcomes and expired claims become uncertain and are never automatically retried',async()=>{
 const f=fixture();f.setWork(async()=>{throw new Error('PRIVATE write acknowledgement');});
 await f.host().pollOnce(signal());assert.deepEqual(f.result(),{state:'UNCERTAIN',reason:'OUTCOME_UNCERTAIN',nextAttemptAtMs:null});
 f.advance(86400000);await f.host().pollOnce(signal());assert.equal(f.calls(),1);
 const g=fixture();await g.store.claim(g.schedule.firstRunAtMs,1100);g.advance(1100);await g.host().pollOnce(signal());assert.equal(g.result()?.reason,'LEASE_EXPIRED');assert.equal(g.calls(),0);
});
test('concurrent hosts cannot duplicate a durable claim and overlapping polls fail',async()=>{
 const f=fixture();let enter!:()=>void,resume!:()=>void;const entered=new Promise<void>(r=>{enter=r;}),gate=new Promise<void>(r=>{resume=r;});
 f.setWork(async()=>{enter();await gate;return {state:'REPLAYED',execution:'NOT_AUTHORIZED',snapshotId:randomUUID(),draftIds:[]};});
 const h=f.host(),first=h.pollOnce(signal());await entered;
 await assert.rejects(h.pollOnce(signal()));await f.host().pollOnce(signal());assert.equal(f.calls(),1);resume();await first;
});
test('stop cancels, joins cleanup and settles before closing the owned store; timeout does not detach work',async()=>{
 for(const timeout of [false,true]){
  const f=fixture();f.options.ownsStore=true;f.options.timeoutMs=10;
  let enter!:()=>void;const entered=new Promise<void>(r=>{enter=r;});let joined=false;
  f.setWork(async(_id,abort)=>{enter();await new Promise<void>(resolve=>{if(abort.aborted)resolve();else abort.addEventListener('abort',()=>resolve(),{once:true});});
    await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.closed(),0);joined=true;throw new Error('cancelled');});
  const h=f.host();h.start();await entered;if(timeout)await new Promise(resolve=>setTimeout(resolve,20));await h.stop();
  assert.equal(joined,true);assert.equal(f.closed(),1);assert.equal(f.result()?.state,'UNCERTAIN');assert.equal(f.result()?.reason,'CANCELLED_OR_TIMED_OUT');await h.stop();assert.equal(f.closed(),1);
 }
});
test('slot/version are pinned on refresh dispatch and settlement failure leaves a reconcilable claim',async()=>{
 const f=fixture();f.setWork(async(id,_abort,pin)=>{assert.equal(id,f.schedule.id);assert.deepEqual(pin,{version:'1',slotAtMs:f.schedule.firstRunAtMs,tenantId:f.schedule.tenantId,leaseUntilMs:f.claim()?.leaseUntilMs});return {state:'REPLAYED',execution:'NOT_AUTHORIZED',snapshotId:randomUUID(),draftIds:[]};});
 f.store.settle=async()=>{throw new Error('PRIVATE commit acknowledgement');};
 await assert.rejects(f.host().pollOnce(signal()),{message:'Refresh settlement unavailable; reconcile persisted claims'});assert.equal(f.result(),undefined);
 f.advance(1100);await f.host().pollOnce(signal());assert.equal(f.result()?.state,'UNCERTAIN');assert.equal(f.calls(),1);
});

test('a reservation that expires while polling does not call the refresh coordinator', async () => {
  const f = fixture();
  const claim = f.store.claim;
  f.store.claim = async (at, lease) => {
    const row = await claim(at, lease);
    if (row) f.advance(lease);
    return row;
  };
  await f.host().pollOnce(signal());
  assert.equal(f.calls(), 0);
  assert.equal(f.result()?.reason, 'LEASE_EXPIRED');
});

test('stop cancels a directly invoked poll before releasing its owned store', async () => {
  const f = fixture();
  f.options.ownsStore = true;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  f.setWork(async (_id, abort) => {
    entered();
    await new Promise<void>(resolve => abort.addEventListener('abort', () => resolve(), { once: true }));
    assert.equal(f.closed(), 0);
    throw new Error('Refresh cancelled');
  });
  const host = f.host();
  const polling = host.pollOnce(signal());
  await ready;
  await host.stop();
  await polling;
  assert.equal(f.closed(), 1);
  assert.equal(f.result()?.reason, 'CANCELLED_OR_TIMED_OUT');
});


test('database-backed dispatch ignores the host wall clock and revalidates the exact reservation', async () => {
  const f = fixture();
  const claim = f.store.claim;
  f.store.claim = async (at, lease) => {
    const row = await claim(at, lease);
    if (row) f.advance(86400000);
    return row;
  };
  let checks = 0, settled = false;
  f.store.checkLease = async reservation => {
    assert.equal(reservation.token, f.claim()?.token);
    checks++;
    return true;
  };
  f.store.settle = async (_reservation, result) => {
    assert.equal(result.state, 'SUCCEEDED');
    settled = true;
  };
  f.setWork(async (_id, _signal, pin) => {
    assert.equal(await pin?.checkLease?.(), true);
    return { state: 'REPLAYED', execution: 'NOT_AUTHORIZED', snapshotId: randomUUID(), draftIds: [] };
  });
  await f.host().pollOnce(signal());
  assert.equal(checks, 3);
  assert.equal(settled, true);
});
