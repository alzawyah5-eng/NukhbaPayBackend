import {
  ACTIVE_AUTHORIZATION_PHASE,
  findPermissionDefinition,
  findRoleDefinition,
  type ActivationPhase,
} from "./permission-catalog.js";
import { isVerifiedStaffIdentity } from "./verified-staff-identity.js";

export type StaffStatus = "PENDING" | "ACTIVE" | "SUSPENDED" | "DISABLED";
export type StaffIdentityStatus = "ACTIVE" | "DISABLED";
export type StaffMembershipStatus = "ACTIVE" | "SUSPENDED" | "REVOKED";
export type StaffGrantScope = "PLATFORM" | "TENANT";

export interface TrustedStaffIdentity {
  readonly issuer: string;
  readonly subject: string;
}

export interface ResolvedStaffPrincipal {
  readonly staffId: string;
  readonly staffStatus: StaffStatus;
  readonly identityStatus: StaffIdentityStatus;
  readonly authzVersion: bigint;
  readonly tokensValidAfter: string | null;
}

export interface StaffRoleGrant {
  readonly roleCode: string;
  readonly scope: StaffGrantScope;
  readonly grantedAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

export interface ResolvedStaffMembership {
  readonly membershipId: string;
  readonly tenantId: string;
  readonly status: StaffMembershipStatus;
  readonly version: bigint;
  readonly roleGrants: readonly StaffRoleGrant[];
}

export interface StaffAuthorizationRepository {
  readonly findByTrustedIdentity: (
    identity: TrustedStaffIdentity,
  ) => Promise<ResolvedStaffPrincipal | null>;
  readonly findTenantMembership: (
    staffId: string,
    tenantId: string,
  ) => Promise<ResolvedStaffMembership | null>;
  readonly findPlatformRoleGrants: (
    staffId: string,
  ) => Promise<readonly StaffRoleGrant[]>;
}

function validateIdentityAndTenant(
  identity: TrustedStaffIdentity,
  tenantId?: string,
): void {
  if (
    typeof identity.issuer !== "string" ||
    identity.issuer.length === 0 ||
    identity.issuer.length > 512 ||
    typeof identity.subject !== "string" ||
    identity.subject.length === 0 ||
    identity.subject.length > 512 ||
    (tenantId !== undefined && (typeof tenantId !== "string" || tenantId.length === 0))
  ) {
    throw new TypeError("Trusted identity and tenant context are required");
  }
}

export async function resolveStaffIdentity(
  repository: StaffAuthorizationRepository,
  identity: TrustedStaffIdentity,
): Promise<ResolvedStaffPrincipal | null> {
  validateIdentityAndTenant(identity);
  const principal = await repository.findByTrustedIdentity(identity);
  if (principal === null) return null;
  // Only signed issuance evidence can pass a persisted emergency cutoff. Missing
  // or malformed repository values fail closed, including structural identities.
  if (principal.tokensValidAfter !== null) {
    const cutoff = typeof principal.tokensValidAfter === "string" ? Date.parse(principal.tokensValidAfter) : NaN;
    if (!Number.isFinite(cutoff) || !isVerifiedStaffIdentity(identity) ||
        !Number.isSafeInteger(identity.security.issuedAt) || identity.security.issuedAt * 1000 <= cutoff) return null;
  }
  return principal;
}

export interface ResolvedStaffTenantContext {
  readonly principal: ResolvedStaffPrincipal | null;
  readonly membership: ResolvedStaffMembership | null;
  readonly platformRoleGrants: readonly StaffRoleGrant[];
}

export async function resolveStaffTenantContext(
  repository: StaffAuthorizationRepository,
  identity: TrustedStaffIdentity,
  tenantId: string,
): Promise<ResolvedStaffTenantContext> {
  validateIdentityAndTenant(identity, tenantId);
  const principal = await resolveStaffIdentity(repository, identity);
  if (principal === null) {
    return { principal: null, membership: null, platformRoleGrants: [] };
  }
  if (principal.staffStatus !== "ACTIVE" || principal.identityStatus !== "ACTIVE") {
    return { principal, membership: null, platformRoleGrants: [] };
  }

  const [membership, platformRoleGrants] = await Promise.all([
    repository.findTenantMembership(principal.staffId, tenantId),
    repository.findPlatformRoleGrants(principal.staffId),
  ]);
  return { principal, membership, platformRoleGrants };
}

export interface ResolvedStaffPlatformContext {
  readonly principal: ResolvedStaffPrincipal | null;
  readonly platformRoleGrants: readonly StaffRoleGrant[];
}

export async function resolveStaffPlatformContext(
  repository: StaffAuthorizationRepository,
  identity: TrustedStaffIdentity,
): Promise<ResolvedStaffPlatformContext> {
  const principal = await resolveStaffIdentity(repository, identity);
  if (principal === null || principal.staffStatus !== "ACTIVE" || principal.identityStatus !== "ACTIVE") {
    return { principal, platformRoleGrants: [] };
  }
  return {
    principal,
    platformRoleGrants: await repository.findPlatformRoleGrants(principal.staffId),
  };
}

export interface StaffAuthorizationRequest {
  readonly permissionCode: string;
  readonly scope: "SELF" | "PLATFORM" | "TENANT";
  readonly now: string;
  readonly tenantId?: string;
  readonly objectTenantId?: string;
  readonly targetStaffId?: string;
  readonly proposalCreatorStaffId?: string;
}

export interface StaffAuthorizationContext {
  readonly principal: ResolvedStaffPrincipal | null;
  readonly membership: ResolvedStaffMembership | null;
  readonly platformRoleGrants: readonly StaffRoleGrant[];
}

export type StaffAuthorizationReason =
  | "ALLOW"
  | "MISSING_CONTEXT"
  | "IDENTITY_NOT_FOUND"
  | "STAFF_NOT_ACTIVE"
  | "MEMBERSHIP_NOT_ACTIVE"
  | "PERMISSION_UNKNOWN"
  | "PERMISSION_INACTIVE"
  | "SCOPE_MISMATCH"
  | "GRANT_INACTIVE"
  | "TENANT_MISMATCH"
  | "ROLE_CONFLICT"
  | "SELF_APPROVAL";

export interface StaffAuthorizationDecision {
  readonly allowed: boolean;
  readonly reason: StaffAuthorizationReason;
}

function deny(reason: Exclude<StaffAuthorizationReason, "ALLOW">): StaffAuthorizationDecision {
  return { allowed: false, reason };
}

function grantIsActive(grant: StaffRoleGrant, now: number): boolean {
  const grantedAt = Date.parse(grant.grantedAt);
  const expiresAt = grant.expiresAt === null ? null : Date.parse(grant.expiresAt);
  if (
    !Number.isFinite(grantedAt) ||
    (expiresAt !== null && !Number.isFinite(expiresAt)) ||
    (grant.revokedAt !== null && !Number.isFinite(Date.parse(grant.revokedAt)))
  ) {
    return false;
  }
  return grantedAt <= now &&
    (expiresAt === null || now < expiresAt) &&
    grant.revokedAt === null;
}

function roleConflict(roleCodes: ReadonlySet<string>, scope: StaffGrantScope): boolean {
  if (scope === "TENANT") {
    return (
      (roleCodes.has("CATALOG_OPERATOR") && roleCodes.has("CATALOG_REVIEWER")) ||
      (roleCodes.has("PRICING_EDITOR") && roleCodes.has("PRICING_APPROVER"))
    );
  }
  const approvalRoles = ["GOVERNANCE_OWNER", "SECURITY_ADMIN", "ACCESS_ADMIN"];
  return approvalRoles.filter((role) => roleCodes.has(role)).length > 1;
}

interface RoleCodeSets {
  readonly active: ReadonlySet<string>;
  readonly assigned: ReadonlySet<string>;
}

function roleCodes(
  grants: readonly StaffRoleGrant[],
  scope: StaffGrantScope,
  now: number,
): RoleCodeSets | null {
  const active = new Set<string>();
  const assigned = new Set<string>();
  for (const grant of grants) {
    const role = findRoleDefinition(grant.roleCode);
    if (role === undefined || role.scope !== grant.scope) return null;
    if (grant.scope === scope && grant.revokedAt === null) {
      assigned.add(grant.roleCode);
      if (grantIsActive(grant, now)) active.add(grant.roleCode);
    }
  }
  return { active, assigned };
}

export function rolePermissionCodes(roleCode: string): readonly string[] | null {
  const role = findRoleDefinition(roleCode);
  return role?.permissions ?? null;
}

export function authorizeStaffAccess(
  context: StaffAuthorizationContext | null | undefined,
  request: StaffAuthorizationRequest | null | undefined,
): StaffAuthorizationDecision {
  return evaluateStaffAccess(context, request);
}

export interface IsolatedStaffReadScope {
  readonly staffId: string;
  readonly tenantId: string;
}

/** Explicit local test composition for the enrolled viewer and the two management reads. */
export function authorizeIsolatedStaffRead(
  context: StaffAuthorizationContext,
  request: StaffAuthorizationRequest,
  scope: IsolatedStaffReadScope,
): StaffAuthorizationDecision {
  if (request.scope !== "TENANT" || request.tenantId !== scope.tenantId ||
      context.principal?.staffId !== scope.staffId ||
      !["tenant.staff.read", "tenant.audit.read"].includes(request.permissionCode)) {
    return deny("SCOPE_MISMATCH");
  }
  return evaluateStaffAccess(context, request, ["TENANT_STAFF_VIEWER"]);
}

/** Opt-in local workspace permissions. Catalogue and privileged IAM commands retain their original gates. */
export function authorizeIsolatedTenantWorkspace(
  context: StaffAuthorizationContext,
  request: StaffAuthorizationRequest,
  tenantId: string,
): StaffAuthorizationDecision {
  if (request.scope !== "TENANT" || request.tenantId !== tenantId ||
      !["tenant.staff.read","tenant.audit.read","tenant.access.request","tenant.departments.manage"].includes(request.permissionCode)) {
    return deny("SCOPE_MISMATCH");
  }
  return evaluateStaffAccess(context, request, ["TENANT_STAFF_VIEWER", "TENANT_STAFF_MANAGER"]);
}

/** The local catalogue preview delegates a single read permission to a bound staff manager. */
export function authorizeIsolatedCataloguePreview(
  context: StaffAuthorizationContext,
  request: StaffAuthorizationRequest,
  scope: IsolatedStaffReadScope,
): StaffAuthorizationDecision {
  if (request.scope !== "TENANT" || request.permissionCode !== "catalog.read" ||
      request.tenantId !== scope.tenantId || context.principal?.staffId !== scope.staffId) {
    return deny("SCOPE_MISMATCH");
  }
  return evaluateStaffAccess(context, { ...request, permissionCode: "tenant.staff.read" }, ["TENANT_STAFF_MANAGER"]);
}

/** Activate the existing catalogue read permission for the configured staging tenant. */
export function authorizeStagingCatalogueRead(
  context: StaffAuthorizationContext,
  request: StaffAuthorizationRequest,
  tenantId: string,
): StaffAuthorizationDecision {
  if (request.scope !== "TENANT" || request.permissionCode !== "catalog.read" || request.tenantId !== tenantId) {
    return deny("SCOPE_MISMATCH");
  }
  return evaluateStaffAccess(context, request, undefined, "4");
}

export function activeTenantRoleCodes(context: ResolvedStaffTenantContext, now: number): readonly string[] {
  const membership=context.membership;
  if (!membership || membership.status!=="ACTIVE") return [];
  const roles=roleCodes(membership.roleGrants,"TENANT",now);
  return roles && !roleConflict(roles.assigned,"TENANT") ? [...roles.active].sort() : [];
}

function evaluateStaffAccess(
  context: StaffAuthorizationContext | null | undefined,
  request: StaffAuthorizationRequest | null | undefined,
  isolatedRoles?: readonly string[],
  tenantActivationPhase: ActivationPhase = ACTIVE_AUTHORIZATION_PHASE,
): StaffAuthorizationDecision {
  if (context == null || request == null || context.principal === null) {
    return deny("MISSING_CONTEXT");
  }
  if (context.principal.staffStatus !== "ACTIVE" || context.principal.identityStatus !== "ACTIVE") {
    return deny("STAFF_NOT_ACTIVE");
  }

  const permission = findPermissionDefinition(request.permissionCode);
  if (permission === undefined) return deny("PERMISSION_UNKNOWN");
  if (permission.scope !== request.scope) return deny("SCOPE_MISMATCH");

  const now = Date.parse(request.now);
  if (!Number.isFinite(now)) return deny("MISSING_CONTEXT");

  if (request.permissionCode === "pricing.approve") {
    if (request.proposalCreatorStaffId === undefined) return deny("MISSING_CONTEXT");
    if (request.proposalCreatorStaffId === context.principal.staffId) {
      return deny("SELF_APPROVAL");
    }
  }

  if (request.scope === "SELF") {
    if (
      request.permissionCode !== "staff.self.read" ||
      request.targetStaffId !== context.principal.staffId
    ) {
      return deny("SCOPE_MISMATCH");
    }
    return { allowed: true, reason: "ALLOW" };
  }

  if (request.scope === "PLATFORM") {
    if (request.tenantId !== undefined || request.objectTenantId !== undefined) {
      return deny("SCOPE_MISMATCH");
    }
    const roles = roleCodes(context.platformRoleGrants, "PLATFORM", now);
    if (roles === null) return deny("SCOPE_MISMATCH");
    if (roleConflict(roles.assigned, "PLATFORM")) return deny("ROLE_CONFLICT");
    if (!hasPermission(roles.active, request.permissionCode)) return deny("GRANT_INACTIVE");
    if (permission.activationPhase !== ACTIVE_AUTHORIZATION_PHASE) {
      return deny("PERMISSION_INACTIVE");
    }
    return { allowed: true, reason: "ALLOW" };
  }

  if (
    request.tenantId === undefined ||
    request.objectTenantId === undefined ||
    request.tenantId !== request.objectTenantId
  ) {
    return deny("TENANT_MISMATCH");
  }
  const membership = context.membership;
  if (
    membership === null ||
    membership.status !== "ACTIVE" ||
    membership.tenantId !== request.tenantId
  ) {
    return deny("MEMBERSHIP_NOT_ACTIVE");
  }
  const roles = roleCodes(membership.roleGrants, "TENANT", now);
  if (roles === null) return deny("SCOPE_MISMATCH");
  if (roleConflict(roles.assigned, "TENANT")) return deny("ROLE_CONFLICT");
  if (isolatedRoles && !isolatedRoles.some(role => roles.active.has(role) &&
      findRoleDefinition(role)?.permissions.includes(request.permissionCode))) return deny("GRANT_INACTIVE");
  if (!hasPermission(roles.active, request.permissionCode)) return deny("GRANT_INACTIVE");
  if (permission.activationPhase !== tenantActivationPhase &&
      !(isolatedRoles && permission.activationPhase === "3C")) {
    return deny("PERMISSION_INACTIVE");
  }
  return { allowed: true, reason: "ALLOW" };
}

function hasPermission(roleCodes: ReadonlySet<string>, permissionCode: string): boolean {
  for (const roleCode of roleCodes) {
    const role = findRoleDefinition(roleCode);
    if (role?.permissions.includes(permissionCode)) return true;
  }
  return false;
}
