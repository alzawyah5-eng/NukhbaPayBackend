import { readFileSync } from 'node:fs';
import { createStaffPortal } from '../apps/admin-web/dist/portal.js';
import { loadBrowserAssets } from '../apps/admin-web/dist/browser-assets.js';
import { loadKioskAssets } from '../apps/admin-web/dist/kiosk-assets.js';
import { readAwsStagingAuth0Configuration } from '../apps/admin-web/dist/auth0-configuration.js';
import { prepareStaffLoginIntegration } from '../apps/admin-web/dist/staff-login-integration.js';
import { createAdministrationAuthority, createStaffAdministration, StaffWorkspaceService } from '../packages/application/dist/application/src/index.js';
import { createIdentityReaderPool, createIdentityWriterPool, createStaffAdministrationReader,
  createStaffWorkspaceStore } from '../packages/database/dist/database/src/index.js';
import { awsStagingTarget, verifyAwsStagingConnection } from '../packages/database/dist/database/src/aws-staging-target.js';
import { createAwsStagingIdentityRuntime, parseIdentityRuntimeConfiguration } from '../packages/database/dist/database/src/identity-runtime.js';
import { createAwsStagingStaffSessionStore } from '../packages/database/dist/database/src/staff-session-store.js';
import { createAwsStagingCatalogueStorage } from '../packages/database/dist/database/src/local-catalogue-storage.js';
import { workspaceReady, workspaceWriterReady } from './start-windows-staff-portal.mjs';

let iam, sessions, catalogue, reader, writer, integration, portal;
async function close() {
  integration?.close();
  await portal?.close().catch(()=>undefined);
  await Promise.allSettled([iam?.close(),sessions?.close(),catalogue?.close(),reader?.end(),writer?.end()]);
}

let phase='staging configuration';
try {
  const env=process.env;
  const auth=readAwsStagingAuth0Configuration(env);
  const target=awsStagingTarget(env.NUKHBAPAY_STAGING_RDS_HOST,readFileSync('/app/rds-ca.pem','utf8'));
  const identity=parseIdentityRuntimeConfiguration(env,target.host);
  phase='restricted staging database roles';
  iam=await createAwsStagingIdentityRuntime(env,target);
  sessions=await createAwsStagingStaffSessionStore({
    expectedRole:'nukhabapay_session_backend',expectedDatabase:'nukhbapay_staff',connectionString:env.DB_STAFF_SESSION_URL,
  },target);
  catalogue=await createAwsStagingCatalogueStorage({
    setupId:env.NUKHBAPAY_STAGING_CATALOGUE_ID,password:env.DB_LOCAL_CATALOGUE_READER_PASSWORD,tenantId:auth.tenantId,
  },target);
  reader=createIdentityReaderPool(identity,identity,client=>verifyAwsStagingConnection(client,identity.database,identity.readerRole),target.poolOptions);
  writer=createIdentityWriterPool(identity,identity,client=>verifyAwsStagingConnection(client,identity.database,identity.writerRole),target.poolOptions);
  const checkReadiness=async()=>{
    const checks=await Promise.all([iam.checkReadiness(),sessions.checkWindowsReadiness(auth.issuer),
      workspaceReady(reader),workspaceWriterReady(writer),catalogue.checkReadiness()]);
    return checks.every(check=>check===true);
  };
  const now=()=>new Date();
  const {repository,auditWriter}=iam;
  phase='staging login and catalogue assembly';
  integration=await prepareStaffLoginIntegration(auth,{now,fetch:globalThis.fetch,
    backend:{repository,auditWriter,sessionStore:sessions,checkReadiness}});
  const {staffAdministration,staffCatalogue}=createStaffAdministration({repository,auditWriter,now,
    readers:{staff:createStaffAdministrationReader(reader),catalogue:catalogue.read},
    stagingCatalogueTenant:auth.tenantId,
    configuredDiscoveryProviders:['FINXPLOR','IPAY']});
  const staffWorkspace=new StaffWorkspaceService({repository,now,authority:createAdministrationAuthority(repository,now),
    store:createStaffWorkspaceStore(reader,writer)});
  phase='staging web listener';
  portal=await createStaffPortal({staging:{checkReadiness},environment:env,port:8080,
    browserAssets:loadBrowserAssets('/app/staff-browser/'),
    kioskAssets:loadKioskAssets('/app/kiosk/'),
    login:integration.login,sessions:integration.sessions,staffManagement:staffAdministration,
    staffCatalogue,staffWorkspace,departmentAccess:staffWorkspace,finxplorLayer1Prices:catalogue.readFinxplorLayer1Prices});
  console.info('AWS staging staff portal is ready');
  process.once('SIGINT',()=>void close());
  process.once('SIGTERM',()=>void close());
} catch {
  console.error('AWS staging staff portal stopped at '+phase);
  await close();
  process.exitCode=1;
}
