import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {archiveInfo,candidate,insist,root,sha} from './windows-staff-migration.mjs';

// psql meta-commands parse backslashes. Use normalized Windows paths and
// never interpolate interactive input into commands.
function psqlValue(value) {
  insist(typeof value==='string' && /^[a-zA-Z0-9 _./:\\-]+$/.test(value),'Unexpected psql configuration');
  return "'"+value.replaceAll('\\','/')+"'";
}

export async function prepareSession() {
  const directory=process.env.NUKHBAPAY_REGISTERED_PG_DIRECTORY;
  insist(typeof directory==='string' && path.win32.isAbsolute(directory),'Registered PostgreSQL directory unavailable');
  const backup=archiveInfo(),bundle=await candidate();
  const read=file=>readFileSync(path.join(root,file),'utf8');
  const report=JSON.parse(read('.local/windows-staff-rehearsal.json'));
  insist(report.status==='passed' && report.candidateHash===bundle.candidateHash && report.backupHash===backup.sha256 &&
    report.sourceDatabaseOid===backup.databaseOid && report.sourceCluster===backup.systemIdentifier,'Target or candidate differs from the qualified backup');
  const vars={oid:backup.databaseOid,cluster:backup.systemIdentifier,candidate:bundle.candidateHash,backup:backup.sha256,
    directory,service_directory:directory};
  const status=path.join(root,'.local','windows-staff-session-readback.json');
  const inspect=read('scripts/inspect-windows-staff-database.sql').trim();
  insist(inspect.endsWith(';'),'Unexpected inspection query');
  const script=[
    '\\set ON_ERROR_STOP on','\\set ECHO none','\\pset pager off','\\pset tuples_only on','\\pset format unaligned',
    ...Object.entries(vars).map(([name,value])=>'\\set '+name+' '+psqlValue(value)),
    '\\echo The new session role needs its own password of at least 16 characters. Save it privately.',
    read('scripts/windows-staff-session-login.sql'),
    'BEGIN READ ONLY;','SET LOCAL search_path=pg_catalog;',
    inspect.slice(0,-1),'\\g '+psqlValue(status),'COMMIT;',
    '\\echo Windows staff session login verified.',''
  ].join('\n');
  const file=path.join(root,'.local','windows-staff-session-'+sha(script).slice(0,16)+'.psql');
  if(existsSync(file))insist(sha(readFileSync(file))===sha(script),'Existing psql file differs');
  else writeFileSync(file,script,{flag:'wx'});
  return file;
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try {insist(process.argv.length===2,'Unexpected arguments');console.info(await prepareSession());}
  catch {console.error('Session setup file unavailable. Check the registered target and restore evidence.');process.exitCode=1;}
}
