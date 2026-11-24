import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { evaluateEvidence, evaluateManagementPolicy, parseEvidence } from '../auth0/security-evidence.mjs';
import { OPERATIONS, MAX_BYTES, sha256 } from '../auth0/security-contract.mjs';
import { evidence, bytesOf, optionsFor, binding, readDependency, NOW, tenantRef } from './fixtures/auth0-security-evidence.mjs';

const evaluate = value => { const bytes = bytesOf(value); return evaluateEvidence(bytes, optionsFor(bytes)); };

test('complete pinned synthetic evidence validates offline without granting deployment, authentication or change authority', () => {
  const report = evaluate(evidence());
  assert.equal(report.status, 'VERIFIED'); assert.equal(report.evidenceReady, true);
  assert.equal(report.basis, 'OFFLINE_SUPPLIED_EVIDENCE'); assert.equal(report.tenantAcceptance, 'NOT_ESTABLISHED');
  for (const key of ['deployable', 'authenticationAllowed', 'changeAllowed']) assert.equal(report[key], false);
  assert.equal(Object.values(report.gates).every(x => x.status === 'VERIFIED'), true);
});

test('absent sections, incomplete inventories and UI-only Rules remain UNKNOWN deployment blockers', async t => {
  const template = readFileSync(new URL('../auth0/development-security-evidence.template.json', import.meta.url));
  assert.equal(evaluateEvidence(template).status, 'UNKNOWN');
  assert.equal(evaluateEvidence(template).gates.effectiveRights.status, 'UNKNOWN');
  for (const section of Object.keys(evidence().sections)) await t.test('absent ' + section, () => {
    const value = evidence(); delete value.sections[section];
    const report = evaluate(value); assert.notEqual(report.status, 'VERIFIED'); assert.equal(report.evidenceReady, false);
  });
  for (const mutate of [
    e => { e.sections.rules.kind = 'UI_ONLY'; }, e => { e.sections.rules.kind = 'UNKNOWN'; },
    e => { e.sections.actions.complete = false; }, e => { e.sections.actions.claimWritersReviewed = null; },
    e => { e.sections.actions.libraryCount = null; },
    e => { e.sections.domain.ownership = 'OPERATOR_CONFIRMED'; },
    e => { e.sections.mfa.administrators[0].enforcement = 'ENROLLED_ONLY'; },
    e => { e.sections.management.dependenciesComplete = false; }, e => { e.sections.management.tokenLifetimeSeconds = null; },
    e => { e.sections.management.defaultGrants = null; },
    e => { e.sections.rollback.adminAccessConfirmed = null; }, e => { e.sections.release.executionValidated = null; },
    e => { e.sections.capabilities.routes = e.sections.capabilities.routes.filter(x => x.operation !== 'IMPORT'); },
  ]) { const value = evidence(); mutate(value); assert.equal(evaluate(value).status, 'UNKNOWN'); }
  const unavailable = evidence(); unavailable.sections.rules.kind = 'UNAVAILABLE';
  assert.equal(evaluate(unavailable).gates.rules.status, 'VERIFIED');
});

test('separate tenant/digest/review/freshness binding cannot be supplied by the JSON itself', () => {
  const value = evidence(), bytes = bytesOf(value), opts = optionsFor(bytes);
  assert.equal(evaluateEvidence(bytes).status, 'UNKNOWN');
  for (const change of [{ expectedTenantRef: '9'.repeat(64) }, { approvedSha256: '0'.repeat(64) },
    { now: NOW + 3600000 }, { now: NOW - 2000 }, { now: NaN }]) {
    assert.equal(evaluateEvidence(bytes, { ...opts, ...change }).status, 'FAILED');
  }
  for (const mutate of [e => { e.environment = 'production'; }, e => { e.custodianRef = e.reviewerRef; },
    e => { e.expiresAt = new Date(NOW + 8 * 86400000).toISOString(); }]) {
    const v = evidence(); mutate(v); assert.equal(evaluate(v).status, 'FAILED');
  }
});

test('malformed, duplicate, escaped-duplicate, unknown, oversized and private fields are rejected without reflecting input', () => {
  const marker = 'SYNTHETIC_PRIVATE_INPUT_DO_NOT_REFLECT';
  const base = bytesOf(evidence()).toString();
  const values = [Buffer.from('{'), Buffer.from(base.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')),
    Buffer.from(base.replace('"schemaVersion":1', '"schemaVersion":1,"schema\\u0056ersion":1')),
    Buffer.from(base.replace('"schemaVersion":1', '"schemaVersion":1,"__proto__":{}')),
    Buffer.alloc(MAX_BYTES + 1), Buffer.from([0xff]),
    bytesOf({ ...evidence(), client_secret: marker }), bytesOf({ ...evidence(), email: 'private@synthetic.invalid' })];
  const badAlias = evidence(); badAlias.sections.mfa.administrators[0].alias = marker + '.JWT'; values.push(bytesOf(badAlias));
  for (const bytes of values) {
    const report = evaluateEvidence(bytes, optionsFor(bytes));
    assert.equal(report.status, 'FAILED'); assert.equal(JSON.stringify(report).includes(marker), false);
    assert.equal(JSON.stringify(report).includes('private@'), false);
  }
});

test('duplicate/conflicting bindings, Rules, applications, scopes and route identities fail closed', () => {
  const mutations = [
    e => { e.sections.actions.bindings = [binding(), binding()]; },
    e => { e.sections.actions.bindings = [{ ...binding(), position: 1 }]; },
    e => { e.sections.rules.kind = 'UNAVAILABLE'; e.sections.rules.rules = [{ alias: 'RULE_A', sourceSha256: 'a'.repeat(64), order: 1,
      enabled: true, principalWriter: false, identityMutation: false, appliesToStaff: true }]; },
    e => { e.sections.management.applications.push(e.sections.management.applications[0]); },
    e => { e.sections.capabilities.principals[0].capabilities.push('CREATE'); },
    e => { e.sections.capabilities.routes.push(e.sections.capabilities.routes[0]); },
    e => { e.sections.capabilities.routes[0].principal = 'UNKNOWN_ACTOR'; },
  ];
  for (const mutate of mutations) { const v = evidence(); mutate(v); assert.equal(evaluate(v).status, 'FAILED'); }
});

test('claim writers and applicable identity mutations cannot hide behind an empty library or a reviewed flag', () => {
  for (const change of [{ principalWriter: true }, { identityMutation: true }]) {
    const value = evidence(); value.sections.actions.bindings = [{ ...binding(), ...change }];
    assert.equal(evaluate(value).gates.actions.status, 'FAILED');
    const r = evidence(); r.sections.rules.rules = [{ alias: 'RULE_A', sourceSha256: 'a'.repeat(64), order: 1,
      enabled: true, principalWriter: false, identityMutation: false, appliesToStaff: true, ...change }];
    assert.equal(evaluate(r).gates.rules.status, 'FAILED');
  }
});

test('effective creation/import/recovery/delegation and linking paths are assessed, not inferred from client counts', async t => {
  for (const operation of OPERATIONS) await t.test(operation, () => {
    const v = evidence(), c = v.sections.capabilities;
    const route = c.routes.find(x => x.operation === operation);
    route.enabled = true; route.principal = 'ADMIN_A'; route.approved = false;
    if (!c.principals[0].capabilities.includes(operation)) c.principals[0].capabilities.push(operation);
    assert.equal(evaluate(v).status, 'FAILED');
  });
  for (const mutate of [
    e => { e.sections.capabilities.principals[0].approved = false; },
    e => { e.sections.capabilities.grantEscalationBlocked = false; },
    e => { e.sections.capabilities.recovery.nativeMfaRequired = false; },
    e => { e.sections.capabilities.recovery.cutoffProcedure = false; },
    e => { e.sections.mfa.administrators[0].fallbacksCovered = false; },
    e => { e.sections.mfa.administrators[0].enforcement = 'NOT_ENFORCED'; },
  ]) { const v = evidence(); mutate(v); assert.equal(evaluate(v).status, 'FAILED'); }
});

test('least-privilege evaluator separates delegated/client grants and preserves zero Staff Portal permissions', () => {
  for (const type of ['user', 'client']) {
    const v = readDependency(evidence(), type);
    assert.equal(evaluate(v).status, 'VERIFIED');
    const m = v.sections.management;
    m.grants[0].subjectType = type === 'user' ? 'client' : 'user';
    assert.equal(evaluateManagementPolicy(m, v.sections.rollback).current.status, 'FAILED');
  }
  for (const scopes of [[], ['create:users'], ['update:users'], ['update:current_user_identities'], ['read:users']]) {
    const v = evidence(); v.sections.management.grants.push({ application: 'STAFF_PORTAL', subjectType: 'user', scopes });
    assert.equal(evaluate(v).gates.management.status, 'FAILED');
  }
});

test('unknown dependencies/defaults/scopes/rollback block changes; known broad policy fails current acceptance', () => {
  const v = evidence(), m = v.sections.management;
  m.userPolicy = 'allow_all';
  const assessed = evaluateManagementPolicy(m, v.sections.rollback);
  assert.equal(assessed.current.status, 'FAILED'); assert.equal(assessed.proposal.status, 'VERIFIED'); assert.equal(assessed.changeAllowed, false);
  for (const mutate of [
    e => { e.sections.management.applications[0].userDependency = 'UNKNOWN'; },
    e => { e.sections.management.defaultsReviewed = false; },
    e => { e.sections.management.clientPolicy = 'UNKNOWN'; },
    e => { e.sections.rollback.adminAccessConfirmed = null; },
    e => { e.sections.management.refreshPathsReviewed = false; },
  ]) { const next = evidence(); mutate(next);
    assert.equal(evaluateManagementPolicy(next.sections.management, next.sections.rollback).proposal.status, 'UNKNOWN'); }
  const unknownScope = readDependency(evidence());
  unknownScope.sections.management.applications[1].userRequiredScopes = ['read:unclassified'];
  unknownScope.sections.management.grants[0].scopes = ['read:unclassified'];
  assert.equal(evaluate(unknownScope).status, 'UNKNOWN');
  const broken = readDependency(evidence()); broken.sections.management.proposedUserPolicy = 'deny_all';
  assert.equal(evaluate(broken).gates.policyProposal.status, 'FAILED');
  const noRollback = evaluateManagementPolicy(m, null); assert.equal(noRollback.proposal.status, 'UNKNOWN');
});

test('grant capabilities must correlate to the declared staff identity writers and deny linking reach', () => {
  const defaults = evidence(); defaults.sections.management.defaultGrants = [{ subjectType: 'user', scopes: ['update:current_user_identities'] }];
  assert.equal(evaluate(defaults).gates.management.status, 'FAILED');
  const reach = readDependency(evidence()); reach.sections.management.applications[1].staffReach = 'NONE';
  reach.sections.management.applications[1].reachEnforced = null;
  assert.equal(evaluate(reach).status, 'UNKNOWN');
  const v = readDependency(evidence(), 'client'), m = v.sections.management;
  m.applications[1].clientRequiredScopes = ['create:users']; m.grants[0].scopes = ['create:users'];
  assert.equal(evaluate(v).gates.effectiveRights.status, 'FAILED');
  m.applications[1].clientRequiredScopes = ['update:users']; m.grants[0].scopes = ['update:users'];
  assert.equal(evaluate(v).gates.management.status, 'FAILED');
  m.applications[1].clientRequiredScopes = ['read:users', 'read:users'];
  assert.equal(evaluate(v).status, 'FAILED');
  assert.equal(evaluateManagementPolicy(m, v.sections.rollback).current.status, 'FAILED');
});

test('CLI reads sanitized input without echo, network, generated credentials or evidence output files', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url)), parent = path.join(root, '.local');
  const dir = mkdtempSync(path.join(parent, 'auth0-evidence-test-'));
  try {
    const input = path.join(dir, 'evidence.json'), v = evidence(), bytes = bytesOf(v); writeFileSync(input, bytes);
    const cli = path.join(root, 'scripts/auth0/security-evidence.mjs');
    const call = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true });
    const good = call(['--evidence', input, '--tenant-ref', tenantRef, '--approved-sha256', sha256(bytes)]);
    assert.equal(good.status, 0); assert.equal(JSON.parse(good.stdout).deployable, false);
    const unknown = call(['--evidence', input]); assert.equal(unknown.status, 2);
    const marker = 'SYNTHETIC_PRIVATE_DO_NOT_ECHO';
    const bad = call(['--evidence', input, '--token', marker]);
    assert.equal(bad.status, 1); assert.equal((bad.stdout + bad.stderr).includes(marker), false);
    writeFileSync(input, bytesOf({ ...v, secret: marker }));
    const rejected = call(['--evidence', input]); assert.equal(rejected.status, 1);
    assert.equal((rejected.stdout + rejected.stderr).includes(marker), false);
    assert.deepEqual(readdirSync(dir), ['evidence.json']);
    assert.throws(() => parseEvidence(bytesOf({ ...v, access_token: marker })));
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(parent));
    assert.match(path.basename(dir), /^auth0-evidence-test-[a-zA-Z0-9]+$/);
    rmSync(dir, { recursive: true, force: false });
  }
});
