import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadLocalCatalogueMigrations, installLocalCatalogueMigrations } from '../local-catalogue-setup.mjs';
import { AcquisitionNormalization, prepareNormalization } from '../../packages/application/dist/application/src/index.js';
import { createPostgresAcquisitionStore } from '../../packages/database/dist/database/src/index.js';
import { AcquisitionNormalizationWorker } from '../../apps/worker/dist/jobs/acquisition-normalization/worker.js';

import { refreshFinxplorPrices, priceSlot } from '../refresh-finxplor-customer-prices.mjs';
import { readCurrencyApiAedRates } from '../../packages/provider-adapters/src/currency-api-aed-rates.ts';
import { importFinxplorAcquisitions } from '../import-finxplor-acquisitions.mjs';

const { Client, Pool } = createRequire(new URL('../../packages/database/package.json', import.meta.url))('pg');
const bin = process.env.NUKHBAPAY_LAYER1_PG_BIN ?? path.join(process.env.ProgramFiles ?? '', 'PostgreSQL','18','bin');
const parent = realpathSync(tmpdir());
const work = mkdtempSync(path.join(parent, 'nukhbapay-layer1-'));
const data = path.join(work, 'pgdata');
const secret = randomBytes(32).toString('hex');
const readerSecret = randomBytes(32).toString('hex');
const workerSecret = randomBytes(32).toString('hex');
const db = 'nukhbapay_catalogue';
const workerRole = 'nukhbapay_layer1_fixture_worker';
const owner = 'nukhbapay_catalogue_migrator';
const signal = new AbortController().signal;
const use = 'LAYER_2_PRICING';
let admin, pool, reader, started = false, stage = 'initialize private PostgreSQL', port;
const fixtures = new Map();

function pg(program, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('PG')));
  try {
    execFileSync(path.join(bin, program + '.exe'), args, { windowsHide: true, env, stdio: 'ignore', timeout: 60000 });
  } catch {
    throw new Error(program + ' failed for disposable Layer 1 cluster');
  }
}

async function seed(tenantId, providerAccountId, minusMs = 30_000, providerCode = 'SYNTH_LAYER1') {
  const scope = {tenantId, providerAccountId};
  const at = offset => new Date(Date.now() + offset).toISOString();
  if (!fixtures.has(providerAccountId)) {
    await admin.query(`INSERT INTO nukhabapay.tenants (id,tenant_key) VALUES($1,$1::uuid::text) ON CONFLICT DO NOTHING`, [tenantId]);
    await admin.query(`INSERT INTO nukhabapay.provider_accounts (id,tenant_id,provider_code,external_account_key,status)
      VALUES($1,$2,$3,$1::uuid::text,'ACTIVE')`, [providerAccountId, tenantId,providerCode]);
    const product = randomUUID(), mapping = randomUUID();
    await admin.query(`INSERT INTO nukhabapay.products (id,canonical_product_key,brand,redemption_country,currency,
      face_value_minor,fulfillment_method,terms_version) VALUES($1,$1::uuid::text,'Synthetic','AE','AED',5000,'DIGITAL_PIN','v1')`, [product]);
    await admin.query(`INSERT INTO nukhabapay.product_mappings
      (id,tenant_id,provider_account_id,provider_sku,product_id,mapping_version,status,provenance_kind,provenance)
      VALUES($1,$2,$3,'fixture', $4,1,'APPROVED','IMPORT','{"source":"layer1-fixture"}')`, [mapping, tenantId, providerAccountId, product]);
    fixtures.set(providerAccountId, {product,mapping});
  }
  const {product,mapping} = fixtures.get(providerAccountId);
  const snapshotId = randomUUID(), offerVersionId = randomUUID(), observedAt = at(-minusMs);
  await admin.query(`INSERT INTO nukhabapay.provider_snapshots
    (id,tenant_id,provider_account_id,snapshot_key,source_version,observed_at,status,row_count,completed_at)
    VALUES($1,$2,$3,$1::uuid::text,'source-v1',$4,'COMPLETE',1,$4)`, [snapshotId, tenantId, providerAccountId, observedAt]);
  await admin.query(`INSERT INTO nukhabapay.provider_offers
    (id,tenant_id,provider_account_id,provider_snapshot_id,product_mapping_id,product_mapping_version,product_id,
    face_value_minor,provider_offer_key,provider_debit_minor,additional_provider_fee_minor,available,observed_at,valid_until)
    VALUES($1,$2,$3,$4,$5,1,$6,5000,'same-offer',4200,0,true,$7,$8)`,
  [offerVersionId, tenantId, providerAccountId, snapshotId, mapping, product, observedAt, at(300_000)]);
  return {
    ...scope, offerKey: 'same-offer', offerVersionId, catalogue: {snapshotId, sourceVersion:'source-v1', completeness:'COMPLETE'},
    costSnapshotId: randomUUID(), provenance:'SYNTHETIC', source:'fixture-quote-source', basis:'VERIFIED_ACCOUNT_QUOTE',
    acquisition: { amount:'11.63', currency:'USD' }, faceValue:{ amount:'50.00', currency:'AED' },
    settlement:{ amount:'11.62',currency:'USD' }, retail:{ amount:'53.00',currency:'AED' },
    sourceReference:'synthetic-quote', observedAt, retrievedAt:observedAt, validUntil:at(250_000),
  };
}

async function check() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error',reject).listen(0,'127.0.0.1',resolve));
  port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  assert.ok(port > 1024 && ![5432,55437].includes(port));
  const pwfile = path.join(work, 'initial-password');
  writeFileSync(pwfile, secret+'\n', {flag:'wx',mode:0o600});
  try { pg('initdb', ['-D',data,'-U','postgres','--locale=C','--encoding=UTF8','-A','scram-sha-256','--pwfile='+pwfile]); }
  finally { rmSync(pwfile); }
  pg('pg_ctl', ['-D',data,'-l',path.join(work,'postgres.log'),'-o',`-p ${port} -h 127.0.0.1`,'-w','start']);
  started = true;
  const config = {host:'127.0.0.1',port,user:'postgres',password:secret,connectionTimeoutMillis:5000};
  admin = new Client({...config,database:'postgres'});
  await admin.connect();
  const { rows:[physical] } = await admin.query("SELECT current_setting('data_directory') AS directory, inet_server_port() AS port, current_setting('server_version') AS version, current_setting('server_version_num')::int/10000 AS major");
  assert.equal(path.normalize(physical.directory).toLowerCase(), path.normalize(data).toLowerCase());
  assert.equal(physical.port,port);
  assert.equal(physical.major,18);
  for (const role of [owner,'nukhbapay_catalogue_runtime'])
    await admin.query('CREATE ROLE '+role+' NOLOGIN NOINHERIT');
  await admin.query(`CREATE ROLE nukhbapay_catalogue_reader LOGIN NOINHERIT PASSWORD '${readerSecret}'`);
  await admin.query(`CREATE ROLE ${workerRole} LOGIN NOINHERIT PASSWORD '${workerSecret}'`);
  await admin.query(`CREATE DATABASE ${db} OWNER ${owner}`);
  await admin.end();
  admin = new Client({...config,database:db});
  await admin.connect();
  stage = 'apply checksummed catalogue migrations';
  const migrations = await loadLocalCatalogueMigrations();
  await admin.query('SET ROLE '+owner);
  assert.equal((await installLocalCatalogueMigrations(admin,migrations.slice(0,-10),{initialise:true})).length,18);
  assert.deepEqual(await installLocalCatalogueMigrations(admin,migrations.slice(0,-9)), ['local_acquisition_normalization_016']);
  assert.deepEqual(await installLocalCatalogueMigrations(admin,migrations.slice(0,-8)), ['local_finxplor_acquisition_projection_017']);
  assert.deepEqual(await installLocalCatalogueMigrations(admin,migrations.slice(0,-7)), ['local_acquisition_exact_valuation_018']);
  assert.deepEqual(await installLocalCatalogueMigrations(admin,migrations.slice(0,-6)), ['local_finxplor_customer_price_fx_019']);
  assert.deepEqual(await installLocalCatalogueMigrations(admin,migrations.slice(0,-5)), ['local_finxplor_manual_xe_refresh_020']);
  assert.deepEqual(await installLocalCatalogueMigrations(admin,migrations.slice(0,-4)), ['local_finxplor_currency_api_rates_021']);
  assert.deepEqual(await installLocalCatalogueMigrations(admin,migrations.slice(0,-3)), ['local_finxplor_catalogue_artwork_022']);
  assert.deepEqual(await installLocalCatalogueMigrations(admin,migrations.slice(0,-2)), ['local_finxplor_resumable_catalogue_023']);
  assert.deepEqual(await installLocalCatalogueMigrations(admin,migrations.slice(0,-1)), ['local_finxplor_variable_page_coverage_024']);
  assert.deepEqual(await installLocalCatalogueMigrations(admin,migrations), ['local_finxplor_partial_generation_projection_025']);
  assert.deepEqual(await installLocalCatalogueMigrations(admin,migrations,{check:true}), []);
  await admin.query('RESET ROLE');

  stage = 'enrol synthetic cost fixtures';
  const scope = {tenantId:randomUUID(),providerAccountId:randomUUID(),provenance:'SYNTHETIC'};
  const sameTenant = {tenantId:scope.tenantId,providerAccountId:randomUUID(),provenance:'SYNTHETIC'};
  const other = {tenantId:randomUUID(),providerAccountId:randomUUID(),provenance:'SYNTHETIC'};
  const first = await seed(scope.tenantId, scope.providerAccountId);
  await seed(sameTenant.tenantId,sameTenant.providerAccountId);
  await seed(other.tenantId,other.providerAccountId);
  const grants = readFileSync(new URL('../../packages/database/roles/grant_layer1_backend.sql',import.meta.url),'utf8')
    .replaceAll(':"layer1_role"', workerRole)
    .replace(":'layer1_role'", "'"+workerRole+"'")
    .replace(":'tenant_id'", "'"+scope.tenantId+"'")
    .replace(":'provider_account_id'", "'"+scope.providerAccountId+"'");
  await admin.query('SET ROLE '+owner);
  await admin.query(grants);
  await admin.query('RESET ROLE');
  await admin.query(`CREATE TABLE nukhabapay.layer1_fixture_effect (id uuid PRIMARY KEY);
    GRANT INSERT ON nukhabapay.layer1_fixture_effect TO ${workerRole}`);
  pool = new Pool({...config,database:db,user:workerRole,password:workerSecret,max:6});
  const store = createPostgresAcquisitionStore(pool, [scope,sameTenant,other]);
  const at = offset => new Date(Date.now()+offset).toISOString();
  const policy = {
    version:'fixture-policy-v1', revision:1, provenance:'SYNTHETIC', approvedCostSource:'fixture-quote-source',
    approvedFxSource:'fixture-direct-fx', effectiveFrom:at(-120_000), validUntil:at(300_000),
    maxRateAgeMs:120_000, maxCostAgeMs:120_000, currencyScales:{AED:2,USD:2},
    rateScale:12, rounding:'HALF_UP', permittedUses:[use], refreshIntervalMs:10_000,
  };
  const fx = {
    ...scope, id:randomUUID(), direction:'AED_PER_SOURCE_UNIT', basis:'APPROVED_DIRECT', sourceCurrency:'USD',
    targetCurrency:'AED', rate:'3.6725', source:policy.approvedFxSource, sourceReference:'synthetic-rate',
    approvalReference:'synthetic-review', effectiveAt:at(-60_000), retrievedAt:at(-45_000),
    validUntil:at(175_000), policyVersion:policy.version,
  };
  const prepared = (cost, rate=fx) => prepareNormalization(cost,rate,policy,use,at(0));

  stage = 'rollback outbox and source writes together';
  await admin.query(`CREATE FUNCTION nukhabapay.layer1_fixture_fail() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'fixture' USING ERRCODE='40001'; END $$;
    CREATE TRIGGER layer1_fixture_fail BEFORE INSERT ON nukhabapay.layer1_outbox
    FOR EACH STATEMENT EXECUTE FUNCTION nukhabapay.layer1_fixture_fail()`);
  await assert.rejects(store.save(prepared(first),'rollback'), /storage unavailable/);
  const {rows:[empty]} = await admin.query(`SELECT
    (SELECT count(*)::int FROM nukhabapay.layer1_cost_snapshots) AS costs,
    (SELECT count(*)::int FROM nukhabapay.layer1_fx_snapshots) AS rates,
    (SELECT count(*)::int FROM nukhabapay.layer1_results) AS results`);
  assert.deepEqual(empty,{costs:0,rates:0,results:0});
  await admin.query('DROP TRIGGER layer1_fixture_fail ON nukhabapay.layer1_outbox');

  stage = 'concurrent replay, exact history and scope';
  const withApprovedFx = new AcquisitionNormalization({
    scopes:[scope], readPolicy:async()=>policy, store, now:()=>new Date(),
    costSource:{source:policy.approvedCostSource,readCost:async()=>first},
    fxSources:new Map([[fx.source,{source:fx.source,readApprovedRate:async request=>{
      assert.equal(request.currency,'USD');
      assert.equal(request.policyVersion,policy.version);
      assert.equal(request.providerAccountId,scope.providerAccountId);
      return fx;
    }}]]),
  });
  const replays = await Promise.all(Array.from({length:6}, () => withApprovedFx.normalize(first,use,'concurrent',signal)));
  assert.equal(replays.filter(entry=>entry.status==='NORMALIZED').length,1);
  const original = replays[0].result;
  assert.equal(new Set(replays.map(entry=>entry.result.resultId)).size,1);
  assert.equal(original.calculation.amount,'42.711175');
  assert.equal(original.calculation.displayAmount,'42.71');
  const pricingRead = await store.readCurrent(scope,first.offerKey,use);
  assert.equal(pricingRead.calculation.amount,'42.711175');
  const {rows:[raw]}=await admin.query('SELECT aed_amount::text AS preview,calculation FROM nukhabapay.layer1_results WHERE id=$1',[original.resultId]);
  assert.equal(raw.preview,'42.71');
  assert.equal(raw.calculation.exactAmount,'42.711175');
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM nukhabapay.layer1_outbox')).rows[0].n,1);
  const historical = await store.readResult(scope,original.resultId,use);
  assert.deepEqual(historical,original);
  assert.deepEqual(prepareNormalization(historical.cost,historical.fx,historical.policy,use,historical.normalizedAt).calculation,
    historical.calculation);
  const legacyId=randomUUID();
  const legacyCalc={amount:raw.preview,currency:'AED',direction:original.calculation.direction,
    workingScale:original.calculation.workingScale,resultScale:2,rounding:'HALF_UP',calculatorVersion:'aed-acquisition-v1'};
  await admin.query(`INSERT INTO nukhabapay.layer1_results
    (tenant_id,provider_account_id,id,cost_snapshot_id,fx_snapshot_id,policy_version,calculator_version,normalized_at,valid_until,aed_amount,calculation)
    SELECT tenant_id,provider_account_id,$2,cost_snapshot_id,fx_snapshot_id,policy_version,'aed-acquisition-v1',normalized_at,valid_until,
      aed_amount,$3 FROM nukhabapay.layer1_results WHERE id=$1`, [original.resultId,legacyId,legacyCalc]);
  const historicalV1=await store.readResult(scope,legacyId,use);
  assert.equal(historicalV1.calculation.calculatorVersion,'aed-acquisition-v1');
  assert.equal(historicalV1.calculation.amount,'42.711175');
  assert.equal((await store.readCurrent(scope,first.offerKey,use)).resultId,original.resultId);
  await assert.rejects(store.save(prepared({...first, acquisition:{amount:'11.64',currency:'USD'}}),'changed'), /IMMUTABLE_EVIDENCE_CONFLICT/);
  await assert.rejects(store.readResult(other,original.resultId,use),/SCOPE_DENIED/);
  await assert.rejects(store.readResult(sameTenant,original.resultId,use),/SCOPE_DENIED/);
  const live = createPostgresAcquisitionStore(pool,[{...scope,provenance:'LIVE'}]);
  assert.equal(await live.readResult(scope,original.resultId,use),null);
  assert.equal(await live.claim(scope,1000),null);
  const direct = await pool.connect();
  try {
    await direct.query('BEGIN');
    await direct.query("SELECT set_config('nukhabapay.tenant_id',$1,true),set_config('nukhabapay.layer1_account_id',$2,true)",
      [sameTenant.tenantId,sameTenant.providerAccountId]);
    assert.equal((await direct.query('SELECT * FROM nukhabapay.layer1_results')).rowCount,0);
    assert.equal((await direct.query('SELECT * FROM nukhabapay.layer1_source_offers')).rowCount,0);
    await direct.query('ROLLBACK');
  } finally {direct.release();}
  await assert.rejects(pool.query('UPDATE nukhabapay.layer1_results SET aed_amount=1'),{code:'42501'});
  await assert.rejects(pool.query('SELECT provider_debit_minor FROM nukhabapay.provider_offers'),{code:'42501'});

  stage = 'outbox retries, stable event identity and transactional inbox';
  const lease = await store.claim(scope,1000);
  assert.ok(lease);
  assert.equal(await store.claim(scope,1000),null);
  assert.equal(await store.settle(lease,false),true);
  assert.equal(await store.claim(scope,1000),null);
  await admin.query('UPDATE nukhabapay.layer1_outbox SET next_attempt_at=clock_timestamp()');
  const retry = await store.claim(scope,5000);
  assert.deepEqual(retry.event,lease.event);
  await assert.rejects(store.consume({...retry.event,correlation_id:'forged'},'fixture-consumer',use,async()=>{}),
    /UNVERIFIED_NORMALIZATION_EVENT/);
  assert.notEqual(retry.lease,lease.lease);
  assert.equal(await store.settle(lease,true),false);
  const writeEffect = tx=>tx.query('INSERT INTO nukhabapay.layer1_fixture_effect VALUES($1)',[retry.event.event_id]);
  await assert.rejects(store.consume(retry.event,'fixture-consumer',use,async tx=>{
    await writeEffect(tx);
    throw new Error('rollback fixture effect');
  }), /storage unavailable/);
  const effects = async()=> (await admin.query('SELECT count(*)::int AS n FROM nukhabapay.layer1_fixture_effect')).rows[0].n;
  assert.equal(await effects(),0);
  assert.equal(await store.consume(retry.event,'fixture-consumer',use,writeEffect),'APPLIED');
  assert.equal(await store.consume(retry.event,'fixture-consumer',use,writeEffect),'ALREADY_CONSUMED');
  assert.equal(await effects(),1);
  assert.equal(await store.settle(retry,true),true);

  stage = 'batch normalization and stale worker fencing';
  await delay(1);
  const successor = await seed(scope.tenantId,scope.providerAccountId,10_000);
  assert.equal(await store.readCurrent(scope,first.offerKey,use),null);
  const newCost = {...successor, acquisition:{amount:'39.005',currency:'AED'}};
  assert.throws(()=>prepared(newCost,null), /precision/);
  const identity = {...newCost, acquisition:{amount:'39.01',currency:'AED'}};
  const normalization = new AcquisitionNormalization({
    scopes:[scope], readPolicy:async()=>policy, fxSources:new Map(), store, now:()=>new Date(),
    costSource:{source:policy.approvedCostSource,readCost:async()=>identity},
  });
  let forwarded;
  const worker = new AcquisitionNormalizationWorker({normalization,outbox:store,batchLimit:10,normalizationTimeoutMs:3000,deliveryTimeoutMs:1000,
    publisher:{publish:async event=>{forwarded=event;}}});
  const batch = {scope,runId:'fixture-run',sourceCatalogue:identity.catalogue,offers:[identity],use};
  const {report,nextDueAt} = await worker.runScheduledBatch(batch,policy,identity.retrievedAt,signal);
  assert.equal(Date.parse(nextDueAt),Date.parse(identity.retrievedAt)+policy.refreshIntervalMs);
  assert.equal(report.counts.NORMALIZED,1, JSON.stringify(report));
  assert.deepEqual(report.sourceCatalogue,identity.catalogue);
  assert.equal((await worker.runBatch(batch,signal)).counts.ALREADY_PROCESSED,1);
  const delayed = await store.save(prepared({...first,costSnapshotId:randomUUID()}),'delayed');
  const current = await store.readCurrent(scope,first.offerKey,use);
  assert.equal(current.calculation.amount,'39.01');
  assert.equal(current.fx.rate,'1');
  assert.equal(current.cost.offerVersionId,identity.offerVersionId);
  assert.notEqual(current.resultId,delayed.result.resultId);
  assert.equal(await store.consume(retry.event,'other-consumer',use,async()=>assert.fail('stale effect')),'STALE');
  assert.equal(await worker.deliverOnce(scope,signal),'DELIVERED');
  assert.equal(forwarded.type,'provider.acquisition-cost.normalized.v1');
  assert.equal(typeof forwarded.result_id,'string');
  assert.equal(Object.hasOwn(forwarded,'acquisition'),false);

  stage = 'persist and read an exact sub-fil valuation';
  const tiny = await seed(scope.tenantId,scope.providerAccountId,5000);
  const tinyRate = {...fx,id:randomUUID(),rate:'0.004'};
  const tinyPrepared = prepared({...tiny,acquisition:{amount:'1.00',currency:'USD'}},tinyRate);
  const tinyResult = await store.save(tinyPrepared,'sub-fil-fixture');
  const tinyRead=await store.readCurrent(scope,tiny.offerKey,use);
  assert.equal(tinyRead.resultId,tinyResult.result.resultId);
  assert.equal(tinyRead.calculation.amount,'0.00400');
  assert.equal(tinyRead.calculation.displayAmount,'0.00');
  assert.throws(()=>prepared(tiny,{...fx,validUntil:at(-1000)}), /FX_STALE_OR_INVALID/);

  console.log(JSON.stringify({type:'DISPOSABLE_SYNTHETIC_PRECISION_EVIDENCE',postgresVersion:physical.version,
    layer2:{resultId:pricingRead.resultId,acquisition:pricingRead.cost.acquisition,
      costSnapshotId:pricingRead.cost.costSnapshotId,costReference:pricingRead.cost.sourceReference,
      fx:{id:pricingRead.fx.id,rate:pricingRead.fx.rate,direction:pricingRead.fx.direction,basis:pricingRead.fx.basis,
        source:pricingRead.fx.source,effectiveAt:pricingRead.fx.effectiveAt,validUntil:pricingRead.fx.validUntil,
        sourceReference:pricingRead.fx.sourceReference},
      calculation:pricingRead.calculation,validUntil:pricingRead.validUntil},
    identity:{resultId:current.resultId,rate:current.fx.rate,amount:current.calculation.amount,currency:current.calculation.currency},
    replayCount:replays.length,uniqueResults:new Set(replays.map(entry=>entry.result.resultId)).size,
    historicalV1Exact:historicalV1.calculation.amount,subFil:{amount:tinyRead.calculation.amount,display:tinyRead.calculation.displayAmount}}));

  stage = 'verified Finxplor export import and staff projection';
  const reviewedScope = {tenantId:randomUUID(),providerAccountId:randomUUID(),provenance:'LIVE'};
  const reviewed = await seed(reviewedScope.tenantId, reviewedScope.providerAccountId, 20_000,'FINXPLOR');
  const discoveryId = randomUUID();
  await admin.query(`INSERT INTO nukhabapay.catalogue_discoveries
    (id,tenant_id,provider_account_id,source_id,source_digest,product_name,brand,source_country,currency,category,delivery,denominations,min_amount,max_amount)
    VALUES($1,$2,$3,'fixture',repeat('d',64),'Finxplor integration fixture','Fixture','ARE','AED','Gift Card','PIN','["50.00"]','50','50')`,
  [discoveryId, reviewed.tenantId, reviewed.providerAccountId]);
  await admin.query('SET ROLE '+owner);
  await admin.query('INSERT INTO nukhabapay.layer1_account_grants VALUES($1,$2,$3)',
    [workerRole, reviewed.tenantId, reviewed.providerAccountId]);
  await admin.query('RESET ROLE');
  reader = new Client({...config,database:db,user:'nukhbapay_catalogue_reader',password:readerSecret});
  await reader.connect();
  await reader.query("SELECT set_config('nukhabapay.tenant_id',$1,false)", [reviewed.tenantId]);
  const summaries = (tenant = reviewed.tenantId, id = discoveryId) =>
    reader.query('SELECT * FROM nukhabapay.staff_finxplor_acquisition_summary($1,$2)', [tenant,[id]]);
  stage = 'Finxplor catalogue artwork ownership and public URL validation';
  await admin.query('BEGIN');
  await admin.query('SET LOCAL ROLE nukhbapay_catalogue_runtime');
  await admin.query("SELECT set_config('nukhabapay.tenant_id',$1,true)",[reviewed.tenantId]);
  const image = 'https://finxplorconnect.com/api/v1/media/YXJ0d29yaw';
  const artwork = 'INSERT INTO nukhabapay.finxplor_catalogue_artwork VALUES($1,$2,$3,$4,now())';
  await admin.query(artwork,[reviewed.tenantId,reviewed.providerAccountId,discoveryId,image]);
  await admin.query('COMMIT');
  assert.deepEqual((await reader.query('SELECT image_url FROM nukhabapay.finxplor_catalogue_artwork')).rows,[{image_url:image}]);
  await reader.query("SELECT set_config('nukhabapay.tenant_id',$1,false)",[other.tenantId]);
  assert.equal((await reader.query('SELECT FROM nukhabapay.finxplor_catalogue_artwork')).rowCount,0);
  await reader.query("SELECT set_config('nukhabapay.tenant_id',$1,false)",[reviewed.tenantId]);
  await assert.rejects(admin.query("UPDATE nukhabapay.finxplor_catalogue_artwork SET image_url='https://other.example/logo.png'"),{code:'23514'});
  stage = 'verified Finxplor export import and staff projection';
  assert.deepEqual((await summaries()).rows.map(row=>[row.state,row.aed_amount]), [['QUOTE_REQUIRED',null]]);
  assert.equal((await summaries(other.tenantId)).rowCount,0);
  await assert.rejects(reader.query('SELECT aed_amount FROM nukhabapay.layer1_results'),{code:'42501'});
  await assert.rejects(pool.query('SELECT * FROM nukhabapay.staff_finxplor_acquisition_summary($1,$2)',
    [reviewed.tenantId,[discoveryId]]),{code:'42501'});
  const reviewedStore = createPostgresAcquisitionStore(pool,[reviewedScope]);
  const reviewedPolicy = {...policy, provenance:'LIVE', version:'reviewed-fixture-v1', approvedCostSource:'FINXPLOR_REVIEWED_EXPORT',
    permittedUses:['INTERNAL_REVIEW']};
  const policyFile = {...reviewedScope,schema_version:1,approvalReference:'operator-fixture-approval',policy:reviewedPolicy};
  const bundle = {...reviewedScope,schema_version:1,policyVersion:reviewedPolicy.version,exportReference:'vendor-fixture',
    reviewReference:'review-fixture',
    costs:[{...reviewed,provenance:'LIVE',source:'FINXPLOR_REVIEWED_EXPORT',acquisition:{amount:'42.71',currency:'AED'}}],rates:[]};
  const runReviewed = () => importFinxplorAcquisitions({scope:reviewedScope,policyFile,bundle,store:reviewedStore});
  assert.equal((await runReviewed())[0].counts.NORMALIZED,1);
  assert.equal((await runReviewed())[0].counts.ALREADY_PROCESSED,1);
  const savedReviewed = await reviewedStore.readCurrent(reviewedScope,reviewed.offerKey,'INTERNAL_REVIEW');
  assert.equal(savedReviewed.cost.commercialReview.exportReference,'vendor-fixture');
  const shown = (await summaries()).rows;
  assert.deepEqual(shown.map(row=>[row.state,row.aed_amount,row.face_amount,row.face_currency]),
    [['NORMALIZED','42.71','50.00','AED']]);
  await seed(reviewedScope.tenantId,reviewedScope.providerAccountId,5000,'FINXPLOR');
  assert.equal((await summaries()).rows[0].state,'QUOTE_REQUIRED');
  console.info('Finxplor projection passed: missing quote, reviewed import and replay, restricted reader, real NUMERIC amount and newer offer fence.');
  stage = 'store source customer price and exact Currency API conversion';
  assert.equal(priceSlot(Date.parse('2026-11-27T07:59:59Z')), '2026-11-26T20:00:00.000Z');
  assert.equal(priceSlot(Date.parse('2026-11-27T08:00:00Z')), '2026-11-27T08:00:00.000Z');
  const key = '00000000-0000-4000-8000-000000000000';
  const fixtureTime = at(-3_000);
  const effective = Math.floor(Date.parse(fixtureTime)/1000);
  const quote = (base='USD', updated=effective) => new Response(
    '{"valid":true,"base":"'+base+'","updated":'+updated+',"rates":{"AED":3.6725,"GBP":0.725000000000000001}}',
    {headers:{'content-type':'application/json'}});
  let currencyApiCalls = 0;
  const getRates = (currencies, apiKey) => readCurrencyApiAedRates(currencies,apiKey,async (url,init) => {
    currencyApiCalls++;
    const parsed = new URL(url);
    assert.equal(parsed.origin+parsed.pathname,'https://currencyapi.net/api/v2/rates');
    assert.equal(parsed.searchParams.get('key'),key);
    assert.equal(parsed.searchParams.has('base'),false);
    assert.equal(init.redirect,'error');
    return quote();
  });
  const currencyBatch = await getRates(['GBP','USD','ZZZ'],key);
  assert.equal(currencyApiCalls,1);
  assert.deepEqual(currencyBatch.map(({currency,aedPerUnit,usdAedRate,usdSourceRate})=>({currency,aedPerUnit,usdAedRate,usdSourceRate})),[
    {currency:'GBP',aedPerUnit:'5.065517241379',usdAedRate:'3.6725',usdSourceRate:'0.725000000000000001'},
    {currency:'USD',aedPerUnit:'3.672500000000',usdAedRate:'3.6725',usdSourceRate:'1'},
  ]);
  await assert.rejects(readCurrencyApiAedRates(['GBP'],key,async()=>quote('EUR')),/Currency API rates unavailable/);
  await assert.rejects(readCurrencyApiAedRates(['GBP'],key,async()=>quote('USD',effective-73*3600)),/Currency API rates unavailable/);
  await admin.query('SET ROLE nukhbapay_catalogue_runtime');
  const faces = await refreshFinxplorPrices(admin,reviewedScope,undefined,{loadReviewed:async()=>[]});
  assert.equal(faces.customer_prices,0);
  assert.equal(faces.aed_identity,1);

  const loadReviewed = async () => [{discovery_id:discoveryId,source_id:'fixture',source_key:'reviewed-price',
    source_reference:'synthetic-customer-price',currency:'GBP',amount:'3.17',observed_at:fixtureTime,valid_until:at(60_000)}];
  const pending = await refreshFinxplorPrices(admin,reviewedScope,undefined,{loadReviewed});
  assert.equal(pending.customer_prices,1);
  assert.equal(pending.awaiting_fx,1);
  const converted = await refreshFinxplorPrices(admin,reviewedScope,key,{loadReviewed,getRates});
  assert.equal(converted.rateRows,1);
  assert.equal(converted.fx_converted,1);
  const repeated = await refreshFinxplorPrices(admin,reviewedScope,key,{loadReviewed,getRates:async()=>assert.fail('Refetched current Currency API slot')});
  assert.equal(repeated.rateRows,0);
  assert.equal(repeated.failedCurrencies,0);
  await admin.query('RESET ROLE');

  const prices = await reader.query(`SELECT basis,source_amount::text,source_currency,converted_aed::text,acquisition_cost_aed
    FROM nukhabapay.finxplor_layer1_customer_prices ORDER BY basis`);
  assert.deepEqual(prices.rows,[
    {basis:'CUSTOMER_PRICE',source_amount:'3.17',source_currency:'GBP',converted_aed:'16.05768965517143',acquisition_cost_aed:null},
    {basis:'DENOMINATION',source_amount:'50.00',source_currency:'AED',converted_aed:'50.00',acquisition_cost_aed:null},
  ]);
  assert.deepEqual(await refreshFinxplorPrices(admin,reviewedScope,undefined,{manual:true}),{result:'FX_NOT_CONFIGURED'});
  await admin.query('SET ROLE nukhbapay_catalogue_runtime');
  const newRateTime = at(0);
  const manual = await refreshFinxplorPrices(admin,reviewedScope,key,{manual:true,loadReviewed,getRates:async currencies => {
    assert.deepEqual(currencies,['GBP']);
    return [{currency:'GBP',aedPerUnit:'6',effectiveAt:fixtureTime,retrievedAt:newRateTime,usdAedRate:'3',usdSourceRate:'0.5'}];
  }});
  assert.equal(manual.slot,converted.slot);
  assert.equal(manual.rateRows,1);
  const failed = await refreshFinxplorPrices(admin,reviewedScope,key,{manual:true,loadReviewed,getRates:async()=>{
    throw new Error('Synthetic Currency API unavailable');
  }});
  assert.equal(failed.rateRows,0);
  assert.equal(failed.failedCurrencies,1);
  assert.equal(failed.fx_converted,1);
  const resumed = await refreshFinxplorPrices(admin,reviewedScope,key,{loadReviewed,getRates:async()=>assert.fail('Refetched scheduled slot')});
  assert.equal(resumed.rateRows,0);
  assert.equal(resumed.failedCurrencies,0);
  await admin.query('RESET ROLE');

  const exactRate = (await reader.query(`SELECT p.converted_aed::text,r.refresh_kind,r.aed_per_unit::text,r.rate_source,r.usd_aed_rate::text,r.usd_source_rate::text
    FROM nukhabapay.finxplor_layer1_customer_prices p JOIN nukhabapay.finxplor_customer_fx_rates r
      ON (p.tenant_id,p.provider_account_id,p.source_currency,p.fx_slot_at,p.fx_retrieved_at)=
        (r.tenant_id,r.provider_account_id,r.source_currency,r.slot_at,r.retrieved_at)`)).rows;
  assert.deepEqual(exactRate,[{converted_aed:'19.02',refresh_kind:'MANUAL',aed_per_unit:'6',rate_source:'CURRENCY_API',usd_aed_rate:'3',usd_source_rate:'0.5'}]);
  assert.equal((await reader.query('SELECT FROM nukhabapay.finxplor_customer_fx_rates')).rowCount,2);
  await reader.query("SELECT set_config('nukhabapay.tenant_id',$1,false)",[other.tenantId]);
  assert.equal((await reader.query('SELECT FROM nukhabapay.finxplor_layer1_customer_prices')).rowCount,0);
  console.info('Customer price passed: verified-price separation, exact Currency API cross-rate, AED identity, missing-rate outcome, 12-hour reuse, on-demand quote history, failed refresh fallback and scoped read.');
  stage = 'partially synced products preserve completed coverage until a new full scan';
  const partialId=randomUUID(), finalId=randomUUID();
  await admin.query(`INSERT INTO nukhabapay.catalogue_discoveries
    (id,tenant_id,provider_account_id,source_id,source_digest,product_name,brand,source_country,currency,category,delivery,denominations,min_amount,max_amount)
    VALUES ($1,$3,$4,'partial-fixture',repeat('e',64),'Partial fixture','Fixture','ARE','AED','Gift Card','PIN','["15"]','15','15'),
           ($2,$3,$4,'fixture',repeat('f',64),'Completed fixture','Fixture','ARE','AED','Gift Card','PIN','["50"]','50','50')`,
    [partialId,finalId,reviewed.tenantId,reviewed.providerAccountId]);
  async function storeScan(scope, id, sourceId, digestChar) {
    const scan=randomUUID(), scopeValues=[reviewed.tenantId,reviewed.providerAccountId];
    const digest=createHash('sha256').update(scope+'\n'+sourceId+':'+digestChar.repeat(64)).digest('hex');
    await admin.query('BEGIN');
    await admin.query(`INSERT INTO nukhabapay.catalogue_discovery_scans
       (id,tenant_id,provider_account_id,coverage_scope,page_count,product_count,source_observed_at,scan_digest)
       VALUES($1,$2,$3,$4,$5,1,now(),$6)`,[scan,...scopeValues,scope,scope==='PARTIAL_ALL_COUNTRIES'?1:2,digest]);
    await admin.query('INSERT INTO nukhabapay.catalogue_discovery_scan_items(tenant_id,provider_account_id,scan_id,discovery_id) VALUES($1,$2,$3,$4)',
      [...scopeValues,scan,id]);
    await admin.query('COMMIT');
  }
  const currentCatalogue = async () => (await admin.query(`SELECT source_id,coverage_scope
    FROM nukhabapay.observed_catalogue_discoveries WHERE tenant_id=$1 AND provider_account_id=$2 ORDER BY source_id`,
    [reviewed.tenantId,reviewed.providerAccountId])).rows;
  await storeScan('ALL_COUNTRIES',discoveryId,'fixture','d');
  await storeScan('PARTIAL_ALL_COUNTRIES',partialId,'partial-fixture','e');
  assert.deepEqual(await currentCatalogue(),[
    {source_id:'fixture',coverage_scope:'ALL_COUNTRIES'},
    {source_id:'partial-fixture',coverage_scope:'PARTIAL_ALL_COUNTRIES'},
  ]);
  await storeScan('ALL_COUNTRIES',finalId,'fixture','f');
  assert.deepEqual(await currentCatalogue(),[{source_id:'fixture',coverage_scope:'ALL_COUNTRIES'}]);
  console.info('Layer 1 PostgreSQL passed: migrations 016 through 025, rollback, concurrent replay, tenant/account/mode isolation, exact history, outbox retries, inbox deduplication, worker batch, and stale-result fencing.');
}

try { await check(); }
catch (error) { console.error('Layer 1 PostgreSQL failed at '+stage, error); process.exitCode=1; }
finally {
  await reader?.end().catch(()=>undefined);
  await pool?.end();
  await admin?.end().catch(()=>undefined);
  if (started || existsSync(path.join(data,'postmaster.pid'))) pg('pg_ctl',['-D',data,'-m','fast','-w','stop']);
  const resolved = realpathSync(work);
  assert.equal(path.dirname(resolved),parent);
  assert.ok(path.basename(resolved).startsWith('nukhbapay-layer1-'));
  rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:250});
}
