import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const {Client}=createRequire(path.join(root,'packages/database/package.json'))('pg');
const env={...process.env};
const secrets=[];
for(const [name,role,database] of [
  ['DB_MIGRATION_URL','nukhabapay_migrator','nukhabapay_dev'],['DB_RUNTIME_URL','nukhabapay_runtime','nukhabapay_dev'],
  ['DB_IMPORT_URL','nukhabapay_importer','nukhabapay_dev'],['DB_IDENTITY_READER_URL','nukhabapay_identity_reader','nukhabapay_dev'],
  ['DB_IDENTITY_WRITER_URL','nukhabapay_identity_writer','nukhabapay_dev'],['DB_TEST_ADMIN_URL','postgres','postgres'],
]) {
  const url=new URL('postgresql://127.0.0.1:5432');url.username=role;url.password=randomBytes(32).toString('hex');url.pathname='/'+database;
  env[name]=url.href;secrets.push(url.href,url.password);
}
Object.assign(env,{DB_RUNTIME_ROLE:'nukhabapay_runtime',DB_IMPORT_ROLE:'nukhabapay_importer',
  DB_IDENTITY_READER_ROLE:'nukhabapay_identity_reader',DB_IDENTITY_WRITER_ROLE:'nukhabapay_identity_writer'});
const postgresBin=[process.env.NUKHBAPAY_PG_TEST_BIN,path.join(process.env.USERPROFILE??'','PostgreSQL','pgsql','bin'),'C:\\Program Files\\PostgreSQL\\17\\bin']
  .find(candidate=>candidate&&existsSync(path.join(candidate,'pg_dump.exe'))&&existsSync(path.join(candidate,'pg_restore.exe')));
if(!postgresBin)throw new Error('Explicit PostgreSQL 17 test binary directory unavailable');
env.NUKHBAPAY_PG_TEST_BIN=postgresBin;
function redacted(value) {
  let text=String(value??'');for(const secret of secrets)text=text.replaceAll(secret,'[redacted]');
  return text.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi,'[redacted-database-url]');
}
async function evidence() {
  const client=new Client({connectionString:env.DB_TEST_ADMIN_URL,connectionTimeoutMillis:3000});await client.connect();
  const development=new Client({connectionString:env.DB_MIGRATION_URL,connectionTimeoutMillis:3000});await development.connect();
  try {
    const databases=(await client.query("SELECT datname FROM pg_database WHERE datname~'^nukhabapay_b3b[23]_[0-9a-f]{32}$' ORDER BY datname")).rows.map(row=>row.datname);
    const history=(await development.query('SELECT name FROM nukhabapay.schema_migrations ORDER BY id')).rows.map(row=>row.name);
    return {databases,history};
  } finally {await development.end();await client.end();}
}

let before,after,result;
try {
  before=await evidence();
  if(process.argv[2]==='--cleanup-interrupted') {
    const client=new Client({connectionString:env.DB_TEST_ADMIN_URL,connectionTimeoutMillis:3000});await client.connect();
    try {
      for(const database of before.databases) {
        if(!/^nukhabapay_b3b[23]_[0-9a-f]{32}$/.test(database))throw new Error('Unsafe disposable cleanup target');
        await client.query(`DROP DATABASE "${database}"`);
      }
    } finally {await client.end();}
    console.log(`Removed ${before.databases.length} verified interrupted disposable database(s).`);
    process.exit(0);
  }
  const command=process.argv.length===2?'pnpm.cmd db:test:combined':
    process.argv[2]==='--database-regression'?'pnpm.cmd db:test':undefined;
  if(!command)throw new Error('Unsupported disposable readiness option');
  result=spawnSync(process.env.ComSpec||'cmd.exe',['/d','/s','/c',command],{
    cwd:root,env,encoding:'utf8',windowsHide:true,timeout:900000,maxBuffer:12*1024*1024,
  });
  after=await evidence();
  console.log(redacted((result.stdout??'')+(result.stderr??'')));
  if(result.status!==0||result.error)throw new Error('Disposable readiness regression failed');
  if(JSON.stringify(before.databases)!==JSON.stringify(after.databases))throw new Error('Disposable database cleanup mismatch');
  if(JSON.stringify(before.history)!==JSON.stringify(['001_catalog','002_import_role_privileges','003_import_role_read_access'])||
    JSON.stringify(after.history)!==JSON.stringify(before.history))throw new Error('Development migration history changed');
  console.log('Disposable migration/session regression passed; generated database inventory restored.');
} catch(error) {
  console.error(redacted(error?.message??'Disposable readiness regression failed'));
  process.exitCode=1;
}
