import {CatalogRefreshReadUnavailable,type DurableRefreshStore,type RefreshClaim,type RefreshSettlement,type ScheduledCatalogRefresh} from '@nukhbapay/application';

export interface RefreshHostOptions {readonly concurrency:number;readonly pollMs:number;readonly timeoutMs:number;readonly leaseMs:number;readonly ownsStore:boolean;}
/** No constructor side effects. start/stop are explicit. stop cancels and joins
 * owned tasks before an owned store is closed; no detached timeout race. */
export class CatalogueRefreshHost {
  #controller:AbortController|undefined;#running:Promise<void>|undefined;#polling=false;#closed=false;#pollOperation:Promise<void>|undefined;#pollController:AbortController|undefined;
  constructor(private readonly deps:{store:DurableRefreshStore;refresh:Pick<ScheduledCatalogRefresh,'runDue'>;now:()=>Date;options:RefreshHostOptions}){
    const o=deps.options;
    if(!Number.isSafeInteger(o.concurrency)||o.concurrency<1||o.concurrency>4||!Number.isSafeInteger(o.pollMs)||o.pollMs<10||o.pollMs>60000||
      !Number.isSafeInteger(o.timeoutMs)||o.timeoutMs<10||o.timeoutMs>60000||!Number.isSafeInteger(o.leaseMs)||o.leaseMs<o.timeoutMs+1000||o.leaseMs>300000)throw new Error('Invalid refresh host options');
  }
  start():void {
    if(this.#closed||this.#running||this.#polling)throw new Error('Refresh host already started or closed');
    this.#controller=new AbortController();const signal=this.#controller.signal;
    this.#running=(async()=>{while(!signal.aborted){await this.pollOnce(signal);if(!signal.aborted)await new Promise<void>(resolve=>{
      const end=()=>{clearTimeout(timer);signal.removeEventListener('abort',end);resolve();};const timer=setTimeout(end,this.deps.options.pollMs);signal.addEventListener('abort',end,{once:true});
    });}})();
    // Keep a rejected loop observable to stop(), without an unhandled rejection.
    void this.#running.catch(()=>undefined);
  }
  async stop():Promise<void>{
    this.#controller?.abort();
    this.#pollController?.abort();
    try{await this.#running;await this.#pollOperation;}finally{this.#running=undefined;this.#controller=undefined;
      if(this.deps.options.ownsStore&&!this.#closed){this.#closed=true;await this.deps.store.close();}}
  }
  pollOnce(signal:AbortSignal):Promise<void>{
    if(this.#pollOperation)return Promise.reject(new Error('Refresh poll overlap'));
    const controller = new AbortController();
    this.#pollController = controller;
    const operation = this.#poll(AbortSignal.any([signal, controller.signal]));
    this.#pollOperation = operation;
    return operation.finally(() => {
      this.#pollOperation = undefined;
      this.#pollController = undefined;
    });
  }
  async #poll(signal:AbortSignal):Promise<void>{
    if(this.#closed||this.#polling)throw new Error('Refresh poll overlap or closed host');
    this.#polling=true;
    try{
      if(signal.aborted)return;
      await this.deps.store.expire(this.deps.now().getTime());
      const jobs:Promise<void>[]=[];
      // Claim first so a claim/store error never abandons previously started work.
      const claims:RefreshClaim[]=[];
      try{for(let i=0;i<this.deps.options.concurrency&&!signal.aborted;i++){
        const claim=await this.deps.store.claim(this.deps.now().getTime(),this.deps.options.leaseMs);if(!claim)break;claims.push(claim);
      }}finally{for(const claim of claims)jobs.push(this.#execute(claim,signal));await Promise.allSettled(jobs).then(results=>{if(results.some(r=>r.status==='rejected'))throw new Error('Refresh settlement unavailable; reconcile persisted claims');});}
    }finally{this.#polling=false;}
  }
  async #execute(claim:RefreshClaim,parent:AbortSignal):Promise<void>{
    const controller=new AbortController(),cancel=()=>controller.abort();parent.addEventListener('abort',cancel,{once:true});if(parent.aborted)cancel();
    const checkLease = this.deps.store.checkLease?.bind(this.deps.store, claim);
    const remaining = checkLease
      ? this.deps.options.timeoutMs
      : claim.leaseUntilMs - this.deps.now().getTime();
    if (remaining <= 0) {
      parent.removeEventListener('abort', cancel);
      await this.deps.store.expire(this.deps.now().getTime());
      return;
    }
    const timer = setTimeout(cancel, Math.min(this.deps.options.timeoutMs, remaining));
    let settlement:RefreshSettlement;
    try{
      if (controller.signal.aborted || (checkLease && !await checkLease())) throw new Error('Refresh cancelled');
      const result=await this.deps.refresh.runDue(claim.scheduleId,controller.signal,{
        version:claim.version, slotAtMs:claim.slotAtMs, tenantId:claim.tenantId, leaseUntilMs:claim.leaseUntilMs,
        ...(checkLease && {checkLease,claim}),
      });
      settlement=!controller.signal.aborted&&result.state!=='NOT_DUE'?{state:'SUCCEEDED',reason:'NONE',nextAttemptAtMs:null}:
        {state:'UNCERTAIN',reason:'CANCELLED_OR_TIMED_OUT',nextAttemptAtMs:null};
    }catch(error){
      const retry=error instanceof CatalogRefreshReadUnavailable&&!controller.signal.aborted;
      settlement={state:retry?(claim.attempt<3?'RETRY_WAIT':'FAILED'):'UNCERTAIN',
        reason:retry?'PROVIDER_READ_UNAVAILABLE':controller.signal.aborted?'CANCELLED_OR_TIMED_OUT':'OUTCOME_UNCERTAIN',
        nextAttemptAtMs:retry&&claim.attempt<3?this.deps.now().getTime()+1000*2**(claim.attempt-1):null};
    }finally{clearTimeout(timer);parent.removeEventListener('abort',cancel);}
    const finished = this.deps.now().getTime();
    if (checkLease ? !await checkLease() : finished >= claim.leaseUntilMs) await this.deps.store.expire(finished);
    else await this.deps.store.settle(claim, settlement, finished);
  }
}
