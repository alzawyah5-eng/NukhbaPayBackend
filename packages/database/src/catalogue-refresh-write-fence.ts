import type { PoolClient } from 'pg';
import type { RefreshClaim } from '@nukhbapay/application';

/** Serialize snapshot completion and draft selection for this tenant/provider account. */
export async function lockCatalogueAccount(client: PoolClient, tenantId: string, accountId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text||':'||$2::uuid::text,12013))",
    [tenantId, accountId]);
}

export interface CatalogueWriteTarget {
  readonly tenantId: string;
  readonly providerAccountId: string;
  readonly purpose: 'IMPORT' | 'DRAFT';
  readonly resourceKey: string;
}

export interface CatalogueWriteWitness { readonly transactionId: string }
const witnesses = new WeakMap<CatalogueWriteWitness, Readonly<{claim:RefreshClaim;target:CatalogueWriteTarget}>>();

export function matchesCatalogueWriteWitness(witness: CatalogueWriteWitness, claim: RefreshClaim, target: CatalogueWriteTarget): boolean {
  const binding=witnesses.get(witness);
  return Boolean(binding && binding.claim.tenantId===claim.tenantId && binding.claim.scheduleId===claim.scheduleId &&
    binding.claim.version===claim.version && binding.claim.slotAtMs===claim.slotAtMs &&
    binding.claim.token===claim.token && binding.claim.attempt===claim.attempt && binding.target.tenantId===target.tenantId &&
    binding.target.providerAccountId===target.providerAccountId && binding.target.purpose===target.purpose && binding.target.resourceKey===target.resourceKey);
}

/** Called on the existing write client's open READ COMMITTED transaction before work.
 * The proposal checks the lease again as a deferred constraint before commit. */
export async function armCatalogueRefreshWrite(
  client: PoolClient,
  claim: RefreshClaim,
  target: CatalogueWriteTarget,
): Promise<CatalogueWriteWitness> {
  if (claim.tenantId !== target.tenantId) throw new Error('Refresh write tenant mismatch');
  await client.query("SELECT set_config('nukhabapay.refresh_tenant_id',$1,true)", [target.tenantId]);
  const {rows:[transaction]} = await client.query<{ xid:string }>('SELECT pg_current_xact_id()::text AS xid');
  if (!transaction) throw new Error('Refresh transaction unavailable');
  await client.query(`INSERT INTO nukhabapay.catalogue_refresh_write_evidence(
    tenant_id,schedule_id,provider_account_id,version,slot_at_ms,token,attempt,purpose,resource_key
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  [target.tenantId,claim.scheduleId,target.providerAccountId,claim.version,claim.slotAtMs,
    claim.token,claim.attempt,target.purpose,target.resourceKey]);
  const witness=Object.freeze({transactionId:transaction.xid});
  witnesses.set(witness,Object.freeze({claim:Object.freeze({...claim}),target:Object.freeze({...target})}));
  return witness;
}
