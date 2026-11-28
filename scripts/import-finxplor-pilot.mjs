import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import pg from '../packages/database/node_modules/pg/lib/index.js';
import { FinxplorCatalogue, FinxplorCatalogueChanged } from '../packages/provider-adapters/src/finxplor-catalogue.ts';
import { openFinxplorCheckpoint } from './finxplor-catalogue-checkpoint.mjs';
import { readProviderBytes } from '../packages/provider-adapters/src/catalogue-http.ts';
import { inspectFinxplorDatabase, inspectFinxplorFeed } from './inspect-finxplor-catalogue.mjs';

const { Client } = pg;
const root = new URL('../', import.meta.url);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const origin = 'https://sandbox.finxplorconnect.com';
const configError = () => new Error('Local catalogue pilot configuration unavailable');
const sourceDigest = ({imageUrl:_imageUrl,...product}) => createHash('sha256').update(JSON.stringify(product)).digest('hex');
let phase = 'configuration';
let providerStatus;
let refreshProgress;
const global = process.argv[2] === '--global';
const approvedCoverage = global ? 'ALL_COUNTRIES' : 'ARE_GIFT_CARD';

async function localAccount(client, account, reference) {
  const { rows: [row] } = await client.query(`
    SELECT external_account_key FROM nukhabapay.provider_accounts
    WHERE tenant_id=$1 AND id=$2 AND provider_code='FINXPLOR' AND status='DISABLED'`,
  [account.tenantId, account.providerAccountId]);
  const registration = /^sandbox-registration:(\d{1,30})$/.exec(row?.external_account_key ?? '')?.[1];
  if (!registration || reference !== 'finxplor/sandbox/registration-' + registration) throw configError();
}

// Previous Layer 1 implementation — disabled while rebuilding according to the new approved architecture.
// async function commercialPrerequisites(client, account, productId) {
//   const { rows: [status] } = await client.query(`WITH latest_mapping AS (
//       SELECT id, mapping_version, status FROM nukhabapay.product_mappings
//       WHERE tenant_id=$1 AND provider_account_id=$2 AND provider_sku=$3
//       ORDER BY mapping_version DESC LIMIT 1
//     ), latest_snapshot AS (
//       SELECT id FROM nukhabapay.provider_snapshots
//       WHERE tenant_id=$1 AND provider_account_id=$2 AND status='COMPLETE'
//       ORDER BY completed_at DESC,id DESC LIMIT 1
//     )
//     SELECT EXISTS (SELECT FROM nukhabapay.provider_accounts WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE')
//         AS "providerAccountActive",
//       (SELECT status FROM latest_mapping) AS "latestMappingStatus",
//       EXISTS (SELECT FROM latest_snapshot) AS "hasCompletedOfferSnapshot",
//       EXISTS (
//         SELECT FROM nukhabapay.provider_offers o
//         JOIN latest_mapping m ON (m.id,m.mapping_version)=(o.product_mapping_id,o.product_mapping_version)
//         JOIN latest_snapshot s ON s.id=o.provider_snapshot_id
//         WHERE o.tenant_id=$1 AND o.provider_account_id=$2 AND m.status='APPROVED' AND o.available
//           AND o.observed_at<=transaction_timestamp() AND o.valid_until>transaction_timestamp()
//           AND o.additional_provider_fee_minor IS NOT NULL AND o.upfront_discount_minor IS NOT NULL
//       ) AS "hasCurrentMappedOffer"`, [account.tenantId, account.providerAccountId, productId]);
//   return status;
// }

async function saveArtwork(client, account, products, observedAt) {
  const artwork = products.flatMap(product => product.imageUrl
    ? [{source_id:product.sourceId,brand:product.brand,country:product.country,image_url:product.imageUrl}] : []);
  if (!artwork.length) return 0;
  const saved = await client.query(`INSERT INTO nukhabapay.finxplor_catalogue_artwork AS previous
    (tenant_id,provider_account_id,discovery_id,image_url,observed_at)
    SELECT d.tenant_id,d.provider_account_id,d.id,a.image_url,$4
    FROM jsonb_to_recordset($3::jsonb) AS a(source_id text,brand text,country text,image_url text)
    JOIN nukhabapay.observed_catalogue_discoveries d ON (d.source_id,d.brand,d.source_country)=(a.source_id,a.brand,a.country)
    WHERE d.tenant_id=$1 AND d.provider_account_id=$2
    ON CONFLICT (tenant_id,provider_account_id,discovery_id) DO UPDATE SET
      image_url=excluded.image_url,observed_at=excluded.observed_at
    WHERE previous.observed_at<=excluded.observed_at`,
    [account.tenantId,account.providerAccountId,JSON.stringify(artwork),observedAt]);
  return saved.rowCount;
}

async function main() {
  const rehearsal = process.argv[2] === '--rehearse-scope';
  const full = global || rehearsal || process.argv[2] === '--full';
  const detail = process.argv[2] === '--detail';
  const inspect = process.argv[2] === '--inspect';
  const verifyLayer1 = process.argv[2] === '--verify-layer1';
  const refreshArtwork = process.argv[2] === '--refresh-artwork';
  const manualPrices = process.argv[2] === '--refresh-prices-now';
  const refreshPrices = manualPrices || process.argv[2] === '--refresh-prices';
  const verifyCoverage = process.argv[2] === '--verify-scope';
  const role = verifyCoverage ? 'nukhbapay_catalogue_reader' : 'nukhbapay_catalogue_runtime';
  const checkCost = process.argv[2] === '--check-cost';
  const productId = process.argv[3];
  if (full) refreshProgress = { requestedCoverage: approvedCoverage, completedCoverage: null, pages: 0,pagesRetrieved:0,requests:0,
    products: 0, inserted: 0, unchanged: 0, rejected: 0 };
  if (checkCost) {
    console.error(JSON.stringify({ result: 'AED_NORMALIZATION_UNAVAILABLE',
      message: 'AED acquisition-cost normalization is unavailable during the Layer 1 rebuild.' }));
    process.exitCode = 1;
    return;
  }
  const hasProductId = detail || inspect || verifyCoverage;
  if (process.platform !== 'win32' || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
      process.argv.length !== (hasProductId ? 4 : full || verifyLayer1 || refreshPrices || refreshArtwork ? 3 : 2) ||
      hasProductId && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(productId ?? '')) throw configError();
  const setup = process.env.NUKHBAPAY_CATALOGUE_SETUP_ID;
  const refreshRunId = process.env.NUKHBAPAY_CATALOGUE_REFRESH_RUN_ID;
  const password = process.env[role.toUpperCase() + '_PASSWORD'];
  if (!/^[a-f0-9]{32}$/.test(setup ?? '') || !/^[a-f0-9]{64}$/.test(password ?? '') ||
      (full && !/^[a-f0-9]{32}$/.test(refreshRunId ?? ''))) throw configError();
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
  const capturedPages = rehearsal ? new Map() : null;
  let scopeQualification;
  const catalogue = new FinxplorCatalogue({
    account, credentialReference: reference,
    getApiKey: async (binding, ref) => {
      if (binding.tenantId !== tenantId || binding.providerAccountId !== providerAccountId || ref !== reference) throw configError();
      return env.NUKHBAPAY_FINXPLOR_API_KEY;
    },
    transport: async (url, init) => {
      providerStatus = undefined;
      const response = await fetch(url, init);
      providerStatus = response.status;
      if (capturedPages && response.status === 200) {
        const page = Number(new URL(url).searchParams.get('page'));
        if (!capturedPages.has(page)) {
          const copy = await readProviderBytes(response.clone(), init.signal, 'application/json', configError);
          capturedPages.set(page, copy);
        }
      }
      return response;
    },
  });
  const client = new Client({
    host: '127.0.0.1', port: 5432, database: 'nukhbapay_catalogue', user: role, password, ssl: false,
    connectionTimeoutMillis: 12000, query_timeout: 15000,
    options: '-c search_path=pg_catalog -c statement_timeout=10000 -c lock_timeout=5000' +
      (detail || inspect || verifyCoverage || verifyLayer1 ? ' -c default_transaction_read_only=on' : ''),
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
    if (verifyCoverage) {
      phase = 'scoped catalogue verification';
      const {rowCount}=await client.query(`SELECT id FROM nukhabapay.provider_accounts
        WHERE tenant_id=$1 AND id=$2 AND provider_code='FINXPLOR' AND status='DISABLED'`,[tenantId,providerAccountId]);
      if(rowCount!==1) throw configError();
      const { verifyFinxplorCoverage } = await import('./verify-finxplor-coverage.mjs');
      const result = await verifyFinxplorCoverage(client, account, productId);
      if ((await client.query('COMMIT')).command !== 'COMMIT') throw configError();
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    await localAccount(client, account, reference);
    if (refreshArtwork) {
      phase = 'current catalogue artwork refresh';
      const {rows} = await client.query(`SELECT source_id,brand,source_country FROM nukhabapay.observed_catalogue_discoveries
        WHERE tenant_id=$1 AND provider_account_id=$2`,[tenantId,providerAccountId]);
      if ((await client.query('COMMIT')).command !== 'COMMIT') throw configError();
      if (!rows.length) throw configError();
      const current = new Map(rows.map(row=>[row.source_id,row]));
      const products = new Map();
      const signal = AbortSignal.timeout(90_000);
      let pages = 0;
      for (let page=1; page<=Math.min(25,Math.ceil(rows.length/100)+2) && products.size<rows.length; page++) {
        const result = await catalogue.unfilteredPage(account,page,signal).catch(()=>null);
        if (!result?.length) break;
        pages++;
        for (const product of result) {
          const original = current.get(product.sourceId);
          if (product.imageUrl && original?.brand===product.brand && original.source_country===product.country) {
            products.set(product.sourceId,product);
          }
        }
      }
      if (!pages) throw configError();
      await client.query('BEGIN');
      await scoped();
      const artworkRows = await saveArtwork(client,account,[...products.values()],new Date().toISOString());
      if ((await client.query('COMMIT')).command !== 'COMMIT') throw configError();
      console.log(JSON.stringify({result:'ARTWORK_STORED',catalogueProducts:rows.length,artworkRows,pages}));
      return;
    }
    if (refreshPrices) {
      phase = 'customer price and Currency API refresh';
      if ((await client.query('COMMIT')).command !== 'COMMIT') throw configError();
      const {refreshFinxplorPrices} = await import('./refresh-finxplor-customer-prices.mjs');
      console.log(JSON.stringify(await refreshFinxplorPrices(client,account,env.NUKHBAPAY_CURRENCY_API_KEY,{manual:manualPrices})));
      return;
    }
    if (verifyLayer1) {
      phase = 'Layer 1 catalogue verification';
      const {rows:[database]} = await client.query(`SELECT current_setting('server_version') AS version,
        current_setting('server_version_num')::int/10000 AS major,
        current_setting('transaction_read_only')='on' AS read_only,
        (SELECT status FROM nukhabapay.provider_accounts WHERE tenant_id=$1 AND id=$2) AS account_status`,
      [tenantId,providerAccountId]);
      if (database?.read_only !== true || (await client.query('COMMIT')).command !== 'COMMIT') throw configError();
      const { verifyFinxplorLayer1 } = await import('./verify-finxplor-layer1.mjs');
      await verifyFinxplorLayer1({account, reference, apiKey:env.NUKHBAPAY_FINXPLOR_API_KEY, database});
      return;
    }
    if (inspect) {
      phase = 'read-only catalogue inspection';
      const { latestProductSetDigest, ...database } = await inspectFinxplorDatabase(client, account, productId);
      if ((await client.query('COMMIT')).command !== 'COMMIT') throw configError();
      const provider = await inspectFinxplorFeed({ origin, account, reference, productId, apiKey: env.NUKHBAPAY_FINXPLOR_API_KEY });
      const sameProductIds = latestProductSetDigest && provider.unfiltered.firstPageProductSetDigest
        ? latestProductSetDigest === provider.unfiltered.firstPageProductSetDigest : null;
      console.log(JSON.stringify({ result: 'INSPECTED', database, provider, latestScanMatchesUnfilteredFirstPage: sameProductIds }, null, 2));
      return;
    }
    // Previous Layer 1 implementation — disabled while rebuilding according to the new approved architecture.
    // if (checkCost) {
    //   phase = 'current AED product scope';
    //   const statement = `SELECT d.id AS "discoveryId", d.source_id AS "sourceProductId", d.source_country AS country,
    //     d.currency, d.denominations, d.last_verified_at AS "scanCompletedAt"
    //   FROM nukhabapay.observed_catalogue_discoveries d
    //   WHERE d.tenant_id=$1 AND d.provider_account_id=$2 AND d.coverage_scope='ARE_GIFT_CARD'
    //     AND d.source_country='ARE' AND d.currency='AED'`;
    //   const scope = [tenantId, providerAccountId];
    //   const prerequisites = productId ? await commercialPrerequisites(client, account, productId) : undefined;
    //   const path = new URL('.local/finxplor-commercial-cost.json', root);
    //   const file = await lstat(path).catch(error => {
    //     if (error.code !== 'ENOENT') throw error;
    //     return undefined;
    //   });
    //   if (!file) {
    //     const { rowCount } = productId
    //       ? await client.query(statement + ' AND d.source_id=$3', [...scope, productId])
    //       : await client.query(statement, scope);
    //     console.log(JSON.stringify({ result: 'COMMERCIAL_INPUT_REQUIRED', currentAedDiscoveries: rowCount,
    //       ...(productId && { sourceProductId: productId, prerequisites }) }));
    //     return;
    //   }
    //   phase = 'commercial price input';
    //   if (!file.isFile() || file.isSymbolicLink() || file.size > 8192) throw configError();
    //   const input = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
    //   if (typeof input?.discoveryId !== 'string' || !uuid.test(input.discoveryId) ||
    //       (productId && input.sourceProductId !== productId)) throw configError();
    //   const { rows: [binding], rowCount } = await client.query(statement + ' AND d.id=$3', [...scope, input.discoveryId]);
    //   if (rowCount !== 1 || !binding) throw configError();
    //   const { validateAedCommercialPriceObservation } =
    //     await import('../packages/application/dist/application/src/catalog/commercial-price-observation.js');
    //   const ageMinutes = env.NUKHBAPAY_FINXPLOR_COMMERCIAL_MAX_AGE_MINUTES ?? '720';
    //   if (!/^[1-9]\d{0,2}$/.test(ageMinutes) || Number(ageMinutes) > 720) throw configError();
    //   let fx;
    //   if (input.settlementCurrency === 'USD') {
    //     phase = 'commercial FX input';
    //     const expectedSource = env.NUKHBAPAY_FINXPLOR_COMMERCIAL_FX_SOURCE;
    //     if (typeof expectedSource !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(expectedSource)) throw configError();
    //     const fxPath = new URL('.local/finxplor-commercial-fx.json', root);
    //     const fxFile = await lstat(fxPath);
    //     if (!fxFile.isFile() || fxFile.isSymbolicLink() || fxFile.size > 8192) throw configError();
    //     fx = { expectedSource, evidence: JSON.parse((await readFile(fxPath, 'utf8')).replace(/^\uFEFF/, '')) };
    //   }
    //   const cost = validateAedCommercialPriceObservation(input, { tenantId, providerAccountId, ...binding },
    //     new Date(), Number(ageMinutes) * 60_000, fx);
    //   await client.query('COMMIT');
    //   console.log(JSON.stringify({ result: 'COMMERCIAL_INPUT_VALIDATED', evidenceDigest: cost.digest,
    //     settlementCurrency: cost.settlementCurrency, validUntil: cost.validUntil, authority: 'NONE',
    //     ...(productId && { sourceProductId: productId, prerequisites }) }));
    //   return;
    // }
    if (detail) {
      phase = 'current saved product';
      const {rows:[saved],rowCount} = await client.query(`SELECT d.observed_at AS "scanAt",d.source_id AS "sourceId",
        d.source_country AS country,d.currency,d.product_name AS name,d.brand,d.category,d.delivery,d.denominations,
        d.min_amount AS "minAmount",d.max_amount AS "maxAmount",d.coverage_scope AS scope
        FROM nukhabapay.current_catalogue_discoveries d
        WHERE d.tenant_id=$1 AND d.provider_account_id=$2 AND d.source_id=$3`, [tenantId, providerAccountId, productId]);
      if (rowCount!==1 || !saved || (await client.query('COMMIT')).command !== 'COMMIT') throw configError();
      phase = 'Finxplor product detail read';
      const observation = await catalogue.detail(account, productId, undefined, saved.scope ?? undefined);
      const missingDetailDenominations = observation.denominations.length === 0;
      const product = missingDetailDenominations ? { ...observation, denominations: saved.denominations } : observation;
      const comparable = ['sourceId','country','currency','name','brand','category','delivery','denominations','minAmount','maxAmount'];
      const differentFields = comparable.filter(key => JSON.stringify(product[key]) !== JSON.stringify(saved[key]));
      console.log(JSON.stringify({result:'DETAIL_READ', product, missingDetailDenominations,
        savedScanAt:saved.scanAt, matchesSavedScan:differentFields.length===0, differentFields, pricing:'UNVERIFIED'}));
      return;
    }
    phase = 'refresh lock';
    const {rows:[lock]} = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',
      [`finxplor-discovery:${tenantId}:${providerAccountId}`]);
    if (lock?.acquired !== true) throw Object.assign(configError(),{code:'55P03'});
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
    const signal = AbortSignal.timeout(global ? 600_000 : 150_000);
    const checkpoint = global ? await openFinxplorCheckpoint(new URL('.local/',root),account) : undefined;
    const report = value=>Object.assign(refreshProgress,value);
    const coverage = global ? await catalogue.globalCatalogue(account,signal,report,checkpoint).catch(async error=>{
      if (error instanceof FinxplorCatalogueChanged) await checkpoint.finish();
      throw error;
    }) : full ? await catalogue.scopedCatalogue(account,approvedCoverage,signal,report) : undefined;
    const partial = coverage?.scope==='PARTIAL_ALL_COUNTRIES';
    const committedCoverage = () => partial
      ? {completedCoverage:null,storedCoverage:coverage.scope,nextPage:coverage.nextPage,verificationPending:coverage.verificationPending,verificationMismatch:coverage.verificationMismatch,providerStatus}
      : {completedCoverage:coverage.scope};
    const products = coverage?.rows ?? (await catalogue.page(account, 1, 1, signal)).products;
    if (!products.length) throw configError();
    if (coverage) Object.assign(refreshProgress, { pages: coverage.pages, products: products.length });
    if (capturedPages && coverage) {
      phase='Finxplor pagination qualification';
      scopeQualification = await import('./test/qualify-finxplor-pagination.mjs');
      refreshProgress.protocolCases = await scopeQualification.qualifyFinxplorPagination(account,reference,capturedPages,coverage);
    }
    const records = products.map(product => ({
      id: randomUUID(), source_id: product.sourceId,
      source_digest: sourceDigest(product),
      product_name: product.name, brand: product.brand, source_country: product.country, currency: product.currency,
      category: product.category, delivery: product.delivery, denominations: product.denominations,
      min_amount: product.minAmount, max_amount: product.maxAmount,
      source_country_label: product.sourceCountryLabel, source_category_label: product.sourceCategoryLabel,
    }));
    phase = 'discovery transaction';
    await client.query('BEGIN');
    await scoped();
    await localAccount(client, account, reference);
    let scanDigest;
    if (coverage) {
      // Sort by SKU itself. The separator can be part of another SKU's prefix.
      const lines = records.slice().sort((a, b) => a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1 : 0)
        .map(row => row.source_id + ':' + row.source_digest);
      scanDigest = createHash('sha256').update(coverage.scope + '\n' + lines.join('\n')).digest('hex');
      const { rows: [latest] } = await client.query(`
        SELECT id,product_count,scan_digest FROM nukhabapay.catalogue_discovery_scans
        WHERE tenant_id=$1 AND provider_account_id=$2 AND coverage_scope=$3 ORDER BY completed_at DESC,id DESC LIMIT 1`,
      [tenantId, providerAccountId, coverage.scope]);
      if (!global && latest && products.length < latest.product_count) throw configError();
      const corrections = await client.query(`INSERT INTO nukhabapay.catalogue_discovery_coverage_corrections(tenant_id,provider_account_id,scan_id)
        SELECT tenant_id,provider_account_id,id FROM nukhabapay.catalogue_discovery_scans
        WHERE tenant_id=$1 AND provider_account_id=$2 AND coverage_scope IS NULL ON CONFLICT DO NOTHING`, [tenantId, providerAccountId]);
      refreshProgress.legacyCorrections = corrections.rowCount;
      if (latest?.scan_digest === scanDigest) {
        if (rehearsal) {
          await scopeQualification.qualifyPartialFinxplorRollback(client,account,latest.id,coverage,scanDigest);
          refreshProgress.partialRollbackChecks=1;
        }
        await client.query(`INSERT INTO nukhabapay.catalogue_discovery_confirmations(tenant_id,provider_account_id,scan_id,run_id,observed_at)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [tenantId,providerAccountId,latest.id,refreshRunId,coverage.observedAt]);
        if (global) await saveArtwork(client,account,products,coverage.observedAt);
        phase = 'discovery commit';
        if ((await client.query(rehearsal ? 'ROLLBACK' : 'COMMIT')).command !== (rehearsal ? 'ROLLBACK' : 'COMMIT')) throw configError();
        console.log(JSON.stringify({ ...refreshProgress, result: rehearsal ? 'REHEARSED' : 'REPLAYED',
          ...committedCoverage(), unchanged: products.length, scanDigest, persisted: !rehearsal }));
        if (global && (!partial || coverage.verificationMismatch)) await checkpoint.finish().catch(()=>undefined);
        return;
      }
    }
    const inserted = await client.query(`
      INSERT INTO nukhabapay.catalogue_discoveries
        (id,tenant_id,provider_account_id,source_id,source_digest,product_name,brand,source_country,
         currency,category,delivery,denominations,min_amount,max_amount,source_country_label,source_category_label)
      SELECT id,$1,$2,source_id,source_digest,product_name,brand,source_country,currency,
        category,delivery,denominations,min_amount,max_amount,source_country_label,source_category_label
      FROM jsonb_to_recordset($3::jsonb) AS p(id uuid,source_id text,source_digest text,product_name text,
        brand text,source_country text,currency text,category text,delivery text,denominations jsonb,
        min_amount text,max_amount text,source_country_label text,source_category_label text)
      ON CONFLICT (tenant_id,provider_account_id,source_id,source_digest) DO NOTHING
      RETURNING id`, [tenantId, providerAccountId, JSON.stringify(records)]);
    const { rows } = await client.query(`
      SELECT d.id FROM nukhabapay.catalogue_discoveries d
      JOIN jsonb_to_recordset($3::jsonb) AS p(source_id text,source_digest text)
        ON (p.source_id,p.source_digest)=(d.source_id,d.source_digest)
      WHERE d.tenant_id=$1 AND d.provider_account_id=$2`,
    [tenantId, providerAccountId, JSON.stringify(records.map(({source_id,source_digest}) => ({source_id,source_digest})))]);
    if (rows.length !== products.length) throw configError();
    if (coverage) {
      const scan = randomUUID();
      await client.query(`INSERT INTO nukhabapay.catalogue_discovery_scans
        (id,tenant_id,provider_account_id,coverage_scope,page_count,product_count,source_observed_at,scan_digest)
        VALUES ($3,$1,$2,$4,$5,$6,$7,$8)`, [tenantId, providerAccountId, scan, coverage.scope,
      coverage.pages, rows.length, coverage.observedAt, scanDigest]);
      const items = await client.query(`INSERT INTO nukhabapay.catalogue_discovery_scan_items
        (tenant_id,provider_account_id,scan_id,discovery_id) SELECT $1,$2,$3,id FROM unnest($4::uuid[]) AS ids(id)`,
      [tenantId, providerAccountId, scan, rows.map(row => row.id)]);
      if (items.rowCount !== products.length) throw configError();
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      await client.query(`INSERT INTO nukhabapay.catalogue_discovery_confirmations(tenant_id,provider_account_id,scan_id,run_id,observed_at)
        VALUES($1,$2,$3,$4,$5)`,[tenantId,providerAccountId,scan,refreshRunId,coverage.observedAt]);
    }
    if (global) await saveArtwork(client,account,products,coverage.observedAt);
    phase = 'discovery commit';
    if ((await client.query(rehearsal ? 'ROLLBACK' : 'COMMIT')).command !== (rehearsal ? 'ROLLBACK' : 'COMMIT')) throw configError();
    console.log(JSON.stringify({ ...(refreshProgress ?? {}), result: rehearsal ? 'REHEARSED' : coverage || inserted.rowCount ? 'IMPORTED' : 'REPLAYED',
      ...(coverage ? { ...committedCoverage(), scanDigest, persisted: !rehearsal }
        : { id: rows[0].id, completeness: 'SAMPLE' }), inserted: inserted.rowCount, unchanged: rows.length - inserted.rowCount,
      products: rows.length, pricing: 'UNVERIFIED', mapping: 'REVIEW_REQUIRED' }));
    if (global && (!partial || coverage.verificationMismatch)) await checkpoint.finish().catch(()=>undefined);
  } finally { await client.end().catch(() => undefined); }
}

main().catch(error => {
  const code = typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : 'UNAVAILABLE';
  console.error(JSON.stringify({ ...refreshProgress, result: 'STOPPED', phase, code,
    ...(providerStatus !== undefined && { providerStatus }) }));
  process.exitCode = 1;
});
