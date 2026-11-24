import { AsyncLocalStorage } from "node:async_hooks";
import { AiJobError, validateAiSummary, BoundedAiAdmission, PROPOSED_AI_CONTROL_POLICY as T, type AiJobRecord, type AiAdmissionPermit, type AiDeliveryAuthorization } from "@nukhbapay/application";
import { AiJobSessionPool, type AiPairLease, type AiManagedClient } from "./ai-job-session-pool.js";
import type { AiJobSqlClient, AiJobSqlPool, AiJobSqlResult } from "./ai-job-prepared-control.js";

export type FixedAiClient=AiManagedClient;
export interface AiRequestPrincipal {readonly tenantId:string;validNow():boolean;reauthorize(signal:AbortSignal):Promise<boolean>;}
interface Scope {pair:AiPairLease;principal:AiRequestPrincipal;abort:AbortController;deadline:number;epoch?:string;sourceDeadline?:number;sourceWallDeadline?:number;ended:boolean;}
const deny=()=>new AiJobError(503),captures=new WeakSet<object>();
export interface AiAdvisoryCapture {readonly kind:"OFFLINE_ADVISORY_CAPTURE";records():readonly AiJobRecord[];}
interface InternalCapture extends AiAdvisoryCapture {write(job:AiJobRecord,valid:()=>boolean):void;}
/** No arbitrary callback receives a result. This sealed sink is privileged
 * synthetic fixture capture only; no HTTP/provider/payment sink is installed. */
export function createAiAdvisoryCapture():AiAdvisoryCapture {
 const values:AiJobRecord[]=[];
 const capture:InternalCapture={kind:"OFFLINE_ADVISORY_CAPTURE",records:()=>structuredClone(values),write(job,valid){
  if(!valid()||job.summary&&(job.summary.can_publish!==false||job.summary.manualReview!==true))throw deny();
  if(job.summary)validateAiSummary(job.summary);
  const serialized=JSON.stringify(job);if(Buffer.byteLength(serialized)>16384||!valid())throw deny();values.push(Object.freeze(JSON.parse(serialized) as AiJobRecord));
 }};Object.freeze(capture);captures.add(capture);return capture;
}
const clock={now:()=>performance.now(),after(ms:number,f:()=>void){const t=setTimeout(f,ms);return()=>clearTimeout(t);}};
export class AiJobSessions {
 readonly durableAttempts=true;
 readonly jobs:AiJobSqlPool;readonly sources:AiJobSqlPool;
 #scope=new AsyncLocalStorage<Scope>();#auth=new BoundedAiAdmission(clock,2,8,1000,deny);
 #active=new Set<Promise<void>>();#closed=false;#seq=0;
 constructor(readonly pool:AiJobSessionPool,private readonly progress:(stage:"REQUEST"|"DISCLOSED"|"IDLE",id:number,absolute:number)=>void=()=>{},
  private readonly transactionGuard:(absolute:number)=>()=>void=()=>()=>{}){
  this.jobs=this.port("jobs");this.sources=this.port("source");
 }
 get currentSignal(){return this.#scope.getStore()?.abort.signal;}
 get currentTenant(){return this.#scope.getStore()?.principal.tenantId;}
 cancelCurrentRequest(){this.#scope.getStore()?.abort.abort();}
 ownershipEpoch(){return this.#scope.getStore()?.epoch;}
 transactionBudget(){
  this.assertActive();const s=this.#scope.getStore()!;
  const deadline=Math.min(performance.now()+T.transactionMs,s.deadline);
  const complete=this.transactionGuard(Number(process.hrtime.bigint()/1000000n)+Math.max(0,deadline-performance.now()));
  return {deadline,complete,cancel:()=>s.abort.abort()};
 }
 async reauthorize(){const s=this.#scope.getStore();if(!s)throw deny();this.assertActive();if(!await s.principal.reauthorize(s.abort.signal))throw deny();this.assertActive();}
 assertActive(tenant?:string){this.check(tenant,false);}
 private check(tenant:string|undefined,finished:boolean){const s=this.#scope.getStore();
  if(!s||this.#closed||s.abort.signal.aborted||!s.pair.healthy()||!s.principal.validNow()||!finished&&s.ended||performance.now()>=s.deadline-T.cleanupMs||
   tenant!==undefined&&tenant!==s.principal.tenantId)throw deny();
 }
 private port(kind:"jobs"|"source"):AiJobSqlPool{return {connect:async()=>{
  this.assertActive();const c=this.#scope.getStore()!.pair.checkout(kind);
  return {query:(sql,values)=>this.query(c,sql,values),release:broken=>c.release(broken)};
 },end:()=>this.close()};}
 private async query(c:AiJobSqlClient,sql:string,values:unknown[]=[]):Promise<AiJobSqlResult>{
  const cleanup=sql==="ROLLBACK"||sql==="RESET ALL";if(!cleanup)this.assertActive();
  const s=this.#scope.getStore();if(!s)throw deny();
  if(sql.includes("set_config('nukhabapay.ai_job_tenant'")){if(values[0]!==s.principal.tenantId)throw deny();}
  const started=performance.now(),result=await c.query(sql,values);
  if(sql.includes("set_config('nukhabapay.ai_job_tenant'"))await c.query("SELECT nukhb4_target.enter_ai_source()");
  if(sql.startsWith("SELECT tenant_id,snapshot_id")){
   const epoch=(await c.query("SELECT nukhb4_target.ai_authority_epoch() AS epoch")).rows[0]?.["epoch"];
   if(typeof epoch!=="string"||!/^\d+\.\d+$/.test(epoch)||s.epoch!==undefined&&epoch!==s.epoch)throw deny();s.epoch=epoch;
   const row=result.rows[0];if(row){
    const server=new Date(row["server_now"] as string|Date).getTime(),until=new Date(row["valid_until"] as string|Date).getTime();
    const observed=new Date(row["observed_at"] as string|Date).getTime(),expiry=Math.min(until,observed+86400000);
    if(!Number.isFinite(server)||!Number.isFinite(expiry)||Math.abs(Date.now()-server)>1000)throw deny();
    s.sourceDeadline=Math.min(s.sourceDeadline??Infinity,started+expiry-server-25);s.sourceWallDeadline=Math.min(s.sourceWallDeadline??Infinity,expiry-25);
   }
  }
  if(!cleanup)this.assertActive();return result;
 }
 async authorizeResult(job:AiJobRecord):Promise<AiDeliveryAuthorization>{
  const s=this.#scope.getStore();if(!s||!s.epoch||job.tenantId!==s.principal.tenantId)throw deny();this.check(job.tenantId,true);
  const c=s.pair.checkout("jobs"),started=performance.now(),wall=Date.now();let row:Record<string,unknown>|undefined;
  try{
   await c.query("BEGIN");await c.query("SELECT set_config('nukhabapay.ai_job_tenant',$1,true)",[job.tenantId]);
   row=(await c.query("SELECT * FROM nukhb4_target.record_ai_disclosure($1,$2,$3,$4,$5)",[job.id,s.epoch,job.clientDigest,s.pair.source.client.backendPid,s.pair.source.client.backendStartedAt])).rows[0];
   if((await c.query("COMMIT")).command!=="COMMIT")throw deny();
  }catch{try{await c.query("ROLLBACK");}catch{}throw deny();}finally{c.release(false);}
  const date=(key:string)=>new Date(row?.[key] as string|Date).getTime();
  const server=date("server_now"),notAfter=Math.min(date("not_after"),date("valid_until"));
  if(!row||row["tenant_id"]!==job.tenantId||row["snapshot_id"]!==job.request.snapshotId||row["generation"]!==s.epoch||
   typeof row["token"]!=="string"||!/^[0-9a-f-]{36}$/.test(row["token"])||!Number.isFinite(server)||!Number.isFinite(notAfter)||Math.abs(Date.now()-server)>1000)throw deny();
  const deadline=Math.min(s.deadline-T.cleanupMs,s.sourceDeadline??-Infinity,started+notAfter-server-25);
  const validNow=()=>!s.abort.signal.aborted&&s.pair.healthy()&&s.principal.validNow()&&performance.now()<deadline&&Date.now()<Math.min(notAfter-25,s.sourceWallDeadline??-Infinity)&&
   Math.abs((Date.now()-wall)-(performance.now()-started))<=1000;
  return {signal:s.abort.signal,validNow,release:async()=>{
   if(!s.pair.healthy())throw deny();const r=s.pair.checkout("jobs");
   try{await r.query("BEGIN");await r.query("SELECT set_config('nukhabapay.ai_job_tenant',$1,true)",[job.tenantId]);await r.query("SELECT nukhb4_target.release_ai_authorization($1)",[row!["token"]]);
    if((await r.query("COMMIT")).command!=="COMMIT")throw deny();
   }finally{r.release(false);}
  }};
 }
 /** Authentication is globally bounded before tenant routing. Only the trusted
  * verifier/server binding may supply principal.tenantId; request JSON cannot. */
 run(authenticate:(signal:AbortSignal)=>Promise<AiRequestPrincipal>,work:()=>Promise<AiJobRecord>,sink:AiAdvisoryCapture,parent?:AbortSignal):Promise<void>{
  if(!captures.has(sink)||this.#closed||parent?.aborted||this.#active.size>=20||this.#seq>=4096)return Promise.reject(deny());
  const abort=new AbortController(),deadline=performance.now()+T.requestMs,id=++this.#seq;
  const cancel=()=>abort.abort();parent?.addEventListener("abort",cancel,{once:true});
  let permit:AiAdmissionPermit|undefined,pair:AiPairLease|undefined,authorization:AiDeliveryAuthorization|undefined,scope:Scope|undefined;
  const pending=(async()=>{
   this.progress("REQUEST",id,Number(process.hrtime.bigint()/1000000n)+T.requestMs);
   const total=setTimeout(cancel,T.requestMs-T.cleanupMs);let listener:()=>void=()=>{};
   try{
    permit=await this.#auth.acquire(deadline,abort.signal);const timer=setTimeout(cancel,T.authenticationMs);let principal:AiRequestPrincipal;
    try{principal=await authenticate(abort.signal);if(abort.signal.aborted||!principal.validNow()||!/^[0-9a-f-]{36}$/.test(principal.tenantId))throw deny();}
    finally{clearTimeout(timer);this.#auth.release(permit);permit=undefined;}
    pair=await this.pool.acquire(principal.tenantId,deadline-T.cleanupMs,abort.signal);
    const fault=()=>abort.abort();pair.abort.signal.addEventListener("abort",fault,{once:true});
    const stop=()=>{if(pair)void this.pool.abortLease(pair);};abort.signal.addEventListener("abort",stop,{once:true});listener=()=>{pair?.abort.signal.removeEventListener("abort",fault);abort.signal.removeEventListener("abort",stop);};
    scope={pair,principal,abort,deadline,ended:false};
    await this.#scope.run(scope,async()=>{
     let job:AiJobRecord;try{job=await work();}finally{scope!.ended=true;}
     this.check(job.tenantId,true);if(!scope!.epoch||pair!.checkedOut())throw deny();
     await this.pool.resetLease(pair!);this.check(job.tenantId,true);
     authorization=await this.authorizeResult(job);
     if(!await principal.reauthorize(abort.signal)||!authorization.validNow())throw deny();
     (sink as InternalCapture).write(job,()=>authorization!.validNow()&&principal.validNow());this.progress("DISCLOSED",id,0);
    });
   }catch(error){if(abort.signal.aborted&&pair)await this.pool.abortLease(pair);throw error instanceof AiJobError?error:deny();}
   finally{
    // Timers and cancellation remain live THROUGH release/audit/reset. No
    // success/IDLE acknowledgement precedes cleanup or terminal uncertainty.
    try{await authorization?.release();if(pair)await pair.release();}
    finally{clearTimeout(total);listener();if(permit)this.#auth.release(permit);parent?.removeEventListener("abort",cancel);}
    this.progress("IDLE",id,0);
   }
  })();this.#active.add(pending);void pending.then(()=>this.#active.delete(pending),()=>this.#active.delete(pending));return pending;
 }
 async close(){this.#closed=true;this.#auth.close();await this.pool.close();await Promise.allSettled([...this.#active]);}
}
// Source-path compatibility only; there is no fixed-four implementation left.
export {AiJobSessions as FixedAiJobSessions};
