import assert from 'node:assert/strict';
import test from 'node:test';
import { TrustedStaffActorBoundary } from '../src/identity/trusted-staff-actor.js';
import { attestVerifiedStaffIdentity, type VerifiedStaffIdentity } from '../src/identity/verified-staff-identity.js';
import type { SecurityAuditEvent } from '../src/identity/security-audit.js';
import type { ResolvedStaffPrincipal, ResolvedStaffMembership } from '../src/identity/staff-access.js';

const issuer = 'https://admission.synthetic.invalid/', subject = 'auth0|approved-human';
const tenant = '00000000-0000-4000-8000-000000000002', staff = '00000000-0000-4000-8000-000000000001';
const now = new Date('2026-11-16T08:00:00Z');
function identity(sub = subject, iss = issuer) {
  return attestVerifiedStaffIdentity({ issuer: iss, subject: sub, security: {
    audience: 'urn:synthetic:staff', clientId: 'synthetic-client', profile: 'rfc9068-staff-v1', principalKind: 'human',
    issuedAt: now.getTime() / 1000, expiresAt: now.getTime() / 1000 + 300, assurance: 'not-established',
  } });
}
function fixture() {
  const state = { reads: 0, auditFailure: false, repositoryFailure: false,
    principal: { staffId: staff, staffStatus: 'ACTIVE', identityStatus: 'ACTIVE', authzVersion: 1n, tokensValidAfter: null } as ResolvedStaffPrincipal | null,
    membership: { membershipId: tenant, tenantId: tenant, status: 'ACTIVE', version: 1n, roleGrants: [] } as ResolvedStaffMembership | null };
  const events: SecurityAuditEvent[] = [];
  const actors = new TrustedStaffActorBoundary({ now: () => now, sessionIssuers: [issuer],
    repository: {
      findByTrustedIdentity: async i => {
        state.reads++; if (state.repositoryFailure) throw new Error('synthetic-private-connection-password');
        return i.issuer === issuer && i.subject === subject ? state.principal : null;
      },
      findPlatformRoleGrants: async () => [], findTenantMembership: async () => state.membership,
    }, auditWriter: { appendSecurityAuditEvents: async batch => {
      if (state.auditFailure) throw new Error('synthetic-private-audit-password');
      events.push(...batch);
    } },
  });
  return { state, events, actors };
}

test('only exact enrolled issuer/subject and active membership pass staff admission', async () => {
  for (const observation of [identity('auth0|new-import'), identity(subject, 'https://other.synthetic.invalid/'),
    identity(subject.toUpperCase()), JSON.parse(JSON.stringify(identity())) as VerifiedStaffIdentity]) {
    const f = fixture(), result = await f.actors.establish(observation, tenant);
    assert.equal(result.allowed, false); assert.equal(result.execution, 'NOT_AUTHORIZED');
    assert.equal(f.events.length, 1);
    const event = f.events[0]!;
    assert.equal(event.outcome, 'DENIED'); assert.equal(event.actorStaffId, null); assert.equal(event.tenantId, null);
    assert.equal(event.targetId, null); assert.equal(event.targetType, 'STAFF_IDENTITY');
    const serialized = JSON.stringify(event);
    for (const value of [subject, issuer, 'new-import', 'synthetic-private']) assert.equal(serialized.includes(value), false);
  }
  const f = fixture(); assert.equal((await f.actors.establish(identity(), tenant)).allowed, true);
  assert.equal(f.events.length, 0); // Session authorization retains its separate existing allow audit.
});

test('inactive identities and recovery cutoffs deny with fixed admission audit categories', async () => {
  for (const change of ['unknown', 'pending', 'suspended', 'disabled', 'identity', 'membership', 'cutoff', 'bad-cutoff'] as const) {
    const f = fixture();
    if (change === 'unknown') f.state.principal = null;
    if (change === 'pending') f.state.principal = { ...f.state.principal!, staffStatus: 'PENDING' };
    if (change === 'suspended') f.state.principal = { ...f.state.principal!, staffStatus: 'SUSPENDED' };
    if (change === 'disabled') f.state.principal = { ...f.state.principal!, staffStatus: 'DISABLED' };
    if (change === 'identity') f.state.principal = { ...f.state.principal!, identityStatus: 'DISABLED' };
    if (change === 'membership') f.state.membership = null;
    if (change === 'cutoff' || change === 'bad-cutoff') f.state.principal = {
      ...f.state.principal!, tokensValidAfter: change === 'cutoff' ? now.toISOString() : 'invalid-cutoff',
    };
    assert.equal((await f.actors.establish(identity(), tenant)).allowed, false);
    assert.equal(f.events.length, 1); assert.equal(f.events[0]!.outcome, 'DENIED');
    assert.equal(f.events[0]!.reasonCode, change === 'membership' ? 'MEMBERSHIP_NOT_ACTIVE' : 'STAFF_NOT_ACTIVE');
  }
});

test('repository and denial-audit outages fail closed and never return dependency details', async () => {
  const failed = fixture(); failed.state.repositoryFailure = true;
  const result = await failed.actors.establish(identity(), tenant);
  assert.deepEqual(result, { allowed: false, reason: 'DEPENDENCY_UNAVAILABLE', execution: 'NOT_AUTHORIZED' });
  assert.equal(failed.events.length, 1); assert.equal(failed.events[0]!.outcome, 'FAILURE');
  assert.equal(failed.events[0]!.reasonCode, 'DEPENDENCY_UNAVAILABLE');
  assert.equal(JSON.stringify([result, failed.events]).includes('synthetic-private'), false);
  const audit = fixture(); audit.state.auditFailure = true;
  assert.deepEqual(await audit.actors.establish(identity('auth0|unapproved'), tenant), result);
  assert.equal(audit.events.length, 0);
});
