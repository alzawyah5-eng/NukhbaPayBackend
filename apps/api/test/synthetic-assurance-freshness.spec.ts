import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { SyntheticAssuranceChallenge } from '@nukhbapay/application';
import { LocalSyntheticAssuranceVerifier } from '../src/modules/identity/synthetic-assurance-verifier.js';
import { NOW } from './fixtures/oidc-test-issuer.js';
import { syntheticAssuranceProvider } from './fixtures/synthetic-assurance-provider.js';

test('signed assurance expiry and clock rollback during verification fail closed', async () => {
  const provider = await syntheticAssuranceProvider({ verify: async () => { throw new Error('Unused access verifier'); } }, () => new Date(NOW));
  const challenge = Object.freeze({
    id: randomUUID(), bindingDigest: 'a'.repeat(64), issuedAtMs: NOW, expiresAtMs: NOW + 60000,
    binding: Object.freeze({ identitySubject: 'synthetic' }),
  }) as SyntheticAssuranceChallenge;
  const assertion = await provider.signFault(provider.payload(challenge));
  const keys = [provider.publicJwk];
  const verify = (now: () => Date) =>
    new LocalSyntheticAssuranceVerifier({ mode: 'test', keys, now }).verify(assertion, challenge);
  assert.equal((await verify(() => new Date(NOW))).challengeId, challenge.id);
  for (const finish of [NOW + 60000, NOW - 1, NaN]) {
    let reads = 0;
    await assert.rejects(verify(() => new Date(reads++ === 0 ? NOW : finish)), /verification failed/);
  }
});
