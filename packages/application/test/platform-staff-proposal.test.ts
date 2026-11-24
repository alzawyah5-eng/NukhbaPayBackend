import assert from 'node:assert/strict';
import test from 'node:test';
import { hasPlatformStaffProposalQuorum, isPlatformStaffProposalCurrent, preparePlatformStaffProposal, type PlatformStaffApprovalObservation } from '../src/identity/platform-staff-proposal.js';
import type { ApprovalSlot } from '../src/identity/staff-lifecycle.js';
import { normalizeStaffRequestCommand, type StaffRequestCommand } from '../src/identity/durable-staff-request.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const now = 10_000;
const target = { kind: 'REVOKE_SESSION', staffId: id(3), authzVersion: 1n, sessionId: id(4), creationOperationId: id(5), sessionScope: id(8) } as const;
const intent = { scope: 'PLATFORM', requestId: id(1), requestVersion: 1n, requesterStaffId: id(2), requesterAuthzVersion: 1n, target,
  requestedAtMs: now - 100, expiresAtMs: now + 2000 };

test('platform proposals bind the precise id, scope, effect, target and persisted versions', () => {
  const single = preparePlatformStaffProposal(intent, now);
  const all = preparePlatformStaffProposal({ ...intent, target: { kind: 'REVOKE_ALL_SESSIONS', staffId: id(3), authzVersion: 1n, currentCutoffMs: null } }, now);
  const suspend = preparePlatformStaffProposal({ ...intent, target: { kind: 'SUSPEND_STAFF', staffId: id(3), authzVersion: 1n, currentCutoffMs: null } }, now);
  assert.ok(single && all && suspend);
  assert.ok(Object.isFrozen(single.target));
  assert.equal(new Set([single, all, suspend].map(p => p.proposedPermission)).size, 3);
  assert.equal(new Set([single, all, suspend].map(p => p.requestDigest)).size, 3);
  assert.ok([single, all, suspend].every(p => p.phase === '3D' && p.scope === 'PLATFORM' && p.execution === 'NOT_AUTHORIZED'));
  assert.notEqual(preparePlatformStaffProposal({ ...intent, requestVersion: 2n }, now)?.requestDigest, single.requestDigest);
  assert.notEqual(preparePlatformStaffProposal({ ...intent, target: { ...target, creationOperationId: id(6) } }, now)?.requestDigest, single.requestDigest);
  assert.notEqual(preparePlatformStaffProposal({ ...intent, target: { kind: 'SUSPEND_STAFF', staffId: id(3), authzVersion: 1n, currentCutoffMs: now - 5 } }, now)?.requestDigest, suspend.requestDigest);
});

test('platform proposals reject tenant or hidden effect selectors, expiry, self-targeting and type confusion', () => {
  for (const malformed of [
    { ...intent, scope: 'TENANT' }, { ...intent, tenantId: id(6) }, { ...intent, requestVersion: '1' },
    { ...intent, expiresAtMs: now }, { ...intent, requestedAtMs: now + 1 }, { ...intent, requesterStaffId: target.staffId },
    { ...intent, target: { ...target, allSessions: true } }, { ...intent, target: { ...target, kind: 'REVOKE_ALL_SESSIONS' } },
    { ...intent, target: Object.assign(Object.create({ tenantId: id(6) }) as object, target) },
    { ...intent, target: { ...target, get creationOperationId() { throw new Error('do not read'); } } },
  ]) assert.equal(preparePlatformStaffProposal(malformed, now), null);
});

test('proposed approvals bind independent people, role grants, authority versions and the exact persisted intent', () => {
  const proposal = preparePlatformStaffProposal({ ...intent, target: { kind: 'SUSPEND_STAFF', staffId: id(3), authzVersion: 1n, currentCutoffMs: null } }, now);
  assert.ok(proposal);
  const approval = (n: number, roleCode: ApprovalSlot): PlatformStaffApprovalObservation => ({
    requestDigest: proposal.requestDigest, reviewerStaffId: id(n), reviewerAuthzVersion: 1n, grantId: id(n + 20), decision: 'APPROVE',
    approvedAtMs: now - 50, expiresAtMs: now + 100,
    reviewer: { staffId: id(n), status: 'ACTIVE', authzVersion: 1n, memberships: [], grants: [{ id: id(n + 20), staffId: id(n),
      roleCode, scope: { kind: 'PLATFORM' }, grantedAtMs: 0, expiresAtMs: null, revokedAtMs: null }] },
  });
  const security = approval(10, 'SECURITY_ADMIN'), governance = approval(11, 'GOVERNANCE_OWNER');
  assert.equal(hasPlatformStaffProposalQuorum(proposal, [security, governance], now), true);
  assert.equal(hasPlatformStaffProposalQuorum({ ...proposal }, [security, governance], now), false);
  assert.equal(hasPlatformStaffProposalQuorum(proposal, [security], now), false);
  assert.equal(hasPlatformStaffProposalQuorum(proposal, [security, governance], now + 100), false);
  for (const change of [
    approval(2, 'GOVERNANCE_OWNER'), approval(3, 'GOVERNANCE_OWNER'), approval(10, 'GOVERNANCE_OWNER'), approval(11, 'SECURITY_ADMIN'),
    { ...governance, decision: 'REJECT' as const }, { ...governance, requestDigest: 'f'.repeat(64) },
    { ...governance, reviewerAuthzVersion: 2n }, { ...governance, approvedAtMs: now + 1 },
    { ...governance, reviewer: { ...governance.reviewer, grants: [{ ...governance.reviewer.grants[0]!, revokedAtMs: now }] } },
    { ...governance, reviewer: { ...governance.reviewer, grants: [{ ...governance.reviewer.grants[0]!, scope: { kind: 'TENANT' as const, tenantId: id(8) } }] } },
  ]) assert.equal(hasPlatformStaffProposalQuorum(proposal, [security, change], now), false);
  const current = {
    request: { id: proposal.requestId, version: proposal.requestVersion, digest: proposal.requestDigest, scope: 'PLATFORM', state: 'APPROVED' },
    requester: { ...security.reviewer, staffId: proposal.requesterStaffId, grants: [] }, target: proposal.target, approvals: [security, governance],
  };
  assert.equal(isPlatformStaffProposalCurrent(proposal, current, now), true);
  assert.equal(isPlatformStaffProposalCurrent(proposal, { ...current, request: { ...current.request, state: 'CANCELLED' } }, now), false);
  assert.equal(isPlatformStaffProposalCurrent(proposal, { ...current, request: { ...current.request, version: 2n } }, now), false);
  assert.equal(isPlatformStaffProposalCurrent(proposal, { ...current, target: { ...proposal.target, authzVersion: 2n } }, now), false);
  assert.equal(isPlatformStaffProposalCurrent(proposal, { ...current, requester: { ...current.requester, authzVersion: 2n } }, now), false);
});

test('durable request normalization rejects selectors absent from the persisted digest', () => {
  const command: StaffRequestCommand = { kind: 'SUBMIT', key: id(7), id: intent.requestId, version: 1n, previousDigest: null,
    targetStaffId: target.staffId, operation: { kind: 'SUSPEND', target: 'MEMBERSHIP' }, proposedRoles: [],
    expectedAuthzVersion: 1n, expectedMembershipVersion: 1n, expiresAtMs: intent.expiresAtMs };
  assert.deepEqual(normalizeStaffRequestCommand(command), command);
  const operation = { ...command.operation, sessionId: target.sessionId };
  assert.throws(() => normalizeStaffRequestCommand({ ...command, operation }), /Invalid operation/);
});
