import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createAuth0FactorClaimVerifier } from '../src/auth0-factor-claim.js';
import { beginPlatformStaffStepUp, platformStaffAssuranceConsumer } from '../src/platform-staff-step-up.js';
import { fixture } from './fixtures/auth0-fixture.js';

const staffId='00000000-0000-4000-8000-000000000001';
const intent={scope:'PLATFORM',actorStaffId:staffId,intentDigest:'a'.repeat(64)} as const;
const name='https://claims.synthetic.invalid/platform-factor';

test('signed Auth0 callback on a platform session binds factor assurance once to the exact platform intent',async()=>{
  const eventId=randomUUID();
  const f=await fixture(undefined,{tenantId:null},{
    stepUpPolicy:async command=>command.operation==='PLATFORM_STAFF_SECURITY' && command.intentDigest===intent.intentDigest,
    verifyStepUpFactor:createAuth0FactorClaimVerifier({claimName:name,version:'fixture-v1',acceptedFactors:['otp']}),
  });
  try {
    const initial=f.begin(), token=await f.login.complete(initial.callback,initial.cookie);
    await assert.rejects(f.login.readForSession(token,async()=>true));
    assert.equal(await f.login.readForPlatformSession(token,async(_identity,staff)=>staff),staffId);
    const deadline=f.now().getTime()+25000;
    const start=f.callbackFor(await beginPlatformStaffStepUp(f.login,intent,token,deadline));
    f.id({[name]:{version:'fixture-v1',eventId,challengeNonce:start.url.searchParams.get('nonce'),factor:'otp',completedAtMs:f.now().getTime()}});
    const result=await f.login.completeBrowserCallback(start.callback,start.cookie,token);
    assert.ok(result.stepUp && result.stepUp.command.operation==='PLATFORM_STAFF_SECURITY');
    assert.equal((await f.sessions.validate(token)).ok,false);
    const consume=platformStaffAssuranceConsumer(f.login,'DISPOSABLE_PLATFORM_STAFF_EFFECT_V1');
    assert.equal(await consume({...intent,intentDigest:'b'.repeat(64)},result.stepUp,result.token),null);
    assert.equal(await consume(intent,{...result.stepUp,proof:{}},result.token),null);
    const assurance=await consume(intent,result.stepUp,result.token);
    assert.equal(assurance?.actorStaffId,staffId);
    assert.equal(assurance.eventId,eventId);
    assert.equal(await assurance.revalidate(),true);
    assert.equal(await consume(intent,result.stepUp,result.token),null);
    const repeated=f.callbackFor(await beginPlatformStaffStepUp(f.login,intent,result.token,deadline));
    f.id({[name]:{version:'fixture-v1',eventId,challengeNonce:repeated.url.searchParams.get('nonce'),factor:'otp',completedAtMs:f.now().getTime()}});
    await assert.rejects(f.login.completeBrowserCallback(repeated.callback,repeated.cookie,result.token));
    f.version();
    assert.equal(await assurance.revalidate(),false);
  } finally { f.login.close(); }
});

test('a tenant session cannot start a platform challenge and signed wrong-nonce evidence cannot rotate a platform session',async()=>{
  const dependencies={stepUpPolicy:async()=>true,
    verifyStepUpFactor:createAuth0FactorClaimVerifier({claimName:name,version:'fixture-v1',acceptedFactors:['otp']})};
  const tenant=await fixture(undefined,{},dependencies), platform=await fixture(undefined,{tenantId:null},dependencies);
  try {
    const initial=tenant.begin(), token=await tenant.login.complete(initial.callback,initial.cookie);
    await assert.rejects(beginPlatformStaffStepUp(tenant.login,intent,token,tenant.now().getTime()+1000));
    const other=platform.begin(), session=await platform.login.complete(other.callback,other.cookie);
    const start=platform.callbackFor(await beginPlatformStaffStepUp(platform.login,intent,session,platform.now().getTime()+1000));
    platform.id({[name]:{version:'fixture-v1',eventId:randomUUID(),challengeNonce:'different-challenge',factor:'otp',completedAtMs:platform.now().getTime()}});
    await assert.rejects(platform.login.completeBrowserCallback(start.callback,start.cookie,session));
    assert.equal((await platform.sessions.validate(session)).ok,true);
  } finally { tenant.login.close(); platform.login.close(); }
});
