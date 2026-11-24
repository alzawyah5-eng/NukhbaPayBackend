import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdtempSync,mkdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import path from 'node:path';
import {archiveInfo,candidate,connection,database,insist,install,owner,pilotIssuer,reader,rehearsalMarker,renderInstallation,root,session,writer} from '../windows-staff-migration.mjs';
import {workspaceReady,workspaceWriterReady} from '../start-windows-staff-portal.mjs';
import {enrollFirstStaff} from '../enroll-windows-staff.mjs';
import {sha} from '../windows-staff-migration.mjs';

// Application-grade checks run exclusively on a new local cluster restored from the pinned empty backup.
const bin=path.join(process.env.ProgramFiles,'PostgreSQL','18','bin');
const parent=realpathSync(tmpdir()),work=mkdtempSync(path.join(parent,'nukhbapay-staff-rehearsal-')),data=path.join(work,'pgdata');
const credentials=Object.fromEntries(['postgres',reader,writer,session].map(role=>[role,randomBytes(32).toString('hex')]));
const checks=[];
let started=false,stage='source verification',admin,clients=[];
function run(name,args,opts={}) {
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.toUpperCase().startsWith('PG')));
  try {return execFileSync(path.join(bin,name+'.exe'),args,{windowsHide:true,encoding:'utf8',env:{...env,...opts.env},input:opts.input,stdio:name==='pg_ctl'?'ignore':['pipe','pipe','pipe'],timeout:90000});}
  catch(error){
    const diagnostic=name==='initdb'?String(error.stderr??'').split(/\r?\n/).find(line=>line.startsWith('initdb: error:')):'';
    throw new Error(name+' stopped with status '+error.status+(diagnostic?' ('+diagnostic+')':''));
  }
}
async function connect(port,role,db) {
  const client=await connection(port,credentials[role],role,db);clients.push(client);return client;
}
async function check(name,fn){stage=name;await fn();checks.push(name);}
async function denied(client,sql,code,params=[]) {
  try {await client.query(sql,params);}catch(error){if(error.code===code)return;throw error;}
  throw new Error('Expected database denial');
}
async function rehearsal() {
  const bundle=await candidate(),backup=archiveInfo();
  const socket=createServer();await new Promise((ok,no)=>socket.once('error',no).listen(0,'127.0.0.1',ok));
  const port=socket.address().port;await new Promise(ok=>socket.close(ok));
  insist(port>1024 && ![5432,55437].includes(port),'Unexpected port');
  stage='initialize PostgreSQL 18';
  const pwfile=path.join(work,'initial-password');
  writeFileSync(pwfile,credentials.postgres+'\n',{flag:'wx',mode:0o600});
  try {run('initdb',['-D',data,'-U','postgres','--encoding=UTF8','--locale=C','-A','scram-sha-256','--pwfile='+pwfile]);}
  finally {rmSync(pwfile);}
  stage='start private cluster';
  run('pg_ctl',['-D',data,'-l',path.join(work,'server.log'),'-o',`-p ${port} -h 127.0.0.1 -c log_statement=none`,'-w','start']);started=true;
  const control=await connect(port,'postgres','postgres');
  const physical=(await control.query("SELECT current_setting('data_directory') AS directory,(SELECT system_identifier::text FROM pg_control_system()) AS cluster")).rows[0];
  insist(path.win32.normalize(physical.directory).toLowerCase()===path.win32.normalize(data).toLowerCase() && physical.cluster!==backup.systemIdentifier,'Rehearsal instance mismatch');
  stage='provision fixture roles';
  for(const role of [owner,'nukhabapay_runtime','nukhabapay_importer',reader,writer]) {
    const login=credentials[role]?"LOGIN PASSWORD '"+credentials[role]+"'":'NOLOGIN';
    await control.query('CREATE ROLE '+role+' NOINHERIT '+login);
  }
  await control.query('CREATE DATABASE nukhbapay_staff OWNER nukhabapay_migrator TEMPLATE template0');
  await control.query('REVOKE ALL ON DATABASE nukhbapay_staff FROM PUBLIC');
  await control.query('GRANT CONNECT ON DATABASE nukhbapay_staff TO nukhabapay_identity_reader,nukhabapay_identity_writer');
  await control.query("COMMENT ON DATABASE nukhbapay_staff IS 'NukhbaPay private PG18 restore rehearsal'");
  await check('restore native backup',async()=>{
    run('pg_restore',['--exit-on-error','--single-transaction','-w','-h','127.0.0.1','-p',String(port),'-U','postgres','-d',database,backup.file],
      {env:{PGPASSWORD:credentials.postgres,PGHOSTADDR:'127.0.0.1',PGREQUIREAUTH:'scram-sha-256'}});
  });
  admin=await connect(port,'postgres',database);
  const pin={port,directory:data,systemIdentifier:physical.cluster,databaseOid:(await admin.query('SELECT oid::text FROM pg_database WHERE datname=current_database()')).rows[0].oid};
  const options={pin,rehearsal:true,bundle,backupHash:backup.sha256,issuer:pilotIssuer};
  await check('wrong target rejected',async()=>{
    let rejected=false;try{await install(admin,{...options,pin:{...pin,databaseOid:'1'}});}catch{rejected=true;}insist(rejected,'Target was accepted');
  });
  await check('transactional schema and role rollback',async()=>{
    insist(await install(admin,{...options,rollback:true})==='rolled-back','Wrong outcome');
    insist((await admin.query("SELECT to_regnamespace('nukhabapay') IS NULL AND to_regrole('nukhabapay_session_backend') IS NULL AS clean")).rows[0].clean,'Rollback incomplete');
  });
  await check('schema installation and replay',async()=>{
    const sql=renderInstallation(options);
    const tampered=sql.replace('CREATE TABLE nukhabapay.tenants (','CREATE TABLE nukhabapay.tenants  (');
    insist(tampered!==sql,'Expected DDL coverage');
    let rejected=false;
    try {await admin.query(tampered);}catch(error){rejected=error.message==='Reviewed DDL integrity mismatch';}
    insist(rejected,'Edited SQL was accepted');
    insist((await admin.query("SELECT to_regrole('nukhabapay_session_backend') IS NULL AS clean")).rows[0].clean,'Incomplete rollback');
    await admin.query(sql);
    insist(await install(admin,options)==='previously-installed','Replay failed');
  });
  // Random credentials and fixture rows exist only in this temporary cluster.
  await admin.query("ALTER ROLE nukhabapay_session_backend LOGIN PASSWORD '"+credentials[session]+"'");
  const r=await connect(port,reader,database),w=await connect(port,writer,database),s=await connect(port,session,database);
  await check('restricted reader and writer projections',async()=>{
    insist(await workspaceReady(r) && await workspaceWriterReady(w),'Staff portal ACL mismatch');
    await denied(r,'DELETE FROM nukhabapay.staff_users WHERE false','42501');
    await denied(w,'SELECT * FROM nukhabapay.staff_identities WHERE false','42501');
  });
  await check('exact session column privileges and invoker functions',async()=>{
    const {rows:[p]}=await s.query(`SELECT count(*)=27 AND bool_and(has_column_privilege(current_user,c.oid,a.attnum,'SELECT')
      AND NOT has_column_privilege(current_user,c.oid,a.attnum,'UPDATE,REFERENCES')
      AND has_column_privilege(current_user,c.oid,a.attnum,'INSERT') =
        (a.attname NOT IN ('assurance','execution') AND NOT(c.relname='sessions' AND a.attname='scope_key'))
      AND NOT has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')) AS exact
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      WHERE c.relnamespace='nukhbapay_sessions'::regnamespace AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped`);
    insist(p.exact,'Session grants differ');
    insist((await s.query(`SELECT NOT EXISTS(SELECT FROM pg_proc p WHERE p.pronamespace='nukhbapay_sessions'::regnamespace
      AND (p.prosecdef OR has_function_privilege(current_user,p.oid,'EXECUTE'))) AS safe`)).rows[0].safe,'Session function permissions differ');
  });
  const other=randomUUID(),subject='auth0|qualified-test-subject',id=randomUUID(),operation=randomUUID();
  const profile={name:'Qualification',email:'staff@example.invalid',subject,tenantKey:'nukhbapay-staff-dev'};
  const approved={...options,profile,rosterDigest:sha(JSON.stringify([profile.tenantKey,profile.name,profile.email]))};
  let tenant,person;
  await check('first staff enrollment, idempotency and identity binding',async()=>{
    const first=await enrollFirstStaff(admin,approved),again=await enrollFirstStaff(admin,approved);
    tenant=first.tenantId;person=first.staffId;insist(again.tenantId===tenant && again.staffId===person,'Duplicate enrollment');
    let rejected=false;try{await enrollFirstStaff(admin,{...approved,profile:{...profile,subject:'auth0|other'}});}catch{rejected=true;}
    insist(rejected,'Unexpected identity replacement');
    const {rows:[counts]}=await admin.query(`SELECT (SELECT count(*) FROM nukhbapay_staff_departments.directory)=6
      AND NOT EXISTS(SELECT FROM nukhabapay.tenant_role_grants) AND NOT EXISTS(SELECT FROM nukhabapay.platform_role_grants)
      AND (SELECT count(*) FROM nukhabapay.windows_staff_enrollments)=1 AS ok`);
    insist(counts.ok,'Unexpected initial grant or department');
    await denied(admin,'UPDATE nukhabapay.windows_staff_enrollments SET enrolled_at=now()','23000');
  });
  await admin.query("INSERT INTO nukhabapay.tenants(id,tenant_key) VALUES($1,'other')",[other]);
  await check('tenant RLS and immutable audit',async()=>{
    await r.query("SELECT set_config('nukhabapay.tenant_id',$1,false)",[other]);
    insist((await r.query('SELECT id FROM nukhabapay.staff_memberships')).rowCount===0,'Tenant isolation failed');
    await r.query("SELECT set_config('nukhabapay.tenant_id',$1,false)",[tenant]);
    insist((await r.query('SELECT id FROM nukhabapay.staff_memberships')).rowCount===1,'Membership unavailable');
    await w.query("SELECT set_config('nukhabapay.tenant_id',$1,false)",[tenant]);
    await w.query("INSERT INTO nukhabapay.security_audit_events(occurred_at,actor_staff_id,tenant_id,action,outcome,target_type,reason_code) VALUES(now(),$1,$2,'AUTHORIZATION_DECISION','SUCCESS','AUTHORIZATION','NONE')",[person,tenant]);
    await denied(w,'DELETE FROM nukhabapay.security_audit_events','42501');
    await denied(admin,'UPDATE nukhabapay.security_audit_events SET occurred_at=now()','23000');
  });
  const insertSession=`INSERT INTO nukhbapay_sessions.sessions
    (id,token_hash,actor_staff_id,issuer,subject,tenant_id,authz_version,membership_version,authority_digest,
     identity_expires_ms,created_ms,expires_ms,idle_ms,creation_operation_id) VALUES($1,$2,$3,$4,$5,$6,1,1,$2,5000,1000,4000,500,$7)`;
  const values=[id,randomBytes(32).toString('hex'),person,pilotIssuer,subject,tenant,operation];
  await s.query("SELECT set_config('nukhbapay_sessions.staff_id',$1,false),set_config('nukhbapay_sessions.scope',$2,false)",[person,tenant]);
  await check('session issuer, membership and atomic event',async()=>{
    await denied(s,insertSession,'23514',values.map((v,i)=>i===3?'https://different.example.invalid/':v));
    await denied(s,insertSession,'23503',values.map((v,i)=>i===4?'unbound-subject':v));
    await denied(s,insertSession,'23514',values);
    await s.query('BEGIN');await s.query(insertSession,values);
    await s.query("INSERT INTO nukhbapay_sessions.events(id,operation_id,session_id,actor_staff_id,scope_key,event_name,occurred_ms,reason) VALUES($1,$2,$3,$4,$5,'SESSION_CREATED',1000,'AUTHENTICATION')",[randomUUID(),operation,id,person,tenant]);
    await s.query('COMMIT');
    insist((await s.query('SELECT id FROM nukhbapay_sessions.sessions')).rowCount===1,'Audited session missing');
    await denied(s,'DELETE FROM nukhbapay_sessions.events','42501');
    await denied(s,'SELECT id FROM nukhabapay.staff_users','42501');
    await s.query("SELECT set_config('nukhbapay_sessions.scope',$1,false)",[other]);
    insist((await s.query('SELECT id FROM nukhbapay_sessions.sessions')).rowCount===0,'Session crossed tenant');
  });
  return {status:'passed',candidateHash:bundle.candidateHash,backupHash:backup.sha256,sourceDatabaseOid:backup.databaseOid,
    sourceCluster:backup.systemIdentifier,postgresMajor:18,checks,completedAt:new Date().toISOString()};
}
let report;
try {report=await rehearsal();}
catch(error){console.error('Rehearsal stopped at '+stage+' ('+(error.code??error.message)+').');process.exitCode=1;}
finally {
  await Promise.allSettled(clients.map(c=>c.end()));
  const pidFile=path.join(data,'postmaster.pid');
  if(started || existsSync(pidFile))run('pg_ctl',['-D',data,'-m','fast','-w','stop']);
  if(!existsSync(pidFile) && path.dirname(realpathSync(work))===parent && path.basename(work).startsWith('nukhbapay-staff-rehearsal-'))
    rmSync(work,{recursive:true,maxRetries:4,retryDelay:300});
}
if(report){
  mkdirSync(path.join(root,'.local'),{recursive:true});
  writeFileSync(path.join(root,'.local/windows-staff-rehearsal.json'),JSON.stringify(report,null,2));
  console.info('Restored PostgreSQL 18 rehearsal passed '+checks.length+' checks.');
}
