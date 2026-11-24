import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSession, readLoginPath, sessionExpiryDelay, signOut, providerLogoutDestination, serverLogoutPolicy } from '../client/src/session.js';

const profile={staffId:'00000000-0000-4000-8000-000000000001',tenantId:'00000000-0000-4000-8000-000000000002',
  expiresAtMs:Date.UTC(2026,10,14),navigation:['/overview']};

test('session client distinguishes denied, expired, unavailable and malformed responses without fallback identity', async () => {
  const original = globalThis.fetch;
  try {
    for (const [status, kind] of [[401, 'anonymous'], [403, 'forbidden'], [503, 'unavailable']] as const) {
      globalThis.fetch = async (url, init) => {
        assert.equal(url, '/auth/workspace'); assert.equal(init?.credentials, 'same-origin'); assert.equal(init?.cache, 'no-store');
        return new Response('{}', { status });
      };
      assert.deepEqual(await readSession(), { kind });
    }
    for (const payload of [{ authenticated: true }, { authenticated: false }, { authenticated: true, csrfToken: 'forged' }]) {
      globalThis.fetch = async () => Response.json(payload);
      assert.deepEqual(await readSession(), { kind: 'unavailable' });
    }
    let calls=0;
    globalThis.fetch = async url => {
      assert.equal(url,'/auth/workspace');
      calls++;
      return Response.json({...profile,csrfToken:'A'.repeat(43)});
    };
    assert.deepEqual(await readSession(), { kind: 'authenticated', csrfToken: 'A'.repeat(43),profile });
    assert.equal(calls,1);
    globalThis.fetch = async () => { throw new Error('Offline'); };
    assert.deepEqual(await readSession(), { kind: 'unavailable' });
  } finally { globalThis.fetch = original; }
});

test('login and known workspace routes come from the BFF; invalid profiles and token fields are rejected',async()=>{
  const original=globalThis.fetch;
  try {
    for(const loginPath of [null,'https://attacker.invalid','//attacker.invalid','/auth/login?tenant=forged']) {
      globalThis.fetch=async()=>Response.json({loginPath});assert.equal(await readLoginPath(),undefined);
    }
    globalThis.fetch=async(url,init)=>{assert.equal(url,'/auth/config');assert.equal(init?.cache,'no-store');return Response.json({loginPath:'/auth/login'});};
    assert.equal(await readLoginPath(),'/auth/login');
    globalThis.fetch=async()=>Response.json({...profile,navigation:['/overview','/roles','/staff/invite'],csrfToken:'A'.repeat(43)});
    const managerSession=await readSession();
    assert.equal(managerSession.kind,'authenticated');
    if(managerSession.kind==='authenticated')assert.deepEqual(managerSession.profile.navigation,['/overview','/roles','/staff/invite']);
    for(const payload of [{...profile,navigation:['/overview','/platform/roles']},
      {...profile,navigation:['/overview','/roles','/roles']},{...profile,staffId:'forged'},
      {...profile,tenantId:null,navigation:['/overview','/staff']},{...profile,tenantId:'forged'},
      {...profile,expiresAtMs:NaN},{...profile,accessToken:'forged'}]) {
      globalThis.fetch=async()=>Response.json({...payload,csrfToken:'A'.repeat(43)});
      assert.deepEqual(await readSession(),{kind:'unavailable'});
    }
    const authorized={...profile,navigation:['/overview','/staff','/audit']};
    globalThis.fetch=async()=>Response.json({...authorized,csrfToken:'A'.repeat(43)});
    assert.deepEqual(await readSession(),{kind:'authenticated',csrfToken:'A'.repeat(43),profile:authorized});
    assert.equal(sessionExpiryDelay(1000,1100),0);assert.equal(sessionExpiryDelay(2000,1000),1000);
  }finally{globalThis.fetch=original;}
});

test('logout sends only the CSRF token and confirms success only after the BFF returns 204', async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [204, 200, 401, 403, 503]) {
      globalThis.fetch = async (url, init) => {
        assert.equal(url, '/auth/logout'); assert.equal(init?.method, 'POST'); assert.equal(init?.body, '{}');
        assert.equal(init?.credentials, 'same-origin');
        assert.deepEqual(init?.headers, { 'content-type': 'application/json', 'x-csrf-token': 'A'.repeat(43) });
        return new Response(null, { status });
      };
      assert.deepEqual(await signOut('A'.repeat(43)),status===204?{ok:true,destination:'/auth/logged-out'}:{ok:false});
    }
    globalThis.fetch = async () => { throw new Error('Offline'); };
    assert.deepEqual(await signOut('A'.repeat(43)), {ok:false});
  } finally { globalThis.fetch = original; }
});

test('provider logout requires exact server-rendered allowlist and rejects hostile destinations',async()=>{
  const origin='https://localhost:3001';
  const approved='https://auth.synthetic.invalid/v2/logout?client_id=synthetic-browser&returnTo='+encodeURIComponent(origin+'/auth/logged-out');
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async()=>Response.json({logoutUrl:approved});
    assert.deepEqual(await signOut('A'.repeat(43),approved,origin),{ok:true,destination:approved});
    assert.deepEqual(await signOut('A'.repeat(43)),{ok:false});
    for(const destination of ['https://attacker.invalid/v2/logout','//attacker.invalid','javascript:alert(1)',
      approved.replace('https:','http:'),approved.replace('auth.synthetic.invalid','auth.synthetic.invalid.attacker.invalid'),
      approved.replace('synthetic-browser','other-client'),approved+'&returnTo=https://attacker.invalid',approved+'#fragment',
      approved.replace(encodeURIComponent(origin+'/auth/logged-out'),encodeURIComponent('https://attacker.invalid'))]) {
      globalThis.fetch=async()=>Response.json({logoutUrl:destination});
      assert.deepEqual(await signOut('A'.repeat(43),approved,origin),{ok:false});
    }
    for(const payload of [{},{logoutUrl:approved,token:'forged'},[approved],null]) {
      globalThis.fetch=async()=>Response.json(payload);
      assert.deepEqual(await signOut('A'.repeat(43),approved,origin),{ok:false});
    }
    assert.equal(providerLogoutDestination(approved,approved,'https://attacker.invalid'),undefined);
    const documentWith=(values:string[])=>({querySelectorAll:()=>values.map(content=>({getAttribute:()=>content}))}) as unknown as Pick<Document,'querySelectorAll'>;
    assert.equal(serverLogoutPolicy(documentWith([])),undefined);
    assert.equal(serverLogoutPolicy(documentWith([approved,approved])),undefined);
    assert.equal(serverLogoutPolicy(documentWith([approved])),approved);
  }finally{globalThis.fetch=original;}
});
