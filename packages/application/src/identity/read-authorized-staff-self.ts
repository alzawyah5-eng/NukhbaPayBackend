import {
  authorizeStaffAccess, resolveStaffIdentity, resolveStaffPlatformContext, resolveStaffTenantContext,
  type StaffAuthorizationContext, type StaffAuthorizationReason,
  type StaffAuthorizationRepository, type StaffAuthorizationRequest,
} from "./staff-access.js";
import { recordSecurityAuditEvents, type SecurityAuditWriter } from "./security-audit.js";
import { isVerifiedStaffIdentity, type VerifiedStaffIdentity } from "./verified-staff-identity.js";

export interface InternalStaffRequest extends Omit<StaffAuthorizationRequest, "now" | "permissionCode"> {
  readonly permissionCode?: string;
  readonly requestId: string;
}

export type StaffSelfResult =
  | Readonly<{
    allowed: true;
    auditRecorded: true;
    staff: Readonly<{
      staffId: string;
      authzVersion: bigint;
      membership: Readonly<{ membershipId: string; tenantId: string; version: bigint }> | null;
    }>;
  }>
  | Readonly<{ allowed: false; reason: Exclude<StaffAuthorizationReason, "ALLOW">; auditRecorded: boolean }>;

export class StaffAccessUnavailableError extends Error {
  override readonly name = "StaffAccessUnavailableError";
  constructor(readonly code: "IDENTITY_UNAVAILABLE" | "AUDIT_UNAVAILABLE") {
    super("Staff authorization dependency unavailable");
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Internal read only; never treats successful token verification as local enrollment. */
export async function readAuthorizedStaffSelf(
  dependencies: {
    readonly repository: StaffAuthorizationRepository;
    readonly auditWriter: SecurityAuditWriter;
    readonly now: () => Date;
  },
  identity: VerifiedStaffIdentity,
  request: InternalStaffRequest,
): Promise<StaffSelfResult> {
  const now = dependencies.now();
  if (!Number.isFinite(now.getTime()) || typeof request.requestId !== "string" || !uuid.test(request.requestId) ||
      [request.tenantId, request.objectTenantId, request.targetStaffId, request.proposalCreatorStaffId]
        .some((value) => value !== undefined && (typeof value !== "string" || !uuid.test(value)))) {
    throw new TypeError("Invalid internal staff authorization context");
  }
  let context: StaffAuthorizationContext = { principal: null, membership: null, platformRoleGrants: [] };
  const audit = async (reason: Exclude<StaffAuthorizationReason, "ALLOW"> | "ALLOW" | "DEPENDENCY_UNAVAILABLE"): Promise<boolean> => {
    try {
      await recordSecurityAuditEvents(dependencies.auditWriter, [{
        occurredAt: now.toISOString(),
        actorStaffId: context.principal?.staffId ?? null,
        tenantId: context.membership?.tenantId ?? null,
        action: "AUTHORIZATION_DECISION",
        outcome: reason === "ALLOW" ? "SUCCESS" : reason === "DEPENDENCY_UNAVAILABLE" ? "FAILURE" : "DENIED",
        targetType: "AUTHORIZATION", targetId: null, requestId: request.requestId,
        reasonCode: reason === "ALLOW" ? "NONE" : reason,
      }]);
      return true;
    } catch { return false; }
  };
  const deny = async (reason: Exclude<StaffAuthorizationReason, "ALLOW">): Promise<StaffSelfResult> =>
    Object.freeze({ allowed: false, reason, auditRecorded: await audit(reason) });

  if (!isVerifiedStaffIdentity(identity) || identity.security.expiresAt <= Math.floor(now.getTime() / 1000)) {
    return deny("MISSING_CONTEXT");
  }
  try {
    if (request.tenantId !== undefined) {
      context = await resolveStaffTenantContext(dependencies.repository, identity, request.tenantId);
    } else if (request.scope === "PLATFORM") {
      const platform = await resolveStaffPlatformContext(dependencies.repository, identity);
      context = { ...platform, membership: null };
    } else {
      context = { principal: await resolveStaffIdentity(dependencies.repository, identity), membership: null, platformRoleGrants: [] };
    }
  } catch {
    // Do not retain the repository exception: connection errors can contain secrets.
    context = { principal: null, membership: null, platformRoleGrants: [] };
    await audit("DEPENDENCY_UNAVAILABLE");
    throw new StaffAccessUnavailableError("IDENTITY_UNAVAILABLE");
  }
  const principal = context.principal;
  if (principal === null) return deny("IDENTITY_NOT_FOUND");
  if (principal.staffStatus !== "ACTIVE" || principal.identityStatus !== "ACTIVE") return deny("STAFF_NOT_ACTIVE");
  if (request.tenantId !== undefined || request.objectTenantId !== undefined) {
    if (request.tenantId === undefined || request.objectTenantId !== request.tenantId) return deny("TENANT_MISMATCH");
    if (context.membership === null || context.membership.status !== "ACTIVE" || context.membership.tenantId !== request.tenantId) {
      return deny("MEMBERSHIP_NOT_ACTIVE");
    }
  }
  const decision = authorizeStaffAccess(context, {
    ...request, now: now.toISOString(), permissionCode: request.permissionCode ?? "",
    targetStaffId: request.targetStaffId ?? principal.staffId,
  });
  if (!decision.allowed) return deny(decision.reason === "ALLOW" ? "MISSING_CONTEXT" : decision.reason);
  // This operation cannot expand even if a future policy phase changes.
  if (request.permissionCode !== "staff.self.read" || request.scope !== "SELF") return deny("PERMISSION_INACTIVE");
  if (!await audit("ALLOW")) throw new StaffAccessUnavailableError("AUDIT_UNAVAILABLE");
  const membership = context.membership;
  return Object.freeze({
    allowed: true, auditRecorded: true,
    staff: Object.freeze({
      staffId: principal.staffId, authzVersion: principal.authzVersion,
      membership: membership === null ? null : Object.freeze({
        membershipId: membership.membershipId, tenantId: membership.tenantId, version: membership.version,
      }),
    }),
  });
}
