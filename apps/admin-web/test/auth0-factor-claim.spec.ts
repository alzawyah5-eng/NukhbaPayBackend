import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuth0FactorClaimVerifier } from '../src/auth0-factor-claim.js';

const name = 'https://fixture.invalid/staff-factor';
const config = { claimName: name, version: 'pilot-v1', acceptedFactors: ['otp'] };
const challenge = { issuer:'https://auth.fixture.invalid/', subject:'fixture-person', audience:'fixture-api', clientId:'fixture-client',
  nonce:'fixture-challenge', challengeStartedAtMs:1234, credentialExpiresAtMs:2234 };
const proof = { version:config.version, eventId:'00000000-0000-4000-8000-000000000001', challengeNonce:challenge.nonce, factor:'otp', completedAtMs:1500 };
const claims = { iss:challenge.issuer, sub:challenge.subject, aud:challenge.clientId, nonce:challenge.nonce, [name]:proof };
const signal = new AbortController().signal;

test('the configured signed Auth0 claim preserves the explicit event identity and completion timestamp', async()=>{
  const verifier=createAuth0FactorClaimVerifier(config);
  const result=await verifier(claims,challenge,signal);
  assert.deepEqual(result,{eventId:proof.eventId,authenticatedAtMs:proof.completedAtMs});
  assert.ok(Object.isFrozen(result));
});

test('Auth0 claim verification fails closed on wrong issuer, subject, audience, nonce, factor, expiry or schema', async()=>{
  const verify=createAuth0FactorClaimVerifier(config);
  for(const value of [
    { ...claims, iss:'https://other.fixture.invalid/' }, { ...claims, sub:'another-person' },
    { ...claims, aud:challenge.audience }, { ...claims, nonce:'another-nonce' },
    { ...claims, [name]:{...proof,challengeNonce:'other-command'} }, { ...claims, [name]:{...proof,factor:'recovery-code'} },
    { ...claims, [name]:{...proof,completedAtMs:challenge.credentialExpiresAtMs} },
    { ...claims, [name]:{...proof,completedAtMs:challenge.challengeStartedAtMs-1} },
    { ...claims, [name]:{...proof,eventId:'not-provider-evidence'} }, { ...claims, [name]:{...proof,synthetic:true} },
    { ...claims, [name]:{...proof,version:'different'} }, { iss:claims.iss,sub:claims.sub,aud:claims.aud,nonce:claims.nonce,amr:['mfa'] },
  ]) assert.equal(await verify(value,challenge,signal),null);
  assert.equal(await verify(claims,challenge,AbortSignal.abort()),null);
  assert.throws(()=>createAuth0FactorClaimVerifier({...config,acceptedFactors:['recovery-code']}),/Invalid Auth0/);
});
