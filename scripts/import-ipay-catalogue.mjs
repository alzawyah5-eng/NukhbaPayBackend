import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { createIpaySoapProcess, IpaySdk } from '../packages/provider-adapters/src/ipay-sdk.ts';
import { parseAcquisitionDecimal } from '../packages/domain/src/acquisition-cost.ts';

const root = new URL('../', import.meta.url);
const { Client } = createRequire(new URL('packages/database/package.json', root))('pg');
const role = 'nukhbapay_catalogue_runtime';
const coverage = 'IPAY_PRODUCT_FILE';
class IpayReadFailure extends Error {
  constructor(stage) {
    super('iPay UAT read unconfirmed');
    this.stage = stage;
  }
}
const endpoint = 'https://uae.q3cloud.me:545/ecsoap';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const scopeTenant = (client, tenantId) =>
  client.query("SELECT set_config('nukhabapay.tenant_id',$1,true)", [tenantId]);
const deliveryLabels = {
  EP: 'Digital PIN', VP: 'Digital PIN', TF: 'Mobile top-up', TV: 'Mobile top-up',
  B1: 'Bill payment', PS: 'Card activation', PF: 'Card activation', PV: 'Card activation',
};

function sortAmounts(a, b) {
  const left = parseAcquisitionDecimal(a, 8, 20);
  const right = parseAcquisitionDecimal(b, 8, 20);
  const delta = left.coefficient * 10n ** BigInt(right.scale) - right.coefficient * 10n ** BigInt(left.scale);
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}

export function projectIpayCatalogue(catalogue, sourceCountry) {
  return catalogue.products.map(product => {
    if (!product.currency || product.title.length > 128 || product.category.length > 80) {
      throw new Error('iPay product exceeds catalogue bounds');
    }
    const denominations = product.amounts.map(({ value }) => value).sort(sortAmounts);
    return {
      source_id: product.code,
      source_digest: digest(JSON.stringify({ ...product, sourceCountry })),
      product_name: product.title,
      brand: product.category,
      source_country: sourceCountry,
      currency: product.currency,
      category: product.category,
      delivery: Object.hasOwn(deliveryLabels, product.sourceType) ? deliveryLabels[product.sourceType] : 'Qore3 ' + product.sourceType,
      denominations,
      min_amount: denominations[0] ?? '0',
      max_amount: denominations.at(-1) ?? product.amountLimit,
    };
  });
}

async function requireAccount(client, tenantId, providerAccountId, terminalId) {
  const { rowCount } = await client.query(`SELECT 1 FROM nukhabapay.provider_accounts
    WHERE tenant_id=$1 AND id=$2 AND provider_code='IPAY' AND status='DISABLED'
      AND lower(external_account_key)=lower('terminal:' || $3)`, [tenantId, providerAccountId, terminalId]);
  if (rowCount !== 1) throw new Error('iPay UAT account binding unavailable');
}

// The caller holds the account lock and supplies a validated file and a scoped transaction.
export async function storeIpayCatalogue(client, account, catalogue, sourceCountry, observedAt) {
  const { tenantId, providerAccountId } = account;
  const scope = [tenantId, providerAccountId];
  const rows = projectIpayCatalogue(catalogue, sourceCountry);
  const entries = rows.map(row => row.source_id + ':' + row.source_digest).sort();
  const scanDigest = digest(coverage + '\n' + entries.join('\n'));
  const { rows: [previous] } = await client.query(`SELECT id,source_group,source_version,scan_digest,product_count
    FROM nukhabapay.catalogue_discovery_scans WHERE tenant_id=$1 AND provider_account_id=$2 AND coverage_scope=$3
    ORDER BY completed_at DESC,id DESC LIMIT 1`, [...scope, coverage]);
  if (previous && (previous.source_group !== catalogue.groupNumber ||
      BigInt(previous.source_version) > BigInt(catalogue.version))) throw new Error('iPay product file is outside the current version scope');
  let scanId = previous?.id;
  let inserted = 0;
  if (!previous || previous.source_version !== catalogue.version) {
    const products = JSON.stringify(rows);
    const saved = await client.query(`INSERT INTO nukhabapay.catalogue_discoveries
      (id,tenant_id,provider_account_id,source_id,source_digest,product_name,brand,source_country,currency,category,
       delivery,denominations,min_amount,max_amount,source_country_label,source_category_label)
      SELECT gen_random_uuid(),$1,$2,p.source_id,p.source_digest,p.product_name,p.brand,p.source_country,p.currency,p.category,
        p.delivery,p.denominations,p.min_amount,p.max_amount,p.source_country,p.category
      FROM jsonb_to_recordset($3::jsonb) AS p(source_id text,source_digest text,product_name text,brand text,
        source_country text,currency text,category text,delivery text,denominations jsonb,min_amount text,max_amount text)
      ON CONFLICT (tenant_id,provider_account_id,source_id,source_digest) DO NOTHING`, [...scope, products]);
    inserted = saved.rowCount;
    scanId = randomUUID();
    await client.query(`INSERT INTO nukhabapay.catalogue_discovery_scans
      (id,tenant_id,provider_account_id,coverage_scope,page_count,product_count,source_observed_at,scan_digest,source_group,source_version)
      VALUES ($3,$1,$2,$4,1,$5,$6,$7,$8,$9)`, [...scope, scanId, coverage, rows.length, observedAt,
      scanDigest, catalogue.groupNumber, catalogue.version]);
    await client.query(`INSERT INTO nukhabapay.catalogue_discovery_scan_items (tenant_id,provider_account_id,scan_id,discovery_id)
      SELECT $1,$2,$3,d.id FROM nukhabapay.catalogue_discoveries d
      JOIN jsonb_to_recordset($4::jsonb) AS p(source_id text,source_digest text) USING (source_id,source_digest)
      WHERE d.tenant_id=$1 AND d.provider_account_id=$2`, [...scope, scanId, products]);
  } else if (previous.scan_digest !== scanDigest || previous.product_count !== rows.length) {
    throw new Error('iPay product file changed without a version update');
  }
  await client.query(`INSERT INTO nukhabapay.catalogue_discovery_confirmations
    (tenant_id,provider_account_id,scan_id,run_id,observed_at) VALUES($1,$2,$3,$4,$5)`,
  [...scope, scanId, randomUUID(), observedAt]);
  return { products: rows.length, inserted, unchanged: rows.length - inserted, sourceVersion: catalogue.version };
}

async function main(operation) {
  if (!['--check', '--sync'].includes(operation) || process.argv.length !== 3 || process.platform !== 'win32' ||
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('iPay UAT operation unavailable');
  const setupId = process.env.NUKHBAPAY_CATALOGUE_SETUP_ID;
  const databasePassword = process.env[role.toUpperCase() + '_PASSWORD'];
  const env = parseEnv(await readFile(new URL('.env', root), 'utf8'));
  const config = key => env['NUKHBAPAY_IPAY_' + key];
  const receipts = (await readdir(new URL('.local/', root))).filter(name => /^windows-enrollment-[a-f0-9]{32}\.txt$/.test(name));
  const tenants = new Set(await Promise.all(receipts.map(async name => (await readFile(new URL('.local/' + name, root), 'utf8')).trim())));
  const [tenantId] = tenants;
  const providerAccountId = config('PROVIDER_ACCOUNT_ID');
  const terminalId = config('TERMINAL_ID');
  const password = config('PASSWORD');
  const country = config('CATALOGUE_SOURCE_COUNTRY');
  const groupNumber = config('PRODUCT_GROUP_NUMBER');
  if (!/^[a-f0-9]{32}$/.test(setupId ?? '') || !/^[a-f0-9]{64}$/.test(databasePassword ?? '') ||
      tenants.size !== 1 || !uuid.test(tenantId ?? '') || !uuid.test(providerAccountId ?? '') ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(terminalId ?? '') || !/^[!-~]{1,512}$/.test(password ?? '') ||
      config('CREDENTIAL_REFERENCE') !== 'ipay/local/terminal-' + terminalId.toLowerCase() ||
      config('SOAP_URL') !== endpoint || country !== 'ARE' || config('PRODUCT_FILE_ROOT') !== 'ProductFile' ||
      !/^\d{1,19}$/.test(groupNumber ?? '')) throw new Error('iPay UAT settings unavailable');
  const account = { tenantId, providerAccountId };
  const sdk = new IpaySdk({
    account, allowedOperations: operation === '--check' ? ['version', 'balance', 'productFile'] : ['productFile'],
    productFile: { rootElement: config('PRODUCT_FILE_ROOT'), groupNumber, format: 'qore3-product-file' },
    getCredentials: async () => ({ terminalId, password }),
    processXml: createIpaySoapProcess({
      endpoint, namespace: config('SOAP_NAMESPACE'), action: config('SOAP_ACTION'),
      requestElementNamespace: config('SOAP_REQUEST_ELEMENT_NAMESPACE'),
      resultElement: config('SOAP_RESULT_ELEMENT'), resultElementNamespace: config('SOAP_RESULT_ELEMENT_NAMESPACE'),
      transport: fetch,
    }),
  });
  const client = new Client({
    host: '127.0.0.1', port: 5432, database: 'nukhbapay_catalogue', user: role, password: databasePassword, ssl: false,
    connectionTimeoutMillis: 5000, query_timeout: 15000,
    options: '-c search_path=pg_catalog -c statement_timeout=10000 -c lock_timeout=5000',
    application_name: 'nukhbapay-ipay-catalogue',
  });
  try {
    await client.connect();
    const { rows: [target] } = await client.query(`SELECT current_user=$1 AND system_user='scram-sha-256:'||$1
      AND current_database()='nukhbapay_catalogue' AND host(inet_server_addr())='127.0.0.1' AND inet_server_port()=5432
      AND current_setting('server_version_num')::int/10000=18 AND pg_get_userbyid(d.datdba)='nukhbapay_catalogue_migrator'
      AND shobj_description(d.oid,'pg_database')=$2 AND row_security_active('nukhabapay.catalogue_discoveries')
      AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolinherit OR r.rolreplication)
      AND NOT EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT has_database_privilege(current_user,'nukhbapay_staff','CONNECT') AS verified
      FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`,
    [role, 'nukhbapay-catalogue-local:' + setupId]);
    if (target?.verified !== true) throw new Error('iPay catalogue database target unavailable');
    await client.query('BEGIN READ ONLY');
    await scopeTenant(client, tenantId);
    await requireAccount(client, tenantId, providerAccountId, terminalId);
    await client.query('COMMIT');
    if (operation === '--sync') {
      const { rows: [lock] } = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',
        ['ipay-catalogue:' + tenantId + ':' + providerAccountId]);
      if (!lock?.acquired) throw new Error('iPay catalogue sync is already running');
    }
    if (operation === '--check') {
      const version = await sdk.execute(account, { operation: 'version' });
      if (version.outcome !== 'OBSERVED' || !version.version) throw new IpayReadFailure('VERSION');
      const balance = await sdk.execute(account, { operation: 'balance' });
      if (balance.outcome !== 'OBSERVED' || !balance.balance) throw new IpayReadFailure('BALANCE');
    }
    const file = await sdk.execute(account, { operation: 'productFile' });
    if (file.outcome !== 'OBSERVED' || !file.catalogue) throw new IpayReadFailure('PRODUCT_FILE');
    if (operation === '--check') {
      console.log(JSON.stringify({ outcome: 'SCHEMA_ACCEPTED', products: file.catalogue.products.length,
        sourceVersion: file.catalogue.version, versionRead: true, balanceRead: true }));
      return;
    }
    const observedAt = new Date().toISOString();
    await client.query('BEGIN');
    await scopeTenant(client, tenantId);
    await requireAccount(client, tenantId, providerAccountId, terminalId);
    const receipt = await storeIpayCatalogue(client, account, file.catalogue, country, observedAt);
    if ((await client.query('COMMIT')).command !== 'COMMIT') throw new Error('iPay catalogue commit unconfirmed');
    console.log(JSON.stringify({ ...receipt, persisted: true }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { await client.end().catch(() => undefined); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv[2]).catch(error => {
    const code = /^[A-Z0-9]{5}$/.test(error?.code ?? '') ? error.code : undefined;
    console.error(JSON.stringify({ outcome: 'IPAY_UNAVAILABLE', code,
      ...(error instanceof IpayReadFailure && { stage: error.stage }) }));
    process.exitCode = 1;
  });
}
