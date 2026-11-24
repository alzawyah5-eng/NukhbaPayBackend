import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  validRefreshSettlement, type CatalogRefreshSchedule, type DurableRefreshStore,
  type RefreshClaim, type RefreshSettlement,
} from '@nukhbapay/application';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const version = /^[A-Za-z0-9_.:-]{1,128}$/;
const clock = 'floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint';
const scheduleJoin = `FROM nukhabapay.catalogue_refresh_schedules s
  JOIN nukhabapay.provider_accounts a ON a.tenant_id=s.tenant_id AND a.id=s.provider_account_id`;
const claimKey = 'tenant_id=$1 AND schedule_id=$2 AND version=$3 AND slot_at_ms=$4 AND token=$5 AND attempt=$6';
const unresolved = `j.state='UNCERTAIN' AND NOT EXISTS(
  SELECT 1 FROM nukhabapay.catalogue_refresh_dispositions d
  WHERE (d.tenant_id,d.schedule_id,d.version,d.slot_at_ms,d.token,d.attempt)=
    (j.tenant_id,j.schedule_id,j.version,j.slot_at_ms,j.token,j.attempt))`;

function millis(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) {
    throw new Error('Invalid refresh timestamp');
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid refresh timestamp');
  return n;
}

function duration(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1010 || leaseMs > 300000) throw new Error('Invalid refresh lease');
}

function claimParameters(claim: RefreshClaim): [string, string, string, number, string, number] {
  if (![claim.tenantId, claim.scheduleId, claim.token].every(id => uuid.test(id)) ||
      !version.test(claim.version) || !Number.isSafeInteger(claim.attempt) || claim.attempt < 1 || claim.attempt > 3) {
    throw new Error('Invalid refresh claim');
  }
  return [claim.tenantId, claim.scheduleId, claim.version, millis(claim.slotAtMs), claim.token, claim.attempt];
}

function claimFrom(row: Record<string, unknown>, tenant: string): RefreshClaim {
  const result = Object.freeze({
    tenantId: String(row['tenant_id']), scheduleId: String(row['schedule_id']), version: String(row['version']),
    slotAtMs: millis(row['slot_at_ms']), token: String(row['token']), attempt: Number(row['attempt']),
    leaseUntilMs: millis(row['lease_until_ms']),
  });
  claimParameters(result);
  if (result.tenantId !== tenant) throw new Error('Invalid refresh tenant');
  return result;
}

/** Requires the unregistered 012 R2 schema and an explicitly scoped pool. */
export function createCatalogueRefreshStore(pool: Pool, tenantIds: readonly string[], ownsPool = false): DurableRefreshStore {
  return refreshStore(pool,tenantIds,ownsPool,false);
}

/** Explicit composition for the additive quarantine disposition schema. */
export function createReconciledCatalogueRefreshStore(pool: Pool, tenantIds: readonly string[], ownsPool = false): DurableRefreshStore {
  return refreshStore(pool,tenantIds,ownsPool,true);
}

function refreshStore(pool: Pool, tenantIds: readonly string[], ownsPool: boolean, dispositions: boolean): DurableRefreshStore {
  const pending = `SELECT 1 FROM nukhabapay.catalogue_refresh_jobs j WHERE j.tenant_id=s.tenant_id AND j.schedule_id=s.id
    AND (j.state='CLAIMED' OR (${dispositions ? unresolved : "j.state='UNCERTAIN'"}) OR
      (j.version=s.version AND j.state='RETRY_WAIT' AND j.next_attempt_at_ms>t.now_ms))`;
  if (!tenantIds.length || tenantIds.length > 100 || tenantIds.some(id => !uuid.test(id)) ||
      new Set(tenantIds).size !== tenantIds.length) throw new Error('Invalid refresh tenant configuration');
  const tenants = Object.freeze([...tenantIds].sort());
  let closed = false;
  async function tx<T>(tenant: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    if (closed || !tenants.includes(tenant)) throw new Error('Refresh store unavailable');
    const client = await pool.connect().catch(() => { throw new Error('Refresh store unavailable'); });
    let discard = false, committing = false;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('nukhabapay.refresh_tenant_id',$1,true)", [tenant]);
      await client.query("SET LOCAL statement_timeout='3s'");
      await client.query("SET LOCAL lock_timeout='1s'");
      const result = await work(client);
      committing = true;
      await client.query('COMMIT');
      return result;
    } catch {
      discard = committing;
      try { await client.query('ROLLBACK'); } catch { discard = true; }
      throw new Error('Refresh transaction unresolved; reconcile before retry');
    } finally {
      client.release(discard);
    }
  }

  return Object.freeze({
    async find(id: string): Promise<CatalogRefreshSchedule | null> {
      if (!uuid.test(id)) throw new Error('Invalid refresh schedule');
      for (const tenant of tenants) {
        const row = await tx(tenant, async client => (await client.query(`SELECT s.*,a.provider_code
          ${scheduleJoin} WHERE s.tenant_id=$1 AND s.id=$2 AND a.status='ACTIVE'`, [tenant, id])).rows[0]);
        if (!row) continue;
        if (row.tenant_id !== tenant || row.id !== id) throw new Error('Invalid refresh schedule binding');
        return Object.freeze({ id, tenantId: tenant, providerAccountId: row.provider_account_id,
          providerId: row.provider_code, sourceVersion: row.source_version, version: row.version,
          enabled: row.enabled, firstRunAtMs: millis(row.first_run_at_ms), intervalMs: millis(row.interval_ms) });
      }
      return null;
    },

    async claim(_localNowMs: number, leaseMs: number): Promise<RefreshClaim | null> {
      duration(leaseMs);
      for (const tenant of tenants) {
        const claimed = await tx(tenant, async client => {
          const selected = (await client.query(`WITH t AS MATERIALIZED (SELECT ${clock} AS now_ms)
            SELECT s.id ${scheduleJoin} CROSS JOIN t
            WHERE s.tenant_id=$1 AND s.enabled AND a.status='ACTIVE' AND s.first_run_at_ms<=t.now_ms
              AND NOT EXISTS (${pending})
              AND NOT EXISTS (SELECT 1 FROM nukhabapay.catalogue_refresh_jobs j
                WHERE j.tenant_id=s.tenant_id AND j.schedule_id=s.id AND j.version=s.version
                  AND j.slot_at_ms=s.first_run_at_ms+((t.now_ms-s.first_run_at_ms)/s.interval_ms)*s.interval_ms
                  AND j.state<>'RETRY_WAIT')
            ORDER BY s.id LIMIT 1`, [tenant])).rows[0];
          if (!selected) return null;
          // Lock the tenant/schedule namespace without UPDATE rights on the registry.
          const locked = (await client.query(`SELECT pg_try_advisory_xact_lock(
            hashtextextended($1::uuid::text||':'||$2::uuid::text,12012)) AS locked`,
          [tenant, selected.id])).rows[0]?.locked;
          if (locked !== true) return null;
          // Re-read after lock acquisition using a new statement snapshot.
          const schedule = (await client.query(`WITH t AS MATERIALIZED (SELECT ${clock} AS now_ms)
            SELECT s.version,s.first_run_at_ms+((t.now_ms-s.first_run_at_ms)/s.interval_ms)*s.interval_ms AS slot
            ${scheduleJoin} CROSS JOIN t WHERE s.tenant_id=$1 AND s.id=$2 AND s.enabled AND a.status='ACTIVE'
            AND s.first_run_at_ms<=t.now_ms AND NOT EXISTS (${pending})`, [tenant, selected.id])).rows[0];
          if (!schedule) return null;
          const retry = (await client.query(`SELECT slot_at_ms FROM nukhabapay.catalogue_refresh_jobs
            WHERE tenant_id=$1 AND schedule_id=$2 AND version=$3 AND state='RETRY_WAIT'
              AND next_attempt_at_ms<=${clock}
            ORDER BY slot_at_ms LIMIT 1 FOR UPDATE`, [tenant, selected.id, schedule.version])).rows[0];
          const parameters = [tenant, selected.id, schedule.version, retry?.slot_at_ms ?? schedule.slot, randomUUID(), leaseMs];
          const result = retry
            ? await client.query(`UPDATE nukhabapay.catalogue_refresh_jobs
                SET token=$5,attempt=attempt+1,lease_duration_ms=$6,state='CLAIMED',reason='NONE'
                WHERE tenant_id=$1 AND schedule_id=$2 AND version=$3 AND slot_at_ms=$4
                  AND state='RETRY_WAIT' RETURNING *`, parameters)
            : await client.query(`INSERT INTO nukhabapay.catalogue_refresh_jobs
                (tenant_id,schedule_id,version,slot_at_ms,token,attempt,lease_duration_ms,lease_until_ms,state,reason,updated_at_ms)
                VALUES($1,$2,$3,$4,$5,1,$6,0,'CLAIMED','NONE',0) ON CONFLICT DO NOTHING RETURNING *`, parameters);
          return result.rows[0] ? claimFrom(result.rows[0], tenant) : null;
        });
        if (claimed) return claimed;
      }
      return null;
    },

    async checkLease(claim: RefreshClaim): Promise<boolean> {
      const parameters = claimParameters(claim);
      return tx(claim.tenantId, async client => (await client.query(`SELECT 1 FROM nukhabapay.catalogue_refresh_jobs
        WHERE ${claimKey} AND state='CLAIMED' AND lease_until_ms>${clock}
        AND EXISTS (SELECT 1 ${scheduleJoin} WHERE s.tenant_id=$1 AND s.id=$2 AND s.version=$3
          AND s.enabled AND a.status='ACTIVE')`, parameters)).rowCount === 1);
    },

    async renew(claim: RefreshClaim, leaseMs: number): Promise<RefreshClaim> {
      duration(leaseMs);
      const parameters = claimParameters(claim);
      return tx(claim.tenantId, async client => {
        const row = (await client.query(`UPDATE nukhabapay.catalogue_refresh_jobs SET lease_duration_ms=$7
          WHERE ${claimKey} AND state='CLAIMED' AND lease_until_ms>${clock} RETURNING *`,
        [...parameters, leaseMs])).rows[0];
        if (!row) throw new Error('Refresh claim fence lost');
        return claimFrom(row, claim.tenantId);
      });
    },

    async settle(claim: RefreshClaim, result: RefreshSettlement, _localNowMs: number): Promise<void> {
      const parameters = claimParameters(claim);
      if (!validRefreshSettlement(result, claim.attempt)) throw new Error('Invalid refresh settlement');
      await tx(claim.tenantId, async client => {
        const resultSet = await client.query(`UPDATE nukhabapay.catalogue_refresh_jobs
          SET state=$7,reason=$8 WHERE ${claimKey} AND state='CLAIMED' AND lease_until_ms>${clock}`,
        [...parameters, result.state, result.reason]);
        if (resultSet.rowCount !== 1) throw new Error('Refresh claim fence lost');
      });
    },

    async expire(_localNowMs: number): Promise<void> {
      for (const tenant of tenants) await tx(tenant, async client => {
        await client.query(`WITH stale AS (
          SELECT tenant_id,schedule_id,version,slot_at_ms FROM nukhabapay.catalogue_refresh_jobs
          WHERE tenant_id=$1 AND state='CLAIMED' AND lease_until_ms<=${clock}
          ORDER BY lease_until_ms,schedule_id,version,slot_at_ms LIMIT 100 FOR UPDATE SKIP LOCKED
        ) UPDATE nukhabapay.catalogue_refresh_jobs j SET state='UNCERTAIN',reason='LEASE_EXPIRED'
          FROM stale WHERE (j.tenant_id,j.schedule_id,j.version,j.slot_at_ms)
          =(stale.tenant_id,stale.schedule_id,stale.version,stale.slot_at_ms)`, [tenant]);
      });
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (ownsPool) await pool.end();
    },
  });
}
