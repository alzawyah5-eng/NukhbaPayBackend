import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaffPortal } from '../apps/admin-web/dist/portal.js';
import { loadBrowserAssets } from '../apps/admin-web/dist/browser-assets.js';
import { prepareStaffLoginIntegration } from '../apps/admin-web/dist/staff-login-integration.js';
import { readPendingAuth0Configuration, STAFF_PORTAL_PORT } from '../apps/admin-web/dist/auth0-configuration.js';
import { createAdministrationAuthority, createStaffAdministration, StaffWorkspaceService } from '../packages/application/dist/application/src/index.js';
import { parseIdentityRuntimeConfiguration } from '../packages/database/dist/database/src/identity-runtime.config.js';
import { createIdentityReaderPool, createIdentityWriterPool, createStaffSessionStore,
  createStaffAdministrationReader, createStaffWorkspaceStore, SecurityAuditPostgresRepository,
  StaffIdentityPostgresRepository } from '../packages/database/dist/database/src/index.js';

const required = Object.freeze([
  'NUKHBAPAY_STAFF_AUTH0_ISSUER', 'NUKHBAPAY_STAFF_AUTH0_CLIENT_ID', 'NUKHBAPAY_STAFF_AUTH0_CLIENT_SECRET',
  'NUKHBAPAY_STAFF_AUTH0_AUDIENCE', 'NUKHBAPAY_STAFF_AUTH0_STAFF_KIND_CLAIM', 'NUKHBAPAY_STAFF_AUTH0_TENANT_ID',
  'DB_IDENTITY_READER_URL', 'DB_IDENTITY_WRITER_URL', 'DB_STAFF_SESSION_URL', 'DB_STAFF_SESSION_ROLE',
  'DB_STAFF_SESSION_EXPECTED_DATABASE_OID',
]);
const unavailable = () => new Error('Staff Auth0 test login unavailable');

export function missingStaffAuth0TestConfiguration(env) {
  return required.filter(key => typeof env[key] !== 'string' || env[key].length===0);
}

export function readStaffAuth0TestConfiguration(env) {
  if (env.NUKHBAPAY_STAFF_SESSION_MODE !== 'auth0-test-login' || env.NUKHBAPAY_ENVIRONMENT !== 'development' ||
      env.NUKHBAPAY_ENV !== 'local' || env.NODE_ENV !== 'development' || env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
      missingStaffAuth0TestConfiguration(env).length) throw unavailable();
  try {
    const auth = readPendingAuth0Configuration(env), identity = parseIdentityRuntimeConfiguration(env);
    const role = env.DB_STAFF_SESSION_ROLE, connectionString = env.DB_STAFF_SESSION_URL;
    const target = new URL(connectionString), databaseOid = env.DB_STAFF_SESSION_EXPECTED_DATABASE_OID;
    if (identity.host !== '127.0.0.1' || identity.port !== 5432 ||
        !/^nukhabapay_b3b[23]_[0-9a-f]{32}$/.test(identity.database) || !/^nukh_session_[0-9a-f]{20}$/.test(role) ||
        !/^[1-9][0-9]{0,9}$/.test(databaseOid) || Number(databaseOid)>4294967295 ||
        !['postgres:','postgresql:'].includes(target.protocol) || target.hostname !== identity.host ||
        (target.port || '5432') !== '5432' || target.search || target.hash ||
        decodeURIComponent(target.username) !== role || !target.password || decodeURIComponent(target.pathname.slice(1)) !== identity.database)
      throw unavailable();
    const session = Object.freeze(Object.defineProperty({expectedRole:role,expectedDatabase:identity.database},'connectionString',{value:connectionString}));
    return Object.freeze({auth,identity,session,databaseOid});
  } catch { throw unavailable(); }
}

async function matchesIdentityTarget(pool,role,database,databaseOid) {
  try {
    const row=(await pool.query(`SELECT current_database() AS database,current_user AS role,session_user AS signed_in_role,
      host(inet_server_addr()) AS host,inet_server_port() AS port,d.oid::text AS database_oid,
      (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication) AS unsafe
      FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`)).rows[0];
    return row?.database===database && row.database_oid===databaseOid && row.role===role && row.signed_in_role===role &&
      row.host==='127.0.0.1' && row.port===5432 && row.unsafe===false;
  } catch {return false;}
}

export async function startStaffAuth0Test(env=process.env,{reportCallbackFailure,reportStartupFailure,isolatedStaffRead,isolatedStaffWorkspace}={}) {
  const {auth,identity,session,databaseOid}=readStaffAuth0TestConfiguration(env);
  const pfxPath=env.NUKHBAPAY_STAFF_TLS_PFX_PATH,certPath=env.NUKHBAPAY_STAFF_TLS_CERT_PATH,passphrase=env.NUKHBAPAY_STAFF_TLS_PASSPHRASE;
  if (!pfxPath || !isAbsolute(pfxPath) || !certPath || !isAbsolute(certPath) || !passphrase || passphrase.length<32) throw unavailable();
  if (isolatedStaffRead && isolatedStaffWorkspace) throw unavailable();
  const localScope=isolatedStaffWorkspace??isolatedStaffRead;
  const readScope=localScope && Object.freeze({ ...localScope });
  if (readScope && (readScope.database!==identity.database || readScope.databaseOid!==databaseOid ||
      readScope.tenantId!==auth.tenantId || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(readScope.staffId))) throw unavailable();
  let reader,writer,managementPool,workspaceWriter,store,integration,portal;
  let startupStage='certificate and browser assets';
  const closeResources=()=>Promise.allSettled([store?.close(),reader?.end(),writer?.end(),managementPool?.end(),workspaceWriter?.end()]);
  try {
    const pfx=readFileSync(pfxPath),certificate=readFileSync(certPath);
    const browserAssets=loadBrowserAssets(fileURLToPath(new URL('../apps/admin-web/dist/client/',import.meta.url)));
    startupStage='identity database target';
    reader=createIdentityReaderPool(identity,{readerUrl:identity.readerUrl});
    writer=createIdentityWriterPool(identity,{writerUrl:identity.writerUrl});
    const checkReadiness=async()=> (await Promise.all([
      matchesIdentityTarget(reader,identity.readerRole,identity.database,databaseOid),
      matchesIdentityTarget(writer,identity.writerRole,identity.database,databaseOid),
    ])).every(Boolean);
    if (!await checkReadiness()) throw unavailable();
    const repository=new StaffIdentityPostgresRepository(reader), auditWriter=new SecurityAuditPostgresRepository(writer);
    const now=()=>new Date();
    let staffManagement,staffWorkspace;
    if (readScope) {
      startupStage='management database read privileges';
      managementPool=createIdentityReaderPool(identity,{readerUrl:identity.readerUrl});
      if (!await matchesIdentityTarget(managementPool,identity.readerRole,identity.database,databaseOid)) throw unavailable();
      await managementPool.query(`SELECT id,tenant_id,occurred_at,action,outcome,actor_staff_id
        FROM nukhabapay.security_audit_events WHERE false`);
      const {rows:[controls]}=await managementPool.query(`SELECT
        NOT has_table_privilege(current_user,'nukhabapay.security_audit_events','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
        AND NOT has_any_column_privilege(current_user,'nukhabapay.security_audit_events','UPDATE,INSERT')
        AND (SELECT count(*)=3 AND bool_and(relrowsecurity AND relforcerowsecurity) FROM pg_class
          WHERE oid IN ('nukhabapay.staff_memberships'::regclass,'nukhabapay.tenant_role_grants'::regclass,
            'nukhabapay.security_audit_events'::regclass)) AS protected`);
      if (controls?.protected!==true) throw unavailable();
      staffManagement=createStaffAdministration({repository,auditWriter,now,
        readers:{staff:createStaffAdministrationReader(managementPool)},
        ...(isolatedStaffWorkspace?{isolatedWorkspaceTenant:readScope.tenantId}:{isolatedStaffReadScope:readScope})}).staffAdministration;
      if (isolatedStaffWorkspace) {
        startupStage='workspace database privileges';
        workspaceWriter=createIdentityWriterPool(identity,{writerUrl:identity.writerUrl});
        if (!await matchesIdentityTarget(workspaceWriter,identity.writerRole,identity.database,databaseOid)) throw unavailable();
        const {rows:[workspace]}=await managementPool.query(`SELECT count(*)=4 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity)
          AND bool_and(has_table_privilege(current_user,c.oid,'SELECT') AND NOT
            has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE')) AS ready
          FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace
          WHERE s.nspname='nukhbapay_staff_workspace' AND c.relkind='r'`);
        if (workspace?.ready!==true) throw unavailable();
        await managementPool.query('SELECT display_name,work_email FROM nukhbapay_staff_workspace.preferences WHERE false');
        const {rows:[positions]}=await managementPool.query(`SELECT count(*)=2 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity)
          AND bool_and(has_table_privilege(current_user,c.oid,'SELECT') AND NOT has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE')
            AND NOT has_table_privilege(current_user,c.oid,'DELETE,TRUNCATE')) AS ready FROM pg_class c
          WHERE c.oid IN ('nukhbapay_staff_departments.directory'::regclass,'nukhbapay_staff_departments.positions'::regclass)`);
        if(positions?.ready!==true)throw unavailable();
        staffWorkspace=new StaffWorkspaceService({repository,now,
          authority:createAdministrationAuthority(repository,now,undefined,readScope.tenantId),
          store:createStaffWorkspaceStore(managementPool,workspaceWriter)});
      }
    }
    startupStage='restricted session store';
    store=await createStaffSessionStore(session);
    startupStage='Auth0 integration';
    integration=await prepareStaffLoginIntegration(auth,{fetch:globalThis.fetch,now,
      ...(typeof reportCallbackFailure === 'function' && {reportCallbackFailure}),backend:{
      repository,auditWriter,sessionStore:store,checkReadiness,
    }});
    startupStage='localhost HTTPS listener';
    portal=await createStaffPortal({pfx,certificate,passphrase,port:STAFF_PORTAL_PORT,browserAssets,
      ...(staffManagement && {staffManagement}),
        ...(staffWorkspace && {staffWorkspace,departmentAccess:staffWorkspace}),
      sessions:integration.sessions,login:integration.login,environment:{NODE_ENV:'development'}});
    let closing;
    return Object.freeze({origin:portal.origin,close:()=>closing??=(async()=>{
      integration.close();
      try {await portal.close();} finally {await closeResources();}
    })()});
  } catch {
    try { reportStartupFailure?.(startupStage); } catch { /* Keep startup errors redacted. */ }
    integration?.close();
    await closeResources();
    throw unavailable();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url)===resolve(process.argv[1])) {
  const missing=missingStaffAuth0TestConfiguration(process.env);
  if (missing.length) {
    console.error(`Staff Auth0 test login needs configuration for ${missing.join(', ')}`);
    process.exitCode=1;
  } else {
    void startStaffAuth0Test().then(runtime=>{
      console.info(`Nukhbapay staff Auth0 test login: ${runtime.origin}/login`);
      const close=()=>{void runtime.close().catch(()=>{process.exitCode=1;});};
      process.once('SIGINT',close);process.once('SIGTERM',close);
    }).catch(()=>{console.error('Staff Auth0 test login startup failed. Check the approved IAM target, guarded session role, and localhost HTTPS settings.');process.exitCode=1;});
  }
}
