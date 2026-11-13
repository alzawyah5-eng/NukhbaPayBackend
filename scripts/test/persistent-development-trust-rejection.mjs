import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectPersistentDevelopmentDeployment,parsePersistentDevelopmentPreflightEnvironment,
  verifyPersistentTargetEvidence } from '../persistent-development-iam.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const {Client}=createRequire(path.join(root,'packages/database/package.json'))('pg');
const syntheticUrl=()=>{
  const url=new URL('postgresql://127.0.0.1:5432/nukhabapay_dev');
  url.username='nukhabapay_migrator';url.password=randomBytes(32).toString('hex');return url.href;
};

test('persistent development preflight rejects the current loopback trust fallback without changing history',async()=>{
  const connectionString=syntheticUrl();
  const client=new Client({connectionString,connectionTimeoutMillis:3000,statement_timeout:5000});
  await client.connect();
  let target;
  try {
    await client.query('BEGIN READ ONLY');
    target=(await client.query(`SELECT (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
      (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
      array_agg(name ORDER BY id) AS history FROM nukhabapay.schema_migrations`)).rows[0];
    await client.query('COMMIT');
  } finally {await client.end();}
  assert.deepEqual(target.history,['001_catalog','002_import_role_privileges','003_import_role_read_access']);
  const manifestHash=createHash('sha256').update(readFileSync(path.join(root,'packages/database/migration-manifest.json'))).digest('hex');
  const approval='SYNTHETIC_READ_ONLY_TRUST_CHECK';
  const env={
    NUKHBAPAY_DB_DEPLOYMENT_PROFILE:'persistent-development-preflight-v1',NUKHBAPAY_ENVIRONMENT:'development',
    NUKHBAPAY_ENV:'local',NODE_ENV:'development',DB_RUNTIME_ROLE:'nukhabapay_runtime',DB_IMPORT_ROLE:'nukhabapay_importer',
    DB_IDENTITY_READER_ROLE:'nukhabapay_identity_reader',DB_IDENTITY_WRITER_ROLE:'nukhabapay_identity_writer',
    NUKHBAPAY_DB_DEPLOYMENT_APPROVAL_ID:approval,NUKHBAPAY_DB_EXPECTED_DATABASE_OID:target.database_oid,
    NUKHBAPAY_DB_EXPECTED_SYSTEM_IDENTIFIER:target.system_identifier,
    NUKHBAPAY_DB_DEPLOYMENT_CONFIRMATION:`PREFLIGHT_ONLY:nukhabapay_dev:${manifestHash}`,
    NUKHBAPAY_DB_SCRAM_HBA_ATTESTATION:`SCRAM_SHA_256_LOOPBACK:${approval}`,DB_MIGRATION_URL:connectionString,
  };
  const parsed=parsePersistentDevelopmentPreflightEnvironment(env);
  const validation=new Client({connectionString:parsed.connectionString,connectionTimeoutMillis:3000});await validation.connect();
  try {assert.deepEqual((await verifyPersistentTargetEvidence(validation,parsed)).history,target.history);}
  finally {await validation.end();}
  await assert.rejects(()=>inspectPersistentDevelopmentDeployment(env),/rejected/);
  const verify=new Client({connectionString:syntheticUrl(),connectionTimeoutMillis:3000});await verify.connect();
  try {assert.deepEqual((await verify.query('SELECT name FROM nukhabapay.schema_migrations ORDER BY id')).rows.map(row=>row.name),target.history);}
  finally {await verify.end();}
});
