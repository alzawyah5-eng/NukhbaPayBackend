import type { Pool } from 'pg';
import { canonicalDigest, type RefreshClaim } from '@nukhbapay/application';
import { matchesCatalogueWriteWitness, type CatalogueWriteTarget, type CatalogueWriteWitness } from './catalogue-refresh-write-fence.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const outcomes = ['COMMITTED','ROLLED_BACK','QUARANTINED'] as const;

type ReconciliationOutcome = typeof outcomes[number];
function observationFields(claim:RefreshClaim,target:CatalogueWriteTarget,transactionId:string|null,outcome:ReconciliationOutcome) {
  return [claim.tenantId,claim.scheduleId,claim.version,claim.slotAtMs,claim.token,target.purpose,target.resourceKey,transactionId,outcome];
}

/** Uses a separate restricted reader/audit pool. Settling or retrying a job is
 * outside this evidence reader's authority. */
export function createCatalogueRefreshReconciler(pool: Pool, tenantIds: readonly string[]) {
  const tenants = new Set(tenantIds);
  if (!tenants.size || tenants.size!==tenantIds.length || tenantIds.length>100 || tenantIds.some(id=>!uuid.test(id)))
    throw new Error('Invalid reconciliation scope');
  return async (claim: RefreshClaim, target: CatalogueWriteTarget, witness?: CatalogueWriteWitness) => {
    if (!tenants.has(claim.tenantId) || target.tenantId!==claim.tenantId ||
        ![claim.scheduleId,claim.token,target.providerAccountId].every(id=>uuid.test(id)) ||
        !['IMPORT','DRAFT'].includes(target.purpose) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(target.resourceKey) ||
        (witness!==undefined && !matchesCatalogueWriteWitness(witness,claim,target)))
      throw new Error('Invalid reconciliation scope');
    const xid=witness?.transactionId;
    const client = await pool.connect();
    let committing = false;
    let discard = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL statement_timeout='3s'");
      await client.query("SELECT set_config('nukhabapay.refresh_tenant_id',$1,true)",[claim.tenantId]);
      if (!(await client.query(`SELECT pg_try_advisory_xact_lock(hashtextextended($1::uuid::text||':'||$2::uuid::text,12012)) AS locked`,
        [claim.tenantId,claim.scheduleId])).rows[0]?.locked) {
        await client.query('ROLLBACK');
        return { outcome:'IN_PROGRESS' as const, transactionId:null };
      }
      const matches = await client.query<{ transaction_id:string }>(`SELECT transaction_id FROM nukhabapay.catalogue_refresh_write_evidence
        WHERE tenant_id=$1 AND schedule_id=$2 AND version=$3 AND slot_at_ms=$4 AND token=$5 AND attempt=$6
          AND provider_account_id=$7 AND purpose=$8 AND resource_key=$9 AND ($10::bigint IS NULL OR transaction_id=$10)
        ORDER BY transaction_id DESC LIMIT 1`, [claim.tenantId,claim.scheduleId,claim.version,claim.slotAtMs,claim.token,claim.attempt,
        target.providerAccountId,target.purpose,target.resourceKey,xid??null]);
      const record = matches.rows[0];
      const transactionId = record?.transaction_id ?? xid ?? null;
      let outcome: typeof outcomes[number] = 'QUARANTINED';
      if (record) outcome = 'COMMITTED';
      else if (xid) {
        const pgStatus = (await client.query<{ status:string|null }>('SELECT pg_xact_status($1::xid8) AS status',[xid])).rows[0]?.status;
        // An absent committed row could be an unrelated transaction or a stale
        // receipt. A caller can never use it as successful write evidence.
        if (pgStatus==='aborted') outcome='ROLLED_BACK';
      }
      const fields = observationFields(claim,target,transactionId,outcome);
      await client.query(`INSERT INTO nukhabapay.catalogue_refresh_reconciliation(observation_id,tenant_id,schedule_id,version,slot_at_ms,
        token,purpose,resource_key,transaction_id,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [canonicalDigest(fields),...fields]);
      committing = true;
      if ((await client.query('COMMIT')).command!=='COMMIT') throw new Error('Reconciliation commit unresolved');
      return { outcome, transactionId };
    } catch {
      discard = committing;
      try { await client.query('ROLLBACK'); } catch { discard = true; }
      throw new Error('Refresh reconciliation unavailable');
    } finally { client.release(discard); }
  };
}

/** Explicit operator workload. The decision only unblocks a future slot, and
 * cannot replay this slot, change its result, or assert that a run succeeded. */
export function createRefreshQuarantineDisposition(pool: Pool, tenantId: string) {
  if (!uuid.test(tenantId)) throw new Error('Invalid disposition scope');
  return async (claim: RefreshClaim, target: CatalogueWriteTarget, evidence: {
    readonly transactionId: string | null; readonly outcome: ReconciliationOutcome;
  }): Promise<'RECORDED'|'REPLAYED'|'CONFLICT'> => {
    if (claim.tenantId!==tenantId || target.tenantId!==tenantId || !outcomes.includes(evidence.outcome))
      throw new Error('Invalid disposition scope');
    const observationId=canonicalDigest(observationFields(claim,target,evidence.transactionId,evidence.outcome));
    const client=await pool.connect();
    let committing=false,discard=false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL statement_timeout='3s'");
      await client.query("SELECT set_config('nukhabapay.refresh_tenant_id',$1,true)",[tenantId]);
      if (!(await client.query(`SELECT pg_try_advisory_xact_lock(hashtextextended($1::uuid::text||':'||$2::uuid::text,12012)) AS locked`,
        [tenantId,claim.scheduleId])).rows[0]?.locked) throw new Error('Quarantine operation busy');
      const keys=[tenantId,claim.scheduleId,claim.version,claim.slotAtMs];
      const prior=(await client.query(`SELECT observation_id,token,attempt FROM nukhabapay.catalogue_refresh_dispositions
        WHERE tenant_id=$1 AND schedule_id=$2 AND version=$3 AND slot_at_ms=$4`,keys)).rows[0];
      if (prior) {
        await client.query('ROLLBACK');
        return prior.observation_id===observationId && prior.token===claim.token && prior.attempt===claim.attempt ? 'REPLAYED' : 'CONFLICT';
      }
      await client.query(`INSERT INTO nukhabapay.catalogue_refresh_dispositions
        (tenant_id,schedule_id,version,slot_at_ms,token,attempt,observation_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [...keys,claim.token,claim.attempt,observationId]);
      committing=true;
      if ((await client.query('COMMIT')).command!=='COMMIT') throw new Error('Unconfirmed disposition');
      return 'RECORDED';
    } catch {
      discard=committing;
      try {await client.query('ROLLBACK');} catch {discard=true;}
      throw new Error('Refresh disposition unavailable');
    } finally {client.release(discard);}
  };
}
