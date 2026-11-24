import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import net from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {candidate,connection,database,install,owner,pilotIssuer,reader,session,sha,writer} from '../windows-staff-migration.mjs';
import {enrollmentPsql} from '../windows-staff-enrollment-psql.mjs';

test('pgAdmin psql enrollment on a private PostgreSQL 18 cluster', {timeout:240000}, async t=>{
  const base=realpathSync(tmpdir()),dir=mkdtempSync(path.join(base,'nukhbapay-psql-test-')),data=path.join(dir,'data');
  const bin=path.join(process.env.ProgramFiles,'PostgreSQL','18','bin');
  const secret=randomBytes(32).toString('hex'),settings=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.toUpperCase().startsWith('PG')));
  const exec=(name,args,extra={})=>execFileSync(path.join(bin,name+'.exe'),args,{env:settings,stdio:'ignore',windowsHide:true,timeout:90000,...extra});
  let admin,control;
  try {
    const file=path.join(dir,'initial-password');
    writeFileSync(file,secret+'\n',{flag:'wx'});
    // The cluster is discarded after the rehearsal. Avoid synchronizing its initial files to disk.
    try{exec('initdb',['-D',data,'-U','postgres','--locale=C','--encoding=UTF8','--no-sync','-A','scram-sha-256','--pwfile='+file]);}
    finally{rmSync(file);}
    const sock=net.createServer();await new Promise((ok,no)=>sock.once('error',no).listen(0,'127.0.0.1',ok));
    const port=sock.address().port;await new Promise(ok=>sock.close(ok));assert(port>1024 && ![5432,55437].includes(port));
    exec('pg_ctl',['-D',data,'-l',path.join(dir,'server.log'),'-o',`-p ${port} -h 127.0.0.1`,'-w','start']);
    control=await connection(port,secret,'postgres','postgres');
    const physical=(await control.query("SELECT current_setting('data_directory') AS dir, (SELECT system_identifier::text FROM pg_control_system()) AS cluster")).rows[0];
    assert.equal(path.win32.normalize(physical.dir).toLowerCase(),path.win32.normalize(data).toLowerCase());
    for(const role of [owner,reader,writer,'nukhabapay_runtime','nukhabapay_importer'])
      await control.query('CREATE ROLE '+role+' NOINHERIT '+([reader,writer].includes(role)?'LOGIN':'NOLOGIN'));
    await control.query('CREATE DATABASE nukhbapay_staff OWNER nukhabapay_migrator TEMPLATE template0');
    await control.query('REVOKE ALL ON DATABASE nukhbapay_staff FROM PUBLIC');
    await control.query('GRANT CONNECT ON DATABASE nukhbapay_staff TO nukhabapay_identity_reader,nukhabapay_identity_writer');
    await control.query("COMMENT ON DATABASE nukhbapay_staff IS 'NukhbaPay private PG18 restore rehearsal'");
    admin=await connection(port,secret);
    const pin={port,databaseOid:(await admin.query('SELECT oid::text FROM pg_database WHERE datname=current_database()')).rows[0].oid,
      systemIdentifier:physical.cluster,directory:data};
    const options={pin,rehearsal:true,bundle:await candidate(),backupHash:sha('private-empty-fixture'),issuer:pilotIssuer};
    await install(admin,options);
    const profile={name:'Test Person',email:'local@example.invalid',subject:'auth0|test-only',tenantKey:'nukhbapay-staff-dev'};
    const rosterDigest=sha(JSON.stringify([profile.tenantKey,profile.name,profile.email]));
    async function attempt(profileInput,overrides={}) {
      const run=randomUUID().replaceAll('-',''),receipt=path.join(dir,run+'.txt'),file=path.join(dir,run+'.psql');
      writeFileSync(file,enrollmentPsql({...options,run,receipt,rosterDigest,...overrides}));
      const endpoint='\\\\.\\pipe\\nukhbapay-enroll-'+run;
      const pipe=net.createServer(s=>s.end(Buffer.from(JSON.stringify(profileInput)).toString('base64')+'\n'));
      await new Promise((ok,no)=>pipe.once('error',no).listen(endpoint,ok));
      try {
        const child=spawn(path.join(bin,'psql.exe'),['-X','-qAtw','-h','127.0.0.1','-p',String(port),'-U','postgres','-d',database,'-f',file],
          {env:{...settings,PGPASSWORD:secret,PGREQUIREAUTH:'scram-sha-256'},windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:25000});
        let diagnostic='';child.stderr.on('data',b=>diagnostic+=b);child.stdout.resume();
        const code=await new Promise((ok,no)=>child.once('error',no).once('close',ok));
        // These error messages are from the isolated fixture only.
        return {code,diagnostic,tenant:existsSync(receipt)?readFileSync(receipt,'utf8').trim():undefined};
      }finally{await new Promise(ok=>pipe.close(ok));}
    }
    await t.test('session credential must be ready before reading the identity',async()=>{
      const r=await attempt(profile);assert.notEqual(r.code,0);assert.match(r.diagnostic,/Finish session credential setup first/);
    });
    await admin.query("ALTER ROLE "+session+" LOGIN PASSWORD '"+randomBytes(24).toString('hex')+"'");
    await t.test('wrong database pin and unapproved roster fail without creating staff',async()=>{
      assert.notEqual((await attempt(profile,{pin:{...pin,databaseOid:'1'}})).code,0);
      const invalid=await attempt({...profile,name:'Different'});assert.notEqual(invalid.code,0);assert.match(invalid.diagnostic,/roster does not match/);
      assert.equal((await admin.query('SELECT FROM nukhabapay.staff_users')).rowCount,0);
    });
    await t.test('private pipe, atomic membership, zero grants, replay and subject binding',async()=>{
      const first=await attempt(profile);assert.equal(first.code,0,first.diagnostic);assert.match(first.tenant,/^[0-9a-f-]{36}$/);
      const again=await attempt(profile);assert.equal(again.code,0,again.diagnostic);assert.equal(again.tenant,first.tenant);
      const altered=await attempt({...profile,subject:'auth0|someone-else'});assert.notEqual(altered.code,0);assert.equal(altered.tenant,undefined);
      assert((await admin.query(`SELECT (SELECT count(*) FROM nukhabapay.windows_staff_enrollments)=1
        AND (SELECT count(*) FROM nukhabapay.staff_memberships)=1 AND (SELECT count(*) FROM nukhbapay_staff_departments.directory)=6
        AND NOT EXISTS(SELECT FROM nukhabapay.platform_role_grants) AND NOT EXISTS(SELECT FROM nukhabapay.tenant_role_grants) AS ok`)).rows[0].ok);
      const {rows:departments}=await admin.query(`SELECT code FROM nukhbapay_staff_departments.directory
        WHERE tenant_id=$1 ORDER BY code`,[first.tenant]);
      assert.deepEqual(departments.map(row=>row.code),['catalogue','compliance','finance','operations','security','support']);
    });
  }finally{
    await Promise.allSettled([admin?.end(),control?.end()]);
    if(existsSync(path.join(data,'postmaster.pid')))exec('pg_ctl',['-D',data,'-m','fast','-w','stop']);
    if(!existsSync(path.join(data,'postmaster.pid')) && path.dirname(realpathSync(dir))===base && path.basename(dir).startsWith('nukhbapay-psql-test-'))
      rmSync(dir,{recursive:true,maxRetries:4,retryDelay:300});
  }
});
