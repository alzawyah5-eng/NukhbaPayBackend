import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Auth0VerificationOnly } from '../src/auth0-verification-only.js';
import { config, fixture } from './fixtures/auth0-fixture.js';

type Claims = Record<string, unknown>;

test('initial staff flow accepts only absent or exact openid scope and absent or empty API permissions', async t => {
  for (const [index, claims] of ([{}, { scope: 'openid' }, { permissions: [] }, { scope: 'openid', permissions: [] }] as Claims[]).entries()) {
    await t.test(`minimal profile ${index}`, async () => {
      const f = await fixture(), start = f.begin(); f.access(claims);
      const token = await f.login.complete(start.callback, start.cookie);
      assert.equal((await f.sessions.validate(token)).ok, true);
    });
  }
});

test('staff flow rejects management/linking/import/recovery scopes and assigned API permissions', async t => {
  const claims: Claims[] = [
    ...['update:current_user_identities', 'update:users', 'create:users', 'delete:users',
      'create:user_tickets', 'read:users', 'create:client_grants', 'update:client_grants', 'update:clients', 'update:client_keys', 'update:client_credentials', 'offline_access', 'profile', 'email', 'OPENID', '', 'openid openid',
      'openid\tupdate:users', 'openid update:current_user_identities'].map(scope => ({ scope })),
    { scope: ['openid'] }, { scope: null }, { scope: { value: 'openid' } },
    ...[['update:current_user_identities'], ['update:users'], ['create:users'], ['create:client_grants'], ['update:client_grants'], ['update:clients'], ['update:client_keys'], ['update:client_credentials'], ['staff.self.read'],
      [null], [{ permission: 'update:users' }], 'update:users', null, {}].map(permissions => ({ permissions })),
  ];
  for (const [index, change] of claims.entries()) await t.test(`unexpected privilege profile ${index}`, async () => {
    const f = await fixture(), start = f.begin(); f.access(change);
    await assert.rejects(() => f.login.complete(start.callback, start.cookie), { message: 'Staff authentication failed' });
    assert.equal(f.rows.size, 0);
    assert.equal(f.auditEvents.length, 0); // Rejected before any application actor/audit port is reached.
    await assert.rejects(() => f.login.complete(start.callback, start.cookie));
    assert.equal(f.exchanges(), 1);
  });
});

test('verification-only harness shares privilege rejection and still supplies no application authority', async () => {
  for (const change of [{ scope: 'openid', permissions: [] }, { scope: 'openid update:current_user_identities' },
    { permissions: ['update:users'] }]) {
    const f = await fixture(), verifier = new Auth0VerificationOnly(config, { fetch: f.fetch, now: f.now });
    const start = verifier.begin(), url = new URL(start.location);
    f.id({ nonce: url.searchParams.get('nonce')! }); f.access(change);
    const outcome = await verifier.complete('/auth/callback?' + new URLSearchParams({
      code: 'synthetic-code', state: url.searchParams.get('state')!,
    }), start.cookie.split(';')[0]!.split('=')[1]!);
    assert.deepEqual(outcome, { verified: change.scope === 'openid', sessionCreated: false });
    assert.equal(f.rows.size, 0); assert.equal(f.auditEvents.length, 0);
  }
});

test('created/imported/linked replacement identities cannot enroll by email, roles or metadata', async t => {
  for (const subject of ['auth0|unapproved-created', 'auth0|unapproved-imported', 'auth0|linked-primary', 'SYNTHETIC-STAFF']) {
    await t.test(subject, async () => {
      const f = await fixture(), start = f.begin();
      const untrusted = { sub: subject, email: 'approved-staff@synthetic.invalid', email_verified: true,
        roles: ['TENANT_ADMIN'], app_metadata: { staff: true }, user_metadata: { principal: 'human' } };
      f.id(untrusted); f.access({ ...untrusted, scope: 'openid', permissions: [] });
      await assert.rejects(() => f.login.complete(start.callback, start.cookie), { message: 'Staff authentication failed' });
      assert.equal(f.rows.size, 0);
      assert.equal(f.auditEvents.length, 1);
      const event = f.auditEvents[0]!;
      assert.equal(event.action, 'STAFF_IDENTITY_RESOLUTION'); assert.equal(event.outcome, 'DENIED');
      assert.equal(event.actorStaffId, null); assert.equal(event.tenantId, null); assert.equal(event.targetId, null);
      for (const forbidden of [subject, untrusted.email, config.clientSecret, 'TENANT_ADMIN', 'app_metadata']) {
        assert.equal(JSON.stringify(event).includes(forbidden), false);
      }
    });
  }
});

test('provider recovery flags and verified email do not substitute for signed native MFA', async () => {
  const f = await fixture(), start = f.begin();
  f.id({ amr: ['pwd'], email_verified: true, recovery_complete: true, mfa_enrolled: true });
  f.access({ amr: ['mfa'], auth_time: f.now().getTime() / 1000, scope: 'openid', permissions: [] });
  await assert.rejects(() => f.login.complete(start.callback, start.cookie), { message: 'Staff authentication failed' });
  assert.equal(f.rows.size, 0); assert.equal(f.auditEvents.length, 0);
});

test('recovery cutoff rejects prior/equal issuance and old sessions; only fresh enrolled identity can return', async () => {
  const f = await fixture(), start = f.begin(), old = await f.login.complete(start.callback, start.cookie);
  f.cutoff(f.now().toISOString());
  assert.equal((await f.sessions.validate(old)).ok, false);
  const equal = f.begin();
  await assert.rejects(() => f.login.complete(equal.callback, equal.cookie));
  assert.equal(f.rows.size, 1);
  f.advance(1000);
  const fresh = f.begin(), current = await f.login.complete(fresh.callback, fresh.cookie);
  assert.equal((await f.sessions.validate(current)).ok, true);
  // Even an invalid rollback of the fixture cutoff cannot resurrect a blocked old actor.
  f.cutoff(null); assert.equal((await f.sessions.validate(old)).ok, false);
});

test('restoration cannot resurrect a denied session or silently replace its internal staff binding', async () => {
  for (const kind of ['staff', 'identity', 'substitution'] as const) {
    const f = await fixture(), start = f.begin(), old = await f.login.complete(start.callback, start.cookie);
    if (kind === 'staff') f.suspend();
    if (kind === 'identity') f.disabledIdentity();
    if (kind === 'substitution') f.rebindStaff('00000000-0000-4000-8000-000000000099');
    assert.equal((await f.sessions.validate(old)).ok, false);
    f.restoreStaff(); f.restoreIdentity(); f.rebindStaff('00000000-0000-4000-8000-000000000001');
    assert.equal((await f.sessions.validate(old)).ok, false);
  }
  const f = await fixture(), first = f.begin(), old = await f.login.complete(first.callback, first.cookie);
  f.rebindStaff('00000000-0000-4000-8000-000000000099');
  const rotated = f.begin(old);
  await assert.rejects(() => f.login.complete(rotated.callback, rotated.cookie));
  assert.equal(f.rows.size, 1);
});
