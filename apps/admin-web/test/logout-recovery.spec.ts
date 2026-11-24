import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareStaffLoginIntegration } from '../src/staff-login-integration.js';
import { config, fixture } from './fixtures/auth0-fixture.js';

test('logout during readiness loss remains denied after backend recovery and supports durable reconciliation', async () => {
  const f=await fixture();let ready=true;
  const integration=await prepareStaffLoginIntegration(config,{backend:{...f.backend,checkReadiness:async()=>ready},fetch:f.fetch,now:f.now});
  try {
    const start=integration.login.begin(),url=new URL(start.location);
    f.id({nonce:url.searchParams.get('nonce')!});
    const cookie=start.cookie.split(';')[0]!.split('=')[1]!;
    const raw=await integration.login.complete('/auth/callback?'+new URLSearchParams({code:'synthetic-code',state:url.searchParams.get('state')!}),cookie);
    assert.equal((await integration.sessions.readProfile(raw)).ok,true);
    ready=false;
    assert.equal((await integration.sessions.revoke(raw)).ok,false);
    assert.equal([...f.rows.values()].every(row=>!row.revoked),true);
    ready=true;
    assert.equal((await integration.sessions.validate(raw)).ok,false);
    assert.equal((await integration.sessions.readProfile(raw)).ok,false);
    assert.equal((await integration.sessions.revoke(raw)).ok,true);
    assert.equal((await integration.sessions.verifyRevocation(raw)).ok,true);
  } finally {integration.close();}
});
