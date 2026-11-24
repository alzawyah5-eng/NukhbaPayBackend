import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { test } from 'node:test';
import { Auth0VerificationOnly } from '../src/auth0-verification-only.js';
import { config, fixture } from './fixtures/auth0-fixture.js';

const seconds = Date.UTC(2026, 10, 13) / 1000;
type Claims = Record<string, unknown>;

test('verification-only uses the existing signed pair checks and never establishes staff or creates a session', async () => {
  const f = await fixture();
  const verifier = new Auth0VerificationOnly(config, { fetch: f.fetch, now: f.now });
  assert.equal(JSON.stringify(verifier), '"[Auth0VerificationOnly: internal]"');
  assert.equal(inspect(verifier).includes(config.clientSecret), false);
  const started = verifier.begin(), url = new URL(started.location);
  f.id({ nonce: url.searchParams.get('nonce')! });
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://localhost:3001/auth/callback');
  assert.equal(url.searchParams.get('scope'), 'openid');
  const callback = '/auth/callback?' + new URLSearchParams({ code: 'synthetic-code', state: url.searchParams.get('state')! });
  const cookie = started.cookie.split(';')[0]!.split('=')[1]!;
  const result = await verifier.complete(callback, cookie);
  assert.deepEqual(result, { verified: true, sessionCreated: false });
  assert.equal(f.rows.size, 0);
  assert.equal(f.exchanges(), 1);
  assert.equal(f.body().get('code_verifier')!.length, 43);
  assert.equal(JSON.stringify(result).includes('synthetic-staff'), false);
  assert.equal(JSON.stringify(result).includes('token'), false);
  assert.deepEqual(await verifier.complete(callback, cookie), { verified: false, sessionCreated: false });
  assert.throws(() => verifier.begin());
});

test('verification-only fails closed on cryptographic, issuer, client, principal, native MFA and freshness failures', async t => {
  const cases: [string, 'id' | 'access' | 'idHeader' | 'accessHeader' | 'tokens' | 'mode' | 'wrongKey' | 'state' | 'cookie' | 'close', Claims | string][] = [
    ['signature', 'wrongKey', {}], ['issuer', 'access', { iss: 'https://wrong.invalid/' }],
    ['ID issuer', 'id', { iss: 'https://wrong.invalid/' }],
    ['API audience', 'access', { aud: 'urn:wrong' }], ['ID audience', 'id', { aud: 'other-client' }],
    ['client', 'access', { client_id: 'other' }], ['azp', 'id', { azp: 'other' }],
    ['subject binding', 'access', { sub: 'other-human' }], ['nonce', 'id', { nonce: 'wrong' }],
    ['human missing', 'access', { [config.staffKindClaim]: undefined }],
    ['human wrong', 'access', { [config.staffKindClaim]: 'machine' }],
    ['human ID only', 'access', { [config.staffKindClaim]: undefined }],
    ['MFA missing', 'id', { amr: ['pwd'] }], ['MFA fabricated in access', 'id', { amr: undefined }],
    ['MFA malformed', 'id', { amr: 'mfa' }], ['auth_time absent', 'id', { auth_time: undefined }],
    ['auth_time stale', 'id', { auth_time: seconds - 301 }], ['auth_time pretransaction', 'id', { auth_time: seconds - 1 }],
    ['auth_time future', 'id', { auth_time: seconds + 1 }], ['expired', 'access', { exp: seconds }],
    ['long access', 'access', { exp: seconds + 301 }], ['long ID', 'id', { exp: seconds + 3601 }],
    ['access type', 'accessHeader', { typ: 'JWT' }], ['ID type', 'idHeader', { typ: 'at+jwt' }],
    ['key URL', 'accessHeader', { jku: 'https://wrong.invalid/' }],
    ['delegation', 'access', { act: null }], ['machine profile', 'access', { client_profile: null }],
    ['token type', 'tokens', { token_type: 'bearer' }], ['refresh', 'tokens', { refresh_token: 'synthetic-private' }],
    ['response lifetime', 'tokens', { expires_in: 301 }], ['state', 'state', {}], ['cookie', 'cookie', {}],
    ['closed', 'close', {}], ['private JWKS', 'mode', 'jwks-private'], ['JWKS error', 'mode', 'jwks-error'],
    ['exchange error', 'mode', 'error'], ['redirect', 'mode', 'redirect'], ['oversize', 'mode', 'oversize'],
    ['bad JSON', 'mode', 'bad-json'],
  ];
  for (const [name, kind, changes] of cases) await t.test(name, async () => {
    const f = await fixture(), verifier = new Auth0VerificationOnly(config, { fetch: f.fetch, now: f.now });
    const started = verifier.begin(), url = new URL(started.location);
    f.id({ nonce: url.searchParams.get('nonce')!, [config.staffKindClaim]: 'human' });
    f.access({ amr: ['mfa'], auth_time: seconds }); // Access MFA cannot substitute for ID evidence.
    if (kind === 'mode') f.mode(changes as string);
    else if (kind === 'wrongKey') f.wrongKey();
    else if (kind === 'close') verifier.close();
    else if (kind !== 'state' && kind !== 'cookie') {
      const claims = changes as Claims;
      f[kind](kind === 'id' ? { nonce: url.searchParams.get('nonce')!, ...claims } : claims);
    }
    const callback = '/auth/callback?' + new URLSearchParams({ code: 'synthetic-code', state: kind === 'state' ? 'x'.repeat(43) : url.searchParams.get('state')! });
    const cookie = kind === 'cookie' ? undefined : started.cookie.split(';')[0]!.split('=')[1]!;
    assert.deepEqual(await verifier.complete(callback, cookie), { verified: false, sessionCreated: false });
    assert.equal(f.rows.size, 0);
    const exchanges = f.exchanges();
    assert.deepEqual(await verifier.complete(callback, cookie), { verified: false, sessionCreated: false });
    assert.equal(f.exchanges(), exchanges);
  });
});

test('verification-only consumes concurrent callbacks and denies expired transactions', async () => {
  const f = await fixture(), verifier = new Auth0VerificationOnly(config, { fetch: f.fetch, now: f.now });
  const started = verifier.begin(), url = new URL(started.location);
  f.id({ nonce: url.searchParams.get('nonce')! });
  const callback = '/auth/callback?' + new URLSearchParams({ code: 'synthetic-code', state: url.searchParams.get('state')! });
  const cookie = started.cookie.split(';')[0]!.split('=')[1]!;
  const results = await Promise.all([verifier.complete(callback, cookie), verifier.complete(callback, cookie)]);
  assert.equal(results.filter(r => r.verified).length, 1); assert.equal(f.exchanges(), 1); assert.equal(f.rows.size, 0);
  const expired = new Auth0VerificationOnly(config, { fetch: f.fetch, now: f.now });
  const expiredStart = expired.begin(), expiredUrl = new URL(expiredStart.location);
  const expiredCookie = expiredStart.cookie.split(';')[0]!.split('=')[1]!;
  const expiredCallback = '/auth/callback?' + new URLSearchParams({ code: 'synthetic-code', state: expiredUrl.searchParams.get('state')! });
  f.advance(300_000);
  assert.equal((await expired.complete(expiredCallback, expiredCookie)).verified, false);
  assert.equal(f.exchanges(), 1);
});

test('closing verification during an in-flight provider exchange suppresses acceptance', async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const exchanging = new Promise<void>(resolve => { entered = resolve; });
  const verifier = new Auth0VerificationOnly(config, { now: f.now, fetch: async (url, options) => {
    if (String(url).endsWith('/oauth/token')) { entered(); await gate; }
    return f.fetch(url, options);
  } });
  const started = verifier.begin(), url = new URL(started.location);
  f.id({ nonce: url.searchParams.get('nonce')! });
  const callback = '/auth/callback?' + new URLSearchParams({ code: 'synthetic-code', state: url.searchParams.get('state')! });
  const pending = verifier.complete(callback, started.cookie.split(';')[0]!.split('=')[1]!);
  await exchanging; verifier.close(); release();
  assert.deepEqual(await pending, { verified: false, sessionCreated: false });
  assert.equal(f.rows.size, 0);
});
