import type { Auth0Login, StaffPlatformStepUpCommand, StaffStepUpProof } from './auth0.js';
import { createHash } from 'node:crypto';

interface PlatformIntentBinding {
  readonly scope: 'PLATFORM';
  readonly actorStaffId: string;
  readonly intentDigest: string;
}

interface PlatformProof {
  readonly command: StaffPlatformStepUpCommand;
  readonly proof: StaffStepUpProof;
}

/** BFF entry point for a server-prepared platform intent. The callback still requires explicit confirmation. */
export async function beginPlatformStaffStepUp(login: Auth0Login, intent: PlatformIntentBinding, token: string,
  expiresAtMs: number, previousTransaction?: string) {
  if (intent.scope !== 'PLATFORM') throw new Error('Platform staff assurance unavailable');
  const {actorStaffId,intentDigest}=intent;
  const expires=await login.readForPlatformSession(token,async(identity,staffId)=>{
    if (staffId!==actorStaffId) throw new Error('Platform staff assurance unavailable');
    return Math.min(expiresAtMs,identity.security.expiresAt*1000);
  });
  return login.beginStepUp({operation:'PLATFORM_STAFF_SECURITY',actorStaffId,intentDigest,expiresAtMs:expires},token,previousTransaction);
}

/** Bridge to the guarded executor. Only Auth0Login can issue a consumable proof. */
export function platformStaffAssuranceConsumer<T extends 'DISPOSABLE_PLATFORM_STAFF_EFFECT_V1'|'AUTH0_PLATFORM_STAFF_PILOT_V1'>(
  login: Auth0Login, profile: T,
) {
  return async (intent: PlatformIntentBinding, value: unknown, credential: string) => {
    if (!value || typeof value!=='object' || intent.scope!=='PLATFORM') return null;
    const {command,proof}=value as Partial<PlatformProof>;
    if (!command || !proof || command.operation!=='PLATFORM_STAFF_SECURITY' || command.actorStaffId!==intent.actorStaffId ||
        command.intentDigest!==intent.intentDigest) return null;
    const assurance=await login.consumeStepUp(proof,command,credential);
    if (!assurance) return null;
    const {issuer,subject,eventId,sessionDigest,identityIssuedAtMs}=assurance.factorEvent;
    if (profile==='AUTH0_PLATFORM_STAFF_PILOT_V1' && /\.(?:invalid|test|local|localhost|example)\/$/.test(issuer)) return null;
    const matchesSession=async()=>{
      try {
        return await login.readForPlatformSession(credential,async(identity,staffId)=>staffId===intent.actorStaffId &&
          identity.issuer===issuer && identity.subject===subject && identity.security.issuedAt*1000===identityIssuedAtMs);
      } catch { return false; }
    };
    if (!await matchesSession()) return null;
    return Object.freeze({profile,actorStaffId:intent.actorStaffId,intentDigest:intent.intentDigest,
      issuer,subject,eventId,sessionDigest,identityIssuedAtMs,expiresAtMs:assurance.expiresAtMs,
      revalidate:async()=>await assurance.revalidate() && await matchesSession()});
  };
}

export interface PlatformStaffPilotPort {
  readonly capability:'DISPOSABLE_PLATFORM_STAFF_EFFECT_V1'|'AUTH0_PLATFORM_STAFF_PILOT_V1';
  /** Resolve an operator-facing reference to an exact server-prepared intent. */
  resolve(actionId:string,staffId:string):Promise<{readonly intent:PlatformIntentBinding;readonly expiresAtMs:number}|null>;
  execute(intent:PlatformIntentBinding, proof:PlatformProof, credential:string):Promise<{
    readonly kind:'APPLIED'|'RECORDED'|'REPLAYED'|'DENIED'|'UNRESOLVED'|'ABSENT';
    readonly receiptId?:string;readonly auditId?:string;readonly revokedSessions?:number;
  }>;
}

const sessionKey=(token:string)=>createHash('sha256').update(token).digest('hex');
const id=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function createPlatformStaffCommandAdmission(login:Auth0Login, port:PlatformStaffPilotPort) {
  const resolve=port.resolve.bind(port), execute=port.execute.bind(port);
  const pending=new Map<string,{intent:PlatformIntentBinding; fingerprint:string; until:number}>();
  const ready=new Map<string,{intent:PlatformIntentBinding; proof:PlatformProof; token:string}>();
  let closed=false;
  const forget=(token:string)=>{
    const key=sessionKey(token);ready.delete(key);
    for(const [tx,entry] of pending)if(entry.fingerprint===key){pending.delete(tx);login.cancel(tx);}
  };
  return Object.freeze({
    async begin(token:string,actionId:string,previous?:string) {
      if(closed || !id.test(actionId))return null;
      forget(token);
      for(const [tx,entry] of pending)if(entry.until<=Date.now())pending.delete(tx);
      if(pending.size>=1000)return null;
      const prepared=await login.readForPlatformSession(token,(_identity,staffId)=>resolve(actionId,staffId));
      if(!prepared || !Object.isFrozen(prepared.intent) || closed)return null;
      const transaction=await beginPlatformStaffStepUp(login,prepared.intent,token,prepared.expiresAtMs,previous);
      const key=transaction.cookie.split(';',1)[0]!.split('=')[1];
      if(!key || closed || pending.size>=1000){if(key)login.cancel(key);return null;}
      pending.set(key,{intent:prepared.intent,fingerprint:sessionKey(token),until:Date.now()+300000});
      return transaction;
    },
    async callback(url:string,transactionId:string|undefined,currentToken?:string) {
      const prior=transactionId ? pending.get(transactionId) : undefined;
      if(transactionId)pending.delete(transactionId);
      const result=await login.completeBrowserCallback(url,transactionId,currentToken);
      if(!result.stepUp)return {token:result.token,redirect:'/'};
      const {command,proof}=result.stepUp;
      for(const [key,entry] of ready)if(!login.hasLiveStepUp(entry.proof.proof,entry.token))ready.delete(key);
      if(closed || !prior || prior.until<=Date.now() || ready.size>=1000 || command.operation!=='PLATFORM_STAFF_SECURITY' ||
          command.actorStaffId!==prior.intent.actorStaffId || command.intentDigest!==prior.intent.intentDigest)
        throw new Error('Platform staff confirmation unavailable');
      ready.set(sessionKey(result.token),{intent:prior.intent,proof:{command,proof},token:result.token});
      return {token:result.token,redirect:'/'};
    },
    async describe(token:string) {
      return login.readForPlatformSession(token,async()=>{
        const entry=ready.get(sessionKey(token));
        return {state:entry && login.hasLiveStepUp(entry.proof.proof,token) ? 'READY' : 'STEP_UP_REQUIRED'};
      });
    },
    async confirm(token:string) {
      const key=sessionKey(token),entry=ready.get(key);
      ready.delete(key);
      if(closed || !entry || !login.hasLiveStepUp(entry.proof.proof,token))return {state:'STEP_UP_REQUIRED'};
      try {
        const {kind:state,receiptId,auditId,revokedSessions}=await execute(entry.intent,entry.proof,token);
        if(!['APPLIED','RECORDED','REPLAYED','DENIED','UNRESOLVED','ABSENT'].includes(state))return {state:'UNRESOLVED'};
        if(state==='APPLIED' || state==='REPLAYED') {
          if(typeof receiptId!=='string' || !id.test(receiptId) || typeof auditId!=='string' || !id.test(auditId) ||
              typeof revokedSessions!=='number' || !Number.isSafeInteger(revokedSessions) || revokedSessions<0)return {state:'UNRESOLVED'};
          return {state,receiptId,auditId,revokedSessions};
        }
        return {state};
      } catch {return {state:'UNRESOLVED'};}
    },
    forget,
    close(){closed=true;pending.clear();ready.clear();},
  });
}
