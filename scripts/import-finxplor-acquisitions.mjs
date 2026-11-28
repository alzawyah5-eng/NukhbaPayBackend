import { lstat, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { AcquisitionNormalization, acquisitionReference, acquisitionScopeKey, validateAcquisitionPolicy } from '../packages/application/dist/application/src/index.js';
import { createPostgresAcquisitionStore } from '../packages/database/dist/database/src/index.js';
import { AcquisitionNormalizationWorker } from '../apps/worker/dist/jobs/acquisition-normalization/worker.js';

const { Pool } = createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const root = new URL('../',import.meta.url);
const reference = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const unavailable = code => Object.assign(new Error('Finxplor acquisition import unavailable'), { code });
const scopeMatches = (scope, value) => acquisitionScopeKey(scope) === acquisitionScopeKey(value);
const liveSource = 'FINXPLOR_REVIEWED_EXPORT';

async function readPrivateJson(name, limit) {
  const path = new URL('.local/' + name,root);
  const file = await lstat(path).catch(error => {
    if (error.code === 'ENOENT') throw unavailable('APPROVED_EVIDENCE_REQUIRED');
    throw error;
  });
  if (!file.isFile() || file.isSymbolicLink() || file.size > limit) throw unavailable('INVALID_EVIDENCE_FILE');
  return JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
}

export async function importFinxplorAcquisitions({ scope, policyFile, bundle, store, now = () => new Date() }) {
  if (!scopeMatches(scope,policyFile) || !scopeMatches(scope,bundle) ||
      policyFile.schema_version !== 1 || bundle.schema_version !== 1 ||
      !reference(policyFile.approvalReference) || !reference(bundle.exportReference) ||
      !reference(bundle.reviewReference) || bundle.policyVersion !== policyFile.policy?.version ||
      policyFile.policy?.provenance !== 'LIVE' || policyFile.policy?.approvedCostSource !== liveSource ||
      !Array.isArray(bundle.costs) || bundle.costs.length < 1 || bundle.costs.length > 100 ||
      !Array.isArray(bundle.rates) || bundle.rates.length > 100) throw unavailable('INVALID_APPROVED_EVIDENCE');
  const policy = policyFile.policy;
  validateAcquisitionPolicy(policy);
  if (!policy.permittedUses.includes('INTERNAL_REVIEW')) throw unavailable('INTERNAL_REVIEW_NOT_PERMITTED');
  const costs = new Map();
  const batches = new Map();
  for (const cost of bundle.costs) {
    if (!scopeMatches(scope,cost) || cost.provenance !== 'LIVE' || cost.source !== liveSource ||
        !reference(cost.sourceReference) || costs.has(cost.offerVersionId) ||
        !['VERIFIED_ACCOUNT_QUOTE','VERIFIED_WALLET_DEBIT'].includes(cost.basis))
      throw unavailable('INVALID_COST_EVIDENCE');
    const ref = acquisitionReference(cost);
    costs.set(cost.offerVersionId, {...cost,commercialReview:{
      exportReference:bundle.exportReference,reviewReference:bundle.reviewReference,
      policyApprovalReference:policyFile.approvalReference,
    }});
    const batch = batches.get(ref.catalogue.snapshotId) ?? [];
    batch.push(ref);
    batches.set(ref.catalogue.snapshotId,batch);
  }
  const rates = new Map();
  for (const rate of bundle.rates) {
    if (!scopeMatches(scope,rate) || rate.provenance !== 'LIVE' || rate.policyVersion !== policy.version ||
        rate.sourceCurrency === 'AED' || rate.source !== policy.approvedFxSource || rates.has(rate.sourceCurrency))
      throw unavailable('INVALID_FX_EVIDENCE');
    rates.set(rate.sourceCurrency,rate);
  }
  for (const batch of batches.values()) {
    const catalogue = JSON.stringify(batch[0].catalogue);
    if (batch.some(ref=>JSON.stringify(ref.catalogue)!==catalogue)) throw unavailable('CATALOGUE_EVIDENCE_CONFLICT');
  }
  const normalization = new AcquisitionNormalization({
    scopes:[scope],store,now,readPolicy:async()=>policy,
    costSource:{source:liveSource,readCost:async req=>costs.get(req.offerVersionId)},
    fxSources:new Map(policy.approvedFxSource ? [[policy.approvedFxSource, {
      source:policy.approvedFxSource,readApprovedRate:async req=>rates.get(req.currency)??null,
    }]] : []),
  });
  // The result transaction writes its outbox event. A Layer 2 publisher is composed separately.
  const worker = new AcquisitionNormalizationWorker({normalization,batchLimit:100,normalizationTimeoutMs:10000,
    deliveryTimeoutMs:10000,outbox:store,publisher:{publish:async()=>{throw unavailable('LAYER2_NOT_CONFIGURED');}}});
  const reports = [];
  const signal = AbortSignal.timeout(240_000);
  for (const offers of batches.values()) {
    reports.push(await worker.runBatch({scope,runId:randomUUID(),sourceCatalogue:offers[0].catalogue,
      offers,use:'INTERNAL_REVIEW'},signal));
  }
  return reports;
}

async function run() {
  if (process.argv.length !== 2 || process.platform !== 'win32') throw unavailable('UNSUPPORTED_ENVIRONMENT');
  const [policyFile,bundle] = await Promise.all([
    readPrivateJson('finxplor-layer1-policy.json',16384),readPrivateJson('finxplor-layer1-evidence.json',524288),
  ]);
  const tenantId = policyFile.tenantId, providerAccountId = policyFile.providerAccountId;
  const local = parseEnv(await readFile(new URL('.env',root),'utf8'));
  if (providerAccountId !== local.NUKHBAPAY_FINXPLOR_PROVIDER_ACCOUNT_ID) throw unavailable('ACCOUNT_MISMATCH');
  const scope = { tenantId, providerAccountId, provenance:'LIVE' };
  acquisitionScopeKey(scope);
  const raw = process.env.NUKHBAPAY_FINXPLOR_LAYER1_WRITER_URL;
  if (!raw) throw unavailable('RESTRICTED_WRITER_REQUIRED');
  const url = new URL(raw);
  if (!['postgresql:','postgres:'].includes(url.protocol) || url.hostname !== '127.0.0.1' ||
      url.port !== '5432' || url.pathname !== '/nukhbapay_catalogue' || url.search || url.hash ||
      !url.password || url.username !== 'nukhbapay_layer1_finxplor')
    throw unavailable('RESTRICTED_WRITER_REQUIRED');
  const pool = new Pool({connectionString:raw,max:2,connectionTimeoutMillis:5000,query_timeout:10000,
    options:'-c search_path=pg_catalog -c statement_timeout=8000'});
  pool.on('error',()=>console.error('Finxplor acquisition PostgreSQL connection unavailable'));
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SELECT set_config('nukhabapay.tenant_id',$1,true),set_config('nukhabapay.layer1_account_id',$2,true)",
        [tenantId,providerAccountId]);
      const { rows:[target] } = await client.query(`SELECT
        system_user='scram-sha-256:nukhbapay_layer1_finxplor' AND row_security_active('nukhabapay.layer1_results')
        AND pg_get_userbyid(d.datdba)='nukhbapay_catalogue_migrator'
        AND shobj_description(d.oid,'pg_database')~'^nukhbapay-catalogue-local:[a-f0-9]{32}$'
        AND EXISTS(SELECT FROM nukhabapay.layer1_active_accounts WHERE tenant_id=$1 AND provider_account_id=$2 AND provider_code='FINXPLOR')
        AS verified FROM pg_database d WHERE datname=current_database()`,[tenantId,providerAccountId]);
      if (!target?.verified) throw unavailable('ACTIVE_FINXPLOR_ACCOUNT_REQUIRED');
      await client.query('COMMIT');
    } finally {client.release(true);}
    const store = createPostgresAcquisitionStore(pool,[scope]);
    const reports = await importFinxplorAcquisitions({scope,policyFile,bundle,store});
    const counts = {NORMALIZED:0,ALREADY_PROCESSED:0,QUOTE_REQUIRED:0,COST_UNCONFIRMED:0,BLOCKED:0,RETRY_PENDING:0};
    for (const report of reports) for (const key of Object.keys(counts)) counts[key] += report.counts[key];
    console.log(JSON.stringify({result:'FINXPLOR_ACQUISITIONS_PROCESSED',counts,reports}));
    if (counts.BLOCKED || counts.RETRY_PENDING) process.exitCode=1;
  } finally {await pool.end();}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(error=>{
    const code = typeof error?.code==='string'&&/^[A-Z0-9_]{5,60}$/.test(error.code)?error.code:'ACQUISITION_IMPORT_UNAVAILABLE';
    console.error(JSON.stringify({result:'STOPPED',code}));
    process.exitCode=1;
  });
}
