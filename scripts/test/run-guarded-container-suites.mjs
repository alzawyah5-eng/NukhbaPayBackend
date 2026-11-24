import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, existsSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { networkInterfaces, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifiedMigrationSources } from '../rehearse-reviewed-migrations.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pgBin = '/usr/lib/postgresql/18/bin';
const require = createRequire(path.join(root, 'packages/database/package.json'));
const { Client } = require('pg');
const { runner } = require('node-pg-migrate');
const roles = ['nukhabapay_migrator','nukhabapay_runtime','nukhabapay_importer','nukhabapay_identity_reader','nukhabapay_identity_writer'];
const historyExpected = ['001_catalog','002_import_role_privileges','003_import_role_read_access'];

assert.equal(process.platform, 'linux');
assert.ok(existsSync('/.dockerenv') && userInfo().username === 'postgres', 'Run in the disposable qualification image');
const interfaces = networkInterfaces();
assert.deepEqual(Object.keys(interfaces), ['lo'], 'A dedicated loopback-only namespace is required');
assert.ok(interfaces.lo.some(address => address.address === '127.0.0.1'));
verifiedMigrationSources(root);

const directory = mkdtempSync(path.join(tmpdir(), 'nukh-guarded-postgres-'));
const env = {
  PATH: process.env.PATH,
  HOME: userInfo().homedir,
  NUKHBAPAY_PG_TEST_BIN: pgBin,
  DB_RUNTIME_ROLE: roles[1], DB_IMPORT_ROLE: roles[2],
  DB_IDENTITY_READER_ROLE: roles[3], DB_IDENTITY_WRITER_ROLE: roles[4],
};
const secretValues = [];

function createTlsFixture() {
  const cert = path.join(directory, 'fixture-cert.pem');
  const key = path.join(directory, 'fixture-key.pem');
  const pfx = path.join(directory, 'fixture-cert.pfx');
  const passphrase = randomBytes(32).toString('hex');
  secretValues.push(passphrase);
  function openssl(args) {
    const result = spawnSync('openssl', args, { env: { ...env, FIXTURE_PFX_PASSWORD:passphrase },
      encoding:'utf8', timeout:30000 });
    if (result.status !== 0 || result.error) throw new Error('Could not generate the disposable localhost certificate');
  }
  openssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1',
    '-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-addext','basicConstraints=critical,CA:FALSE',
    '-addext','extendedKeyUsage=serverAuth','-addext','keyUsage=critical,digitalSignature,keyEncipherment']);
  openssl(['pkcs12','-export','-out',pfx,'-inkey',key,'-in',cert,'-passout','env:FIXTURE_PFX_PASSWORD']);
  Object.assign(env, { NUKHBAPAY_STAFF_TEST_PFX_PATH:pfx, NUKHBAPAY_STAFF_TEST_CA_PATH:cert,
    NUKHBAPAY_STAFF_TEST_PASSPHRASE:passphrase });
}
for (const [name, index] of [['DB_MIGRATION_URL',0], ['DB_RUNTIME_URL',1], ['DB_IMPORT_URL',2],
  ['DB_IDENTITY_READER_URL',3], ['DB_IDENTITY_WRITER_URL',4], ['DB_TEST_ADMIN_URL',5]]) {
  const maintenance = index === 5;
  const password = randomBytes(32).toString('hex');
  const url = new URL('postgresql://127.0.0.1:5432');
  url.username = maintenance ? 'postgres' : roles[index];
  url.password = password;
  url.pathname = maintenance ? '/postgres' : '/nukhabapay_dev';
  env[name] = url.href;
  secretValues.push(password);
}

function redact(value) {
  let output = String(value ?? '').replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[redacted-database-url]');
  for (const secret of secretValues) output = output.replaceAll(secret, '[redacted]');
  return output;
}
function pg(command, args) {
  const result = spawnSync(path.join(pgBin, command), args, { env, encoding:'utf8', timeout:45000, maxBuffer:2*1024*1024 });
  if (result.status !== 0 || result.error) throw new Error(redact(result.stderr ?? result.error?.message ?? command));
}
async function connect(url, work) {
  const client = new Client({ connectionString:url, connectionTimeoutMillis:3000 });
  await client.connect();
  try { return await work(client); }
  finally { await client.end(); }
}
async function inventory() {
  const history = await connect(env.DB_MIGRATION_URL, async client =>
    (await client.query('SELECT name FROM nukhabapay.schema_migrations ORDER BY id')).rows.map(row=>row.name));
  return connect(env.DB_TEST_ADMIN_URL, async client => ({
    history,
    databases:(await client.query('SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database ORDER BY datname')).rows,
    roles:(await client.query('SELECT rolname, rolcanlogin, rolsuper, rolinherit, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles ORDER BY rolname')).rows,
    memberships:(await client.query('SELECT pg_get_userbyid(roleid) AS role, pg_get_userbyid(member) AS member, admin_option, inherit_option, set_option FROM pg_auth_members ORDER BY roleid, member, grantor')).rows,
  }));
}

let started = false;
try {
  // Generated workload roles used by the unchanged suites exist only within this private test cluster.
  pg('initdb', ['-D',directory,'--auth=trust','--locale=C','--encoding=UTF8','--username=postgres']);
  createTlsFixture();
  pg('pg_ctl', ['-D',directory,'-l',path.join(directory,'postgres.log'),'-w','-o',
    '-h 127.0.0.1 -p 5432 -c shared_buffers=64MB -c max_connections=40','start']);
  started = true;
  await connect(env.DB_TEST_ADMIN_URL, async client => {
    const target = (await client.query("SELECT current_setting('data_directory') AS directory, host(inet_server_addr()) AS address, inet_server_port() AS port, current_database() AS database, current_user AS role")).rows[0];
    assert.deepEqual(target, {directory,address:'127.0.0.1',port:5432,database:'postgres',role:'postgres'});
    for (const role of roles) await client.query('CREATE ROLE '+role+' LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB');
    await client.query('ALTER ROLE nukhabapay_runtime SET default_transaction_read_only = on');
    await client.query('ALTER ROLE nukhabapay_importer SET default_transaction_read_only = off');
    await client.query('CREATE DATABASE nukhabapay_dev OWNER nukhabapay_migrator');
    await client.query('REVOKE ALL ON DATABASE nukhabapay_dev FROM PUBLIC');
    await client.query('GRANT CONNECT ON DATABASE nukhabapay_dev TO '+roles.join(', '));
  });
  await connect(env.DB_MIGRATION_URL, async client => {
    await client.query('CREATE SCHEMA nukhabapay AUTHORIZATION nukhabapay_migrator');
    await client.query('GRANT USAGE ON SCHEMA nukhabapay TO '+roles.slice(1).join(', '));
    await runner({dbClient:client,dir:path.join(root,'packages/database/migrations'),direction:'up',count:3,timestamp:true,
      schema:'nukhabapay',migrationsSchema:'nukhabapay',migrationsTable:'schema_migrations',
      singleTransaction:true,checkOrder:true,ignorePattern:'README.md|.*\\.md',
      log:()=>{},logger:{info:()=>{},warn:()=>{},error:()=>{},debug:()=>{}}});
  });
  const before = await inventory();
  assert.deepEqual(before.history, historyExpected);
  assert.deepEqual(before.roles.filter(role=>role.rolname.startsWith('nukhabapay_')).map(role=>role.rolname), roles.toSorted());

  const databaseTests = 'packages/database/dist-test/database/test';
  const suites = [
    ['database', ...readdirSync(path.join(root,databaseTests)).filter(file=>file.endsWith('.spec.js')).sort().map(file=>databaseTests+'/'+file)],
    ['iam', ...['internal-staff-access','staff-http','local-api-runtime','staff-persistence','migration005','staff-sessions','migration006']
      .map(name=>'apps/api/dist-test/test/'+name+'.integration.js')],
    ['publication','apps/api/dist-test/test/catalogue-publication.integration.js'],
  ];
  for (const [name,...files] of suites) {
    console.log('RUN '+name);
    const result = spawnSync(process.execPath, ['--test','--test-concurrency=1','--test-reporter=tap',...files],
      { cwd: root, env, encoding:'utf8', timeout:480000, maxBuffer:10*1024*1024 });
    const output = redact((result.stdout ?? '')+(result.stderr ?? ''));
    process.stdout.write(output);
    // The scheduled-import test intentionally requires an alternate private port.
    // It runs separately under refresh-012-isolated.py with that test's own guard.
    const expectedSkips = name === 'database' ? 1 : 0;
    const skips = [...output.matchAll(/# SKIP(?: .*)?$/gm)];
    const expectedSkip = expectedSkips === 0 || /^ok \d+ - scheduled PostgreSQL import commits only under a current lease # SKIP$/m.test(output);
    if (result.status !== 0 || result.error || skips.length !== expectedSkips || !expectedSkip) {
      process.exitCode = 1;
      if (result.error) console.error(name+' process failure: '+result.error.code);
    }
  }
  assert.deepEqual(await inventory(), before, 'Disposable roles, databases and baseline history must be restored');
} catch (error) {
  console.error(redact(error.message));
  process.exitCode = 1;
} finally {
  if (started) pg('pg_ctl', ['-D',directory,'-m','fast','-w','stop']);
}
