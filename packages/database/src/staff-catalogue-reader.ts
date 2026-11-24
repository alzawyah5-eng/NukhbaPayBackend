import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  administrationUuid, consumeStaffCatalogueRead, type ConfiguredAvailability,
  type StaffCatalogueReadTicket, type StaffCatalogueSnapshot,
} from '@nukhbapay/application';

type Snapshot = Omit<StaffCatalogueSnapshot, 'revision'>;
const limit = 1001;

function minor(value: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)) {
    throw new Error('Invalid stored catalogue amount');
  }
  return BigInt(value);
}

/** Uses an explicitly supplied read-only workload pool. Pending publication tables
 * are read only for their respective pricing views. No setup or connection here. */
export function createStaffCatalogueReader(
  pool: Pool,
  availabilityByTenant: ReadonlyMap<string, readonly ConfiguredAvailability[]>,
) {
  const configuration = new Map([...availabilityByTenant].map(([tenant, rows]) =>
    [tenant, Object.freeze(rows.map(row => Object.freeze({ ...row })))] as const));

  return async (ticket: StaffCatalogueReadTicket): Promise<StaffCatalogueSnapshot> => {
    consumeStaffCatalogueRead(ticket);
    const tenant = ticket.tenantId;
    if (!administrationUuid.test(tenant) || !configuration.has(tenant) || !await ticket.revalidate()) {
      throw new Error('Catalogue read denied');
    }
    const client = await pool.connect().catch(() => { throw new Error('Catalogue reader unavailable'); });
    let discard = false;
    let committing = false;
    let committed = false;
    const scope = [tenant, limit];
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query(`SELECT set_config('nukhabapay.tenant_id',$1,true),
        set_config('nukhabapay.publication_tenant_id',$1,true)`, [tenant]);
      const accounts = await client.query<{ provider_code: string }>(`
        SELECT DISTINCT provider_code FROM nukhabapay.provider_accounts
        WHERE tenant_id=$1 AND status='ACTIVE' ORDER BY provider_code LIMIT $2`, scope);
      if (accounts.rows.length >= limit) throw new Error('Catalogue snapshot exceeds limit');
      const active = new Set(accounts.rows.map(row => row.provider_code));
      const availability = configuration.get(tenant)!.map(row => ({
        ...row, enabled: row.enabled && active.has(row.providerId),
      }));
      const core = ['products', 'offers', 'economics', 'drafts', 'publications'].includes(ticket.view);
      const products: Snapshot['products'] = core ? (await client.query<{
        id: string; name: string; country: string; service: string;
      }>(`SELECT p.id,p.canonical_product_key AS name,p.redemption_country AS country,p.fulfillment_method AS service
        FROM nukhabapay.products p WHERE EXISTS (
          SELECT 1 FROM nukhabapay.product_mappings m
          WHERE m.tenant_id=$1 AND m.product_id=p.id AND m.status='APPROVED'
        ) ORDER BY p.id LIMIT $2`, scope)).rows : [];
      let offers: Snapshot['offers'] = [];
      if (ticket.view === 'products' || ticket.view === 'offers') {
        const pricing = ticket.view === 'offers';
        const cost = pricing
          ? ',(o.provider_debit_minor+COALESCE(o.additional_provider_fee_minor,0))::text AS cost,s.observed_at,s.completed_at'
          : '';
        const result = await client.query<{
          id: string; product_id: string; provider_code: string; available: boolean; valid_until: Date; cost?: string; observed_at?: Date; completed_at?: Date;
        }>(`SELECT o.id,o.product_id,a.provider_code,o.available,o.valid_until${cost}
          FROM nukhabapay.provider_offers o
          JOIN nukhabapay.provider_accounts a ON a.tenant_id=o.tenant_id AND a.id=o.provider_account_id
          JOIN nukhabapay.provider_snapshots s ON s.tenant_id=o.tenant_id
            AND s.provider_account_id=o.provider_account_id AND s.id=o.provider_snapshot_id
          JOIN nukhabapay.product_mappings m ON m.tenant_id=o.tenant_id
            AND m.provider_account_id=o.provider_account_id AND m.id=o.product_mapping_id
          WHERE o.tenant_id=$1 AND a.status='ACTIVE' AND m.status='APPROVED' AND s.status='COMPLETE'
            AND NOT EXISTS (
              SELECT 1 FROM nukhabapay.provider_snapshots newer
              WHERE newer.tenant_id=s.tenant_id AND newer.provider_account_id=s.provider_account_id
                AND newer.status='COMPLETE'
                AND (newer.observed_at,newer.completed_at,newer.id)>(s.observed_at,s.completed_at,s.id)
            )
          ORDER BY o.id LIMIT $2`, scope);
        offers = result.rows.map(row => ({
          id: row.id, productId: row.product_id, providerId: row.provider_code,
          available: row.available, validUntil: row.valid_until.toISOString(),
          ...(pricing && { providerCostMinor: minor(row.cost!),
            sourceObservedAt: row.observed_at!.toISOString(), sourceCompletedAt: row.completed_at!.toISOString() }),
        }));
      }
      const imports: Snapshot['imports'] = ticket.view === 'imports' ? (await client.query<{
        id: string; provider_code: string; status: Snapshot['imports'][number]['status']; observed_at: Date;
      }>(`SELECT s.id,a.provider_code,s.status,s.observed_at FROM nukhabapay.provider_snapshots s
        JOIN nukhabapay.provider_accounts a ON a.tenant_id=s.tenant_id AND a.id=s.provider_account_id
        WHERE s.tenant_id=$1 ORDER BY s.id LIMIT $2`, scope)).rows.map(row => ({
        id: row.id, providerId: row.provider_code, status: row.status, observedAt: row.observed_at.toISOString(),
      })) : [];
      const drafts: Snapshot['drafts'] = ticket.view === 'drafts' ? (await client.query<{
        id: string; product_id: string; version: string; status: Snapshot['drafts'][number]['status'];
      }>(`SELECT c.candidate_id AS id,c.product_id,c.price_version::text AS version,
          CASE WHEN EXISTS (SELECT 1 FROM nukhabapay.price_workflow_versions v
            WHERE v.tenant_id=c.tenant_id AND v.product_id=c.product_id AND v.candidate_id=c.candidate_id) THEN 'PUBLISHED'
          WHEN EXISTS (SELECT 1 FROM nukhabapay.price_workflow_approvals a
            WHERE a.tenant_id=c.tenant_id AND a.product_id=c.product_id AND a.candidate_id=c.candidate_id) THEN 'APPROVED'
          WHEN EXISTS (SELECT 1 FROM nukhabapay.price_submission_evidence e
            WHERE e.tenant_id=c.tenant_id AND e.product_id=c.product_id AND e.candidate_id=c.candidate_id) THEN 'SUBMITTED'
          ELSE 'DRAFT' END AS status
        FROM nukhabapay.catalogue_publication_candidates c WHERE c.tenant_id=$1
        ORDER BY c.candidate_id LIMIT $2`, scope)).rows.map(row => ({
        id: row.id, productId: row.product_id, version: Number(row.version), status: row.status,
      })) : [];
      const storedEconomics: NonNullable<Snapshot['storedEconomics']> = ticket.view === 'economics'
        ? (await client.query<{
          product_id: string; candidate_id: string; selected_provider_id: string; total: string;
          cost: string; service: string; payment: string; commission: string; margin: string;
        }>(`SELECT DISTINCT ON (product_id) product_id,candidate_id,selected_provider_id,
          total_amount_minor::text AS total,provider_cost_minor::text AS cost,service_fee_minor::text AS service,
          payment_fee_minor::text AS payment,agent_commission_minor::text AS commission,
          expected_contribution_minor::text AS margin
          FROM nukhabapay.catalogue_publication_candidates WHERE tenant_id=$1
          ORDER BY product_id,price_version DESC LIMIT $2`, scope)).rows.map(row => ({
          productId: row.product_id, candidateId: row.candidate_id, selectedProviderId: row.selected_provider_id,
          totalAmountMinor: minor(row.total), providerCostMinor: minor(row.cost), serviceFeeMinor: minor(row.service),
          paymentFeeMinor: minor(row.payment), agentCommissionMinor: minor(row.commission),
          expectedContributionMinor: minor(row.margin),
        })) : [];

      const publications: NonNullable<Snapshot['publications']> = ticket.view === 'publications' ? (await client.query<{
        id: string; product_id: string; revision: string; kind: 'ACTIVATE'|'ROLLBACK'; occurred_at: Date;
      }>(`SELECT v.operation_id AS id,v.product_id,v.revision::text,v.kind,a.occurred_at
        FROM nukhabapay.price_workflow_versions v JOIN nukhabapay.price_workflow_audit a
          ON (a.operation_id,a.tenant_id,a.product_id,a.action)=(v.operation_id,v.tenant_id,v.product_id,v.kind)
        WHERE v.tenant_id=$1 ORDER BY v.revision DESC,v.operation_id LIMIT $2`,scope)).rows.map(row => ({
        id:row.id,productId:row.product_id,revision:row.revision,action:row.kind,occurredAt:row.occurred_at.toISOString(),
      })) : [];

      const data: Snapshot = { tenantId: tenant, availability, products, offers, imports,
        drafts, publications, storedEconomics, proposals: [] };
      const revision = createHash('sha256')
        .update(JSON.stringify(data, (_, value: unknown) => typeof value === 'bigint' ? value.toString() : value))
        .digest('hex');
      if (!await ticket.revalidate()) throw new Error('Catalogue read denied');
      committing = true;
      if ((await client.query('COMMIT')).command!=='COMMIT') throw new Error('Catalogue read incomplete');
      committed = true;
      if (!await ticket.revalidate()) throw new Error('Catalogue read denied');
      return { ...data, revision };
    } catch {
      discard = committing && !committed;
      if (!committed) {
        try { await client.query('ROLLBACK'); } catch { discard = true; }
      }
      throw new Error('Catalogue reader unavailable');
    } finally {
      client.release(discard);
    }
  };
}
