import { createHash, randomBytes, randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { isVerifiedSessionActor, type TrustedStaffActor, type TrustedStaffActorBoundary, type VerifiedSessionActor } from "./trusted-staff-actor.js";

export const STAFF_SESSION_COOKIE = "__Host-nukhbapay_staff";
export const STAFF_SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
export const STAFF_SESSION_IDLE_MS = 15 * 60 * 1000;
export interface SessionBinding {
  readonly staffId: string; readonly issuer: string; readonly subject: string; readonly tenantId: string | null;
  readonly authzVersion: string; readonly membershipVersion: string | null; readonly authorityDigest: string;
  readonly identityExpiresAtMs: number;
}
export type SessionOperation = "CREATE" | "VALIDATE" | "ROTATE" | "REVOKE" | "CHECK_REVOKED";
declare const ticketBrand: unique symbol;
export interface StaffSessionTicket {
  readonly [ticketBrand]: true; readonly operation: SessionOperation; readonly operationId: string;
  readonly sessionId: string; readonly tokenHash: string; readonly previousHash?: string; readonly previousBinding?: SessionBinding;
  readonly binding: SessionBinding; readonly nowMs: number; readonly expiresAtMs: number; readonly idleMs: number;
  readonly reason: "AUTHENTICATION" | "CONTEXT_ROTATION" | "VALIDATION" | "LOGOUT" | "AUTHORITY_CHANGED";
  revalidate(): Promise<boolean>;
}
const tickets = new WeakSet<object>();
export function consumeStaffSessionTicket(value: unknown): value is StaffSessionTicket {
  if (typeof value !== "object" || value === null || !tickets.has(value)) return false;
  tickets.delete(value); return true;
}
export type SessionStoreOutcome = "COMMITTED" | "ACTIVE" | "REVOKED" | "ABSENT" | "DENIED" | "UNRESOLVED";
export interface StaffSessionHistoryEntry {
  readonly id:string;
  readonly createdAtMs:number;
  readonly lastUsedAtMs:number;
  readonly expiresAtMs:number;
  readonly revoked:boolean;
}
export interface StaffSessionHistoryTicket {
  readonly staffId:string;
  readonly tenantId:string;
}
const historyTickets=new WeakSet<StaffSessionHistoryTicket>();
export function consumeStaffSessionHistoryTicket(ticket:StaffSessionHistoryTicket):boolean {return historyTickets.delete(ticket);}
export interface StaffSessionStore {
  execute(ticket: StaffSessionTicket): Promise<SessionStoreOutcome>;
  history?(ticket:StaffSessionHistoryTicket):Promise<readonly StaffSessionHistoryEntry[]>;
}
class SessionCredential {
  readonly #value: string;
  constructor(value: string) { this.#value = value; Object.freeze(this); }
  /** Trusted server cookie sink only. Never log, serialize or return in an HTTP body. */
  cookieValue(): string { return this.#value; }
  toJSON(): string { return "[REDACTED_SESSION]"; }
  toString(): string { return "[REDACTED_SESSION]"; }
  [inspect.custom](): string { return "[REDACTED_SESSION]"; }
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const validToken = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const binding = (e: VerifiedSessionActor): SessionBinding => Object.freeze({staffId:e.staffId,issuer:e.issuer,subject:e.subject,
  tenantId:e.tenantId,authzVersion:e.authzVersion,membershipVersion:e.membershipVersion,
  authorityDigest:e.authorityDigest,identityExpiresAtMs:e.identityExpiresAtMs});
const same = (a: SessionBinding, b: SessionBinding) => JSON.stringify(a) === JSON.stringify(b);
const failure = (reason: "DISABLED" | "DENIED" | "UNAVAILABLE") => Object.freeze({ok:false as const,reason,execution:"NOT_AUTHORIZED" as const});

/** No environment-selected activation, token attester, enrollment, API permission or MFA bypass. */
export class StaffSessionLifecycle {
  readonly #known = new Map<string, {actor:TrustedStaffActor;binding:SessionBinding;id:string;expiresAtMs:number;invalidated:boolean}>();
  readonly #blockedActors = new WeakSet<object>();
  constructor(private readonly dependencies: {
    readonly actors: Pick<TrustedStaffActorBoundary,"inspectSessionActor">; readonly store: StaffSessionStore;
    readonly now: () => Date; readonly enabled?: boolean; readonly absoluteMs?: number; readonly idleMs?: number;
  }) {
    // Trusted ports can retain restricted database pools. Keep them out of JSON/debug output.
    Object.defineProperty(this,'dependencies',{value:dependencies,enumerable:false,writable:false});
    for(const [value,max] of [[dependencies.absoluteMs ?? STAFF_SESSION_ABSOLUTE_MS,STAFF_SESSION_ABSOLUTE_MS],
      [dependencies.idleMs ?? STAFF_SESSION_IDLE_MS,STAFF_SESSION_IDLE_MS]]) {
      if(!Number.isSafeInteger(value) || value<1 || value>max) throw new TypeError("Invalid session lifetime");
    }
  }
  [inspect.custom]():string { return '[StaffSessionLifecycle: internal, non-authorized]'; }
  #now():number { const n=this.dependencies.now().getTime();if(!Number.isSafeInteger(n)||n<0)throw new Error("Invalid session clock");return n; }
  #ticket(operation:SessionOperation, tokenHash:string, id:string, bound:SessionBinding, expiresAtMs:number,
    revalidate:()=>Promise<boolean>, previousHash?:string, previousBinding?:SessionBinding, revocationReason:"LOGOUT"|"AUTHORITY_CHANGED"="LOGOUT"):StaffSessionTicket {
    const ticket=Object.freeze({operation,operationId:randomUUID(),sessionId:id,tokenHash,binding:bound,nowMs:this.#now(),expiresAtMs,
      idleMs:this.dependencies.idleMs??STAFF_SESSION_IDLE_MS,
      reason:operation==="ROTATE"?"CONTEXT_ROTATION":operation==="CREATE"?"AUTHENTICATION":operation==="REVOKE"?revocationReason:"VALIDATION",
      revalidate,...(previousHash===undefined?{}:{previousHash}),...(previousBinding===undefined?{}:{previousBinding})}) as StaffSessionTicket;
    tickets.add(ticket);return ticket;
  }
  async #execute(ticket:StaffSessionTicket) {try{return await this.dependencies.store.execute(ticket);}catch{return "UNRESOLVED" as const;}finally{tickets.delete(ticket);}}
  async create(actor:TrustedStaffActor) {return this.#issue(actor);}
  async rotate(actor:TrustedStaffActor,previousToken:string) {return this.#issue(actor,previousToken);}
  /** A fresh ordinary login may replace an expired session for the same canonical identity. */
  async reauthenticate(actor:TrustedStaffActor,previousToken:string) {return this.#issue(actor,previousToken,true);}
  /** Release expired local bindings only. Durable session/audit history remains append-only. */
  cleanup():number {
    const now=this.#now();let removed=0;
    for(const [key,entry] of this.#known)if(entry.expiresAtMs<=now){entry.invalidated=true;this.#known.delete(key);removed++;}
    return removed;
  }
  async #issue(actor:TrustedStaffActor,previousToken?:string,reauthenticate=false) {
    if(this.dependencies.enabled!==true)return failure("DISABLED");
    try {
      if(typeof actor==='object' && actor!==null && this.#blockedActors.has(actor))return failure("DENIED");
      const evidence=await this.dependencies.actors.inspectSessionActor(actor);
      if(!isVerifiedSessionActor(evidence,actor))return failure("DENIED");
      const bound=binding(evidence),previousHash=validToken(previousToken)?hash(previousToken):undefined;
      const prior=previousHash && this.#known.get(previousHash);
      if(previousToken!==undefined && (!prior || prior.invalidated || prior.binding.staffId!==bound.staffId || prior.binding.tenantId!==bound.tenantId ||
        prior.binding.issuer!==bound.issuer || prior.binding.subject!==bound.subject))return failure("DENIED");
      const expiredReauthentication=reauthenticate && !!prior && prior.expiresAtMs<=this.#now();
      if(reauthenticate && previousToken && !expiredReauthentication) {
        const active=await this.validate(previousToken);
        if(!active.ok)return active;
      }
      this.cleanup();
      if(prior && !expiredReauthentication && prior.invalidated)return failure("DENIED");
      if(this.#known.size>=1000)return failure("UNAVAILABLE");
      const now=this.#now(),expiresAtMs=Math.min(now+(this.dependencies.absoluteMs??STAFF_SESSION_ABSOLUTE_MS),bound.identityExpiresAtMs);
      if(expiresAtMs<=now)return failure("DENIED");
      const token=randomBytes(32).toString("base64url"),tokenHash=hash(token),id=randomUUID();
      const rotating=prior && !expiredReauthentication;
      const outcome=await this.#execute(this.#ticket(rotating?"ROTATE":"CREATE",tokenHash,id,bound,expiresAtMs,evidence.revalidate,
        rotating?previousHash:undefined,rotating?prior.binding:undefined));
      if(outcome!=="COMMITTED")return failure(outcome==="UNRESOLVED"?"UNAVAILABLE":"DENIED");
      if(prior)prior.invalidated=true;
      this.#known.set(tokenHash,{actor,binding:bound,id,expiresAtMs,invalidated:false});
      if(!await evidence.revalidate())return this.#invalidate(token); // Never issue a credential after a changed authority snapshot.
      return Object.freeze({ok:true as const,credential:new SessionCredential(token),execution:"NOT_AUTHORIZED" as const});
    } catch {return failure("UNAVAILABLE");}
  }
  async validate(token:string) {
    if(this.dependencies.enabled!==true)return failure("DISABLED");
    if(!validToken(token))return failure("DENIED");
    const known=this.#known.get(hash(token));if(!known || known.invalidated)return failure("DENIED");
    if(this.#blockedActors.has(known.actor))return this.#invalidate(token);
    try {
      const evidence=await this.dependencies.actors.inspectSessionActor(known.actor);
      if(!isVerifiedSessionActor(evidence,known.actor) || !same(binding(evidence),known.binding)) {
        return this.#invalidate(token);
      }
      const fresh=async()=>{const valid=await evidence.revalidate();return valid && !known.invalidated;};
      const result=await this.#execute(this.#ticket("VALIDATE",hash(token),known.id,known.binding,known.expiresAtMs,fresh));
      if(result!=="ACTIVE")return result==="UNRESOLVED"?failure("UNAVAILABLE"):this.#invalidate(token,!await fresh());
      if(!await fresh())return this.#invalidate(token);
      return Object.freeze({ok:true as const,execution:"NOT_AUTHORIZED" as const,assurance:"not-established" as const});
    } catch {return failure("UNAVAILABLE");}
  }
  /** Minimal self projection after audited store validation and fresh authority checks. */
  async readProfile(token:string) {
    const valid=await this.validate(token);
    if(!valid.ok)return valid;
    try {
      const known=this.#known.get(hash(token));
      if(!known || known.invalidated || known.expiresAtMs<=this.#now())return failure('DENIED');
      const evidence=await this.dependencies.actors.inspectSessionActor(known.actor);
      if(!isVerifiedSessionActor(evidence,known.actor) || !same(binding(evidence),known.binding) || !await evidence.revalidate())return this.#invalidate(token);
      if(known.invalidated || known.expiresAtMs<=this.#now())return failure('DENIED');
      return Object.freeze({ok:true as const,profile:Object.freeze({staffId:evidence.staffId,tenantId:evidence.tenantId,
        expiresAtMs:known.expiresAtMs}),execution:'NOT_AUTHORIZED' as const});
    } catch {return failure('UNAVAILABLE');}
  }
  async readHistory(token:string) {
    if (!validToken(token) || !this.dependencies.store.history) return failure('UNAVAILABLE');
    const active=await this.validate(token);
    if(!active.ok)return active;
    const known=this.#known.get(hash(token));
    if(!known?.binding.tenantId || known.invalidated)return failure('DENIED');
    const ticket=Object.freeze({staffId:known.binding.staffId,tenantId:known.binding.tenantId});
    historyTickets.add(ticket);
    try {
      const rows=await this.dependencies.store.history(ticket);
      const final=await this.validate(token);
      if(!final.ok)return final;
      return {ok:true as const,items:rows.map(row=>({
        id:row.id,createdAtMs:row.createdAtMs,lastUsedAtMs:row.lastUsedAtMs,expiresAtMs:row.expiresAtMs,
        state:row.id===known.id?'CURRENT':row.revoked?'REVOKED':row.expiresAtMs<=this.#now()?'EXPIRED':'RECORDED',
      }))};
    } catch {return failure('UNAVAILABLE');}
    finally {historyTickets.delete(ticket);}
  }
  async revoke(token:string) {return this.#revocation(token,"REVOKE");}
  async verifyRevocation(token:string) {return this.#revocation(token,"CHECK_REVOKED");}
  async #invalidate(token:string,invalidateActor=true) {
    const known=this.#known.get(hash(token));
    if(known){known.invalidated=true;if(invalidateActor)this.#blockedActors.add(known.actor);await this.#revocation(token,"REVOKE","AUTHORITY_CHANGED");}
    return failure("DENIED");
  }
  async #revocation(token:string,operation:"REVOKE"|"CHECK_REVOKED",reason:"LOGOUT"|"AUTHORITY_CHANGED"="LOGOUT") {
    if(this.dependencies.enabled!==true)return failure("DISABLED");
    if(!validToken(token))return failure("DENIED");
    const known=this.#known.get(hash(token));if(!known)return failure("DENIED");
    // Local denial precedes persistence: an uncertain logout must never regain authority after recovery.
    // Keep the binding so durable revocation can be retried and independently verified.
    if(operation==="REVOKE")known.invalidated=true;
    const outcome=await this.#execute(this.#ticket(operation,hash(token),known.id,known.binding,known.expiresAtMs,async()=>true,undefined,undefined,reason));
    return outcome==="REVOKED" ? Object.freeze({ok:true as const,revoked:true as const,execution:"NOT_AUTHORIZED" as const})
      : failure(outcome==="UNRESOLVED"?"UNAVAILABLE":"DENIED");
  }
}
