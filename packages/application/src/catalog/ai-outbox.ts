import { aiDigest, AiJobError, validateAiSummary, type AiSummary } from "./ai-jobs.js";

export type AiOutboxState="PENDING"|"IN_FLIGHT"|"ATTEMPTED"|"ACKNOWLEDGED"|"CONFIRMED"|"RETRY_WAIT"|"UNCERTAIN"|"DEAD_LETTER"|"REVOKED";
export interface AiOutboxRecord {
  readonly id:string; readonly tenantId:string; readonly jobId:string; readonly snapshotId:string;
  readonly idempotencyKey:string; readonly payloadDigest:string; readonly generation:string;
  readonly summary:AiSummary; readonly state:AiOutboxState; readonly attempts:number;
  readonly nextAttemptAt:string|null; readonly leaseToken:string; readonly receiptId:string|null;
}
export interface AiDeliveryAuthorization {
  readonly signal:AbortSignal;
  /** Checks live connection/lease evidence, both monotonic and authoritative
   * wall-clock expiry, tenant, generation and source identity. No cached I flag. */
  validNow():boolean;
  release():Promise<void>;
}
export type AiOutboxEvent="CLAIMED"|"DELIVERY_INTENT"|"ATTEMPTED"|"ACKNOWLEDGED"|"CONFIRMED"|"RETRY_SCHEDULED"|"UNCERTAIN"|"DEAD_LETTER"|"AUTHORIZATION_DENIED"|"RECONCILED";
export interface AiOutboxRepository {
  claim(tenantId:string,idempotencyKey:string|undefined,signal:AbortSignal):Promise<AiOutboxRecord|null>;
  authorize(record:AiOutboxRecord,signal:AbortSignal):Promise<AiDeliveryAuthorization>;
  /** Must atomically CAS leaseToken/state and append immutable sanitized audit. */
  transition(record:AiOutboxRecord,state:AiOutboxState,event:AiOutboxEvent,metadata:{nextAttemptAt?:string;receiptId?:string;code?:string}):Promise<AiOutboxRecord>;
  reconcile(record:AiOutboxRecord,outcome:"PROCESSED"|"NOT_PROCESSED"|"UNKNOWN",receiptId?:string):Promise<AiOutboxRecord>;
}
export interface AiDeliveryResponse {attempted:true;acknowledged:boolean;processed:boolean;receiptId?:string;}
export interface MockAiReceiver {
  readonly kind:"MOCK_ONLY";
  send(input:{idempotencyKey:string;payloadDigest:string;summary:AiSummary;can_publish:false},signal:AbortSignal):Promise<AiDeliveryResponse>;
  inspect(idempotencyKey:string,signal:AbortSignal):Promise<{outcome:"PROCESSED"|"NOT_PROCESSED"|"UNKNOWN";receiptId?:string}>;
}
export class AiDeliveryError extends Error {
  constructor(readonly phase:"BEFORE_SEND"|"UNKNOWN"){super("AI advisory delivery unavailable");}
}
export const AI_OUTBOX_POLICY=Object.freeze({maximumAttempts:5,baseBackoffMs:250,maximumBackoffMs:30000,maximumReconciliationAttempts:3,deliveryMs:1000});
export function aiRetryAt(attempt:number,now:number):string{
  if(!Number.isSafeInteger(attempt)||attempt<1||attempt>AI_OUTBOX_POLICY.maximumAttempts||!Number.isSafeInteger(now))throw new AiJobError(503);
  return new Date(now+Math.min(AI_OUTBOX_POLICY.maximumBackoffMs,AI_OUTBOX_POLICY.baseBackoffMs*2**(attempt-1))).toISOString();
}
function validRecord(r:AiOutboxRecord):void{
  validateAiSummary(r.summary);
  if(!/^[0-9a-f]{64}$/.test(r.idempotencyKey)||r.payloadDigest!==aiDigest(r.summary)||!/^\d+\.\d+$/.test(r.generation)||
    r.summary.manualReview!==true||r.summary.can_publish!==false||r.state!=="IN_FLIGHT"||!Number.isSafeInteger(r.attempts)||r.attempts<1||r.attempts>5)throw new AiJobError(503);
}
/** Advisory-only delivery coordinator. A real network adapter is deliberately
 * absent. Receiver acknowledgement is distinct from confirmed processing. */
export class AiOutboxDelivery {
  constructor(private readonly repository:AiOutboxRepository,private readonly receiver:MockAiReceiver,private readonly now:()=>number=Date.now){
    if(receiver.kind!=="MOCK_ONLY")throw new AiJobError(503);
  }
  async deliver(tenantId:string,key?:string,parent?:AbortSignal):Promise<AiOutboxRecord|null>{
    const abort=new AbortController();const stop=()=>abort.abort();parent?.addEventListener("abort",stop,{once:true});if(parent?.aborted)stop();
    let authorization:AiDeliveryAuthorization|undefined,record:AiOutboxRecord|null=null,started=false;
    const timer=setTimeout(stop,AI_OUTBOX_POLICY.deliveryMs);
    try{
      if(abort.signal.aborted)throw new AiJobError(503);
      record=await this.repository.claim(tenantId,key,abort.signal);if(!record)return null;validRecord(record);
      if(record.tenantId!==tenantId)throw new AiJobError(403);
      authorization=await this.repository.authorize(record,abort.signal);
      const signal=AbortSignal.any([abort.signal,authorization.signal]);
      if(signal.aborted||!authorization.validNow())return await this.repository.transition(record,"REVOKED","AUTHORIZATION_DENIED",{code:"AUTHORITY_UNAVAILABLE"});
      record=await this.repository.transition(record,"IN_FLIGHT","DELIVERY_INTENT",{});
      // Audit/commit waits MUST NOT extend source/lease validity.
      if(signal.aborted||!authorization.validNow())return await this.repository.transition(record,"REVOKED","AUTHORIZATION_DENIED",{code:"AUTHORITY_EXPIRED"});
      started=true;
      const answer=await this.receiver.send({idempotencyKey:record.idempotencyKey,payloadDigest:record.payloadDigest,summary:record.summary,can_publish:false},signal);
      if(signal.aborted||!authorization.validNow())return await this.repository.transition(record,"UNCERTAIN","UNCERTAIN",{code:"AUTHORITY_OR_RESPONSE_UNCERTAIN"});
      if(answer.attempted!==true||typeof answer.acknowledged!=="boolean"||typeof answer.processed!=="boolean"||answer.processed&&!answer.acknowledged||
        answer.acknowledged&&(!answer.receiptId||!/^[A-Za-z0-9_.:-]{1,128}$/.test(answer.receiptId)))throw new AiDeliveryError("UNKNOWN");
      record=await this.repository.transition(record,"ATTEMPTED","ATTEMPTED",{});
      if(!answer.acknowledged)return await this.repository.transition(record,"UNCERTAIN","UNCERTAIN",{code:"ACKNOWLEDGEMENT_MISSING"});
      record=await this.repository.transition(record,"ACKNOWLEDGED","ACKNOWLEDGED",{receiptId:answer.receiptId!});
      return answer.processed?await this.repository.transition(record,"CONFIRMED","CONFIRMED",{receiptId:answer.receiptId!}):record;
    }catch(error){
      if(!record)throw new AiJobError(503);
      if(error instanceof AiDeliveryError&&error.phase==="BEFORE_SEND")return await this.repository.transition(record,
        record.attempts>=5?"DEAD_LETTER":"RETRY_WAIT",record.attempts>=5?"DEAD_LETTER":"RETRY_SCHEDULED",
        record.attempts>=5?{code:"ATTEMPTS_EXHAUSTED"}:{code:"NOT_SENT",nextAttemptAt:aiRetryAt(record.attempts,this.now())});
      return await this.repository.transition(record,started?"UNCERTAIN":"REVOKED",started?"UNCERTAIN":"AUTHORIZATION_DENIED",{code:started?"TRANSPORT_UNCERTAIN":"AUTHORITY_UNAVAILABLE"});
    }finally{clearTimeout(timer);parent?.removeEventListener("abort",stop);await authorization?.release();}
  }
  async reconcile(record:AiOutboxRecord,signal:AbortSignal):Promise<AiOutboxRecord>{
    if(!["UNCERTAIN","ACKNOWLEDGED","ATTEMPTED"].includes(record.state)||signal.aborted)throw new AiJobError(503);
    const r=await this.receiver.inspect(record.idempotencyKey,signal);
    if(!['PROCESSED','NOT_PROCESSED','UNKNOWN'].includes(r.outcome)||r.receiptId!==undefined&&!/^[A-Za-z0-9_.:-]{1,128}$/.test(r.receiptId))throw new AiJobError(503);
    return this.repository.reconcile(record,r.outcome,r.receiptId);
  }
}
