import { readFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAIM, CONFIG_NAMES, SOURCE_SHA256, MANIFEST_SHA256, OPERATIONS, SECTIONS, MAX_BYTES,
  invalid, parseStrictJson, hash, nullableHash, alias, flag, integer, choice, list, object, unique,
  digest, sha256, result, check, reviewed, complete, safeReport } from './security-contract.mjs';

const scopes = x => list(y => typeof y === 'string' && /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/.test(y) && y.length <= 96)(x);
const nullableSection = predicate => x => x === null || predicate(x);
const binding = x => object(x, { alias, sourceSha256: hash, position: integer,
  principalWriter: flag, identityMutation: flag, appliesToStaff: flag });
const rule = x => object(x, { alias, sourceSha256: hash, order: integer, enabled: flag,
  principalWriter: flag, identityMutation: flag, appliesToStaff: flag });
const principal = x => object(x, { alias, kind: choice('ADMIN', 'INTEGRATION'), approved: flag,
  staffReach: choice('STAFF_ONLY', 'BROADER', 'NONE', 'UNKNOWN'), scopeEnforced: flag,
  capabilities: list(choice(...OPERATIONS)) });
const route = x => object(x, { operation: choice(...OPERATIONS), enabled: flag,
  principal: x => x === null || alias(x), approved: flag, procedureRef: nullableHash });
const application = x => object(x, { alias, approved: flag, staffReach: choice('STAFF', 'NONE', 'UNKNOWN'),
  reachEnforced: flag, reachEvidenceRef: nullableHash,
  userDependency: choice('REQUIRED', 'NONE', 'UNKNOWN'), clientDependency: choice('REQUIRED', 'NONE', 'UNKNOWN'),
  userRequiredScopes: scopes, clientRequiredScopes: scopes });
const grant = x => object(x, { application: alias, subjectType: choice('user', 'client'), scopes });
const defaultGrant = x => object(x, { subjectType: choice('user', 'client'), scopes });
const priorVersion = x => object(x, { kind: choice('EMPTY', 'VERSION', 'UNKNOWN'),
  sourceSha256: nullableHash, versionRef: x => x === null || alias(x), artifactPreserved: flag });
const validators = {
  domain: x => object(x, { recordRef: nullableHash, ownership: choice('INDEPENDENT', 'OPERATOR_CONFIRMED', 'UNKNOWN'),
    reservation: choice('APPROVED', 'REJECTED', 'UNKNOWN'), claim: choice(CLAIM), value: choice('human') }),
  actions: x => object(x, { recordRef: nullableHash, complete: flag, claimWritersReviewed: flag,
    libraryCount: x => x === null || integer(x), installedIntegrationCount: x => x === null || integer(x), bindings: list(binding) }),
  rules: x => object(x, { recordRef: nullableHash, kind: choice('UI_ONLY', 'UNAVAILABLE', 'INVENTORY', 'UNKNOWN'),
    complete: flag, rules: list(rule) }),
  capabilities: x => object(x, { recordRef: nullableHash, complete: flag, grantEscalationBlocked: flag, principals: list(principal), routes: list(route),
    recovery: x => object(x, { immutableBinding: flag, nativeMfaRequired: flag, freshAuthRequired: flag,
      cutoffProcedure: flag, notifications: flag }) }),
  management: x => object(x, { recordRef: nullableHash, complete: flag, dependenciesComplete: flag,
    defaultsReviewed: flag, supportedControl: flag,
    userPolicy: choice('allow_all', 'require_client_grant', 'deny_all', 'UNKNOWN'),
    clientPolicy: choice('require_client_grant', 'deny_all', 'UNKNOWN'),
    proposedUserPolicy: choice('require_client_grant', 'deny_all', 'UNKNOWN'),
    tokenLifetimeSeconds: x => x === null || Number.isSafeInteger(x) && x > 0 && x <= 604800,
    refreshPathsReviewed: flag, defaultGrants: x => x === null || list(defaultGrant)(x), applications: list(application), grants: list(grant) }),
  mfa: x => object(x, { recordRef: nullableHash, complete: flag, administrators: list(x => object(x, {
    alias, enforcement: choice('ENFORCED', 'ENROLLED_ONLY', 'NOT_ENFORCED', 'UNKNOWN'),
    fallbacksCovered: flag, policyRef: nullableHash })) }),
  rollback: x => object(x, { recordRef: nullableHash, adminAccessConfirmed: flag, priorPolicyPreserved: flag,
    priorBindingsPreserved: flag, bindingsSnapshotSha256: nullableHash, previousVersion: priorVersion,
    stopOwnerAssigned: flag, windowApproved: flag, reopenBroadPolicyApproved: flag, tokenExposureReviewed: flag }),
  release: x => object(x, { recordRef: nullableHash, version: alias, runtime: choice('node22', 'UNKNOWN'),
    sourceSha256: nullableHash, artifactSha256: nullableHash, manifestSha256: nullableHash,
    bindingsSnapshotSha256: nullableHash, configurationNames: list(x => CONFIG_NAMES.includes(x)),
    clientIdSha256: nullableHash, connectionIdSha256: nullableHash, audienceSha256: nullableHash,
    serverManaged: flag, mappingApproved: flag, executionValidated: flag, bindingOrderReviewed: flag,
    deploymentApprovalRef: nullableHash }),
};
const timestamp = x => x === null || typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) &&
  Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;

export function parseEvidence(bytes) {
  const data = parseStrictJson(bytes);
  object(data, { schemaVersion: choice(1), environment: choice('development'), tenantRef: nullableHash,
    custodianRef: nullableHash, reviewerRef: nullableHash, capturedAt: timestamp, expiresAt: timestamp,
    sections: x => object(x, Object.fromEntries(SECTIONS.map(name => [name, nullableSection(validators[name])])), true) });
  const s = data.sections;
  for (const name of ['actions', 'rules']) if (s[name]) {
    const entries = name === 'actions' ? s.actions.bindings : s.rules.rules;
    unique(entries, x => x.alias); unique(entries, x => name === 'actions' ? x.position : x.order);
  }
  if (s.actions?.bindings.some((x, index) => x.position !== index)) throw invalid();
  if (s.rules && s.rules.kind !== 'INVENTORY' && s.rules.rules.length) throw invalid();
  if (s.capabilities) {
    unique(s.capabilities.principals, x => x.alias);
    unique(s.capabilities.routes, x => x.operation + ':' + x.principal);
    s.capabilities.principals.forEach(x => unique(x.capabilities));
  }
  if (s.management) {
    unique(s.management.applications, x => x.alias);
    unique(s.management.grants, x => x.application + ':' + x.subjectType);
    if (s.management.defaultGrants) { unique(s.management.defaultGrants, x => x.subjectType); s.management.defaultGrants.forEach(x => unique(x.scopes)); }
    for (const x of s.management.applications) { unique(x.userRequiredScopes); unique(x.clientRequiredScopes); }
    s.management.grants.forEach(x => unique(x.scopes));
  }
  if (s.mfa) unique(s.mfa.administrators, x => x.alias);
  if (s.release) unique(s.release.configurationNames);
  return data;
}

const unknown = code => result([check(null, code)]);
const linking = new Set(['LINK', 'UNLINK', 'PRIMARY_USER']);
// A supported subset only. Unclassified scopes block; arbitrary administrative scopes are not treated as benign.
const scopeOperations = {
  'read:users': [], 'create:users': ['CREATE', 'IMPORT'],
  'create:user_tickets': ['PASSWORD_RESET', 'EMAIL_VERIFY'],
  'update:users': ['RESTORE', 'PASSWORD_RESET', 'EMAIL_VERIFY', 'LINK', 'UNLINK', 'PRIMARY_USER'],
  'update:current_user_identities': ['LINK', 'UNLINK'],
  'delete:authentication_methods': ['MFA_RESET'], 'delete:guardian_enrollments': ['MFA_RESET'],
  'create:client_grants': ['DELEGATE'], 'update:client_grants': ['DELEGATE'],
  'update:clients': ['DELEGATE'], 'update:client_keys': ['DELEGATE'], 'update:client_credentials': ['DELEGATE'],
};
const grantAdministration = new Map([
  ['create:client_grants', 'GRANT_CREATION_CAPABILITY'],
  ['update:client_grants', 'GRANT_MODIFICATION_CAPABILITY'],
  ['update:clients', 'CLIENT_CONFIGURATION_CAPABILITY'],
  ['update:client_keys', 'CLIENT_KEY_CAPABILITY'],
  ['update:client_credentials', 'CLIENT_CREDENTIAL_CAPABILITY'],
]);
const clientControl = new Map([
  ['update:clients', 'CLIENT_CONFIGURATION'],
  ['update:client_keys', 'CLIENT_KEY'],
  ['update:client_credentials', 'CLIENT_CREDENTIAL'],
]);

// Application control can expose existing grants without directly changing a grant.
// This profile permits no application-held grant/configuration/credential administration, including self-administration.
function grantAdministrationChecks(m) {
  const checks = [];
  for (const app of m.applications) for (const type of ['user', 'client']) {
    for (const scope of app[type + 'RequiredScopes'].filter(scope => grantAdministration.has(scope))) {
      checks.push(check(false, clientControl.has(scope) ? clientControl.get(scope) + '_DEPENDENCY' : 'GRANT_ADMINISTRATION_DEPENDENCY'));
    }
  }
  for (const grant of m.grants) for (const scope of grant.scopes) {
    if (!Object.hasOwn(scopeOperations, scope)) checks.push(check(null, 'UNCLASSIFIED_MANAGEMENT_SCOPE'));
    if (grantAdministration.has(scope)) {
      const delegated = grant.subjectType === 'user';
      checks.push(check(false, grantAdministration.get(scope)), check(false, clientControl.has(scope)
        ? delegated ? 'DELEGATED_' + clientControl.get(scope) : 'CLIENT_ACCESS_' + clientControl.get(scope).slice('CLIENT_'.length)
        : delegated ? 'DELEGATED_GRANT_ADMINISTRATION' : 'CLIENT_GRANT_ADMINISTRATION'));
    }
  }
  for (const grant of m.defaultGrants ?? []) {
    for (const scope of grant.scopes.filter(scope => grantAdministration.has(scope))) {
      checks.push(check(false, clientControl.has(scope) ? 'DEFAULT_' + clientControl.get(scope) : 'DEFAULT_GRANT_ADMINISTRATION'));
    }
  }
  return checks;
}

function rollbackChecks(r, currentPolicy) {
  if (!r) return [check(null, 'ROLLBACK_MISSING')];
  return [...reviewed(r), ...['adminAccessConfirmed', 'priorPolicyPreserved', 'stopOwnerAssigned',
    'windowApproved', 'tokenExposureReviewed'].map(key => check(r[key], 'ROLLBACK_' + key.toUpperCase())),
    check(currentPolicy === 'allow_all' ? r.reopenBroadPolicyApproved : true, 'BROAD_POLICY_ROLLBACK_NOT_APPROVED')];
}

/** Pure evaluator: no token issuance, configuration mutation or inferred app dependencies. */
export function evaluateManagementPolicy(m, rollback) {
  try {
    if (!m) return { current: unknown('MANAGEMENT_MISSING'), proposal: unknown('MANAGEMENT_MISSING'), changeAllowed: false };
    validators.management(m); if (rollback) validators.rollback(rollback);
    unique(m.applications, x => x.alias); unique(m.grants, x => x.application + ':' + x.subjectType);
    if (m.defaultGrants) { unique(m.defaultGrants, x => x.subjectType); m.defaultGrants.forEach(x => unique(x.scopes)); }
    for (const x of m.applications) { unique(x.userRequiredScopes); unique(x.clientRequiredScopes); }
    m.grants.forEach(x => unique(x.scopes));
    const common = [...reviewed(m), complete(m.complete), complete(m.dependenciesComplete, 'DEPENDENCIES_INCOMPLETE'),
      complete(m.defaultsReviewed, 'DEFAULTS_UNREVIEWED'), check(m.supportedControl, 'CONTROL_UNSUPPORTED'),
      check(m.tokenLifetimeSeconds === null ? null : true, 'TOKEN_EXPOSURE_UNKNOWN'),
      complete(m.refreshPathsReviewed, 'REFRESH_PATHS_UNREVIEWED'),
      check(m.defaultGrants === null ? null : m.defaultGrants.length === 0, 'DEFAULT_MANAGEMENT_ELIGIBILITY'),
      ...grantAdministrationChecks(m)];
    const apps = new Map(m.applications.map(x => [x.alias, x]));
    common.push(check(apps.has('STAFF_PORTAL') ? true : null, 'STAFF_PORTAL_NOT_IN_INVENTORY'));
    for (const app of m.applications) {
      for (const type of ['user', 'client']) {
        const dependency = app[type + 'Dependency'], required = app[type + 'RequiredScopes'];
        common.push(check(dependency === 'UNKNOWN' ? null : true, 'DEPENDENCY_UNKNOWN'));
        common.push(check(dependency === 'NONE' && required.length ? false : true, 'DEPENDENCY_SCOPE_CONFLICT'));
        if (app.alias === 'STAFF_PORTAL') common.push(check(dependency === 'REQUIRED' || required.length ? false : true, 'STAFF_PORTAL_MANAGEMENT_DEPENDENCY'));
        if (dependency === 'REQUIRED') common.push(check(app.approved, 'DEPENDENCY_UNAPPROVED'),
          check(required.length > 0, 'REQUIRED_SCOPES_EMPTY'));
      }
    }
    for (const grant of m.grants) {
      const app = apps.get(grant.application);
      if (!app) { common.push(check(false, 'GRANT_APPLICATION_MISSING')); continue; }
      common.push(check(app.approved, 'GRANT_UNAPPROVED'));
      common.push(check(app.staffReach === 'UNKNOWN' ? null : true, 'GRANT_REACH_UNKNOWN'));
      common.push(check(app.reachEnforced, 'GRANT_REACH_UNENFORCED'),
        check(app.reachEvidenceRef === null ? null : true, 'GRANT_REACH_EVIDENCE_MISSING'));
      const required = app[grant.subjectType + 'RequiredScopes'];
      common.push(check(grant.scopes.every(scope => required.includes(scope)), 'EXCESS_GRANT_SCOPE'));
      common.push(check(app[grant.subjectType + 'Dependency'] === 'UNKNOWN' ? null :
        app[grant.subjectType + 'Dependency'] === 'REQUIRED', 'GRANT_WITHOUT_DEPENDENCY'));
      if (app.alias === 'STAFF_PORTAL') common.push(check(false, 'STAFF_PORTAL_MANAGEMENT_GRANT'));
      for (const scope of grant.scopes) {
        if (!Object.hasOwn(scopeOperations, scope)) common.push(check(null, 'UNCLASSIFIED_MANAGEMENT_SCOPE'));
        if (app.staffReach === 'STAFF' && scopeOperations[scope]?.some(x => linking.has(x))) common.push(check(false, 'LINKING_CAPABLE_GRANT'));
      }
    }
    const current = [...common, check(m.userPolicy === 'UNKNOWN' ? null : m.userPolicy !== 'allow_all', 'BROAD_USER_POLICY'),
      check(m.clientPolicy === 'UNKNOWN' ? null : true, 'CLIENT_POLICY_UNKNOWN')];
    const proposal = [...common, ...rollbackChecks(rollback, m.userPolicy),
      check(m.proposedUserPolicy === 'UNKNOWN' ? null : true, 'PROPOSED_POLICY_UNKNOWN'),
      check(m.userPolicy === 'UNKNOWN' || m.clientPolicy === 'UNKNOWN' ? null : true, 'CURRENT_POLICY_UNKNOWN')];
    for (const app of m.applications) for (const type of ['user', 'client']) {
      const required = app[type + 'RequiredScopes'], dependency = app[type + 'Dependency'];
      const actual = m.grants.find(g => g.application === app.alias && g.subjectType === type)?.scopes ?? [];
      const currentPolicy = type === 'user' ? m.userPolicy : m.clientPolicy;
      if (dependency === 'REQUIRED') {
        const permitted = currentPolicy !== 'deny_all' && (currentPolicy === 'allow_all' || required.every(x => actual.includes(x)));
        current.push(check(permitted, 'REQUIRED_DEPENDENCY_NOT_GRANTED'));
        if (type === 'user') proposal.push(check(m.proposedUserPolicy === 'require_client_grant' && required.every(x => actual.includes(x)), 'PROPOSED_DEPENDENCY_BROKEN'));
      }
    }
    return { current: result(current), proposal: result(proposal), changeAllowed: false };
  } catch { return { current: result([check(false, 'MALFORMED_POLICY')]), proposal: result([check(false, 'MALFORMED_POLICY')]), changeAllowed: false }; }
}

function capabilities(c, operations) {
  if (!c) return unknown('CAPABILITIES_MISSING');
  const checks = [...reviewed(c), complete(c.complete)];
  if (operations.includes('DELEGATE')) checks.push(check(c.grantEscalationBlocked, 'GRANT_ESCALATION_UNCONTROLLED'));
  const principals = new Map(c.principals.map(x => [x.alias, x]));
  for (const operation of operations) {
    const routes = c.routes.filter(x => x.operation === operation);
    checks.push(complete(routes.length > 0, 'OPERATION_COVERAGE_MISSING'));
    for (const route of routes) {
      if (route.enabled === null) { checks.push(check(null, 'ROUTE_STATE_UNKNOWN')); continue; }
      if (!route.enabled) continue;
      const actor = principals.get(route.principal);
      checks.push(check(!!actor && actor.capabilities.includes(operation), 'ROUTE_PRINCIPAL_CONFLICT'));
      checks.push(check(route.approved, 'ROUTE_UNAPPROVED'));
      checks.push(check(route.procedureRef === null ? null : true, 'PROCEDURE_MISSING'));
      if (linking.has(operation)) checks.push(check(false, 'LINKING_ENABLED'));
      if (actor) {
        checks.push(check(actor.approved, 'PRINCIPAL_UNAPPROVED'));
        checks.push(check(actor.staffReach === 'UNKNOWN' ? null : actor.staffReach !== 'NONE', 'PRINCIPAL_REACH_CONFLICT'));
        checks.push(check(actor.scopeEnforced, 'PRINCIPAL_SCOPE_UNENFORCED'));
        if (actor.kind === 'INTEGRATION') checks.push(check(actor.staffReach === 'STAFF_ONLY', 'INTEGRATION_REACH_BROAD'));
      }
    }
    for (const actor of c.principals.filter(x => x.capabilities.includes(operation))) {
      const matching = routes.filter(x => x.principal === actor.alias);
      checks.push(check(matching.some(x => x.enabled === true) ? true :
        !matching.length || matching.some(x => x.enabled === null) ? null : false, 'CAPABILITY_ROUTE_CONFLICT'));
    }
  }
  if (operations.includes('MFA_RESET')) for (const value of Object.values(c.recovery)) checks.push(check(value, 'RECOVERY_BYPASS_OR_UNKNOWN'));
  return result(checks);
}

function evaluateSections(s) {
  const gates = {};
  gates.domain = !s.domain ? unknown('DOMAIN_MISSING') : result([...reviewed(s.domain),
    check(s.domain.ownership === 'INDEPENDENT' ? true : null, 'INDEPENDENT_DOMAIN_CONTROL_MISSING'),
    check(s.domain.reservation === 'UNKNOWN' ? null : s.domain.reservation === 'APPROVED', 'NAMESPACE_NOT_APPROVED')]);
  const a = s.actions;
  gates.actions = !a ? unknown('ACTIONS_MISSING') : result([...reviewed(a), complete(a.complete),
    check(a.libraryCount === null ? null : true, 'ACTION_LIBRARY_COUNT_UNKNOWN'),
    check(a.installedIntegrationCount === null ? null : true, 'INSTALLED_INTEGRATION_COUNT_UNKNOWN'),
    complete(a.claimWritersReviewed, 'CLAIM_WRITERS_UNREVIEWED'), ...a.bindings.flatMap(x => [
      check(x.principalWriter === null ? null : !x.principalWriter, 'EXISTING_PRINCIPAL_WRITER'),
      check(x.appliesToStaff === null ? null : !(x.appliesToStaff && x.identityMutation), 'ACTION_IDENTITY_MUTATION'),
      check(x.identityMutation === null ? null : true, 'ACTION_EFFECT_UNKNOWN')])]);
  const r = s.rules;
  gates.rules = !r ? unknown('RULES_MISSING') : result([...reviewed(r), complete(r.complete),
    check(['UI_ONLY', 'UNKNOWN'].includes(r.kind) ? null : true, 'RULE_EXECUTION_UNVERIFIED'),
    ...r.rules.flatMap(x => [check(x.enabled === null ? null : true, 'RULE_STATE_UNKNOWN'),
      ...(!x.enabled ? [] : [check(x.principalWriter === null ? null : !x.principalWriter, 'RULE_PRINCIPAL_WRITER'),
        check(x.appliesToStaff === null || x.identityMutation === null ? null : !(x.appliesToStaff && x.identityMutation), 'RULE_IDENTITY_MUTATION')])])]);
  gates.provisioning = capabilities(s.capabilities, ['CREATE', 'IMPORT', 'DELEGATE']);
  gates.recovery = capabilities(s.capabilities, ['PASSWORD_RESET', 'EMAIL_VERIFY', 'MFA_RESET', 'RESTORE']);
  gates.linking = capabilities(s.capabilities, ['LINK', 'UNLINK', 'PRIMARY_USER']);
  const policy = evaluateManagementPolicy(s.management, s.rollback);
  gates.management = policy.current; gates.policyProposal = policy.proposal;
  const delegation = [];
  if (!s.management || !s.capabilities) delegation.push(check(null, 'DELEGATION_INVENTORY_MISSING'));
  else {
    delegation.push(...reviewed(s.management), ...reviewed(s.capabilities), complete(s.management.complete),
      complete(s.management.dependenciesComplete, 'DEPENDENCIES_INCOMPLETE'), complete(s.management.defaultsReviewed, 'DEFAULTS_UNREVIEWED'),
      complete(s.capabilities.complete), check(s.capabilities.grantEscalationBlocked, 'GRANT_ESCALATION_UNCONTROLLED'),
      check(s.management.defaultGrants === null ? null : true, 'DEFAULT_GRANTS_UNKNOWN'), ...grantAdministrationChecks(s.management));
    for (const actor of s.capabilities.principals.filter(x => x.kind === 'INTEGRATION' && x.capabilities.includes('DELEGATE'))) {
      const actual = s.management.grants.some(x => x.application === actor.alias && x.scopes.some(scope => grantAdministration.has(scope)));
      if (!actual) delegation.push(check(null, 'INTEGRATION_DELEGATION_SOURCE_UNKNOWN'));
    }
  }
  gates.grantAdministration = result(delegation);
  const cross = [];
  if (!s.capabilities || !s.management) cross.push(check(null, 'EFFECTIVE_RIGHTS_CORRELATION_MISSING'));
  else {
    cross.push(...reviewed(s.capabilities), ...reviewed(s.management), complete(s.capabilities.complete), complete(s.management.complete));
    for (const grant of s.management.grants) for (const scope of grant.scopes) {
      const app = s.management.applications.find(x => x.alias === grant.application);
      const administersGrants = grantAdministration.has(scope);
      // A connection reach assertion cannot bound control over an application's settings, grants or credentials.
      if (app?.staffReach === 'NONE' && !administersGrants) continue;
      const actor = s.capabilities.principals.find(x => x.alias === grant.application);
      if (!Object.hasOwn(scopeOperations, scope)) { cross.push(check(null, 'UNCLASSIFIED_MANAGEMENT_SCOPE')); continue; }
      if (administersGrants) {
        cross.push(check(s.capabilities.grantEscalationBlocked === true ? false : s.capabilities.grantEscalationBlocked === null ? null : true,
          clientControl.has(scope) ? clientControl.get(scope) + '_ESCALATION_CONFLICT' : 'GRANT_ESCALATION_EVIDENCE_CONFLICT'));
        cross.push(check(actor === undefined ? null : actor.kind === 'INTEGRATION',
          clientControl.has(scope) ? clientControl.get(scope) + '_HOLDER_KIND_CONFLICT' : 'GRANT_HOLDER_KIND_CONFLICT'));
      }
      for (const operation of scopeOperations[scope]) cross.push(check(!!actor && actor.capabilities.includes(operation), 'GRANT_CAPABILITY_CONFLICT'));
    }
  }
  gates.effectiveRights = result(cross);
  const mfa = s.mfa;
  if (!mfa || !s.capabilities) gates.mfa = unknown('MFA_OR_ADMIN_INVENTORY_MISSING');
  else {
    const checks = [...reviewed(mfa), complete(mfa.complete)];
    const admins = s.capabilities.principals.filter(x => x.kind === 'ADMIN');
    checks.push(check(admins.length > 0 ? true : null, 'ADMIN_INVENTORY_EMPTY'));
    checks.push(check(mfa.administrators.every(x => admins.some(y => y.alias === x.alias)), 'MFA_ADMIN_CONFLICT'));
    for (const admin of admins) {
      const entry = mfa.administrators.find(x => x.alias === admin.alias);
      if (!entry) { checks.push(check(null, 'ADMIN_MFA_MISSING')); continue; }
      checks.push(check(admin.approved, 'ADMIN_UNAPPROVED'));
      checks.push(check(entry.enforcement === 'NOT_ENFORCED' ? false : entry.enforcement === 'ENFORCED' ? true : null, 'MFA_NOT_ENFORCED'));
      checks.push(check(entry.fallbacksCovered, 'MFA_FALLBACK_UNCOVERED'));
      checks.push(check(entry.policyRef === null ? null : true, 'MFA_POLICY_REFERENCE_MISSING'));
    }
    gates.mfa = result(checks);
  }
  const rb = s.rollback;
  gates.rollback = !rb ? unknown('ROLLBACK_MISSING') : result([...rollbackChecks(rb, s.management?.userPolicy),
    check(rb.priorBindingsPreserved, 'PRIOR_BINDINGS_NOT_PRESERVED'), check(rb.previousVersion.artifactPreserved, 'PRIOR_ARTIFACT_NOT_PRESERVED'),
    check(rb.previousVersion.kind === 'UNKNOWN' || !a ? null : rb.previousVersion.kind === 'EMPTY'
      ? a?.bindings.length === 0 && rb.previousVersion.sourceSha256 === null && rb.previousVersion.versionRef === null
      : hash(rb.previousVersion.sourceSha256) && alias(rb.previousVersion.versionRef), 'PRIOR_VERSION_CONFLICT'),
    check(!a || rb.bindingsSnapshotSha256 === null ? null : rb.bindingsSnapshotSha256 === digest(a.bindings), 'ROLLBACK_BINDINGS_CHANGED')]);
  const rel = s.release;
  gates.release = !rel ? unknown('RELEASE_REVIEW_MISSING') : result([...reviewed(rel),
    ...[['sourceSha256', SOURCE_SHA256], ['artifactSha256', SOURCE_SHA256], ['manifestSha256', MANIFEST_SHA256],
      ['version', 'STAFF_HUMAN_PRINCIPAL_DEV_V1'], ['runtime', 'node22']].map(([key, value]) =>
      check(rel[key] === null || rel[key] === 'UNKNOWN' ? null : rel[key] === value, 'RELEASE_ARTIFACT_CONFLICT')),
    check(CONFIG_NAMES.every(x => rel.configurationNames.includes(x)) && rel.configurationNames.length === CONFIG_NAMES.length, 'PROTECTED_NAMES_CONFLICT'),
    ...['clientIdSha256', 'connectionIdSha256', 'audienceSha256', 'deploymentApprovalRef'].map(key => check(rel[key] === null ? null : true, 'PROTECTED_MAPPING_OR_APPROVAL_MISSING')),
    ...['serverManaged', 'mappingApproved', 'executionValidated', 'bindingOrderReviewed'].map(key => check(rel[key], 'RELEASE_CONDITION_UNSATISFIED')),
    check(!a || rel.bindingsSnapshotSha256 === null ? null : rel.bindingsSnapshotSha256 === digest(a.bindings), 'RELEASE_BINDINGS_CHANGED')]);
  return gates;
}

export function evaluateEvidence(bytes, { approvedSha256, expectedTenantRef, now = Date.now() } = {}) {
  try {
    const data = parseEvidence(bytes);
    const checks = [check(approvedSha256 === undefined ? null : hash(approvedSha256) && sha256(bytes) === approvedSha256, 'APPROVAL_DIGEST_MISSING_OR_MISMATCH'),
      check(expectedTenantRef === undefined || data.tenantRef === null ? null : hash(expectedTenantRef) && data.tenantRef === expectedTenantRef, 'TENANT_BINDING_MISSING_OR_MISMATCH'),
      check(data.custodianRef === null || data.reviewerRef === null ? null : data.custodianRef !== data.reviewerRef, 'INDEPENDENT_REVIEW_REFERENCE_MISSING'),
      check(data.capturedAt === null || data.expiresAt === null ? null : Number.isSafeInteger(now) &&
        Date.parse(data.capturedAt) <= now && now < Date.parse(data.expiresAt) &&
        Date.parse(data.expiresAt) - Date.parse(data.capturedAt) <= 7 * 86400000, 'SNAPSHOT_EXPIRED_OR_INVALID')];
    const gates = { evidence: result(checks), ...evaluateSections(data.sections) };
    if (gates.evidence.status !== 'VERIFIED') for (const [key, value] of Object.entries(gates)) {
      if (key !== 'evidence' && value.status === 'VERIFIED') gates[key] = unknown('EVIDENCE_NOT_APPROVED');
    }
    return safeReport(gates, { evidenceReady: Object.values(gates).every(x => x.status === 'VERIFIED') });
  } catch { return safeReport({ evidence: result([check(false, 'MALFORMED_OR_CONFLICTING_EVIDENCE')]) }, { evidenceReady: false }); }
}

export function readEvidenceFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw invalid();
  return readFileSync(path);
}
export function parseArguments(args, names) {
  if (args.length % 2) throw invalid(); const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]; if (!names.includes(key) || Object.hasOwn(values, key) || !args[i + 1]) throw invalid(); values[key] = args[i + 1];
  }
  return values;
}
export const reportExitCode = report => report.status === 'VERIFIED' ? 0 : report.status === 'UNKNOWN' ? 2 : 1;
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let report;
  try {
    const args = parseArguments(process.argv.slice(2), ['--evidence', '--tenant-ref', '--approved-sha256']);
    if (!args['--evidence']) throw invalid();
    report = evaluateEvidence(readEvidenceFile(args['--evidence']), { approvedSha256: args['--approved-sha256'], expectedTenantRef: args['--tenant-ref'] });
  } catch { report = safeReport({ evidence: result([check(false, 'INPUT_REJECTED')]) }); }
  console.info(JSON.stringify(report)); process.exitCode = reportExitCode(report);
}
