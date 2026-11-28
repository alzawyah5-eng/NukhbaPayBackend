import {createHash, randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createReadStream, existsSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../packages/database/package.json', import.meta.url));
const {Client} = require('pg');
const catalogueMigrationLock = '8074652183940113';
const sourceName = 'nukhbapay_staff';
const targetName = 'nukhbapay_catalogue';
const staffOwner = 'nukhabapay_migrator';
const catalogueOwner = 'nukhbapay_catalogue_migrator';
const schemas = ['nukhabapay', 'nukhbapay_sessions', 'nukhbapay_staff_departments', 'nukhbapay_staff_workspace'];
const staffRoles = ['nukhabapay_identity_reader', 'nukhabapay_identity_writer', 'nukhabapay_session_backend'];
const catalogueRoles = ['nukhbapay_catalogue_reader', 'nukhbapay_catalogue_runtime'];
const state = join(root, '.local');
const receiptFile = join(state, 'windows-staff-catalogue-cutover.json');
const apply = process.argv[2] === '--apply';
const directory = process.env.NUKHBAPAY_STAFF_MERGE_BACKUP_DIRECTORY;
const setupId = process.env.NUKHBAPAY_STAFF_MERGE_CATALOGUE_SETUP_ID;
const marker = `nukhbapay-catalogue-local:${setupId}`;
const intermediate = new Set();
const ident = value => '"' + value.replaceAll('"', '""') + '"';
const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
const names = values => values.map(literal).join(',');
const qualified = (schema, name) => `${ident(schema)}.${ident(name)}`;
async function hashFile(path) {
  const digest=createHash('sha256');
  for await(const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest('hex');
}
const requireCheck = (condition, step) => { if (!condition) throw new Error(step); };
const local = database => ['--host=127.0.0.1', '--port=5432', '--username=postgres', '--no-password', '--dbname=' + database];
const tableQuery = `SELECT n.nspname AS schema,c.relname AS name,pg_get_userbyid(c.relowner) AS owner,
  c.relrowsecurity AS rls,c.relforcerowsecurity AS forced
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname=ANY($1::text[]) AND c.relkind='r' ORDER BY 1,2`;

function command(bin, name, args, password, readOnly = false) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'].includes(name.toUpperCase())));
  const env = password === undefined ? inherited : {
    ...inherited, PGPASSWORD:password, PGREQUIREAUTH:'scram-sha-256', PGCONNECT_TIMEOUT:'5',
    PGAPPNAME:'nukhbapay-windows-staff-consolidation',
    PGOPTIONS:readOnly ? '-c default_transaction_read_only=on' : '-c search_path=pg_catalog',
  };
  return execFileSync(join(bin,name+'.exe'), args, {env, encoding:'utf8', windowsHide:true,
    stdio:['ignore','pipe','pipe'], timeout:180_000, maxBuffer:2_000_000});
}

async function connection(database, password, readOnly) {
  const client = new Client({host:'127.0.0.1',port:5432,user:'postgres',database,password,
    connectionTimeoutMillis:5000,statement_timeout:30000,application_name:'nukhbapay-windows-staff-consolidation',
    options:`-c search_path=pg_catalog -c default_transaction_read_only=${readOnly?'on':'off'}`});
  try { await client.connect(); return client; }
  catch(error) { await client.end().catch(()=>{}); throw error; }
}

const identitySql = `SELECT current_database() AS name,d.oid::text,pg_get_userbyid(d.datdba) AS owner,
  shobj_description(d.oid,'pg_database') AS marker,(SELECT system_identifier::text FROM pg_control_system()) AS system,
  session_user=current_user AND current_user='postgres' AND system_user='scram-sha-256:postgres'
  AND host(inet_server_addr())='127.0.0.1' AND inet_server_port()=5432
  AND current_setting('server_version_num')::int/10000=18 AND NOT pg_is_in_recovery() AS verified
  FROM pg_database d WHERE datname=current_database()`;

function sameStaffRows(table) {
  return `SELECT count(*)::int AS count, encode(sha256(convert_to(coalesce(string_agg(row_hash,'' ORDER BY row_hash),''),'UTF8')),'hex') AS digest
    FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS row_hash FROM ${table} t) hashed`;
}

function guard(suffix) {
  return `DO $staff_merge$ BEGIN
    ${suffix}
  END $staff_merge$;\n`;
}

function file(name, sql) {
  const filename=join(directory,name);
  writeFileSync(filename,sql,{flag:'wx',encoding:'utf8'});
  intermediate.add(filename);
  return filename;
}

function readManifest() {
  const path=join(state,'windows-staff-inspection.json');
  const inspection=JSON.parse(readFileSync(path,'utf8'));
  requireCheck(inspection.targetVerified===true && /^[1-9]\d{0,9}$/.test(inspection.databaseOid) &&
    /^[1-9]\d{15,19}$/.test(inspection.systemIdentifier),'verified Windows staff inspection');
  return inspection;
}

async function migrate() {
  requireCheck(process.platform==='win32' && process.argv.length===3 && (apply || process.argv[2]==='--rehearse')
    && typeof directory==='string' && /^[a-f0-9]{32}$/.test(setupId??''),'invocation');
  requireCheck(!existsSync(receiptFile),'database is already configured for cutover');
  const pin=readManifest();
  const password=parseEnv(readFileSync(join(root,'.env'),'utf8')).POSTGRES_PASSWORD;
  requireCheck(password,'private Windows PostgreSQL administrator configuration');
  const bin=join(process.env.ProgramFiles,'PostgreSQL','18','bin');
  let source, target;
  let phase='verify the Windows databases';
  try {
    source=await connection(sourceName,password,false);
    target=await connection(targetName,password,true);
    const {rows:[from]}=await source.query(identitySql);
    const {rows:[to]}=await target.query(identitySql);
    requireCheck(from.verified && to.verified && from.name===sourceName && from.oid===pin.databaseOid &&
      from.system===pin.systemIdentifier && from.owner===staffOwner && from.marker==='NukhbaPay Windows staff development v1'
      && to.name===targetName && to.system===from.system && to.owner===catalogueOwner && to.marker===marker,
    'local source and destination binding');

    phase='lock the source and compare the tenant';
    await source.query("BEGIN; SET LOCAL lock_timeout='4s'; SET LOCAL TIME ZONE 'UTC'");
    const {rows:all}=await source.query(tableQuery,[schemas]);
    const tables=all.filter(row=>row.schema!=='nukhabapay'||row.name!=='tenants');
    requireCheck(tables.length>0 && tables.every(row=>row.owner===staffOwner && /^[a-z_]+$/.test(row.schema) &&
      /^[a-z][a-z_0-9]+$/.test(row.name)), 'staff relation inventory');
    await source.query('LOCK TABLE '+all.map(row=>qualified(row.schema,row.name)).join(',')+' IN SHARE MODE NOWAIT');
    if (apply) {
      const {rows:[quiet]}=await source.query(`SELECT
        NOT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND usename=ANY($1::text[]))
        AND NOT EXISTS(SELECT FROM nukhbapay_sessions.sessions s
          WHERE s.expires_ms>(extract(epoch FROM clock_timestamp())*1000)::bigint
          AND NOT EXISTS(SELECT FROM nukhbapay_sessions.events e WHERE e.session_id=s.id AND e.event_name='SESSION_REVOKED'))
        AS safe`,[staffRoles]);
      requireCheck(quiet.safe,'source Staff Portal stopped and no unexpired staff sessions');
    }
    const {rows:destinationTables}=await target.query(tableQuery,[schemas]);
    requireCheck(destinationTables.every(row=>row.schema==='nukhabapay') &&
      tables.every(item=>!destinationTables.some(row=>row.name===item.name && row.schema===item.schema)),
    'unoccupied destination staff tables');
    for(const client of [source,target])await client.query("SET TIME ZONE 'UTC'");
    const tenantSql="SELECT count(*)::int AS count, md5(coalesce(string_agg(jsonb_build_array(id,tenant_key)::text,'' ORDER BY id),'')) AS fingerprint FROM nukhabapay.tenants";
    const {rows:[sourceTenants]}=await source.query(tenantSql);
    const {rows:[destinationTenants]}=await target.query(tenantSql);
    requireCheck(sourceTenants.count===1 && destinationTenants.count===1 &&
      sourceTenants.fingerprint===destinationTenants.fingerprint,'matching staff and catalogue tenant identifiers and keys');
    const {rows:[{snapshot}]}=await source.query('SELECT pg_export_snapshot() AS snapshot');
    requireCheck(/^[0-9A-Fa-f-]+$/.test(snapshot),'source snapshot');

    phase='archive staff and catalogue';
    const sourceArchive=join(directory,'staff-before-consolidation.dump');
    const targetArchive=join(directory,'catalogue-before-consolidation.dump');
    let staffBackupSha256, catalogueBackupSha256;
    const archiveArgs=['--format=custom','--lock-wait-timeout=5000'];
    command(bin,'pg_dump',[...local(sourceName),...archiveArgs,'--snapshot='+snapshot,'--file='+sourceArchive],password,true);
    if(apply) {
      command(bin,'pg_dump',[...local(targetName),...archiveArgs,'--file='+targetArchive],password,true);
      requireCheck(command(bin,'pg_restore',['--list',targetArchive]).includes('TABLE nukhabapay tenants '),'readable pre-cutover catalogue archive');
      [staffBackupSha256,catalogueBackupSha256]=await Promise.all([hashFile(sourceArchive),hashFile(targetArchive)]);
    }
    const toc=command(bin,'pg_restore',['--list',sourceArchive]);
    const omit=[
      / (?:DATABASE|DATABASE PROPERTIES) - /,
      / SCHEMA - (?:nukhabapay|public) /,
      / (?:TABLE|TABLE DATA) nukhabapay tenants /,
      / (?:CONSTRAINT|CHECK CONSTRAINT) nukhabapay tenants /,
      / (?:ACL|COMMENT) (?:- SCHEMA (?:nukhabapay|public)|nukhabapay TABLE tenants) /,
    ];
    requireCheck(toc.includes('TABLE nukhabapay tenants ')&&toc.includes('TABLE DATA nukhabapay tenants '),'source tenant archive');
    const restoreList=file('staff-restore.list',toc.split(/\r?\n/).filter(line=>!omit.some(pattern=>pattern.test(line))).join('\n'));
    const restoreSql=join(directory,'staff-restore.sql');
    requireCheck(!existsSync(restoreSql),'unused private restore path');
    intermediate.add(restoreSql);
    command(bin,'pg_restore',['--file='+restoreSql,'--use-list='+restoreList,'--no-statistics',sourceArchive]);

    phase='fingerprint staff data and security metadata';
    const expected=[];
    for(const row of tables) {
      const name=qualified(row.schema,row.name);
      const {rows:[data]}=await source.query(sameStaffRows(name));
      expected.push({...row,...data});
    }
    const before=file('before-staff-restore.sql',`\\set VERBOSITY sqlstate
BEGIN;
SET LOCAL search_path=pg_catalog;
SET LOCAL lock_timeout='5s';
SET LOCAL TIME ZONE 'UTC';
`+guard(`
      IF NOT EXISTS (SELECT FROM (${identitySql}) d WHERE d.verified AND d.name=${literal(targetName)}
        AND d.oid=${literal(to.oid)} AND d.system=${literal(to.system)} AND d.owner=${literal(catalogueOwner)} AND d.marker=${literal(marker)})
        THEN RAISE EXCEPTION 'Unverified destination'; END IF;
      IF NOT pg_try_advisory_xact_lock(${catalogueMigrationLock}::bigint) THEN RAISE EXCEPTION 'Concurrent catalogue migration'; END IF;
      IF EXISTS (SELECT FROM pg_namespace WHERE nspname IN (${names(schemas.slice(1))}))
        THEN RAISE EXCEPTION 'Staff schemas already exist'; END IF;`)
      + `LOCK TABLE nukhabapay.tenants IN SHARE MODE NOWAIT;\n`
      + guard(`IF NOT EXISTS (SELECT FROM (${tenantSql}) tenant WHERE count=1 AND fingerprint=${literal(sourceTenants.fingerprint)})
        THEN RAISE EXCEPTION 'Tenant changed'; END IF;`));

    phase='verify the transactional merge';
    const after=file('verify-staff-restore.sql',`SET LOCAL search_path=pg_catalog;
SET LOCAL TIME ZONE 'UTC';
GRANT CONNECT ON DATABASE ${ident(targetName)} TO ${staffRoles.join(',')};
GRANT USAGE ON SCHEMA nukhabapay TO ${staffRoles.slice(0,2).join(',')};
GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ${staffRoles.join(',')};
`+guard(expected.map(row=>{
      const name=qualified(row.schema,row.name);
      return `IF NOT EXISTS (SELECT FROM (${sameStaffRows(name)}) actual WHERE count=${row.count} AND digest=${literal(row.digest)})
        OR NOT EXISTS(SELECT FROM pg_class c WHERE c.oid=${literal(name)}::regclass AND pg_get_userbyid(c.relowner)=${literal(staffOwner)}
          AND c.relrowsecurity=${row.rls} AND c.relforcerowsecurity=${row.forced})
        THEN RAISE EXCEPTION 'Restored staff rows or metadata differ'; END IF;`;
    }).join('\n')+`
      IF EXISTS(SELECT FROM pg_class c CROSS JOIN unnest(ARRAY[${names(catalogueRoles)}]) AS r(role)
        WHERE c.relkind='r' AND c.relowner=${literal(staffOwner)}::regrole
        AND (has_table_privilege(r.role,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR has_any_column_privilege(r.role,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
        THEN RAISE EXCEPTION 'Catalogue privilege crosses into staff data'; END IF;
      IF EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        CROSS JOIN unnest(ARRAY[${names(staffRoles)}]) AS r(role)
        WHERE c.relkind='r' AND n.nspname='nukhabapay' AND c.relowner=${literal(catalogueOwner)}::regrole
        AND (has_table_privilege(r.role,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR has_any_column_privilege(r.role,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
        THEN RAISE EXCEPTION 'Staff database privilege crosses into catalogue data'; END IF;`)
      + (apply?'COMMIT;\n':'ROLLBACK;\n'));
    command(bin,'psql',[...local(targetName),'-X','-q','-v','ON_ERROR_STOP=1','-f',before,'-f',restoreSql,'-f',after],password);
    phase=apply?'record the verified launcher binding':'verify rollback';
    const result=await target.query("SELECT to_regclass('nukhabapay.staff_users') IS NOT NULL AS migrated");
    requireCheck(result.rows[0]?.migrated===apply,'expected merge disposition');
    const report={version:1,status:'verified',sourceOid:from.oid,catalogueOid:to.oid,systemIdentifier:to.system,
      catalogueSetupId:setupId,staffTables:tables.length,completedAt:new Date().toISOString()};
    if(apply) {
      report.staffBackupSha256=staffBackupSha256;
      report.catalogueBackupSha256=catalogueBackupSha256;
      const temp=join(state,'windows-staff-catalogue-cutover-'+randomUUID()+'.tmp');
      writeFileSync(temp,JSON.stringify(report)+'\n',{flag:'wx'});
      renameSync(temp,receiptFile);
    }
    console.log(`${apply?'Committed':'Rehearsed and rolled back'} the staff consolidation, with ${tables.length} staff tables verified.`);
  }catch(error){
    const sqlstate=/^[A-Z0-9]{5}$/.test(error.code??'')?error.code:String(error.stderr??'').match(/\bERROR:\s+([A-Z0-9]{5})\b/)?.[1];
    console.error(`Staff consolidation stopped at ${phase}${sqlstate?' ('+sqlstate+')':''}.`);
    process.exitCode=1;
  }finally{
    await Promise.allSettled([source?.end(),target?.end()]);
    for (const filename of intermediate) {
      try { rmSync(filename,{force:true}); }
      catch { console.warn('An intermediate restore file remains in the private backup directory.'); }
    }
  }
}

await migrate().catch(()=>{console.error('Staff consolidation inputs were unavailable or unverified.');process.exitCode=1;});
