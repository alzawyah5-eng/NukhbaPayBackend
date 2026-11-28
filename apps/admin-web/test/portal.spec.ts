import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFileSync } from "node:fs";
import { randomUUID, X509Certificate } from "node:crypto";
import { request } from "node:https";
import { rootCertificates } from "node:tls";
import { fileURLToPath } from "node:url";
import { createServer as createNetServer } from "node:net";
import { consumePublicationCommand, parseStaffWorkspaceCommand, type StaffWorkspaceCommand } from "@nukhbapay/application";
import { createStaffPortal, staffCookie } from "../src/portal.js";
import { startStaffPortal } from "../src/main.js";
import { config, fixture } from "./fixtures/auth0-fixture.js";
import { prepareStaffLoginIntegration } from "../src/staff-login-integration.js";
import { loadBrowserAssets } from "../src/browser-assets.js";
import { createAuth0FactorClaimVerifier } from '../src/auth0-factor-claim.js';
import { platformStaffAssuranceConsumer, type PlatformStaffPilotPort } from '../src/platform-staff-step-up.js';

let pfx:Buffer,certificate:Buffer,passphrase:string,ca:string;
before(()=>{
  const pfxPath=process.env['NUKHBAPAY_STAFF_TEST_PFX_PATH'],caPath=process.env['NUKHBAPAY_STAFF_TEST_CA_PATH'];
  passphrase=process.env['NUKHBAPAY_STAFF_TEST_PASSPHRASE']??'';
  if(!pfxPath||!caPath||!passphrase||process.env['NODE_TLS_REJECT_UNAUTHORIZED']==='0')throw new Error('Explicit verified local TLS test configuration required');
  pfx=readFileSync(pfxPath);certificate=readFileSync(caPath);ca=new X509Certificate(certificate).toString();
});
function call(origin:string,path='/',method='GET',headers:Record<string,string>={},body?:string,trust=true,servername='localhost') {
  const port=Number(new URL(origin).port);
  return new Promise<{status:number;headers:import('node:http').IncomingHttpHeaders;body:string}>((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port,servername,path,method,headers:{host:`localhost:${port}`,...headers},agent:false,ca:trust?ca:[...rootCertificates]},res=>{
      let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,body:text}));
    });req.on('error',reject);if(body)req.write(body);req.end();
  });
}
test('stale session and parallel login callbacks recover without removing the current transaction',async()=>{
  const reservation=createNetServer();
  await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const address=reservation.address();assert.ok(address&&typeof address!=='string');const port=address.port;
  await new Promise<void>(resolve=>reservation.close(()=>resolve()));
  const origin=`https://localhost:${port}`,f=await fixture(origin+'/auth/callback');
  const app=await createStaffPortal({pfx,certificate,passphrase,port,sessions:f.sessions,login:f.login});
  try{
    const oldCookie=staffCookie('o'.repeat(43)).split(';')[0]!;
    const stale=await call(origin,'/auth/workspace','GET',{cookie:oldCookie});
    assert.equal(stale.status,401);
    assert.equal(stale.headers['set-cookie']?.length,2);
    assert.ok(stale.headers['set-cookie']?.every(value=>value.includes('Max-Age=0')));
    const first=f.callbackFor(f.login.begin());
    const latest=f.callbackFor(f.login.begin(undefined,first.cookie));
    const pendingCookie=latest.cookieHeader.split(';')[0]!;
    const wrong=await call(origin,first.callback,'GET',{cookie:pendingCookie});
    assert.equal(wrong.status,401);
    assert.equal(wrong.headers['set-cookie'],undefined);
    assert.equal(f.exchanges(),0);
    const correct=await call(origin,latest.callback,'GET',{cookie:pendingCookie});
    assert.equal(correct.status,303);
    assert.equal(f.exchanges(),1);
    const activeCookie=correct.headers['set-cookie']?.[1]?.split(';')[0];
    assert.ok(activeCookie);
    assert.equal((await call(origin,'/auth/workspace','GET',{cookie:activeCookie})).status,200);
    assert.equal((await call(origin,latest.callback,'GET',{cookie:pendingCookie})).status,401);
    assert.equal(f.exchanges(),1);
  }finally{await app.close();f.login.close();}
});
test('staff workspace routes require a real browser session and CSRF, and carry only the session tenant',async()=>{
  const reservation=createNetServer();
  await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const addr=reservation.address();
  assert.ok(addr && typeof addr!=='string');
  const port=addr.port;
  await new Promise<void>(resolve=>reservation.close(()=>resolve()));
  const origin=`https://localhost:${port}`,f=await fixture(origin+'/auth/callback');
  const integration=await prepareStaffLoginIntegration({...config,callbackUrl:origin+'/auth/callback'},
    {backend:f.backend,fetch:f.fetch,now:f.now});
  const commands:StaffWorkspaceCommand[]=[];
  const app=await createStaffPortal({pfx,certificate,passphrase,port,environment:{NODE_ENV:'development'},
    login:integration.login,sessions:integration.sessions,staffWorkspace:{
      availableViews:async(_identity,tenant)=>{assert.equal(tenant,config.tenantId);return ['roles','invitations','settings'];},
      read:async(_identity,tenant,session,view)=>{
        assert.equal(tenant,config.tenantId);
        assert.ok(await session.revalidate());
        return view==='settings'?{timeZone:'UTC',locale:'en-GB',version:0}:[];
      },
      command:async(_identity,tenant,session,input)=>{
        assert.equal(tenant,config.tenantId);
        const command=parseStaffWorkspaceCommand(input);
        assert.ok(await session.revalidate());
        commands.push(command);
      },
    }});
  try {
    const path='/staff-api/workspace';
    assert.equal((await call(origin,path+'/settings')).status,401);
    const started=f.callbackFor(integration.login.begin());
    const raw=await integration.login.complete(started.callback,started.cookie);
    const cookie=staffCookie(raw).split(';')[0]!;
    const profile=await call(origin,'/auth/workspace','GET',{cookie});
    assert.equal(profile.status,200);
    const session=JSON.parse(profile.body);
    assert.deepEqual(session.navigation,['/overview','/roles','/staff/invite','/access-requests','/settings']);
    assert.equal((await call(origin,path+'/settings','GET',{cookie,origin:'https://wrong.invalid'})).status,403);
    assert.equal((await call(origin,path+'/settings','GET',{cookie,authorization:'Bearer unexpected'})).status,400);
    assert.equal((await call(origin,path+'/settings?tenant=foreign','GET',{cookie})).status,404);
    assert.equal((await call(origin,path+'/settings','GET',{cookie})).status,200);
    const input={action:'save-settings',version:0,timeZone:'Asia/Dubai',locale:'en-GB'};
    const headers={cookie,origin,'content-type':'application/json'};
    assert.equal((await call(origin,path,'POST',headers,JSON.stringify(input))).status,403);
    const valid={...headers,'x-csrf-token':session.csrfToken};
    assert.equal((await call(origin,path,'POST',valid,JSON.stringify({...input,tenantId:'forged'}))).status,400);
    assert.equal((await call(origin,path,'POST',valid,JSON.stringify(input))).status,204);
    assert.deepEqual(commands,[input]);
  } finally {await app.close();integration.close();}
});
// Previous Layer 1 implementation — disabled while rebuilding according to the new approved architecture.
// test('local price previews accept the pilot format and reject duplicate costs or an incorrect scope',()=>{
//   const tenantId=randomUUID();
//   const setupId='test-setup';
//   const entry={discoveryId:randomUUID(),senderCurrency:'GBP',senderAmount:'3.17',demoAedRate:'4.70'};
//   const fees={platformFeeAed:'2.00',commissionAed:'0.50'};
//   assert.equal(readLocalPricePreviewBook({version:1,tenantId,setupId,...entry,...fees},tenantId,setupId)
//     .prices.get(entry.discoveryId)?.indicativePrice,'17.40');
//   const batch={version:2,tenantId,setupId,entries:[entry],...fees};
//   assert.equal(readLocalPricePreviewBook({...batch,platformFeeAed:'1.00',commissionAed:'0.25'},tenantId,setupId)
//     .prices.get(entry.discoveryId)?.indicativePrice,'16.15');
//   assert.throws(()=>readLocalPricePreviewBook({...batch,platformFeeAed:undefined},tenantId,setupId));
//   assert.throws(()=>readLocalPricePreviewBook(batch,randomUUID(),setupId));
//   assert.throws(()=>readLocalPricePreviewBook(batch,tenantId,'other-setup'));
//   assert.throws(()=>readLocalPricePreviewBook({...batch,entries:[entry,entry]},tenantId,setupId));
//   assert.throws(()=>readLocalPricePreviewBook({...batch,entries:[{...entry,demoAedRate:'0'}]},tenantId,setupId));
// });

test('department login scopes direct reads and writes to the selected live grant and invalidates regrants',async()=>{
  const reservation=createNetServer();
  await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const address=reservation.address();assert.ok(address && typeof address!=='string');const port=address.port;
  await new Promise<void>(resolve=>reservation.close(()=>resolve()));
  const origin='https://localhost:'+port,f=await fixture(origin+'/auth/callback');
  const integration=await prepareStaffLoginIntegration({...config,callbackUrl:origin+'/auth/callback'},{backend:f.backend,fetch:f.fetch,now:f.now});
  let positions=[{department:'support',role:'SUPPORT_AGENT',grantId:randomUUID()},
    {department:'central',role:'TENANT_STAFF_MANAGER',grantId:randomUUID()},
    {department:'catalogue',role:'PRICING_EDITOR',grantId:randomUUID()}];
  let writes=0,reads=0;
  let catalogueReads=0, replacePricingGrant=false;
  let nativeStorageAvailable=false;
  const discoveryId=randomUUID();
  const otherDiscoveryId=randomUUID();
  const missingCostId=randomUUID();
  const replacedDiscoveryId=randomUUID();
  let currentDiscovery=true;
  let priceStorageDown = false;
  let xeRefreshRuns = 0;
  const customerPrice = {basis:'CUSTOMER_PRICE',sourceKey:'test-price',sourceAmount:'3.17',
    sourceCurrency:'GBP',convertedAed:'16.24135802116804',rateSource:'CURRENCY_API'} as const;
  const app=await createStaffPortal({pfx,certificate,passphrase,port,environment:{NODE_ENV:'development'},login:integration.login,
    windowsStaffStorageReady:async()=>nativeStorageAvailable,
    localCataloguePreview:true,
    finxplorLayer1Prices:async (tenantId,ids)=>{
      assert.equal(tenantId,config.tenantId);
      assert.ok(!ids.includes(missingCostId));
      if (priceStorageDown) throw new Error('Fixture storage unavailable');
      return new Map(ids.map(id=>[id,id===discoveryId ? [customerPrice] : []]));
    },
    refreshFxRates:async tenantId=>{
      assert.equal(tenantId,config.tenantId);
      xeRefreshRuns++;
      return {status:'not-configured'};
    },
    syncCatalogue:async tenantId=>{
      assert.equal(tenantId,config.tenantId);
      return {products:101,inserted:1,unchanged:100,layer1:{amounts:105,pendingFx:2}};
    },
    staffCatalogue:{available:async()=>true,read:async(_identity,tenant,view,query)=> {
      catalogueReads++;
      if(view==='discoveries'){
        assert.equal(tenant,config.tenantId);
        const items=[{id:currentDiscovery?discoveryId:replacedDiscoveryId,providerId:'FINXPLOR'},
          {id:otherDiscoveryId,providerId:'FINXPLOR'},{id:missingCostId,providerId:'SSL_WIRELESS'}]
          .filter(item=>!query['discoveryId'] || item.id===query['discoveryId']);
        return {revision:'fixture-revision',items,next:null,previous:null,count:items.length};
      }
      if (replacePricingGrant) positions=positions.map(p=>p.role==='PRICING_EDITOR'?{...p,grantId:randomUUID()}:p);
      return {revision:'fixture-revision',items:[],next:null,previous:null,count:0};
    }},
    sessions:integration.sessions,departmentAccess:{positions:async()=>positions},staffWorkspace:{
      availableViews:async()=>['departments','roles','settings'],read:async()=>{reads++;return [];},
      command:async()=>{writes++;},
    }});
  try{
    const offline=await call(origin,'/health/staff-storage','HEAD');
    assert.equal(offline.status,503);assert.equal(offline.headers['x-nukhbapay-storage'],undefined);
    nativeStorageAvailable=true;
    const online=await call(origin,'/health/staff-storage','HEAD');
    assert.equal(online.status,204);assert.equal(online.headers['x-nukhbapay-storage'],'windows-postgresql-staff');
    assert.equal((await call(origin,'/health/staff-storage','GET')).status,404);
    assert.equal((await call(origin,'/auth/position','POST')).status,401);
    const start=f.callbackFor(integration.login.begin());
    const cookie=staffCookie(await integration.login.complete(start.callback,start.cookie)).split(';')[0]!;
    const state=JSON.parse((await call(origin,'/auth/workspace','GET',{cookie})).body);
    assert.deepEqual(state.navigation,['/overview']);assert.equal(state.departmentAccess.selected,null);
    assert.equal((await call(origin,'/staff-api/catalogue/products','GET',{cookie})).status,403);
    assert.ok(state.departmentAccess.positions.every((p:object)=>!('grantId' in p)));
    const headers={origin,cookie,'content-type':'application/json','x-csrf-token':state.csrfToken};
    const choose=(department:string,role:string,overrides={})=>call(origin,'/auth/position','POST',{...headers,...overrides},JSON.stringify({department,role}));
    assert.equal((await choose('support','SECURITY_ADMIN')).status,403);
    assert.equal((await choose('finance','SUPPORT_AGENT')).status,403);
    assert.equal((await choose('support','SUPPORT_AGENT',{'x-csrf-token':'invalid'})).status,403);
    const selected=await choose('support','SUPPORT_AGENT');assert.equal(selected.status,204);
    const mark=selected.headers['set-cookie']![0]!;
    assert.match(mark,/; Path=\/; Secure; HttpOnly; SameSite=Strict$/);
    const activeCookie=cookie+'; '+mark.split(';')[0];
    assert.ok(JSON.parse((await call(origin,'/auth/workspace','GET',{cookie:activeCookie})).body).navigation.includes('/catalogue'));
    assert.equal((await call(origin,'/staff-api/catalogue/products','GET',{cookie:activeCookie})).status,200);
    for (const view of ['offers','economics','drafts','publications'])
      assert.equal((await call(origin,'/staff-api/catalogue/'+view,'GET',{cookie:activeCookie})).status,403);
    const supportDiscoveries=await call(origin,'/staff-api/catalogue/discoveries','GET',{cookie:activeCookie});
    assert.equal(supportDiscoveries.status,200);
    assert.equal(JSON.parse(supportDiscoveries.body).items[0].sellingPricePreview,undefined);
    assert.equal(JSON.parse(supportDiscoveries.body).items[0].acquisitionCost,undefined);
    assert.deepEqual(JSON.parse(supportDiscoveries.body).items[0].layer1Prices,[customerPrice]);
    assert.equal(catalogueReads,2);
    const manager=await choose('central','TENANT_STAFF_MANAGER');
    assert.equal(manager.status,204);
    const managerCookie=cookie+'; '+manager.headers['set-cookie']![0]!.split(';')[0];
    const syncPath='/staff-api/catalogue/sync';
    assert.equal((await call(origin,syncPath,'POST')).status,401);
    assert.equal((await call(origin,syncPath,'POST',{...headers,cookie:activeCookie})).status,403);
    assert.equal((await call(origin,syncPath,'POST',{...headers,cookie:managerCookie,'x-csrf-token':'x'.repeat(43)})).status,403);
    assert.equal((await call(origin,syncPath,'POST',{...headers,cookie:managerCookie,origin:'https://other.invalid'})).status,403);
    const synced=await call(origin,syncPath,'POST',{...headers,cookie:managerCookie});
    assert.equal(synced.status,200,synced.body);
    assert.deepEqual(JSON.parse(synced.body),{products:101,inserted:1,unchanged:100,persisted:true,layer1:{amounts:105,pendingFx:2}});
    const previewPath='/staff-api/catalogue/price-preview';
    const selection={discoveryId};
    const preview=(cookieValue:string,input:unknown,extra={})=>call(origin,previewPath,'POST',
      {...headers,cookie:cookieValue,...extra},JSON.stringify(input));
    assert.equal((await call(origin,previewPath,'POST')).status,401);
    assert.equal((await preview(activeCookie,selection)).status,403);
    assert.equal((await preview(managerCookie,selection,{'x-csrf-token':'x'.repeat(43)})).status,403);
    assert.equal((await preview(managerCookie,{...selection,tenantId:randomUUID()})).status,400);
    assert.equal((await preview(managerCookie,{...selection,rate:'1e0'})).status,400);
    assert.equal((await preview(managerCookie,{...selection,senderAmount:'0.01'})).status,400);
    assert.equal((await preview(managerCookie,{discoveryId:randomUUID()})).status,503);
    assert.equal((await preview(managerCookie,{...selection,platformFeeAed:'0.00',commissionAed:'0.00'})).status,400);
    const result=await preview(managerCookie,selection);
    assert.equal(result.status,503);
    assert.deepEqual(JSON.parse(result.body),{code:'AED_NORMALIZATION_UNAVAILABLE',
      error:'AED acquisition-cost normalization is unavailable during the Layer 1 rebuild.'});
    const catalogue=await Promise.all(['countries?group=GCC','discovery-providers',
      'discoveries?provider=FINXPLOR&sourceCountry=GTM&sourceRegion=Americas&productType=Gift+cards'].map(view=>
      call(origin,'/staff-api/catalogue/'+view,'GET',{cookie:managerCookie,'sec-fetch-site':'same-origin'})));
    assert.deepEqual(catalogue.map(response=>response.status),[200,200,200]);
    assert.equal(JSON.parse(catalogue[1]!.body).pricingPreviewAvailable,undefined);
    assert.deepEqual(JSON.parse(catalogue[2]!.body).items,[
      {id:discoveryId,providerId:'FINXPLOR',layer1Prices:[customerPrice]},
      {id:otherDiscoveryId,providerId:'FINXPLOR',layer1Prices:[]},
      {id:missingCostId,providerId:'SSL_WIRELESS'},
    ]);
    currentDiscovery=false;
    assert.equal((await preview(managerCookie,selection)).status,503);
    const current=await call(origin,'/staff-api/catalogue/discoveries','GET',{cookie:managerCookie});
    assert.equal(current.status,200);
    assert.deepEqual(JSON.parse(current.body).items[0],{id:replacedDiscoveryId,providerId:'FINXPLOR',layer1Prices:[]});
    assert.equal((await call(origin,'/staff-api/catalogue/economics','GET',{cookie:managerCookie})).status,403);
    assert.equal(catalogueReads,7);
    const fxPath='/staff-api/catalogue/refresh-rates';
    const managerProfile=JSON.parse((await call(origin,'/auth/workspace','GET',{cookie:managerCookie})).body);
    const supportProfile=JSON.parse((await call(origin,'/auth/workspace','GET',{cookie:activeCookie})).body);
    assert.equal(managerProfile.canRefreshFxRates,true);
    assert.equal(supportProfile.canRefreshFxRates,undefined);
    assert.equal((await call(origin,fxPath,'POST')).status,401);
    assert.equal((await call(origin,fxPath,'POST',{...headers,cookie:activeCookie})).status,403);
    assert.equal((await call(origin,fxPath,'POST',{...headers,cookie:managerCookie,'x-csrf-token':'x'.repeat(43)})).status,403);
    assert.equal((await call(origin,fxPath,'POST',{...headers,cookie:managerCookie,origin:'https://other.invalid'})).status,403);
    assert.equal(xeRefreshRuns,0);
    const refreshed=await call(origin,fxPath,'POST',{...headers,cookie:managerCookie});
    assert.equal(refreshed.status,200,refreshed.body);
    assert.deepEqual(JSON.parse(refreshed.body),{status:'not-configured'});
    assert.equal(xeRefreshRuns,1);
    const pricing=await choose('catalogue','PRICING_EDITOR');
    assert.equal(pricing.status,204);
    const pricingCookie=cookie+'; '+pricing.headers['set-cookie']![0]!.split(';')[0];
    currentDiscovery=true;
    const pricingDiscoveries=await call(origin,'/staff-api/catalogue/discoveries','GET',{cookie:pricingCookie});
    assert.equal(pricingDiscoveries.status,200);
    assert.deepEqual(JSON.parse(pricingDiscoveries.body).items[0].layer1Prices,[customerPrice]);
    priceStorageDown=true;
    const pendingPrices=await call(origin,'/staff-api/catalogue/discoveries','GET',{cookie:pricingCookie});
    assert.equal(pendingPrices.status,200);
    assert.equal(JSON.parse(pendingPrices.body).items[0].layer1Prices,null);
    priceStorageDown=false;
    assert.equal((await call(origin,'/staff-api/catalogue/offers','GET',{cookie:pricingCookie})).status,200);
    replacePricingGrant=true;
    assert.equal((await call(origin,'/staff-api/catalogue/offers','GET',{cookie:pricingCookie})).status,403);
    assert.equal((await call(origin,'/staff-api/workspace/settings','GET',{cookie:activeCookie})).status,200);
    assert.equal((await call(origin,'/staff-api/workspace/departments','GET',{cookie:activeCookie})).status,403);
    assert.equal((await call(origin,'/staff-api/workspace','POST',{...headers,cookie:activeCookie},
      JSON.stringify({action:'create-department',id:randomUUID(),name:'Forbidden'}))).status,403);
    assert.equal(writes,0);assert.equal(reads,1);
    positions=positions.map(p=>({...p,grantId:randomUUID()}));
    assert.equal((await preview(managerCookie,selection)).status,403);
    assert.equal((await call(origin,'/staff-api/workspace/settings','GET',{cookie:activeCookie})).status,403);
    assert.equal(JSON.parse((await call(origin,'/auth/workspace','GET',{cookie:activeCookie})).body).departmentAccess.selected,null);
  }finally{await app.close();integration.close();}
});
test('HTTPS portal presents a valid localhost certificate and rejects untrusted or wrong-host TLS',async()=>{
  const app=await createStaffPortal({pfx,certificate,passphrase,port:0});
  try {
    const root=await call(app.origin,'/','GET',{'sec-fetch-site':'none'});assert.equal(root.status,200);assert.match(root.body,/Nukhbapay Staff Portal/);
    assert.match(String(root.headers['content-security-policy']),/frame-ancestors 'none'/);assert.equal(root.headers['cache-control'],'no-store');
    await assert.rejects(()=>call(app.origin,'/','GET',{},undefined,false));
    await assert.rejects(()=>call(app.origin,'/','GET',{},undefined,true,'wrong.synthetic.invalid'));
    assert.equal((await call(app.origin,'/health/live')).status,200);
    assert.equal((await call(app.origin,'/health/staff-storage','HEAD')).status,404);
  }finally{await app.close();await app.close();}
  await assert.rejects(()=>call(app.origin));
});
test('CLI and default BFF cannot activate Auth0, create sessions, accept actor JSON or expose tokens',async()=>{
  await assert.rejects(()=>startStaffPortal({NUKHBAPAY_STAFF_SESSION_MODE:'auth0'}),{message:'Staff HTTPS portal startup failed'});
  await assert.rejects(()=>startStaffPortal({}),{message:'Staff HTTPS portal startup failed'});
  const app=await createStaffPortal({pfx,certificate,passphrase,port:0});
  try{
    assert.equal((await call(app.origin,'/auth/session')).status,503);
    assert.deepEqual(JSON.parse((await call(app.origin,'/auth/config')).body),{loginPath:null});
    assert.equal((await call(app.origin,'/auth/me')).status,503);
    for(const path of ['/auth/login','/auth/callback','/auth/access-token','/auth/create','/auth/link','/auth/unlink','/auth/recovery','/auth/reset-password','/auth/reset-mfa','/api/v2/users','/api/v2/jobs/users-imports','/auth/session?actor=forged','/AUTH/SESSION','/auth/session/','/.env','/src/main.ts','/dist/main.js','/../../packages/database'])assert.equal((await call(app.origin,path)).status,404);
    assert.equal((await call(app.origin,'/auth/session','POST',{'content-type':'application/json'},'{"actor":"forged"}')).status,404);
    assert.equal((await call(app.origin,'/auth/logout','GET')).status,404);
    assert.equal((await call(app.origin,'/auth/session','HEAD')).status,404);
    assert.equal((await call(app.origin,'/','GET',{host:'attacker.invalid'})).status,400);
  }finally{await app.close();}
});
test('isolated platform HTTPS admission binds the signed step-up and confirms each prepared intent once',async()=>{
  const reservation=createNetServer();
  await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const address=reservation.address();assert.ok(address && typeof address!=='string');const port=address.port;
  await new Promise<void>(resolve=>reservation.close(()=>resolve()));
  const origin=`https://localhost:${port}`,path='/staff-api/commands/platform-security';
  const name='https://claims.synthetic.invalid/platform-factor', actionId=randomUUID(), receiptId=randomUUID(), auditId=randomUUID();
  const intent=Object.freeze({scope:'PLATFORM',actorStaffId:'00000000-0000-4000-8000-000000000001',intentDigest:'b'.repeat(64)} as const);
  const f=await fixture(`${origin}/auth/callback`,{tenantId:null},{
    stepUpPolicy:async command=>command.operation==='PLATFORM_STAFF_SECURITY' && command.intentDigest===intent.intentDigest,
    verifyStepUpFactor:createAuth0FactorClaimVerifier({claimName:name,version:'fixture-v1',acceptedFactors:['otp']}),
  });
  let applied=0;
  const consume=platformStaffAssuranceConsumer(f.login,'DISPOSABLE_PLATFORM_STAFF_EFFECT_V1');
  const platform: PlatformStaffPilotPort={capability:'DISPOSABLE_PLATFORM_STAFF_EFFECT_V1',
    async resolve(ref,staffId){return ref===actionId && staffId===intent.actorStaffId ? {intent,expiresAtMs:f.now().getTime()+30000} : null;},
    async execute(binding,proof,credential){
      if(!await consume(binding,proof,credential))return {kind:'DENIED'};
      applied++;
      return {kind:'APPLIED',receiptId,auditId,revokedSessions:1};
    }};
  await assert.rejects(createStaffPortal({pfx,certificate,passphrase,port,login:f.login,sessions:f.sessions,platformStaffPilot:platform,
    environment:{NODE_ENV:'production'}}));
  const app=await createStaffPortal({pfx,certificate,passphrase,port,login:f.login,sessions:f.sessions,platformStaffPilot:platform,environment:{}});
  try {
    const start=f.begin(), token=await f.login.complete(start.callback,start.cookie);
    const headers=async(cookie:string)=>({cookie,origin,'content-type':'application/json',
      'x-csrf-token':JSON.parse((await call(origin,'/auth/session','GET',{cookie})).body).csrfToken as string});
    const oldCookie=staffCookie(token).split(';')[0]!;
    assert.equal((await call(origin,path,'POST',{cookie:oldCookie,origin},JSON.stringify({actionId}))).status,403);
    assert.equal((await call(origin,path,'POST',await headers(oldCookie),JSON.stringify({actionId,tenantId:config.tenantId}))).status,400);
    const step=await call(origin,path,'POST',await headers(oldCookie),JSON.stringify({actionId}));
    assert.equal(step.status,200);
    const target=new URL(JSON.parse(step.body).location as string), nonce=target.searchParams.get('nonce');
    f.id({nonce,[name]:{version:'fixture-v1',challengeNonce:nonce,eventId:randomUUID(),factor:'otp',completedAtMs:f.now().getTime()}});
    const callback='/auth/callback?'+new URLSearchParams({code:'fixture-code',state:target.searchParams.get('state')!});
    const transaction=step.headers['set-cookie']![0]!.split(';')[0]!;
    const completed=await call(origin,callback,'GET',{cookie:transaction});
    assert.equal(completed.status,303);
    const cookie=completed.headers['set-cookie']![1]!.split(';')[0]!;
    assert.deepEqual(JSON.parse((await call(origin,path,'GET',{cookie})).body),{state:'READY'});
    assert.equal(applied,0);
    const requestHeaders=await headers(cookie);
    assert.equal((await call(origin,path+'/confirm','POST',requestHeaders,JSON.stringify({actionId}))).status,400);
    const result=await call(origin,path+'/confirm','POST',requestHeaders,'{}');
    assert.deepEqual(JSON.parse(result.body),{state:'APPLIED',receiptId,auditId,revokedSessions:1});
    assert.equal((await call(origin,path+'/confirm','POST',requestHeaders,'{}')).status,428);
    assert.equal(applied,1);
  } finally {await app.close();}
});
test('host-only session cookies and CSRF protect logout; failed audit/revocation never claims success',async()=>{
  const raw='A'.repeat(43);let active=true,failure=false,revokes=0;
  const app=await createStaffPortal({pfx,certificate,passphrase,port:0,sessions:{validate:async()=>({ok:active}),revoke:async()=>{
    if(failure)return {ok:false,reason:'UNAVAILABLE'};revokes++;active=false;return {ok:true};
  }}});
  try{
    const cookie=staffCookie(raw);assert.equal(cookie.includes('Domain='),false);
    for(const part of ['__Host-nukhbapay_staff=','Secure','HttpOnly','SameSite=Strict','Path=/'])assert.equal(cookie.includes(part),true);
    const header={cookie:cookie.split(';')[0]!};
    assert.equal((await call(app.origin,'/auth/session','GET',{...header,origin:'https://attacker.invalid'})).status,403);
    const status=await call(app.origin,'/auth/session','GET',header);assert.equal(status.status,200);assert.equal(status.body.includes(raw),false);
    const csrf=JSON.parse(status.body).csrfToken as string;
    const valid={...header,origin:app.origin,'content-type':'application/json','x-csrf-token':csrf};
    for(const headers of [{...valid,origin:'https://attacker.invalid'},{...valid,'x-csrf-token':'B'.repeat(43)},
      {...valid,'content-type':'application/x-www-form-urlencoded'},{...valid,'sec-fetch-site':'cross-site'},header]) {
      assert.equal((await call(app.origin,'/auth/logout','POST',headers,'{}')).status,403);
    }
    assert.equal((await call(app.origin,'/auth/session','GET',{cookie:header.cookie+'; '+header.cookie})).status,401);
    assert.equal((await call(app.origin,'/auth/logout','POST',valid,'{"actor":"forged"}')).status,400);
    assert.equal((await call(app.origin,'/auth/logout','POST',valid,'"'+'x'.repeat(5000)+'"')).status,413);
    assert.equal(revokes,0);failure=true;assert.equal((await call(app.origin,'/auth/logout','POST',valid,'{}')).status,503);
    failure=false;const logout=await call(app.origin,'/auth/logout','POST',valid,'{}');assert.equal(logout.status,204);
    assert.equal(String(logout.headers['set-cookie']).includes('Max-Age=0'),true);assert.equal((await call(app.origin,'/auth/session','GET',header)).status,401);
  }finally{await app.close();}
});

test('mock Auth0 browser round trip admits only the exact callback; logout revokes session and pending login',async()=>{
  const reservation=createNetServer();
  await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const address=reservation.address();assert.ok(address && typeof address!=='string');const port=address.port;
  await new Promise<void>(resolve=>reservation.close(()=>resolve()));
  const origin=`https://localhost:${port}`,f=await fixture(`${origin}/auth/callback`);
  const integration=await prepareStaffLoginIntegration({...config,callbackUrl:`${origin}/auth/callback`},
    {backend:f.backend,fetch:f.fetch,now:f.now});
  const app=await createStaffPortal({pfx,certificate,passphrase,port,sessions:integration.sessions,login:integration.login});
  try {
    assert.equal((await call(origin,'/auth/login','GET',{'sec-fetch-site':'cross-site'})).status,403);
    assert.equal((await call(origin,'/auth/login?tenant=forged')).status,404);
    const stale=staffCookie('A'.repeat(43)).split(';')[0]!;
    const start=await call(origin,'/auth/login','GET',{'sec-fetch-site':'none',cookie:stale});
    assert.equal(start.status,303);assert.equal(start.body,'');
    assert.match(start.headers['set-cookie']![1]!,/^__Host-nukhbapay_staff=;.*Max-Age=0$/);
    const auth=new URL(start.headers.location!),cookie=start.headers['set-cookie']![0]!.split(';')[0]!;
    // Fixture signs the nonce from the actual browser redirect, without contacting Auth0.
    f.id({nonce:auth.searchParams.get('nonce')!});
    const path='/auth/callback?'+new URLSearchParams({code:'synthetic-code',state:auth.searchParams.get('state')!});
    assert.equal((await call(origin,path,'GET',{cookie,'sec-fetch-site':'cross-site','sec-fetch-mode':'cors'})).status,403);
    assert.equal((await call(origin,path,'POST',{cookie,'sec-fetch-site':'cross-site'})).status,403);
    assert.equal((await call(origin,path,'GET',{cookie,origin:'https://attacker.invalid'})).status,403);
    const callback=await call(origin,path,'GET',{cookie,'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'});
    assert.equal(callback.status,303);assert.equal(callback.headers.location,'/');assert.equal(callback.body,'');
    assert.equal(callback.headers['referrer-policy'],'no-referrer');assert.equal(callback.headers['cache-control'],'no-store');
    const session=callback.headers['set-cookie']!.find(v=>v.startsWith('__Host-nukhbapay_staff='))!;
    assert.match(session,/Secure; HttpOnly; SameSite=Strict/);
    const raw=session.split(';')[0]!;
    const navigation={'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'};
    const landing=await call(origin,callback.headers.location!,'GET',navigation);
    assert.equal(landing.status,200);
    assert.match(String(landing.headers['content-type']),/^text\/html/);
    assert.match(String(landing.headers['content-security-policy']),/frame-ancestors 'none'/);
    for(const [landingPath,method,headers] of [
      ['/','GET',{...navigation,origin:'https://attacker.invalid'}],
      ['/','GET',{...navigation,'sec-fetch-mode':'cors'}],
      ['/','GET',{...navigation,'sec-fetch-dest':'iframe'}],
      ['/','GET',{'sec-fetch-site':'cross-site'}],
      ['/?next=invalid','GET',navigation],
      ['/','POST',navigation],
      ['/auth/me','GET',{...navigation,cookie:raw}],
      ['/auth/session','GET',{...navigation,cookie:raw}],
      ['/auth/workspace','GET',{...navigation,cookie:raw}],
    ] as const) {
      assert.equal((await call(origin,landingPath,method,headers)).status,403);
    }
    const status=await call(origin,'/auth/session','GET',{cookie:raw});assert.equal(status.status,200);
    assert.deepEqual(JSON.parse((await call(origin,'/auth/config')).body),{loginPath:'/auth/login'});
    assert.equal((await call(origin,'/auth/me')).status,401);
    const self=await call(origin,'/auth/me','GET',{cookie:raw});assert.equal(self.status,200);
    const projection=JSON.parse(self.body);
    assert.deepEqual(Object.keys(projection).sort(),['expiresAtMs','navigation','staffId','tenantId']);
    assert.deepEqual(projection.navigation,['/overview']);
    assert.equal((await call(origin,'/auth/workspace')).status,401);
    const workspace=await call(origin,'/auth/workspace','GET',{cookie:raw});
    assert.equal(workspace.status,200);
    assert.deepEqual(JSON.parse(workspace.body),{...projection,csrfToken:JSON.parse(status.body).csrfToken});
    assert.equal((await call(origin,'/auth/me?tenant=forged','GET',{cookie:raw})).status,404);
    assert.equal((await call(origin,'/auth/me','GET',{cookie:raw,origin:'https://attacker.invalid'})).status,403);
    const replay=await call(origin,path,'GET',{cookie,'sec-fetch-site':'cross-site'});assert.equal(replay.status,401);
    assert.deepEqual(JSON.parse(replay.body),{error:'Staff authentication failed'});
    const pending=await call(origin,'/auth/login','GET',{cookie:raw});assert.equal(pending.status,303);
    const pendingCookie=pending.headers['set-cookie']![0]!.split(';')[0]!;
    const logout=await call(origin,'/auth/logout','POST',{cookie:raw+'; '+pendingCookie,origin,'content-type':'application/json',
      'x-csrf-token':JSON.parse(status.body).csrfToken as string},'{}');
    assert.equal(logout.status,200);assert.equal(logout.headers['set-cookie']!.length,2);
    const logoutUrl=new URL(JSON.parse(logout.body).logoutUrl as string);
    assert.equal(logoutUrl.origin,'https://auth.synthetic.invalid');assert.equal(logoutUrl.pathname,'/v2/logout');
    assert.equal(logoutUrl.searchParams.get('returnTo'),origin+'/auth/logged-out');assert.equal(logoutUrl.searchParams.has('client_secret'),false);
    assert.equal((await call(origin,'/auth/logged-out','GET',{'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'})).status,200);
    assert.equal((await call(origin,'/auth/logged-out?returnTo=forged','GET',{'sec-fetch-site':'cross-site'})).status,403);
    assert.equal((await call(origin,'/auth/session','GET',{cookie:raw})).status,401);
    const pendingAuth=new URL(pending.headers.location!);
    assert.equal((await call(origin,'/auth/callback?'+new URLSearchParams({code:'synthetic-code',state:pendingAuth.searchParams.get('state')!}),
      'GET',{cookie:pendingCookie,'sec-fetch-site':'cross-site'})).status,401);
    assert.equal(f.exchanges(),1);
  }finally{integration.close();await app.close();}
});
test('integrated browser routes and assets retain HTTPS transport and auth boundaries',async()=>{
  const html=Buffer.from('<div id="root"></div><script src="/assets/test.js"></script>');
  const app=await createStaffPortal({pfx,certificate,passphrase,port:0,environment:{NODE_ENV:'development',NUKHBAPAY_STAFF_UI_PREVIEW:'enabled'},browserAssets:new Map([
    ['/index.html',{body:html,type:'text/html'}],
    ['/assets/test.js',{body:Buffer.from('/* public browser code */'),type:'text/javascript'}],
    ['/assets/App-demo.js',{body:Buffer.from('Maya Rahman'),type:'text/javascript',previewOnly:true}],
  ])});
  try {
    for(const path of ['/','/login','/overview','/staff?q=Maya','/staff/stf-1001','/preview/overview','/preview/login','/auth/logged-out']) {
      const response=await call(app.origin,path);
      assert.equal(response.status,200,path);assert.equal(response.body,html.toString());
      assert.equal(response.headers['cache-control'],'no-store');
      const csp=String(response.headers['content-security-policy']);
      assert.match(csp,/style-src 'self'/);assert.match(csp,/frame-ancestors 'none'/);assert.equal(csp.includes('unsafe-inline'),false);
    }
    assert.match(String((await call(app.origin,'/assets/test.js')).headers['content-type']),/text\/javascript/);
    assert.equal((await call(app.origin,'/assets/App-demo.js')).body,'Maya Rahman');
    for(const path of ['/.env','/src/main.tsx','/assets/test.js.map','/assets/../index.html','/%2e%2e/.env','/auth/login','/staff-api/v1/staff','/unknown']) {
      assert.equal((await call(app.origin,path)).status,404,path);
    }
    assert.equal((await call(app.origin,'/preview/overview','GET',{origin:'https://attacker.invalid'})).status,403);
    assert.equal((await call(app.origin,'/preview/overview','POST')).status,404);
    assert.equal((await call(app.origin,'/auth/session')).status,503);
  }finally{await app.close();}
});

test('default and production servers deny preview routes and direct demo chunk requests',async()=>{
  for(const environment of [{},{NODE_ENV:'development'},{NODE_ENV:'production',NUKHBAPAY_STAFF_UI_PREVIEW:'enabled'}]) {
    const app=await createStaffPortal({pfx,certificate,passphrase,port:0,environment,browserAssets:new Map([
      ['/index.html',{body:Buffer.from('<div id="root"></div>'),type:'text/html'}],
      ['/assets/App-demo.js',{body:Buffer.from('Maya Rahman'),type:'text/javascript',previewOnly:true}],
    ])});
    try {
      for(const path of ['/preview','/preview/overview','/preview/staff?q=Maya','/assets/App-demo.js','/assets/App-demo.js?enabled=true','/%70review/overview','/preview%2foverview']) {
        const response=await call(app.origin,path);
        assert.equal(response.status,404,path);assert.equal(response.body.includes('Maya Rahman'),false);
      }
      assert.equal((await call(app.origin,'/')).status,200);
      assert.equal((await call(app.origin,'/auth/session')).status,503);
    }finally{await app.close();}
  }
});

test('combined Auth0 and actual built assets preserve callback, preview isolation, logout policy and persistence failure',async()=>{
  const assets=loadBrowserAssets(fileURLToPath(new URL('../../dist/client/',import.meta.url)));
  const demoPaths=[...assets].filter(([,asset])=>asset.previewOnly).map(([url])=>url);
  assert.deepEqual(demoPaths,[],'The centralized dashboard must ship without the fictional preview bundle');
  const normalChunks=[...assets].filter(([,asset])=>!asset.previewOnly && asset.type==='text/javascript');
  for(const [,asset]of normalChunks)assert.equal(asset.body.includes(Buffer.from('Maya Rahman')),false);
  for(const environment of [{},{NODE_ENV:'production',NUKHBAPAY_STAFF_UI_PREVIEW:'enabled'}]) {
    const reservation=createNetServer();
    await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve));
    const address=reservation.address();assert.ok(address&&typeof address!=='string');
    const port=address.port;await new Promise<void>(resolve=>reservation.close(()=>resolve()));
    const origin=`https://localhost:${port}`,f=await fixture(`${origin}/auth/callback`);
    const app=await createStaffPortal({pfx,certificate,passphrase,port,sessions:f.sessions,login:f.login,browserAssets:assets,environment});
    try {
      const landing=await call(origin,'/staff?q=synthetic');
      assert.equal(landing.status,200);assert.match(landing.body,/name="nukhbapay-provider-logout"/);
      assert.ok(landing.body.includes(f.login.logoutUrl.replaceAll('&','&amp;')));
      assert.equal(landing.body.includes('synthetic-secret-'),false);
      assert.equal((await call(origin,'/staff','GET',{'sec-fetch-site':'cross-site'})).status,403);
      for(const url of ['/preview','/preview/overview',...demoPaths,'/frontend-handover/nukhbapay-staff-react/index.html',
        '/browser-boundary-report.json','/.vite/manifest.json','/src/auth0.ts','/test/fixtures/auth0-fixture.ts'])
        assert.equal((await call(origin,url)).status,404,url);
      const start=await call(origin,'/auth/login');assert.equal(start.status,303);
      const auth=new URL(start.headers.location!),transaction=start.headers['set-cookie']![0]!.split(';')[0]!;
      f.id({nonce:auth.searchParams.get('nonce')!});
      const callback='/auth/callback?'+new URLSearchParams({code:'synthetic-code',state:auth.searchParams.get('state')!});
      const result=await call(origin,callback,'GET',{cookie:transaction,'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'});
      assert.equal(result.status,303);assert.equal(result.headers.location,'/');
      assert.equal((await call(origin,callback,'GET',{cookie:transaction,'sec-fetch-site':'cross-site'})).status,401);
      const navigation={'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'};
      const failed=await call(origin,'/auth/callback?error=fixture','GET',navigation);
      assert.equal(failed.status,303);
      assert.equal(failed.headers.location,'/login?sign-in=failed');
      assert.equal((await call(origin,failed.headers.location!,'GET',navigation)).status,200);
      assert.equal((await call(origin,'/login?sign-in=failed&returnTo=forged','GET',navigation)).status,403);
      const session=result.headers['set-cookie']!.find(cookie=>cookie.startsWith('__Host-nukhbapay_staff='))!.split(';')[0]!;
      const status=await call(origin,'/auth/session','GET',{cookie:session});assert.equal(status.status,200);
      // Revocation audit belongs to the atomic session store, not the identity lookup audit writer.
      if(environment.NODE_ENV==='production')f.store();
      const logout=await call(origin,'/auth/logout','POST',{cookie:session,origin,'content-type':'application/json',
        'x-csrf-token':JSON.parse(status.body).csrfToken as string},'{}');
      if(environment.NODE_ENV==='production') {
        assert.equal(logout.status,503);assert.equal(logout.headers['set-cookie'],undefined);assert.equal(logout.body.includes('logoutUrl'),false);
      }else {
        assert.equal(logout.status,200);assert.deepEqual(JSON.parse(logout.body),{logoutUrl:f.login.logoutUrl});
        assert.equal((await call(origin,'/auth/session','GET',{cookie:session})).status,401);
      }
      assert.equal((await call(origin,'/auth/logged-out','GET',{'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'})).status,200);
      assert.equal((await call(origin,'/auth/logged-out?returnTo=forged','GET',{'sec-fetch-site':'cross-site'})).status,403);
    } finally {await app.close();}
  }
});

test('catalogue BFF forwards an allowlisted read with verified server session and derived tenant',async()=>{
  const reservation=createNetServer();
  await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const address=reservation.address();
  assert.ok(address&&typeof address!=='string');
  const port=address.port;await new Promise<void>(resolve=>reservation.close(()=>resolve()));
  const origin=`https://localhost:${port}`,f=await fixture(`${origin}/auth/callback`);
  let calls=0,staffCalls=0;
  let catalogueAvailable=true;
  const app=await createStaffPortal({pfx,certificate,passphrase,port,sessions:f.sessions,login:f.login,
    staffCatalogue:{async available(identity,tenant){
      assert.equal(identity.subject,'synthetic-staff');
      assert.equal(tenant,config.tenantId);
      return catalogueAvailable;
    },async read(identity,tenant,view,query){
      calls++;
      assert.equal(identity.subject,'synthetic-staff');
      assert.equal(tenant,config.tenantId);
      assert.equal(view,'countries');
      assert.equal(query['group'],'GCC');
      return {revision:'fixture-v1',items:[{id:'AE',name:'United Arab Emirates'}],next:null,previous:null,count:1};
    }},
    staffManagement:{async availableViews(identity,tenant){
      assert.equal(identity.subject,'synthetic-staff');
      assert.equal(tenant,config.tenantId);
      return ['STAFF'];
    },async read(identity,tenant,view,query){
      staffCalls++;
      assert.equal(identity.subject,'synthetic-staff');
      assert.equal(tenant,config.tenantId);
      assert.equal(view,'STAFF');
      assert.equal(query['limit'],'1');
      return {items:[],next:null};
    }}});
  try {
    const started=f.begin();
    const token=await f.login.complete(started.callback,started.cookie);
    const cookie=staffCookie(token).split(';')[0]!;
    assert.equal((await call(origin,'/staff-api/catalogue/countries?group=GCC')).status,401);
    assert.equal((await call(origin,'/staff-api/catalogue/countries?group=GCC','GET',{cookie,origin:'https://other.invalid'})).status,403);
    assert.equal((await call(origin,'/staff-api/catalogue/countries?group=GCC&tenant=forged','GET',{cookie})).status,400);
    assert.equal((await call(origin,'/staff-api/catalogue/countries?group=GCC&group=EUROPE','GET',{cookie})).status,400);
    assert.equal((await call(origin,'/staff-api/catalogue/countries?group=GCC','GET',{cookie,authorization:'Bearer forged'})).status,400);
    assert.equal((await call(origin,'/staff-api/catalogue/countries','POST',{cookie})).status,404);
    assert.equal(calls,0);
    assert.deepEqual(JSON.parse((await call(origin,'/auth/me','GET',{cookie})).body).navigation,['/overview','/staff','/catalogue']);
    assert.deepEqual(JSON.parse((await call(origin,'/auth/workspace','GET',{cookie})).body).navigation,['/overview','/staff','/catalogue']);
    catalogueAvailable=false;
    assert.deepEqual(JSON.parse((await call(origin,'/auth/workspace','GET',{cookie})).body).navigation,['/overview','/staff']);
    assert.equal(staffCalls,0);
    assert.equal((await call(origin,'/staff-api/catalogue/countries?group=GCC','GET',{cookie})).status,200);
    assert.equal(calls,1);
    assert.equal((await call(origin,'/staff-api/staff?limit=1','GET',{cookie})).status,200);
    assert.equal((await call(origin,'/staff-api/staff?limit=1&actor=forged','GET',{cookie})).status,400);
    assert.equal((await call(origin,'/staff-api/staff/not-a-staff-id','GET',{cookie})).status,400);
    assert.equal(staffCalls,1);
    f.membership();
    assert.equal((await call(origin,'/staff-api/catalogue/countries?group=GCC','GET',{cookie})).status,403);
    assert.equal(calls,1);
  } finally {await app.close();}
});

test('privileged browser admission requires CSRF, fresh step-up and one explicit confirmation',async()=>{
  const reservation=createNetServer();
  await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const address=reservation.address();
  assert.ok(address&&typeof address!=='string');
  const port=address.port;await new Promise<void>(resolve=>reservation.close(()=>resolve()));
  const origin=`https://localhost:${port}`;
  const actor='00000000-0000-4000-8000-000000000001', requestId='00000000-0000-4000-8000-000000000033';
  const target='00000000-0000-4000-8000-000000000034',idempotencyKey='00000000-0000-4000-8000-000000000035';
  let version='1', event=0,applied=0,reviewed=0;
  const f=await fixture(`${origin}/auth/callback`,{},{
    stepUpPolicy:async()=>true,
    verifyStepUpFactor:async claims=>({eventId:`00000000-0000-4000-8000-${String(++event).padStart(12,'0')}`,
      authenticatedAtMs:Number(claims['auth_time'])*1000}),
  });
  const suspension={
    capability:'DISPOSABLE_STAFF_EFFECT_V1' as const,
    async resolve(_identity:unknown,tenantId:string,staffId:string,id:string,key:string,decision?:import('../src/auth0.js').StaffReviewDecision) {
      if (id!==requestId || key!==idempotencyKey || staffId!==actor || tenantId!==config.tenantId) return null;
      const binding={actorStaffId:staffId,tenantId,targetStaffId:target,requestId:id,requestVersion:version,
        requestDigest:'a'.repeat(64),approvalDigest:'c'.repeat(64),idempotencyKey:key,expiresAtMs:Date.UTC(2026,10,13)+120000};
      return decision ? {...binding,decision,slot:'SECURITY_ADMIN' as const,
        operation:'DECIDE_SUSPENSION' as const,permission:'platform.access.approve' as const}
        : {...binding,operation:'SUSPEND_MEMBERSHIP' as const,permission:'tenant.staff.suspend' as const};
    },
    async execute(command:import('../src/auth0.js').StaffStepUpCommand,proof:import('../src/auth0.js').StaffStepUpProof,token:string) {
      const verified=await f.login.consumeStepUp(proof,command,token);
      if (!verified || !verified.factorEvent) return {kind:'DENIED' as const};
      if (command.operation==='DECIDE_SUSPENSION') {reviewed++;return {kind:'RECORDED' as const};}
      applied++;
      return {kind:'APPLIED' as const};
    },
  };
  await assert.rejects(createStaffPortal({pfx,certificate,passphrase,port,sessions:f.sessions,login:f.login,
    staffSuspension:suspension,environment:{NODE_ENV:'production'}}));
  const app=await createStaffPortal({pfx,certificate,passphrase,port,sessions:f.sessions,login:f.login,staffSuspension:suspension,environment:{}});
  const path='/staff-api/commands/suspension';
  const payload=JSON.stringify({requestId,idempotencyKey});
  let raw='';
  try {
    const transaction=f.begin();
    raw=await f.login.complete(transaction.callback,transaction.cookie);
    const credentials=async()=>{
      const cookie=staffCookie(raw).split(';')[0]!;
      const session=await call(origin,'/auth/session','GET',{cookie});
      assert.equal(session.status,200);
      return {cookie,origin,'content-type':'application/json','x-csrf-token':JSON.parse(session.body).csrfToken as string};
    };
    async function stepUp(body=payload) {
      const response=await call(origin,path,'POST',await credentials(),body);
      assert.equal(response.status,200,response.body);
      const location=new URL(JSON.parse(response.body).location as string);
      f.id({nonce:location.searchParams.get('nonce')!});
      const query='/auth/callback?'+new URLSearchParams({code:'synthetic-code',state:location.searchParams.get('state')!});
      const tx=response.headers['set-cookie']![0]!.split(';')[0]!;
      const callback=await call(origin,query,'GET',{cookie:tx,'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'});
      assert.equal(callback.status,303,callback.body);
      assert.equal(callback.headers.location,'/staff/commands');
      assert.equal((await call(origin,query,'GET',{cookie:tx})).status,401);
      raw=callback.headers['set-cookie']!.find(v=>v.startsWith('__Host-nukhbapay_staff='))!.split(';')[0]!.split('=')[1]!;
    }
    assert.equal((await call(origin,path)).status,401);
    const initial=await credentials();
    assert.equal((await call(origin,path,'POST',{...initial,'x-csrf-token':'A'.repeat(43)},payload)).status,403);
    assert.equal((await call(origin,path,'POST',{...initial,origin:'https://other.invalid'},payload)).status,403);
    assert.equal((await call(origin,path,'POST',initial,JSON.stringify({requestId,idempotencyKey,tenantId:config.tenantId}))).status,400);
    assert.equal((await call(origin,path+'/confirm','POST',initial,'{}')).status,428);
    await stepUp();
    assert.equal(applied,0);
    assert.equal((await call(origin,path,'GET',initial)).status,401);
    const ready=await credentials();
    assert.deepEqual(JSON.parse((await call(origin,path,'GET',ready)).body),{state:'READY',requestId,requestVersion:'1',targetStaffId:target});
    assert.equal((await call(origin,path+'/confirm','POST',ready,'{"target":"forged"}')).status,400);
    version='2';
    assert.equal((await call(origin,path+'/confirm','POST',ready,'{}')).status,403);
    assert.equal(applied,0);
    await stepUp();
    f.advance(60_000);
    const aged=await credentials();
    assert.deepEqual(JSON.parse((await call(origin,path,'GET',aged)).body),{state:'STEP_UP_REQUIRED'});
    assert.equal((await call(origin,path+'/confirm','POST',aged,'{}')).status,428);
    await stepUp();
    const exact=await credentials();
    const concurrent=await Promise.all([call(origin,path+'/confirm','POST',exact,'{}'),call(origin,path+'/confirm','POST',exact,'{}')]);
    assert.deepEqual(concurrent.map(result=>result.status).sort(),[200,428]);
    assert.equal(applied,1);
    const reviewPayload=JSON.stringify({requestId,idempotencyKey,decision:'REJECT'});
    assert.equal((await call(origin,path,'POST',exact,JSON.stringify({requestId,idempotencyKey,decision:'APPROVE',slot:'SECURITY_ADMIN'}))).status,400);
    await stepUp(reviewPayload);
    const review=await credentials();
    assert.deepEqual(JSON.parse((await call(origin,path,'GET',review)).body),
      {state:'READY',requestId,requestVersion:'2',targetStaffId:target,decision:'REJECT'});
    assert.equal((await call(origin,path+'/confirm','POST',review,'{"decision":"APPROVE"}')).status,400);
    const recorded=await call(origin,path+'/confirm','POST',review,'{}');
    assert.equal(recorded.status,200);
    assert.deepEqual(JSON.parse(recorded.body),{state:'RECORDED'});
    assert.equal(reviewed,1);
    await f.sessions.revoke(raw);
    assert.equal((await call(origin,path,'GET',review)).status,401);
  } finally {await app.close();}
});

test('disposable HTTPS publication binds role, command, MFA and final session to an audited confirmation',async()=>{
  const reservation=createNetServer();
  await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const address=reservation.address();
  assert.ok(address&&typeof address!=='string');
  const {port}=address;
  await new Promise<void>(resolve=>reservation.close(()=>resolve()));
  const origin=`https://localhost:${port}`,path='/staff-api/commands/publication';
  const actor='00000000-0000-4000-8000-000000000001', productId='00000000-0000-4000-8000-000000000040';
  const candidateId='a'.repeat(64),idempotencyKey='00000000-0000-4000-8000-000000000041';
  let role='PRICING_APPROVER',version=1n,execution=0,expire=false,factorChecks=0;
  const f=await fixture(origin+'/auth/callback',{},{
    stepUpPolicy:async()=>true,
    verifyStepUpFactor: async (claims,challenge)=>{
      assert.equal(challenge.issuer,config.issuer);
      assert.equal(challenge.subject,'synthetic-staff');
      assert.equal(challenge.audience,config.audience);
      assert.equal(challenge.clientId,config.clientId);
      assert.equal(challenge.nonce,claims['nonce']);
      factorChecks++;
      return {eventId:randomUUID(),authenticatedAtMs:Number(claims['auth_time'])*1000};
    },
  });
  const publication={
    authority:{capability:'ISOLATED_SYNTHETIC_PUBLICATION_ONLY' as const,now:f.now,auditWriter:f.backend.auditWriter,
      repository:{...f.backend.repository,
        findTenantMembership:async(staffId:string,tenantId:string)=>staffId===actor&&tenantId===config.tenantId
          ? {membershipId:productId,tenantId,status:'ACTIVE' as const,version,roleGrants:[{roleCode:role,scope:'TENANT' as const,
            grantedAt:'2026-11-12T00:00:00Z',expiresAt:null,revokedAt:null}]} : null},
      allows:async()=>true},
    async executePublication(value:import('@nukhbapay/application').PublicationCommandTicket) {
      const ticket=consumePublicationCommand(value);
      if(expire)f.advance(5_000);
      if(!await ticket.revalidate())throw new Error('Fixture commit guard denied');
      execution++;
      return {operationId:productId,candidateId,action:ticket.command.action,synthetic:true as const,
        execution:'NOT_AUTHORIZED' as const,replayed:false};
    },
  };
  await assert.rejects(createStaffPortal({pfx,certificate,passphrase,port,login:f.login,sessions:f.sessions,
    staffPublication:publication,environment:{NODE_ENV:'production'}}));
  const app=await createStaffPortal({pfx,certificate,passphrase,port,login:f.login,sessions:f.sessions,staffPublication:publication,environment:{}});
  const body={action:'APPROVE',productId,candidateId,candidateVersion:1,expectedActiveId:null,rollbackSourceId:null,
    idempotencyKey,reason:null};
  let token='';
  async function credentials() {
    const cookie=staffCookie(token).split(';')[0]!;
    const check=await call(origin,'/auth/session','GET',{cookie});
    assert.equal(check.status,200);
    return {cookie,origin,'content-type':'application/json','x-csrf-token':JSON.parse(check.body).csrfToken as string};
  }
  async function authorize() {
    const start=await call(origin,path,'POST',await credentials(),JSON.stringify(body));
    assert.equal(start.status,200,start.body);
    const location=new URL(JSON.parse(start.body).location as string);
    f.id({nonce:location.searchParams.get('nonce')});
    const query='/auth/callback?'+new URLSearchParams({code:'fixture',state:location.searchParams.get('state')!});
    const callback=await call(origin,query,'GET',{cookie:start.headers['set-cookie']![0]!.split(';')[0]!,
      'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'});
    assert.equal(callback.status,303,callback.body);
    assert.equal(callback.headers.location,'/catalogue/publication');
    token=callback.headers['set-cookie']!.find(value=>value.startsWith('__Host-nukhbapay_staff='))!.split(';')[0]!.split('=')[1]!;
    return credentials();
  }
  try {
    const start=f.begin();
    token=await f.login.complete(start.callback,start.cookie);
    const headers=await credentials();
    assert.equal((await call(origin,path,'POST',{...headers,'x-csrf-token':'B'.repeat(43)},JSON.stringify(body))).status,403);
    assert.equal((await call(origin,path,'POST',headers,JSON.stringify({...body,tenantId:config.tenantId}))).status,400);
    assert.equal((await call(origin,path,'POST',headers,JSON.stringify({...body,totalMinor:'1'}))).status,403);
    role='SUPPORT_AGENT';
    assert.equal((await call(origin,path,'POST',headers,JSON.stringify(body))).status,403);
    role='PRICING_APPROVER';
    const stale=await authorize();
    version++;
    assert.equal((await call(origin,path+'/confirm','POST',stale,'{}')).status,403);
    assert.equal(execution,0);
    const ready=await authorize();
    assert.deepEqual(JSON.parse((await call(origin,path,'GET',ready)).body),{state:'READY',...body,tenantId:config.tenantId});
    assert.equal((await call(origin,path+'/confirm','POST',ready,'{"candidateVersion":2}')).status,400);
    const results=await Promise.all([call(origin,path+'/confirm','POST',ready,'{}'),call(origin,path+'/confirm','POST',ready,'{}')]);
    assert.deepEqual(results.map(row=>row.status).sort(),[200,428]);
    assert.equal(execution,1);
    const expiring=await authorize();
    expire=true;
    assert.equal((await call(origin,path+'/confirm','POST',expiring,'{}')).status,503);
    assert.equal(execution,1);
    assert.equal(factorChecks,3);
  } finally {await app.close();}
});
