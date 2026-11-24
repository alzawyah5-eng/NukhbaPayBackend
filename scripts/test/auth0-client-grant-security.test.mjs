import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateEvidence, evaluateManagementPolicy } from '../auth0/security-evidence.mjs';
import { sha256 } from '../auth0/security-contract.mjs';
import { evidence, bytesOf, optionsFor, readDependency, ref } from './fixtures/auth0-security-evidence.mjs';

// Synthetic capabilities only. No grant request, target-client mutation or token issuance occurs.
const administrativeScopes = ['create:client_grants', 'update:client_grants'];
const credentialScopes = [['update:client_keys', 'CLIENT_KEY'], ['update:client_credentials', 'CLIENT_CREDENTIAL']];
const evaluate = value => { const bytes = bytesOf(value); return evaluateEvidence(bytes, optionsFor(bytes)); };
function applicationGrant(scope, subjectType = 'client', reach = 'STAFF') {
  const value = readDependency(evidence(), subjectType), m = value.sections.management;
  m.applications[1][subjectType + 'RequiredScopes'] = [scope];
  m.applications[1].staffReach = reach;
  m.grants[0].scopes = [scope];
  // All declared approvals/boundaries are positive to prove they cannot override the capability ban.
  value.sections.capabilities.principals.push({ alias: 'READ_SERVICE', kind: 'INTEGRATION', approved: true,
    staffReach: 'STAFF_ONLY', scopeEnforced: true, capabilities: ['DELEGATE'] });
  value.sections.capabilities.routes.push({ operation: 'DELEGATE', enabled: true, principal: 'READ_SERVICE', approved: true, procedureRef: ref });
  return value;
}

test('normal staff login requires no administrative application grant; reviewed human delegation is separate', () => {
  const value = evidence(), report = evaluate(value), portal = value.sections.management.applications[0];
  assert.equal(portal.alias, 'STAFF_PORTAL'); assert.deepEqual(portal.userRequiredScopes, []); assert.deepEqual(portal.clientRequiredScopes, []);
  assert.equal(value.sections.management.grants.length, 0);
  assert.equal(report.status, 'VERIFIED'); assert.equal(report.gates.grantAdministration.status, 'VERIFIED');
  assert.equal(report.changeAllowed, false); assert.equal(report.deployable, false);
  assert.equal(value.sections.capabilities.principals[0].kind, 'ADMIN');
  assert.ok(value.sections.capabilities.principals[0].capabilities.includes('DELEGATE'));
});

test('both grant-administration scopes are classified as delegation and denied for every application access type/reach', async t => {
  for (const scope of administrativeScopes) for (const type of ['client', 'user']) for (const reach of ['STAFF', 'NONE']) {
    await t.test(`${scope} ${type} ${reach}`, () => {
      const value = applicationGrant(scope, type, reach), report = evaluate(value);
      assert.equal(report.status, 'FAILED'); assert.equal(report.gates.management.status, 'FAILED');
      assert.equal(report.gates.policyProposal.status, 'FAILED'); assert.equal(report.gates.grantAdministration.status, 'FAILED');
      const reasons = report.gates.management.reasons;
      assert.ok(reasons.includes(scope.startsWith('create:') ? 'GRANT_CREATION_CAPABILITY' : 'GRANT_MODIFICATION_CAPABILITY'));
      assert.equal(reasons.includes('UNCLASSIFIED_MANAGEMENT_SCOPE'), false);
      assert.ok(reasons.includes(type === 'user' ? 'DELEGATED_GRANT_ADMINISTRATION' : 'CLIENT_GRANT_ADMINISTRATION'));
      assert.ok(report.gates.effectiveRights.reasons.includes('GRANT_ESCALATION_EVIDENCE_CONFLICT'));
      assert.equal(report.changeAllowed, false); assert.equal(report.deployable, false);
    });
  }
});

test('Staff Portal cannot acquire either administrative permission through client or delegated grants', async t => {
  for (const scope of administrativeScopes) for (const type of ['client', 'user']) await t.test(scope + ' ' + type, () => {
    const value = evidence(), m = value.sections.management, portal = m.applications[0];
    portal[type + 'Dependency'] = 'REQUIRED'; portal[type + 'RequiredScopes'] = [scope];
    m.grants.push({ application: 'STAFF_PORTAL', subjectType: type, scopes: [scope] });
    const report = evaluate(value);
    assert.equal(report.status, 'FAILED'); assert.ok(report.gates.management.reasons.includes('STAFF_PORTAL_MANAGEMENT_GRANT'));
    assert.ok(report.gates.management.reasons.includes('GRANT_ADMINISTRATION_DEPENDENCY'));
  });
});

test('an approved intermediary remains an escalation risk even when the other client has no direct administrative grant', () => {
  for (const scope of administrativeScopes) {
    const value = applicationGrant(scope, 'client', 'NONE'), m = value.sections.management;
    m.applications.push({ ...m.applications[0], alias: 'OTHER_CLIENT', staffReach: 'NONE' });
    assert.equal(m.grants.some(x => x.application === 'STAFF_PORTAL' || x.application === 'OTHER_CLIENT'), false);
    const report = evaluate(value);
    assert.equal(report.gates.grantAdministration.status, 'FAILED');
    assert.equal(report.gates.effectiveRights.status, 'FAILED');
    // Denial precedes target selection: source authority could otherwise change its own or another grant.
    assert.ok(report.gates.management.reasons.includes('CLIENT_GRANT_ADMINISTRATION'));
  }
});

test('self-approval, constrained-reach claims and role labels cannot legalize application permission administration', () => {
  for (const scope of administrativeScopes) {
    const value = applicationGrant(scope), m = value.sections.management;
    const policy = evaluateManagementPolicy(m, value.sections.rollback);
    assert.equal(m.applications[1].approved, true); assert.equal(m.applications[1].reachEnforced, true);
    assert.equal(value.sections.capabilities.grantEscalationBlocked, true);
    assert.equal(policy.current.status, 'FAILED'); assert.equal(policy.proposal.status, 'FAILED');
    value.sections.capabilities.principals[1].kind = 'ADMIN';
    assert.ok(evaluate(value).gates.effectiveRights.reasons.includes('GRANT_HOLDER_KIND_CONFLICT'));
  }
});

test('unapproved creation/modification and permission ceilings fail even when the requestor lists the right as required', () => {
  for (const scope of administrativeScopes) {
    const value = applicationGrant(scope), m = value.sections.management;
    m.applications[1].approved = false;
    assert.ok(evaluate(value).gates.management.reasons.includes('GRANT_UNAPPROVED'));
    m.applications[1].approved = true; m.applications[1].clientRequiredScopes = ['read:users'];
    assert.ok(evaluate(value).gates.management.reasons.includes('EXCESS_GRANT_SCOPE'));
    const route = value.sections.capabilities.routes.find(x => x.principal === 'READ_SERVICE'); route.approved = false;
    assert.equal(evaluate(value).gates.provisioning.status, 'FAILED');
  }
});

test('declared administrative dependencies and automatic defaults cannot hide missing explicit grants', () => {
  for (const scope of administrativeScopes) for (const type of ['user', 'client']) {
    const value = applicationGrant(scope, type), m = value.sections.management;
    m.grants = [];
    assert.ok(evaluate(value).gates.management.reasons.includes('GRANT_ADMINISTRATION_DEPENDENCY'));
    const defaults = evidence(); defaults.sections.management.defaultGrants = [{ subjectType: type, scopes: [scope] }];
    assert.ok(evaluate(defaults).gates.management.reasons.includes('DEFAULT_GRANT_ADMINISTRATION'));
  }
});

test('missing integration delegation sources and incomplete inventories remain UNKNOWN, not a secure empty graph', () => {
  const value = applicationGrant('read:users'), m = value.sections.management;
  // Effective DELEGATE is declared, but no supplied scope explains where it comes from.
  assert.equal(evaluate(value).status, 'UNKNOWN');
  assert.ok(evaluate(value).gates.grantAdministration.reasons.includes('INTEGRATION_DELEGATION_SOURCE_UNKNOWN'));
  value.sections.capabilities.principals.pop(); value.sections.capabilities.routes.pop();
  m.complete = null;
  assert.equal(evaluate(value).gates.grantAdministration.status, 'UNKNOWN');
  m.complete = true; m.dependenciesComplete = false;
  assert.equal(evaluate(value).gates.policyProposal.status, 'UNKNOWN');
  m.dependenciesComplete = true; m.defaultGrants = null;
  assert.equal(evaluate(value).gates.grantAdministration.status, 'UNKNOWN');
});

test('missing or contradictory grant records cannot manufacture safe application permission evidence', () => {
  const missingActor = applicationGrant('create:client_grants', 'client', 'NONE');
  missingActor.sections.capabilities.principals.pop();
  assert.ok(evaluate(missingActor).gates.effectiveRights.reasons.includes('GRANT_CAPABILITY_CONFLICT'));
  for (const mutate of [
    e => { delete e.sections.management.grants; },
    e => { e.sections.management.grants.push(structuredClone(e.sections.management.grants[0])); },
    e => { e.sections.management.grants[0].application = 'UNLISTED_CLIENT'; },
    e => { e.sections.management.grants[0].allow_all_scopes = true; },
  ]) { const value = applicationGrant('update:client_grants'); mutate(value); assert.equal(evaluate(value).status, 'FAILED'); }
});

test('editing an application permission record invalidates its independent approval pin', () => {
  const value = evidence(), original = bytesOf(value), opts = optionsFor(original);
  value.sections.management.grants.push({ application: 'STAFF_PORTAL', subjectType: 'client', scopes: ['create:client_grants'] });
  const modified = bytesOf(value); assert.notEqual(sha256(modified), opts.approvedSha256);
  const report = evaluateEvidence(modified, opts);
  assert.equal(report.gates.evidence.status, 'FAILED'); assert.equal(report.evidenceReady, false);
  assert.equal(report.changeAllowed, false);
});

test('update:clients is a delegation risk in both access types regardless of declared staff-connection reach', async t => {
  for (const type of ['client', 'user']) for (const reach of ['STAFF', 'NONE']) await t.test(type + ' ' + reach, () => {
    const value = applicationGrant('update:clients', type, reach), report = evaluate(value);
    assert.equal(report.status, 'FAILED'); assert.equal(report.gates.management.status, 'FAILED');
    assert.equal(report.gates.policyProposal.status, 'FAILED'); assert.equal(report.gates.grantAdministration.status, 'FAILED');
    assert.ok(report.gates.management.reasons.includes('CLIENT_CONFIGURATION_CAPABILITY'));
    assert.ok(report.gates.management.reasons.includes(type === 'user' ? 'DELEGATED_CLIENT_CONFIGURATION' : 'CLIENT_ACCESS_CONFIGURATION'));
    assert.equal(report.gates.management.reasons.includes('UNCLASSIFIED_MANAGEMENT_SCOPE'), false);
    assert.equal(report.gates.management.reasons.includes('GRANT_MODIFICATION_CAPABILITY'), false);
    assert.ok(report.gates.effectiveRights.reasons.includes('CLIENT_CONFIGURATION_ESCALATION_CONFLICT'));
    assert.equal(report.changeAllowed, false); assert.equal(report.deployable, false);
  });
});

test('client-configuration requirements/defaults are denied even without explicit grants; staff login has no such dependency', async t => {
  assert.equal(evaluate(evidence()).status, 'VERIFIED');
  for (const type of ['client', 'user']) await t.test(type, () => {
    const value = applicationGrant('update:clients', type), m = value.sections.management;
    m.grants = [];
    assert.ok(evaluate(value).gates.management.reasons.includes('CLIENT_CONFIGURATION_DEPENDENCY'));
    const defaults = evidence(); defaults.sections.management.defaultGrants = [{ subjectType: type, scopes: ['update:clients'] }];
    assert.ok(evaluate(defaults).gates.management.reasons.includes('DEFAULT_CLIENT_CONFIGURATION'));
    const staff = evidence(), portal = staff.sections.management.applications[0];
    portal[type + 'Dependency'] = 'REQUIRED'; portal[type + 'RequiredScopes'] = ['update:clients'];
    staff.sections.management.grants = [{ application: 'STAFF_PORTAL', subjectType: type, scopes: ['update:clients'] }];
    assert.ok(evaluate(staff).gates.management.reasons.includes('STAFF_PORTAL_MANAGEMENT_GRANT'));
  });
});

test('an intermediary with client control cannot expose a separate application even without grant-write scopes', () => {
  for (const type of ['client', 'user']) {
    const value = readDependency(evidence(), 'client');
    assert.equal(evaluate(value).status, 'VERIFIED'); // Existing limited reader is accepted before adding the editor.
    const targetGrant = structuredClone(value.sections.management.grants[0]);
    const editor = applicationGrant('update:clients', type, 'NONE');
    value.sections.management.applications.push({ ...editor.sections.management.applications[1], alias: 'CONFIGURATION_EDITOR' });
    value.sections.management.grants.push({ ...editor.sections.management.grants[0], application: 'CONFIGURATION_EDITOR' });
    value.sections.capabilities.principals.push({ ...editor.sections.capabilities.principals[1], alias: 'CONFIGURATION_EDITOR' });
    value.sections.capabilities.routes.push({ ...editor.sections.capabilities.routes.at(-1), principal: 'CONFIGURATION_EDITOR' });
    if (type === 'user') {
      value.sections.management.userPolicy = 'require_client_grant'; value.sections.management.proposedUserPolicy = 'require_client_grant';
    }
    const report = evaluate(value);
    assert.equal(report.status, 'FAILED'); assert.ok(report.gates.management.reasons.includes('CLIENT_CONFIGURATION_CAPABILITY'));
    assert.deepEqual(value.sections.management.grants[0], targetGrant); // No changes to the target's grant needed for the risk.
    assert.equal(value.sections.management.grants.flatMap(x => x.scopes).some(x => administrativeScopes.includes(x)), false);
  }
});

test('configuration self-approval, application identity substitution and excess permission claims fail closed', () => {
  const value = applicationGrant('update:clients'), m = value.sections.management;
  assert.equal(m.applications[1].approved, true); assert.equal(m.applications[1].reachEnforced, true);
  assert.equal(evaluate(value).gates.management.status, 'FAILED');
  value.sections.capabilities.principals[1].kind = 'ADMIN';
  assert.ok(evaluate(value).gates.effectiveRights.reasons.includes('CLIENT_CONFIGURATION_HOLDER_KIND_CONFLICT'));
  m.applications[1].approved = false;
  assert.ok(evaluate(value).gates.management.reasons.includes('GRANT_UNAPPROVED'));
  m.applications[1].approved = true; m.applications[1].clientRequiredScopes = ['read:users'];
  assert.ok(evaluate(value).gates.management.reasons.includes('EXCESS_GRANT_SCOPE'));
  m.grants[0].application = 'UNLISTED_CONFIGURATION_EDITOR';
  assert.ok(evaluate(value).gates.management.reasons.includes('GRANT_APPLICATION_MISSING'));
});

test('missing configuration-authority evidence stays UNKNOWN; a known unsafe scope is not erased by other missing evidence', () => {
  const missing = evidence(); missing.sections.management = null;
  assert.equal(evaluate(missing).status, 'UNKNOWN');
  const incomplete = evidence(); incomplete.sections.management.complete = null;
  assert.equal(evaluate(incomplete).gates.grantAdministration.status, 'UNKNOWN');
  const unsafe = applicationGrant('update:clients'); delete unsafe.sections.capabilities;
  assert.equal(evaluate(unsafe).status, 'FAILED');
  assert.ok(evaluate(unsafe).gates.management.reasons.includes('CLIENT_CONFIGURATION_CAPABILITY'));
  const conflicting = applicationGrant('update:clients', 'client', 'NONE');
  conflicting.sections.capabilities.principals.pop();
  assert.ok(evaluate(conflicting).gates.effectiveRights.reasons.includes('GRANT_CAPABILITY_CONFLICT'));
  conflicting.sections.management.grants.push(structuredClone(conflicting.sections.management.grants[0]));
  assert.ok(evaluate(conflicting).gates.evidence.reasons.includes('MALFORMED_OR_CONFLICTING_EVIDENCE'));
});

test('raw redirect/authentication/credential/identity settings are rejected without reflecting or storing their values', async t => {
  for (const field of ['callbacks', 'token_endpoint_auth_method', 'grant_types', 'client_secret', 'signing_key',
    'client_authentication_methods', 'client_id', 'jwt_configuration', 'credential_id', 'pem', 'kid',
    'private_key', 'client_assertion', 'credentials']) await t.test(field, () => {
    const value = readDependency(evidence(), 'client'); assert.equal(evaluate(value).status, 'VERIFIED');
    const marker = 'SYNTHETIC_PRIVATE_CONFIGURATION_DO_NOT_REFLECT';
    value.sections.management.applications[1][field] = marker;
    const report = evaluate(value);
    assert.equal(report.gates.evidence.status, 'FAILED'); assert.equal(report.status, 'FAILED');
    assert.equal(JSON.stringify(report).includes(marker), false);
    assert.equal(JSON.stringify(report).includes(field), false);
  });
});

test('unreviewed credential CRUD and token-vault permissions remain UNKNOWN rather than inheriting update authority', () => {
  for (const scope of ['create:client_credentials', 'read:client_credentials', 'delete:client_credentials', 'update:client_token_vault_privileged_access']) {
    const value = applicationGrant(scope), report = evaluate(value);
    assert.equal(report.status, 'UNKNOWN');
    assert.ok(report.gates.management.reasons.includes('UNCLASSIFIED_MANAGEMENT_SCOPE'));
    assert.equal(report.gates.management.reasons.includes('CLIENT_CONFIGURATION_CAPABILITY'), false);
  }
  const combined = applicationGrant('update:clients');
  combined.sections.management.applications[1].clientRequiredScopes.push('update:client_keys');
  combined.sections.management.grants[0].scopes.push('update:client_keys');
  assert.equal(evaluate(combined).status, 'FAILED');
});

test('forged configuration approvals and stale approval digests cannot authorize a settings controller', () => {
  const value = readDependency(evidence(), 'client'), original = bytesOf(value), opts = optionsFor(original);
  value.sections.management.applications[1].clientRequiredScopes = ['update:clients'];
  value.sections.management.grants[0].scopes = ['update:clients'];
  const report = evaluateEvidence(bytesOf(value), opts);
  assert.equal(report.gates.evidence.status, 'FAILED'); assert.equal(report.evidenceReady, false);
  const forged = applicationGrant('update:clients'); forged.reviewerRef = forged.custodianRef;
  assert.equal(evaluate(forged).gates.evidence.status, 'FAILED');
});

test('key and credential authority is classified and denied across both access types and declared connection boundaries', async t => {
  for (const [scope, family] of credentialScopes) for (const type of ['client', 'user']) for (const reach of ['STAFF', 'NONE']) {
    await t.test(scope + ' ' + type + ' ' + reach, () => {
      const value = applicationGrant(scope, type, reach), report = evaluate(value);
      const policy = evaluateManagementPolicy(value.sections.management, value.sections.rollback);
      for (const gate of ['management', 'policyProposal', 'grantAdministration', 'effectiveRights']) assert.equal(report.gates[gate].status, 'FAILED');
      assert.equal(policy.current.status, 'FAILED'); assert.equal(policy.proposal.status, 'FAILED');
      assert.ok(report.gates.management.reasons.includes(family + '_CAPABILITY'));
      assert.ok(report.gates.management.reasons.includes(type === 'user' ? 'DELEGATED_' + family : 'CLIENT_ACCESS_' + family.slice('CLIENT_'.length)));
      assert.ok(report.gates.effectiveRights.reasons.includes(family + '_ESCALATION_CONFLICT'));
      assert.equal(report.gates.management.reasons.includes('UNCLASSIFIED_MANAGEMENT_SCOPE'), false);
      assert.equal(report.gates.management.reasons.includes('CLIENT_CONFIGURATION_CAPABILITY'), false);
      assert.equal(report.deployable, false); assert.equal(report.authenticationAllowed, false); assert.equal(policy.changeAllowed, false);
    });
  }
});

test('ordinary staff login has zero key/credential dependencies and cannot receive administrative requirements, grants or defaults', async t => {
  const baseline = evidence(), portal = baseline.sections.management.applications[0];
  assert.equal(evaluate(baseline).status, 'VERIFIED'); assert.deepEqual(baseline.sections.management.grants, []);
  assert.deepEqual(portal.userRequiredScopes, []); assert.deepEqual(portal.clientRequiredScopes, []);
  for (const [scope, family] of credentialScopes) for (const type of ['client', 'user']) await t.test(scope + ' ' + type, () => {
    const required = applicationGrant(scope, type); required.sections.management.grants = [];
    assert.ok(evaluate(required).gates.management.reasons.includes(family + '_DEPENDENCY'));
    const defaults = evidence(); defaults.sections.management.defaultGrants = [{ subjectType: type, scopes: [scope] }];
    assert.ok(evaluate(defaults).gates.grantAdministration.reasons.includes('DEFAULT_' + family));
    const staff = evidence(), app = staff.sections.management.applications[0];
    app[type + 'Dependency'] = 'REQUIRED'; app[type + 'RequiredScopes'] = [scope];
    staff.sections.management.grants.push({ application: 'STAFF_PORTAL', subjectType: type, scopes: [scope] });
    assert.ok(evaluate(staff).gates.management.reasons.includes('STAFF_PORTAL_MANAGEMENT_GRANT'));
    assert.equal(evaluate(staff).status, 'FAILED');
  });
});

test('credential-controlling intermediaries are denied before self/other-client target selection or credential use', async t => {
  for (const [scope, family] of credentialScopes) for (const type of ['client', 'user']) await t.test(scope + ' ' + type, () => {
    const value = readDependency(evidence(), 'client'); assert.equal(evaluate(value).status, 'VERIFIED');
    const original = structuredClone(value.sections.management.grants[0]), writer = applicationGrant(scope, type, 'NONE');
    value.sections.management.applications.push({ ...writer.sections.management.applications[1], alias: 'CREDENTIAL_INTERMEDIARY' });
    value.sections.management.grants.push({ ...writer.sections.management.grants[0], application: 'CREDENTIAL_INTERMEDIARY' });
    value.sections.capabilities.principals.push({ ...writer.sections.capabilities.principals[1], alias: 'CREDENTIAL_INTERMEDIARY' });
    value.sections.capabilities.routes.push({ ...writer.sections.capabilities.routes.at(-1), principal: 'CREDENTIAL_INTERMEDIARY' });
    if (type === 'user') {
      value.sections.management.userPolicy = 'require_client_grant'; value.sections.management.proposedUserPolicy = 'require_client_grant';
    }
    const report = evaluate(value);
    assert.ok(report.gates.management.reasons.includes(family + '_CAPABILITY')); assert.equal(report.status, 'FAILED');
    assert.deepEqual(value.sections.management.grants[0], original);
    assert.equal(value.sections.management.grants.flatMap(x => x.scopes).some(x => [...administrativeScopes, 'update:clients'].includes(x)), false);
    // Permission denial needs neither a target credential nor a secret; it applies before either can be selected.
  });
});

test('credential inventory absence stays UNKNOWN while known authority and contradictory holder evidence fail', async t => {
  for (const [scope] of credentialScopes) await t.test(scope, () => {
    const missing = evidence(); missing.sections.management = null; assert.equal(evaluate(missing).status, 'UNKNOWN');
    const incomplete = evidence(); incomplete.sections.management.complete = null;
    assert.equal(evaluate(incomplete).gates.grantAdministration.status, 'UNKNOWN');
    const defaults = evidence(); defaults.sections.management.defaultGrants = null;
    assert.equal(evaluate(defaults).gates.grantAdministration.status, 'UNKNOWN');
    const unsafe = applicationGrant(scope); unsafe.sections.capabilities = null;
    assert.equal(evaluate(unsafe).status, 'FAILED'); assert.equal(evaluate(unsafe).gates.management.status, 'FAILED');
    const conflict = applicationGrant(scope, 'client', 'NONE'); conflict.sections.capabilities.principals.pop();
    assert.ok(evaluate(conflict).gates.effectiveRights.reasons.includes('GRANT_CAPABILITY_CONFLICT'));
    conflict.sections.management.grants.push(structuredClone(conflict.sections.management.grants[0]));
    assert.ok(evaluate(conflict).gates.evidence.reasons.includes('MALFORMED_OR_CONFLICTING_EVIDENCE'));
  });
});

test('unapproved credential control, application/human identity substitution and excess permission evidence cannot waive denial', async t => {
  for (const [scope, family] of credentialScopes) await t.test(scope, () => {
    const value = applicationGrant(scope), m = value.sections.management;
    assert.equal(evaluate(value).status, 'FAILED'); // Even a claimed approved writer is prohibited.
    value.sections.capabilities.principals[1].kind = 'ADMIN';
    assert.ok(evaluate(value).gates.effectiveRights.reasons.includes(family + '_HOLDER_KIND_CONFLICT'));
    m.applications[1].approved = false; assert.ok(evaluate(value).gates.management.reasons.includes('GRANT_UNAPPROVED'));
    m.applications[1].approved = true; m.applications[1].clientRequiredScopes = ['read:users'];
    assert.ok(evaluate(value).gates.management.reasons.includes('EXCESS_GRANT_SCOPE'));
    m.grants[0].application = 'UNLISTED_CREDENTIAL_CONTROLLER';
    assert.ok(evaluate(value).gates.management.reasons.includes('GRANT_APPLICATION_MISSING'));
  });
});

test('forged key/credential approval records and edited approved snapshots cannot authorize credential controllers', async t => {
  for (const [scope] of credentialScopes) await t.test(scope, () => {
    const value = readDependency(evidence(), 'client'), opts = optionsFor(bytesOf(value));
    value.sections.management.applications[1].clientRequiredScopes = [scope]; value.sections.management.grants[0].scopes = [scope];
    const changed = evaluateEvidence(bytesOf(value), opts);
    assert.ok(changed.gates.evidence.reasons.includes('APPROVAL_DIGEST_MISSING_OR_MISMATCH')); assert.equal(changed.evidenceReady, false);
    const forged = applicationGrant(scope); forged.reviewerRef = forged.custodianRef;
    assert.equal(evaluate(forged).gates.evidence.status, 'FAILED');
    const unapproved = bytesOf(applicationGrant(scope));
    assert.equal(evaluateEvidence(unapproved, { ...optionsFor(unapproved), approvedSha256: undefined }).gates.evidence.status, 'UNKNOWN');
    assert.equal(evaluateEvidence(unapproved, { ...optionsFor(unapproved), approvedSha256: undefined }).evidenceReady, false);
  });
});
