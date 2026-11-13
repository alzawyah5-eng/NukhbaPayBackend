import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as deployment from '../persistent-development-iam.mjs';
import { verifiedMigrationSources } from '../rehearse-reviewed-migrations.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const manifestHash=()=>createHash('sha256').update(readFileSync(path.join(root,'packages/database/migration-manifest.json'))).digest('hex');
const connection=()=>{
  const url=new URL('postgresql://127.0.0.1:5432/nukhabapay_dev');
  url.username='nukhabapay_migrator';url.password='synthetic-password-not-a-secret';return url.href;
};
const valid=()=>({
  NUKHBAPAY_DB_DEPLOYMENT_PROFILE:'persistent-development-preflight-v1',
  NUKHBAPAY_ENVIRONMENT:'development',
  NUKHBAPAY_ENV:'local',NODE_ENV:'development',
  DB_RUNTIME_ROLE:'nukhabapay_runtime',DB_IMPORT_ROLE:'nukhabapay_importer',
  DB_IDENTITY_READER_ROLE:'nukhabapay_identity_reader',DB_IDENTITY_WRITER_ROLE:'nukhabapay_identity_writer',
  NUKHBAPAY_DB_DEPLOYMENT_APPROVAL_ID:'CHANGE_12345678',
  NUKHBAPAY_DB_EXPECTED_DATABASE_OID:'24576',
  NUKHBAPAY_DB_EXPECTED_SYSTEM_IDENTIFIER:'7000000000000000001',
  NUKHBAPAY_DB_DEPLOYMENT_CONFIRMATION:`PREFLIGHT_ONLY:nukhabapay_dev:${manifestHash()}`,
  NUKHBAPAY_DB_SCRAM_HBA_ATTESTATION:'SCRAM_SHA_256_LOOPBACK:CHANGE_12345678',
  DB_MIGRATION_URL:connection(),
});

test('persistent development preflight is explicit, preflight-only and redacts credentials',()=>{
  const parsed=deployment.parsePersistentDevelopmentPreflightEnvironment(valid());
  assert.equal(parsed.profile,'persistent-development-preflight-v1');
  assert.equal(parsed.database,'nukhabapay_dev');
  assert.equal(Object.keys(parsed).includes('connectionString'),false);
  assert.doesNotMatch(inspect(parsed),/synthetic-password/);
  assert.equal('applyPersistentDevelopmentDeployment' in deployment,false);
});

test('persistent development preflight denies missing authorization, unsafe targets and disposable fallback',()=>{
  const mutations=[
    ['NUKHBAPAY_DB_DEPLOYMENT_PROFILE',undefined],['NUKHBAPAY_DB_DEPLOYMENT_PROFILE','disposable'],
    ['NUKHBAPAY_ENVIRONMENT','production'],['NUKHBAPAY_ENV','production'],['NODE_ENV','production'],['DB_TEST_ADMIN_URL',connection()],
    ['NUKHBAPAY_PG_TEST_BIN','C:\\PostgreSQL'],['DB_RUNTIME_ROLE','unreviewed_runtime'],
    ['NUKHBAPAY_DB_DEPLOYMENT_APPROVAL_ID','short'],['NUKHBAPAY_DB_EXPECTED_DATABASE_OID','0'],
    ['NUKHBAPAY_DB_EXPECTED_SYSTEM_IDENTIFIER','short'],['NUKHBAPAY_DB_DEPLOYMENT_CONFIRMATION','PREFLIGHT_ONLY:nukhabapay_dev:wrong'],
    ['NUKHBAPAY_DB_SCRAM_HBA_ATTESTATION','TRUST'],['DB_MIGRATION_URL',connection().replace('nukhabapay_dev','postgres')],
    ['DB_MIGRATION_URL',connection().replace('127.0.0.1','localhost')],['DB_MIGRATION_URL',connection().replace('nukhabapay_migrator','postgres')],
    ['DB_MIGRATION_URL','postgresql://nukhabapay_migrator@127.0.0.1:5432/nukhabapay_dev'],
  ];
  assert.throws(()=>deployment.parsePersistentDevelopmentPreflightEnvironment({}),/rejected/);
  for(const [key,value] of mutations) {
    const env=valid();if(value===undefined)delete env[key];else env[key]=value;
    assert.throws(()=>deployment.parsePersistentDevelopmentPreflightEnvironment(env),/rejected/,key);
  }
});

test('persistent target evidence rejects unexpected database grants',async()=>{
  const config={database:'nukhabapay_dev',expectedDatabaseOid:'24576',expectedSystemIdentifier:'7000000000000000001'};
  const responses=[
    {rows:[{database:'nukhabapay_dev',role:'nukhabapay_migrator',host:'127.0.0.1',port:5432,database_oid:'24576',
      owner:'nukhabapay_migrator',system_identifier:'7000000000000000001',server_version_num:170011,password_encryption:'scram-sha-256',unsafe:false,membership:false}]},
    {rows:[{name:'001_catalog'},{name:'002_import_role_privileges'},{name:'003_import_role_read_access'}]},
    {rows:['nukhabapay_identity_reader','nukhabapay_identity_writer','nukhabapay_importer','nukhabapay_migrator','nukhabapay_runtime']
      .map(rolname=>({rolname,rolcanlogin:true,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolinherit:false,rolbypassrls:false,membership:false}))},
    {rows:[{count:1}]},
  ];
  const client={query:async()=>responses.shift()};
  await assert.rejects(()=>deployment.verifyPersistentTargetEvidence(client,config),/rejected/);
  assert.equal(responses.length,0);
});

test('proposed persistent IAM envelope is unregistered and contains no data or DDL grant',()=>{
  const sql=readFileSync(path.join(root,'packages/database/roles/proposed_persistent_iam_connection_grants.sql'),'utf8');
  const {manifest}=verifiedMigrationSources(root);
  assert.equal('packages/database/roles/proposed_persistent_iam_connection_grants.sql' in manifest.files,false);
  assert.match(sql,/GRANT CONNECT ON DATABASE nukhabapay_dev TO nukhabapay_identity_reader,nukhabapay_identity_writer/);
  assert.match(sql,/GRANT USAGE ON SCHEMA nukhabapay TO nukhabapay_identity_reader,nukhabapay_identity_writer/);
  assert.doesNotMatch(sql,/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|CREATE|TEMP)\b/i);
  assert.match(sql,/has_database_privilege\('nukhabapay_importer',current_database\(\),'CONNECT'\)/);
  assert.match(sql,/has_schema_privilege\('nukhabapay_importer','nukhabapay','USAGE'\)/);
});

test('persistent development preflight rejects source or manifest tampering before any connection',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'nukh-persistent-profile-'));
  try {
    const {manifest}=verifiedMigrationSources(root);
    for(const name of Object.keys(manifest.files)) {
      const target=path.join(directory,name);mkdirSync(path.dirname(target),{recursive:true});cpSync(path.join(root,name),target);
    }
    const manifestPath=path.join(directory,'packages/database/migration-manifest.json');
    writeFileSync(manifestPath,readFileSync(path.join(root,'packages/database/migration-manifest.json')));
    const env=valid();
    env.NUKHBAPAY_DB_DEPLOYMENT_CONFIRMATION=`PREFLIGHT_ONLY:nukhabapay_dev:${createHash('sha256').update(readFileSync(manifestPath)).digest('hex')}`;
    deployment.parsePersistentDevelopmentPreflightEnvironment(env,directory);
    writeFileSync(path.join(directory,'packages/database/migrations/006_staff_server_sessions.ts'),'tampered');
    assert.throws(()=>deployment.parsePersistentDevelopmentPreflightEnvironment(env,directory),/integrity rejected/);
    cpSync(path.join(root,'packages/database/migrations/006_staff_server_sessions.ts'),path.join(directory,'packages/database/migrations/006_staff_server_sessions.ts'));
    const changed=JSON.parse(readFileSync(manifestPath,'utf8'));changed.status='UNREVIEWED';writeFileSync(manifestPath,JSON.stringify(changed));
    assert.throws(()=>deployment.parsePersistentDevelopmentPreflightEnvironment(env,directory),/manifest rejected/i);
  } finally {rmSync(directory,{recursive:true,force:true});}
});
