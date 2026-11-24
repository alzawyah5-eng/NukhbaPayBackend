import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export interface PublicationDelivery {
  readonly eventId: string;
  readonly tenantId: string;
  readonly productId: string;
  readonly revision: string;
  readonly kind: 'ACTIVATE' | 'ROLLBACK';
}

export interface IdempotentPublicationRecipient {
  /** Deduplicate by tenant and event ID, including after acknowledgement loss. */
  deliver(event: PublicationDelivery, signal: AbortSignal): Promise<string>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const receiptPattern = /^[A-Za-z0-9_.:-]{1,128}$/;

async function scoped<T>(pool: Pool, tenantId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let committing = false;
  let discard = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query("SET LOCAL statement_timeout='4s'");
    await client.query("SET LOCAL lock_timeout='1s'");
    await client.query("SELECT set_config('nukhabapay.publication_tenant_id',$1,true)",[tenantId]);
    const result = await work(client);
    committing = true;
    if ((await client.query('COMMIT')).command !== 'COMMIT') throw new Error('Unconfirmed publication transaction');
    return result;
  } catch {
    discard = committing;
    try { await client.query('ROLLBACK'); } catch { discard = true; }
    throw new Error('Publication delivery persistence unavailable');
  } finally { client.release(discard); }
}

/** Explicit backend composition; the recipient only receives version IDs and metadata. */
export function createPublicationDeliveryWorker(pool: Pool, tenantIds: readonly string[], recipient: IdempotentPublicationRecipient) {
  const tenants = new Set(tenantIds);
  if (!tenants.size || tenants.size > 100 || tenantIds.some(id=>!uuid.test(id)) || tenants.size!==tenantIds.length)
    throw new Error('Invalid publication delivery scope');

  return Object.freeze({
    async deliverNext(tenantId: string, signal: AbortSignal, leaseMs = 10_000) {
      if (!tenants.has(tenantId) || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 60_000)
        throw new Error('Invalid publication delivery scope');
      if (signal.aborted) return 'CANCELLED' as const;
      const lease = randomUUID();
      const claimed = await scoped(pool,tenantId,async client=>{
        await client.query(`WITH exhausted AS (
          SELECT event_id FROM nukhabapay.publication_delivery_state WHERE tenant_id=$1 AND status='CLAIMED'
            AND lease_until<=clock_timestamp() AND attempts=4 ORDER BY lease_until LIMIT 100 FOR UPDATE SKIP LOCKED
          ) UPDATE nukhabapay.publication_delivery_state s SET status='FAILED',lease_token=NULL,lease_until=NULL
          FROM exhausted x WHERE s.tenant_id=$1 AND s.event_id=x.event_id`,[tenantId]);
        const row = (await client.query(`WITH eligible AS (
          SELECT e.event_id,e.product_id,e.revision,e.kind FROM nukhabapay.publication_delivery_outbox e
          JOIN nukhabapay.publication_delivery_state s USING (tenant_id,event_id)
          WHERE e.tenant_id=$1 AND s.attempts<4 AND (s.status='PENDING' OR
            (s.status='RETRY_WAIT' AND s.retry_at<=clock_timestamp()) OR (s.status='CLAIMED' AND s.lease_until<=clock_timestamp()))
          AND NOT EXISTS (SELECT 1 FROM nukhabapay.publication_delivery_outbox earlier
            JOIN nukhabapay.publication_delivery_state prior USING (tenant_id,event_id)
            WHERE earlier.tenant_id=e.tenant_id AND earlier.product_id=e.product_id AND earlier.revision<e.revision
              AND prior.status<>'ACKNOWLEDGED')
          ORDER BY e.created_at,e.event_id LIMIT 1 FOR UPDATE OF s SKIP LOCKED
          ) UPDATE nukhabapay.publication_delivery_state s SET status='CLAIMED',lease_token=$2,
            lease_until=clock_timestamp()+make_interval(secs=>$3::double precision/1000),retry_at=NULL,attempts=s.attempts+1
          FROM eligible e WHERE s.tenant_id=$1 AND s.event_id=e.event_id
          RETURNING e.event_id,e.product_id,e.revision::text,e.kind,s.attempts`,[tenantId,lease,leaseMs])).rows[0];
        return row;
      });
      if (!claimed) return 'EMPTY' as const;
      if (signal.aborted) return 'CANCELLED' as const;
      const event = Object.freeze({eventId:claimed.event_id as string,tenantId,productId:claimed.product_id as string,
        revision:claimed.revision as string,kind:claimed.kind as PublicationDelivery['kind']});
      const bounds = AbortSignal.any([signal,AbortSignal.timeout(leaseMs)]);
      let receipt: string | null = null;
      try {
        const received = await recipient.deliver(event,bounds);
        if (typeof received==='string' && receiptPattern.test(received)) receipt=received;
      } catch { /* The durable event ID is reused after an uncertain network result. */ }
      if (bounds.aborted) return 'CANCELLED' as const;
      const settled = await scoped(pool,tenantId,async client=>{
        const status = receipt ? 'ACKNOWLEDGED' : claimed.attempts===4 ? 'FAILED' : 'RETRY_WAIT';
        const updated = await client.query(`UPDATE nukhabapay.publication_delivery_state
          SET status=$4,lease_until=NULL,lease_token=NULL,ack_receipt=$5,
            retry_at=CASE WHEN $4='RETRY_WAIT' THEN clock_timestamp()+make_interval(secs=>power(2,attempts-1)) ELSE NULL END
          WHERE tenant_id=$1 AND event_id=$2 AND lease_token=$3 AND status='CLAIMED' AND lease_until>clock_timestamp()`,
        [tenantId,event.eventId,lease,status,receipt]);
        return updated.rowCount===1 ? status : 'STALE';
      });
      return settled;
    },
  });
}

/** Recovery uses an independently scoped role and an authoritative recipient
 * lookup. A missing receipt leaves the failed event available for investigation. */
export function createPublicationDeliveryRecovery(pool: Pool, tenantId: string,
  lookupReceipt: (tenantId: string, eventId: string) => Promise<string | null>) {
  if (!uuid.test(tenantId)) throw new Error('Invalid publication recovery scope');
  return async (eventId: string) => {
    if (!uuid.test(eventId)) throw new Error('Invalid publication recovery scope');
    const receipt = await lookupReceipt(tenantId,eventId);
    if (!receipt || !receiptPattern.test(receipt)) return 'UNRESOLVED' as const;
    return scoped(pool,tenantId,async client=>{
      const row = (await client.query(`SELECT status,ack_receipt FROM nukhabapay.publication_delivery_state
        WHERE tenant_id=$1 AND event_id=$2 FOR UPDATE`,[tenantId,eventId])).rows[0];
      if (row?.status==='ACKNOWLEDGED' && row.ack_receipt===receipt) return 'ACKNOWLEDGED' as const;
      if (row?.status!=='FAILED') return 'UNRESOLVED' as const;
      await client.query(`INSERT INTO nukhabapay.publication_delivery_recovery(event_id,tenant_id,verified_receipt)
        VALUES($1,$2,$3)`,[eventId,tenantId,receipt]);
      const updated = await client.query(`UPDATE nukhabapay.publication_delivery_state SET status='ACKNOWLEDGED',ack_receipt=$3
        WHERE tenant_id=$1 AND event_id=$2 AND status='FAILED'`,[tenantId,eventId,receipt]);
      if (updated.rowCount!==1) throw new Error('Publication recovery conflict');
      return 'ACKNOWLEDGED' as const;
    });
  };
}
