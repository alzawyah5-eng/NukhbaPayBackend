import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { up as catalogue } from '../../packages/database/migrations/001_catalog.ts';
import { up as identity } from '../../packages/database/migrations/004_staff_identity_foundation.ts';
import { createDisposableStaffSessionStore } from '../../packages/database/dist/database/src/staff-session-store.js';
import { createDisposablePlatformStaffExecutor, DISPOSABLE_PLATFORM_STAFF_EFFECT, AUTH0_PLATFORM_STAFF_PILOT } from '../../packages/database/dist/database/src/platform-staff-executor.js';
import { StaffIdentityPostgresRepository } from '../../packages/database/dist/database/src/repositories/staff-identity-repository.js';
import { attestVerifiedStaffIdentity } from '../../packages/application/dist/application/src/identity/verified-staff-identity.js';
import { StaffSessionLifecycle, TrustedStaffActorBoundary } from '../../packages/application/dist/application/src/index.js';
import { Auth0Login } from '../../apps/admin-web/dist/auth0.js';
import { createAuth0FactorClaimVerifier } from '../../apps/admin-web/dist/auth0-factor-claim.js';
import { beginPlatformStaffStepUp, platformStaffAssuranceConsumer } from '../../apps/admin-web/dist/platform-staff-step-up.js';

const { Client, Pool } = createRequire(new URL('../../packages/database/package.json', import.meta.url))('pg');
const {exportJWK,generateKeyPair,SignJWT}=createRequire(new URL('../../apps/admin-web/package.json',import.meta.url))('jose');
const issuer = 'https://platform-staff.fixture.invalid/';
const hash = value => createHash('sha256').update(value).digest('hex');

test('owner-approved platform staff effects on disposable PostgreSQL', async t => {
  const { NUKHBA_DISPOSABLE_PG: origin, NUKHBA_DISPOSABLE_PG_DIRECTORY: directory } = process.env;
  assert.ok(origin && directory);
  const target = new URL(origin);
  assert.equal(target.hostname, '127.0.0.1');
  assert.equal(target.username, 'nukh_fixture');
  assert.equal(target.pathname, '/postgres');
  assert.ok(Number(target.port)>1024 && !['5432','55437'].includes(target.port));
  const owner = new Client({connectionString: origin});
  const database = 'nukhabapay_effect_'+randomUUID().replaceAll('-','');
  let fixture, pool, identityPool, store;
  await owner.connect();
  try {
    const root = (await owner.query('SHOW data_directory')).rows[0].data_directory;
    assert.equal(root.replaceAll('\\','/').toLowerCase(),directory.replaceAll('\\','/').toLowerCase());
    await owner.query('CREATE DATABASE '+database);
    await owner.query('REVOKE TEMP ON DATABASE '+database+' FROM PUBLIC');
    target.pathname='/'+database;
    fixture = new Client({connectionString:target.href});
    await fixture.connect();
    await fixture.query('CREATE SCHEMA nukhabapay; CREATE ROLE nukhabapay_runtime; CREATE ROLE nukhabapay_importer; CREATE ROLE nukhabapay_identity_reader; CREATE ROLE nukhabapay_identity_writer;');
    const migrations=[];
    catalogue({sql:s=>migrations.push(s)});
    identity({sql:s=>migrations.push(s)});
    for (const sql of migrations) await fixture.query(sql);
    for (const file of ['staff-access-request-records.sql','staff-request-cancellation-PROPOSAL.sql'])
      await fixture.query(readFileSync(new URL('../../packages/database/pending-migrations/'+file,import.meta.url),'utf8'));
    for (const file of ['staff-effective-membership.sql','staff-effective-sessions.sql','staff-effective-platform.sql'])
      await fixture.query(readFileSync(new URL('../../packages/database/fixtures/'+file,import.meta.url),'utf8'));
    const signingKey = randomBytes(32);
    await fixture.query('INSERT INTO nukhbapay_effect_private.signing_key VALUES(true,$1)',[signingKey]);
    target.username='nukh_platform_executor';
    pool=new Pool({connectionString:target.href,max:3,connectionTimeoutMillis:2500});
    const restrictedSession=new URL(target);
    restrictedSession.username='nukh_effect_session';
    restrictedSession.password='disposable-placeholder';
    store=await createDisposableStaffSessionStore({connectionString:restrictedSession.href,expectedRole:'nukh_effect_session',expectedDatabase:database});
    const identityTarget=new URL(target);
    identityTarget.username='nukh_effect_executor';
    identityPool=new Pool({connectionString:identityTarget.href,max:2,connectionTimeoutMillis:2500});
    const identities = new StaffIdentityPostgresRepository(identityPool);
    const actors = new TrustedStaffActorBoundary({repository:identities,auditWriter:{appendSecurityAuditEvents:async()=>{}},now:()=>new Date()});
    const sessions = new StaffSessionLifecycle({actors,store,enabled:true,now:()=>new Date()});
    const minted=new WeakMap();
    let commitHook, loseCommit=false;
    const observedPool={query:(...args)=>pool.query(...args),async connect(){
      const client=await pool.connect();
      return {release:discard=>client.release(discard), async query(...args){
        const result=await client.query(...args);
        if(loseCommit && args[0]==='COMMIT'){loseCommit=false;throw new Error('Fixture COMMIT acknowledgement lost');}
        return result;
      }};
    }};
    const executor=await createDisposablePlatformStaffExecutor(observedPool,{capability:DISPOSABLE_PLATFORM_STAFF_EFFECT,signingKey,
      async consumeAssurance(intent,proof,credential) {
        const claim=minted.get(proof);
        minted.delete(proof);
        if(!claim || claim.intentDigest!==intent.intentDigest || claim.sessionDigest!==hash(credential))return null;
        let calls=0;
        return {...claim,async revalidate(){if(++calls===2)await commitHook?.(); return Date.now()<claim.expiresAtMs;}};
      }});

    const tenants=[randomUUID(),randomUUID()];
    for (const tenant of tenants) await fixture.query('INSERT INTO nukhabapay.tenants(id,tenant_key) VALUES($1,$2)',[tenant,tenant]);

    async function person(role) {
      const id=randomUUID(),subject='fixture-'+id,issuedAt=Math.floor(Date.now()/1000)-1;
      await fixture.query("INSERT INTO nukhabapay.staff_users(id,display_name,contact_email,status,authz_version) VALUES($1,'Fixture',$2,'ACTIVE',1)",[id,id+'@fixture.invalid']);
      await fixture.query("INSERT INTO nukhabapay.staff_identities(id,staff_id,issuer,subject,status) VALUES($1,$2,$3,$4,'ACTIVE')",[randomUUID(),id,issuer,subject]);
      for(const tenant of tenants) await fixture.query("INSERT INTO nukhabapay.staff_memberships(id,staff_id,tenant_id,status) VALUES($1,$2,$3,'ACTIVE')",[randomUUID(),id,tenant]);
      if(role)await fixture.query("INSERT INTO nukhabapay.platform_role_grants(id,staff_id,role_code,scope,granted_at,grant_source,evidence_reference) VALUES($1,$2,$3,'PLATFORM',clock_timestamp()-interval '1 hour','TEST','platform-fixture')",[randomUUID(),id,role]);
      const identity=attestVerifiedStaffIdentity({issuer,subject,security:{audience:'urn:platform-fixture',clientId:'platform-fixture',profile:'rfc9068-staff-v1',
        principalKind:'human',issuedAt,expiresAt:issuedAt+180,assurance:'not-established'}});
      const actor={id,subject,issuedAt,identity};
      return {...actor,credential:(await openSession(actor)).credential};
    }

    async function openSession(person,tenant) {
      const result=await actors.establish(person.identity,tenant);
      assert.equal(result.allowed,true,result.reason);
      const created=await sessions.create(result.actor);
      assert.equal(created.ok,true,created.reason);
      const credential=created.credential.cookieValue();
      const row=(await fixture.query('SELECT id,scope_key,creation_operation_id FROM nukhbapay_sessions.sessions WHERE token_hash=$1',[hash(credential)])).rows[0];
      return {credential,id:row.id,scope:row.scope_key,creation:row.creation_operation_id};
    }

    async function credentialAfterCutoff(person, cutoff) {
      const nextSecond=Math.floor(cutoff.getTime()/1000)+1;
      await new Promise(resolve=>setTimeout(resolve,Math.max(0,nextSecond*1000-Date.now())+10));
      return attestVerifiedStaffIdentity({issuer,subject:person.subject,security:{...person.identity.security,
        issuedAt:nextSecond,expiresAt:nextSecond+180}});
    }

    const requester=await person('SECURITY_ADMIN'),security=await person('SECURITY_ADMIN'),governance=await person('GOVERNANCE_OWNER');
    const unprivileged=await person('PLATFORM_AUDITOR');
    const attest=(intent,person,{credential=person.credential, eventId=randomUUID(), lifetime=30000, profile=DISPOSABLE_PLATFORM_STAFF_EFFECT}={})=>{
      const proof=Object.freeze({});
      minted.set(proof,{intentDigest:intent.intentDigest,sessionDigest:hash(credential),profile,eventId,actorStaffId:person.id,
        issuer,subject:person.subject,identityIssuedAtMs:person.issuedAt*1000,expiresAtMs:Date.now()+lifetime});
      return proof;
    };
    const run=(intent,person,opts)=>executor.run(intent,attest(intent,person,opts),opts?.credential??person.credential);
    const follow=(submit,action,actor=requester,overrides={})=>executor.prepare({
      scope:'PLATFORM',action,command:submit.command,actorStaffId:actor.id,targetStaffId:submit.targetStaffId,
      requestId:submit.requestId,requestVersion:submit.requestVersion,requestDigest:submit.requestDigest,idempotencyKey:submit.idempotencyKey,...overrides,
    });
    const submit=(person,target,fields={})=>executor.prepare({action:'SUBMIT',idempotencyKey:randomUUID(),previousDigest:fields.previousDigest??null,
      proposal:{scope:'PLATFORM',requestId:fields.id??randomUUID(),requestVersion:fields.version??1n,requesterStaffId:person.id,requesterAuthzVersion:1n,
        target:{authzVersion:1n,...target},requestedAtMs:Date.now()-50,expiresAtMs:fields.expiry??Date.now()+120000}});
    const one=(person,session)=>({kind:'REVOKE_SESSION',staffId:person.id,sessionId:session.id,creationOperationId:session.creation,sessionScope:session.scope});
    const broad=(person,kind)=>({kind,staffId:person.id,currentCutoffMs:null});
    const approved=async(request,second=true)=>{
      assert.equal((await run(request,requester)).kind,'RECORDED');
      assert.equal((await run(follow(request,'APPROVE',security),security)).kind,'RECORDED');
      if(second)assert.equal((await run(follow(request,'APPROVE',governance),governance)).kind,'RECORDED');
    };
    const revoked=async(person)=>(await fixture.query("SELECT session_id FROM nukhbapay_sessions.events WHERE actor_staff_id=$1 AND event_name='SESSION_REVOKED'",[person.id])).rows.map(row=>row.session_id);

    await t.test('permissions are split, scopes are explicit and executor has function-only effect access',async()=>{
      const result=await fixture.query("SELECT code,scope,activation_phase FROM nukhabapay.iam_permissions WHERE code LIKE 'platform.sessions.%' OR code='platform.staff.suspend' OR code='tenant.staff.suspend'");
      assert.equal(result.rowCount,4);
      assert.ok(result.rows.every(x=>x.scope==='PLATFORM'?x.activation_phase==='3D':x.activation_phase==='3C'));
      await assert.rejects(pool.query('SELECT * FROM nukhabapay.platform_staff_receipts'),{code:'42501'});
      await assert.rejects(pool.query("UPDATE nukhabapay.staff_users SET status='SUSPENDED'"),{code:'42501'});
      await assert.rejects(pool.query("SELECT nukhabapay.apply_platform_staff_effect('{}',$1)",['0'.repeat(64)]),{code:'42501'});
      for(const approvedIssuer of [issuer,'https://unconfigured.example.com/'])
        await assert.rejects(createDisposablePlatformStaffExecutor(pool,{capability:AUTH0_PLATFORM_STAFF_PILOT,
          signingKey,approvedIssuer,consumeAssurance:async()=>null}),{message:'Platform staff effect unavailable'});
    });

    await t.test('signed Auth0 fixture login and step-up drive independent approval and the guarded platform effect',async()=>{
      const clientId='platform-fixture', audience='urn:platform-fixture', claim='https://claims.fixture.invalid/staff',
        factor='https://claims.fixture.invalid/factor';
      const pair=await generateKeyPair('RS256'), jwk={...await exportJWK(pair.publicKey),kid:'platform-fixture',alg:'RS256',use:'sig'};
      let current, nonce, pendingIntent;
      const signed=async(payload,typ)=>new SignJWT(payload).setProtectedHeader({alg:'RS256',kid:jwk.kid,typ}).sign(pair.privateKey);
      const login=new Auth0Login({issuer,clientId,clientSecret:'synthetic-fixture-'.repeat(3),audience,staffKindClaim:claim,
        callbackUrl:'https://localhost:3001/auth/callback',tenantId:null},{actors,sessions,
        stepUpPolicy:async command=>command.operation==='PLATFORM_STAFF_SECURITY' && command.intentDigest===pendingIntent?.intentDigest,
        verifyStepUpFactor:createAuth0FactorClaimVerifier({claimName:factor,version:'fixture-v1',acceptedFactors:['otp']}),
        fetch:async url=>{
          if(url===issuer+'.well-known/jwks.json')return Response.json({keys:[jwk]});
          assert.equal(url,issuer+'oauth/token');
          const nowMs=Date.now(), seconds=Math.floor(nowMs/1000), sub=current.subject;
          const access=await signed({iss:issuer,sub,aud:audience,client_id:clientId,iat:seconds,exp:seconds+300,jti:randomUUID(),[claim]:'human'},'at+jwt');
          const idToken=await signed({iss:issuer,sub,aud:clientId,nonce,iat:seconds,exp:seconds+300,auth_time:seconds,amr:['pwd','mfa'],
            at_hash:createHash('sha256').update(access).digest().subarray(0,16).toString('base64url'),
            [factor]:{version:'fixture-v1',eventId:randomUUID(),challengeNonce:nonce,factor:'otp',completedAtMs:nowMs}},'JWT');
          return Response.json({token_type:'Bearer',expires_in:300,id_token:idToken,access_token:access});
        }});
      const composed=await createDisposablePlatformStaffExecutor(pool,{capability:DISPOSABLE_PLATFORM_STAFF_EFFECT,signingKey,
        consumeAssurance:platformStaffAssuranceConsumer(login,DISPOSABLE_PLATFORM_STAFF_EFFECT)});
      const callback=async(start,who,prior)=>{
        current=who;
        const url=new URL(start.location);
        nonce=url.searchParams.get('nonce');
        const transaction=start.cookie.split(';',1)[0].split('=')[1];
        return login.completeBrowserCallback('/auth/callback?'+new URLSearchParams({state:url.searchParams.get('state'),code:'fixture'}),transaction,prior);
      };
      const normalize=composed.prepare;
      const cookies=new Map();
      const act=async(input,actor)=>{
        pendingIntent=normalize(input);
        assert.ok(pendingIntent);
        const previous=cookies.get(actor.id)??(await callback(login.begin(),actor)).token;
        const start=await beginPlatformStaffStepUp(login,pendingIntent,previous,Date.now()+25000);
        const result=await callback(start,actor,previous);
        cookies.set(actor.id,result.token);
        return composed.run(pendingIntent,result.stepUp,result.token);
      };
      try {
        const victim=await person(), requestId=randomUUID(), key=randomUUID(), target=await openSession(victim,tenants[0]);
        const submitted={action:'SUBMIT',idempotencyKey:key,previousDigest:null,proposal:{scope:'PLATFORM',requestId,requestVersion:1n,
          requesterStaffId:requester.id,requesterAuthzVersion:1n,target:{...one(victim,target),authzVersion:1n},
          requestedAtMs:Date.now()-100,expiresAtMs:Date.now()+120000}};
        const digest=normalize(submitted).requestDigest;
        const next=(action,actor)=>({action,scope:'PLATFORM',actorStaffId:actor.id,targetStaffId:victim.id,requestId,
          requestVersion:'1',requestDigest:digest,command:'REVOKE_SESSION',idempotencyKey:key});
        assert.equal((await act(submitted,requester)).kind,'RECORDED');
        assert.equal((await act(next('APPROVE',security),security)).kind,'RECORDED');
        const result=await act(next('EXECUTE',requester),requester);
        assert.equal(result.kind,'APPLIED');
        assert.equal((await sessions.validate(target.credential)).ok,false);
        const row=(await fixture.query('SELECT audit_id FROM nukhabapay.platform_staff_receipts WHERE id=$1',[result.receiptId])).rows[0];
        assert.equal(row.audit_id,result.auditId);
      } finally {login.close();}
    });

    await t.test('one session revocation protects sibling and unrelated tenant sessions and reconciles one immutable receipt',async()=>{
      const victim=await person(), other=await person();
      const session=await openSession(victim,tenants[0]), sibling=await openSession(victim,tenants[1]), foreign=await openSession(other,tenants[0]);
      const bad=submit(requester,{...one(victim,session),sessionScope:tenants[1]});
      assert.equal((await run(bad,requester)).kind,'DENIED');
      assert.equal((await run(submit(requester,one(victim,foreign)),requester)).kind,'DENIED');
      const request=submit(requester,one(victim,session));
      await approved(request,false);
      const execute=follow(request,'EXECUTE');
      assert.equal((await run(follow(request,'EXECUTE',requester,{command:'REVOKE_ALL_SESSIONS'}),requester)).kind,'DENIED');
      const result=await run(execute,requester);
      assert.equal(result.kind,'APPLIED');
      assert.equal(result.revokedSessions,1);
      assert.ok(Object.isFrozen(result));
      assert.deepEqual(await revoked(victim),[session.id]);
      assert.equal((await sessions.validate(session.credential)).ok,false);
      assert.equal((await sessions.validate(sibling.credential)).ok,true);
      assert.equal((await sessions.validate(foreign.credential)).ok,true);
      const replay=await run(follow(request,'LOOKUP'),requester);
      assert.equal(replay.kind,'REPLAYED');
      assert.equal(replay.receiptId,result.receiptId);
      assert.equal((await run(follow(request,'LOOKUP',requester,{idempotencyKey:randomUUID()}),requester)).kind,'DENIED');
      await assert.rejects(fixture.query('UPDATE nukhabapay.platform_staff_receipts SET revoked_sessions=0'));
    });

    await t.test('platform grants, one-person independence, command proof and actor platform session are required',async()=>{
      const victim=await person('SECURITY_ADMIN'), session=await openSession(victim,tenants[0]);
      const request=submit(requester,one(victim,session));
      assert.equal((await run(request,requester)).kind,'RECORDED');
      assert.equal(follow(request,'APPROVE',victim),null);
      assert.equal((await run(follow(request,'APPROVE',requester),requester)).kind,'DENIED');
      assert.equal((await run(follow(request,'APPROVE',unprivileged),unprivileged)).kind,'DENIED');
      assert.equal((await run(follow(request,'APPROVE',governance),governance)).kind,'DENIED');
      const decision=follow(request,'APPROVE',security),execute=follow(request,'EXECUTE');
      assert.equal((await executor.run(decision,{},security.credential)).kind,'DENIED');
      assert.equal((await executor.run({...decision},attest(decision,security),security.credential)).kind,'DENIED');
      const wrongProof=attest(decision,security);
      assert.equal((await executor.run(execute,wrongProof,requester.credential)).kind,'DENIED');
      const tenantToken=(await openSession(security,tenants[0])).credential;
      assert.equal((await run(decision,security,{credential:tenantToken})).kind,'DENIED');
      assert.equal((await run(decision,security,{profile:'OPERATIONAL'})).kind,'DENIED');
      const eventId=randomUUID();
      assert.equal((await run(decision,security,{eventId})).kind,'RECORDED');
      assert.equal((await run(execute,requester,{eventId})).kind,'DENIED');
      assert.deepEqual(await revoked(victim),[]);
    });

    await t.test('all-session revocation requires quorum, advances cutoff and permits fresh enrolled access',async()=>{
      const victim=await person();
      const first=await openSession(victim,tenants[0]), second=await openSession(victim,tenants[1]);
      const request=submit(requester,broad(victim,'REVOKE_ALL_SESSIONS'));
      await approved(request,false);
      const execute=follow(request,'EXECUTE');
      assert.equal((await run(execute,requester)).kind,'DENIED');
      assert.equal((await run(follow(request,'APPROVE',security),security)).kind,'DENIED');
      assert.equal((await run(follow(request,'APPROVE',governance),governance)).kind,'RECORDED');
      const result=await run(execute,requester);
      assert.equal(result.kind,'APPLIED');
      assert.equal(result.revokedSessions,3);
      for(const s of [first.credential,second.credential,victim.credential])assert.equal((await sessions.validate(s)).ok,false);
      assert.equal((await actors.establish(victim.identity)).allowed,false);
      const state=(await fixture.query('SELECT status,authz_version,tokens_valid_after FROM nukhabapay.staff_users WHERE id=$1',[victim.id])).rows[0];
      assert.equal(state.status,'ACTIVE');
      assert.equal(state.authz_version,'2');
      assert.ok(state.tokens_valid_after instanceof Date);
      const fresh=await credentialAfterCutoff(victim,state.tokens_valid_after);
      const enrolled=await actors.establish(fresh);
      assert.equal(enrolled.allowed,true);
      assert.equal((await sessions.create(enrolled.actor)).ok,true);
    });

    await t.test('global suspension blocks canonical access and application rollback survives audit failure',async()=>{
      const victim=await person(), tenantSession=await openSession(victim,tenants[0]);
      const request=submit(requester,broad(victim,'SUSPEND_STAFF'));
      await approved(request);
      const execute=follow(request,'EXECUTE');
      await fixture.query("CREATE FUNCTION nukhabapay.fixture_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Fixture audit unavailable' USING ERRCODE='42501'; END$$; CREATE CONSTRAINT TRIGGER fixture_reject_audit AFTER INSERT ON nukhabapay.security_audit_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nukhabapay.fixture_reject_audit()");
      try { assert.equal((await run(execute,requester)).kind,'DENIED'); }
      finally { await fixture.query('DROP TRIGGER fixture_reject_audit ON nukhabapay.security_audit_events; DROP FUNCTION nukhabapay.fixture_reject_audit()'); }
      assert.deepEqual(await revoked(victim),[]);
      assert.equal((await run(follow(request,'LOOKUP'),requester)).kind,'ABSENT');
      loseCommit=true;
      assert.equal((await run(execute,requester)).kind,'UNRESOLVED');
      assert.equal((await run(follow(request,'LOOKUP'),requester)).kind,'REPLAYED');
      assert.equal((await sessions.validate(tenantSession.credential)).ok,false);
      assert.equal((await actors.establish(victim.identity)).allowed,false);
      const state=(await fixture.query('SELECT status,authz_version,tokens_valid_after FROM nukhabapay.staff_users WHERE id=$1',[victim.id])).rows[0];
      assert.equal(state.status,'SUSPENDED');
      assert.equal(state.authz_version,'2');
      const fresh=await credentialAfterCutoff(victim,state.tokens_valid_after);
      assert.equal((await actors.establish(fresh)).allowed,false);
    });

    await t.test('superseded, cancelled, rejected, expired and revoked authority fail closed',async()=>{
      const victim=await person(), target=broad(victim,'SUSPEND_STAFF');
      const request=submit(requester,target);
      await approved(request);
      const next=submit(requester,target,{id:request.requestId,version:2n,previousDigest:request.requestDigest});
      assert.equal((await run(next,requester)).kind,'RECORDED');
      assert.equal((await run(follow(request,'EXECUTE'),requester)).kind,'DENIED');
      assert.equal((await run(follow(next,'APPROVE',security),security)).kind,'RECORDED');
      assert.equal((await run(follow(next,'CANCEL'),requester)).kind,'RECORDED');
      assert.equal((await run(follow(next,'APPROVE',governance),governance)).kind,'DENIED');
      const rejected=submit(requester,target);
      assert.equal((await run(rejected,requester)).kind,'RECORDED');
      assert.equal((await run(follow(rejected,'REJECT',security),security)).kind,'RECORDED');
      assert.equal((await run(follow(rejected,'EXECUTE'),requester)).kind,'DENIED');
      const short=submit(requester,target,{expiry:Date.now()+220});
      assert.equal((await run(short,requester)).kind,'RECORDED');
      await new Promise(resolve=>setTimeout(resolve,240));
      assert.equal((await run(follow(short,'APPROVE',security),security)).kind,'DENIED');
      const current=submit(requester,target);
      await approved(current);
      await fixture.query('UPDATE nukhabapay.platform_role_grants SET revoked_at=clock_timestamp() WHERE staff_id=$1',[governance.id]);
      assert.equal((await run(follow(current,'EXECUTE'),requester)).kind,'DENIED');
    });

    await t.test('assurance expiry while the effect transaction is staged rolls back revocation and audit',async()=>{
      const victim=await person(), target=await openSession(victim,tenants[0]);
      const request=submit(requester,one(victim,target));
      await approved(request,false);
      const execute=follow(request,'EXECUTE');
      let reachedCommitCheck=false;
      commitHook=async()=>{reachedCommitCheck=true;await new Promise(resolve=>setTimeout(resolve,850));};
      try { assert.equal((await run(execute,requester,{lifetime:600})).kind,'DENIED'); }
      finally {commitHook=undefined;}
      assert.equal(reachedCommitCheck,true);
      assert.deepEqual(await revoked(victim),[]);
      assert.equal((await run(follow(request,'LOOKUP'),requester)).kind,'ABSENT');
      assert.equal((await run(execute,requester)).kind,'APPLIED');
    });

    await t.test('competing execution, logout and session creation serialize, with one effect and one audit',async()=>{
      const victim=await person();
      const target=await openSession(victim,tenants[0]), request=submit(requester,one(victim,target));
      await approved(request,false);
      const execute=follow(request,'EXECUTE');
      let entered, release;
      const start=new Promise(resolve=>{entered=resolve;});
      const hold=new Promise(resolve=>{release=resolve;});
      commitHook=async()=>{entered();await hold;};
      const first=run(execute,requester);
      try {
        await Promise.race([start,first.then(()=>{throw new Error('Expected held platform transaction');})]);
        assert.equal((await run(execute,requester)).kind,'DENIED');
        assert.equal((await sessions.revoke(target.credential)).ok,false);
        const attempt=await actors.establish(victim.identity,tenants[1]);
        assert.equal(attempt.allowed,true);
        assert.equal((await sessions.create(attempt.actor)).ok,false);
      } finally {release();commitHook=undefined;}
      assert.equal((await first).kind,'APPLIED');
      assert.equal((await run(execute,requester)).kind,'REPLAYED');
      assert.deepEqual(await revoked(victim),[target.id]);
      const audit=(await fixture.query("SELECT count(*)::int AS count FROM nukhabapay.security_audit_events WHERE request_id=$1 AND target_id=$2",[request.requestId,target.id])).rows[0];
      assert.equal(audit.count,1);
    });
  } finally {
    await store?.close();
    await identityPool?.end();
    await pool?.end();
    await fixture?.end();
    await owner.end();
  }
});
