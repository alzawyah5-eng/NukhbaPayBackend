import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(root,'packages/database/package.json'));
const frozen={
  '001_catalog.ts':'3f26bf82ace865d086d2d2f5471a8db0c5544e6459ab388b69a26e093a59c09c',
  '002_import_role_privileges.ts':'520dfef71a3cc5fb741c87ebf509ed3d4299b84f15394112778db577ebb5ffae',
  '003_import_role_read_access.ts':'4960730b563c8b8912cb1edc23235df9aa0077a463c32f01bc5e5ede51cecf34',
  '004_staff_identity_foundation.ts':'ebb5b282d9afad7dc5ef7b8221bd7b34942c1cbb53757e73832987b36975b312',
  '005_staff_workflow_persistence.ts':'41910d1aa060a1971c8e33e123b0e350d884ffede490cb71b52dc00838779390',
};
const registered006='035fa9bb914de3cb4094f8e98ce2fa9164dc4e6b5e11b40ddfdd55707bc98eed';
export function verifiedMigrationSources(sourceRoot=root) {
  const manifest=JSON.parse(readFileSync(path.join(sourceRoot,'packages/database/migration-manifest.json'),'utf8'));
  if(manifest.profile!=='REGISTERED_MIGRATIONS_V1' || manifest.status!=='006_REGISTERED_LOCAL_SOURCE_HISTORY' || Object.keys(manifest.files).length!==10)throw new Error('Migration manifest rejected');
  for(const [name,expected] of Object.entries(frozen))if(manifest.files['packages/database/migrations/'+name]!==expected)throw new Error('Frozen migration manifest rejected');
  if(manifest.files['packages/database/migrations/006_staff_server_sessions.ts']!==registered006)throw new Error('Registered migration manifest rejected');
  const snapshot=new Map();
  for(const [name,expected] of Object.entries(manifest.files)) {
    if(!/^packages\/database\/(migrations\/[0-9]{3}_[a-z_]+\.ts|pending-migrations\/(004_identity_(default_acl_preflight|activation_safeguards)\.sql|006_staff_server_sessions\.sql)|roles\/grant_identity_validity_reader\.sql)$/.test(name))throw new Error('Migration path rejected');
    const bytes=readFileSync(path.join(sourceRoot,name));
    if(createHash('sha256').update(bytes).digest('hex')!==expected)throw new Error('Migration source integrity rejected');
    snapshot.set(name,bytes);
  }
  return {manifest,snapshot};
}
export async function rehearseReviewedMigrations(connectionString) {
  const {Client}=require('pg'),{runner,PG_MIGRATE_LOCK_ID}=require('node-pg-migrate');
  const {manifest,snapshot}=verifiedMigrationSources();
  for(const [name,role] of Object.entries({DB_RUNTIME_ROLE:'nukhabapay_runtime',DB_IMPORT_ROLE:'nukhabapay_importer',
    DB_IDENTITY_READER_ROLE:'nukhabapay_identity_reader',DB_IDENTITY_WRITER_ROLE:'nukhabapay_identity_writer'})) {
    if((process.env[name]??role)!==role)throw new Error('Unreviewed migration workload configuration');
  }
  let url;
  try {url=new URL(connectionString);}catch{throw new Error('Unapproved migration rehearsal target');}
  if(!['postgres:','postgresql:'].includes(url.protocol) || url.hostname!=='127.0.0.1' || (url.port||'5432')!=='5432' || url.search || url.hash ||
    decodeURIComponent(url.username)!=='nukhabapay_migrator' || !/^nukhabapay_b3b[23]_[0-9a-f]{32}$/.test(decodeURIComponent(url.pathname.slice(1))))throw new Error('Unapproved migration rehearsal target');
  const directory=path.resolve(tmpdir(),'nukh-migration-rehearsal-'+randomUUID());
  const client=new Client({connectionString,connectionTimeoutMillis:3000,statement_timeout:15000});let locked=false,createdDirectory=false;
  try {
    mkdirSync(directory,{recursive:false});
    createdDirectory=true;
    for(const [name,bytes] of snapshot) {
      if(name.includes('/migrations/') || name.endsWith('004_identity_activation_safeguards.sql') || name.endsWith('006_staff_server_sessions.sql'))writeFileSync(path.join(directory,path.basename(name)),bytes,{flag:'wx'});
    }
    writeFileSync(path.join(directory,'migration-manifest.json'),JSON.stringify(manifest),{flag:'wx'});
    await client.connect();
    const target=(await client.query(`SELECT current_database() AS database,current_user AS role,host(inet_server_addr()) AS host,inet_server_port() AS port,
      (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls OR NOT rolcanlogin FROM pg_roles WHERE rolname=current_user) AS unsafe,
      EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user) OR roleid=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS membership`)).rows[0];
    if(target.database!==decodeURIComponent(url.pathname.slice(1)) || target.role!=='nukhabapay_migrator' || target.host!=='127.0.0.1' || target.port!==5432 || target.unsafe || target.membership)throw new Error('Unapproved migration connection');
    // Same advisory lock as the installed migrator. Preflight and migration use
    // one owner connection while this lock remains held. No automatic down/fake.
    const acquired=(await client.query('SELECT pg_try_advisory_lock($1) AS ok',[PG_MIGRATE_LOCK_ID])).rows[0].ok;
    if(!acquired)throw new Error('Migration lock unavailable');locked=true;
    await client.query(snapshot.get('packages/database/pending-migrations/004_identity_default_acl_preflight.sql').toString('utf8'));
    await runner({dbClient:client,dir:directory,direction:'up',count:6,timestamp:true,
      schema:'nukhabapay',migrationsSchema:'nukhabapay',migrationsTable:'schema_migrations',singleTransaction:true,checkOrder:true,noLock:true,
      ignorePattern:'.*\\.sql|.*\\.json',log:()=>undefined,logger:{info:()=>undefined,warn:()=>undefined,error:()=>undefined,debug:()=>undefined}});
    return (await client.query('SELECT name FROM nukhabapay.schema_migrations ORDER BY id')).rows.map(r=>r.name);
  } catch { throw new Error('Reviewed migration rehearsal rejected'); }
  finally {
    if(locked)await client.query('SELECT pg_advisory_unlock($1)',[PG_MIGRATE_LOCK_ID]).catch(()=>undefined);
    await client.end().catch(()=>undefined);
    const resolved=path.resolve(directory);
    if(path.dirname(resolved)!==path.resolve(tmpdir()) || !/^nukh-migration-rehearsal-[0-9a-f-]{36}$/.test(path.basename(resolved)))throw new Error('Unsafe rehearsal cleanup path');
    if(createdDirectory)rmSync(resolved,{recursive:true,force:true});
  }
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    if(process.argv.length!==3 || !['--verify-only','--registered-only'].includes(process.argv[2]))throw new Error();
    if(process.argv[2]==='--verify-only'){verifiedMigrationSources();console.info('Migration manifest verified; no database connection');}
    else {if(!process.env.DB_MIGRATION_URL)throw new Error();const names=await rehearseReviewedMigrations(process.env.DB_MIGRATION_URL);console.info('Disposable reviewed registered migration history:',names.join(', '));}
  }catch{console.error('Reviewed migration verification/rehearsal rejected');process.exitCode=1;}
}
