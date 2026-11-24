import { AiJobError, type AiOutboxRepository, type AiOutboxRecord, type AiJobRecord, type AiDeliveryAuthorization } from "@nukhbapay/application";
import type { AiJobSessions } from "./ai-job-fixed-sessions.js";
import type { AiJobSqlClient } from "./ai-job-prepared-control.js";
const deny=()=>new AiJobError(503);
function outbox(r:Record<string,unknown>):AiOutboxRecord{
 return Object.freeze({id:r['id'] as string,tenantId:r['tenant_id'] as string,jobId:r['job_id'] as string,snapshotId:r['snapshot_id'] as string,
  idempotencyKey:r['idempotency_key'] as string,payloadDigest:r['payload_digest'] as string,generation:r['generation'] as string,
  summary:Object.freeze(r['summary'] as AiOutboxRecord['summary']),state:r['state'] as AiOutboxRecord['state'],attempts:r['attempts'] as number,
  nextAttemptAt:r['next_attempt_at']==null?null:new Date(r['next_attempt_at'] as Date).toISOString(),leaseToken:r['lease_token'] as string,receiptId:r['receipt_id'] as string|null});
}
/** This uses the SAME tenant-routed leased connection owner as signed jobs.
 * SQL functions own CAS/state/audit/backoff; request JSON never chooses tenant.
 * Atomic result+instruction enqueue is the ai_outbox_atomic DB trigger. */
export function createAiOutboxRepository(sessions:AiJobSessions,loadJob:(id:string)=>Promise<AiJobRecord>):AiOutboxRepository{
 const transaction=async<T>(tenant:string,work:(c:AiJobSqlClient)=>Promise<T>):Promise<T>=>{
  sessions.assertActive(tenant);await sessions.reauthorize();const c=await sessions.jobs.connect();let broken=false;
  try{await c.query('BEGIN');await c.query("SELECT set_config('nukhabapay.ai_job_tenant',$1,true)",[tenant]);
   const value=await work(c);sessions.assertActive(tenant);await sessions.reauthorize();
   if((await c.query('COMMIT')).command!=='COMMIT')throw deny();return value;
  }catch{try{await c.query('ROLLBACK');}catch{broken=true;}throw deny();}finally{c.release(broken);}
 };
 const one=(rows:Record<string,unknown>[])=>{if(rows.length!==1)throw deny();return outbox(rows[0]!);};
 return {
  async claim(tenant,key,signal){if(signal.aborted||key!==undefined&&!/^[a-f0-9]{64}$/.test(key))throw deny();
   return transaction(tenant,async c=>{const rows=(await c.query('SELECT * FROM nukhb4_target.claim_ai_outbox($1)',[key??null])).rows;
    if(signal.aborted)throw deny();return rows.length===0?null:one(rows);});},
  async authorize(r,signal):Promise<AiDeliveryAuthorization>{
   sessions.assertActive(r.tenantId);await sessions.reauthorize();if(signal.aborted||sessions.ownershipEpoch()!==r.generation)throw deny();
   const job=await loadJob(r.jobId);if(job.id!==r.jobId||job.tenantId!==r.tenantId||job.request.snapshotId!==r.snapshotId||job.state!=='SUCCEEDED')throw deny();
   const auth=await sessions.authorizeResult(job);
   return {signal:AbortSignal.any([signal,auth.signal]),validNow:()=>!signal.aborted&&auth.validNow(),release:()=>auth.release()};
  },
  async transition(r,state,event,metadata){return transaction(r.tenantId,async c=>one((await c.query(
   'SELECT * FROM nukhb4_target.transition_ai_outbox($1,$2,$3,$4,$5,$6,$7)',
   [r.id,r.leaseToken,state,event,metadata.nextAttemptAt??null,metadata.receiptId??null,metadata.code??null])).rows));},
  async reconcile(r,outcome,receipt){return transaction(r.tenantId,async c=>one((await c.query(
   'SELECT * FROM nukhb4_target.reconcile_ai_outbox($1,$2,$3)',[r.id,outcome,receipt??null])).rows));},
 };
}
