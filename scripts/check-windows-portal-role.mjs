import {readFileSync} from 'node:fs';
import {Client} from './windows-staff-migration.mjs';
import {verifyWindowsStaffConnection,windowsStaffTarget} from '../packages/database/dist/database/src/windows-staff-target.js';

const roles=new Map([['nukhabapay_identity_reader','DB_IDENTITY_READER_URL'],['nukhabapay_identity_writer','DB_IDENTITY_WRITER_URL'],
  ['nukhabapay_session_backend','DB_STAFF_SESSION_URL']]);
const role=process.argv[2];
let client,stage='configuration';
try {
  if(!roles.has(role))throw new Error();
  const evidence=JSON.parse(readFileSync(new URL('../.local/windows-staff-inspection.json',import.meta.url),'utf8'));
  if(evidence.targetVerified!==true)throw new Error();
  const target=windowsStaffTarget(evidence.databaseOid,evidence.systemIdentifier);
  const url=new URL(process.env[roles.get(role)]);
  if(url.origin!=='null' || url.protocol!=='postgresql:' || url.hostname!=='127.0.0.1' || url.port!=='5432' ||
    url.pathname!=='/nukhbapay_staff' || url.username!==role || url.search || url.hash)throw new Error();
  client=new Client({host:'127.0.0.1',port:5432,database:'nukhbapay_staff',user:role,password:decodeURIComponent(url.password),
    connectionTimeoutMillis:5000,statement_timeout:4000,application_name:'staff-portal-read-only-check',
    options:'-c default_transaction_read_only=on -c search_path=pg_catalog'});
  stage='connection';
  await client.connect();
  stage='target-or-role-guard';
  await verifyWindowsStaffConnection(client,target,role);
  console.log('verified');
}catch(error){
  const reason=error.code==='28P01'?'password-rejected':error.code==='42501'?'permission-denied':
    error.code==='ECONNREFUSED'?'connection-refused':stage;
  console.log(reason);process.exitCode=1;
}finally{if(client)await client.end().catch(()=>{});}
