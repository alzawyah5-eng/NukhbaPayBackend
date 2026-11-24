import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TrustedStaffActorBoundary } from '@nukhbapay/application';
import { Auth0Login } from '../src/auth0.js';
import { config, fixture } from './fixtures/auth0-fixture.js';

// Reuse the real verifier and backend boundary. No StaffSessionLifecycle, database or real session store.
const tenant = config.tenantId, staff = '00000000-0000-4000-8000-000000000001';
async function contract(mode: 'approved' | 'unknown' | 'cross-tenant' | 'inactive' | 'audit-failure') {
  const tokens = await fixture();
  let actorCalls = 0, sessionAttempts = 0, enrolledReads = 0;
  const decisions: { allowed: boolean; execution: string }[] = [];
  const audits: unknown[] = [];
  const boundary = new TrustedStaffActorBoundary({ now: tokens.now, sessionIssuers: [config.issuer],
    repository: {
      findByTrustedIdentity: async identity => {
        enrolledReads++;
        if (mode === 'unknown' || identity.issuer !== config.issuer || identity.subject !== 'synthetic-staff') return null;
        return { staffId: staff, staffStatus: mode === 'inactive' ? 'SUSPENDED' : 'ACTIVE', identityStatus: 'ACTIVE',
          authzVersion: 1n, tokensValidAfter: null };
      },
      findTenantMembership: async (_staff, requestedTenant) => requestedTenant === tenant
        ? { membershipId: tenant, tenantId: tenant, status: 'ACTIVE', version: 1n, roleGrants: [] } : null,
      findPlatformRoleGrants: async () => [],
    },
    auditWriter: { appendSecurityAuditEvents: async events => {
      if (mode === 'audit-failure') throw new Error('synthetic-private-audit-outage'); audits.push(...events);
    } },
  });
  const refuseSession = async (): Promise<never> => { sessionAttempts++; throw new Error('Synthetic contract: sessions prohibited'); };
  const login = new Auth0Login({ ...config, tenantId: mode === 'cross-tenant' ? '00000000-0000-4000-8000-000000000099' : tenant }, {
    now: tokens.now, fetch: tokens.fetch,
    actors: { establish: async (identity, requestedTenant) => {
      actorCalls++;
      const established = await boundary.establish(identity, requestedTenant);
      if (established.allowed) {
        // Exercise backend self-authorization and its required audit/freshness check without creating a session.
        try {
          if (!await boundary.inspectSessionActor(established.actor)) throw new Error('Denied');
        } catch {
          const denied = { allowed: false as const, reason: 'DEPENDENCY_UNAVAILABLE', execution: 'NOT_AUTHORIZED' as const };
          decisions.push(denied); return denied;
        }
      }
      decisions.push(established); return established;
    } },
    sessions: { create: refuseSession, rotate: refuseSession, revoke: refuseSession },
  });
  return { tokens, login, decisions, audits, actorCalls: () => actorCalls,
    sessionAttempts: () => sessionAttempts, enrolledReads: () => enrolledReads };
}

function begin(f: Awaited<ReturnType<typeof contract>>) {
  const started = f.login.begin(), url = new URL(started.location);
  f.tokens.id({ nonce: url.searchParams.get('nonce')!, roles: ['PLATFORM_ADMIN'], email_verified: true,
    recovery_complete: true, app_metadata: { staff: true } });
  const callback = '/auth/callback?' + new URLSearchParams({ code: 'synthetic-code', state: url.searchParams.get('state')! });
  const cookie = started.cookie.split(';')[0]!.split('=')[1]!;
  return { callback, cookie, nonce: url.searchParams.get('nonce')! };
}

test('a verified human token crosses the backend boundary but creates no privileged or application session', async () => {
  const f = await contract('approved'), started = begin(f);
  await assert.rejects(() => f.login.complete(started.callback, started.cookie), { message: 'Staff authentication failed' });
  assert.equal(f.actorCalls(), 1); assert.ok(f.enrolledReads() > 0);
  assert.deepEqual(f.decisions.map(x => ({ allowed: x.allowed, execution: x.execution })), [{ allowed: true, execution: 'NOT_AUTHORIZED' }]);
  assert.equal(f.sessionAttempts(), 1); assert.equal(f.tokens.rows.size, 0);
  await assert.rejects(() => f.login.complete(started.callback, started.cookie));
  assert.equal(f.actorCalls(), 1); assert.equal(f.sessionAttempts(), 1);
});

test('signed human/recovery/role claims cannot supply enrollment, tenant membership, active status or available audit', async t => {
  for (const mode of ['unknown', 'cross-tenant', 'inactive', 'audit-failure'] as const) await t.test(mode, async () => {
    const f = await contract(mode), started = begin(f);
    await assert.rejects(() => f.login.complete(started.callback, started.cookie));
    assert.equal(f.decisions.length, 1); assert.equal(f.decisions[0]!.allowed, false);
    assert.equal(f.decisions[0]!.execution, 'NOT_AUTHORIZED');
    assert.equal(f.sessionAttempts(), 0); assert.equal(f.tokens.rows.size, 0);
    assert.equal(JSON.stringify(f.audits).includes('synthetic-staff'), false);
    assert.equal(JSON.stringify(f.audits).includes('synthetic-private'), false);
    await assert.rejects(() => f.login.complete(started.callback, started.cookie)); assert.equal(f.actorCalls(), 1);
  });
});

test('forged principal evidence, management privileges and MFA recovery downgrade never reach backend authorization', async t => {
  for (const kind of ['forged', 'scope', 'recovery', 'expired', 'issuer', 'audience'] as const) await t.test(kind, async () => {
    const f = await contract('approved'), started = begin(f);
    if (kind === 'forged') f.tokens.wrongKey();
    if (kind === 'scope') f.tokens.access({ scope: 'openid update:current_user_identities', [config.staffKindClaim]: 'human' });
    if (kind === 'recovery') f.tokens.id({ nonce: started.nonce, amr: ['pwd'], recovery_complete: true, mfa_enrolled: true });
    if (kind === 'expired') f.tokens.advance(300000);
    if (kind === 'issuer') f.tokens.access({ iss: 'https://substitution.synthetic.invalid/' });
    if (kind === 'audience') f.tokens.access({ aud: 'urn:synthetic:other-tenant' });
    await assert.rejects(() => f.login.complete(started.callback, started.cookie));
    assert.equal(f.actorCalls(), 0); assert.equal(f.sessionAttempts(), 0); assert.equal(f.enrolledReads(), 0);
    assert.equal(f.tokens.rows.size, 0);
  });
});
