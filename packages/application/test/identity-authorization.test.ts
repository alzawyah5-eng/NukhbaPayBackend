import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeStaffAccess,
  resolveStaffIdentity,
  resolveStaffTenantContext,
  rolePermissionCodes,
  type ResolvedStaffPrincipal,
  type StaffAuthorizationContext,
  type StaffAuthorizationRepository,
  type StaffRoleGrant,
} from "../src/identity/staff-access.js";
import { PERMISSION_CATALOG, ROLE_CATALOG } from "../src/identity/permission-catalog.js";
import {
  recordSecurityAuditEvents,
  type SecurityAuditEvent,
} from "../src/identity/security-audit.js";

const staffId = "00000000-0000-4000-8000-000000000001";
const otherStaffId = "00000000-0000-4000-8000-000000000002";
const tenantA = "00000000-0000-4000-8000-00000000000a";
const tenantB = "00000000-0000-4000-8000-00000000000b";
const now = "2026-11-10T12:00:00.000Z";
const activePrincipal: ResolvedStaffPrincipal = {
  staffId,
  staffStatus: "ACTIVE",
  identityStatus: "ACTIVE", tokensValidAfter: null,
  authzVersion: 4n,
};

function grant(
  roleCode: string,
  scope: "PLATFORM" | "TENANT",
  values: Partial<Pick<StaffRoleGrant, "grantedAt" | "expiresAt" | "revokedAt">> = {},
): StaffRoleGrant {
  return {
    roleCode,
    scope,
    grantedAt: values.grantedAt ?? "2026-11-01T00:00:00.000Z",
    expiresAt: values.expiresAt ?? null,
    revokedAt: values.revokedAt ?? null,
  };
}

function context(
  tenantRoleGrants: readonly StaffRoleGrant[] = [],
  platformRoleGrants: readonly StaffRoleGrant[] = [],
  principal: ResolvedStaffPrincipal | null = activePrincipal,
  membershipStatus: "ACTIVE" | "SUSPENDED" | "REVOKED" = "ACTIVE",
  membershipTenantId = tenantA,
): StaffAuthorizationContext {
  return {
    principal,
    membership: {
      membershipId: "00000000-0000-4000-8000-000000000010",
      tenantId: membershipTenantId,
      status: membershipStatus,
      version: 3n,
      roleGrants: tenantRoleGrants,
    },
    platformRoleGrants,
  };
}

test("the fixed catalogue has explicit scopes and no wildcard or inherited grants", () => {
  assert.equal(ROLE_CATALOG.length, 12);
  assert.equal(PERMISSION_CATALOG.length, 23);
  assert.equal(PERMISSION_CATALOG.some(({ code }) => code.includes("*")), false);
  assert.deepEqual(rolePermissionCodes("CATALOG_OPERATOR"), [
    "catalog.read",
    "catalog.import.request",
    "catalog.mapping.propose",
  ]);
  assert.deepEqual(rolePermissionCodes("CATALOG_REVIEWER"), [
    "catalog.read",
    "catalog.mapping.approve",
  ]);
  assert.deepEqual(rolePermissionCodes("PRICING_EDITOR"), [
    "catalog.read",
    "pricing.read",
    "pricing.draft",
    "pricing.submit",
  ]);
  assert.deepEqual(rolePermissionCodes("PRICING_APPROVER"), [
    "catalog.read",
    "pricing.read",
    "pricing.approve",
  ]);
  assert.equal(rolePermissionCodes("SUPER_ADMIN"), null);
});

test("only an active staff member can read their own self-scope", () => {
  assert.deepEqual(
    authorizeStaffAccess(context(), {
      permissionCode: "staff.self.read",
      scope: "SELF",
      targetStaffId: staffId,
      now,
    }),
    { allowed: true, reason: "ALLOW" },
  );
  assert.equal(
    authorizeStaffAccess(context(), {
      permissionCode: "staff.self.read",
      scope: "SELF",
      targetStaffId: otherStaffId,
      now,
    }).allowed,
    false,
  );
  assert.equal(
    authorizeStaffAccess(context([], [], { ...activePrincipal, staffStatus: "SUSPENDED" }), {
      permissionCode: "staff.self.read",
      scope: "SELF",
      targetStaffId: staffId,
      now,
    }).reason,
    "STAFF_NOT_ACTIVE",
  );
  assert.equal(
    authorizeStaffAccess(context([], [], { ...activePrincipal, identityStatus: "DISABLED" }), {
      permissionCode: "staff.self.read",
      scope: "SELF",
      targetStaffId: staffId,
      now,
    }).allowed,
    false,
  );
});

test("missing, unknown, and non-active-phase permissions fail closed", () => {
  assert.equal(
    authorizeStaffAccess(null, {
      permissionCode: "staff.self.read",
      scope: "SELF",
      targetStaffId: staffId,
      now,
    }).reason,
    "MISSING_CONTEXT",
  );
  assert.equal(
    authorizeStaffAccess(context(), null).reason,
    "MISSING_CONTEXT",
  );
  assert.equal(
    authorizeStaffAccess(context(), {
      permissionCode: "tenant.unknown.action",
      scope: "TENANT",
      tenantId: tenantA,
      objectTenantId: tenantA,
      now,
    }).reason,
    "PERMISSION_UNKNOWN",
  );
  assert.equal(
    authorizeStaffAccess(context([grant("CATALOG_OPERATOR", "TENANT")]), {
      permissionCode: "catalog.read",
      scope: "TENANT",
      tenantId: tenantA,
      objectTenantId: tenantA,
      now,
    }).reason,
    "PERMISSION_INACTIVE",
  );
});

test("platform grants do not imply tenant access and tenant object scope must match", () => {
  const platformOnly = context(
    [],
    [grant("GOVERNANCE_OWNER", "PLATFORM")],
  );
  assert.equal(
    authorizeStaffAccess(platformOnly, {
      permissionCode: "catalog.read",
      scope: "TENANT",
      tenantId: tenantA,
      objectTenantId: tenantA,
      now,
    }).reason,
    "GRANT_INACTIVE",
  );
  assert.equal(
    authorizeStaffAccess(context([grant("CATALOG_OPERATOR", "TENANT")]), {
      permissionCode: "catalog.read",
      scope: "TENANT",
      tenantId: tenantA,
      objectTenantId: tenantB,
      now,
    }).reason,
    "TENANT_MISMATCH",
  );
  assert.equal(
    authorizeStaffAccess(context([], [], activePrincipal, "SUSPENDED"), {
      permissionCode: "catalog.read",
      scope: "TENANT",
      tenantId: tenantA,
      objectTenantId: tenantA,
      now,
    }).reason,
    "MEMBERSHIP_NOT_ACTIVE",
  );
  assert.equal(
    authorizeStaffAccess(context([], [grant("GOVERNANCE_OWNER", "PLATFORM")]), {
      permissionCode: "platform.audit.read",
      scope: "PLATFORM",
      tenantId: tenantA,
      now,
    }).reason,
    "SCOPE_MISMATCH",
  );
});

test("expired, revoked, future, and malformed grants never authorize", () => {
  const request = {
    permissionCode: "catalog.read",
    scope: "TENANT" as const,
    tenantId: tenantA,
    objectTenantId: tenantA,
    now,
  };
  for (const invalidGrant of [
    grant("CATALOG_OPERATOR", "TENANT", { expiresAt: "2026-11-10T12:00:00.000Z" }),
    grant("CATALOG_OPERATOR", "TENANT", { revokedAt: "2026-11-09T12:00:00.000Z" }),
    grant("CATALOG_OPERATOR", "TENANT", { grantedAt: "2026-11-11T00:00:00.000Z" }),
    grant("CATALOG_OPERATOR", "TENANT", { expiresAt: "not-a-time" }),
  ]) {
    assert.equal(
      authorizeStaffAccess(context([invalidGrant]), request).reason,
      "GRANT_INACTIVE",
    );
  }
});

test("conflicting role combinations are rejected even when a grant has expired", () => {
  const tenantConflict = context([
    grant("CATALOG_OPERATOR", "TENANT"),
    grant("CATALOG_REVIEWER", "TENANT"),
  ]);
  assert.equal(
    authorizeStaffAccess(tenantConflict, {
      permissionCode: "catalog.read",
      scope: "TENANT",
      tenantId: tenantA,
      objectTenantId: tenantA,
      now,
    }).reason,
    "ROLE_CONFLICT",
  );

  const expiredEditorConflict = context([
    grant("PRICING_EDITOR", "TENANT", { expiresAt: "2026-11-10T11:00:00.000Z" }),
    grant("PRICING_APPROVER", "TENANT"),
  ]);
  assert.equal(
    authorizeStaffAccess(expiredEditorConflict, {
      permissionCode: "pricing.read",
      scope: "TENANT",
      tenantId: tenantA,
      objectTenantId: tenantA,
      now,
    }).reason,
    "ROLE_CONFLICT",
  );
  assert.equal(
    authorizeStaffAccess(context([], [
      grant("GOVERNANCE_OWNER", "PLATFORM"),
      grant("SECURITY_ADMIN", "PLATFORM"),
    ]), {
      permissionCode: "platform.audit.read",
      scope: "PLATFORM",
      now,
    }).reason,
    "ROLE_CONFLICT",
  );
});

test("self-approval compares internal staff IDs rather than external identities", () => {
  const request = {
    permissionCode: "pricing.approve",
    scope: "TENANT" as const,
    tenantId: tenantA,
    objectTenantId: tenantA,
    proposalCreatorStaffId: staffId,
    now,
  };
  assert.equal(
    authorizeStaffAccess(context([grant("PRICING_APPROVER", "TENANT")]), request).reason,
    "SELF_APPROVAL",
  );
  assert.equal(
    authorizeStaffAccess(context([grant("PRICING_APPROVER", "TENANT")]), {
      ...request,
      proposalCreatorStaffId: otherStaffId,
    }).reason,
    "PERMISSION_INACTIVE",
  );
});

test("staff resolution uses exact trusted issuer/subject values and never links by email", async () => {
  const received: unknown[] = [];
  let membershipReads = 0;
  const repository: StaffAuthorizationRepository = {
    findByTrustedIdentity: async (identity) => {
      received.push(identity);
      return activePrincipal;
    },
    findTenantMembership: async (resolvedStaffId, resolvedTenantId) => {
      membershipReads += 1;
      assert.equal(resolvedStaffId, staffId);
      assert.equal(resolvedTenantId, tenantA);
      return {
        membershipId: "00000000-0000-4000-8000-000000000010",
        tenantId: tenantA,
        status: "ACTIVE",
        version: 3n,
        roleGrants: [],
      };
    },
    findPlatformRoleGrants: async () => [],
  };
  const identity = {
    issuer: "https://issuer.example/exact/",
    subject: "subject:case-sensitive-01",
  };

  assert.equal(await resolveStaffIdentity(repository, identity), activePrincipal);
  const resolved = await resolveStaffTenantContext(repository, identity, tenantA);
  assert.deepEqual(received, [identity, identity]);
  assert.equal(resolved.membership?.tenantId, tenantA);
  assert.equal(membershipReads, 1);
});

test("unknown and inactive identities do not create or resolve memberships; repository failure rejects", async () => {
  let membershipReads = 0;
  const repository: StaffAuthorizationRepository = {
    findByTrustedIdentity: async () => null,
    findTenantMembership: async () => {
      membershipReads += 1;
      return null;
    },
    findPlatformRoleGrants: async () => [],
  };
  const unknown = await resolveStaffTenantContext(
    repository,
    { issuer: "https://issuer.example/", subject: "unknown" },
    tenantA,
  );
  assert.equal(unknown.principal, null);
  assert.equal(unknown.membership, null);
  assert.equal(membershipReads, 0);

  const suspendedRepository: StaffAuthorizationRepository = {
    ...repository,
    findByTrustedIdentity: async () => ({ ...activePrincipal, staffStatus: "SUSPENDED" }),
  };
  const suspended = await resolveStaffTenantContext(
    suspendedRepository,
    { issuer: "https://issuer.example/", subject: "suspended" },
    tenantA,
  );
  assert.equal(suspended.membership, null);
  assert.equal(membershipReads, 0);

  const failingRepository: StaffAuthorizationRepository = {
    ...repository,
    findByTrustedIdentity: async () => {
      throw new Error("database unavailable");
    },
  };
  await assert.rejects(
    resolveStaffTenantContext(
      failingRepository,
      { issuer: "https://issuer.example/", subject: "staff" },
      tenantA,
    ),
    /database unavailable/,
  );
});

test("security audit input is bounded and rejects malformed identifiers before persistence", async () => {
  let persisted: readonly SecurityAuditEvent[] = [];
  const writer = {
    appendSecurityAuditEvents: async (events: readonly SecurityAuditEvent[]) => {
      persisted = events;
    },
  };
  const event: SecurityAuditEvent = {
    occurredAt: now,
    actorStaffId: staffId,
    tenantId: tenantA,
    action: "AUTHORIZATION_DECISION",
    outcome: "DENIED",
    targetType: "AUTHORIZATION",
    targetId: null,
    requestId: "00000000-0000-4000-8000-000000000020",
    reasonCode: "GRANT_INACTIVE",
  };

  await recordSecurityAuditEvents(writer, [event]);
  assert.deepEqual(persisted, [event]);
  await assert.rejects(
    recordSecurityAuditEvents(writer, Array.from({ length: 51 }, () => event)),
    /between 1 and 50/,
  );
  await assert.rejects(
    recordSecurityAuditEvents(writer, [{ ...event, actorStaffId: "not-a-uuid" }]),
    /must be a UUID or null/,
  );
  await assert.rejects(
    recordSecurityAuditEvents(writer, [{ ...event, occurredAt: "not-a-time" }]),
    /valid timestamp/,
  );
});
