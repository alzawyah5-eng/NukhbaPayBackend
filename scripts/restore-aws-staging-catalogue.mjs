import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { awsStagingTarget } from '../packages/database/dist/database/src/aws-staging-target.js';
import { createAwsStagingCatalogueStorage } from '../packages/database/dist/database/src/local-catalogue-storage.js';
import { importStagingCatalogue, readStagingCatalogueSnapshot } from './aws-staging-catalogue-import.mjs';
import { scram } from './local-catalogue-setup.mjs';

const { Client } = createRequire(new URL('../packages/database/package.json', import.meta.url))('pg');
const roles = ['nukhbapay_catalogue_migrator', 'nukhbapay_catalogue_runtime', 'nukhbapay_catalogue_reader'];
const [owner, , reader] = roles;
const admin = 'stagingadmin';
const database = 'nukhbapay_catalogue';
const { env } = process;

async function provision(client, marker, password) {
  await client.query('BEGIN');
  try {
    for (const role of roles) {
      const { rows: [existing] } = await client.query(`SELECT shobj_description(oid,'pg_authid') AS marker, rolcanlogin,
        NOT (rolsuper OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS restricted,
        NOT EXISTS(SELECT FROM pg_auth_members m WHERE m.member=r.oid OR (m.roleid=r.oid AND m.member<>$2::regrole)) AS scoped
        FROM pg_roles r WHERE rolname=$1`, [role,admin]);
      if (existing) {
        if (existing.marker !== marker || !existing.restricted || !existing.scoped || existing.rolcanlogin !== (role === reader)) {
          throw new Error('Staging catalogue role is already in use');
        }
      } else {
        const login = role === reader ? `LOGIN PASSWORD '${scram(password)}'` : 'NOLOGIN';
        await client.query(`CREATE ROLE ${role} ${login} NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
        await client.query(`COMMENT ON ROLE ${role} IS '${marker}'`);
      }
    }
    await client.query(`GRANT ${owner} TO ${admin} WITH SET TRUE, INHERIT FALSE`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  const { rows: [existing] } = await client.query(`SELECT shobj_description(oid,'pg_database') AS marker,
    pg_get_userbyid(datdba) AS owner, datallowconn AS online FROM pg_database WHERE datname=$1`, [database]);
  if (existing && (existing.marker !== marker || existing.owner !== owner || !existing.online)) {
    throw new Error('Staging catalogue database is already in use');
  }
  if (!existing) {
    await client.query(`CREATE DATABASE ${database} OWNER ${owner} TEMPLATE template0 ALLOW_CONNECTIONS false`);
    await client.query(`BEGIN;
      SET LOCAL ROLE ${owner};
      COMMENT ON DATABASE ${database} IS '${marker}';
      REVOKE ALL ON DATABASE ${database} FROM PUBLIC;
      GRANT CONNECT ON DATABASE ${database} TO ${admin};
      ALTER DATABASE ${database} ALLOW_CONNECTIONS true;
      COMMIT`);
  }
}

async function requireRdsAdmin(client, name) {
  await client.connect();
  // The RDS-managed staging administrator can use MD5 over verified TLS. Application logins require SCRAM.
  const { rows: [row] } = await client.query(`SELECT current_database()=$1 AND session_user=$2 AND current_user=$2
    AND system_user IN ('scram-sha-256:'||$2,'md5:'||$2) AND inet_server_port()=5432
    AND current_setting('server_version_num')::int/10000=18 AND NOT pg_is_in_recovery()
    AND (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid())
    AND pg_has_role(current_user,'rds_superuser','MEMBER') AS verified`, [name,admin]);
  if (!row?.verified) throw new Error('Unexpected PostgreSQL staging target');
}

let control, catalogue, storage, stage = 'validate inputs';
try {
  const setupId = env.NUKHBAPAY_STAGING_CATALOGUE_ID;
  const readerPassword = env.DB_LOCAL_CATALOGUE_READER_PASSWORD;
  if (env.NUKHBAPAY_ENVIRONMENT !== 'aws-staging' || env.STAGING_DB_USERNAME !== admin || !env.STAGING_DB_PASSWORD ||
      !/^[a-f0-9]{32}$/.test(setupId ?? '') || !/^[a-f0-9]{64}$/.test(readerPassword ?? '')) {
    throw new Error('Invalid staging restore settings');
  }
  const marker = `nukhbapay-catalogue-staging:${setupId}`;
  const target = awsStagingTarget(env.NUKHBAPAY_STAGING_RDS_HOST,readFileSync('/app/rds-ca.pem','utf8'));
  const backup = await readStagingCatalogueSnapshot('/restore/catalogue.json.gz',env.STAGING_SNAPSHOT_CHECKSUM);
  const config = {host:target.host,ssl:target.ssl,port:5432,user:admin,password:env.STAGING_DB_PASSWORD,
    connectionTimeoutMillis:5000,query_timeout:420000,application_name:'nukhbapay-staging-catalogue-restore',
    options:'-c search_path=pg_catalog -c lock_timeout=8000 -c statement_timeout=360000'};
  stage = 'provision private catalogue database';
  control = new Client({...config,database:'postgres'});
  await requireRdsAdmin(control,'postgres');
  const { rows: [lock] } = await control.query('SELECT pg_try_advisory_lock(8074652183940113::bigint) AS held');
  if (!lock?.held) throw new Error('A staging catalogue restore is already running');
  await provision(control,marker,readerPassword);
  stage = 'restore catalogue transaction';
  catalogue = new Client({...config,database});
  await requireRdsAdmin(catalogue,database);
  await catalogue.query(`SET ROLE ${owner}`);
  const { counts, migrated } = await importStagingCatalogue(catalogue,backup);
  await catalogue.query(`GRANT CONNECT ON DATABASE ${database} TO ${reader}`);
  stage = 'verify restricted catalogue read';
  storage = await createAwsStagingCatalogueStorage({setupId,password:readerPassword},target);
  if (!await storage.checkReadiness()) throw new Error('Staging catalogue reader is unavailable');
  const verify = new Client({...config,user:reader,password:readerPassword,database});
  try {
    await verify.connect();
    await verify.query('BEGIN READ ONLY');
    const { rows: [noScope] } = await verify.query('SELECT count(*)::int AS visible FROM nukhabapay.catalogue_discoveries');
    if (noScope?.visible !== 0) throw new Error('Staging catalogue tenant isolation failed');
    await verify.query("SELECT set_config('nukhabapay.tenant_id',$1,true)", [backup.snapshot.tenantId]);
    for (const [table, expected] of Object.entries(counts)) {
      const {rows:[row]} = await verify.query(`SELECT count(*)::int AS visible FROM nukhabapay.${table}`);
      if (row?.visible !== expected) throw new Error('Staging catalogue restore counts differ');
    }
    const {rows:products} = await verify.query(`SELECT a.provider_code,count(*)::int AS products
      FROM nukhabapay.observed_catalogue_discoveries d JOIN nukhabapay.provider_accounts a
      ON (a.tenant_id,a.id)=(d.tenant_id,d.provider_account_id) GROUP BY a.provider_code ORDER BY a.provider_code`);
    const {rows:[amounts]} = await verify.query(`SELECT count(converted_aed)::int AS converted_aed,
      count(acquisition_cost_aed)::int AS acquisition_cost_aed FROM nukhabapay.finxplor_layer1_customer_prices`);
    if (amounts?.acquisition_cost_aed !== 0) throw new Error('Staging acquisition cost is not empty');
    await verify.query('COMMIT');
    console.info(JSON.stringify({migrated,products,amounts,counts}));
  } finally { await verify.end(); }
} catch (error) {
  const details = [error?.code,error?.table,error?.constraint].filter(value => /^[a-zA-Z0-9_]+$/.test(value ?? '')).join(' ');
  console.error(`Staging catalogue restore failed at ${stage}${details ? ` (${details})` : ''}`);
  process.exitCode = 1;
} finally {
  await Promise.allSettled([storage?.close(),catalogue?.end(),control?.end()]);
}
