import { Pool, type PoolClient } from 'pg';
import { administrationUuid, type ConfiguredAvailability, type FinxplorAcquisitionSummary, type FinxplorLayer1Price } from '@nukhbapay/application';
import { createStaffCatalogueReader } from './staff-catalogue-reader.js';
import { type AwsStagingTarget, verifyAwsStagingConnection } from './aws-staging-target.js';

type CatalogueStorageSettings = Readonly<{ setupId: string; databaseOid?: string; password: string }>;

/** Restricted read composition for the dedicated Windows development database. */
export async function createLocalCatalogueStorage(
  config: CatalogueStorageSettings,
  availability: ReadonlyMap<string, readonly ConfiguredAvailability[]>,
) {
  return openCatalogueStorage(config,availability);
}

export async function createAwsStagingCatalogueStorage(config:CatalogueStorageSettings, target:AwsStagingTarget) {
  return openCatalogueStorage(config,new Map(),target);
}

async function openCatalogueStorage(config:CatalogueStorageSettings,
  availability:ReadonlyMap<string,readonly ConfiguredAvailability[]>, staging?:AwsStagingTarget) {
  if ((!staging && process.platform !== 'win32') || !/^[a-f0-9]{32}$/.test(config.setupId) ||
      (config.databaseOid !== undefined && !/^[1-9][0-9]{0,9}$/.test(config.databaseOid)) ||
      !/^[a-f0-9]{64}$/.test(config.password)) throw new Error('Invalid local catalogue configuration');

  const pool = new Pool({ host: staging?.host ?? '127.0.0.1', port: 5432, database: 'nukhbapay_catalogue',
    user: 'nukhbapay_catalogue_reader', password: config.password, ssl: false, ...staging?.poolOptions,
    options: '-c search_path=pg_catalog -c default_transaction_read_only=on -c statement_timeout=8000',
    application_name: 'nukhbapay-local-catalogue-reader', max: 2, connectionTimeoutMillis: 5000 });
  pool.on('error', () => { /* The next checkout revalidates the database and role. */ });

  let databaseOid = config.databaseOid;
  async function connect(): Promise<PoolClient> {
    const client = await pool.connect();
    try {
      if (staging)await verifyAwsStagingConnection(client,'nukhbapay_catalogue','nukhbapay_catalogue_reader');
      const { rows: [result] } = await client.query<{ ready: boolean; oid: string }>(`SELECT db.oid::text AS oid,
        current_database()='nukhbapay_catalogue' AND ($1::text IS NULL OR db.oid::text=$1)
        AND shobj_description(db.oid,'pg_database')=$2 AND pg_get_userbyid(db.datdba)='nukhbapay_catalogue_migrator'
        AND ($3::boolean OR host(inet_server_addr())='127.0.0.1') AND inet_server_port()=5432
        AND current_user='nukhbapay_catalogue_reader' AND ($3::boolean OR system_user='scram-sha-256:nukhbapay_catalogue_reader')
        AND current_setting('default_transaction_read_only')='on'
        AND NOT (r.rolsuper OR r.rolinherit OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
        AND NOT EXISTS(SELECT FROM pg_auth_members m WHERE m.member=r.oid OR (m.roleid=r.oid AND NOT (
          $3::boolean AND coalesce(m.member=to_regrole('stagingadmin'),false)
          AND m.admin_option AND NOT m.set_option AND NOT m.inherit_option)))
        AND NOT EXISTS(SELECT FROM pg_database legacy
          WHERE legacy.datname='nukhbapay_staff' AND has_database_privilege(current_user,legacy.oid,'CONNECT'))
        AND (SELECT count(*)=14 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity
          AND pg_get_userbyid(c.relowner)='nukhbapay_catalogue_migrator'
          AND NOT has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
          AND NOT has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES'))
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nukhabapay'
          AND c.relname IN('tenants','products','provider_accounts','provider_snapshots','product_mappings','provider_offers',
            'catalogue_publication_candidates','price_submission_evidence','price_workflow_approvals',
            'price_workflow_versions','price_workflow_audit','catalogue_discoveries',
            'catalogue_discovery_scans','catalogue_discovery_scan_items')) AS ready
        FROM pg_database db JOIN pg_roles r ON r.rolname=current_user WHERE db.datname=current_database()`,
        [databaseOid ?? null, `nukhbapay-catalogue-${staging?'staging':'local'}:${config.setupId}`,Boolean(staging)]);
      if (result?.ready !== true) throw new Error('Unexpected local catalogue database or reader');
      databaseOid ??= result.oid;
      return client;
    } catch {
      client.release(true);
      throw new Error('Local catalogue storage unavailable');
    }
  }

  let closing: Promise<void> | undefined;
  const close = () => closing ??= pool.end();
  const checkReadiness = async () => {
    if (closing) return false;
    try {
      const client = await connect();
      try {
        await client.query('SELECT id FROM nukhabapay.products LIMIT 0');
        await client.query('SELECT id,source_id,review_reason FROM nukhabapay.catalogue_discoveries LIMIT 0');
        await client.query(`SELECT d.id,d.last_verified_at,m.status
          FROM nukhabapay.observed_catalogue_discoveries d
          LEFT JOIN nukhabapay.staff_discovery_mapping_status m
            ON (m.tenant_id,m.provider_account_id,m.discovery_id)=(d.tenant_id,d.provider_account_id,d.id)
          LIMIT 0`);
        await client.query(`SELECT c.total_amount_minor,e.candidate_id,a.candidate_id,v.revision,h.occurred_at
          FROM nukhabapay.catalogue_publication_candidates c
          JOIN nukhabapay.price_submission_evidence e USING(candidate_id,tenant_id,product_id)
          JOIN nukhabapay.price_workflow_approvals a USING(candidate_id,tenant_id,product_id)
          JOIN nukhabapay.price_workflow_versions v USING(candidate_id,tenant_id,product_id)
          JOIN nukhabapay.price_workflow_audit h ON h.operation_id=v.operation_id AND h.tenant_id=v.tenant_id LIMIT 0`);
      }
      finally { client.release(); }
      return !closing;
    } catch { return false; }
  };
  if (!await checkReadiness()) {
    await close();
    throw new Error('Local catalogue storage unavailable');
  }

  async function hasActiveProviderAccount(tenantId: string, accountId: string, providerCode: string): Promise<boolean> {
    if (closing || !administrationUuid.test(tenantId) || !administrationUuid.test(accountId) ||
        !['SSL_WIRELESS', 'IRONGATE'].includes(providerCode)) return false;
    const client = await connect();
    let discard = false;
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SELECT set_config('nukhabapay.tenant_id',$1,true)", [tenantId]);
      const { rows: [result] } = await client.query<{ found: boolean }>(`SELECT EXISTS(
        SELECT FROM nukhabapay.provider_accounts WHERE tenant_id=$1 AND id=$2 AND provider_code=$3 AND status='ACTIVE'
      ) AS found`, [tenantId, accountId, providerCode]);
      if ((await client.query('COMMIT')).command !== 'COMMIT') throw new Error('Incomplete account check');
      return !closing && result?.found === true;
    } catch {
      discard = true;
      await client.query('ROLLBACK').catch(() => undefined);
      return false;
    } finally { client.release(discard); }
  }

  async function readFinxplorAcquisitions(tenantId: string, discoveryIds: readonly string[]) {
    const summaries = new Map<string, FinxplorAcquisitionSummary>();
    if (discoveryIds.length === 0) return summaries;
    if (closing || !administrationUuid.test(tenantId) || discoveryIds.length > 50 ||
        discoveryIds.some(id => !administrationUuid.test(id))) throw new Error('Invalid acquisition summary scope');
    const client = await connect();
    let discard = false;
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SELECT set_config('nukhabapay.tenant_id',$1,true)", [tenantId]);
      const { rows } = await client.query<{
        discovery_id: string; state: 'QUOTE_REQUIRED' | 'EXPIRED' | 'NORMALIZED';
        aed_amount: string | null; face_amount: string | null; face_currency: string | null; valid_until: Date | null;
      }>('SELECT * FROM nukhabapay.staff_finxplor_acquisition_summary($1,$2)', [tenantId, discoveryIds]);
      for (const row of rows) {
        const previous = summaries.get(row.discovery_id);
        if (row.state === 'NORMALIZED' && row.aed_amount && row.face_amount && row.face_currency && row.valid_until) {
          summaries.set(row.discovery_id, { status: 'NORMALIZED', amounts: [
            ...(previous?.status === 'NORMALIZED' ? previous.amounts : []),
            { aedAmount: row.aed_amount, faceAmount: row.face_amount, faceCurrency: row.face_currency,
              validUntil: row.valid_until.toISOString() },
          ] });
        } else if (previous?.status !== 'NORMALIZED' && (row.state === 'QUOTE_REQUIRED' || row.state === 'EXPIRED')) {
          summaries.set(row.discovery_id, { status: row.state });
        }
      }
      if ((await client.query('COMMIT')).command !== 'COMMIT') throw new Error('Acquisition summary read incomplete');
      return summaries;
    } catch {
      discard = true;
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error('Acquisition summary unavailable');
    } finally { client.release(discard); }
  }

  async function readFinxplorLayer1Prices(tenantId: string, discoveryIds: readonly string[]) {
    const prices = new Map<string, FinxplorLayer1Price[]>();
    if (!discoveryIds.length) return prices;
    if (closing || !administrationUuid.test(tenantId) || discoveryIds.length>50 ||
        discoveryIds.some(id=>!administrationUuid.test(id))) throw new Error('Invalid price scope');
    const client = await connect();
    let discard = false;
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SELECT set_config('nukhabapay.tenant_id',$1,true)", [tenantId]);
      const {rows} = await client.query<FinxplorLayer1Price & { discoveryId: string }>(`
        SELECT p.discovery_id AS "discoveryId",p.basis,p.source_key AS "sourceKey",
          p.source_currency AS "sourceCurrency",p.source_amount::text AS "sourceAmount",
          CASE WHEN fresh.rate_source IS NOT NULL THEN p.converted_aed::text END AS "convertedAed",
          fresh.rate_source AS "rateSource"
        FROM (
          SELECT p.*,row_number() OVER(PARTITION BY p.discovery_id, (p.basis='CUSTOMER_PRICE')
            ORDER BY p.source_amount,p.source_key) AS item_number
          FROM nukhabapay.finxplor_layer1_customer_prices p
          JOIN nukhabapay.observed_catalogue_discoveries d
            ON (d.tenant_id,d.provider_account_id,d.id)=(p.tenant_id,p.provider_account_id,p.discovery_id)
          WHERE p.tenant_id=$1 AND p.discovery_id=ANY($2::uuid[])
            AND (p.price_valid_until IS NULL OR p.price_valid_until>statement_timestamp())
        ) p LEFT JOIN nukhabapay.finxplor_customer_fx_rates quote
          ON (quote.tenant_id,quote.provider_account_id,quote.source_currency,quote.slot_at,quote.retrieved_at)=
            (p.tenant_id,p.provider_account_id,p.source_currency,p.fx_slot_at,p.fx_retrieved_at)
        CROSS JOIN LATERAL (
          SELECT CASE WHEN p.source_currency='AED' THEN 'AED_IDENTITY'
            WHEN quote.slot_at+interval '12 hours'>statement_timestamp() THEN quote.rate_source END AS rate_source
        ) fresh
        WHERE p.item_number<=25 ORDER BY p.discovery_id,p.basis,p.source_amount,p.source_key`, [tenantId,discoveryIds]);
      for (const {discoveryId,...price} of rows) {
        const list = prices.get(discoveryId) ?? [];
        list.push(price);
        prices.set(discoveryId,list);
      }
      if ((await client.query('COMMIT')).command!=='COMMIT') throw new Error('Incomplete price read');
      return prices;
    } catch {
      discard = true;
      await client.query('ROLLBACK').catch(()=>undefined);
      throw new Error('Layer 1 price read unavailable');
    } finally {client.release(discard);}
  }

  const read = createStaffCatalogueReader({ connect }, availability, { localDiscoveries: true });
  return Object.freeze({ checkReadiness, close, read, hasActiveProviderAccount, readFinxplorAcquisitions, readFinxplorLayer1Prices });
}
