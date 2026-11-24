import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AiOutboxDelivery, AiDeliveryError, aiRetryAt, type AiOutboxRecord, type AiOutboxRepository, type MockAiReceiver } from '../src/catalog/ai-outbox.js';
import { aiDigest } from '../src/catalog/ai-jobs.js';
function fixture(){
 const summary={provider:'openai',modelVersion:'mock-openai-v1',promptVersion:'product-match-mock-v1',rulesVersion:'equivalence-v1',decision:'REQUIRES_REVIEW',confidenceBps:9000,duplicateCandidate:false,manualReview:true,can_publish:false} as const;
 let record:AiOutboxRecord={id:randomUUID(),tenantId:randomUUID(),jobId:randomUUID(),snapshotId:randomUUID(),idempotencyKey:'a'.repeat(64),payloadDigest:aiDigest(summary),generation:'2.0',summary,state:'IN_FLIGHT',attempts:1,nextAttemptAt:null,leaseToken:randomUUID(),receiptId:null};
 const state={authority:true,released:false,claimed:false,auditFailure:false,revokeDuringAudit:false,calls:0,reconciliations:0};const events:string[]=[];
 const repo:AiOutboxRepository={async claim(){if(state.claimed)return null;state.claimed=true;return record;},async authorize(){return {signal:new AbortController().signal,validNow:()=>state.authority,release:async()=>{state.released=true;}};},
  async transition(r,next,event,meta){if(state.auditFailure)throw new Error('SYNTHETIC_SECRET');assert.equal(r.leaseToken,record.leaseToken);events.push(event);if(state.revokeDuringAudit)state.authority=false;record={...record,state:next,...(meta.receiptId?{receiptId:meta.receiptId}:{}),...(meta.nextAttemptAt?{nextAttemptAt:meta.nextAttemptAt}:{})};return record;},
  async reconcile(r,outcome,receipt){state.reconciliations++;return {...r,state:outcome==='PROCESSED'?'CONFIRMED':state.reconciliations>=3?'DEAD_LETTER':'UNCERTAIN',receiptId:receipt??null};}};
 const receiver:MockAiReceiver={kind:'MOCK_ONLY',async send(_i,s){state.calls++;assert.equal(s.aborted,false);return {attempted:true,acknowledged:true,processed:true,receiptId:'mock:receipt'};},async inspect(){return {outcome:'UNKNOWN'};}};
 return {state,events,repo,receiver,get record(){return record;},set record(r){record=r;},delivery:()=>new AiOutboxDelivery(repo,receiver,()=>10000)};
}
test('confirmed processing is distinct from attempted delivery and acknowledgement',async()=>{
 const f=fixture(),done=await f.delivery().deliver(f.record.tenantId);assert.equal(done?.state,'CONFIRMED');assert.deepEqual(f.events,['DELIVERY_INTENT','ATTEMPTED','ACKNOWLEDGED','CONFIRMED']);assert.equal(f.state.released,true);
 assert.equal(await f.delivery().deliver(f.record.tenantId),null);assert.equal(f.state.calls,1);
});
test('acknowledgement alone does not claim processed or exactly-once network delivery',async()=>{
 const f=fixture();f.receiver.send=async()=>({attempted:true,acknowledged:true,processed:false,receiptId:'mock:ack'});
 assert.equal((await f.delivery().deliver(f.record.tenantId))?.state,'ACKNOWLEDGED');assert.ok(!f.events.includes('CONFIRMED'));
});
test('source revocation or expiry during intent audit prevents receiver invocation',async()=>{
 const f=fixture();f.state.revokeDuringAudit=true;assert.equal((await f.delivery().deliver(f.record.tenantId))?.state,'REVOKED');assert.equal(f.state.calls,0);assert.equal(f.state.released,true);
});
test('source identity unavailable at authorization prevents delivery',async()=>{
 const f=fixture();f.state.authority=false;await f.delivery().deliver(f.record.tenantId);assert.equal(f.state.calls,0);assert.deepEqual(f.events,['AUTHORIZATION_DENIED']);
});
test('unacknowledged or interrupted transport is uncertain and is never automatically resent',async()=>{
 for(const mode of ['interrupt','missing-ack']){const f=fixture();f.receiver.send=async()=>{f.state.calls++;if(mode==='interrupt')throw new Error('SYNTHETIC_SECRET');return {attempted:true,acknowledged:false,processed:false};};
  assert.equal((await f.delivery().deliver(f.record.tenantId))?.state,'UNCERTAIN');assert.equal(await f.delivery().deliver(f.record.tenantId),null);assert.equal(f.state.calls,1);assert.ok(!JSON.stringify(f.events).includes('SYNTHETIC_SECRET'));}
});
test('known before-send failure receives bounded exponential backoff and dead letters at five attempts',async()=>{
 for(const attempts of [1,2,3,4,5]){const f=fixture();f.record={...f.record,attempts};f.receiver.send=async()=>{throw new AiDeliveryError('BEFORE_SEND');};
  const result=await f.delivery().deliver(f.record.tenantId);assert.equal(result?.state,attempts===5?'DEAD_LETTER':'RETRY_WAIT');if(attempts<5)assert.equal(result?.nextAttemptAt,aiRetryAt(attempts,10000));}
 assert.throws(()=>aiRetryAt(6,10000));assert.throws(()=>aiRetryAt(0,10000));
});
test('audit-write failure fails closed without send or fabricated successful recovery',async()=>{
 const f=fixture();f.state.auditFailure=true;await assert.rejects(f.delivery().deliver(f.record.tenantId));assert.equal(f.state.calls,0);assert.equal(f.state.released,true);assert.equal(f.events.length,0);
});
test('malicious summary, price fields, publication flag and stale digest never reach a receiver',async()=>{
 for(const patch of [{can_publish:true},{price:'1.00'},{manualReview:false},{provider:'live-provider'}]){
  const f=fixture(),summary={...f.record.summary,...patch};f.record={...f.record,summary,payloadDigest:aiDigest(summary)} as AiOutboxRecord;
  await f.delivery().deliver(f.record.tenantId);assert.equal(f.state.calls,0);assert.ok(!f.events.includes('DELIVERY_INTENT'));
 }
 const f=fixture();f.record={...f.record,payloadDigest:'b'.repeat(64)};await f.delivery().deliver(f.record.tenantId);assert.equal(f.state.calls,0);
});
test('wrong tenant and pre-cancelled delivery are rejected before send',async()=>{
 const f=fixture();await f.delivery().deliver(randomUUID());assert.equal(f.state.calls,0);const abort=new AbortController();abort.abort();await assert.rejects(f.delivery().deliver(f.record.tenantId,undefined,abort.signal));
});
test('cancellation during send joins the mock transport before releasing authorization',async()=>{
 const f=fixture(),abort=new AbortController();let exited=false;
 f.receiver.send=async(_i,s)=>{await new Promise<void>(resolve=>s.addEventListener('abort',()=>{exited=true;resolve();},{once:true}));return {attempted:true,acknowledged:false,processed:false};};
 const pending=f.delivery().deliver(f.record.tenantId,undefined,abort.signal);setTimeout(()=>abort.abort(),10);assert.equal((await pending)?.state,'UNCERTAIN');assert.equal(exited,true);assert.equal(f.state.released,true);
});
test('reconciliation has a bounded unknown path and only receiver processing evidence confirms',async()=>{
 const f=fixture();let r={...f.record,state:'UNCERTAIN'} as AiOutboxRecord;const signal=new AbortController().signal;
 for(let i=0;i<3;i++)r=await f.delivery().reconcile(r,signal);assert.equal(r.state,'DEAD_LETTER');await assert.rejects(f.delivery().reconcile(r,signal));
 const g=fixture();g.receiver.inspect=async()=>({outcome:'PROCESSED',receiptId:'mock:confirmed'});assert.equal((await g.delivery().reconcile({...g.record,state:'UNCERTAIN'},signal)).state,'CONFIRMED');
});
test('invalid receiver acknowledgement cannot become confirmed processing',async()=>{
 const f=fixture();f.receiver.send=async()=>({attempted:true,acknowledged:false,processed:true,receiptId:'SYNTHETIC_SECRET\n'});assert.equal((await f.delivery().deliver(f.record.tenantId))?.state,'UNCERTAIN');assert.ok(!f.events.includes('CONFIRMED'));
});
