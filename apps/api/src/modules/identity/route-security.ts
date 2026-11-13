import { SetMetadata } from "@nestjs/common";
import type { Request } from "express";

export const PUBLIC_ROUTE = Symbol("ReviewedPublicRoute");
export const STAFF_PERMISSION = Symbol("StaffPermission");

export interface StaffRouteContext {
  readonly tenantId?: string;
  readonly objectTenantId?: string;
}

export interface StaffPermissionRequirement {
  readonly permissionCode: string;
  readonly scope: "SELF" | "PLATFORM" | "TENANT";
  readonly method: "GET";
  /** Trusted application logic: requested tenant is not proof of object ownership. */
  readonly resolveContext?: (request: Request) => StaffRouteContext | Promise<StaffRouteContext>;
}

/** Marker only. Guards separately restrict exemptions to the reviewed health handler. */
export function PublicRoute(): MethodDecorator {
  return SetMetadata(PUBLIC_ROUTE, true);
}

export function RequireStaffPermission(requirement: StaffPermissionRequirement): MethodDecorator {
  if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/.test(requirement.permissionCode) ||
      requirement.permissionCode.length > 96 || !["SELF", "PLATFORM", "TENANT"].includes(requirement.scope) ||
      requirement.method !== "GET" ||
      (requirement.resolveContext !== undefined && typeof requirement.resolveContext !== "function")) {
    throw new TypeError("Invalid staff permission metadata");
  }
  return SetMetadata(STAFF_PERMISSION, Object.freeze({ ...requirement }));
}
