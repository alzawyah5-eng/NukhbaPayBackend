import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createServer } from 'node:net';
import test from 'node:test';
import { createStaffPortal } from '../src/portal.js';
import { fixture } from './fixtures/auth0-fixture.js';

test('AWS staging serves management and kiosk through HTTPS forwarding and provides a load-balancer health check',async()=>{
  const listener=createServer();
  await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const address=listener.address();
  assert.ok(address && typeof address!=='string');
  const {port}=address;
  await new Promise<void>(resolve=>listener.close(()=>resolve()));

  const origin='https://staging.nukhbapay.com';
  const f=await fixture(origin+'/auth/callback',{deployment:'aws-staging'});
  const reject=async()=>{throw new Error('Unexpected staff data access');};
  let ready=true;
  const app=await createStaffPortal({
    port,staging:{checkReadiness:async()=>ready},environment:{NODE_ENV:'production',NUKHBAPAY_ENVIRONMENT:'aws-staging'},
    login:f.login,sessions:f.sessions,staffCatalogue:{read:reject},
    staffWorkspace:{availableViews:reject,read:reject,command:reject},departmentAccess:{positions:async()=>[]},
    browserAssets:new Map([['/index.html',{body:Buffer.from('<html><head></head><body>staff fixture</body></html>'),type:'text/html'}]]),
    kioskAssets:new Map([['/kiosk',{body:Buffer.from('kiosk fixture'),type:'text/html'}]]),
  });
  const call=(path:string,headers:Record<string,string>={})=>new Promise<{status:number;body:string}>((resolve,rejectRequest)=>{
    const req=request({hostname:'127.0.0.1',port,path,headers},res=>{
      let body='';
      res.setEncoding('utf8');
      res.on('data',text=>body+=text);
      res.on('end',()=>resolve({status:res.statusCode!,body}));
    });
    req.on('error',rejectRequest);
    req.end();
  });
  try {
    const forwarded={host:'staging.nukhbapay.com','x-forwarded-proto':'https'};
    assert.equal((await call('/health/ready')).status,200);
    ready=false;
    assert.equal((await call('/health/ready')).status,503);
    assert.equal((await call('/management')).status,403);
    assert.equal((await call('/management',{...forwarded,host:'nukhbapay.com'})).status,400);
    const management=await call('/management',forwarded);
    assert.equal(management.status,200);
    assert.match(management.body,/staff fixture/);
    assert.deepEqual(await call('/kiosk',forwarded),{status:200,body:'kiosk fixture'});
    assert.equal((await call('/staff-api/catalogue/discoveries',forwarded)).status,401);
  } finally {
    await app.close();
  }
});
