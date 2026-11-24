// SYNTHETIC UNIT EVIDENCE ONLY. Never an approved tenant record or deployment authorization.
import { CLAIM, CONFIG_NAMES, SOURCE_SHA256, MANIFEST_SHA256, manifest, OPERATIONS, digest, sha256 } from '../../auth0/security-contract.mjs';
export const NOW = Date.now();
export const tenantRef = '1'.repeat(64);
export const ref = 'a'.repeat(64);
export function evidence() {
  return {
    schemaVersion: 1, environment: 'development', tenantRef, custodianRef: 'b'.repeat(64), reviewerRef: 'c'.repeat(64),
    capturedAt: new Date(NOW - 1000).toISOString(), expiresAt: new Date(NOW + 3600000).toISOString(),
    sections: {
      domain: { recordRef: ref, ownership: 'INDEPENDENT', reservation: 'APPROVED', claim: CLAIM, value: 'human' },
      actions: { recordRef: ref, complete: true, claimWritersReviewed: true, libraryCount: 0, installedIntegrationCount: 0, bindings: [] },
      rules: { recordRef: ref, kind: 'INVENTORY', complete: true, rules: [] },
      capabilities: { recordRef: ref, complete: true, grantEscalationBlocked: true,
        principals: [{ alias: 'ADMIN_A', kind: 'ADMIN', approved: true, staffReach: 'STAFF_ONLY', scopeEnforced: true,
          capabilities: ['CREATE', 'IMPORT', 'PASSWORD_RESET', 'EMAIL_VERIFY', 'MFA_RESET', 'RESTORE', 'DELEGATE'] }],
        routes: OPERATIONS.map(operation => ({ operation, enabled: !['LINK', 'UNLINK', 'PRIMARY_USER'].includes(operation),
          principal: ['LINK', 'UNLINK', 'PRIMARY_USER'].includes(operation) ? null : 'ADMIN_A',
          approved: true, procedureRef: ref })),
        recovery: { immutableBinding: true, nativeMfaRequired: true, freshAuthRequired: true, cutoffProcedure: true, notifications: true } },
      management: { recordRef: ref, complete: true, dependenciesComplete: true, defaultsReviewed: true, supportedControl: true,
        userPolicy: 'deny_all', clientPolicy: 'require_client_grant', proposedUserPolicy: 'deny_all',
        tokenLifetimeSeconds: 300, refreshPathsReviewed: true, defaultGrants: [],
        applications: [{ alias: 'STAFF_PORTAL', approved: true, staffReach: 'STAFF', reachEnforced: true, reachEvidenceRef: ref, userDependency: 'NONE', clientDependency: 'NONE',
          userRequiredScopes: [], clientRequiredScopes: [] }], grants: [] },
      mfa: { recordRef: ref, complete: true, administrators: [{ alias: 'ADMIN_A', enforcement: 'ENFORCED', fallbacksCovered: true, policyRef: ref }] },
      rollback: { recordRef: ref, adminAccessConfirmed: true, priorPolicyPreserved: true, priorBindingsPreserved: true,
        bindingsSnapshotSha256: digest([]), previousVersion: { kind: 'EMPTY', sourceSha256: null, versionRef: null, artifactPreserved: true },
        stopOwnerAssigned: true, windowApproved: true, reopenBroadPolicyApproved: true, tokenExposureReviewed: true },
      release: { recordRef: ref, version: manifest.version, runtime: manifest.runtime, sourceSha256: SOURCE_SHA256,
        artifactSha256: SOURCE_SHA256, manifestSha256: MANIFEST_SHA256, bindingsSnapshotSha256: digest([]),
        configurationNames: [...CONFIG_NAMES], clientIdSha256: '2'.repeat(64), connectionIdSha256: '3'.repeat(64), audienceSha256: '4'.repeat(64),
        serverManaged: true, mappingApproved: true, executionValidated: true, bindingOrderReviewed: true, deploymentApprovalRef: ref },
    },
  };
}
export const bytesOf = value => Buffer.from(JSON.stringify(value));
export const optionsFor = bytes => ({ expectedTenantRef: tenantRef, approvedSha256: sha256(bytes), now: NOW });
export const binding = () => ({ alias: 'EXISTING_REVIEWED_ACTION', sourceSha256: ref, position: 0,
  principalWriter: false, identityMutation: false, appliesToStaff: true });
export function readDependency(value, subjectType = 'user') {
  const m = value.sections.management;
  m.applications.push({ alias: 'READ_SERVICE', approved: true, staffReach: 'STAFF', reachEnforced: true, reachEvidenceRef: ref, userDependency: 'NONE', clientDependency: 'NONE',
    userRequiredScopes: [], clientRequiredScopes: [], [subjectType + 'Dependency']: 'REQUIRED', [subjectType + 'RequiredScopes']: ['read:users'] });
  m.grants.push({ application: 'READ_SERVICE', subjectType, scopes: ['read:users'] });
  if (subjectType === 'user') { m.userPolicy = 'require_client_grant'; m.proposedUserPolicy = 'require_client_grant'; }
  return value;
}
