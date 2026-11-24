import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';
import {readWindowsStaffSettings,startWindowsStaffPortal} from '../start-windows-staff-portal.mjs';
import {readStaffAuth0TestConfiguration} from '../start-staff-auth0-test.mjs';
import {verifyWindowsStaffConnection,windowsStaffTarget,WindowsStaffTargetMismatch} from '../../packages/database/dist/database/src/windows-staff-target.js';

const reader='nukhabapay_identity_reader',writer='nukhabapay_identity_writer',session='nukhabapay_session_backend';
const uri=role=>'postgresql://'+role+':offline-only-credential-'+role+'@127.0.0.1:5432/nukhbapay_staff';
const config={NODE_ENV:'development',NUKHBAPAY_ENV:'local',NUKHBAPAY_ENVIRONMENT:'development',
  NUKHBAPAY_STAFF_SESSION_MODE:'windows-staff-development',NUKHBAPAY_STAFF_AUTH0_CLIENT_SECRET:'offline-only-authentication-secret-for-tests',
  NUKHBAPAY_STAFF_AUTH0_CLIENT_ID:'offline-client',NUKHBAPAY_STAFF_AUTH0_AUDIENCE:'urn:test-staff',
  NUKHBAPAY_STAFF_AUTH0_ISSUER:'https://staff.example.test/',NUKHBAPAY_STAFF_AUTH0_STAFF_KIND_CLAIM:'https://claim.example.test/kind',
  NUKHBAPAY_STAFF_AUTH0_TENANT_ID:'00000000-0000-4000-8000-000000000001',
  DB_STAFF_SESSION_EXPECTED_DATABASE_OID:'12345',DB_STAFF_SESSION_EXPECTED_SYSTEM_IDENTIFIER:'7000000000000000001',
  DB_IDENTITY_READER_URL:uri(reader),DB_IDENTITY_WRITER_URL:uri(writer),DB_STAFF_SESSION_URL:uri(session),DB_STAFF_SESSION_ROLE:session};

test('Windows portal binds three different workload credentials to the named database and redacts them',()=>{
  const parsed=readWindowsStaffSettings(config);
  assert.equal(parsed.session.expectedDatabase,'nukhbapay_staff');
  assert.equal(parsed.target.databaseOid,'12345');
  assert.equal(parsed.auth.callbackUrl,'https://localhost:3001/auth/callback');
  assert.doesNotMatch(JSON.stringify(parsed),/offline-only/);
  assert.throws(()=>readStaffAuth0TestConfiguration({...config,NUKHBAPAY_STAFF_SESSION_MODE:'auth0-test-login'}));
});

test('invalid targets, role substitution, shared credentials and unsafe runtime settings stop before opening a connection',async()=>{
  for(const override of [
    {NODE_ENV:'production'},{NUKHBAPAY_STAFF_SESSION_MODE:'auth0-test-login'},{NODE_TLS_REJECT_UNAUTHORIZED:'0'},
    {DB_IDENTITY_READER_URL:uri('postgres')},{DB_IDENTITY_WRITER_URL:uri(reader)},{DB_STAFF_SESSION_ROLE:reader},
    {DB_STAFF_SESSION_URL:uri(session).replace('127.0.0.1','localhost')},{DB_STAFF_SESSION_URL:uri(session).replace('5432','55437')},
    {DB_STAFF_SESSION_URL:uri(session).replace('nukhbapay_staff','nukhabapay_dev')},{DB_STAFF_SESSION_URL:uri(session)+'?options=unsuitable'},
    {DB_STAFF_SESSION_URL:uri(session).replace('credential-'+session,'credential-'+reader)},
    {DB_STAFF_SESSION_EXPECTED_DATABASE_OID:'4294967296'},{DB_STAFF_SESSION_EXPECTED_SYSTEM_IDENTIFIER:'18446744073709551616'},
    {DB_STAFF_SESSION_EXPECTED_SYSTEM_IDENTIFIER:undefined},
  ])await assert.rejects(startWindowsStaffPortal({...config,...override},{preflightOnly:true}),{message:'Windows staff portal configuration unavailable'});
});

test('the connection check requires a positive server result for the pinned role, database, OID and cluster',async()=>{
  const target=windowsStaffTarget('12345','7000000000000000001');
  let calls=0;
  const positive={query:async(sql,params)=>{
    calls++;
    assert.deepEqual(params,['nukhbapay_staff','12345','7000000000000000001',reader]);
    return {rows:[{verified:true}]};
  }};
  await verifyWindowsStaffConnection(positive,target,reader);
  await assert.rejects(verifyWindowsStaffConnection(positive,target,'postgres'));
  assert.equal(calls,1);
  for(const rows of [[],[{verified:null}],[{verified:false}],[{verified:'t'}],[{verified:true},{verified:true}]])
    await assert.rejects(verifyWindowsStaffConnection({query:async()=>({rows})},target,reader));
  await assert.rejects(verifyWindowsStaffConnection({query:async()=>({
    rows: [{verified: false, failed_checks: ['schema grants', 'private detail']}],
  })},target,reader), {failedChecks: ['schema grants']});
});

test('portal reports the affected IAM role and a safe failure category', async t => {
  const requireDatabase = createRequire(new URL('../../packages/database/package.json', import.meta.url));
  const {Pool} = requireDatabase('pg');
  let failingRole = reader;
  let failure = Object.assign(new Error('private error detail'), {code: '28P01'});
  t.mock.method(Pool.prototype, 'query', async function () {
    const role = new URL(this.options.connectionString).username;
    if (role === failingRole) {
      throw failure;
    }
    return {rowCount: 1, rows: [{
      name: role, rolcanlogin: true, rolsuper: false, rolcreatedb: false,
      rolcreaterole: false, rolinherit: false, rolbypassrls: false,
      member: false, ddl: false, database_owner: false,
    }]};
  });

  await assert.rejects(startWindowsStaffPortal(config, {preflightOnly: true}),
    {message: 'Windows staff portal stopped at '+reader+' (password rejected)'});
  failingRole = writer;
  failure = Object.assign(new Error('private error detail'), {code: '42501'});
  await assert.rejects(startWindowsStaffPortal(config, {preflightOnly: true}),
    {message: 'Windows staff portal stopped at '+writer+' (permission denied)'});
  failingRole = reader;
  failure = new WindowsStaffTargetMismatch(['database identity', 'private detail']);
  await assert.rejects(startWindowsStaffPortal(config, {preflightOnly: true}),
    {message: 'Windows staff portal stopped at '+reader+' (restricted role check failed: database identity)'});
  failure = new Error('Connection terminated due to connection timeout');
  await assert.rejects(startWindowsStaffPortal(config, {preflightOnly: true}),
    {message: 'Windows staff portal stopped at '+reader+' (connection timed out)'});
});
