import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { StaffSessionLifecycle, TrustedStaffActorBoundary } from '@nukhbapay/application';
import { createStaffSessionStore } from '@nukhbapay/database';
import { createIdentityRuntime } from '@nukhbapay/database/identity-runtime';
import { OidcAccessTokenVerifier } from '../src/modules/identity/oidc-access-token.verifier.js';
import { claims, environment, ISSUER, keySource, signingKey } from './fixtures/oidc-test-issuer.js';
import { forDatabase, withDisposableIamDatabase } from './fixtures/disposable-iam-database.js';

const root=fileURLToPath(new URL('../../../../',import.meta.url));
const database=path.join(root,'packages/database');
const {verifiedMigrationSources,rehearseReviewedMigrations}=await import(pathToFileURL(path.join(root,'scripts/rehearse-reviewed-migrations.mjs')).href);
const pending=(name:string)=>readFileSync(path.join(database,'pending-migrations',name),'utf8');
const expected=['001_catalog','002_import_role_privileges','003_import_role_read_access','004_staff_identity_foundation','005_staff_workflow_persistence','006_staff_server_sessions'];
const workloads=['nukhabapay_runtime','nukhabapay_importer','nukhabapay_identity_reader','nukhabapay_identity_writer'];
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
async function initialize(c:Client) {
  await c.query('CREATE SCHEMA nukhabapay AUTHORIZATION nukhabapay_migrator');
  await c.query('GRANT USAGE ON SCHEMA nukhabapay TO '+workloads.join(','));
}
function removeTemporary(directory:string) {
  assert.equal(path.dirname(path.resolve(directory)),path.resolve(tmpdir()));
  assert.match(path.basename(directory),/^nukh-migration-test-[a-zA-Z0-9]+$/);
  rmSync(path.resolve(directory),{recursive:true,force:true});
}
async function ownerFor(name:string) {
  const c=new Client({connectionString:forDatabase(process.env['DB_MIGRATION_URL']!,name)});await c.connect();return c;
}

test('reviewed immutable manifest pins frozen migrations and rejects modified or missing source before connecting',async()=>{
  const {manifest,snapshot}=verifiedMigrationSources();
  assert.equal(snapshot.size,10);
  assert.equal(manifest.profile,'REGISTERED_MIGRATIONS_V1');
  assert.equal(manifest.status,'006_REGISTERED_LOCAL_SOURCE_HISTORY');
  assert.equal(manifest.files['packages/database/migrations/004_staff_identity_foundation.ts'],'ebb5b282d9afad7dc5ef7b8221bd7b34942c1cbb53757e73832987b36975b312');
  assert.equal(manifest.files['packages/database/migrations/005_staff_workflow_persistence.ts'],'41910d1aa060a1971c8e33e123b0e350d884ffede490cb71b52dc00838779390');
  assert.equal(manifest.files['packages/database/migrations/006_staff_server_sessions.ts'],'035fa9bb914de3cb4094f8e98ce2fa9164dc4e6b5e11b40ddfdd55707bc98eed');
  assert.equal(manifest.files['packages/database/pending-migrations/006_staff_server_sessions.ts'],undefined);
  const directory=mkdtempSync(path.join(tmpdir(),'nukh-migration-test-'));
  try {
    for(const [name,bytes] of snapshot as Map<string,Buffer>) {mkdirSync(path.dirname(path.join(directory,name)),{recursive:true});writeFileSync(path.join(directory,name),bytes);}
    writeFileSync(path.join(directory,'packages/database/migration-manifest.json'),JSON.stringify(manifest));
    verifiedMigrationSources(directory);
    const registered006=path.join(directory,'packages/database/migrations/006_staff_server_sessions.ts');
    writeFileSync(registered006,'unreviewed');
    assert.throws(()=>verifiedMigrationSources(directory),/integrity rejected/);
    manifest.files['packages/database/migrations/006_staff_server_sessions.ts']=hash('unreviewed');
    writeFileSync(path.join(directory,'packages/database/migration-manifest.json'),JSON.stringify(manifest));
    assert.throws(()=>verifiedMigrationSources(directory),/Registered migration/);
    manifest.files['packages/database/migrations/006_staff_server_sessions.ts']='035fa9bb914de3cb4094f8e98ce2fa9164dc4e6b5e11b40ddfdd55707bc98eed';
    writeFileSync(path.join(directory,'packages/database/migration-manifest.json'),JSON.stringify(manifest));
    writeFileSync(registered006,(snapshot as Map<string,Buffer>).get('packages/database/migrations/006_staff_server_sessions.ts')!);
    verifiedMigrationSources(directory);
    writeFileSync(path.join(directory,'packages/database/migrations/004_staff_identity_foundation.ts'),'unreviewed');
    assert.throws(()=>verifiedMigrationSources(directory),/integrity rejected/);
    rmSync(path.join(directory,'packages/database/migrations/004_staff_identity_foundation.ts'));
    assert.throws(()=>verifiedMigrationSources(directory));
    manifest.files['packages/database/migrations/004_staff_identity_foundation.ts']=hash('unreviewed');
    writeFileSync(path.join(directory,'packages/database/migration-manifest.json'),JSON.stringify(manifest));
    assert.throws(()=>verifiedMigrationSources(directory),/Frozen migration/);
  }finally{removeTemporary(directory);}
  const previous=process.env['DB_IDENTITY_READER_ROLE'];process.env['DB_IDENTITY_READER_ROLE']='unreviewed_reader';
  try {await assert.rejects(()=>rehearseReviewedMigrations(process.env['DB_MIGRATION_URL']!),/workload configuration/);}
  finally {if(previous===undefined)delete process.env['DB_IDENTITY_READER_ROLE'];else process.env['DB_IDENTITY_READER_ROLE']=previous;}
  await assert.rejects(()=>rehearseReviewedMigrations(process.env['DB_MIGRATION_URL']!),/target/);
});

test('004 preflight denies unreviewed defaults and schema ACLs without changing frozen history',async t=>{
  await withDisposableIamDatabase(async f=>{
    await initialize(f.fixtureClient);const c=await ownerFor(f.databaseName),role='nukh_workflow_'+randomUUID().replaceAll('-','').slice(0,20);
    await f.fixtureClient.query(`CREATE ROLE "${role}" NOLOGIN`);
    try {
      await c.query(pending('004_identity_default_acl_preflight.sql'));
      for(const spec of [
        ['', 'SELECT ON TABLES',role],[' IN SCHEMA nukhabapay','SELECT ON TABLES',role],
        ['', 'EXECUTE ON FUNCTIONS',role],['','USAGE,CREATE ON SCHEMAS',role],['','USAGE ON SEQUENCES',role],
        ['', 'SELECT ON TABLES','nukhabapay_runtime'],
      ])await t.test('rejects default '+spec.join(' '),async()=>{
        await c.query(`ALTER DEFAULT PRIVILEGES${spec[0]} GRANT ${spec[1]} TO "${spec[2]}"`);
        try {await assert.rejects(()=>c.query(pending('004_identity_default_acl_preflight.sql')),{code:'42501'});}
        finally {await c.query(`ALTER DEFAULT PRIVILEGES${spec[0]} REVOKE ALL ON ${spec[1]!.split(' ON ')[1]} FROM "${spec[2]}"`);}
      });
      await t.test('rejects hostile existing schema rights',async()=>{
        await c.query(`GRANT USAGE,CREATE ON SCHEMA nukhabapay TO "${role}"`);
        try {await assert.rejects(()=>c.query(pending('004_identity_default_acl_preflight.sql')),{code:'42501'});}
        finally {await c.query(`REVOKE ALL ON SCHEMA nukhabapay FROM "${role}"`);}
      });
      assert.equal((await c.query("SELECT to_regclass('nukhabapay.staff_users') IS NULL AS absent")).rows[0].absent,true);
      await c.query(pending('004_identity_default_acl_preflight.sql'));
    }finally {await c.end();await f.fixtureClient.query(`DROP ROLE "${role}"`);}
  },'b3b3',0);
});

test('006 denies NULL socket metadata, wrong network targets, missing dependencies and hostile schema defaults',async t=>{
  await withDisposableIamDatabase(async f=>{
    const c=await ownerFor(f.databaseName),sql=pending('006_staff_server_sessions.sql');
    const gate=sql.slice(sql.indexOf('DO $gate$'),sql.indexOf('END $gate$;')+'END $gate$;'.length);
    const role='nukh_workflow_'+randomUUID().replaceAll('-','').slice(0,20);await f.fixtureClient.query(`CREATE ROLE "${role}" NOLOGIN`);
    try {
      await c.query(gate);
      // Windows has no Unix-socket listener. Substitute only connection metadata
      // inputs in the actual SQL guard and execute its unchanged predicate in PG.
      for(const [name,probe] of [
        ['Unix socket NULL address and port',gate.replaceAll('inet_server_addr()','NULL::inet').replaceAll('inet_server_port()','NULL::integer')],
        ['NULL address',gate.replaceAll('inet_server_addr()','NULL::inet')],
        ['NULL port',gate.replaceAll('inet_server_port()','NULL::integer')],
        ['remote address',gate.replaceAll('inet_server_addr()',"'192.0.2.1'::inet")],
        ['wrong port',gate.replaceAll('inet_server_port()','5433')],
      ])await t.test(name!,async()=>{await assert.rejects(()=>c.query(probe!),{code:'42501'});});
      await t.test('requires 005 history',async()=>{
        await c.query('BEGIN');try {await c.query("DELETE FROM nukhabapay.schema_migrations WHERE name='005_staff_workflow_persistence'");await assert.rejects(()=>c.query(gate),{code:'42501'});}finally{await c.query('ROLLBACK');}
      });
      for(const grantee of [...workloads,'PUBLIC',role])await t.test('rejects schema default for '+grantee,async()=>{
        const principal=grantee==='PUBLIC'?'PUBLIC':`"${grantee}"`;
        await c.query(`ALTER DEFAULT PRIVILEGES GRANT USAGE,CREATE ON SCHEMAS TO ${principal}`);
        try {await c.query('BEGIN');await assert.rejects(()=>c.query(sql),{code:'42501'});await c.query('ROLLBACK');}
        finally {await c.query('ROLLBACK');await c.query(`ALTER DEFAULT PRIVILEGES REVOKE ALL ON SCHEMAS FROM ${principal}`);}
        assert.equal((await c.query("SELECT to_regnamespace('nukhbapay_sessions') IS NULL AS absent")).rows[0].absent,true);
      });
      await t.test('final ACL check rejects an unexpected schema grant and rolls everything back',async()=>{
        const hostile=sql.replace('DO $acl$',`GRANT USAGE,CREATE ON SCHEMA nukhbapay_sessions TO "${role}";\nDO $acl$`);
        await c.query('BEGIN');try {await assert.rejects(()=>c.query(hostile),{code:'42501'});}finally{await c.query('ROLLBACK');}
        assert.equal((await c.query("SELECT to_regnamespace('nukhbapay_sessions') IS NULL AS absent,to_regclass('nukhabapay.staff_identities_session_binding_uq') IS NULL AS index_absent")).rows[0].absent,true);
        assert.equal((await c.query("SELECT to_regclass('nukhabapay.staff_identities_session_binding_uq') IS NULL AS absent")).rows[0].absent,true);
      });
    }finally{await c.end();await f.fixtureClient.query(`DROP ROLE "${role}"`);}
  },'b3b3',5);
});

test('failed combined migration rolls back IAM, grants and history; a clean retry needs no down migration',async()=>{
  await withDisposableIamDatabase(async f=>{
    await initialize(f.fixtureClient);
    await f.fixtureClient.query('CREATE SCHEMA nukhbapay_sessions AUTHORIZATION nukhabapay_migrator');
    await assert.rejects(()=>rehearseReviewedMigrations(forDatabase(process.env['DB_MIGRATION_URL']!,f.databaseName)));
    assert.equal((await f.fixtureClient.query("SELECT to_regclass('nukhabapay.staff_users') IS NULL AS absent")).rows[0].absent,true);
    assert.equal((await f.fixtureClient.query('SELECT count(*)::int AS n FROM nukhabapay.schema_migrations')).rows[0].n,0);
    // Remove only the deliberately conflicting empty fixture schema, not history.
    await f.fixtureClient.query('DROP SCHEMA nukhbapay_sessions');
    assert.deepEqual(await rehearseReviewedMigrations(forDatabase(process.env['DB_MIGRATION_URL']!,f.databaseName)),expected);
    assert.deepEqual(await rehearseReviewedMigrations(forDatabase(process.env['DB_MIGRATION_URL']!,f.databaseName)),expected);
    await f.fixtureClient.query("UPDATE nukhabapay.schema_migrations SET name='unreviewed_history' WHERE name='002_import_role_privileges'");
    try {await assert.rejects(()=>rehearseReviewedMigrations(forDatabase(process.env['DB_MIGRATION_URL']!,f.databaseName)));}
    finally {await f.fixtureClient.query("UPDATE nukhabapay.schema_migrations SET name='002_import_role_privileges' WHERE name='unreviewed_history'");}
  },'b3b3',0);
});

test('combined 001-006 enforces authority invalidation, restricted sessions and clean database restoration',async t=>{
  await withDisposableIamDatabase(async f=>{
    const admin=f.fixtureClient;await initialize(admin);
    assert.deepEqual(await rehearseReviewedMigrations(forDatabase(process.env['DB_MIGRATION_URL']!,f.databaseName)),expected);
    const owner=await ownerFor(f.databaseName),role='nukh_session_'+randomUUID().replaceAll('-','').slice(0,20);
    const stores:Awaited<ReturnType<typeof createStaffSessionStore>>[]=[];
    let runtime:Awaited<ReturnType<typeof createIdentityRuntime>>|undefined,createdRole=false;
    try {
      await t.test('FORCE RLS and exact grants preserve all existing IAM/catalogue boundaries',async()=>{
        const scoped=(await admin.query("SELECT count(*)::int AS n,bool_and(relrowsecurity AND relforcerowsecurity) AS forced FROM pg_class WHERE relnamespace IN ('nukhabapay'::regnamespace,'nukhbapay_sessions'::regnamespace) AND (relname IN ('staff_memberships','tenant_role_grants','security_audit_events','sessions','events') OR relname LIKE 'staff_request_%' OR relname IN ('staff_access_requests','staff_review_observations','staff_synthetic_provenance') OR relname LIKE 'iam_workflow_%') AND relkind='r'")).rows[0];
        assert.deepEqual(scoped,{n:16,forced:true});
        for(const workload of workloads) {
          assert.equal((await admin.query("SELECT has_schema_privilege($1,'nukhbapay_sessions','USAGE,CREATE') AS yes",[workload])).rows[0].yes,false);
          for(const table of ['staff_users','staff_identities','staff_access_requests','staff_request_receipts'])
            if(workload.includes('runtime')||workload.includes('importer'))assert.equal((await admin.query('SELECT has_any_column_privilege($1,$2,\'SELECT,INSERT,UPDATE\') AS yes',[workload,'nukhabapay.'+table])).rows[0].yes,false);
          assert.equal((await admin.query("SELECT has_any_column_privilege($1,'nukhabapay.staff_users','INSERT,UPDATE') AS yes",[workload])).rows[0].yes,false);
          assert.equal((await admin.query("SELECT bool_or(has_function_privilege($1,oid,'EXECUTE')) AS yes FROM pg_proc WHERE pronamespace='nukhabapay'::regnamespace AND proname IN ('advance_staff_authority','advance_membership_authority','propagate_staff_authority')",[workload])).rows[0].yes,false);
        }
        assert.equal((await admin.query("SELECT has_column_privilege('nukhabapay_identity_reader','nukhabapay.staff_users','tokens_valid_after','SELECT') AS yes")).rows[0].yes,true);
        assert.equal((await admin.query("SELECT has_column_privilege('nukhabapay_identity_reader','nukhabapay.staff_users','contact_email','SELECT') AS yes")).rows[0].yes,false);
        assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace IN ('nukhabapay'::regnamespace,'nukhbapay_sessions'::regnamespace) AND prosecdef")).rows[0].n,0);
        await assert.rejects(()=>admin.query("SELECT nukhabapay.execute_staff_command('{}')"),{code:'42501'});
      });
      await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);createdRole=true;
      await owner.query('BEGIN');try {await owner.query("SELECT set_config('nukhbapay_sessions.backend_role',$1,true)",[role]);await owner.query(readFileSync(path.join(database,'roles/grant_staff_session_backend.sql'),'utf8'));await owner.query('COMMIT');}catch(e){await owner.query('ROLLBACK');throw e;}
      const url=new URL(forDatabase(process.env['DB_TEST_ADMIN_URL']!,f.databaseName));url.username=role;url.password=randomUUID();
      const config={connectionString:url.href,expectedRole:role,expectedDatabase:f.databaseName,poolMax:1};
      const first=await createStaffSessionStore(config),second=await createStaffSessionStore(config);stores.push(first,second);let active=first;
      const staff=randomUUID(),tenant=randomUUID(),member=randomUUID(),bindingId=randomUUID();
      await admin.query("INSERT INTO nukhabapay.tenants(id,tenant_key) VALUES($1,'combined-synthetic')",[tenant]);
      await admin.query("INSERT INTO nukhabapay.staff_users(id,display_name,contact_email,status) VALUES($1,'Synthetic Combined','combined@example.invalid','ACTIVE')",[staff]);
      await admin.query("INSERT INTO nukhabapay.staff_identities(id,staff_id,issuer,subject,status) VALUES($1,$2,$3,'combined-staff','ACTIVE')",[bindingId,staff,ISSUER]);
      await admin.query("INSERT INTO nukhabapay.staff_memberships(id,staff_id,tenant_id,status) VALUES($1,$2,$3,'ACTIVE')",[member,staff,tenant]);
      runtime=await createIdentityRuntime(f.runtimeEnv);
      let now=Date.now();const clock=()=>new Date(now),key=await signingKey('combined-synthetic-key'),source=keySource([key.publicJwk]);
      const verifier=new OidcAccessTokenVerifier(environment(),{fetchKeys:source.fetchKeys,now:clock});
      const actors=new TrustedStaffActorBoundary({...runtime,now:clock});
      const service=new StaffSessionLifecycle({actors,store:{execute:ticket=>active.execute(ticket)},now:clock,enabled:true,idleMs:1000,absoluteMs:5000});
      async function fresh() {
        const cutoff=(await admin.query('SELECT tokens_valid_after FROM nukhabapay.staff_users WHERE id=$1',[staff])).rows[0].tokens_valid_after as Date|null;
        const wait=cutoff===null?0:Math.floor(cutoff.getTime()/1000)*1000+1000-Date.now();
        if(wait>0)await new Promise(resolve=>setTimeout(resolve,wait+5));now=Date.now();
        const identity=await verifier.verify(await key.sign(claims({sub:'combined-staff',iat:Math.floor(now/1000),exp:Math.floor(now/1000)+300})));
        const established=await actors.establish(identity,tenant);assert.equal(established.allowed,true);
        if(!established.allowed)throw new Error('Synthetic combined actor denied');
        const session=await service.create(established.actor);assert.equal(session.ok,true);if(!session.ok)throw new Error('Synthetic combined session denied');
        return {raw:session.credential.cookieValue(),actor:established.actor,identity};
      }
      const version=async()=>(await admin.query('SELECT authz_version::text AS v,tokens_valid_after,status FROM nukhabapay.staff_users WHERE id=$1',[staff])).rows[0];
      await t.test('suspension then reinstatement between reads cannot preserve an old token or session',async()=>{
        const s=await fresh(),before=await version();
        await admin.query("UPDATE nukhabapay.staff_users SET status='SUSPENDED' WHERE id=$1",[staff]);
        await admin.query("UPDATE nukhabapay.staff_users SET status='ACTIVE' WHERE id=$1",[staff]);
        assert.equal(BigInt((await version()).v),BigInt(before.v)+2n);
        assert.equal((await actors.establish(s.identity,tenant)).allowed,false);
        assert.equal((await service.validate(s.raw)).ok,false);assert.equal((await service.verifyRevocation(s.raw)).ok,true);
        const event=(await admin.query("SELECT reason FROM nukhbapay_sessions.events e JOIN nukhbapay_sessions.sessions s ON s.id=e.session_id WHERE s.token_hash=$1 AND e.event_name='SESSION_REVOKED'",[hash(s.raw)])).rows[0];assert.equal(event.reason,'AUTHORITY_CHANGED');
      });
      await t.test('identity and membership changes advance authority even if restored before validation',async()=>{
        for(const table of ['staff_identities','staff_memberships']) {
          const s=await fresh(),before=await version();const inactive=table==='staff_identities'?'DISABLED':'SUSPENDED';
          await admin.query(`UPDATE nukhabapay.${table} SET status=$2 WHERE staff_id=$1`,[staff,inactive]);
          await admin.query(`UPDATE nukhabapay.${table} SET status='ACTIVE' WHERE staff_id=$1`,[staff]);
          assert.equal(BigInt((await version()).v),BigInt(before.v)+2n);assert.equal((await service.validate(s.raw)).ok,false);
        }
      });
      await t.test('emergency cutoff is strict, monotonic and invalidates old signed issuance',async()=>{
        const s=await fresh(),before=await version();await admin.query('UPDATE nukhabapay.staff_users SET tokens_valid_after=clock_timestamp() WHERE id=$1',[staff]);
        assert.equal(BigInt((await version()).v),BigInt(before.v)+1n);assert.equal((await actors.establish(s.identity,tenant)).allowed,false);assert.equal((await service.validate(s.raw)).ok,false);
        for(const query of ['UPDATE nukhabapay.staff_users SET tokens_valid_after=NULL WHERE id=$1','UPDATE nukhabapay.staff_users SET tokens_valid_after=tokens_valid_after-interval \'1 second\' WHERE id=$1','UPDATE nukhabapay.staff_users SET authz_version=authz_version-1 WHERE id=$1'])await assert.rejects(()=>admin.query(query,[staff]),{code:'23514'});
        assert.equal((await service.validate((await fresh()).raw)).ok,true);
      });
      await t.test('grant changes advance staff and membership versions and cannot undo revocation',async()=>{
        const id=randomUUID(),s=await fresh(),before=await version(),mv=(await admin.query('SELECT version FROM nukhabapay.staff_memberships WHERE id=$1',[member])).rows[0].version;
        await admin.query("INSERT INTO nukhabapay.tenant_role_grants(id,membership_id,tenant_id,role_code,granted_at,grant_source,evidence_reference) VALUES($1,$2,$3,'CATALOG_OPERATOR',clock_timestamp(),'TEST','combined.synthetic')",[id,member,tenant]);
        assert.equal(BigInt((await version()).v),BigInt(before.v)+1n);assert.equal(BigInt((await admin.query('SELECT version FROM nukhabapay.staff_memberships WHERE id=$1',[member])).rows[0].version),BigInt(mv)+1n);assert.equal((await service.validate(s.raw)).ok,false);
        await admin.query('UPDATE nukhabapay.tenant_role_grants SET revoked_at=clock_timestamp() WHERE id=$1',[id]);
        await assert.rejects(()=>admin.query('UPDATE nukhabapay.tenant_role_grants SET revoked_at=NULL WHERE id=$1',[id]),{code:'23514'});
        await assert.rejects(()=>admin.query('UPDATE nukhabapay.staff_memberships SET version=version-1 WHERE id=$1',[member]),{code:'23514'});
        await assert.rejects(()=>admin.query("UPDATE nukhabapay.iam_permissions SET activation_phase='3A' WHERE code='platform.access.approve'"),{code:'23000'});
      });
      await t.test('platform grants and immutable bindings obey the same version and cutoff contract',async()=>{
        const id=randomUUID(),s=await fresh(),before=await version();
        await admin.query("INSERT INTO nukhabapay.platform_role_grants(id,staff_id,role_code,granted_at,grant_source,evidence_reference) VALUES($1,$2,'PLATFORM_AUDITOR',clock_timestamp(),'TEST','combined.synthetic')",[id,staff]);
        assert.equal(BigInt((await version()).v),BigInt(before.v)+1n);assert.equal((await service.validate(s.raw)).ok,false);
        await admin.query('UPDATE nukhabapay.platform_role_grants SET revoked_at=clock_timestamp() WHERE id=$1',[id]);
        await assert.rejects(()=>admin.query('UPDATE nukhabapay.platform_role_grants SET revoked_at=NULL WHERE id=$1',[id]),{code:'23514'});
        await assert.rejects(()=>admin.query("UPDATE nukhabapay.staff_identities SET subject='substituted' WHERE id=$1",[bindingId]),{code:'23514'});
        await assert.rejects(()=>admin.query('UPDATE nukhabapay.staff_memberships SET tenant_id=$2 WHERE id=$1',[member,randomUUID()]),{code:'23514'});
        await assert.rejects(()=>admin.query('DELETE FROM nukhabapay.staff_identities WHERE id=$1',[bindingId]),{code:'42501'});
        const unchanged=await version();await admin.query("UPDATE nukhabapay.staff_users SET display_name='Synthetic Cosmetic' WHERE id=$1",[staff]);assert.deepEqual(await version(),unchanged);
      });
      await t.test('failed audit rolls back authority advancement; concurrent maintenance updates do not lose versions',async()=>{
        const before=await version();await admin.query('BEGIN');try {
          await admin.query("UPDATE nukhabapay.staff_users SET status='SUSPENDED' WHERE id=$1",[staff]);
          await assert.rejects(()=>admin.query("INSERT INTO nukhabapay.security_audit_events(occurred_at,action,outcome,target_type,reason_code) VALUES(clock_timestamp(),'STAFF_ACTIVATED','SUCCESS','STAFF_USER','NONE')"),{code:'23514'});
        }finally{await admin.query('ROLLBACK');}
        assert.deepEqual(await version(),before);
        const other=new Client({connectionString:forDatabase(process.env['DB_TEST_ADMIN_URL']!,f.databaseName)});await other.connect();
        try {await Promise.all([admin.query('UPDATE nukhabapay.staff_users SET authz_version=authz_version+1 WHERE id=$1',[staff]),other.query('UPDATE nukhabapay.staff_users SET authz_version=authz_version+1 WHERE id=$1',[staff])]);}
        finally {await other.end();}assert.equal(BigInt((await version()).v),BigInt(before.v)+2n);
      });
      await t.test('combined sessions rotate, expire, revoke concurrently and preserve evidence across pool restart',async()=>{
        const s=await fresh();const rotated=await service.rotate(s.actor,s.raw);assert.equal(rotated.ok,true);if(!rotated.ok)throw new Error('Rotation denied');
        const raw=rotated.credential.cookieValue();assert.equal((await service.validate(s.raw)).ok,false);
        await first.close();active=second;assert.equal((await service.validate(raw)).ok,true);
        const cold=new StaffSessionLifecycle({actors,store:second,now:clock,enabled:true});assert.equal((await cold.validate(raw)).ok,false);
        const outcomes=await Promise.all(Array.from({length:6},()=>service.revoke(raw)));assert.equal(outcomes.every(x=>x.ok),true);
        assert.equal((await service.verifyRevocation(raw)).ok,true);assert.equal((await service.validate(raw)).ok,false);
        assert.equal((await admin.query("SELECT count(*)::int AS n FROM nukhbapay_sessions.events e JOIN nukhbapay_sessions.sessions s ON s.id=e.session_id WHERE s.token_hash=$1 AND e.event_name='SESSION_REVOKED'",[hash(raw)])).rows[0].n,1);
        const expiring=await fresh();now+=1000;assert.equal((await service.validate(expiring.raw)).ok,false);now=Date.now();
        await assert.rejects(()=>admin.query('DELETE FROM nukhbapay_sessions.events'),{code:'42501'});
      });
      await t.test('pg_dump/pg_restore restores complete history, session evidence, owners, grants and FORCE RLS into a fresh disposable database',async()=>{
        const directory=mkdtempSync(path.join(tmpdir(),'nukh-migration-test-')),archive=path.join(directory,'synthetic.dump');
        const bin=process.env['NUKHBAPAY_PG_TEST_BIN'];assert.ok(bin && path.isAbsolute(bin),'Explicit PostgreSQL test binary directory required');
        const adminUrl=new URL(process.env['DB_TEST_ADMIN_URL']!);
        const env={...process.env,PGHOST:'127.0.0.1',PGPORT:'5432',PGUSER:decodeURIComponent(adminUrl.username),PGPASSWORD:decodeURIComponent(adminUrl.password)};
        const evidence=async(c:Client)=>(await c.query("SELECT encode(sha256(convert_to(coalesce(string_agg(row_to_json(e)::text,',' ORDER BY id),''),'UTF8')),'hex') AS digest,count(*)::int AS n FROM nukhbapay_sessions.events e")).rows[0];
        const before=await evidence(admin);
        try {
          execFileSync(path.join(bin!,'pg_dump.exe'),['--format=custom','--file',archive,'--dbname',f.databaseName],{env,stdio:'pipe',windowsHide:true,timeout:30000});
          await withDisposableIamDatabase(async restored=>{
            execFileSync(path.join(bin!,'pg_restore.exe'),['--exit-on-error','--single-transaction','--dbname',restored.databaseName,archive],{env,stdio:'pipe',windowsHide:true,timeout:30000});
            assert.deepEqual((await restored.fixtureClient.query('SELECT name FROM nukhabapay.schema_migrations ORDER BY id')).rows.map(r=>r.name),expected);
            assert.deepEqual(await evidence(restored.fixtureClient),before);
            assert.equal((await restored.fixtureClient.query("SELECT bool_and(relrowsecurity AND relforcerowsecurity AND pg_get_userbyid(relowner)='nukhabapay_migrator') AS ok FROM pg_class WHERE relnamespace='nukhbapay_sessions'::regnamespace AND relkind='r'")).rows[0].ok,true);
            assert.equal((await restored.fixtureClient.query("SELECT has_column_privilege($1,'nukhbapay_sessions.sessions','token_hash','SELECT') AS read,has_table_privilege($1,'nukhbapay_sessions.sessions','UPDATE,DELETE') AS mutate",[role])).rows[0].read,true);
            assert.equal((await restored.fixtureClient.query("SELECT has_table_privilege($1,'nukhbapay_sessions.sessions','UPDATE,DELETE') AS mutate",[role])).rows[0].mutate,false);
            await assert.rejects(()=>restored.fixtureClient.query('DELETE FROM nukhbapay_sessions.events'),{code:'42501'});
          },'b3b3',0);
          await withDisposableIamDatabase(async failed=>{
            await failed.fixtureClient.query('CREATE SCHEMA nukhbapay_sessions AUTHORIZATION nukhabapay_migrator');
            assert.throws(()=>execFileSync(path.join(bin!,'pg_restore.exe'),['--exit-on-error','--single-transaction','--dbname',failed.databaseName,archive],{env,stdio:'pipe',windowsHide:true,timeout:30000}));
            assert.equal((await failed.fixtureClient.query("SELECT to_regnamespace('nukhabapay') IS NULL AS absent")).rows[0].absent,true);
            assert.equal((await failed.fixtureClient.query("SELECT count(*)::int AS n FROM pg_class WHERE relnamespace='nukhbapay_sessions'::regnamespace")).rows[0].n,0);
          },'b3b3',0);
        }finally{removeTemporary(directory);}
      });
    }finally {
      await Promise.all(stores.map(s=>s.close()));await runtime?.close();await owner.end();
      if(createdRole) {
        await admin.query(`REVOKE ALL(id,token_hash,actor_staff_id,issuer,subject,tenant_id,scope_key,authz_version,membership_version,authority_digest,identity_expires_ms,created_ms,expires_ms,idle_ms,parent_id,creation_operation_id,execution,assurance) ON nukhbapay_sessions.sessions FROM "${role}"`);
        await admin.query(`REVOKE ALL(id,operation_id,session_id,actor_staff_id,scope_key,event_name,occurred_ms,reason,execution) ON nukhbapay_sessions.events FROM "${role}"`);
        await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA nukhbapay_sessions FROM "${role}"`);
        await admin.query(`REVOKE ALL ON SCHEMA nukhbapay_sessions FROM "${role}"`);await admin.query(`REVOKE ALL ON DATABASE "${f.databaseName}" FROM "${role}"`);await admin.query(`DROP ROLE "${role}"`);
      }
    }
  },'b3b3',0);
});
