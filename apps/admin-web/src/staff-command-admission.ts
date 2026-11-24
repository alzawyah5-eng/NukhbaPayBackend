import { createHash } from 'node:crypto';
import { administrationUuid, inspectSyntheticPublicationCommand, prepareSyntheticPublicationCommand,
  type PublicationCommandTicket, type SyntheticPublicationAuthority, type VerifiedStaffIdentity } from '@nukhbapay/application';
import type { Auth0Login, StaffReviewDecision, StaffStepUpBinding, StaffMembershipStepUpCommand, StaffPublicationStepUpCommand, StaffStepUpCommand, StaffStepUpProof } from './auth0.js';

export type StaffCommandOutcome = 'APPLIED' | 'RECORDED' | 'REPLAYED' | 'DENIED' | 'UNRESOLVED';

export interface StaffSuspensionPort {
  readonly capability: 'DISPOSABLE_STAFF_EFFECT_V1';
  resolve(identity: VerifiedStaffIdentity, tenantId: string, staffId: string, requestId: string,
    idempotencyKey: string, decision?: StaffReviewDecision): Promise<StaffMembershipStepUpCommand | null>;
  // The restricted executor consumes the proof through Auth0Login on the server.
  execute(intent: StaffMembershipStepUpCommand, proof: StaffStepUpProof, credential: string): Promise<{ readonly kind: StaffCommandOutcome }>;
}

export interface StaffPublicationPort {
  readonly authority:SyntheticPublicationAuthority;
  executePublication(ticket:PublicationCommandTicket):Promise<{
    readonly operationId:string;readonly candidateId:string;readonly action:string;
    readonly synthetic:true;readonly execution:'NOT_AUTHORIZED';readonly replayed:boolean;
  }>;
}

const sessionKey = (token: string) => createHash('sha256').update(token).digest('hex');
const equal = (a: StaffMembershipStepUpCommand, b: StaffMembershipStepUpCommand) =>
  a.actorStaffId===b.actorStaffId && a.tenantId===b.tenantId && a.targetStaffId===b.targetStaffId &&
  a.requestId===b.requestId && a.requestVersion===b.requestVersion && a.requestDigest===b.requestDigest &&
  a.approvalDigest===b.approvalDigest && a.idempotencyKey===b.idempotencyKey && a.permission===b.permission &&
  a.expiresAtMs===b.expiresAtMs && (a.operation==='DECIDE_SUSPENSION'
    ? b.operation==='DECIDE_SUSPENSION' && a.slot===b.slot && a.decision===b.decision
    : b.operation==='SUSPEND_MEMBERSHIP');

export function createStaffCommandAdmission(login: Auth0Login, port?: StaffSuspensionPort, publication?:StaffPublicationPort) {
  const confirmations = new Map<string, {
    token: string; command: StaffStepUpCommand; proof: StaffStepUpProof;
  }>();
  const forget = (token: string) => confirmations.delete(sessionKey(token));

  async function resolve(token: string, requestId: string, idempotencyKey: string, decision?: StaffReviewDecision) {
    return login.readForSession(token,async (identity,tenantId,staffId) => {
      const command=await port?.resolve(identity,tenantId,staffId,requestId,idempotencyKey,decision);
      if (!command || command.actorStaffId!==staffId || command.tenantId!==tenantId ||
          command.requestId!==requestId || command.idempotencyKey!==idempotencyKey ||
          (command.operation==='DECIDE_SUSPENSION' ? command.decision!==decision : decision!==undefined)) return null;
      return Object.freeze({...command});
    });
  }

  async function executePublication(token:string,command:StaffPublicationStepUpCommand,proof:StaffStepUpProof) {
    if (!publication) return 'DENIED';
    const assurance=await login.consumeStepUp(proof,command,token);
    if (!assurance) return 'DENIED';
    const ticket=await login.readForSession(token,async(identity,tenantId,staffId)=>{
      if (tenantId!==command.tenantId || staffId!==command.actorStaffId || identity.issuer!==assurance.factorEvent.issuer ||
          identity.subject!==assurance.factorEvent.subject || identity.security.issuedAt*1000!==assurance.factorEvent.identityIssuedAtMs)
        throw new Error('Publication denied');
      return prepareSyntheticPublicationCommand(publication.authority,identity,command.command,{
        commandDigest:command.commandDigest,authorityDigest:command.authorityDigest,revalidate:assurance.revalidate,
      });
    });
    try {
      const result=await publication.executePublication(ticket);
      if(result.synthetic!==true||result.execution!=='NOT_AUTHORIZED'||!administrationUuid.test(result.operationId)||
         result.candidateId!==command.command.candidateId||
         result.action!==command.command.action||typeof result.replayed!=='boolean')return 'UNRESOLVED';
      return result.replayed ? 'REPLAYED' : 'RECORDED';
    } catch {return 'UNRESOLVED';}
  }

  return Object.freeze({
    async begin(token: string, requestId: string, idempotencyKey: string, previous?: string, decision?: StaffReviewDecision) {
      forget(token);
      const command=await resolve(token,requestId,idempotencyKey,decision);
      return command ? login.beginStepUp(command,token,previous) : null;
    },
    async beginPublication(token:string,intent:Readonly<Record<string,unknown>>,previous?:string) {
      if (!publication || Object.hasOwn(intent,'tenantId')) return null;
      forget(token);
      const binding=await login.readForSession(token,async(identity,tenantId,staffId)=>{
        const admitted=await inspectSyntheticPublicationCommand(publication.authority,identity,{...intent,tenantId});
        if (admitted.staffId!==staffId) throw new Error('Publication denied');
        return {operation:'CATALOGUE_PUBLICATION' as const,actorStaffId:staffId,tenantId,expiresAtMs:identity.security.expiresAt*1000,
          command:admitted.command,commandDigest:admitted.commandDigest,authorityDigest:admitted.authorityDigest};
      });
      return login.beginStepUp(binding,token,previous);
    },
    async callback(url: string, transactionId: string | undefined, currentToken?: string) {
      const result=await login.completeBrowserCallback(url,transactionId,currentToken);
      if (!result.stepUp) return {token:result.token,redirect:'/'};
      if (result.stepUp.command.operation==='PLATFORM_STAFF_SECURITY') throw new Error('Staff confirmation unavailable');
      for (const [key,value] of confirmations) if (!login.hasLiveStepUp(value.proof,value.token)) confirmations.delete(key);
      if (confirmations.size>=1000) throw new Error('Staff confirmation unavailable');
      confirmations.set(sessionKey(result.token),{...result.stepUp,token:result.token});
      return {token:result.token,redirect:result.stepUp.command.operation==='CATALOGUE_PUBLICATION' ? '/catalogue/publication' : '/staff/commands'};
    },
    async describe(token: string, isPublication=false) {
      return login.readForSession(token,async()=>{
        const entry=confirmations.get(sessionKey(token));
        if (!entry || !login.hasLiveStepUp(entry.proof,token)) return {state:'STEP_UP_REQUIRED' as const};
        if ((entry.command.operation==='CATALOGUE_PUBLICATION')!==isPublication) return {state:'STEP_UP_REQUIRED' as const};
        if (entry.command.operation==='CATALOGUE_PUBLICATION') return {state:'READY' as const,...entry.command.command};
        if (entry.command.operation==='PLATFORM_STAFF_SECURITY') return {state:'STEP_UP_REQUIRED' as const};
        const {requestId,requestVersion,targetStaffId}=entry.command;
        return {state:'READY' as const,requestId,requestVersion,targetStaffId,
          ...(entry.command.operation==='DECIDE_SUSPENSION' && {decision:entry.command.decision})};
      });
    },
    async execute(token: string, isPublication=false): Promise<StaffCommandOutcome | 'STEP_UP_REQUIRED'> {
      const entry=confirmations.get(sessionKey(token));
      if (!entry || (entry.command.operation==='CATALOGUE_PUBLICATION')!==isPublication) return 'STEP_UP_REQUIRED';
      forget(token);
      if (!login.hasLiveStepUp(entry.proof,token)) return 'STEP_UP_REQUIRED';
      if(entry.command.operation==='CATALOGUE_PUBLICATION')return executePublication(token,entry.command,entry.proof);
      if(entry.command.operation==='PLATFORM_STAFF_SECURITY')return 'DENIED';
      if(!port)return 'DENIED';
      const decision=entry.command.operation==='DECIDE_SUSPENSION' ? entry.command.decision : undefined;
      const latest=await resolve(token,entry.command.requestId,entry.command.idempotencyKey,decision);
      if (!latest || !equal(entry.command,latest)) return 'DENIED';
      const result=await port.execute(entry.command,entry.proof,token);
      return ['APPLIED','RECORDED','REPLAYED','DENIED','UNRESOLVED'].includes(result.kind) ? result.kind : 'UNRESOLVED';
    },
    forget,
    close:()=>confirmations.clear(),
  });
}

type ApprovalIntent = StaffStepUpBinding & Readonly<{
  purpose:'DECIDE'; slot:'SECURITY_ADMIN'|'GOVERNANCE_OWNER'; decision:StaffReviewDecision;
}>;
type SuspensionIntent = StaffStepUpBinding & Readonly<{purpose:'EXECUTE'}>;
type StaffEffectIntent = SuspensionIntent | ApprovalIntent;

function commandFrom(intent: StaffEffectIntent): StaffMembershipStepUpCommand {
  const {actorStaffId,tenantId,targetStaffId,requestId,requestVersion,requestDigest,approvalDigest,idempotencyKey,expiresAtMs}=intent;
  const binding={actorStaffId,tenantId,targetStaffId,requestId,requestVersion,requestDigest,approvalDigest,idempotencyKey,expiresAtMs};
  if (intent.purpose==='EXECUTE') return {...binding,operation:'SUSPEND_MEMBERSHIP',permission:'tenant.staff.suspend'};
  const {slot,decision}=intent;
  return slot==='SECURITY_ADMIN'
    ? {...binding,operation:'DECIDE_SUSPENSION',slot,decision,permission:'platform.access.approve'}
    : {...binding,operation:'DECIDE_SUSPENSION',slot,decision,permission:'platform.access.approve_privileged'};
}

export function connectDisposableStaffSuspension(backend: {
  prepareSuspension(identity:VerifiedStaffIdentity,tenantId:string,staffId:string,requestId:string,idempotencyKey:string):Promise<StaffStepUpBinding|null>;
  prepareApproval(identity:VerifiedStaffIdentity,tenantId:string,staffId:string,requestId:string,idempotencyKey:string,
    decision:StaffReviewDecision):Promise<ApprovalIntent|null>;
  run(intent:StaffEffectIntent,proof:unknown,credential:string):Promise<{readonly kind:StaffCommandOutcome}>;
}): StaffSuspensionPort {
  return Object.freeze({
    capability:'DISPOSABLE_STAFF_EFFECT_V1',
    async resolve(identity:VerifiedStaffIdentity,tenantId:string,staffId:string,requestId:string,idempotencyKey:string,decision?:StaffReviewDecision) {
      if (decision) {
        const intent=await backend.prepareApproval(identity,tenantId,staffId,requestId,idempotencyKey,decision);
        return intent ? commandFrom(intent) : null;
      }
      const fields=await backend.prepareSuspension(identity,tenantId,staffId,requestId,idempotencyKey);
      return fields ? commandFrom({...fields,purpose:'EXECUTE'}) : null;
    },
    async execute(command:StaffMembershipStepUpCommand,proof:StaffStepUpProof,credential:string) {
      const {actorStaffId,tenantId,targetStaffId,requestId,requestVersion,requestDigest,approvalDigest,idempotencyKey,expiresAtMs}=command;
      const binding={actorStaffId,tenantId,targetStaffId,requestId,requestVersion,requestDigest,approvalDigest,idempotencyKey,expiresAtMs};
      const intent:StaffEffectIntent=command.operation==='DECIDE_SUSPENSION'
        ? {...binding,purpose:'DECIDE',slot:command.slot,decision:command.decision} : {...binding,purpose:'EXECUTE'};
      return backend.run(intent,proof,credential);
    },
  });
}

/** Bridge for the explicitly isolated executor. The authenticated provider
 * factor event stays server-side and is never accepted from HTTP input. */
export function disposableSuspensionAssurance(login: Auth0Login) {
  return async (intent: { readonly purpose:string }, proof: unknown, session: string) => {
    if ((intent.purpose!=='EXECUTE' && intent.purpose!=='DECIDE') || typeof proof!=='object' || proof===null) return null;
    const command=commandFrom(intent as StaffEffectIntent);
    const authorization=await login.consumeStepUp(proof as StaffStepUpProof,command,session);
    if (!authorization || !authorization.factorEvent) return null;
    return Object.freeze({profile:'DISPOSABLE_STAFF_EFFECT_V1' as const,...authorization.factorEvent,
      staffId:command.actorStaffId,tenantId:command.tenantId,expiresAtMs:authorization.expiresAtMs,revalidate:authorization.revalidate});
  };
}
