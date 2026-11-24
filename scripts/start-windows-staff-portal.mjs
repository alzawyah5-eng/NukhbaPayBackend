import {readFileSync} from 'node:fs';
import {isAbsolute, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createStaffPortal} from '../apps/admin-web/dist/portal.js';
import {loadBrowserAssets} from '../apps/admin-web/dist/browser-assets.js';
import {prepareStaffLoginIntegration} from '../apps/admin-web/dist/staff-login-integration.js';
import {readPendingAuth0Configuration, STAFF_PORTAL_PORT} from '../apps/admin-web/dist/auth0-configuration.js';
import {createAdministrationAuthority, createStaffAdministration, StaffWorkspaceService} from '../packages/application/dist/application/src/index.js';
import {parseIdentityRuntimeConfiguration, createWindowsStaffIdentityRuntime, IdentityRuntimeUnavailableError} from '../packages/database/dist/database/src/identity-runtime.js';
import {createIdentityReaderPool,createIdentityWriterPool,createStaffAdministrationReader,createStaffWorkspaceStore} from '../packages/database/dist/database/src/index.js';
import {createWindowsStaffSessionStore} from '../packages/database/dist/database/src/staff-session-store.js';
import {verifyWindowsStaffConnection,windowsSessionRole,windowsStaffDatabase,windowsStaffTarget} from '../packages/database/dist/database/src/windows-staff-target.js';

const unavailable=()=>new Error('Windows staff portal configuration unavailable');
class EnrollmentMismatch extends Error {
  constructor(){super('No active staff identity and membership matched the supplied issuer, User ID and selected tenant.');}
}

function readWindowsStorageSettings(env) {
  try {
    if(env.NODE_ENV!=='development' || env.NUKHBAPAY_ENVIRONMENT!=='development' || env.NUKHBAPAY_ENV!=='local' ||
       env.NUKHBAPAY_STAFF_SESSION_MODE!=='windows-staff-development' || env.NODE_TLS_REJECT_UNAUTHORIZED==='0' ||
       env.DB_STAFF_SESSION_ROLE!==windowsSessionRole)throw unavailable();
    const identity=parseIdentityRuntimeConfiguration(env);
    const target=windowsStaffTarget(env.DB_STAFF_SESSION_EXPECTED_DATABASE_OID,env.DB_STAFF_SESSION_EXPECTED_SYSTEM_IDENTIFIER);
    const sessionUrl=new URL(env.DB_STAFF_SESSION_URL);
    if(identity.host!=='127.0.0.1' || identity.port!==5432 || identity.database!==windowsStaffDatabase ||
       !['postgres:','postgresql:'].includes(sessionUrl.protocol) || sessionUrl.hostname!==identity.host ||
       (sessionUrl.port || '5432')!=='5432' || sessionUrl.username!==windowsSessionRole ||
       sessionUrl.pathname!=='/'+windowsStaffDatabase || sessionUrl.search || sessionUrl.hash)throw unavailable();
    const passwords=[identity.readerUrl,identity.writerUrl,sessionUrl.href].map(url=>decodeURIComponent(new URL(url).password));
    if(passwords.some(password=>password.length<16 || password.length>1024) || new Set(passwords).size!==3)throw unavailable();
    const session=Object.freeze(Object.defineProperty({expectedDatabase:windowsStaffDatabase,expectedRole:windowsSessionRole},
      'connectionString',{value:sessionUrl.href}));
    return Object.freeze({identity,session,target});
  } catch {throw unavailable();}
}

export function readWindowsStaffSettings(env) {
  try {return Object.freeze({...readWindowsStorageSettings(env),auth:readPendingAuth0Configuration(env)});}
  catch {throw unavailable();}
}

// Every relation used by department navigation and workspace views must be tenant scoped.
export async function workspaceReady(reader) {
  const result=await reader.query(`SELECT count(*)=6 AND bool_and(c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity
    AND pg_get_userbyid(c.relowner)='nukhabapay_migrator' AND has_table_privilege(current_user,c.oid,'SELECT')
    AND NOT has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    AND NOT has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES')) AS ready
    FROM pg_class c WHERE c.oid IN ('nukhbapay_staff_workspace.departments'::regclass,'nukhbapay_staff_workspace.invitations'::regclass,
    'nukhbapay_staff_workspace.preferences'::regclass,'nukhbapay_staff_workspace.activity'::regclass,
    'nukhbapay_staff_departments.directory'::regclass,'nukhbapay_staff_departments.positions'::regclass)`);
  if(result.rows[0]?.ready!==true)return false;
  await reader.query('SELECT display_name,work_email FROM nukhbapay_staff_workspace.preferences WHERE false');
  await reader.query('SELECT id,tenant_id,occurred_at,action,outcome,actor_staff_id FROM nukhabapay.security_audit_events WHERE false');
  const grants=await reader.query(`WITH approved(table_name,columns) AS (VALUES
    ('staff_users',ARRAY['id','status','authz_version','tokens_valid_after']),
    ('staff_identities',ARRAY['staff_id','issuer','subject','status']),
    ('staff_memberships',ARRAY['id','staff_id','tenant_id','status','version']),
    ('tenant_role_grants',ARRAY['id','membership_id','tenant_id','role_code','scope','granted_at','expires_at','revoked_at']),
    ('platform_role_grants',ARRAY['staff_id','role_code','scope','granted_at','expires_at','revoked_at']),
    ('security_audit_events',ARRAY['id','tenant_id','occurred_at','action','outcome','actor_staff_id','request_id'])
  ) SELECT NOT EXISTS (
    SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL (SELECT NULL::text AS col,c.relacl AS grants UNION ALL
      SELECT a.attname::text,a.attacl FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) g
    CROSS JOIN LATERAL aclexplode(g.grants) acl
    WHERE c.relkind IN ('r','p','v','m','f','S') AND left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
      AND acl.grantee IN (0,current_user::regrole) AND (acl.grantee=0 OR acl.is_grantable OR acl.privilege_type<>'SELECT'
        OR NOT ((n.nspname='nukhabapay' AND EXISTS(SELECT FROM approved p WHERE p.table_name=c.relname AND g.col=ANY(p.columns)))
          OR (n.nspname='nukhbapay_staff_workspace' AND c.relname IN ('preferences','departments','activity','invitations'))
          OR (n.nspname='nukhbapay_staff_departments' AND c.relname IN ('positions','directory')))))
    AS ready`);
  return grants.rows[0]?.ready===true;
}

export async function workspaceWriterReady(writer) {
  const result=await writer.query(`WITH permitted(schema_name,table_name,column_name,privilege) AS (
    VALUES ('nukhabapay','security_audit_events','','INSERT'),('nukhbapay_staff_workspace','activity','','INSERT'),
      ('nukhbapay_staff_workspace','departments','','SELECT'),('nukhbapay_staff_workspace','departments','','INSERT'),
      ('nukhbapay_staff_workspace','invitations','','SELECT'),('nukhbapay_staff_workspace','invitations','','INSERT'),
      ('nukhbapay_staff_workspace','preferences','','SELECT'),('nukhbapay_staff_workspace','preferences','','INSERT'),
      ('nukhbapay_staff_workspace','departments','name','UPDATE'),('nukhbapay_staff_workspace','departments','version','UPDATE'),
      ('nukhbapay_staff_workspace','invitations','state','UPDATE'),('nukhbapay_staff_workspace','invitations','version','UPDATE'),
      ('nukhbapay_staff_workspace','preferences','time_zone','UPDATE'),('nukhbapay_staff_workspace','preferences','locale','UPDATE'),
      ('nukhbapay_staff_workspace','preferences','display_name','UPDATE'),('nukhbapay_staff_workspace','preferences','work_email','UPDATE'),
      ('nukhbapay_staff_workspace','preferences','version','UPDATE')
  ), objects AS (
    SELECT c.oid,c.relname,c.relacl,n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND left(n.nspname,3)<>'pg_'
      AND c.relkind IN ('r','p','v','m','f','S')
  ), actual AS (
    SELECT o.nspname::text,o.relname::text,g.column_name,acl.privilege_type,acl.is_grantable,acl.grantee FROM objects o
    CROSS JOIN LATERAL (SELECT '' AS column_name,o.relacl AS grants UNION ALL
      SELECT a.attname::text,a.attacl FROM pg_attribute a WHERE a.attrelid=o.oid AND a.attnum>0 AND NOT a.attisdropped) g
    CROSS JOIN LATERAL aclexplode(g.grants) acl WHERE acl.grantee IN (0,current_user::regrole)
  ) SELECT NOT EXISTS(SELECT nspname,relname,column_name,privilege_type FROM actual EXCEPT SELECT * FROM permitted)
    AND NOT EXISTS(SELECT * FROM permitted EXCEPT SELECT nspname,relname,column_name,privilege_type FROM actual)
    AND NOT EXISTS(SELECT FROM actual WHERE is_grantable OR grantee=0) AS ready`);
  return result.rows[0]?.ready===true;
}

export async function startWindowsStaffPortal(env=process.env,{preflightOnly=false,storageOnly=false}={}) {
  const {identity,session,target,auth}=storageOnly?readWindowsStorageSettings(env):readWindowsStaffSettings(env);
  const issuer=storageOnly?env.NUKHBAPAY_STAFF_AUTH0_ISSUER:auth.issuer;
  if(typeof issuer!=='string' || !issuer.length)throw unavailable();
  let iam,store,reader,writer,integration,portal;
  async function close() {
    integration?.close();
    try {await portal?.close();} finally {await Promise.allSettled([iam?.close(),store?.close(),reader?.end(),writer?.end()]);}
  }
  let stage='restricted IAM database connections';
  try {
    iam=await createWindowsStaffIdentityRuntime(env,target);
    stage='restricted session database';
    store=await createWindowsStaffSessionStore(session,target);
    stage='staff workspace schema and grants';
    reader=createIdentityReaderPool(identity,identity,client=>verifyWindowsStaffConnection(client,target,identity.readerRole));
    writer=createIdentityWriterPool(identity,identity,client=>verifyWindowsStaffConnection(client,target,identity.writerRole));
    async function storageFailure() {
      let check='workspace writer connection';
      try {
        await verifyWindowsStaffConnection(writer,target,identity.writerRole);
        check='IAM schema and audit grants';
        if(!await iam.checkReadiness())return check;
        check='session schema and issuer binding';
        if(!await store.checkWindowsReadiness(issuer))return check;
        check='workspace reader schema and grants';
        if(!await workspaceReady(reader))return check;
        check='workspace writer grants';
        if(!await workspaceWriterReady(writer))return check;
        return null;
      } catch {return check;}
    }
    const ready=async()=>await storageFailure()===null;
    const failedCheck=await storageFailure();
    if(failedCheck){
      stage=failedCheck;
      throw unavailable();
    }
    if(storageOnly){await close();return;}
    stage='active staff enrollment in the selected tenant';
    const scope=await reader.connect();
    try {
      await scope.query('BEGIN READ ONLY');
      await scope.query("SELECT set_config('nukhabapay.tenant_id',$1,true)",[auth.tenantId]);
      const {rows:[membership]}=await scope.query(`SELECT EXISTS(SELECT FROM nukhabapay.staff_memberships m
        JOIN nukhabapay.staff_users u ON u.id=m.staff_id JOIN nukhabapay.staff_identities i ON i.staff_id=u.id
        WHERE m.tenant_id=$1 AND m.status='ACTIVE' AND u.status='ACTIVE' AND i.status='ACTIVE'
          AND i.issuer=$2 AND i.subject=$3) AS active`,[auth.tenantId,issuer,env.NUKHBAPAY_STAFF_ENROLLMENT_SUBJECT]);
      if(membership?.active===false)throw new EnrollmentMismatch();
      if(membership?.active!==true)throw unavailable();
      await scope.query('COMMIT');
    }catch(error){await scope.query('ROLLBACK').catch(()=>{});throw error;}
    finally{scope.release();}
    stage='localhost HTTPS and browser assets';
    const pfxPath=env.NUKHBAPAY_STAFF_TLS_PFX_PATH,certPath=env.NUKHBAPAY_STAFF_TLS_CERT_PATH;
    const passphrase=env.NUKHBAPAY_STAFF_TLS_PASSPHRASE;
    if(!pfxPath || !certPath || !isAbsolute(pfxPath) || !isAbsolute(certPath) || !passphrase || passphrase.length<32)throw unavailable();
    const pfx=readFileSync(pfxPath),certificate=readFileSync(certPath);
    const browserAssets=loadBrowserAssets(fileURLToPath(new URL('../apps/admin-web/dist/client/',import.meta.url)));
    const now=()=>new Date();
    const {repository,auditWriter}=iam;
    const {staffAdministration}=createStaffAdministration({repository,auditWriter,now,readers:{staff:createStaffAdministrationReader(reader)}});
    const staffWorkspace=new StaffWorkspaceService({repository,now,authority:createAdministrationAuthority(repository,now),
      store:createStaffWorkspaceStore(reader,writer)});
    stage='Auth0 staff session integration';
    integration=await prepareStaffLoginIntegration(auth,{now,fetch:globalThis.fetch,
      reportCallbackFailure:stage=>console.warn('Staff sign-in stopped at '+stage),
      backend:{repository,auditWriter,sessionStore:store,checkReadiness:ready}});
    if(preflightOnly){
      stage='localhost TLS key and certificate';
      portal=await createStaffPortal({pfx,certificate,passphrase,port:0,environment:{NODE_ENV:'development'}});
      await close();
      return;
    }
    stage='HTTPS listener on port 3001';
    portal=await createStaffPortal({pfx,certificate,passphrase,port:STAFF_PORTAL_PORT,browserAssets,environment:{NODE_ENV:'development'},
      sessions:integration.sessions,login:integration.login,staffManagement:staffAdministration,staffWorkspace,
      departmentAccess:staffWorkspace,windowsStaffStorageReady:ready});
    let closing;
    return Object.freeze({origin:portal.origin,close:()=>closing??=close()});
  } catch(error){
    await close();
    if(error instanceof EnrollmentMismatch)throw error;
    if(error instanceof IdentityRuntimeUnavailableError && error.windowsLogin){
      const {role,reason,failedChecks}=error.windowsLogin;
      const detail=failedChecks?.length ? ': '+failedChecks.join(', ') : '';
      throw new Error('Windows staff portal stopped at '+role+' ('+reason+detail+')');
    }
    throw new Error('Windows staff portal stopped at '+stage);
  }
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    if(process.argv.length>3 || (process.argv[2] && !['--preflight','--verify-storage'].includes(process.argv[2])))throw unavailable();
    const storageOnly=process.argv[2]==='--verify-storage';
    const runtime=await startWindowsStaffPortal(process.env,{preflightOnly:process.argv[2]==='--preflight',storageOnly});
    if(runtime){
      console.info(runtime.origin+'/login');
      process.once('SIGINT',()=>void runtime.close());
      process.once('SIGTERM',()=>void runtime.close());
    }else console.info(storageOnly?'Windows staff database runtime connections and grants verified.':'Windows staff database runtime connections and localhost TLS verified.');
  }catch(error){
    console.error(error.message);
    process.exitCode=process.argv[2]==='--preflight' && error instanceof EnrollmentMismatch?2:1;
  }
}
