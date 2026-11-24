import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { test } from 'node:test';
import type { StaffStepUpCommand } from '../src/auth0.js';
import { prepareStaffLoginIntegration } from '../src/staff-login-integration.js';
import { config, fixture } from './fixtures/auth0-fixture.js';

// Synthetic transport and existing in-memory backend ports only: no pool, listener or real login.
type Integration = Awaited<ReturnType<typeof prepareStaffLoginIntegration>>;
type Tokens = Awaited<ReturnType<typeof fixture>>;
function begin(integration: Integration, tokens: Tokens) {
  return callbackFor(integration.login.begin(), tokens);
}
function callbackFor(started: { location: string; cookie: string }, tokens: Tokens) {
  const url = new URL(started.location);
  tokens.id({ nonce: url.searchParams.get('nonce')! });
  return { cookie: started.cookie.split(';')[0]!.split('=')[1]!,
    callback: '/auth/callback?' + new URLSearchParams({ code: 'synthetic-code', state: url.searchParams.get('state')! }) };
}
async function setup(settings = { ...config }) {
  const tokens = await fixture();
  const integration = await prepareStaffLoginIntegration(settings, { backend: tokens.backend, fetch: tokens.fetch, now: tokens.now });
  return { tokens, integration };
}
async function signIn(integration: Integration, tokens: Tokens) {
  const start = begin(integration, tokens);
  return integration.login.complete(start.callback, start.cookie);
}

test('trusted assembly reuses signed verification and Track A ports without enrolling or issuing anything during preparation', async () => {
  const { tokens, integration } = await setup();
  try {
    assert.equal(tokens.exchanges(), 0); assert.equal(tokens.rows.size, 0); assert.equal(tokens.auditEvents.length, 0);
    assert.equal(await integration.checkReadiness(), true);
    const cookie = await signIn(integration, tokens), profile = await integration.sessions.readProfile(cookie);
    assert.equal(profile.ok, true);
    if (!profile.ok) throw new Error('Synthetic profile unavailable');
    assert.equal(profile.execution, 'NOT_AUTHORIZED'); assert.equal(profile.profile.tenantId, config.tenantId);
    assert.deepEqual(Object.keys(profile.profile).sort(), ['expiresAtMs', 'staffId', 'tenantId']);
    assert.equal(profile.profile.expiresAtMs, tokens.now().getTime() + 300_000);
    assert.equal(tokens.rows.size, 1); assert.equal(tokens.exchanges(), 1);
    assert.ok(tokens.auditEvents.length > 0);
    for (const rendered of [JSON.stringify(integration), inspect(integration), JSON.stringify(integration.sessions), inspect(integration.sessions)]) {
      assert.equal(rendered.includes(config.clientSecret), false); assert.equal(rendered.includes(cookie), false);
      assert.equal(rendered.includes(config.issuer), false);
    }
  } finally { integration.close(); }
});

test('unknown, suspended, disabled and cross-tenant identities cannot create a restricted session through assembly', async t => {
  for (const mode of ['unknown', 'suspended', 'disabled', 'membership', 'cross-tenant'] as const) await t.test(mode, async () => {
    const { tokens, integration } = await setup({ ...config,
      ...(mode === 'cross-tenant' ? { tenantId: '00000000-0000-4000-8000-000000000099' } : {}) });
    try {
      if (mode === 'unknown') tokens.unenroll();
      if (mode === 'suspended') tokens.suspend();
      if (mode === 'disabled') tokens.disabledIdentity();
      if (mode === 'membership') tokens.membership();
      await assert.rejects(() => signIn(integration, tokens), { message: 'Staff authentication failed' });
      assert.equal(tokens.rows.size, 0);
      assert.equal(JSON.stringify(tokens.auditEvents).includes('synthetic-staff'), false);
    } finally { integration.close(); }
  });
});

test('stale readiness cannot turn IAM, audit or store failure into successful authentication', async t => {
  for (const mode of ['identity', 'audit', 'store'] as const) await t.test(mode, async () => {
    const tokens = await fixture();
    const integration = await prepareStaffLoginIntegration(config, { backend: { ...tokens.backend, checkReadiness: async () => true },
      fetch: tokens.fetch, now: tokens.now });
    try {
      if (mode === 'identity') tokens.database();
      if (mode === 'audit') tokens.audit();
      if (mode === 'store') tokens.store();
      await assert.rejects(() => signIn(integration, tokens), { message: 'Staff authentication failed' });
      assert.equal(tokens.rows.size, 0);
    } finally { integration.close(); }
  });
});

test('observed recovery cutoff and identity substitution invalidate existing authority without silent restoration', async t => {
  for (const mode of ['cutoff', 'substitution', 'suspension'] as const) await t.test(mode, async () => {
    const { tokens, integration } = await setup();
    try {
      const cookie = await signIn(integration, tokens);
      if (mode === 'cutoff') tokens.cutoff(tokens.now().toISOString());
      if (mode === 'substitution') tokens.rebindStaff('00000000-0000-4000-8000-000000000099');
      if (mode === 'suspension') tokens.suspend();
      assert.equal((await integration.sessions.readProfile(cookie)).ok, false);
      tokens.cutoff(null); tokens.restoreStaff(); tokens.rebindStaff('00000000-0000-4000-8000-000000000001');
      assert.equal((await integration.sessions.validate(cookie)).ok, false);
      assert.equal([...tokens.rows.values()].every(row => row.revoked), true);
    } finally { integration.close(); }
  });
});

test('committed logout is required and old credentials cannot return after assembly restart', async () => {
  const { tokens, integration } = await setup();
  const cookie = await signIn(integration, tokens);
  assert.equal((await integration.sessions.verifyRevocation(cookie)).ok, false);
  assert.equal((await integration.sessions.revoke(cookie)).ok, true);
  assert.equal((await integration.sessions.verifyRevocation(cookie)).ok, true);
  assert.equal((await integration.sessions.validate(cookie)).ok, false);
  integration.close();
  const restarted = await prepareStaffLoginIntegration(config, { backend: tokens.backend, fetch: tokens.fetch, now: tokens.now });
  try {
    assert.equal((await restarted.sessions.readProfile(cookie)).ok, false);
    assert.equal((await restarted.sessions.validate(cookie)).ok, false);
  } finally { restarted.close(); }
});

test('restart refuses an unrevoked stored credential without an instance-bound actor', async () => {
  const { tokens, integration } = await setup(), cookie = await signIn(integration, tokens);
  assert.equal([...tokens.rows.values()].some(row => row.revoked), false);
  integration.close();
  const restarted = await prepareStaffLoginIntegration(config, { backend: tokens.backend, fetch: tokens.fetch, now: tokens.now });
  try { assert.equal((await restarted.sessions.readProfile(cookie)).ok, false); }
  finally { restarted.close(); }
});

test('readiness loss denies profile and logout acknowledgement, and close cannot be reopened', async () => {
  const { tokens, integration } = await setup(), cookie = await signIn(integration, tokens);
  tokens.store();
  assert.equal(await integration.checkReadiness(), false);
  assert.equal((await integration.sessions.readProfile(cookie)).ok, false);
  assert.equal((await integration.sessions.revoke(cookie)).ok, false);
  integration.close(); integration.close();
  assert.equal(await integration.checkReadiness(), false);
  assert.throws(() => integration.login.begin(), { message: 'Staff authentication failed' });
});

test('close during a store acknowledgement cannot return a session credential', { timeout: 5000 }, async () => {
  const { tokens, integration } = await setup();
  let entered!: () => void, release!: () => void;
  const writing = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  tokens.pauseStore(async () => { entered(); await released; });
  const result = signIn(integration, tokens);
  const rejected = assert.rejects(result, { message: 'Staff authentication failed' });
  try {
    await writing; integration.close(); release(); await rejected;
    assert.equal(await integration.checkReadiness(), false);
  } finally { release(); integration.close(); }
});

test('configuration and backend method substitution cannot rebind prepared authority', async () => {
  const tokens = await fixture(), settings = { ...config };
  const repository = { ...tokens.backend.repository }, sessionStore = { ...tokens.backend.sessionStore };
  const backend = { ...tokens.backend, repository, sessionStore };
  const integration = await prepareStaffLoginIntegration(settings, { backend, fetch: tokens.fetch, now: tokens.now });
  let substituted = 0;
  try {
    settings.tenantId = '00000000-0000-4000-8000-000000000099'; settings.issuer = 'https://substitution.synthetic.invalid/';
    repository.findByTrustedIdentity = async () => { substituted++; return null; };
    sessionStore.execute = async () => { substituted++; return 'DENIED'; };
    backend.checkReadiness = async () => true;
    const cookie = await signIn(integration, tokens), profile = await integration.sessions.readProfile(cookie);
    assert.equal(profile.ok, true); assert.equal(substituted, 0);
    tokens.database(); assert.equal(await integration.checkReadiness(), false);
  } finally { integration.close(); }
});

test('assembly pins step-up ports before awaiting readiness and passes the verifier signal', async () => {
  const tokens = await fixture();
  let release!: (ready: boolean) => void;
  const readiness = new Promise<boolean>(resolve => { release = resolve; });
  let verifierSignal: AbortSignal | undefined, replacementCalls = 0;
  const stepUp = {
    stepUpPolicy: async (): Promise<boolean> => true,
    verifyStepUpFactor: async (_claims, challenge, signal) => {
      verifierSignal = signal;
      return { eventId: '00000000-0000-4000-8000-000000000008', authenticatedAtMs: challenge.challengeStartedAtMs };
    },
  } satisfies NonNullable<Parameters<typeof prepareStaffLoginIntegration>[1]['stepUp']>;
  const preparing = prepareStaffLoginIntegration(config, { backend: { ...tokens.backend, checkReadiness: () => readiness },
    fetch: tokens.fetch, now: tokens.now, stepUp });
  stepUp.stepUpPolicy = async () => { replacementCalls++; return false; };
  stepUp.verifyStepUpFactor = async () => { replacementCalls++; throw new Error('Substituted verifier'); };
  release(true);
  const integration = await preparing;
  try {
    const session = await signIn(integration, tokens);
    const command: StaffStepUpCommand = { operation: 'SUSPEND_MEMBERSHIP', permission: 'tenant.staff.suspend',
      actorStaffId: '00000000-0000-4000-8000-000000000001', tenantId: config.tenantId,
      targetStaffId: '00000000-0000-4000-8000-000000000003', requestId: '00000000-0000-4000-8000-000000000004',
      idempotencyKey: '00000000-0000-4000-8000-000000000005', requestVersion: '1',
      requestDigest: 'a'.repeat(64), approvalDigest: 'b'.repeat(64), expiresAtMs: tokens.now().getTime() + 30000 };
    const request = callbackFor(await integration.login.beginStepUp(command, session), tokens);
    const { token, proof } = await integration.login.completeStepUp(request.callback, request.cookie, session);
    assert.ok(verifierSignal && !verifierSignal.aborted);
    assert.ok(await integration.login.consumeStepUp(proof, command, token));
    assert.equal(replacementCalls, 0);
  } finally { integration.close(); }
});

test('unready, malformed or throwing backend readiness fails preparation without private diagnostics', async () => {
  const tokens = await fixture();
  for (const checkReadiness of [async () => false, async () => 'true' as unknown as boolean,
    async () => { throw new Error(config.clientSecret); }]) {
    await assert.rejects(() => prepareStaffLoginIntegration(config, { backend: { ...tokens.backend, checkReadiness },
      fetch: tokens.fetch, now: tokens.now }), { message: 'Staff login integration unavailable' });
  }
  const invalid = { backend: tokens.backend, now: tokens.now } as unknown as Parameters<typeof prepareStaffLoginIntegration>[1];
  await assert.rejects(() => prepareStaffLoginIntegration(config, invalid), { message: 'Staff login integration unavailable' });
  assert.equal(tokens.exchanges(), 0); assert.equal(tokens.rows.size, 0);
});

test('concurrent readiness coalesces and a pending healthy result cannot override close', async () => {
  const tokens = await fixture(); let slow = false, calls = 0, release!: (ready: boolean) => void;
  const integration = await prepareStaffLoginIntegration(config, { backend: { ...tokens.backend, checkReadiness: async () => {
    calls++; return slow ? new Promise<boolean>(resolve => { release = resolve; }) : true;
  } }, fetch: tokens.fetch, now: tokens.now });
  slow = true;
  const first = integration.checkReadiness(), second = integration.checkReadiness();
  assert.equal(first, second); await Promise.resolve();
  integration.close(); release(true);
  assert.equal(await first, false); assert.equal(await second, false); assert.equal(calls, 2);
});
