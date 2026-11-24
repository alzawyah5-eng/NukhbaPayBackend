import { AiJobError } from "@nukhbapay/application";
import type { AiJobSqlClient, AiJobSqlResult } from "./ai-job-prepared-control.js";

export type AiConnectionKind = "jobs" | "source";
export interface AiManagedClient {
  readonly backendPid: number; readonly backendStartedAt: string; readonly expiresAt: number;
  healthy(): boolean; idle(): boolean;
  onFault(listener: () => void): () => void;
  query(sql: string, values?: unknown[]): Promise<AiJobSqlResult>;
  end(): Promise<void>;
}
export interface AiPoolPolicy {
  minimum: number; maximum: number; maximumConnecting: number;
  administrativeReserve: number; authorizedConnectionBudget: number;
  queueLimit: number; perTenantQueueLimit: number; acquisitionMs: number;
  idleMs: number; maintenanceMs: number;
}
export const DEFAULT_AI_POOL_POLICY: Readonly<AiPoolPolicy> = Object.freeze({minimum:2,maximum:4,maximumConnecting:2,
  administrativeReserve:2,authorizedConnectionBudget:6,queueLimit:8,perTenantQueueLimit:2,acquisitionMs:1000,idleMs:10000,maintenanceMs:100});
export const AI_MANAGED_BUDGETS=Object.freeze({runMs:1200000,startupMs:60000,diagnosticMs:15000,integrityMs:4000,
 setupMs:32000,preflightMs:20000,physicalMs:4500,stallMs:10000,networkMs:6500,assertionMs:4000,cleanupMs:3000});
/** Cold-start schedules are rejected before any connection. Growth uses the
 * control-plane connector, never acquire(). All budgets remain bounded. */
export function validateAiStartupSchedule(policy:Readonly<AiPoolPolicy>):number{
 const required=AI_MANAGED_BUDGETS.diagnosticMs+AI_MANAGED_BUDGETS.integrityMs+
  Math.ceil(policy.minimum/policy.maximumConnecting)*AI_MANAGED_BUDGETS.setupMs+AI_MANAGED_BUDGETS.cleanupMs;
 if(!Number.isSafeInteger(required)||required>AI_MANAGED_BUDGETS.startupMs)throw new AiJobError(503);return required;
}
const deny=()=>new AiJobError(503);
interface Entry { client: AiManagedClient; kind: AiConnectionKind; state: "IDLE"|"LEASED"|"QUARANTINED"|"CLOSED"; used: number; pair?: AiPairLease; removeFault(): void; pending:Set<Promise<unknown>>; }
interface Waiter { tenant:string; deadline:number; signal:AbortSignal; resolve(p:AiPairLease):void; reject(e:Error):void; dispose():void; }

/** Domain-specific connection owner. acquire() NEVER invokes a connector. Only
 * start()/maintain() create connections under the approved startup authority. */
export class AiJobSessionPool {
  readonly policy:Readonly<AiPoolPolicy>;
  #entries:Entry[]=[]; #queues=new Map<string,Waiter[]>(); #order:string[]=[];
  #pairs=new Set<AiPairLease>(); #connecting=0; #closed=false; #uncertain=false;
  #maintenance:Promise<void>|undefined; #timer:ReturnType<typeof setInterval>|undefined; #started=false;
  #root=new AbortController(); #closing:Promise<void>|undefined;
  #lastTenant:string|undefined;
  constructor(policy:Readonly<AiPoolPolicy>,private readonly connector:(kind:AiConnectionKind,signal:AbortSignal)=>Promise<AiManagedClient>,
    private readonly verify:(client:AiManagedClient)=>Promise<void>,seeds:readonly {client:AiManagedClient;kind:AiConnectionKind}[]=[]){
    this.policy=Object.freeze({...policy});policy=this.policy;
    const n=Object.values(policy);if(n.some(x=>!Number.isSafeInteger(x)||x<0)||policy.minimum<2||policy.minimum%2||policy.maximum%2||policy.maximum<policy.minimum||
      policy.maximumConnecting<1||policy.maximumConnecting>policy.maximum||policy.administrativeReserve<1||policy.maximum+policy.administrativeReserve>policy.authorizedConnectionBudget||
      policy.queueLimit<1||policy.perTenantQueueLimit<1||policy.perTenantQueueLimit>policy.queueLimit||policy.acquisitionMs<1||policy.idleMs<1||policy.maintenanceMs<1||seeds.length>policy.maximum)throw deny();
    for(const seed of seeds)this.add(seed.client,seed.kind);
  }
  private add(client:AiManagedClient,kind:AiConnectionKind):void {
    if(!Number.isSafeInteger(client.backendPid)||client.backendPid<1||!/^\d{10,16}([.]\d{1,6})?$/.test(client.backendStartedAt)||!client.healthy()||!client.idle()||client.expiresAt<=performance.now()||this.#entries.some(e=>e.client.backendPid===client.backendPid&&e.state!=="CLOSED"))throw deny();
    const e:Entry={client,kind,state:"IDLE",used:performance.now(),removeFault:()=>{},pending:new Set()};
    e.removeFault=client.onFault(()=>{void this.quarantine(e);});this.#entries.push(e);
  }
  snapshot(){return {closed:this.#closed,uncertain:this.#uncertain,connections:this.#entries.filter(e=>e.state!=="CLOSED").length,
    idle:this.#entries.filter(e=>e.state==="IDLE").length,active:this.#pairs.size,queued:[...this.#queues.values()].reduce((n,q)=>n+q.length,0),connecting:this.#connecting,
    administrativeReserve:this.policy.administrativeReserve,quarantinedBackends:this.#entries.filter(e=>e.state==='QUARANTINED').map(e=>({pid:e.client.backendPid,startedAt:e.client.backendStartedAt}))};}
  async start():Promise<void>{
    if(this.#closed||this.#started)throw deny();this.#started=true;
    for(let wave=0;this.#entries.filter(e=>e.state==="IDLE").length<this.policy.minimum;wave++){
      if(wave>=Math.ceil(this.policy.minimum/this.policy.maximumConnecting)||this.#uncertain)throw deny();await this.maintain();
    }
    this.#timer=setInterval(()=>{void this.maintain().catch(()=>{this.#uncertain=true;});},this.policy.maintenanceMs);this.#timer.unref();
  }
  maintain():Promise<void>{
    if(this.#closed||this.#uncertain)return Promise.resolve();
    return this.#maintenance??=(async()=>{
      const now=performance.now();
      for(const e of this.#entries){
        if(e.state==="IDLE"&&(!e.client.healthy()||e.client.expiresAt<=now)){await this.quarantine(e);continue;}
        const count=this.#entries.filter(x=>x.kind===e.kind&&["IDLE","LEASED"].includes(x.state)).length;
        if(e.state==="IDLE"&&count>this.policy.minimum/2&&now-e.used>=this.policy.idleMs)await this.retire(e);
      }
      if(this.#closed||this.#uncertain)return;
      const desired=Math.min(this.policy.maximum,Math.max(this.policy.minimum,2*(this.#pairs.size+Math.min(1,this.snapshot().queued))));
      const tasks:Promise<void>[]=[];
      for(const kind of ["jobs","source"] as const){
        const count=this.#entries.filter(e=>e.kind===kind&&["IDLE","LEASED"].includes(e.state)).length;
        for(let i=count;i<desired/2&&this.#connecting<this.policy.maximumConnecting;i++){
          this.#connecting++;
          tasks.push((async()=>{let c:AiManagedClient|undefined;
            try{c=await this.connector(kind,this.#root.signal);if(this.#closed||this.#root.signal.aborted)throw deny();await this.verify(c);this.add(c,kind);}
            catch{await c?.end().catch(()=>{});this.#uncertain=true;throw deny();}
            finally{this.#connecting--;}
          })());
        }
      }
      const completed=await Promise.allSettled(tasks);if(completed.some(r=>r.status==='rejected'))throw deny();this.pump();
    })().finally(()=>{this.#maintenance=undefined;});
  }
  acquire(tenant:string,deadline:number,signal:AbortSignal):Promise<AiPairLease>{
    if(!/^[0-9a-f-]{36}$/.test(tenant)||!Number.isFinite(deadline)||this.#closed||this.#uncertain||signal.aborted||performance.now()>=deadline||
      this.snapshot().queued>=this.policy.queueLimit||(this.#queues.get(tenant)?.length??0)>=this.policy.perTenantQueueLimit)return Promise.reject(deny());
    return new Promise((resolve,reject)=>{
      let w:Waiter;const remove=()=>{const q=this.#queues.get(tenant);if(q){const i=q.indexOf(w);if(i>=0)q.splice(i,1);}this.compact();};
      const abort=()=>{remove();w.dispose();reject(deny());};
      const timer=setTimeout(abort,Math.max(0,Math.min(this.policy.acquisitionMs,deadline-performance.now())));
      w={tenant,deadline,signal,resolve,reject,dispose:()=>{clearTimeout(timer);signal.removeEventListener("abort",abort);}};
      if(!this.#queues.has(tenant)){this.#queues.set(tenant,[]);this.#order.push(tenant);}this.#queues.get(tenant)!.push(w);
      signal.addEventListener("abort",abort,{once:true});this.pump();
    });
  }
  private compact(){for(const [t,q] of this.#queues)if(!q.length)this.#queues.delete(t);this.#order=this.#order.filter(t=>this.#queues.has(t));}
  private pump():void{
    if(this.#closed||this.#uncertain)return;
    while(this.#order.length){
      const jobs=this.#entries.find(e=>this.usable(e)&&e.kind==="jobs"),source=this.#entries.find(e=>this.usable(e)&&e.kind==="source");if(!jobs||!source)return;
      // Prefer a waiting tenant without an active pair, then rotate fairly.
      let index=this.#order.findIndex(t=>t!==this.#lastTenant&&![...this.#pairs].some(p=>p.tenant===t));
      if(index<0)index=this.#order.findIndex(t=>![...this.#pairs].some(p=>p.tenant===t));
      const t=this.#order.splice(index<0?0:index,1)[0]!,q=this.#queues.get(t)!,w=q.shift()!;
      if(q.length)this.#order.push(t);else this.#queues.delete(t);w.dispose();
      if(w.signal.aborted||performance.now()>=w.deadline){w.reject(deny());continue;}
      const pair:AiPairLease=new AiPairLease(t,jobs,source,()=>this.release(pair),e=>this.quarantine(e));
      for(const e of [jobs,source]){e.state="LEASED";e.pair=pair;}this.#lastTenant=t;this.#pairs.add(pair);w.resolve(pair);
    }
  }
  private usable(e:Entry){return e.state==="IDLE"&&e.client.healthy()&&e.client.idle()&&e.client.expiresAt>performance.now()+14000;}
  private async release(pair:AiPairLease):Promise<void>{
    if(!this.#pairs.has(pair))throw deny();pair.revoke();
    try{for(const e of pair.entries){
      if(e.state!=="LEASED"||!e.client.healthy()||e.pending.size)throw deny();
      if(!e.client.idle())await e.client.query("ROLLBACK");
      await e.client.query("DISCARD ALL");await this.verify(e.client);
      if(!e.client.healthy()||!e.client.idle())throw deny();
      e.state="IDLE";e.used=performance.now();delete e.pair;
    }}catch{for(const e of pair.entries)await this.quarantine(e);throw deny();}
    finally{this.#pairs.delete(pair);this.pump();}
  }
  private async retire(e:Entry){e.removeFault();try{await e.client.end();e.state="CLOSED";}catch{e.state="QUARANTINED";this.#uncertain=true;this.rejectQueued();throw deny();}}
  private async quarantine(e:Entry){
    if(e.state==="CLOSED"||e.state==="QUARANTINED")return;e.state="QUARANTINED";this.#uncertain=true;e.pair?.abort.abort();
    await e.client.end().catch(()=>{});await Promise.allSettled([...e.pending]);
    // No silent replacement. An authorized control path must prove backend
    // termination/rollback before clearing this quarantine.
    this.rejectQueued();
  }
  async reconcile(backendAbsent:(pid:number,startedAt:string)=>Promise<boolean>):Promise<void>{
    if(this.#closed||this.#pairs.size||this.#connecting)throw deny();
    for(const e of this.#entries.filter(e=>e.state==="QUARANTINED")){if(!await backendAbsent(e.client.backendPid,e.client.backendStartedAt))throw deny();e.state="CLOSED";e.removeFault();}
    this.#uncertain=false;
  }
  async abortLease(pair:AiPairLease):Promise<void>{pair.abort.abort();for(const e of pair.entries)await this.quarantine(e);}
  async resetLease(pair:AiPairLease):Promise<void>{
    if(!this.#pairs.has(pair)||!pair.healthy()||pair.checkedOut())throw deny();
    for(const e of pair.entries){if(e.pending.size)throw deny();if(!e.client.idle())await e.client.query("ROLLBACK");await e.client.query("DISCARD ALL");await this.verify(e.client);if(!pair.healthy()||!e.client.idle())throw deny();}
  }
  private rejectQueued(){for(const q of this.#queues.values())for(const w of q){w.dispose();w.reject(deny());}this.#queues.clear();this.#order=[];}
  close():Promise<void>{return this.#closing??=(async()=>{
    this.#closed=true;this.#root.abort();clearInterval(this.#timer);this.rejectQueued();for(const p of this.#pairs){p.abort.abort();p.revoke();}
    await this.#maintenance?.catch(()=>{});for(const e of this.#entries){e.removeFault();let uncertain=e.state==='QUARANTINED';try{await e.client.end();}catch{uncertain=true;this.#uncertain=true;}await Promise.allSettled([...e.pending]);e.state=uncertain?'QUARANTINED':'CLOSED';}
  })();}
}

export class AiPairLease {
  readonly abort=new AbortController();#active=true;#handles=new Set<object>();#checked=new Set<Entry>();
  constructor(readonly tenant:string,readonly jobs:Entry,readonly source:Entry,private readonly giveBack:()=>Promise<void>,private readonly poison:(e:Entry)=>Promise<void>){}
  get entries(){return [this.jobs,this.source] as const;}
  healthy(){return this.#active&&!this.abort.signal.aborted&&this.entries.every(e=>e.state==="LEASED"&&e.pair===this&&e.client.healthy()&&e.client.expiresAt>performance.now());}
  checkout(kind:AiConnectionKind):AiJobSqlClient{
    const e=kind==="jobs"?this.jobs:this.source;if(!this.healthy()||this.#checked.has(e)||!e.client.idle())throw deny();
    const token={};this.#handles.add(token);this.#checked.add(e);let released=false;
    const valid=()=>{if(released||!this.#handles.has(token)||!this.healthy())throw deny();};
    return {query:async(sql,values)=>{valid();const pending=e.client.query(sql,values);e.pending.add(pending);try{const r=await pending;valid();return r;}finally{e.pending.delete(pending);}},
      release:broken=>{valid();released=true;this.#handles.delete(token);this.#checked.delete(e);
        if(e.pending.size){void this.poison(e);throw deny();}if(broken)void this.poison(e);}};
  }
  checkedOut(){return this.#checked.size;}
  revoke(){this.#active=false;this.#handles.clear();this.#checked.clear();}
  release(){return this.giveBack();}
}
