export type AuthorizationScope = "SELF" | "PLATFORM" | "TENANT";
export type ActivationPhase = "3A" | "3B" | "3C" | "3D" | "3E" | "4" | "LATER";

export interface PermissionDefinition {
  readonly code: string;
  readonly scope: AuthorizationScope;
  readonly description: string;
  readonly activationPhase: ActivationPhase;
}

export interface RoleDefinition {
  readonly code: string;
  readonly scope: Exclude<AuthorizationScope, "SELF">;
  readonly description: string;
  readonly privileged: boolean;
  readonly permissions: readonly string[];
}

export const PERMISSION_CATALOG = [
  { code: "staff.self.read", scope: "SELF", description: "Read only the active staff member self and membership summary.", activationPhase: "3A" },
  { code: "platform.audit.read", scope: "PLATFORM", description: "Read platform security audit evidence only.", activationPhase: "3D" },
  { code: "platform.access.approve_privileged", scope: "PLATFORM", description: "Approve privileged platform access requests.", activationPhase: "3D" },
  { code: "platform.staff.read", scope: "PLATFORM", description: "Read minimal platform staff identity records.", activationPhase: "3D" },
  { code: "platform.access.approve", scope: "PLATFORM", description: "Approve eligible platform access requests.", activationPhase: "3D" },
  { code: "platform.staff.suspend", scope: "PLATFORM", description: "Suspend a compromised staff identity.", activationPhase: "3D" },
  { code: "platform.sessions.revoke", scope: "PLATFORM", description: "Revoke one explicitly bound staff session.", activationPhase: "3D" },
  { code: "platform.sessions.revoke_all", scope: "PLATFORM", description: "Revoke all sessions belonging to one staff identity.", activationPhase: "3D" },
  { code: "platform.access.request", scope: "PLATFORM", description: "Submit controlled platform access requests.", activationPhase: "3D" },
  { code: "tenant.staff.read", scope: "TENANT", description: "Read minimal staff membership information for one tenant.", activationPhase: "3C" },
  { code: "tenant.access.request", scope: "TENANT", description: "Submit eligible access requests within one tenant.", activationPhase: "3C" },
  { code: "tenant.staff.suspend", scope: "TENANT", description: "Suspend eligible low-risk staff within one tenant.", activationPhase: "3C" },
  { code: "tenant.audit.read", scope: "TENANT", description: "Read security audit evidence for one tenant.", activationPhase: "3C" },
  { code: "tenant.departments.manage", scope: "TENANT", description: "Create and rename departments for one tenant.", activationPhase: "3C" },
  { code: "catalog.read", scope: "TENANT", description: "Read customer-safe catalog data for one tenant.", activationPhase: "4" },
  { code: "catalog.import.request", scope: "TENANT", description: "Request a controlled catalog import operation.", activationPhase: "LATER" },
  { code: "catalog.mapping.propose", scope: "TENANT", description: "Propose a provider-to-product mapping for review.", activationPhase: "LATER" },
  { code: "catalog.mapping.approve", scope: "TENANT", description: "Approve an eligible provider-to-product mapping.", activationPhase: "LATER" },
  { code: "pricing.read", scope: "TENANT", description: "Read authorized tenant pricing economics.", activationPhase: "4" },
  { code: "pricing.draft", scope: "TENANT", description: "Draft pricing policy changes for one tenant.", activationPhase: "4" },
  { code: "pricing.submit", scope: "TENANT", description: "Submit pricing policy changes for review.", activationPhase: "4" },
  { code: "pricing.approve", scope: "TENANT", description: "Approve an immutable pricing proposal.", activationPhase: "4" },
  { code: "finance.read", scope: "TENANT", description: "Read reserved financial reports without execution rights.", activationPhase: "LATER" },
  { code: "settlement.read", scope: "TENANT", description: "Read reserved settlement reports without execution rights.", activationPhase: "LATER" },
  { code: "support.read_masked", scope: "TENANT", description: "Read reserved minimal masked support records.", activationPhase: "LATER" },
] as const satisfies readonly PermissionDefinition[];

export const ROLE_CATALOG = [
  { code: "GOVERNANCE_OWNER", scope: "PLATFORM", description: "Governance approvals for exceptional platform access.", privileged: true, permissions: ["platform.audit.read", "platform.access.approve_privileged"] },
  { code: "SECURITY_ADMIN", scope: "PLATFORM", description: "Security response and privileged access approvals.", privileged: true, permissions: ["platform.staff.read", "platform.access.approve", "platform.staff.suspend", "platform.sessions.revoke", "platform.sessions.revoke_all", "platform.audit.read"] },
  { code: "ACCESS_ADMIN", scope: "PLATFORM", description: "Submit controlled platform access requests.", privileged: true, permissions: ["platform.staff.read", "platform.access.request"] },
  { code: "PLATFORM_AUDITOR", scope: "PLATFORM", description: "Read platform security audit evidence.", privileged: false, permissions: ["platform.audit.read"] },
  { code: "TENANT_ADMIN", scope: "TENANT", description: "Manage limited staff access requests within one tenant.", privileged: true, permissions: ["tenant.staff.read", "tenant.access.request", "tenant.staff.suspend", "tenant.audit.read"] },
  { code: "CATALOG_OPERATOR", scope: "TENANT", description: "Propose catalog operations within one tenant.", privileged: false, permissions: ["catalog.read", "catalog.import.request", "catalog.mapping.propose"] },
  { code: "CATALOG_REVIEWER", scope: "TENANT", description: "Review catalog mapping proposals within one tenant.", privileged: true, permissions: ["catalog.read", "catalog.mapping.approve"] },
  { code: "PRICING_EDITOR", scope: "TENANT", description: "Prepare pricing drafts within one tenant.", privileged: false, permissions: ["catalog.read", "pricing.read", "pricing.draft", "pricing.submit"] },
  { code: "PRICING_APPROVER", scope: "TENANT", description: "Approve pricing proposals within one tenant.", privileged: true, permissions: ["catalog.read", "pricing.read", "pricing.approve"] },
  { code: "FINANCE_REVIEWER", scope: "TENANT", description: "Read reserved finance and settlement reports.", privileged: true, permissions: ["pricing.read", "finance.read", "settlement.read"] },
  { code: "SUPPORT_AGENT", scope: "TENANT", description: "Read reserved masked support information.", privileged: false, permissions: ["catalog.read", "support.read_masked"] },
  { code: "TENANT_AUDITOR", scope: "TENANT", description: "Read tenant security audit evidence.", privileged: true, permissions: ["tenant.audit.read"] },
  { code: "TENANT_STAFF_VIEWER", scope: "TENANT", description: "Read the staff directory and security audit for one tenant.", privileged: true, permissions: ["tenant.staff.read", "tenant.audit.read"] },
  { code: "TENANT_STAFF_MANAGER", scope: "TENANT", description: "Read staff records, submit onboarding requests, and manage departments for one tenant.", privileged: true, permissions: ["tenant.staff.read", "tenant.audit.read", "tenant.access.request", "tenant.departments.manage"] },
] as const satisfies readonly RoleDefinition[];

export const ACTIVE_AUTHORIZATION_PHASE: ActivationPhase = "3A";

export function findPermissionDefinition(code: string): PermissionDefinition | undefined {
  return PERMISSION_CATALOG.find((permission) => permission.code === code);
}

export function findRoleDefinition(code: string): RoleDefinition | undefined {
  return ROLE_CATALOG.find((role) => role.code === code);
}
