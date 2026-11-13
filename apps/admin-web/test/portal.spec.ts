import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { request } from "node:https";
import { rootCertificates } from "node:tls";
import { createStaffPortal, staffCookie } from "../src/portal.js";
import { startStaffPortal } from "../src/main.js";

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
