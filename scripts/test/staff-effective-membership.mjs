import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as reservePort } from 'node:net';
import { request } from 'node:https';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
import { up as catalogue } from '../../packages/database/migrations/001_catalog.ts';
import { up as identity } from '../../packages/database/migrations/004_staff_identity_foundation.ts';
import { createDisposableStaffSessionStore } from '../../packages/database/dist/database/src/staff-session-store.js';
import { connectDisposableStaffSuspension, disposableSuspensionAssurance } from '../../apps/admin-web/dist/staff-command-admission.js';
import { createStaffPortal, staffCookie } from '../../apps/admin-web/dist/portal.js';
import { Auth0Login } from '../../apps/admin-web/dist/auth0.js';
import { createStaffMembershipExecutor } from '../../packages/database/dist/database/src/staff-membership-executor.js';
import { attestVerifiedStaffIdentity } from '../../packages/application/dist/application/src/identity/verified-staff-identity.js';
import { StaffIdentityPostgresRepository } from '../../packages/database/dist/database/src/repositories/staff-identity-repository.js';
import { StaffSessionLifecycle, TrustedStaffActorBoundary, accessChangeRequestDigest, canonicalDigest } from '../../packages/application/dist/application/src/index.js';

const { Client, Pool } = createRequire(new URL('../../packages/database/package.json', import.meta.url))('pg');
const {exportJWK,generateKeyPair,SignJWT}=createRequire(new URL('../../apps/admin-web/package.json',import.meta.url))('jose');
const issuer = 'https://staff-effect.fixture.invalid/';
const bindingDigest = value => canonicalDigest(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)));
const hash = value => createHash('sha256').update(value).digest('hex');

test('effective staff membership suspension on private PostgreSQL', async t => {
  const {NUKHBA_DISPOSABLE_PG: origin, NUKHBA_DISPOSABLE_PG_DIRECTORY: directory} = process.env;
  assert.ok(origin && directory);
  const target = new URL(origin);
  assert.equal(target.hostname,'127.0.0.1');
  assert.equal(target.username,'nukh_fixture');
  assert.equal(target.pathname,'/postgres');
  assert.ok(Number(target.port)>1024 && !['5432','55437'].includes(target.port));
  const owner = new Client({connectionString:origin});
  const database = 'nukhabapay_effect_'+randomUUID().replaceAll('-','');
  await owner.connect();
  let fixture,pool,sessionStore;
  try {
    const root = (await owner.query('SHOW data_directory')).rows[0].data_directory;
    assert.equal(root.replaceAll('\\','/').toLowerCase(),directory.replaceAll('\\','/').toLowerCase());
    await owner.query(`CREATE DATABASE ${database}`);
    await owner.query(`REVOKE TEMP ON DATABASE ${database} FROM PUBLIC`);
    target.pathname='/'+database;
    fixture = new Client({connectionString:target.href});
    await fixture.connect();
    await fixture.query(`CREATE SCHEMA nukhabapay;
      CREATE ROLE nukhabapay_runtime; CREATE ROLE nukhabapay_importer;
      CREATE ROLE nukhabapay_identity_reader; CREATE ROLE nukhabapay_identity_writer;`);
    const migrations=[];
    catalogue({sql:sql=>migrations.push(sql)});
    identity({sql:sql=>migrations.push(sql)});
    for (const sql of migrations) await fixture.query(sql);
    for (const file of ['staff-access-request-records.sql','staff-request-cancellation-PROPOSAL.sql'])
      await fixture.query(readFileSync(new URL('../../packages/database/pending-migrations/'+file,import.meta.url),'utf8'));
    for (const file of ['staff-effective-membership.sql','staff-effective-sessions.sql'])
      await fixture.query(readFileSync(new URL('../../packages/database/fixtures/'+file,import.meta.url),'utf8'));
    const secret=randomBytes(32);
    await fixture.query('INSERT INTO nukhbapay_effect_private.signing_key VALUES(true,$1)',[secret]);
    target.username='nukh_effect_executor';
    pool=new Pool({connectionString:target.href,max:2,connectionTimeoutMillis:2500});
    const capabilities=new WeakMap();
    let beforeRecheck, authenticateBff;
    const executor=await createStaffMembershipExecutor(pool,{capability:'DISPOSABLE_STAFF_EFFECT_V1',signingKey:secret,
      async consumeAssurance(intent,proof,session){
        if (authenticateBff) return authenticateBff(intent,proof,session);
        const claim=capabilities.get(proof);
        capabilities.delete(proof);
        if (!claim || claim.session!==session || claim.scope!==bindingDigest(intent)) return null;
        return {...claim,
          async revalidate() {
            await beforeRecheck?.();
            return Date.now()<claim.expiresAtMs;
          }};
      }});
    const session=randomBytes(32).toString('base64url');

    function issue(intent, subject, {eventId=randomUUID(), lifetime=30000, profile='DISPOSABLE_STAFF_EFFECT_V1'}={}) {
      const proof=Object.freeze({});
      capabilities.set(proof, {scope:bindingDigest(intent),session,sessionDigest:hash(session),
        profile,eventId,staffId:intent.actorStaffId,tenantId:intent.tenantId,issuer,subject,
        identityIssuedAtMs:Date.now()-500,expiresAtMs:Date.now()+lifetime});
      return proof;
    }
    const run=(intent,subject,options)=>executor.run(intent,issue(intent,subject,options),session);

    async function person(tenant,tenantRole,platformRole) {
      const user=randomUUID(), membership=randomUUID(), subject='subject-'+user;
      await fixture.query("INSERT INTO nukhabapay.staff_users(id,display_name,contact_email,status,authz_version) VALUES($1,'Fixture',$2,'ACTIVE',1)",[user,user+'@fixture.invalid']);
      await fixture.query("INSERT INTO nukhabapay.staff_identities(id,staff_id,issuer,subject,status) VALUES($1,$2,$3,$4,'ACTIVE')",[randomUUID(),user,issuer,subject]);
      await fixture.query("INSERT INTO nukhabapay.staff_memberships(id,staff_id,tenant_id,status) VALUES($1,$2,$3,'ACTIVE')",[membership,user,tenant]);
      if (tenantRole) await fixture.query(`INSERT INTO nukhabapay.tenant_role_grants(id,membership_id,tenant_id,role_code,scope,granted_at,grant_source,evidence_reference)
        VALUES($1,$2,$3,$4,'TENANT',clock_timestamp()-interval '1 day','TEST','effective-fixture')`,[randomUUID(),membership,tenant,tenantRole]);
      if (platformRole) await fixture.query(`INSERT INTO nukhabapay.platform_role_grants(id,staff_id,role_code,scope,granted_at,grant_source,evidence_reference)
        VALUES($1,$2,$3,'PLATFORM',clock_timestamp()-interval '1 day','TEST','effective-fixture')`,[randomUUID(),user,platformRole]);
      return {user,membership,subject};
    }

    async function setup(needsReview=false) {
      const tenant=randomUUID();
      await fixture.query('INSERT INTO nukhabapay.tenants(id,tenant_key) VALUES($1,$2)',[tenant,tenant]);
      const requester=await person(tenant,'TENANT_ADMIN',needsReview?'ACCESS_ADMIN':null);
      const beneficiary=await person(tenant,'SUPPORT_AGENT');
      const reviewer=await person(tenant,null,'SECURITY_ADMIN');
      const request={id:randomUUID(),version:1n,policyVersion:'staff-lifecycle-v1',state:'SUBMITTED',
        scope:{kind:'TENANT',tenantId:tenant},requesterStaffId:requester.user,targetStaffId:beneficiary.user,
        operation:{kind:'SUSPEND',target:'MEMBERSHIP'},expectedAuthzVersion:1n,expectedMembershipVersion:1n,proposedRoles:[],
        createdAtMs:Date.now()-100,expiresAtMs:Date.now()+120000};
      const digest=accessChangeRequestDigest(request), operation=hash(request.id), key=randomUUID();
      await fixture.query('BEGIN');
      try {
        await fixture.query(`INSERT INTO nukhabapay.staff_request_operations(operation_id,actor_staff_id,issuer,subject,idempotency_key,intent_digest,request_id,request_version,scope_key,kind)
          VALUES($1,$2,$3,$4,$5,$1,$6,1,$7,'SUBMIT')`,[operation,requester.user,issuer,requester.subject,key,request.id,tenant]);
        await fixture.query(`INSERT INTO nukhabapay.staff_access_requests(request_id,version,request_digest,requester_staff_id,target_staff_id,tenant_id,scope_key,
          expected_authz_version,expected_membership_version,roles,created_at_ms,expires_at_ms,policy_version,payload,submission_operation,requester_authz_version,
          requester_authority_digest,target_authority_digest) VALUES($1,1,$2,$3,$4,$5::uuid,$5::uuid::text,1,1,'{}',$6,$7,'staff-lifecycle-v1',$8,$9,1,$9,$9)`,
        [request.id,digest,requester.user,beneficiary.user,tenant,request.createdAtMs,request.expiresAtMs,
          JSON.stringify(request,(_,value)=>typeof value==='bigint'?value.toString():value),operation]);
        await fixture.query(`INSERT INTO nukhabapay.staff_request_audit(operation_id,actor_staff_id,request_id,request_version,scope_key,intent_digest,event_name)
          VALUES($1,$2,$3,1,$4,$1,'SYNTHETIC_REQUEST_SUBMITTED')`,[operation,requester.user,request.id,tenant]);
        await fixture.query("INSERT INTO nukhabapay.staff_request_receipts(operation_id,scope_key,outcome) VALUES($1,$2,'RECORDED_NOT_AUTHORIZED')",[operation,tenant]);
        await fixture.query("INSERT INTO nukhabapay.staff_request_outbox(operation_id,scope_key) VALUES($1,$2)",[operation,tenant]);
        await fixture.query('COMMIT');
      } catch(error) {await fixture.query('ROLLBACK');throw error;}
      const binding={targetStaffId:beneficiary.user,tenantId:tenant,requestId:request.id,requestVersion:'1',requestDigest:digest};
      return {tenant,requester,beneficiary,reviewer,request,
        execute:{...binding,actorStaffId:requester.user,purpose:'EXECUTE',approvalDigest:canonicalDigest([]),idempotencyKey:randomUUID(),expiresAtMs:Date.now()+60000},
        decision:{...binding,actorStaffId:reviewer.user,purpose:'DECIDE',slot:'SECURITY_ADMIN',decision:'APPROVE',
          approvalDigest:canonicalDigest([]),idempotencyKey:randomUUID(),expiresAtMs:request.expiresAtMs}};
    }

    async function committed(f) {
      const {rows:[row]}=await fixture.query(`SELECT status,version::int AS version,
        (SELECT count(*)::int FROM nukhabapay.staff_effect_receipts WHERE request_id=$2) AS receipts,
        (SELECT count(*)::int FROM nukhabapay.security_audit_events WHERE request_id=$2 AND target_type='STAFF_MEMBERSHIP') AS audit
        FROM nukhabapay.staff_memberships WHERE id=$1`,[f.beneficiary.membership,f.request.id]);
      return row;
    }

    function cancel(f){
      return fixture.query(`INSERT INTO nukhabapay.staff_request_cancellations(request_id,request_version,request_digest,requester_staff_id,target_staff_id,
        scope_key,operation_id,idempotency_key,cancelled_at_ms) VALUES($1,1,$2,$3,$4,$5,$6,$7,$8)`,
      [f.request.id,f.execute.requestDigest,f.requester.user,f.beneficiary.user,f.tenant,hash(f.request.id),randomUUID(),Date.now()]);
    }
    async function approve(f) {
      assert.equal((await run(f.decision,f.reviewer.subject)).kind,'RECORDED');
      const {rows:[row]} = await fixture.query('SELECT * FROM nukhabapay.staff_effect_decisions WHERE request_id=$1',[f.request.id]);
      return {...f.execute,approvalDigest:canonicalDigest([[row.slot,row.reviewer_staff_id,row.reviewer_authz_version,
        row.request_id,row.request_version,row.request_digest,'staff-lifecycle-v1',row.decision,Number(row.decided_at_ms),Number(row.expires_at_ms)]])};
    }
    const unchanged={status:'ACTIVE',version:1,receipts:0,audit:0};

    const actors = new TrustedStaffActorBoundary({
      repository:new StaffIdentityPostgresRepository(pool), sessionIssuers:[issuer], now:()=>new Date(),
      auditWriter:{async appendSecurityAuditEvents(){}},
    });
    const sessionTarget=new URL(target);
    sessionTarget.username='nukh_effect_session';
    sessionTarget.password=randomUUID();
    sessionStore=await createDisposableStaffSessionStore({connectionString:sessionTarget.href,
      expectedRole:'nukh_effect_session',expectedDatabase:database});
    const sessions = new StaffSessionLifecycle({actors,now:()=>new Date(),enabled:true,store:sessionStore});
    async function admit(person,tenant) {
      const time=Math.floor(Date.now()/1000);
      const identity=attestVerifiedStaffIdentity({issuer,subject:person.subject,security:{
        audience:'urn:fixture:staff',clientId:'fixture',profile:'rfc9068-staff-v1',principalKind:'human',
        issuedAt:time-1,expiresAt:time+120,assurance:'not-established',
      }});
      const result=await actors.establish(identity,tenant);
      assert.equal(result.allowed,true);
      const issued=await sessions.create(result.actor);
      assert.equal(issued.ok,true);
      return issued.credential.cookieValue();
    }
    await t.test('effective suspension commits canonical state, session version invalidation, audit and receipt',async()=>{
      const f=await setup(true);
      assert.equal((await run(f.execute,f.requester.subject)).kind,'DENIED');
      assert.deepEqual(await committed(f),unchanged);
      const command=await approve(f);
      const victimToken=await admit(f.beneficiary,f.tenant);
      assert.equal((await sessions.validate(victimToken)).ok,true);
      assert.equal((await run(command,f.requester.subject)).kind,'APPLIED');
      const revocations=(await fixture.query(`SELECT e.reason FROM nukhbapay_sessions.events e JOIN nukhbapay_sessions.sessions s ON s.id=e.session_id
        WHERE s.token_hash=$1 AND e.event_name='SESSION_REVOKED'`,[hash(victimToken)])).rows;
      assert.deepEqual(revocations,[{reason:'AUTHORITY_CHANGED'}]);
      assert.equal((await sessions.validate(victimToken)).ok,false);
      assert.equal((await sessions.verifyRevocation(victimToken)).ok,true);
      assert.deepEqual(await committed(f),{status:'SUSPENDED',version:2,receipts:1,audit:1});
      assert.equal((await run(command,f.requester.subject)).kind,'REPLAYED');
      await assert.rejects(cancel(f),{code:'42501'});
      assert.equal((await run({...command,idempotencyKey:randomUUID()},f.requester.subject)).kind,'DENIED');
      await assert.rejects(fixture.query('DELETE FROM nukhabapay.staff_effect_receipts WHERE request_id=$1',[f.request.id]),{code:'23000'});
    });
    await t.test('audit failure rolls back the canonical effect and its receipt',async()=>{
      const f=await setup();
      const victimToken=await admit(f.beneficiary,f.tenant);
      await fixture.query(`CREATE FUNCTION nukhabapay.fail_effect_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'Controlled fixture audit failure'; END $$;
        CREATE TRIGGER fail_effect_audit BEFORE INSERT ON nukhabapay.security_audit_events
        FOR EACH ROW EXECUTE FUNCTION nukhabapay.fail_effect_audit()`);
      try {
        assert.equal((await run(f.execute,f.requester.subject)).kind,'DENIED');
        assert.deepEqual(await committed(f),unchanged);
        assert.equal((await sessions.validate(victimToken)).ok,true);
      } finally {await fixture.query('DROP TRIGGER fail_effect_audit ON nukhabapay.security_audit_events');}
      assert.equal((await run(f.execute,f.requester.subject)).kind,'APPLIED');
    });
    await t.test('forged, expired, cross-tenant and replayed proof cannot mutate',async()=>{
      const f=await setup();
      assert.equal((await executor.run(f.execute,{},session)).kind,'DENIED');
      assert.equal((await run(f.execute,f.requester.subject,{profile:'SYNTHETIC_TEST_EVENT'})).kind,'DENIED');
      assert.equal((await run(f.execute,f.requester.subject,{lifetime:-1})).kind,'DENIED');
      assert.equal((await run({...f.execute,tenantId:randomUUID()},f.requester.subject)).kind,'DENIED');
      assert.equal((await run(f.execute,f.beneficiary.subject)).kind,'DENIED');
      const proof=issue(f.execute,f.requester.subject);
      assert.equal((await executor.run({...f.execute,requestVersion:'2'},proof,session)).kind,'DENIED');
      assert.equal((await executor.run(f.execute,proof,session)).kind,'DENIED');
      assert.deepEqual(await committed(f),unchanged);
      await assert.rejects(pool.query("UPDATE nukhabapay.staff_memberships SET status='SUSPENDED' WHERE id=$1",[f.beneficiary.membership]),{code:'42501'});
      await assert.rejects(pool.query("SELECT nukhabapay.apply_staff_membership_effect('{}',$1)", ['0'.repeat(64)]),{code:'42501'});
      await assert.rejects(pool.query('SELECT secret FROM nukhbapay_effect_private.signing_key'),{code:'42501'});
    });
    await t.test('stale reviewer, rejection, self-approval and cancellation deny effective execution',async()=>{
      const f=await setup(true);
      assert.equal((await run({...f.decision,actorStaffId:f.requester.user},f.requester.subject)).kind,'DENIED');
      assert.equal((await run({...f.decision,actorStaffId:f.beneficiary.user},f.beneficiary.subject)).kind,'DENIED');
      const command=await approve(f);
      await fixture.query("UPDATE nukhabapay.platform_role_grants SET revoked_at=clock_timestamp() WHERE staff_id=$1",[f.reviewer.user]);
      assert.equal((await run(command,f.requester.subject)).kind,'DENIED');
      assert.deepEqual(await committed(f),unchanged);
      const g=await setup(true);
      assert.equal((await run({...g.decision,decision:'REJECT'},g.reviewer.subject)).kind,'RECORDED');
      assert.equal((await run(g.execute,g.requester.subject)).kind,'DENIED');
      const h=await setup();
      await cancel(h);
      assert.equal((await run(h.execute,h.requester.subject)).kind,'DENIED');
    });
    await t.test('simultaneous execution has one owner and one committed mutation',async()=>{
      const f=await setup();
      const outcomes=await Promise.all([run(f.execute,f.requester.subject),run(f.execute,f.requester.subject)]);
      assert.equal(outcomes.filter(row=>row.kind==='APPLIED').length,1,JSON.stringify(outcomes));
      assert.deepEqual(await committed(f),{status:'SUSPENDED',version:2,receipts:1,audit:1});
    });
    await t.test('HTTPS approval and signed step-up commit the effective membership and session revocation',async()=>{
      const f=await setup(true);
      const key=await generateKeyPair('RS256');
      const jwk={...await exportJWK(key.publicKey),kid:'staff-effective-fixture',alg:'RS256',use:'sig'};
      let nonce='';
      const clientId='staff-effect-browser',audience='urn:fixture:staff';
      const principal='https://claims.fixture.invalid/principal';
      let subject=f.reviewer.subject,eventId=randomUUID();
      const ca=readFileSync(process.env.NUKHBAPAY_STAFF_TEST_CA_PATH);
      const pfx=readFileSync(process.env.NUKHBAPAY_STAFF_TEST_PFX_PATH);
      const passphrase=process.env.NUKHBAPAY_STAFF_TEST_PASSPHRASE;
      assert.ok(passphrase);
      const portReservation=reservePort().listen(0,'127.0.0.1');
      await once(portReservation,'listening');
      const {port}=portReservation.address();
      await new Promise(resolve=>portReservation.close(resolve));
      const origin='https://localhost:'+port;
      const route='/staff-api/commands/suspension';

      function call(path,method='GET',headers={},body) {
        return new Promise((resolve,reject)=>{
          const req=request({hostname:'127.0.0.1',servername:'localhost',port,path,method,agent:false,ca,
            headers:{host:'localhost:'+port,...headers}},res=>{
            let text='';
            res.on('data',chunk=>{text+=chunk;});
            res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:text}));
          });
          req.on('error',reject);
          req.setTimeout(6000,()=>req.destroy(new Error('Fixture HTTPS response timed out')));
          req.end(body);
        });
      }
      const login=new Auth0Login({issuer,clientId,audience,clientSecret:'fixture-only-'+randomUUID(),
        staffKindClaim:principal,callbackUrl:origin+'/auth/callback',tenantId:f.tenant},{
        actors,sessions,
        stepUpPolicy:async command=>command.tenantId===f.tenant &&
          (command.operation==='DECIDE_SUSPENSION' ? command.permission==='platform.access.approve' : command.permission==='tenant.staff.suspend'),
        verifyStepUpFactor:async claims=>claims['fixture_factor_id']===eventId
          ?{eventId,authenticatedAtMs:Number(claims['fixture_factor_ms'])}:null,
        fetch:async url=>{
          if (String(url).endsWith('/.well-known/jwks.json')) return Response.json({keys:[jwk]});
          const ms=Date.now(),seconds=Math.floor(ms/1000);
          const sign=(value,typ)=>new SignJWT(value).setProtectedHeader({alg:'RS256',kid:jwk.kid,typ}).sign(key.privateKey);
          const common={iss:issuer,sub:subject,iat:seconds,exp:seconds+180};
          const access=await sign({...common,aud:audience,client_id:clientId,jti:randomUUID(),[principal]:'human'},'at+jwt');
          const id=await sign({...common,aud:clientId,nonce,auth_time:seconds,amr:['pwd','mfa'],
            at_hash:createHash('sha256').update(access).digest().subarray(0,16).toString('base64url'),
            fixture_factor_id:eventId,fixture_factor_ms:ms},'JWT');
          return Response.json({token_type:'Bearer',expires_in:180,id_token:id,access_token:access});
        },
      });
      async function callback(location,cookie){
        const url=new URL(location);
        nonce=url.searchParams.get('nonce');
        const response=await call('/auth/callback?'+new URLSearchParams({code:'fixture',state:url.searchParams.get('state')}),
          'GET',{cookie,'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'});
        assert.equal(response.status,303,response.body);
        assert.equal((await call('/auth/callback?'+new URLSearchParams({code:'fixture',state:url.searchParams.get('state')}),
          'GET',{cookie})).status,401);
        return {cookie:response.headers['set-cookie'].find(value=>value.startsWith('__Host-nukhbapay_staff=')).split(';')[0],
          redirect:response.headers.location};
      }
      async function authenticate(){
        const result=await call('/auth/login');
        assert.equal(result.status,303);
        return (await callback(result.headers.location,result.headers['set-cookie'][0].split(';')[0])).cookie;
      }
      async function credentials(cookie){
        const response=await call('/auth/session','GET',{cookie});
        assert.equal(response.status,200);
        return {cookie,origin,'content-type':'application/json','x-csrf-token':JSON.parse(response.body).csrfToken};
      }
      async function advance(cookie,idempotencyKey,decision){
        const headers=await credentials(cookie);
        const payload=JSON.stringify({requestId:f.request.id,idempotencyKey,...(decision&&{decision})});
        assert.equal((await call(route,'POST',{...headers,'x-csrf-token':'A'.repeat(43)},payload)).status,403);
        const start=await call(route,'POST',headers,payload);
        assert.equal(start.status,200,start.body);
        const ready=await callback(JSON.parse(start.body).location,start.headers['set-cookie'][0].split(';')[0]);
        assert.equal(ready.redirect,'/staff/commands');
        assert.equal((await call(route,'GET',{cookie})).status,401);
        return credentials(ready.cookie);
      }
      let app;
      try {
        authenticateBff=disposableSuspensionAssurance(login);
        app=await createStaffPortal({port,certificate:ca,pfx,passphrase,login,sessions,
          staffSuspension:connectDisposableStaffSuspension(executor),environment:{}});
        const reviewerCookie=await authenticate();
        const review=await advance(reviewerCookie,f.decision.idempotencyKey,'APPROVE');
        assert.deepEqual(JSON.parse((await call(route,'GET',review)).body),
          {state:'READY',targetStaffId:f.beneficiary.user,requestId:f.request.id,requestVersion:'1',decision:'APPROVE'});
        assert.equal((await call(route+'/confirm','POST',review,'{"decision":"REJECT"}')).status,400);
        assert.deepEqual(JSON.parse((await call(route+'/confirm','POST',review,'{}')).body),{state:'RECORDED'});
        assert.equal((await call(route+'/confirm','POST',review,'{}')).status,428);
        const duplicate={requestId:f.request.id,idempotencyKey:randomUUID(),decision:'REJECT'};
        assert.equal((await call(route,'POST',review,JSON.stringify(duplicate))).status,403);
        const evidence=(await fixture.query(`SELECT d.reviewer_staff_id,d.decision,a.actor_staff_id,a.tenant_id,a.request_id
          FROM nukhabapay.staff_effect_decisions d JOIN nukhabapay.security_audit_events a ON a.id=d.audit_event_id
          WHERE d.request_id=$1`,[f.request.id])).rows;
        assert.deepEqual(evidence,[{reviewer_staff_id:f.reviewer.user,decision:'APPROVE',actor_staff_id:f.reviewer.user,
          tenant_id:f.tenant,request_id:f.request.id}]);
        assert.deepEqual(await committed(f),unchanged);

        subject=f.requester.subject;
        eventId=randomUUID();
        const requester=await authenticate();
        const selfApproval={requestId:f.request.id,idempotencyKey:randomUUID(),decision:'APPROVE'};
        assert.equal((await call(route,'POST',await credentials(requester),JSON.stringify(selfApproval))).status,403);
        const confirmation=await advance(requester,f.execute.idempotencyKey);
        assert.deepEqual(JSON.parse((await call(route,'GET',confirmation)).body),
          {state:'READY',targetStaffId:f.beneficiary.user,requestId:f.request.id,requestVersion:'1'});
        const beneficiaryActor=await actors.establish(attestVerifiedStaffIdentity({issuer,subject:f.beneficiary.subject,security:{
          profile:'rfc9068-staff-v1',principalKind:'human',assurance:'not-established',audience,clientId,
          issuedAt:Math.floor(Date.now()/1000)-1,expiresAt:Math.floor(Date.now()/1000)+120,
        }}),f.tenant);
        assert.ok(beneficiaryActor.allowed);
        const beneficiarySession=await sessions.create(beneficiaryActor.actor);
        assert.ok(beneficiarySession.ok);
        const beneficiaryCookie=staffCookie(beneficiarySession.credential.cookieValue()).split(';')[0];
        assert.equal((await call('/auth/session','GET',{cookie:beneficiaryCookie})).status,200);
        assert.deepEqual(JSON.parse((await call(route+'/confirm','POST',confirmation,'{}')).body),{state:'APPLIED'});
        assert.equal((await call(route+'/confirm','POST',confirmation,'{}')).status,428);
        assert.equal((await call('/auth/session','GET',{cookie:beneficiaryCookie})).status,401);
        assert.deepEqual(await committed(f),{status:'SUSPENDED',version:2,receipts:1,audit:1});
      } finally {authenticateBff=undefined;await app?.close();login.close();}
    });
    await t.test('decision and factor consumption roll back on audit failure and duplicate reviews cannot append',async()=>{
      const f=await setup(true);
      const eventId=randomUUID();
      await fixture.query(`CREATE FUNCTION nukhabapay.reject_fixture_review_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Fixture audit failure'; END $$;
        CREATE TRIGGER reject_fixture_review_audit BEFORE INSERT ON nukhabapay.security_audit_events
        FOR EACH ROW WHEN(NEW.target_type='AUTHORIZATION') EXECUTE FUNCTION nukhabapay.reject_fixture_review_audit()`);
      try {
        assert.equal((await run(f.decision,f.reviewer.subject,{eventId})).kind,'DENIED');
        assert.equal((await fixture.query('SELECT 1 FROM nukhabapay.staff_effect_authorizations WHERE event_id=$1',[eventId])).rowCount,0);
        assert.equal((await fixture.query('SELECT 1 FROM nukhabapay.staff_effect_decisions WHERE request_id=$1',[f.request.id])).rowCount,0);
      } finally {await fixture.query('DROP TRIGGER reject_fixture_review_audit ON nukhabapay.security_audit_events');}
      assert.equal((await run(f.decision,f.reviewer.subject,{eventId})).kind,'RECORDED');
      assert.equal((await run({...f.decision,decision:'REJECT'},f.reviewer.subject)).kind,'DENIED');
      assert.equal((await fixture.query('SELECT 1 FROM nukhabapay.security_audit_events WHERE request_id=$1',[f.request.id])).rowCount,1);
    });
    await t.test('authority writes cannot race the effect, and async expiry rolls the transaction back',async()=>{
      const f=await setup();
      let checks=0;
      beforeRecheck=async()=>{
        if (++checks!==3) return;
        await assert.rejects(fixture.query("UPDATE nukhabapay.staff_users SET authz_version=2 WHERE id=$1",[f.requester.user]),{code:'40001'});
        await new Promise(resolve=>setTimeout(resolve,400));
      };
      try {
        const outcome=await run(f.execute,f.requester.subject,{lifetime:300});
        assert.equal(outcome.kind,'DENIED');
        assert.equal(checks,3);
        assert.deepEqual(await committed(f),unchanged);
      } finally {beforeRecheck=undefined;}
    });
  } finally {
    await sessionStore?.close();
    await pool?.end();
    await fixture?.end();
    await owner.end();
  }
});
