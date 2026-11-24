import type { RefreshClaim } from "./durable-refresh.js";
import { createHash } from "node:crypto";
import type { CatalogProvider } from "../../../provider-contracts/src/index.js";
import type { CatalogImportRepository, CatalogSnapshotReadResult } from "./synthetic-provider-import.js";
import { generateDraftPublicationCandidate, type DraftPublicationCandidate, type DraftPublicationRequest } from "./publication-candidate.js";

export interface CatalogRefreshSchedule {
  readonly id:string; readonly tenantId:string; readonly providerAccountId:string; readonly providerId:string;
  readonly sourceVersion:string; readonly version:string; readonly enabled:boolean;
  readonly firstRunAtMs:number; readonly intervalMs:number;
}
export class CatalogRefreshError extends Error {
  constructor(readonly status:403|409|503){super("Scheduled catalogue refresh unavailable");}
}
/** Only a provider read failure before any import/draft write is retryable. */
export class CatalogRefreshReadUnavailable extends CatalogRefreshError {
  constructor(){super(503);}
}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function operationKey(value:unknown):string {
  const chars=digest(value).slice(0,32).split('');chars[12]='5';chars[16]='8';const h=chars.join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
function schedule(value:CatalogRefreshSchedule|null):CatalogRefreshSchedule {
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const text=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=128&&!/[^A-Za-z0-9_.:-]/.test(v);
  if(!value||![value.id,value.tenantId,value.providerAccountId].every(v=>typeof v==='string'&&uuid.test(v))||
    !text(value.providerId)||!text(value.sourceVersion)||!text(value.version)||typeof value.enabled!=='boolean'||
    !Number.isSafeInteger(value.firstRunAtMs)||value.firstRunAtMs<0||!Number.isSafeInteger(value.intervalMs)||
    value.intervalMs<1000||value.intervalMs>86400000)throw new CatalogRefreshError(503);
  return Object.freeze({id:value.id,tenantId:value.tenantId,providerAccountId:value.providerAccountId,providerId:value.providerId,
    sourceVersion:value.sourceVersion,version:value.version,enabled:value.enabled,firstRunAtMs:value.firstRunAtMs,intervalMs:value.intervalMs});
}

/** Trusted backend worker composition only. No timer, listener, provider credential
 * discovery or publication authority. The existing repository owns import
 * transactions; each draft save owns its immutable version/audit transaction. */
export class ScheduledCatalogRefresh {
  readonly #active=new Set<string>();
  constructor(private readonly deps:{
    readonly capability:"ISOLATED_SYNTHETIC_CATALOG_REFRESH_ONLY";
    readonly schedules:{find(id:string):Promise<CatalogRefreshSchedule|null>};
    readonly providers:ReadonlyMap<string,CatalogProvider>;
    readonly catalog:CatalogImportRepository;
    readonly drafts:{prepare(snapshot:CatalogSnapshotReadResult,signal:AbortSignal):Promise<readonly DraftPublicationRequest[]>;
      save(candidate:DraftPublicationCandidate):Promise<{readonly candidateId:string;readonly priceVersion:number;readonly execution:"NOT_AUTHORIZED"}>;
      saveFenced?(candidate:DraftPublicationCandidate,claim:RefreshClaim):Promise<{readonly candidateId:string;readonly priceVersion:number;readonly execution:"NOT_AUTHORIZED"}>};
    readonly now:()=>Date;readonly concurrency?:number;
  }) {
    if(deps.capability!=="ISOLATED_SYNTHETIC_CATALOG_REFRESH_ONLY"||!Number.isSafeInteger(deps.concurrency??2)||
      (deps.concurrency??2)<1||(deps.concurrency??2)>4)throw new CatalogRefreshError(503);
  }
  async runDue(scheduleId:string,signal:AbortSignal,expected?:{readonly version:string;readonly slotAtMs:number;readonly tenantId?:string;readonly leaseUntilMs?:number;readonly checkLease?:()=>Promise<boolean>;readonly claim?:RefreshClaim}) {
    let lock:string|undefined;
    const expired = () => !expected?.checkLease && expected?.leaseUntilMs !== undefined &&
      (!Number.isSafeInteger(expected.leaseUntilMs) || this.deps.now().getTime() >= expected.leaseUntilMs);
    try {
      if(signal.aborted || expired())throw new CatalogRefreshError(503);
      const claim=expected?.claim;
      if (expected?.checkLease && (!claim || claim.scheduleId!==scheduleId || claim.tenantId!==expected.tenantId ||
          claim.version!==expected.version || claim.slotAtMs!==expected.slotAtMs ||
          !this.deps.catalog.importFencedSnapshot || !this.deps.drafts.saveFenced)) throw new CatalogRefreshError(403);
      if (claim && !expected?.checkLease) throw new CatalogRefreshError(403);
      const selected=schedule(await this.deps.schedules.find(scheduleId));
      if(selected.id!==scheduleId||!selected.enabled||(expected?.tenantId!==undefined&&selected.tenantId!==expected.tenantId))throw new CatalogRefreshError(403);
      const now=this.deps.now().getTime();if(!Number.isSafeInteger(now)||now<0)throw new CatalogRefreshError(503);
      if(!expected?.checkLease && now<selected.firstRunAtMs)return Object.freeze({state:'NOT_DUE' as const,execution:'NOT_AUTHORIZED' as const});
      const at=expected?.slotAtMs??selected.firstRunAtMs+Math.floor((now-selected.firstRunAtMs)/selected.intervalMs)*selected.intervalMs;
      if(expected&&(expected.version!==selected.version||!Number.isSafeInteger(at)||at<selected.firstRunAtMs||(!expected.checkLease&&at>now)||
        (at-selected.firstRunAtMs)%selected.intervalMs!==0))throw new CatalogRefreshError(409);
      const snapshotKey='scheduled-'+digest([selected.tenantId,selected.providerAccountId,selected.id,selected.version,at]);
      const key=digest([selected.tenantId,selected.providerAccountId]);
      if(this.#active.has(key))throw new CatalogRefreshError(409);
      if(this.#active.size>=(this.deps.concurrency??2))throw new CatalogRefreshError(503);
      this.#active.add(key);lock=key;
      const fresh=async()=>{
        if(signal.aborted || expired())throw new CatalogRefreshError(503);
        const current=schedule(await this.deps.schedules.find(scheduleId));
        if (expected?.checkLease && !await expected.checkLease()) throw new CatalogRefreshError(503);
        if(signal.aborted || expired())throw new CatalogRefreshError(503);
        if(!current.enabled||digest(current)!==digest(selected))throw new CatalogRefreshError(403);
      };
      await fresh();
      let accepted=await this.deps.catalog.readSnapshot(selected.tenantId,selected.providerAccountId,snapshotKey);
      let imported=false;
      if(!accepted) {
        const provider=this.deps.providers.get(selected.providerId);
        if(!provider||provider.providerId!==selected.providerId)throw new CatalogRefreshError(503);
        let offers;
        try{offers=await provider.fetchCatalog(signal);}catch{
          if(signal.aborted || expired())throw new CatalogRefreshError(503);
          throw new CatalogRefreshReadUnavailable();
        }
        await fresh();
        if(!Array.isArray(offers)||offers.length>10000||offers.some(o=>o.providerId!==selected.providerId))throw new CatalogRefreshError(503);
        // The backend owns the import snapshot grouping; original provider IDs and observation times are retained.
        const context={tenantId:selected.tenantId,providerAccountId:selected.providerAccountId,
          snapshotKey,sourceVersion:selected.sourceVersion,observedAt:new Date(at).toISOString(),effectiveAt:null};
        const normalized=offers.map(o=>Object.freeze({...o,snapshotId:snapshotKey,identity:Object.freeze({...o.identity})}));
        if (claim) await this.deps.catalog.importFencedSnapshot!(context,normalized,claim);
        else await this.deps.catalog.importSyntheticSnapshot(context,normalized);
        imported=true;await fresh();
        accepted=await this.deps.catalog.readSnapshot(selected.tenantId,selected.providerAccountId,snapshotKey);
      }
      if(!accepted||accepted.snapshot.tenantId!==selected.tenantId||accepted.snapshot.providerAccountId!==selected.providerAccountId||
        accepted.snapshot.snapshotKey!==snapshotKey||accepted.snapshot.sourceVersion!==selected.sourceVersion||
        accepted.snapshot.status!=='COMPLETE'||!accepted.snapshot.completedAt)throw new CatalogRefreshError(409);
      await fresh();
      const requests=await this.deps.drafts.prepare(accepted,signal);await fresh();
      if(!Array.isArray(requests)||requests.length>100||new Set(requests.map(r=>r.productId)).size!==requests.length)throw new CatalogRefreshError(503);
      const candidates=requests.map((request:DraftPublicationRequest)=>{
        if(request.tenantId!==selected.tenantId||request.sourceSnapshots.length!==1||
          request.sourceSnapshots[0]?.snapshotId!==accepted.snapshot.id||request.sourceSnapshots[0].providerAccountId!==selected.providerAccountId||
          request.sourceSnapshots[0].snapshotKey!==snapshotKey||request.offers.some(o=>o.providerId!==selected.providerId))throw new CatalogRefreshError(403);
        return generateDraftPublicationCandidate({...request,evaluatedAt:accepted.snapshot.completedAt!,
          idempotencyKey:operationKey([selected.tenantId,selected.id,selected.version,at,request.productId,request.pricingPolicy.version])});
      });
      for(const candidate of candidates) {
        await fresh();
        const receipt=claim
          ? await this.deps.drafts.saveFenced!(candidate,claim)
          : await this.deps.drafts.save(candidate);
        await fresh();
        if(receipt.candidateId!==candidate.candidateId||receipt.priceVersion!==candidate.priceVersion||receipt.execution!=='NOT_AUTHORIZED')throw new CatalogRefreshError(503);
      }
      return Object.freeze({state:imported?'REFRESHED' as const:'REPLAYED' as const,snapshotId:accepted.snapshot.id,
        draftIds:Object.freeze(candidates.map(c=>c.candidateId)),execution:'NOT_AUTHORIZED' as const});
    }catch(error){throw error instanceof CatalogRefreshError?error:new CatalogRefreshError(503);}
    finally{if(lock)this.#active.delete(lock);}
  }
}
