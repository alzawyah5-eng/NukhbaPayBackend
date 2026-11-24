import type {CatalogRefreshSchedule} from './refresh-schedule.js';

export type RefreshJobState='CLAIMED'|'SUCCEEDED'|'RETRY_WAIT'|'FAILED'|'UNCERTAIN';
export type RefreshFailure='NONE'|'PROVIDER_READ_UNAVAILABLE'|'CANCELLED_OR_TIMED_OUT'|'OUTCOME_UNCERTAIN'|'LEASE_EXPIRED';
export interface RefreshClaim {
  readonly tenantId:string;readonly scheduleId:string;readonly version:string;readonly slotAtMs:number;
  readonly token:string;readonly attempt:number;readonly leaseUntilMs:number;
}
export interface RefreshSettlement {
  readonly state:Exclude<RefreshJobState,'CLAIMED'>;readonly reason:RefreshFailure;readonly nextAttemptAtMs:number|null;
}
/** Explicit backend composition only; implementations must atomically persist
 * claims, fenced settlements and audit transitions. No provider or IAM authority. */
export interface DurableRefreshStore {
  find(id:string):Promise<CatalogRefreshSchedule|null>;
  claim(nowMs:number,leaseMs:number):Promise<RefreshClaim|null>;
  settle(claim:RefreshClaim,result:RefreshSettlement,nowMs:number):Promise<void>;
  expire(nowMs:number):Promise<void>;
  /** Durable adapters decide these fences using their storage clock. */
  checkLease?(claim: RefreshClaim): Promise<boolean>;
  renew?(claim: RefreshClaim, leaseMs: number): Promise<RefreshClaim>;
  close():Promise<void>;
}
/** Daily UTC schedule; timezone conversion is an owner configuration decision. */
export function dailyRefreshSchedule(input:Omit<CatalogRefreshSchedule,'firstRunAtMs'|'intervalMs'>,utcMinute:number,fromMs:number):CatalogRefreshSchedule {
  if(!Number.isSafeInteger(utcMinute)||utcMinute<0||utcMinute>=1440||!Number.isSafeInteger(fromMs)||fromMs<0)throw new Error('Invalid daily refresh schedule');
  const day=Math.floor(fromMs/86400000)*86400000;
  return Object.freeze({...input,firstRunAtMs:day+utcMinute*60000,intervalMs:86400000});
}


export function validRefreshSettlement(result: RefreshSettlement, attempt: number): boolean {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 3) return false;
  switch (result.state) {
    case 'SUCCEEDED': return result.reason === 'NONE' && result.nextAttemptAtMs === null;
    case 'RETRY_WAIT': return attempt < 3 && result.reason === 'PROVIDER_READ_UNAVAILABLE' &&
      Number.isSafeInteger(result.nextAttemptAtMs) && result.nextAttemptAtMs! >= 0;
    case 'FAILED': return attempt === 3 && result.reason === 'PROVIDER_READ_UNAVAILABLE' &&
      result.nextAttemptAtMs === null;
    case 'UNCERTAIN': return ['CANCELLED_OR_TIMED_OUT', 'OUTCOME_UNCERTAIN'].includes(result.reason) &&
      result.nextAttemptAtMs === null;
    default: return false;
  }
}
