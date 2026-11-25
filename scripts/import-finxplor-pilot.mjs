import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import pg from '../packages/database/node_modules/pg/lib/index.js';
import { FinxplorCatalogue } from '../packages/provider-adapters/src/finxplor-catalogue.ts';

const { Client } = pg;
const root = new URL('../', import.meta.url);
const role = 'nukhbapay_catalogue_runtime';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const origin = 'https://sandbox.finxplorconnect.com';
const configError = () => new Error('Local catalogue pilot configuration unavailable');
const sourceDigest = product => createHash('sha256').update(JSON.stringify(product)).digest('hex');
let phase = 'configuration';
let detailStatus;

async function localAccount(client, account, reference) {
  const { rows: [row] } = await client.query(`
    SELECT external_account_key FROM nukhabapay.provider_accounts
    WHERE tenant_id=$1 AND id=$2 AND provider_code='FINXPLOR' AND status='DISABLED'`,
  [account.tenantId, account.providerAccountId]);
  const registration = /^sandbox-registration:(\d{1,30})$/.exec(row?.external_account_key ?? '')?.[1];
  if (!registration || reference !== 'finxplor/sandbox/registration-' + registration) throw configError();
}

async function main() {
  const full = process.argv[2] === '--full';
  const detail = process.argv[2] === '--detail';
  const productId = process.argv[3];
  if (process.platform !== 'win32' || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
      process.argv.length !== (detail ? 4 : full ? 3 : 2) ||
      detail && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(productId ?? '')) throw configError();
  const setup = process.env.NUKHBAPAY_CATALOGUE_SETUP_ID;
  const password = process.env.NUKHBAPAY_CATALOGUE_RUNTIME_PASSWORD;
  if (!/^[a-f0-9]{32}$/.test(setup ?? '') || !/^[a-f0-9]{64}$/.test(password ?? '')) throw configError();
  const env = parseEnv(await readFile(new URL('.env', root), 'utf8'));
  const evidence = JSON.parse(await readFile(new URL('.local/windows-catalogue-result.json', root), 'utf8'));
  const receipts = (await readdir(new URL('.local/', root))).filter(name => /^windows-enrollment-[a-f0-9]{32}\.txt$/.test(name));
  const tenants = new Set(await Promise.all(receipts.map(async name => (await readFile(new URL('.local/' + name, root), 'utf8')).trim())));
  const [tenantId] = tenants;
  const providerAccountId = env.NUKHBAPAY_FINXPLOR_PROVIDER_ACCOUNT_ID;
  const reference = env.NUKHBAPAY_FINXPLOR_CREDENTIAL_REFERENCE;
  if (evidence.status !== 'verified' || evidence.backendReaderVerified !== true ||
      env.NUKHBAPAY_FINXPLOR_BASE_URL !== origin || env.NUKHBAPAY_FINXPLOR_API_KEY_HEADER !== 'x-api-key' ||
      env.NUKHBAPAY_PROVIDER_SANDBOX_ENABLED !== 'false' ||
      tenants.size !== 1 || !uuid.test(tenantId ?? '') || !uuid.test(providerAccountId ?? '')) throw configError();
  const account = Object.freeze({ tenantId, providerAccountId });
  const catalogue = new FinxplorCatalogue({
    account, credentialReference: reference,
    getApiKey: async (binding, ref) => {
      if (binding.tenantId !== tenantId || binding.providerAccountId !== providerAccountId || ref !== reference) throw configError();
      return env.NUKHBAPAY_FINXPLOR_API_KEY;
    },
    transport: detail ? async (url, init) => {
      const response = await fetch(url, init);
      detailStatus = response.status;
      return response;
    } : globalThis.fetch,
  });
  const client = new Client({
    host: '127.0.0.1', port: 5432, database: 'nukhbapay_catalogue', user: role, password, ssl: false,
    connectionTimeoutMillis: 12000, query_timeout: 15000,
    options: '-c search_path=pg_catalog -c statement_timeout=10000 -c lock_timeout=5000' +
      (detail ? ' -c default_transaction_read_only=on' : ''),
    application_name: 'nukhbapay-finxplor-pilot',
  });
  const scoped = () => client.query("SELECT set_config('nukhabapay.tenant_id',$1,true)", [tenantId]);
  try {
    phase = 'catalogue database login';
    await client.connect();
    phase = 'catalogue database scope';
    const { rows: [target] } = await client.query(`
      SELECT current_user=$1 AND system_user='scram-sha-256:' || $1
        AND current_database()='nukhbapay_catalogue' AND host(inet_server_addr())='127.0.0.1'
        AND inet_server_port()=5432 AND current_setting('server_version_num')::int/10000=18
        AND pg_get_userbyid(d.datdba)='nukhbapay_catalogue_migrator'
        AND shobj_description(d.oid,'pg_database')=$2
        AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolinherit OR r.rolreplication)
        AND NOT EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)
        AND NOT has_database_privilege(current_user,'nukhbapay_staff','CONNECT')
        AND (SELECT c.relrowsecurity AND c.relforcerowsecurity AND c.relowner=d.datdba
          AND NOT has_table_privilege(current_user,c.oid,'UPDATE,DELETE,TRUNCATE,TRIGGER')
          AND NOT has_any_column_privilege(current_user,c.oid,'UPDATE')
          FROM pg_class c WHERE c.oid='nukhabapay.catalogue_discoveries'::regclass)
        AND row_security_active('nukhabapay.catalogue_discoveries') AS verified
      FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`,
    [role, 'nukhbapay-catalogue-local:' + setup]);
    if (target?.verified !== true) throw configError();
    phase = 'local provider account';
    await client.query('BEGIN READ ONLY');
    await scoped();
    await localAccount(client, account, reference);
    if (detail) {
      phase = 'current saved product';
      const {rows:[saved],rowCount} = await client.query(`WITH latest AS (
        SELECT id,completed_at FROM nukhabapay.catalogue_discovery_scans WHERE tenant_id=$1 AND provider_account_id=$2
        ORDER BY completed_at DESC,id DESC LIMIT 1
      )
      SELECT s.completed_at AS "scanAt", d.source_id AS "sourceId",d.source_country AS country,d.currency,
        d.product_name AS name,d.brand,d.category,d.delivery,d.denominations,d.min_amount AS "minAmount",d.max_amount AS "maxAmount"
      FROM latest s JOIN nukhabapay.catalogue_discovery_scan_items i ON i.scan_id=s.id
      JOIN nukhabapay.catalogue_discoveries d
        ON (d.tenant_id,d.provider_account_id,d.id)=(i.tenant_id,i.provider_account_id,i.discovery_id)
      WHERE i.tenant_id=$1 AND i.provider_account_id=$2 AND d.source_id=$3`, [tenantId, providerAccountId, productId]);
      if (rowCount!==1 || !saved || (await client.query('COMMIT')).command !== 'COMMIT') throw configError();
      phase = 'Finxplor product detail read';
      const observation = await catalogue.detail(account, productId);
      const differentFields = Object.keys(observation).filter(key => JSON.stringify(observation[key]) !== JSON.stringify(saved[key]));
      console.log(JSON.stringify({result:'DETAIL_READ', product:observation,
        savedScanAt:saved.scanAt, matchesSavedScan:differentFields.length===0, differentFields, pricing:'UNVERIFIED'}));
      return;
    }
    const {rows:[lock]} = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',
      [`finxplor-discovery:${tenantId}:${providerAccountId}`]);
    if (lock?.acquired !== true) throw configError();
    if (full) {
      const {rows:[scans]} = await client.query(`SELECT count(*)=2 AND bool_and(c.relforcerowsecurity
        AND row_security_active(c.oid) AND pg_get_userbyid(c.relowner)='nukhbapay_catalogue_migrator'
        AND NOT has_table_privilege(current_user,c.oid,'UPDATE,DELETE,TRUNCATE,TRIGGER')
        AND NOT has_any_column_privilege(current_user,c.oid,'UPDATE')) AS verified
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nukhabapay'
        AND c.relname IN ('catalogue_discovery_scans','catalogue_discovery_scan_items')`);
      if (scans?.verified !== true) throw configError();
    }
    if ((await client.query('COMMIT')).command !== 'COMMIT') throw configError();
    phase = 'Finxplor catalogue read';
    const signal = AbortSignal.timeout(150_000);
    const products = full ? await catalogue.fullCatalogue(account, signal) : (await catalogue.page(account, 1, 1, signal)).products;
    if (!products.length) throw configError();
    const records = products.map(product => ({
      id: randomUUID(), source_id: product.sourceId,
      source_digest: sourceDigest(product),
      product_name: product.name, brand: product.brand, source_country: product.country, currency: product.currency,
      category: product.category, delivery: product.delivery, denominations: product.denominations,
      min_amount: product.minAmount, max_amount: product.maxAmount,
    }));
    phase = 'discovery transaction';
    await client.query('BEGIN');
    await scoped();
    await localAccount(client, account, reference);
    const inserted = await client.query(`
      INSERT INTO nukhabapay.catalogue_discoveries
        (id,tenant_id,provider_account_id,source_id,source_digest,product_name,brand,source_country,
         currency,category,delivery,denominations,min_amount,max_amount)
      SELECT id,$1,$2,source_id,source_digest,product_name,brand,source_country,currency,
        category,delivery,denominations,min_amount,max_amount
      FROM jsonb_to_recordset($3::jsonb) AS p(id uuid,source_id text,source_digest text,product_name text,
        brand text,source_country text,currency text,category text,delivery text,denominations jsonb,
        min_amount text,max_amount text)
      ON CONFLICT (tenant_id,provider_account_id,source_id,source_digest) DO NOTHING
      RETURNING id`, [tenantId, providerAccountId, JSON.stringify(records)]);
    const { rows } = await client.query(`
      SELECT d.id FROM nukhabapay.catalogue_discoveries d
      JOIN jsonb_to_recordset($3::jsonb) AS p(source_id text,source_digest text)
        ON (p.source_id,p.source_digest)=(d.source_id,d.source_digest)
      WHERE d.tenant_id=$1 AND d.provider_account_id=$2`,
    [tenantId, providerAccountId, JSON.stringify(records.map(({source_id,source_digest}) => ({source_id,source_digest})))]);
    if (rows.length !== products.length) throw configError();
    if (full) {
      const scan = randomUUID();
      await client.query(`INSERT INTO nukhabapay.catalogue_discovery_scans (id,tenant_id,provider_account_id)
        VALUES ($3,$1,$2)`, [tenantId, providerAccountId, scan]);
      const items = await client.query(`INSERT INTO nukhabapay.catalogue_discovery_scan_items
        (tenant_id,provider_account_id,scan_id,discovery_id) SELECT $1,$2,$3,id FROM unnest($4::uuid[]) AS ids(id)`,
      [tenantId, providerAccountId, scan, rows.map(row => row.id)]);
      if (items.rowCount !== products.length) throw configError();
    }
    if ((await client.query('COMMIT')).command !== 'COMMIT') throw configError();
    console.log(JSON.stringify({ result: inserted.rowCount ? 'IMPORTED' : 'REPLAYED',
      ...(full ? {} : {id:rows[0].id}), inserted:inserted.rowCount, products:rows.length,
      completeness: full ? 'ALL_LISTED_PRODUCTS' : 'SAMPLE', pricing: 'UNVERIFIED', mapping: 'REVIEW_REQUIRED' }));
  } finally { await client.end().catch(() => undefined); }
}

main().catch(error => {
  const code = /^[A-Z0-9_]{2,24}$/.test(error.code ?? '') ? error.code : 'UNAVAILABLE';
  console.error(JSON.stringify({ result: 'STOPPED', phase, code,
    ...(detailStatus !== undefined && { providerStatus: detailStatus }) }));
  process.exitCode = 1;
});
