import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifiedMigrationSources } from './rehearse-reviewed-migrations.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(root,'packages/database/package.json'));
const expectedHistory=['001_catalog','002_import_role_privileges','003_import_role_read_access'];
const exactRoles={DB_RUNTIME_ROLE:'nukhabapay_runtime',DB_IMPORT_ROLE:'nukhabapay_importer',
  DB_IDENTITY_READER_ROLE:'nukhabapay_identity_reader',DB_IDENTITY_WRITER_ROLE:'nukhabapay_identity_writer'};
const reject=()=>new Error('Persistent development IAM preflight rejected');
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

function parseTargetUrl(text) {
  if(typeof text!=='string'||text.length===0||text.length>4096||/\s/.test(text))throw reject();
  let url,user,password,database;
  try {url=new URL(text);user=decodeURIComponent(url.username);password=decodeURIComponent(url.password);database=decodeURIComponent(url.pathname.slice(1));}
  catch {throw reject();}
  if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||(url.port||'5432')!=='5432'||
    url.search||url.hash||user!=='nukhabapay_migrator'||database!=='nukhabapay_dev'||password.length<16||password.length>1024)throw reject();
  return {connectionString:text,database};
}

export function parsePersistentDevelopmentPreflightEnvironment(env,sourceRoot=root) {
  if(env.NUKHBAPAY_DB_DEPLOYMENT_PROFILE!=='persistent-development-preflight-v1'||env.NUKHBAPAY_ENVIRONMENT!=='development'||
    env.NUKHBAPAY_ENV!=='local'||env.NODE_ENV!=='development'||env.DB_TEST_ADMIN_URL!==undefined||env.NUKHBAPAY_PG_TEST_BIN!==undefined)throw reject();
  for(const [name,value] of Object.entries(exactRoles))if(env[name]!==value)throw reject();
  const approvalId=env.NUKHBAPAY_DB_DEPLOYMENT_APPROVAL_ID;
  const expectedDatabaseOid=env.NUKHBAPAY_DB_EXPECTED_DATABASE_OID;
  const expectedSystemIdentifier=env.NUKHBAPAY_DB_EXPECTED_SYSTEM_IDENTIFIER;
  if(typeof approvalId!=='string'||!/^[A-Z][A-Z0-9_-]{7,63}$/.test(approvalId)||
    typeof expectedDatabaseOid!=='string'||!/^[1-9]\d{0,9}$/.test(expectedDatabaseOid)||
    typeof expectedSystemIdentifier!=='string'||!/^[1-9]\d{15,19}$/.test(expectedSystemIdentifier))throw reject();
  const {manifest}=verifiedMigrationSources(sourceRoot);
  const manifestSha256=sha256(readFileSync(path.join(sourceRoot,'packages/database/migration-manifest.json')));
  if(env.NUKHBAPAY_DB_DEPLOYMENT_CONFIRMATION!==`PREFLIGHT_ONLY:nukhabapay_dev:${manifestSha256}`||
    env.NUKHBAPAY_DB_SCRAM_HBA_ATTESTATION!==`SCRAM_SHA_256_LOOPBACK:${approvalId}`)throw reject();
  const target=parseTargetUrl(env.DB_MIGRATION_URL);
  const settings={profile:'persistent-development-preflight-v1',database:target.database,approvalId,expectedDatabaseOid,
    expectedSystemIdentifier,manifestSha256};
  Object.defineProperties(settings,{connectionString:{value:target.connectionString},
    [inspect.custom]:{value:()=>({...settings,connection:'[REDACTED]'})}});
  return Object.freeze(settings);
}

async function verifyPasswordAuthentication(connectionString) {
  const {Client}=require('pg');
  const wrong=new URL(connectionString);wrong.password=randomBytes(32).toString('hex');
  const probe=new Client({connectionString:wrong.href,connectionTimeoutMillis:2000});
  let connected=false;
  try {await probe.connect();connected=true;}
  catch(error) {if(error?.code!=='28P01')throw reject();}
  finally {await probe.end().catch(()=>undefined);}
  if(connected)throw reject();
}

export async function verifyPersistentTargetEvidence(client,config) {
  const target=(await client.query(`SELECT current_database() AS database,current_user AS role,host(inet_server_addr()) AS host,
    inet_server_port() AS port,d.oid::text AS database_oid,pg_get_userbyid(d.datdba) AS owner,
    (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
    current_setting('server_version_num')::int AS server_version_num,current_setting('password_encryption') AS password_encryption,
    (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls OR NOT rolcanlogin FROM pg_roles WHERE rolname=current_user) AS unsafe,
    EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user) OR roleid=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS membership
    FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  if(target.database!==config.database||target.role!=='nukhabapay_migrator'||target.host!=='127.0.0.1'||target.port!==5432||
    target.database_oid!==config.expectedDatabaseOid||target.system_identifier!==config.expectedSystemIdentifier||target.owner!=='nukhabapay_migrator'||
    target.server_version_num<170000||target.server_version_num>=180000||target.password_encryption!=='scram-sha-256'||target.unsafe||target.membership)throw reject();
  const history=(await client.query('SELECT name FROM nukhabapay.schema_migrations ORDER BY id')).rows.map(row=>row.name);
  if(JSON.stringify(history)!==JSON.stringify(expectedHistory))throw reject();
  const principals=Object.values(exactRoles).concat('nukhabapay_migrator');
  const roles=(await client.query(`SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls,
    EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS membership FROM pg_roles r
    WHERE rolname=ANY($1::text[]) ORDER BY rolname`,[principals])).rows;
  if(roles.length!==5||roles.some(role=>!role.rolcanlogin||role.rolsuper||role.rolcreatedb||role.rolcreaterole||role.rolinherit||role.rolbypassrls||role.membership))throw reject();
  const unexpectedDatabaseAcl=(await client.query(`SELECT count(*)::int AS count FROM pg_database d
    CROSS JOIN LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a LEFT JOIN pg_roles r ON r.oid=a.grantee
    WHERE d.datname=current_database() AND NOT(a.grantee=d.datdba OR
      (r.rolname='nukhabapay_runtime' AND a.privilege_type='CONNECT' AND NOT a.is_grantable))`)).rows[0].count;
  if(unexpectedDatabaseAcl!==0)throw reject();
  const unexpectedSchemaAcl=(await client.query(`SELECT count(*)::int AS count FROM pg_namespace n
    CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a LEFT JOIN pg_roles r ON r.oid=a.grantee
    WHERE n.nspname='nukhabapay' AND NOT(a.grantee=n.nspowner OR
      (r.rolname='nukhabapay_runtime' AND a.privilege_type='USAGE' AND NOT a.is_grantable))`)).rows[0].count;
  if(unexpectedSchemaAcl!==0)throw reject();
  const defaults=(await client.query(`SELECT
    count(*) FILTER(WHERE a.grantee<>d.defaclrole AND NOT(d.defaclobjtype='r' AND d.defaclnamespace='nukhabapay'::regnamespace
      AND r.rolname IN ('nukhabapay_runtime','nukhabapay_importer') AND a.privilege_type='SELECT' AND NOT a.is_grantable)
      AND NOT(d.defaclobjtype='f' AND d.defaclnamespace=0 AND a.grantee=0 AND a.privilege_type='EXECUTE' AND NOT a.is_grantable))::int AS unexpected,
    count(DISTINCT r.rolname) FILTER(WHERE d.defaclobjtype='r' AND d.defaclnamespace='nukhabapay'::regnamespace
      AND r.rolname IN ('nukhabapay_runtime','nukhabapay_importer') AND a.privilege_type='SELECT' AND NOT a.is_grantable)::int AS catalogue_readers
    FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a LEFT JOIN pg_roles r ON r.oid=a.grantee
    WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND d.defaclobjtype IN ('r','f','n','S')`)).rows[0];
  if(defaults.unexpected!==0||defaults.catalogue_readers!==2)throw reject();
  const unexpectedObjectAcl=(await client.query(`SELECT count(*)::int AS count FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) a
    LEFT JOIN pg_roles r ON r.oid=a.grantee
    WHERE c.relnamespace='nukhabapay'::regnamespace AND c.relkind IN ('r','p','S')
      AND NOT(a.grantee=c.relowner OR r.rolname IN ('nukhabapay_runtime','nukhabapay_importer'))`)).rows[0].count;
  if(unexpectedObjectAcl!==0)throw reject();
  const privileges=(await client.query(`SELECT r.rolname,has_database_privilege(r.rolname,current_database(),'CONNECT') AS connect,
    has_database_privilege(r.rolname,current_database(),'CREATE,TEMP') AS database_excess,
    has_schema_privilege(r.rolname,'nukhabapay','USAGE') AS schema_usage,has_schema_privilege(r.rolname,'nukhabapay','CREATE') AS schema_create
    FROM pg_roles r WHERE r.rolname=ANY($1::text[]) ORDER BY r.rolname`,[principals])).rows;
  const expected={nukhabapay_identity_reader:[false,false,false,false],nukhabapay_identity_writer:[false,false,false,false],
    nukhabapay_importer:[false,false,false,false],nukhabapay_migrator:[true,true,true,true],nukhabapay_runtime:[true,false,true,false]};
  if(privileges.length!==5||privileges.some(row=>JSON.stringify([row.connect,row.database_excess,row.schema_usage,row.schema_create])!==JSON.stringify(expected[row.rolname])))throw reject();
  const state=(await client.query(`SELECT to_regclass('nukhabapay.staff_users') IS NULL AS iam_absent,
    to_regnamespace('nukhbapay_sessions') IS NULL AS sessions_absent,
    NOT EXISTS(SELECT 1 FROM pg_prepared_xacts WHERE database=current_database()) AS no_prepared,
    NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND usename LIKE 'nukhabapay_%') AS no_other_project_connections`)).rows[0];
  if(!state.iam_absent||!state.sessions_absent||!state.no_prepared||!state.no_other_project_connections)throw reject();
  return Object.freeze({database:target.database,databaseOid:target.database_oid,systemIdentifier:target.system_identifier,
    serverVersionNum:target.server_version_num,history:Object.freeze(history)});
}

export async function inspectPersistentDevelopmentDeployment(env,sourceRoot=root) {
  const config=parsePersistentDevelopmentPreflightEnvironment(env,sourceRoot);
  const {Client}=require('pg');
  const client=new Client({connectionString:config.connectionString,connectionTimeoutMillis:3000,statement_timeout:15000,query_timeout:18000});
  let transaction=false;
  try {
    await client.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');transaction=true;
    const evidence=await verifyPersistentTargetEvidence(client,config);await client.query('COMMIT');transaction=false;
    await verifyPasswordAuthentication(config.connectionString);return evidence;
  } catch {if(transaction)await client.query('ROLLBACK').catch(()=>undefined);throw reject();}
  finally {await client.end().catch(()=>undefined);}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    if(process.argv.length!==3||process.argv[2]!=='--preflight')throw reject();
    const result=await inspectPersistentDevelopmentDeployment(process.env);
    console.info('Persistent development IAM preflight passed:',result.database,result.databaseOid);
  } catch {console.error('Persistent development IAM preflight rejected');process.exitCode=1;}
}
