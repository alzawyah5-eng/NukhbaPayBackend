import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:https";
import { X509Certificate } from "node:crypto";
import { Client } from "pg";
import { createStaffPortal, staffCookie } from "@nukhbapay/admin-web/portal";
import { StaffSessionLifecycle, TrustedStaffActorBoundary, type TrustedStaffActor, type StaffSessionStore } from "@nukhbapay/application";
import { createStaffSessionStore } from "@nukhbapay/database";
import { createIdentityRuntime } from "@nukhbapay/database/identity-runtime";
import { OidcAccessTokenVerifier } from "../src/modules/identity/oidc-access-token.verifier.js";
import { withDisposableIamDatabase, forDatabase } from "./fixtures/disposable-iam-database.js";
import { NOW, ISSUER, claims, environment, keySource, signingKey } from "./fixtures/oidc-test-issuer.js";

const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
test('restricted synthetic sessions persist atomically, revalidate actor authority and protect HTTPS cookies',async t=>{
  await withDisposableIamDatabase(async f=>{
    const admin=f.fixtureClient,db=f.databaseName;assert.match(db,/^nukhabapay_b3b3_[0-9a-f]{32}$/);
    const migration=new Client({connectionString:forDatabase(process.env['DB_MIGRATION_URL']!,db)});await migration.connect();
    const role='nukh_session_'+randomUUID().replaceAll('-','').slice(0,20);
    const stores:Awaited<ReturnType<typeof createStaffSessionStore>>[]=[];
    let runtime:Awaited<ReturnType<typeof createIdentityRuntime>>|undefined,createdRole=false;
    try {
      const acl=async()=>(await admin.query("SELECT c.relname,c.relacl::text FROM pg_class c WHERE c.relnamespace='nukhabapay'::regnamespace AND c.relkind='r' ORDER BY c.relname")).rows;
      const beforeAcl=await acl();
      await migration.query('BEGIN');
      try {
        await migration.query('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO nukhabapay_runtime,nukhabapay_importer');
        await migration.query('ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO nukhabapay_identity_writer');
        await migration.query(readFileSync(new URL('../../../../packages/database/pending-migrations/006_staff_server_sessions.sql',import.meta.url),'utf8'));
        await migration.query('COMMIT');
      }catch{await migration.query('ROLLBACK');throw new Error('Disposable proposed session migration failed');}
      assert.deepEqual(await acl(),beforeAcl);
      assert.equal((await admin.query('SELECT count(*)::int AS n FROM nukhabapay.schema_migrations')).rows[0].n,5);
      await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);createdRole=true;
      await migration.query('BEGIN');try{
        await migration.query("SELECT set_config('nukhbapay_sessions.backend_role',$1,true)",[role]);
        await migration.query(readFileSync(new URL('../../../../packages/database/roles/grant_staff_session_backend.sql',import.meta.url),'utf8'));
        await migration.query('COMMIT');
      }catch(error){await migration.query('ROLLBACK');throw error;}
      const url=new URL(forDatabase(process.env['DB_TEST_ADMIN_URL']!,db));url.username=role;url.password=randomUUID();
      const config={connectionString:url.href,expectedRole:role,expectedDatabase:db,poolMax:1};
      const storeA=await createStaffSessionStore(config),storeB=await createStaffSessionStore(config);stores.push(storeA,storeB);
      let dispatch=0;
      const store:StaffSessionStore={execute:ticket=>(++dispatch%2?storeA:storeB).execute(ticket)};
      const staff=randomUUID(),other=randomUUID(),tenant=randomUUID(),otherTenant=randomUUID(),member=randomUUID();
      await admin.query("INSERT INTO nukhabapay.tenants(id,tenant_key) VALUES($1,'session-a'),($2,'session-b')",[tenant,otherTenant]);
      await admin.query("INSERT INTO nukhabapay.staff_users(id,display_name,contact_email,status) VALUES($1,'Synthetic Session','session@example.invalid','ACTIVE'),($2,'Synthetic Other','other-session@example.invalid','ACTIVE')",[staff,other]);
      await admin.query("INSERT INTO nukhabapay.staff_identities(id,staff_id,issuer,subject,status) VALUES($1,$2,$3,'session-staff','ACTIVE'),($4,$5,$3,'session-other','ACTIVE')",[randomUUID(),staff,ISSUER,randomUUID(),other]);
      await admin.query("INSERT INTO nukhabapay.staff_memberships(id,staff_id,tenant_id,status) VALUES($1,$2,$3,'ACTIVE'),($4,$5,$6,'ACTIVE')",[member,staff,tenant,randomUUID(),other,otherTenant]);
      runtime=await createIdentityRuntime(f.runtimeEnv);
      let now=NOW;const clock=()=>new Date(now),key=await signingKey('staff-session-key'),source=keySource([key.publicJwk]);
      const verifier=new OidcAccessTokenVerifier(environment(),{fetchKeys:source.fetchKeys,now:clock});
      const boundary=()=>new TrustedStaffActorBoundary({...runtime!,now:clock});
      const actors=boundary();
      async function actor(subject='session-staff',scope?:string,b=actors) {
        const identity=await verifier.verify(await key.sign(claims({sub:subject,iat:Math.floor(now/1000),exp:Math.floor(now/1000)+300})));
        const result=await b.establish(identity,scope);assert.equal(result.allowed,true);if(!result.allowed)throw new Error('Synthetic actor denied');return result.actor;
      }
      const make=(sessionStore=store,b=actors)=>new StaffSessionLifecycle({actors:b,store:sessionStore,now:clock,enabled:true,idleMs:1000,absoluteMs:10000});
      const service=make();
      async function create(s=service,a?:TrustedStaffActor){const result=await s.create(a??await actor('session-staff',tenant));assert.equal(result.ok,true);if(!result.ok)throw new Error('Synthetic session creation denied');return result.credential.cookieValue();}
      const count=async(table:string,where='',params:unknown[]=[])=>(await admin.query(`SELECT count(*)::int AS n FROM nukhbapay_sessions.${table} ${where}`,params)).rows[0].n as number;
      await t.test('SQL grants are append/read only; existing catalogue and IAM roles gain no session access',async()=>{
        const grants=(await admin.query("SELECT c.relname,has_table_privilege($1,c.oid,'SELECT') AS read,has_table_privilege($1,c.oid,'INSERT') AS append,has_table_privilege($1,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS excess FROM pg_class c WHERE c.relnamespace='nukhbapay_sessions'::regnamespace AND c.relkind='r'",[role])).rows;
        assert.equal(grants.length,2);for(const g of grants){assert.equal(g.read,false);assert.equal(g.append,false);assert.equal(g.excess,false);}
        const columns=(await admin.query(`SELECT sum(has_column_privilege($1,c.oid,a.attnum,'SELECT')::int)::int AS reads,
          sum(has_column_privilege($1,c.oid,a.attnum,'INSERT')::int)::int AS appends,
          sum(has_column_privilege($1,c.oid,a.attnum,'UPDATE,REFERENCES')::int)::int AS excess
          FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid WHERE c.relnamespace='nukhbapay_sessions'::regnamespace AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped`,[role])).rows[0];
        assert.deepEqual(columns,{reads:27,appends:23,excess:0});
        for(const old of ['nukhabapay_runtime','nukhabapay_importer','nukhabapay_identity_reader','nukhabapay_identity_writer']) {
          assert.equal((await admin.query("SELECT has_schema_privilege($1,'nukhbapay_sessions','USAGE') AS ok",[old])).rows[0].ok,false);
          for(const table of ['sessions','events'])assert.equal((await admin.query("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') AS ok",[old,'nukhbapay_sessions.'+table])).rows[0].ok,false);
        }
        assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace='nukhbapay_sessions'::regnamespace AND (prosecdef OR has_function_privilege($1,oid,'EXECUTE'))",[role])).rows[0].n,0);
        const c=new Client({connectionString:url.href});await c.connect();try{
          assert.equal((await c.query('SELECT count(*)::int AS n FROM nukhbapay_sessions.sessions')).rows[0].n,0);
          for(const sql of ['SELECT * FROM nukhabapay.staff_identities','SELECT * FROM nukhabapay.catalog_snapshots','UPDATE nukhbapay_sessions.sessions SET expires_ms=expires_ms+1','DELETE FROM nukhbapay_sessions.events','TRUNCATE nukhbapay_sessions.sessions'])await assert.rejects(()=>c.query(sql),{code:'42501'});
        }finally{await c.end();}
      });
      await t.test('creation accepts only opaque verified actors and stores hashes with exact immutable bindings',async()=>{
        const before=await count('sessions');for(const a of [{},{staffId:staff,tenantId:tenant},JSON.parse('{}')])assert.equal((await service.create(a as TrustedStaffActor)).ok,false);
        assert.equal((await service.create(await actor('session-staff',tenant,boundary()))).ok,false);
        assert.equal(await count('sessions'),before);
        const raw=await create(),row=(await admin.query('SELECT * FROM nukhbapay_sessions.sessions WHERE token_hash=$1',[hash(raw)])).rows[0];
        assert.equal(JSON.stringify(row).includes(raw),false);assert.equal(row.actor_staff_id,staff);assert.equal(row.tenant_id,tenant);
        assert.equal(row.issuer,ISSUER);assert.equal(row.subject,'session-staff');assert.equal(row.execution,'NOT_AUTHORIZED');assert.equal(row.assurance,'not-established');
        assert.equal((await service.validate(raw)).ok,true);assert.equal((await make().validate(raw)).ok,false);
        await assert.rejects(()=>admin.query('UPDATE nukhbapay_sessions.sessions SET expires_ms=expires_ms+1 WHERE id=$1',[row.id]),{code:'42501'});
        assert.equal((await count('events',"WHERE session_id=$1 AND event_name='SESSION_CREATED'",[row.id])),1);
      });
      await t.test('staff, membership, identity and authorization-version changes deny and permanently revoke observed old sessions',async()=>{
        for(const kind of ['staff','membership','identity','version','membership-version']){
          const raw=await create();
          const change=kind==='staff'?"UPDATE nukhabapay.staff_users SET status='SUSPENDED' WHERE id=$1":kind==='membership'?"UPDATE nukhabapay.staff_memberships SET status='REVOKED' WHERE staff_id=$1":kind==='identity'?"UPDATE nukhabapay.staff_identities SET status='DISABLED' WHERE staff_id=$1":kind==='membership-version'?"UPDATE nukhabapay.staff_memberships SET version=version+1 WHERE staff_id=$1":"UPDATE nukhabapay.staff_users SET authz_version=authz_version+1 WHERE id=$1";
          await admin.query(change,[staff]);assert.equal((await service.validate(raw)).ok,false);assert.equal((await service.verifyRevocation(raw)).ok,true);
          assert.equal((await admin.query("SELECT e.reason FROM nukhbapay_sessions.events e JOIN nukhbapay_sessions.sessions s ON s.id=e.session_id WHERE s.token_hash=$1 AND e.event_name='SESSION_REVOKED'",[hash(raw)])).rows[0].reason,'AUTHORITY_CHANGED');
          await admin.query("UPDATE nukhabapay.staff_users SET status='ACTIVE' WHERE id=$1",[staff]);await admin.query("UPDATE nukhabapay.staff_memberships SET status='ACTIVE' WHERE staff_id=$1",[staff]);await admin.query("UPDATE nukhabapay.staff_identities SET status='ACTIVE' WHERE staff_id=$1",[staff]);
          assert.equal((await service.validate(raw)).ok,false);
        }
      });
      await t.test('authentication and changed-context rotations are atomic and old credential replay never succeeds',async()=>{
        const raw=await create();await admin.query('UPDATE nukhabapay.staff_users SET authz_version=authz_version+1 WHERE id=$1',[staff]);
        const result=await service.rotate(await actor('session-staff',tenant),raw);assert.equal(result.ok,true);if(!result.ok)throw new Error('Rotation denied');
        assert.equal(result.credential.cookieValue()!==raw,true);assert.equal((await service.validate(raw)).ok,false);assert.equal((await service.verifyRevocation(raw)).ok,true);
        assert.equal((await service.validate(result.credential.cookieValue())).ok,true);
        assert.equal((await service.rotate(await actor('session-staff',tenant),raw)).ok,false);
        assert.equal((await service.rotate(await actor('session-other',otherTenant),result.credential.cookieValue())).ok,false);
      });
      await t.test('exclusive idle and absolute expiry cannot be extended by bearer replay',async()=>{
        const raw=await create();now+=1000;assert.equal((await service.validate(raw)).ok,false);
        const raw2=await create();for(let n=0;n<11;n++){now+=900;assert.equal((await service.validate(raw2)).ok,true);}now+=100;assert.equal((await service.validate(raw2)).ok,false);
      });
      await t.test('future and expired grants invalidate the bound authority digest without enabling reserved permissions',async()=>{
        const id=randomUUID();
        await admin.query("INSERT INTO nukhabapay.tenant_role_grants(id,membership_id,tenant_id,role_code,granted_at,expires_at,grant_source,evidence_reference) VALUES($1,$2,$3,'CATALOG_OPERATOR',$4,$5,'TEST','session.synthetic')",
          [id,member,tenant,new Date(now+500).toISOString(),new Date(now+1500).toISOString()]);
        const raw=await create();now+=500;assert.equal((await service.validate(raw)).ok,false);assert.equal((await service.verifyRevocation(raw)).ok,true);
        const raw2=await create();now+=1000;assert.equal((await service.validate(raw2)).ok,false);assert.equal((await service.verifyRevocation(raw2)).ok,true);
      });
      await t.test('concurrent retries across independent restricted PostgreSQL pools revoke exactly once',async()=>{
        const raw=await create();const outcomes=await Promise.all(Array.from({length:8},()=>service.revoke(raw)));
        assert.equal(outcomes.every(o=>o.ok),true);assert.equal((await service.verifyRevocation(raw)).ok,true);assert.equal((await service.validate(raw)).ok,false);
        const id=(await admin.query('SELECT id FROM nukhbapay_sessions.sessions WHERE token_hash=$1',[hash(raw)])).rows[0].id;
        assert.equal(await count('events',"WHERE session_id=$1 AND event_name='SESSION_REVOKED'",[id]),1);
        assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND application_name='nukhbapay-staff-session-store'",[db])).rows[0].n,2);
      });
      await t.test('audit failure rolls back creation, rotation and revocation without a partial success',async()=>{
        const raw=await create(),before=await count('sessions');
        const id=(await admin.query('SELECT id FROM nukhbapay_sessions.sessions WHERE token_hash=$1',[hash(raw)])).rows[0].id;
        await migration.query(`REVOKE INSERT(id,operation_id,session_id,actor_staff_id,scope_key,event_name,occurred_ms,reason) ON nukhbapay_sessions.events FROM "${role}"`);
        try{
          assert.equal((await service.create(await actor('session-staff',tenant))).ok,false);
          assert.equal((await service.rotate(await actor('session-staff',tenant),raw)).ok,false);
          assert.equal((await service.revoke(raw)).ok,false);assert.equal(await count('sessions'),before);
        }finally{await migration.query(`GRANT INSERT(id,operation_id,session_id,actor_staff_id,scope_key,event_name,occurred_ms,reason) ON nukhbapay_sessions.events TO "${role}"`);}
        assert.equal(await count('events',"WHERE session_id=$1 AND event_name='SESSION_REVOKED'",[id]),0);
        assert.equal((await service.validate(raw)).ok,false);
        assert.equal((await service.verifyRevocation(raw)).ok,false);
        assert.equal((await service.revoke(raw)).ok,true);
        assert.equal(await count('events',"WHERE session_id=$1 AND event_name='SESSION_REVOKED'",[id]),1);
      });
      await t.test('concurrent rolling validation cannot resurrect a committed revocation',async()=>{
        const raw=await create(),results=await Promise.all([service.revoke(raw),...Array.from({length:6},()=>service.validate(raw))]);
        assert.equal(results[0]!.ok,true);assert.equal((await service.verifyRevocation(raw)).ok,true);
        const used=await count('events',"WHERE event_name='SESSION_USED'");
        for(let n=0;n<3;n++)assert.equal((await service.validate(raw)).ok,false);
        assert.equal(await count('events',"WHERE event_name='SESSION_USED'"),used);
      });
      await t.test('unacknowledged committed revocation reconciles against the authoritative database event',async()=>{
        const uncertain=make({execute:async ticket=>{const result=await store.execute(ticket);return ticket.operation==='REVOKE'&&result==='REVOKED'?'UNRESOLVED':result;}});
        const raw=await create(uncertain);assert.equal((await uncertain.revoke(raw)).ok,false);assert.equal((await uncertain.verifyRevocation(raw)).ok,true);
        assert.equal((await uncertain.validate(raw)).ok,false);
        const orphan=make({execute:async ticket=>{const result=await store.execute(ticket);return ticket.operation==='CREATE'&&result==='COMMITTED'?'UNRESOLVED':result;}});
        const result=await orphan.create(await actor('session-staff',tenant));assert.equal(result.ok,false);assert.equal('credential' in result,false);
      });
      await t.test('connection termination rolls back pending work, releases locks and later operations recover',async()=>{
        const raw=await create(),lock=BigInt.asIntN(64,BigInt('0x'+hash(raw).slice(0,16))).toString();
        const id=(await admin.query('SELECT id FROM nukhbapay_sessions.sessions WHERE token_hash=$1',[hash(raw)])).rows[0].id;
        await admin.query('BEGIN');await admin.query('SELECT pg_advisory_xact_lock($1::bigint)',[lock]);
        let pending:Promise<Awaited<ReturnType<typeof service.revoke>>>|undefined;
        try{
          pending=service.revoke(raw);let pid:number|undefined;
          for(let attempt=0;attempt<200;attempt++){
            await admin.query('SELECT pg_stat_clear_snapshot()');
            const found=(await admin.query("SELECT pid FROM pg_stat_activity WHERE datname=$1 AND application_name='nukhbapay-staff-session-store' AND wait_event='advisory'",[db])).rows[0];
            if(found){pid=Number(found.pid);break;}await new Promise(resolve=>setTimeout(resolve,10));
          }
          assert.equal(typeof pid,'number');assert.equal((await admin.query('SELECT pg_terminate_backend($1) AS terminated',[pid])).rows[0].terminated,true);
        }finally{await admin.query('ROLLBACK');}
        assert.equal((await pending!).ok,false);
        assert.equal(await count('events',"WHERE session_id=$1 AND event_name='SESSION_REVOKED'",[id]),0);
        assert.equal((await service.validate(raw)).ok,false);
        assert.equal((await service.verifyRevocation(raw)).ok,false);
        assert.equal((await service.revoke(raw)).ok,true);assert.equal((await service.verifyRevocation(raw)).ok,true);
        assert.equal(await count('events',"WHERE session_id=$1 AND event_name='SESSION_REVOKED'",[id]),1);
        assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND state='idle in transaction'",[db])).rows[0].n,0);
      });
      await t.test('FORCE RLS prevents other-actor and other-tenant record disclosure or enumeration without exact context',async()=>{
        const raw=await create(),c=new Client({connectionString:url.href});await c.connect();
        try{await c.query('BEGIN');
          await c.query("SELECT set_config('nukhbapay_sessions.staff_id',$1,true),set_config('nukhbapay_sessions.scope',$2,true)",[other,tenant]);
          assert.equal((await c.query('SELECT count(*)::int AS n FROM nukhbapay_sessions.sessions WHERE token_hash=$1',[hash(raw)])).rows[0].n,0);
          await c.query("SELECT set_config('nukhbapay_sessions.staff_id',$1,true),set_config('nukhbapay_sessions.scope',$2,true)",[staff,otherTenant]);
          assert.equal((await c.query('SELECT count(*)::int AS n FROM nukhbapay_sessions.sessions WHERE token_hash=$1',[hash(raw)])).rows[0].n,0);
          await c.query('ROLLBACK');assert.equal((await c.query('SELECT count(*)::int AS n FROM nukhbapay_sessions.sessions')).rows[0].n,0);
        }finally{await c.end();}
      });
      await t.test('incomplete create and rotation audit tuples cannot commit; session audit cannot claim staff success',async()=>{
        const raw=await create(),row=(await admin.query('SELECT * FROM nukhbapay_sessions.sessions WHERE token_hash=$1',[hash(raw)])).rows[0];
        const c=new Client({connectionString:url.href});await c.connect();
        try{
          await c.query('BEGIN');await c.query("SELECT set_config('nukhbapay_sessions.staff_id',$1,true),set_config('nukhbapay_sessions.scope',$2,true)",[staff,tenant]);
          await c.query(`INSERT INTO nukhbapay_sessions.sessions(id,token_hash,actor_staff_id,issuer,subject,tenant_id,authz_version,membership_version,authority_digest,identity_expires_ms,created_ms,expires_ms,idle_ms,creation_operation_id)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[randomUUID(),hash(randomUUID()),staff,ISSUER,'session-staff',tenant,row.authz_version,row.membership_version,row.authority_digest,row.identity_expires_ms,now,now+1000,row.idle_ms,randomUUID()]);
          await assert.rejects(()=>c.query('COMMIT'),{code:'23514'});await c.query('ROLLBACK');
          await c.query('BEGIN');await c.query("SELECT set_config('nukhbapay_sessions.staff_id',$1,true),set_config('nukhbapay_sessions.scope',$2,true)",[staff,tenant]);
          await c.query("INSERT INTO nukhbapay_sessions.events(id,operation_id,session_id,actor_staff_id,scope_key,event_name,occurred_ms,reason) VALUES($1,$2,$3,$4,$5,'SESSION_REVOKED',$6,'CONTEXT_ROTATION')",[randomUUID(),randomUUID(),row.id,staff,tenant,now]);
          await assert.rejects(()=>c.query('COMMIT'),{code:'23514'});await c.query('ROLLBACK');
          await c.query('BEGIN');await c.query("SELECT set_config('nukhbapay_sessions.staff_id',$1,true),set_config('nukhbapay_sessions.scope',$2,true)",[staff,tenant]);
          await assert.rejects(()=>c.query("INSERT INTO nukhbapay_sessions.events(id,operation_id,session_id,actor_staff_id,scope_key,event_name,occurred_ms,reason) VALUES($1,$2,$3,$4,$5,'STAFF_ACTIVATED',$6,'LOGOUT')",[randomUUID(),randomUUID(),row.id,staff,tenant,now]),{code:'23514'});await c.query('ROLLBACK');
        }finally{await c.end();}
        assert.equal((await service.validate(raw)).ok,true);
      });
      await t.test('HTTPS uses real restricted session persistence; CSRF logout commits revocation before cookie clearing',async()=>{
        const pfxPath=process.env['NUKHBAPAY_STAFF_TEST_PFX_PATH'],publicPath=process.env['NUKHBAPAY_STAFF_TEST_CA_PATH'],passphrase=process.env['NUKHBAPAY_STAFF_TEST_PASSPHRASE'];
        if(!pfxPath||!publicPath||!passphrase)throw new Error('Explicit local HTTPS acceptance configuration required');
        const certificate=readFileSync(publicPath),ca=new X509Certificate(certificate).toString(),raw=await create();
        const portal=await createStaffPortal({pfx:readFileSync(pfxPath),certificate,passphrase,port:0,sessions:service});
        const call=(path:string,method='GET',headers:Record<string,string>={},body?:string)=>new Promise<{status:number;headers:import('node:http').IncomingHttpHeaders;body:string}>((resolve,reject)=>{
          const port=Number(new URL(portal.origin).port),req=request({hostname:'127.0.0.1',port,servername:'localhost',ca,agent:false,path,method,headers:{host:`localhost:${port}`,...headers}},res=>{
            let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,body:text}));
          });req.on('error',reject);if(body)req.write(body);req.end();
        });
        try{
          const cookie=staffCookie(raw).split(';')[0]!,status=await call('/auth/session','GET',{cookie});assert.equal(status.status,200);assert.equal(status.body.includes(raw),false);
          const csrf=JSON.parse(status.body).csrfToken;
          assert.equal((await call('/auth/logout','POST',{cookie,origin:'https://attacker.invalid','content-type':'application/json','x-csrf-token':csrf},'{}')).status,403);
          assert.equal((await service.validate(raw)).ok,true);
          const logout=await call('/auth/logout','POST',{cookie,origin:portal.origin,'content-type':'application/json','x-csrf-token':csrf},'{}');
          assert.equal(logout.status,204);assert.equal(String(logout.headers['set-cookie']).includes('Max-Age=0'),true);
          assert.equal((await service.verifyRevocation(raw)).ok,true);assert.equal((await call('/auth/session','GET',{cookie})).status,401);
          assert.equal((await call('/auth/callback?code=synthetic')).status,404);
        }finally{await portal.close();}
      });
      await t.test('database records and workload credentials cannot mint an opaque actor or authenticate a fabricated session',async()=>{
        const real=await create(),row=(await admin.query('SELECT * FROM nukhbapay_sessions.sessions WHERE token_hash=$1',[hash(real)])).rows[0];
        const fake='D'.repeat(43),id=randomUUID(),operation=randomUUID(),c=new Client({connectionString:url.href});await c.connect();
        const insert=`INSERT INTO nukhbapay_sessions.sessions(id,token_hash,actor_staff_id,issuer,subject,tenant_id,authz_version,membership_version,authority_digest,identity_expires_ms,created_ms,expires_ms,idle_ms,creation_operation_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`;
        try{
          await c.query('BEGIN');await c.query("SELECT set_config('nukhbapay_sessions.staff_id',$1,true),set_config('nukhbapay_sessions.scope',$2,true)",[staff,tenant]);
          await c.query(insert,[id,hash(fake),staff,ISSUER,'session-staff',tenant,row.authz_version,row.membership_version,row.authority_digest,row.identity_expires_ms,now,now+1000,1000,operation]);
          await c.query("INSERT INTO nukhbapay_sessions.events(id,operation_id,session_id,actor_staff_id,scope_key,event_name,occurred_ms,reason) VALUES($1,$2,$3,$4,$5,'SESSION_CREATED',$6,'AUTHENTICATION')",[randomUUID(),operation,id,staff,tenant,now]);
          await c.query('COMMIT');
          assert.equal((await service.validate(fake)).ok,false);assert.equal((await make().validate(fake)).ok,false);
          assert.equal((await service.verifyRevocation(fake)).ok,false);assert.equal((await service.validate(real)).ok,true);
          await c.query('BEGIN');await c.query("SELECT set_config('nukhbapay_sessions.staff_id',$1,true),set_config('nukhbapay_sessions.scope',$2,true)",[other,otherTenant]);
          await assert.rejects(()=>c.query(insert,[randomUUID(),hash(randomUUID()),other,ISSUER,'session-staff',otherTenant,0,1,row.authority_digest,row.identity_expires_ms,now,now+1000,1000,randomUUID()]),{code:'23503'});
          await c.query('ROLLBACK');
        }finally{await c.end();}
      });
      await t.test('configuration rejects wrong database roles, development targets and excessive new privileges',async()=>{
        await assert.rejects(()=>createStaffSessionStore({...config,expectedDatabase:'nukhabapay_dev'}),{message:'Restricted session persistence unavailable'});
        await assert.rejects(()=>createStaffSessionStore({...config,expectedRole:'nukhabapay_migrator'}),{message:'Restricted session persistence unavailable'});
        await migration.query(`GRANT UPDATE ON nukhbapay_sessions.sessions TO "${role}"`);
        try{await assert.rejects(()=>createStaffSessionStore(config),{message:'Restricted session persistence unavailable'});}
        finally{await migration.query(`REVOKE UPDATE ON nukhbapay_sessions.sessions FROM "${role}"`);}
        assert.deepEqual(await acl(),beforeAcl);
      });
    }finally{
      await Promise.all(stores.map(s=>s.close()));await runtime?.close();await migration.end();
      if(createdRole){
        await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA nukhbapay_sessions FROM "${role}"`);
        await admin.query(`REVOKE ALL(id,token_hash,actor_staff_id,issuer,subject,tenant_id,scope_key,authz_version,membership_version,authority_digest,identity_expires_ms,created_ms,expires_ms,idle_ms,parent_id,creation_operation_id,execution,assurance) ON nukhbapay_sessions.sessions FROM "${role}"`);
        await admin.query(`REVOKE ALL(id,operation_id,session_id,actor_staff_id,scope_key,event_name,occurred_ms,reason,execution) ON nukhbapay_sessions.events FROM "${role}"`);
        await admin.query(`REVOKE ALL ON SCHEMA nukhbapay_sessions FROM "${role}"`);
        await admin.query(`REVOKE ALL ON DATABASE "${db}" FROM "${role}"`);
        await admin.query(`DROP ROLE "${role}"`);
      }
    }
  },'b3b3',5);
});

test('proposed session migration rejects unknown default grantees atomically on a disposable database',async()=>{
  await withDisposableIamDatabase(async f=>{
    const c=new Client({connectionString:forDatabase(process.env['DB_MIGRATION_URL']!,f.databaseName)});await c.connect();
    const role='nukh_session_'+randomUUID().replaceAll('-','').slice(0,20);await f.fixtureClient.query(`CREATE ROLE "${role}" NOLOGIN`);
    try{
      await c.query(`ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO "${role}"`);
      await c.query('BEGIN');await assert.rejects(()=>c.query(readFileSync(new URL('../../../../packages/database/pending-migrations/006_staff_server_sessions.sql',import.meta.url),'utf8')),{code:'42501'});await c.query('ROLLBACK');
      assert.equal((await f.fixtureClient.query("SELECT to_regnamespace('nukhbapay_sessions') IS NULL AS absent")).rows[0].absent,true);
      assert.equal((await f.fixtureClient.query("SELECT to_regclass('nukhabapay.staff_identities_session_binding_uq') IS NULL AS absent")).rows[0].absent,true);
    }finally{
      await c.query(`ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM "${role}"`);await c.end();await f.fixtureClient.query(`DROP ROLE "${role}"`);
    }
  },'b3b3',5);
});
