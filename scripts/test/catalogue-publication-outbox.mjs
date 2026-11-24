import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createStaffPortal } from '../../apps/admin-web/dist/portal.js';
import { config, fixture as authFixture } from '../../apps/admin-web/dist-test/test/fixtures/auth0-fixture.js';
import { createCatalogueRefreshStore } from '../../packages/database/dist/database/src/catalogue-refresh-store.js';
import { createRefreshFencedDraftWriter } from '../../packages/database/dist/database/src/catalogue-publication-draft-store.js';
import { prepareSyntheticPriceSubmission } from '../../packages/application/dist/application/src/catalog/submission-evidence.js';
import { createApiApplication } from '../../apps/api/dist/http-application.js';
import { SyntheticCatalogueTokenVerifier } from '../../apps/api/dist/modules/catalog/published-catalogue-http.js';
import { signingKey } from '../../apps/api/dist-test/test/fixtures/oidc-test-issuer.js';
import { PublishedCatalogueService, CATALOGUE_AUDIENCES, CATALOGUE_SCOPES,
  consumeCatalogueReadTicket } from '../../packages/application/dist/application/src/catalog/published-catalogue.js';
import { createRequire } from 'node:module';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { executeSyntheticPublication } from '../../packages/database/dist/database/src/synthetic-publication-workflow.js';
import { prepareSyntheticPublicationCommand } from '../../packages/application/dist/application/src/catalog/publication-workflow.js';
import { attestVerifiedStaffIdentity } from '../../packages/application/dist/application/src/identity/verified-staff-identity.js';
import { createPublicationDeliveryWorker, createPublicationDeliveryRecovery } from '../../packages/database/dist/database/src/publication-delivery-outbox.js';

const { Client, Pool } = createRequire(new URL('../../packages/database/package.json',import.meta.url))('pg');

test('publication outbox on disposable PostgreSQL',async t=>{
  const {NUKHBA_DISPOSABLE_PG:origin,NUKHBA_DISPOSABLE_PG_DIRECTORY:directory}=process.env;
  assert.ok(origin&&directory);
  const address=new URL(origin);
  assert.equal(address.username,'nukh_fixture');
  assert.equal(address.hostname,'127.0.0.1');
  assert.ok(Number(address.port)>1024&&!['5432','55437'].includes(address.port));
  const owner=new Client({connectionString:origin});
  await owner.connect();
  let pool,recoveryPool;
  try {
    const target=(await owner.query('SHOW data_directory')).rows[0].data_directory;
    assert.equal(target.replaceAll('\\','/').toLowerCase(),directory.replaceAll('\\','/').toLowerCase());
    // The version projection matches the guarded workflow's outbox contract.
    // Original workflow activation and approval migration guards are exercised separately.
    await owner.query(`CREATE SCHEMA nukhabapay;
      CREATE TABLE nukhabapay.price_workflow_versions(operation_id uuid PRIMARY KEY,tenant_id uuid NOT NULL,product_id uuid NOT NULL,
        revision bigint NOT NULL,kind text NOT NULL CHECK(kind IN ('ACTIVATE','ROLLBACK')),UNIQUE(operation_id,tenant_id,product_id),
        UNIQUE(tenant_id,product_id,revision));
      CREATE FUNCTION nukhabapay.reject_publication_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Immutable version' USING ERRCODE='42501'; END $$;
      CREATE TRIGGER immutable_version BEFORE UPDATE OR DELETE OR TRUNCATE ON nukhabapay.price_workflow_versions
        FOR EACH STATEMENT EXECUTE FUNCTION nukhabapay.reject_publication_evidence_mutation();
      CREATE TABLE nukhabapay.fixture_recipient(tenant_id uuid NOT NULL,event_id uuid NOT NULL,receipt text NOT NULL,
        PRIMARY KEY(tenant_id,event_id));`);
    for (const file of ['013_catalogue_publication_outbox.sql','013_catalogue_publication_delivery_fence.sql'])
      await owner.query(readFileSync(new URL('../../packages/database/pending-migrations/'+file,import.meta.url),'utf8'));
    await owner.query(`CREATE ROLE publication_delivery_worker LOGIN NOINHERIT NOBYPASSRLS;
      GRANT USAGE ON SCHEMA nukhabapay TO publication_delivery_worker;
      GRANT SELECT ON nukhabapay.publication_delivery_outbox,nukhabapay.publication_delivery_state TO publication_delivery_worker;
      GRANT UPDATE(status,attempts,lease_token,lease_until,retry_at,ack_receipt) ON nukhabapay.publication_delivery_state TO publication_delivery_worker;
      GRANT INSERT ON nukhabapay.publication_delivery_audit TO publication_delivery_worker;
      GRANT USAGE ON SEQUENCE nukhabapay.publication_delivery_audit_sequence_seq TO publication_delivery_worker;`);
    address.username='publication_delivery_worker';
    pool=new Pool({connectionString:address.href,max:4});
    const tenant=randomUUID(), foreign=randomUUID(), product=randomUUID();
    async function revision(scope, productId, number, kind='ACTIVATE', event=randomUUID()) {
      await owner.query('INSERT INTO nukhabapay.price_workflow_versions VALUES($1,$2,$3,$4,$5)',[event,scope,productId,number,kind]);
      return event;
    }
    const states=async(event)=>(await owner.query('SELECT status,attempts,ack_receipt FROM nukhabapay.publication_delivery_state WHERE event_id=$1',[event])).rows[0];
    const signal=()=>new AbortController().signal;

    await t.test('event and version roll back together and direct creation is denied',async()=>{
      await owner.query('BEGIN');
      const draft=await revision(tenant,product,1);
      assert.equal((await states(draft)).status,'PENDING');
      await owner.query('ROLLBACK');
      assert.equal(await states(draft),undefined);
      assert.equal((await owner.query('SELECT 1 FROM nukhabapay.price_workflow_versions WHERE operation_id=$1',[draft])).rowCount,0);
      await assert.rejects(owner.query("INSERT INTO nukhabapay.publication_delivery_outbox(event_id,tenant_id,product_id,revision,kind) VALUES($1,$2,$3,1,'ACTIVATE')",
        [draft,tenant,product]),{code:'42501'});
    });


    await t.test('fenced staff submission, HTTPS publication, audit and outbox share one disposable database',async()=>{
      await owner.query(`CREATE TABLE nukhabapay.provider_accounts(
        id uuid NOT NULL,tenant_id uuid NOT NULL,provider_code text NOT NULL,status text NOT NULL,UNIQUE(tenant_id,id))`);
      for(const file of ['012_catalogue_refresh_R2_PROPOSAL.sql','012_catalogue_refresh_write_fence_PROPOSAL.sql',
        '012_catalogue_refresh_reconciliation.sql','012_catalogue_refresh_disposition.sql'])
        await owner.query(readFileSync(new URL('../../packages/database/pending-migrations/'+file,import.meta.url),'utf8'));
      await owner.query(readFileSync(new URL('../../packages/database/fixtures/catalogue-publication-workflow-projection.sql',import.meta.url),'utf8'));
      const writerAddress=new URL(origin);
      writerAddress.username='publication_workflow_fixture';
      const writer=new Pool({connectionString:writerAddress.href,max:2});
      function rolePool(username){
        const url=new URL(origin);
        url.username=username;
        return new Pool({connectionString:url.href,max:1});
      }
      const claimPool=rolePool('publication_refresh_fixture'),submissionPool=rolePool('publication_submission_fixture');
      const scope=config.tenantId,account=randomUUID(),item=randomUUID(),snapshot=randomUUID(),schedule=randomUUID();
      const refresh=createCatalogueRefreshStore(claimPool,[scope]),drafts=createRefreshFencedDraftWriter(submissionPool);
      let claim;

      const author=randomUUID(),reviewer=randomUUID(),operator=randomUUID();
      const at=Date.now(),iso=ms=>new Date(ms).toISOString();
      const observed=iso(at-10000),completed=iso(at-5000),valid=iso(at+60000);
      const productIdentity={canonicalProductId:'fixture-publication',brand:'Fixture',redemptionCountry:'AE',
        currency:'AED',faceValueMinor:10000n,fulfillmentMethod:'DIGITAL_PIN',termsVersion:'fixture-v1'};
      const policy={version:'fixture-v1',serviceFeeMinor:200n,maximumServiceFeeMinor:200n,taxAmountMinor:0n,
        paymentFeeBasisPoints:150,paymentFixedFeeMinor:20n,agentCommissionMinor:50n,minimumContributionMinor:100n,maximumOfferAgeMs:300000};
      const draft={
        tenantId:scope,productId:item,product:productIdentity,evaluatedAt:iso(at),pricingPolicy:policy,
        idempotencyKey:randomUUID(),expectedPreviousVersion:0,
        sourceSnapshots:[{snapshotId:snapshot,providerAccountId:account,snapshotKey:'fixture-v1',sourceVersion:'fixture-v1',
          observedAt:observed,completedAt:completed,status:'COMPLETE'}],
        offers:[{providerId:'fixture',offerId:'digital-pin',snapshotId:snapshot,identity:productIdentity,
          providerDebitMinor:9600n,upfrontDiscountMinor:400n,additionalProviderFeeMinor:0n,available:true,eligible:true,
          mappingStatus:'APPROVED',observedAt:observed,validUntil:valid}],
      };
      const actor=id=>attestVerifiedStaffIdentity({issuer:'https://publication.fixture.invalid/',subject:id,security:{
        audience:'urn:fixture:publication',profile:'rfc9068-staff-v1',principalKind:'human',assurance:'not-established',issuedAt:Math.floor(at/1000)-1,
        expiresAt:Math.floor(at/1000)+90,clientId:'publication-test',
      }});
      function authority(id,role,permission,subject=id){
        const membershipId=randomUUID();
        return {capability:'ISOLATED_SYNTHETIC_PUBLICATION_ONLY',now:()=>new Date(),auditWriter:{appendSecurityAuditEvents:async()=>{}},
          repository:{
            findByTrustedIdentity:async identity=>identity.subject!==subject?null:
              {staffId:id,staffStatus:'ACTIVE',identityStatus:'ACTIVE',authzVersion:1n,tokensValidAfter:null},
            findPlatformRoleGrants:async()=>[],
            findTenantMembership:async(_staff,tenantId)=>tenantId!==scope?null:
              {membershipId,tenantId,status:'ACTIVE',version:1n,roleGrants:[
                {roleCode:role,scope:'TENANT',grantedAt:observed,expiresAt:null,revokedAt:null}]},
          },
          allows:async(_context,current)=>permission===current};
      }
      const command=(action,candidate,expectedActiveId=null)=>({
        action,candidateId:candidate.candidateId,candidateVersion:candidate.priceVersion,tenantId:scope,productId:item,
        expectedActiveId,idempotencyKey:randomUUID(),rollbackSourceId:null,reason:null,
      });
      const prepare=(id,cmd)=>prepareSyntheticPublicationCommand(
        authority(id,cmd.action==='APPROVE'?'PRICING_APPROVER':'PUBLICATION_OPERATOR',
          {APPROVE:'pricing.approve',ACTIVATE:'pricing.activate',ROLLBACK:'publication.rollback'}[cmd.action]),actor(id),cmd);
      const run=async(id,cmd)=>executeSyntheticPublication(writer,await prepare(id,cmd));
      const ca=readFileSync(process.env.NUKHBAPAY_STAFF_TEST_CA_PATH);
      const pfx=readFileSync(process.env.NUKHBAPAY_STAFF_TEST_PFX_PATH);
      const passphrase=process.env.NUKHBAPAY_STAFF_TEST_PASSPHRASE;
      async function viaPortal(id,cmd,status,db=writer){
        const reservation=createServer().listen(0,'127.0.0.1');
        await once(reservation,'listening');
        const {port}=reservation.address();
        await new Promise(resolve=>reservation.close(resolve));
        const url='https://localhost:'+port,route='/staff-api/commands/publication',subject='fixture-'+id;
        const f=await authFixture(url+'/auth/callback',{},{
          stepUpPolicy:async intent=>intent.operation==='CATALOGUE_PUBLICATION'&&intent.actorStaffId===id,
          verifyStepUpFactor:async claims=>({eventId:randomUUID(),authenticatedAtMs:Number(claims.auth_time)*1000}),
        },{staffId:id,subject});
        f.advance(Math.floor(Date.now()/1000)*1000-f.now().getTime());
        const server=await createStaffPortal({port,pfx,certificate:ca,passphrase,login:f.login,sessions:f.sessions,environment:{},
          staffPublication:{authority:authority(id,cmd.action==='APPROVE'?'PRICING_APPROVER':'PUBLICATION_OPERATOR',
            {APPROVE:'pricing.approve',ACTIVATE:'pricing.activate',ROLLBACK:'publication.rollback'}[cmd.action],subject),
          executePublication:ticket=>executeSyntheticPublication(db,ticket)}});
        function call(path,method,headers,body){
          return new Promise((resolve,reject)=>{
            const req=request({hostname:'127.0.0.1',servername:'localhost',port,path,method,agent:false,ca,
              headers:{host:'localhost:'+port,...headers}},res=>{
              let text='';
              res.on('data',chunk=>{text+=chunk;});
              res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(text||'null')}));
            });
            req.on('error',reject);
            req.setTimeout(6000,()=>req.destroy(new Error('Publication fixture response timed out')));
            req.end(body);
          });
        }
        async function headers(cookie) {
          const res=await call('/auth/session','GET',{cookie});
          assert.equal(res.status,200);
          return {cookie,origin:url,'content-type':'application/json','x-csrf-token':res.body.csrfToken};
        }
        try {
          const start=f.begin();
          const token=await f.login.complete(start.callback,start.cookie);
          const initial=await headers('__Host-nukhbapay_staff='+token);
          const {tenantId,...body}=cmd;
          const pending=await call(route,'POST',initial,JSON.stringify(body));
          assert.equal(pending.status,200,JSON.stringify(pending.body));
          const provider=new URL(pending.body.location);
          f.id({nonce:provider.searchParams.get('nonce')});
          const callback=await call('/auth/callback?'+new URLSearchParams({code:'fixture',state:provider.searchParams.get('state')}),
            'GET',{cookie:pending.headers['set-cookie'][0].split(';')[0],'sec-fetch-site':'cross-site'});
          assert.equal(callback.status,303);
          const confirmed=await headers(callback.headers['set-cookie'].find(row=>row.startsWith('__Host-nukhbapay_staff=')).split(';')[0]);
          assert.equal((await call(route,'GET',confirmed)).body.candidateId,body.candidateId);
          const final=await call(route+'/confirm','POST',confirmed,'{}');
          assert.equal(final.body.state,status,JSON.stringify(final.body));
          const receipt=(await owner.query(`SELECT o.operation_id AS "operationId",v.revision::text
            FROM nukhabapay.price_workflow_operations o LEFT JOIN nukhabapay.price_workflow_versions v USING(operation_id)
            WHERE o.tenant_id=$1 AND o.product_id=$2 AND o.idempotency_key=$3`,[scope,item,cmd.idempotencyKey])).rows[0];
          assert.ok(receipt);
          return receipt;
        } finally {await server.close();}
      }

      async function exerciseScopedRead(rollbackId){
        const read=rolePool('publication_read_fixture'),audit=rolePool('publication_read_audit_fixture');
        async function transaction(pool,tenant,query,mode=''){
          const client=await pool.connect();
          let discard=false;
          try {
            await client.query('BEGIN '+mode);
            await client.query("SELECT set_config('nukhabapay.publication_tenant_id',$1,true)",[tenant]);
            const result=await query(client);
            if((await client.query('COMMIT')).command!=='COMMIT')throw new Error('Fixture read unconfirmed');
            return result;
          } catch(error) {
            discard=true;
            await client.query('ROLLBACK').catch(()=>{});
            throw error;
          } finally {client.release(discard);}
        }
        const kioskId=randomUUID(),issuer='https://readback.fixture.invalid/',now=()=>new Date();
        const bindings=new Map([['fixture-payment',{kind:'payment',tenantId:scope,kioskId:null}],
          ['fixture-kiosk',{kind:'kiosk',tenantId:scope,kioskId}],['fixture-foreign',{kind:'payment',tenantId:foreign,kioskId:null}]]);
        const key=await signingKey('projection-key');
        const verifier=new SyntheticCatalogueTokenVerifier({issuer,keys:[key.publicJwk],now});
        const seconds=Math.floor(Date.now()/1000);
        const mint=(kind,clientId)=>key.sign({iss:issuer,sub:clientId,aud:CATALOGUE_AUDIENCES[kind],iat:seconds,exp:seconds+60,jti:randomUUID(),
          client_id:clientId,client_kind:kind,client_profile:'synthetic-catalogue-client-v1',principal_kind:'machine',scope:CATALOGUE_SCOPES[kind]});
        const service=new PublishedCatalogueService({capability:'SYNTHETIC_PUBLISHED_CATALOGUE_ONLY',now,requestsPerMinute:30,
          bindings:{find:async({clientId})=>{
            const binding=bindings.get(clientId);
            return binding ? {...binding,issuer,subject:clientId,clientId,scope:CATALOGUE_SCOPES[binding.kind],enabled:true,version:'1'} : null;
          }},
          reader:{async read(raw){
            const ticket=consumeCatalogueReadTicket(raw);
            if(!await ticket.revalidate())throw new Error('Read unavailable');
            return transaction(read,ticket.tenantId,async client=>{
              await client.query("SELECT set_config('nukhabapay.catalogue_read_at',$1,true)",[iso(ticket.nowMs)]);
              const result=await client.query('SELECT product_id,name,publication_id,total_amount_minor::text,valid_until FROM nukhabapay.fixture_public_catalogue');
              return result.rows.map(row=>({productId:row.product_id,name:row.name,publicationId:row.publication_id,
                totalMinor:row.total_amount_minor,validUntil:row.valid_until.toISOString()}));
            },'ISOLATION LEVEL REPEATABLE READ READ ONLY');
          }},
          audit:{append:e=>transaction(audit,e.tenantId,client=>client.query(
            'INSERT INTO nukhabapay.fixture_public_read_audit VALUES($1,$2,$3,$4,$5,$6,$7)',
            [e.requestId,e.tenantId,e.kind,e.kioskId,e.clientDigest,e.catalogueVersion,e.occurredAt]))}});
        const api=await createApiApplication({logger:false,catalogue:{verifier,service,now}});
        try {
          await api.listen(0,'127.0.0.1');
          const endpoint='http://127.0.0.1:'+api.getHttpServer().address().port;
          const payment=await mint('payment','fixture-payment'),kiosk=await mint('kiosk','fixture-kiosk');
          const cross=await mint('payment','fixture-foreign');
          async function get(route,token,headers={}){
            const response=await fetch(endpoint+route,{headers:{authorization:'Bearer '+token,...headers}});
            return {status:response.status,body:await response.json()};
          }
          const paymentPath='/v1/payment/catalogue', kioskPath='/v1/kiosks/'+kioskId+'/catalogue';
          const expected={product_id:item,name:'Fixture',category:'DIGITAL_PIN',price_status:'INDICATIVE',
            catalog_version:rollbackId,display_total:'102.00',currency:'AED'};
          for(const [route,token] of [[paymentPath,payment],[kioskPath,kiosk]]){
            const response=await get(route,token);
            assert.equal(response.status,200);
            assert.deepEqual(response.body.items,[expected]);
          }
          assert.equal((await get(paymentPath,kiosk)).status,401);
          assert.equal((await get(kioskPath,payment)).status,401);
          assert.equal((await get('/v1/kiosks/'+randomUUID()+'/catalogue',kiosk)).status,403);
          assert.equal((await get(paymentPath+'/'+item,cross,{'x-tenant-id':scope})).status,404);
          assert.equal((await owner.query('SELECT count(*)::int AS n FROM nukhabapay.fixture_public_read_audit WHERE tenant_id=$1',[scope])).rows[0].n,2);
          await assert.rejects(read.query('SELECT * FROM nukhabapay.price_workflow_versions'),{code:'42501'});
          await assert.rejects(audit.query('SELECT * FROM nukhabapay.fixture_public_read_audit'),{code:'42501'});
          await owner.query('REVOKE INSERT ON nukhabapay.fixture_public_read_audit FROM publication_read_audit_fixture');
          try {assert.equal((await get(paymentPath,payment)).status,503);}
          finally {await owner.query('GRANT INSERT ON nukhabapay.fixture_public_read_audit TO publication_read_audit_fixture');}
        } finally {await api.close();await Promise.all([read.end(),audit.end()]);}
      }

      async function submit(request,lease) {
        const deps=authority(author,'PRICING_EDITOR','pricing.submit');
        const proof=await prepareSyntheticPriceSubmission({...deps,capability:'ISOLATED_SYNTHETIC_SUBMISSION_ONLY'},actor(author),request);
        return {proof,receipt:await drafts.submitFenced(proof,lease)};
      }
      async function seed(request){
        const {proof,receipt}=await submit(request,claim);
        assert.equal(receipt.outcome,'CREATED');
        assert.equal(receipt.candidateId,proof.candidate.candidateId);
        return proof.candidate;
      }
      const scopeCount=async relation=>(await owner.query('SELECT count(*)::int AS n FROM nukhabapay.'+relation+' WHERE tenant_id=$1',[scope])).rows[0].n;
      try {
        await owner.query("INSERT INTO nukhabapay.products VALUES($1,'fixture-publication','Fixture','AE','AED',10000,'DIGITAL_PIN','fixture-v1')",[item]);
        await owner.query("INSERT INTO nukhabapay.provider_accounts VALUES($1,$2,'fixture','ACTIVE')",[account,scope]);
        await owner.query("INSERT INTO nukhabapay.catalogue_refresh_schedules VALUES($1,$2,$3,'fixture-v1','v1',true,$4,86400000)",
          [schedule,scope,account,at-500]);
        claim=await refresh.claim(0,45000);
        assert.ok(claim);
        await owner.query("INSERT INTO nukhabapay.catalogue_publication_provider_accounts VALUES($1,$2,'fixture','ACTIVE')",[account,scope]);
        await owner.query(`INSERT INTO nukhabapay.catalogue_publication_provider_snapshots
          VALUES($1,$2,$3,'COMPLETE','fixture-v1','fixture-v1',$4,$5),($6,$2,$3,'IN_PROGRESS','fixture-inflight','fixture-v1',$5,NULL)`,
          [snapshot,scope,account,observed,completed,randomUUID()]);
        await owner.query("INSERT INTO nukhabapay.catalogue_publication_provider_offers VALUES($1,$2,$3,$4,'digital-pin',9600,400,0,true,$5,$6)",
          [scope,item,snapshot,account,observed,valid]);
        await assert.rejects(submit(draft,{...claim,tenantId:foreign}),/tenant mismatch/i);
        await assert.rejects(submit(draft,{...claim,token:randomUUID()}),{code:'42501'});
        await owner.query(`CREATE TRIGGER reject_projected_submission_audit BEFORE INSERT ON nukhabapay.price_submission_events
          FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_publication_evidence_mutation()`);
        try {await assert.rejects(submit(draft,claim),{code:'42501'});}
        finally {await owner.query('DROP TRIGGER reject_projected_submission_audit ON nukhabapay.price_submission_events');}
        for (const table of ['price_submission_births','price_submission_evidence','catalogue_publication_candidates',
          'catalogue_publication_events','catalogue_refresh_write_evidence']) assert.equal(await scopeCount(table),0,table);
        const first=await seed(draft),activate=command('ACTIVATE',first),approve=command('APPROVE',first);
        await assert.rejects(run(author,approve),/separation/);
        await assert.rejects(run(reviewer,{...approve,tenantId:foreign}),/denied/);
        await assert.rejects(run(operator,activate),/distinct approval/);
        assert.equal((await viaPortal(reviewer,approve,'RECORDED')).revision,null);
        assert.equal(await scopeCount('publication_delivery_outbox'),0);
        await assert.rejects(run(reviewer,activate),/distinct approval/);

        // The database commits before the caller loses the response. Replay
        // uses a fresh authority ticket and resolves the original operation.
        const lostResponse={async connect(){
          const client=await writer.connect();
          return {async query(sql,parameters){
            const result=await client.query(sql,parameters);
            if (sql==='COMMIT') throw new Error('Fixture commit response lost');
            return result;
          },release:discard=>client.release(discard)};
        }};
        const unconfirmed=await viaPortal(operator,activate,'UNRESOLVED',lostResponse);
        const one=await viaPortal(operator,activate,'REPLAYED');
        assert.equal(one.operationId,unconfirmed.operationId);
        assert.equal(one.revision,'1');
        assert.equal(await scopeCount('publication_delivery_outbox'),1);

        const second=await seed({...draft,idempotencyKey:randomUUID(),expectedPreviousVersion:1,
          pricingPolicy:{...policy,version:'fixture-v2',serviceFeeMinor:300n,maximumServiceFeeMinor:300n}});
        const secondApproval=command('APPROVE',second),newer=randomUUID();
        await owner.query(`INSERT INTO nukhabapay.catalogue_publication_provider_snapshots
          VALUES($1,$2,$3,'COMPLETE','fixture-newer','fixture-v2',$4,$4)`,[newer,scope,account,iso(at-1000)]);
        await assert.rejects(run(reviewer,secondApproval),/Invalid source provenance/);
        await owner.query('DELETE FROM nukhabapay.catalogue_publication_provider_snapshots WHERE id=$1',[newer]);
        await run(reviewer,secondApproval);
        const activateSecond=command('ACTIVATE',second,one.operationId);
        await owner.query(`CREATE TRIGGER reject_projected_workflow_audit BEFORE INSERT ON nukhabapay.price_workflow_audit
          FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_publication_evidence_mutation()`);
        try {await assert.rejects(run(operator,activateSecond),{code:'42501'});}
        finally {await owner.query('DROP TRIGGER reject_projected_workflow_audit ON nukhabapay.price_workflow_audit');}
        assert.equal(await scopeCount('publication_delivery_outbox'),1);
        const two=await run(operator,activateSecond);
        const restored=await viaPortal(operator,{...command('ROLLBACK',first,two.operationId),
          rollbackSourceId:one.operationId,reason:'Restore fixture price'},'RECORDED');
        const totals=(await owner.query(`SELECT total_amount_minor::text AS total FROM nukhabapay.price_workflow_versions
          JOIN nukhabapay.catalogue_publication_candidates USING(candidate_id,tenant_id,product_id)
          WHERE tenant_id=$1 ORDER BY revision`,[scope])).rows.map(row=>row.total);
        assert.deepEqual(totals,['10200','10300','10200']);
        assert.equal(restored.revision,'3');
        await exerciseScopedRead(restored.operationId);
        assert.equal(await scopeCount('price_workflow_audit'),5);
        assert.equal(await scopeCount('price_submission_events'),2);
        assert.equal(await scopeCount('catalogue_refresh_write_evidence'),2);
        await refresh.settle(claim,{state:'SUCCEEDED',reason:'NONE',nextAttemptAtMs:null},0);
        await assert.rejects(submit(draft,claim),{code:'42501'});
        assert.equal(await scopeCount('publication_delivery_outbox'),3);
        const delivered=[];
        const delivery=createPublicationDeliveryWorker(pool,[scope],{async deliver(event){
          delivered.push(event.eventId);
          return 'fixture-'+event.eventId;
        }});
        for (let attempt=0;attempt<3;attempt++) assert.equal(await delivery.deliverNext(scope,signal()),'ACKNOWLEDGED');
        assert.deepEqual(delivered,[one.operationId,two.operationId,restored.operationId]);
        assert.equal(await delivery.deliverNext(scope,signal()),'EMPTY');
      } finally {await Promise.all([writer.end(),claimPool.end(),submissionPool.end()]);}
    });

    let deliveryCalls=0,loseReceipt=true,onDeliver;
    const recipient={async deliver(event){
      assert.deepEqual(Object.keys(event).sort(),['eventId','kind','productId','revision','tenantId']);
      deliveryCalls++;
      await onDeliver?.();
      const stable='fixture-'+event.eventId;
      await owner.query('INSERT INTO nukhabapay.fixture_recipient VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[event.tenantId,event.eventId,stable]);
      if (loseReceipt) {loseReceipt=false;throw new Error('Injected receipt loss after consumer commit');}
      return stable;
    }};

    await t.test('worker restart retries with the same event ID, respects ordering and isolates tenants',async()=>{
      const published=await revision(tenant,product,1), rollback=await revision(tenant,product,2,'ROLLBACK');
      const other=await revision(foreign,product,1);
      const first=createPublicationDeliveryWorker(pool,[tenant],recipient);
      await assert.rejects(first.deliverNext(foreign,signal()));
      assert.equal(await first.deliverNext(tenant,signal()),'RETRY_WAIT');
      assert.equal(await first.deliverNext(tenant,signal()),'EMPTY');
      await pause(1100);
      const restarted=createPublicationDeliveryWorker(pool,[tenant],recipient);
      let markStarted, resume;
      const entered = new Promise(resolve=>{markStarted=resolve;});
      const blocked = new Promise(resolve=>{resume=resolve;});
      onDeliver=async()=>{markStarted();await blocked;};
      const delivery=restarted.deliverNext(tenant,signal());
      try {
        await Promise.race([entered,delivery.then(()=>{throw new Error('No concurrent lease');})]);
        assert.equal(await first.deliverNext(tenant,signal()),'EMPTY');
      } finally {resume();onDeliver=undefined;}
      assert.equal(await delivery,'ACKNOWLEDGED');
      assert.equal((await states(published)).attempts,2);
      assert.equal((await states(rollback)).status,'PENDING');
      assert.equal(await restarted.deliverNext(tenant,signal()),'ACKNOWLEDGED');
      assert.equal((await states(other)).status,'PENDING');
      assert.equal((await owner.query('SELECT count(*)::int AS count FROM nukhabapay.fixture_recipient WHERE tenant_id=$1',[tenant])).rows[0].count,2);
      assert.equal(deliveryCalls,3);
      await assert.rejects(owner.query('UPDATE nukhabapay.price_workflow_versions SET revision=3 WHERE operation_id=$1',[published]),{code:'42501'});
      await assert.rejects(revision(tenant,product,2,'ROLLBACK'),{code:'23505'});
      assert.equal((await pool.query('SELECT 1 FROM nukhabapay.publication_delivery_outbox')).rowCount,0);
    });

    await t.test('a worker that loses its lease cannot acknowledge after a replacement commits',async()=>{
      const event=await revision(tenant,randomUUID(),1);
      let started,finish;
      const entered=new Promise(resolve=>{started=resolve});
      const paused=new Promise(resolve=>{finish=resolve});
      const stopped=createPublicationDeliveryWorker(pool,[tenant],{async deliver(){started();await paused;return 'stale';}});
      const running=stopped.deliverNext(tenant,signal(),1000);
      try {
        await entered;
        await pause(1100);
        const replacement=createPublicationDeliveryWorker(pool,[tenant],{async deliver(){return 'new-receipt';}});
        assert.equal(await replacement.deliverNext(tenant,signal()),'ACKNOWLEDGED');
      } finally {finish();}
      assert.equal(await running,'CANCELLED');
      assert.deepEqual(await states(event),{status:'ACKNOWLEDGED',attempts:2,ack_receipt:'new-receipt'});
    });

    await t.test('a lease expiring during acknowledgement rolls back the delivery and audit at commit',async()=>{
      const event=await revision(tenant,randomUUID(),1),token=randomUUID();
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('nukhabapay.publication_tenant_id',$1,true)",[tenant]);
        await client.query(`UPDATE nukhabapay.publication_delivery_state SET status='CLAIMED',lease_token=$2,
          lease_until=clock_timestamp()+interval '1.1 seconds',attempts=1 WHERE event_id=$1`,[event,token]);
        await client.query('COMMIT');
        await client.query('BEGIN');
        await client.query("SELECT set_config('nukhabapay.publication_tenant_id',$1,true)",[tenant]);
        await client.query(`UPDATE nukhabapay.publication_delivery_state SET status='ACKNOWLEDGED',lease_token=NULL,
          lease_until=NULL,ack_receipt='too-late' WHERE event_id=$1 AND lease_token=$2`,[event,token]);
        await pause(1220);
        await assert.rejects(client.query('COMMIT'),{code:'42501'});
      } finally {await client.query('ROLLBACK');client.release();}
      assert.deepEqual(await states(event),{status:'CLAIMED',attempts:1,ack_receipt:null});
      const worker=createPublicationDeliveryWorker(pool,[tenant],{async deliver(){return 'on-time';}});
      assert.equal(await worker.deliverNext(tenant,signal()),'ACKNOWLEDGED');
      assert.deepEqual(await states(event),{status:'ACKNOWLEDGED',attempts:2,ack_receipt:'on-time'});
      const audit=(await owner.query('SELECT status FROM nukhabapay.publication_delivery_audit WHERE event_id=$1 ORDER BY sequence',[event])).rows;
      assert.deepEqual(audit.map(r=>r.status),['PENDING','CLAIMED','CLAIMED','ACKNOWLEDGED']);
    });

    await t.test('terminal uncertainty is repaired only from an authoritative receipt',async()=>{
      const event=await revision(tenant,randomUUID(),1);
      const worker=createPublicationDeliveryWorker(pool,[tenant],{async deliver(notification){
        await owner.query('INSERT INTO nukhabapay.fixture_recipient VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [notification.tenantId,notification.eventId,'verified-fixture-receipt']);
        throw new Error('Controlled acknowledgement loss on every attempt');
      }});
      for (let attempt=1;attempt<=4;attempt++) {
        assert.equal(await worker.deliverNext(tenant,signal()),attempt===4?'FAILED':'RETRY_WAIT');
        if (attempt<4) await pause(2**(attempt-1)*1000+100);
      }
      assert.equal((await states(event)).status,'FAILED');
      await assert.rejects(pool.query("INSERT INTO nukhabapay.publication_delivery_recovery(event_id,tenant_id,verified_receipt) VALUES($1,$2,'fake')",
        [event,tenant]),{code:'42501'});
      await owner.query(`CREATE ROLE publication_delivery_operator LOGIN NOINHERIT NOBYPASSRLS;
        GRANT USAGE ON SCHEMA nukhabapay TO publication_delivery_operator;
        GRANT SELECT ON nukhabapay.publication_delivery_state,nukhabapay.publication_delivery_recovery TO publication_delivery_operator;
        GRANT UPDATE(status,ack_receipt) ON nukhabapay.publication_delivery_state TO publication_delivery_operator;
        GRANT INSERT ON nukhabapay.publication_delivery_audit,nukhabapay.publication_delivery_recovery TO publication_delivery_operator;
        GRANT USAGE ON SEQUENCE nukhabapay.publication_delivery_audit_sequence_seq TO publication_delivery_operator;`);
      const operator=new URL(address);
      operator.username='publication_delivery_operator';
      recoveryPool=new Pool({connectionString:operator.href,max:1});
      const lookup=async(scope,id)=>(await owner.query('SELECT receipt FROM nukhabapay.fixture_recipient WHERE tenant_id=$1 AND event_id=$2',[scope,id])).rows[0]?.receipt??null;
      const recover=createPublicationDeliveryRecovery(recoveryPool,tenant,lookup);
      assert.equal(await createPublicationDeliveryRecovery(recoveryPool,foreign,lookup)(event),'UNRESOLVED');
      assert.equal(await recover(event),'ACKNOWLEDGED');
      assert.equal(await recover(event),'ACKNOWLEDGED');
      assert.equal((await states(event)).attempts,4);
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM nukhabapay.publication_delivery_recovery WHERE event_id=$1',[event])).rows[0].n,1);
    });
    const soakMs=Number(process.env.NUKHBA_DISPOSABLE_SOAK_MS??0);
    if (soakMs) await t.test('publication soak retries committed deliveries without duplicating recipient effects',async()=>{
      assert.ok(soakMs>=1000 && soakMs<=600000);
      const recipients=new Pool({connectionString:origin,max:3});
      const scopes=[randomUUID(),randomUUID(),randomUUID()];
      const products=scopes.map(()=>Array.from({length:16},()=>randomUUID()));
      const expectedFailures=new Set();
      let retries=0;
      const workerPools=scopes.map(()=>new Pool({connectionString:address.href,max:2}));
      const workers=workerPools.map(workerPool=>createPublicationDeliveryWorker(workerPool,scopes,{
        async deliver(event){
          const receipt='soak-'+event.eventId;
          const update=await recipients.query('INSERT INTO nukhabapay.fixture_recipient VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
            [event.tenantId,event.eventId,receipt]);
          if (update.rowCount===1 && expectedFailures.has(event.eventId)) {retries++;throw new Error('Recipient commit acknowledgement lost');}
          return receipt;
        },
      }));
      const begin=performance.now();
      let rounds=0;
      try {
        do {
          for (const [index,scope] of scopes.entries()) {
            const event=await revision(scope,products[index][rounds%16],1+Math.floor(rounds/16));
            if (rounds%128===0) expectedFailures.add(event);
          }
          await Promise.all(workers.map((worker,index)=>worker.deliverNext(scopes[index],signal())));
          rounds++;
          await pause(15);
        } while (performance.now()-begin<soakMs);
        const duration=Math.round(performance.now()-begin);
        let rows;
        const drain=performance.now();
        do {
          await Promise.all(workers.map((worker,index)=>worker.deliverNext(scopes[index],signal())));
          rows=(await owner.query(`SELECT count(*)::int AS jobs,
              count(*) FILTER (WHERE status='ACKNOWLEDGED')::int AS delivered,
              (SELECT count(*)::int FROM nukhabapay.fixture_recipient WHERE tenant_id=ANY($1::uuid[])) AS receipts
              FROM nukhabapay.publication_delivery_state WHERE tenant_id=ANY($1::uuid[])`,[scopes])).rows[0];
          if (rows.jobs!==rows.delivered) await pause(20);
        } while (rows.jobs!==rows.delivered && performance.now()-drain<8000);
        assert.deepEqual(rows,{jobs:3*rounds,delivered:3*rounds,receipts:3*rounds});
        assert.equal(retries,expectedFailures.size);
        console.log('PUBLICATION_SOAK '+JSON.stringify({elapsedMs:duration,rounds,workers:3,tenants:3,retries,
          drainMs:Math.round(performance.now()-drain),...rows}));
      } finally {await Promise.all(workerPools.map(workerPool=>workerPool.end()));await recipients.end();}
    });
  } finally {
    await recoveryPool?.end();
    await pool?.end();
    await owner.end();
  }
});
