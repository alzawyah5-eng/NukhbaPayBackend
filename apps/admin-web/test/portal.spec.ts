import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { request } from "node:https";
import { rootCertificates } from "node:tls";
import { fileURLToPath } from "node:url";
import { createServer as createNetServer } from "node:net";
import { createStaffPortal, staffCookie } from "../src/portal.js";
import { startStaffPortal } from "../src/main.js";
import { fixture } from "./fixtures/auth0-fixture.js";
import { loadBrowserAssets } from "../src/browser-assets.js";

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
test('HTTPS portal presents a valid localhost certificate and rejects untrusted or wrong-host TLS',async()=>{
  const app=await createStaffPortal({pfx,certificate,passphrase,port:0});
  try {
    const root=await call(app.origin,'/','GET',{'sec-fetch-site':'none'});assert.equal(root.status,200);assert.match(root.body,/Nukhbapay Staff Portal/);
    assert.match(String(root.headers['content-security-policy']),/frame-ancestors 'none'/);assert.equal(root.headers['cache-control'],'no-store');
    await assert.rejects(()=>call(app.origin,'/','GET',{},undefined,false));
    await assert.rejects(()=>call(app.origin,'/','GET',{},undefined,true,'wrong.synthetic.invalid'));
    assert.equal((await call(app.origin,'/health/live')).status,200);
  }finally{await app.close();await app.close();}
  await assert.rejects(()=>call(app.origin));
});
test('CLI and default BFF cannot activate Auth0, create sessions, accept actor JSON or expose tokens',async()=>{
  await assert.rejects(()=>startStaffPortal({NUKHBAPAY_STAFF_SESSION_MODE:'auth0'}),{message:'Staff HTTPS portal startup failed'});
  await assert.rejects(()=>startStaffPortal({}),{message:'Staff HTTPS portal startup failed'});
  const app=await createStaffPortal({pfx,certificate,passphrase,port:0});
  try{
    assert.equal((await call(app.origin,'/auth/session')).status,503);
    for(const path of ['/auth/login','/auth/callback','/auth/access-token','/auth/create','/auth/session?actor=forged','/AUTH/SESSION','/auth/session/','/.env','/src/main.ts','/dist/main.js','/../../packages/database'])assert.equal((await call(app.origin,path)).status,404);
    assert.equal((await call(app.origin,'/auth/session','POST',{'content-type':'application/json'},'{"actor":"forged"}')).status,404);
    assert.equal((await call(app.origin,'/auth/logout','GET')).status,404);
    assert.equal((await call(app.origin,'/auth/session','HEAD')).status,404);
    assert.equal((await call(app.origin,'/','GET',{host:'attacker.invalid'})).status,400);
  }finally{await app.close();}
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
  const app=await createStaffPortal({pfx,certificate,passphrase,port,sessions:f.sessions,login:f.login});
  try {
    assert.equal((await call(origin,'/auth/login','GET',{'sec-fetch-site':'cross-site'})).status,403);
    assert.equal((await call(origin,'/auth/login?tenant=forged')).status,404);
    const start=await call(origin,'/auth/login','GET',{'sec-fetch-site':'none'});
    assert.equal(start.status,303);assert.equal(start.body,'');
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
    const raw=session.split(';')[0]!,status=await call(origin,'/auth/session','GET',{cookie:raw});assert.equal(status.status,200);
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
  }finally{await app.close();}
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
  assert.ok(demoPaths.length>0,'The actual preview must remain in a dynamic chunk');
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
      for(const url of ['/preview','/preview/overview',...demoPaths,'/frontend-handover/nukhbapay-staff-react/index.html'])
        assert.equal((await call(origin,url)).status,404,url);
      const start=await call(origin,'/auth/login');assert.equal(start.status,303);
      const auth=new URL(start.headers.location!),transaction=start.headers['set-cookie']![0]!.split(';')[0]!;
      f.id({nonce:auth.searchParams.get('nonce')!});
      const callback='/auth/callback?'+new URLSearchParams({code:'synthetic-code',state:auth.searchParams.get('state')!});
      const result=await call(origin,callback,'GET',{cookie:transaction,'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'});
      assert.equal(result.status,303);assert.equal(result.headers.location,'/');
      assert.equal((await call(origin,callback,'GET',{cookie:transaction,'sec-fetch-site':'cross-site'})).status,401);
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
