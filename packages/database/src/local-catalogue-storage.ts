import { Pool, type PoolClient } from 'pg';
import { administrationUuid, type ConfiguredAvailability } from '@nukhbapay/application';
import { createStaffCatalogueReader } from './staff-catalogue-reader.js';

/** Restricted read composition for the dedicated Windows development database. */
export async function createLocalCatalogueStorage(
  config: Readonly<{ setupId: string; databaseOid?: string; password: string }>,
  availability: ReadonlyMap<string, readonly ConfiguredAvailability[]>,
) {
  if (process.platform !== 'win32' || !/^[a-f0-9]{32}$/.test(config.setupId) ||
      (config.databaseOid !== undefined && !/^[1-9][0-9]{0,9}$/.test(config.databaseOid)) ||
      !/^[a-f0-9]{64}$/.test(config.password)) throw new Error('Invalid local catalogue configuration');

  const pool = new Pool({ host: '127.0.0.1', port: 5432, database: 'nukhbapay_catalogue',
    user: 'nukhbapay_catalogue_reader', password: config.password, ssl: false,
    options: '-c search_path=pg_catalog -c default_transaction_read_only=on -c statement_timeout=8000',
    application_name: 'nukhbapay-local-catalogue-reader', max: 2, connectionTimeoutMillis: 5000 });
  pool.on('error', () => { /* The next checkout revalidates the database and role. */ });

  let databaseOid = config.databaseOid;
  async function connect(): Promise<PoolClient> {
    const client = await pool.connect();
    try {
      const { rows: [result] } = await client.query<{ ready: boolean; oid: string }>(`SELECT db.oid::text AS oid,
        current_database()='nukhbapay_catalogue' AND ($1::text IS NULL OR db.oid::text=$1)
        AND shobj_description(db.oid,'pg_database')=$2 AND pg_get_userbyid(db.datdba)='nukhbapay_catalogue_migrator'
        AND host(inet_server_addr())='127.0.0.1' AND inet_server_port()=5432
        AND current_user='nukhbapay_catalogue_reader' AND system_user='scram-sha-256:nukhbapay_catalogue_reader'
        AND current_setting('default_transaction_read_only')='on'
        AND NOT (r.rolsuper OR r.rolinherit OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
        AND NOT EXISTS(SELECT FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid)
        AND NOT has_database_privilege(current_user,'nukhbapay_staff','CONNECT')
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
        [databaseOid ?? null, `nukhbapay-catalogue-local:${config.setupId}`]);
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
        await client.query(`SELECT i.discovery_id FROM nukhabapay.catalogue_discovery_scans s
          JOIN nukhabapay.catalogue_discovery_scan_items i ON i.scan_id=s.id LIMIT 0`);
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

  const read = createStaffCatalogueReader({ connect }, availability, { localDiscoveries: true });
  return Object.freeze({ checkReadiness, close, read, hasActiveProviderAccount });
}
