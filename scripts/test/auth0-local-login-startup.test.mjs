import assert from 'node:assert/strict';
import test from 'node:test';
import { missingStaffAuth0TestConfiguration, readStaffAuth0TestConfiguration, startStaffAuth0Test } from '../start-staff-auth0-test.mjs';

const database='nukhabapay_b3b3_'+'a'.repeat(32);
const role='nukh_session_'+'b'.repeat(20);
const secret='synthetic-configuration-secret-0000';
const address=expectedRole=>`postgresql://${expectedRole}:${secret}@127.0.0.1:5432/${database}`;
const settings={NODE_ENV:'development',NUKHBAPAY_ENV:'local',NUKHBAPAY_ENVIRONMENT:'development',
  NUKHBAPAY_STAFF_SESSION_MODE:'auth0-test-login',NUKHBAPAY_STAFF_AUTH0_ISSUER:'https://staff.fixture.invalid/',
  NUKHBAPAY_STAFF_AUTH0_CLIENT_ID:'staff-fixture',NUKHBAPAY_STAFF_AUTH0_CLIENT_SECRET:secret,
  NUKHBAPAY_STAFF_AUTH0_AUDIENCE:'urn:staff-fixture',NUKHBAPAY_STAFF_AUTH0_STAFF_KIND_CLAIM:'https://claims.fixture.invalid/staff',
  NUKHBAPAY_STAFF_AUTH0_TENANT_ID:'00000000-0000-4000-8000-000000000001',DB_IDENTITY_READER_URL:address('nukhabapay_identity_reader'),
  DB_IDENTITY_WRITER_URL:address('nukhabapay_identity_writer'),DB_STAFF_SESSION_URL:address(role),DB_STAFF_SESSION_ROLE:role,
  DB_STAFF_SESSION_EXPECTED_DATABASE_OID:'12345'};

test('attended login uses the canonical callback and one guarded IAM target, with secrets excluded from serialization',()=>{
  const config=readStaffAuth0TestConfiguration(settings);
  assert.equal(config.auth.callbackUrl,'https://localhost:3001/auth/callback');
  assert.equal(config.identity.database,database);
  assert.equal(config.session.expectedDatabase,database);
  assert.equal(config.session.expectedRole,role);
  assert.equal(config.databaseOid,'12345');
  assert.equal(JSON.stringify(config).includes(secret),false);
});

test('attended login rejects disabled or production modes, unguarded targets, and disabled TLS before opening a listener',async()=>{
  for (const override of [{NODE_ENV:'production'},{NUKHBAPAY_STAFF_SESSION_MODE:'disabled'},
    {NODE_TLS_REJECT_UNAUTHORIZED:'0'},{DB_STAFF_SESSION_EXPECTED_DATABASE_OID:'4294967296'},
    {DB_IDENTITY_READER_URL:settings.DB_IDENTITY_READER_URL.replace('127.0.0.1','localhost')},
    {DB_STAFF_SESSION_URL:settings.DB_STAFF_SESSION_URL.replace(':5432',':55437')},
    {DB_STAFF_SESSION_URL:settings.DB_STAFF_SESSION_URL.replace(database,'nukhabapay_dev')}]) {
    await assert.rejects(startStaffAuth0Test({...settings,...override}),{message:'Staff Auth0 test login unavailable'});
  }
});

test('missing Auth0 credentials and unconfigured IAM fail before any connection or certificate access',async()=>{
  const env={...settings,NUKHBAPAY_STAFF_AUTH0_CLIENT_SECRET:undefined,DB_IDENTITY_WRITER_URL:undefined};
  assert.deepEqual(missingStaffAuth0TestConfiguration(env),['NUKHBAPAY_STAFF_AUTH0_CLIENT_SECRET','DB_IDENTITY_WRITER_URL']);
  await assert.rejects(startStaffAuth0Test(env),{message:'Staff Auth0 test login unavailable'});
  await assert.rejects(startStaffAuth0Test(settings),{message:'Staff Auth0 test login unavailable'});
});
