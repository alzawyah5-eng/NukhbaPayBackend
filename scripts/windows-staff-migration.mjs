import {createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {createRequire,stripTypeScriptTypes} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifiedMigrationSources} from './rehearse-reviewed-migrations.mjs';
import {guardedBlock,installationSql,installedChecks,targetChecks} from './windows-staff-install-sql.mjs';

export const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(path.join(root,'packages/database/package.json'));
const {PG_MIGRATE_LOCK_ID}=require('node-pg-migrate');
export const {Client}=require('pg');
export const database='nukhbapay_staff';
export const owner='nukhabapay_migrator';
export const session='nukhabapay_session_backend';
export const reader='nukhabapay_identity_reader';
export const writer='nukhabapay_identity_writer';
export const liveMarker='NukhbaPay Windows staff development v1';
export const rehearsalMarker='NukhbaPay private PG18 restore rehearsal';
const frozenFoundation='packages/database/migrations/004_staff_identity_foundation.ts';
const nativeFiles=['packages/database/windows-staff/001_foundation.sql','packages/database/windows-staff/001_portal.sql','scripts/windows-staff-empty.sql'];
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const digest=/^[0-9a-f]{64}$/;
export const pilotIssuer='https://dev-whz1tr4aj20nxswq.us.auth0.com/';
export function insist(condition,message){if(!condition)throw new Error(message);}
export function archiveInfo() {
  const backup=JSON.parse(readFileSync(path.join(root,'.local/windows-staff-backup.json'),'utf8'));
  insist(/^[a-f0-9]{32}$/.test(backup.run) && digest.test(backup.sha256),'Invalid backup record');
  const file=path.join(process.env.LOCALAPPDATA,'Nukhbapay','staff-db-backups',backup.run,'staff-before-schema.dump');
  insist(sha(readFileSync(file))===backup.sha256,'Backup archive digest mismatch');
  return {...backup,file};
}
export async function candidate() {
  const {snapshot}=verifiedMigrationSources(root);
  const pins=JSON.parse(readFileSync(path.join(root,'packages/database/windows-staff/manifest.json'),'utf8'));
  const sources=nativeFiles.map(file=>{
    const bytes=readFileSync(path.join(root,file));insist(sha(bytes)===pins[file],'Native migration source integrity rejected');
    return bytes.toString('utf8');
  });
  for(const [key,value] of Object.entries({DB_IDENTITY_READER_ROLE:reader,DB_IDENTITY_WRITER_ROLE:writer,DB_RUNTIME_ROLE:'nukhabapay_runtime',DB_IMPORT_ROLE:'nukhabapay_importer'}))
    insist((process.env[key]??value)===value,'Unexpected foundation role override');
  const foundation=snapshot.get(frozenFoundation);
  const module=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(foundation.toString('utf8'))).toString('base64'));
  const ddl=[]; module.up({sql:text=>ddl.push(text)});
  insist(ddl.length===1,'Canonical foundation interface changed');
  const bound=[frozenFoundation,...nativeFiles,'scripts/windows-staff-migration.mjs','scripts/test/windows-staff-migration-rehearsal.mjs',
    'scripts/start-windows-staff-portal.mjs','scripts/start-windows-staff-portal.ps1','scripts/apply-windows-staff-schema.ps1',
    'scripts/windows-staff-session-login.sql','scripts/enroll-windows-staff.mjs','scripts/windows-staff-install-sql.mjs'];
  const candidateHash=sha(JSON.stringify(bound.map(file=>[file,sha(readFileSync(path.join(root,file)))])));
  return {foundation:sources[0],iam:ddl[0],portal:sources[1],empty:sources[2],candidateHash};
}
export async function connection(port,password,user='postgres',db=database) {
  const client=new Client({host:'127.0.0.1',port,user,database:db,password,connectionTimeoutMillis:5000,
    query_timeout:30000,statement_timeout:25000,application_name:'nukhbapay-windows-staff-schema',options:'-c search_path=pg_catalog'});
  try {await client.connect();return client;}catch(error){await client.end().catch(()=>{});throw error;}
}
export async function assertTarget(client,pin,rehearsal) {
  await client.query(guardedBlock(targetChecks(pin,rehearsal)));
}
export async function verifyInstalled(client,bundle,backupHash,issuer) {
  await client.query(guardedBlock(installedChecks(bundle.candidateHash,backupHash,issuer)));
}
export const renderInstallation=options=>installationSql(options,PG_MIGRATE_LOCK_ID);
export async function install(client,options) {
  await client.query('BEGIN');
  try {
    await client.query(renderInstallation(options));
    const result=await client.query("SELECT current_setting('nukhbapay.windows_install_result') AS status");
    await client.query(options.rollback?'ROLLBACK':'COMMIT');
    return options.rollback?'rolled-back':result.rows[0].status;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
}
async function apply(preparePgAdmin) {
  const backup=archiveInfo(),bundle=await candidate();
  const report=JSON.parse(readFileSync(path.join(root,'.local/windows-staff-rehearsal.json'),'utf8'));
  insist(report.status==='passed' && report.candidateHash===bundle.candidateHash && report.backupHash===backup.sha256 &&
    report.sourceDatabaseOid===backup.databaseOid && report.sourceCluster===backup.systemIdentifier,'Qualified restore for this candidate and target required');
  const pin={databaseOid:backup.databaseOid,systemIdentifier:backup.systemIdentifier,port:5432,directory:process.env.NUKHBAPAY_REGISTERED_PG_DIRECTORY};
  insist(typeof pin.directory==='string' && path.win32.isAbsolute(pin.directory),'Missing registered Windows target');
  const options={pin,bundle,backupHash:backup.sha256,issuer:pilotIssuer};
  if(preparePgAdmin) {
    const sql='-- Run this whole file in the verified pgAdmin Query Tool with Auto commit enabled.\n'+renderInstallation(options)+
      "\nSELECT 'Windows staff schema verified' AS result,version FROM nukhabapay.windows_staff_schema_history WHERE version=1;\n";
    const file=path.join(root,'.local','install-windows-staff-'+sha(sql).slice(0,16)+'.sql');
    if(existsSync(file))insist(sha(readFileSync(file))===sha(sql),'Existing pgAdmin file differs');
    else writeFileSync(file,sql,{flag:'wx'});
    console.info(file);
    return;
  }
  const client=await connection(5432,process.env.PGPASSWORD);
  try {console.info(await install(client,options));}
  finally {await client.end();}
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {insist(process.argv.length===3 && ['--apply-qualified','--prepare-pgadmin'].includes(process.argv[2]),'Unexpected command');await apply(process.argv[2]==='--prepare-pgadmin');}
  catch(error){console.error('Windows staff migration stopped.',error.code && /^[A-Z0-9]{5}$/.test(error.code)?error.code:'Check target, candidate and backup evidence.');process.exitCode=1;}
}
