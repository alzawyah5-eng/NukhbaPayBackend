import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAwsStagingIdentityRuntime, parseIdentityRuntimeConfiguration } from '../packages/database/dist/database/src/identity-runtime.js';
import { awsStagingTarget, verifyAwsStagingConnection } from '../packages/database/dist/database/src/aws-staging-target.js';
import { createAwsStagingStaffSessionStore } from '../packages/database/dist/database/src/staff-session-store.js';
import { createIdentityReaderPool, createIdentityWriterPool } from '../packages/database/dist/database/src/pool.js';
import { candidate, Client, database, owner, pilotIssuer, reader, session, sha, writer } from './windows-staff-migration.mjs';
import { scram } from './local-catalogue-setup.mjs';
import { workspaceReady, workspaceWriterReady } from './start-windows-staff-portal.mjs';

const admin = 'stagingadmin';
const marker = 'NukhbaPay AWS staging staff v1';
const workloadRoles = [reader, writer, session];
const roles = [owner, ...workloadRoles, 'nukhabapay_runtime', 'nukhabapay_importer'];

function schemaDefinitions(sql, tag) {
  // candidate() authenticates the complete native SQL before this staging installer selects its DDL.
  const end = `END $${tag}$;`;
  const offset = sql.indexOf(end);
  if (offset < 0 || !sql.slice(0, offset).includes(`DO $${tag}$`)) throw new Error('Unrecognized reviewed schema boundary');
  return sql.slice(offset + end.length);
}

export async function applyAwsStagingStaffSchema(client) {
  const bundle = await candidate();
  const definitions = [schemaDefinitions(bundle.foundation, 'target'), bundle.iam, schemaDefinitions(bundle.portal, 'native')];
  const fingerprint = sha(JSON.stringify(definitions));
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL ROLE ${owner}`);
    const { rows: [target] } = await client.query(`SELECT current_database()=$1 AND current_user=$2 AND session_user=$3
      AND shobj_description(d.oid,'pg_database')=$4 AND pg_get_userbyid(d.datdba)=$2
      AND NOT EXISTS (SELECT FROM aclexplode(d.datacl) a WHERE a.grantee=0) AS approved,
      to_regclass('nukhabapay.aws_staging_staff_schema_history') IS NOT NULL AS installed
      FROM pg_database d WHERE d.datname=current_database()`, [database, owner, admin, marker]);
    if (!target?.approved) throw new Error('Unapproved AWS staff schema target');
    if (target.installed) {
      const { rows: [existing] } = await client.query('SELECT source_sha256,issuer FROM nukhabapay.aws_staging_staff_schema_history WHERE version=1');
      if (existing?.source_sha256 !== fingerprint || existing.issuer !== pilotIssuer) throw new Error('Existing AWS staff schema needs a reviewed migration');
    } else {
      const { rows: [[empty]] } = await client.query({ text: bundle.empty, rowMode: 'array' });
      if (empty !== true) throw new Error('Expected an empty staging staff database');
      await client.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
      await client.query("SELECT set_config('nukhbapay.windows_issuer',$1,true)", [pilotIssuer]);
      for (const definition of definitions) await client.query(definition);
      await client.query(`CREATE TABLE nukhabapay.aws_staging_staff_schema_history(
        version integer PRIMARY KEY CHECK (version=1), source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
        issuer text NOT NULL, installed_at timestamptz NOT NULL DEFAULT transaction_timestamp());`);
      await client.query('INSERT INTO nukhabapay.aws_staging_staff_schema_history(version,source_sha256,issuer) VALUES(1,$1,$2)', [fingerprint,pilotIssuer]);
    }
    await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${reader}, ${writer}, ${session}`);
    if ((await client.query('COMMIT')).command !== 'COMMIT') throw new Error('Incomplete staff schema transaction');
    return target.installed ? 'verified' : 'installed';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function trustedAdmin(client, name) {
  await client.connect();
  const { rows: [row] } = await client.query(`SELECT current_database()=$1 AND current_user=$2 AND session_user=$2
    AND system_user IN ('md5:'||$2,'scram-sha-256:'||$2) AND inet_server_port()=5432
    AND current_setting('server_version_num')::int/10000=18 AND NOT pg_is_in_recovery()
    AND (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid())
    AND pg_has_role(current_user,'rds_superuser','MEMBER') AS approved`, [name, admin]);
  if (!row?.approved) throw new Error('Unapproved AWS RDS administrator connection');
}

async function provision(control, passwords) {
  await control.query('BEGIN');
  try {
    for (const role of roles) {
      const password = passwords.get(role);
      const { rows: [current] } = await control.query(`SELECT shobj_description(oid,'pg_authid') AS marker,rolcanlogin,
        NOT (rolsuper OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS restricted,
        NOT EXISTS (SELECT FROM pg_auth_members m WHERE m.member=r.oid OR (m.roleid=r.oid AND m.member<>$2::regrole)) AS isolated
        FROM pg_roles r WHERE rolname=$1`, [role, admin]);
      if (current) {
        if (current.marker !== marker || !current.restricted || !current.isolated || current.rolcanlogin !== Boolean(password)) throw new Error('Staff database role is already in use');
      } else {
        const authentication = password ? `LOGIN PASSWORD '${scram(password)}'` : 'NOLOGIN';
        await control.query(`CREATE ROLE ${role} ${authentication} NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS${role === session ? ' CONNECTION LIMIT 4' : ''}`);
        await control.query(`COMMENT ON ROLE ${role} IS '${marker}'`);
      }
    }
    await control.query(`GRANT ${owner} TO ${admin} WITH SET TRUE, INHERIT FALSE`);
    await control.query('COMMIT');
  } catch (error) {
    await control.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
  const { rows: [existing] } = await control.query(`SELECT shobj_description(oid,'pg_database') AS marker,
    pg_get_userbyid(datdba) AS owner, datallowconn AS online FROM pg_database WHERE datname=$1`, [database]);
  if (existing && (existing.owner !== owner || existing.marker !== marker || !existing.online)) throw new Error('Staff database name is already in use');
  if (existing) return;
  await control.query(`CREATE DATABASE ${database} OWNER ${owner} TEMPLATE template0 ALLOW_CONNECTIONS false`);
  await control.query(`BEGIN;
    SET LOCAL ROLE ${owner};
    COMMENT ON DATABASE ${database} IS '${marker}';
    REVOKE ALL ON DATABASE ${database} FROM PUBLIC;
    GRANT CONNECT ON DATABASE ${database} TO ${admin};
    ALTER DATABASE ${database} ALLOW_CONNECTIONS true;
    COMMIT`);
}

async function main(env) {
  let control, connection, iam, sessions, readPool, writePool, phase = 'configuration';
  try {
    if (env.NUKHBAPAY_ENVIRONMENT !== 'aws-staging' || env.STAGING_DB_USERNAME !== admin || !env.STAGING_DB_PASSWORD) throw new Error('Incomplete staging-only setup');
    const target = awsStagingTarget(env.NUKHBAPAY_STAGING_RDS_HOST,readFileSync('/app/rds-ca.pem','utf8'));
    const identity = parseIdentityRuntimeConfiguration(env,target.host);
    const sessionUrl = new URL(env.DB_STAFF_SESSION_URL);
    if (sessionUrl.protocol !== 'postgresql:' || sessionUrl.username !== session || sessionUrl.hostname !== target.host ||
        sessionUrl.port || sessionUrl.search || sessionUrl.hash || sessionUrl.pathname !== `/${database}`) throw new Error('Unexpected staging session settings');
    const values = [identity.readerUrl,identity.writerUrl,sessionUrl.href].map(url => new URL(url).password);
    if (values.some(value => !/^[a-f0-9]{64}$/.test(value)) || new Set(values).size !== workloadRoles.length) throw new Error('Invalid staging database credentials');
    const pg = {host:target.host, ssl:target.ssl, port:5432, user:admin, password:env.STAGING_DB_PASSWORD,
      connectionTimeoutMillis:8000, statement_timeout:90000, query_timeout:120000, options:'-c search_path=pg_catalog -c lock_timeout=8000'};
    phase = 'provision staging staff roles';
    control = new Client({...pg,database:'postgres'});
    await trustedAdmin(control,'postgres');
    const {rows:[state]} = await control.query("SELECT pg_try_advisory_lock(hashtextextended('nukhbapay.aws.staging.staff',0)) AS locked");
    if (!state?.locked) throw new Error('Staging staff migration lock unavailable');
    await provision(control,new Map(workloadRoles.map((role,index) => [role,values[index]])));
    phase = 'apply reviewed staff schema';
    connection = new Client({...pg,database});
    await trustedAdmin(connection,database);
    const schema = await applyAwsStagingStaffSchema(connection);
    phase = 'verify restricted staff runtime roles';
    iam = await createAwsStagingIdentityRuntime(env,target);
    sessions = await createAwsStagingStaffSessionStore({expectedRole:session,expectedDatabase:database,connectionString:sessionUrl.href},target);
    readPool = createIdentityReaderPool(identity,identity,client=>verifyAwsStagingConnection(client,database,reader),target.poolOptions);
    writePool = createIdentityWriterPool(identity,identity,client=>verifyAwsStagingConnection(client,database,writer),target.poolOptions);
    const results = await Promise.all([iam.checkReadiness(),sessions.checkWindowsReadiness(pilotIssuer),workspaceReady(readPool),workspaceWriterReady(writePool)]);
    if (results.some(result => result !== true)) throw new Error('Staging staff database runtime role verification failed');
    console.info(JSON.stringify({schema, restrictedRolesReady:true}));
  } catch(error) {
    const details = [error?.code,error?.table,error?.constraint].filter(value => /^[a-zA-Z0-9_]+$/.test(value ?? '')).join(' ');
    console.error(`AWS staff database setup failed at ${phase}${details ? ` (${details})` : ''}`);
    process.exitCode=1;
  } finally {
    await Promise.allSettled([control?.end(),connection?.end(),iam?.close(),sessions?.close(),readPool?.end(),writePool?.end()]);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main(process.env);
