import { randomUUID } from "node:crypto";
import { BadRequestException, ForbiddenException, Logger, ServiceUnavailableException, UnauthorizedException, type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import type { Request, Response } from "express";
import { readAuthorizedStaffSelf, StaffAccessUnavailableError, type InternalStaffRequest } from "@nukhbapay/application";
import type { IdentityBoundaryDependencies } from "./identity-boundary.js";
import { isReviewedPublicRoute } from "./reviewed-public-route.js";
import { STAFF_PERMISSION, type StaffPermissionRequirement, type StaffRouteContext } from "./route-security.js";
import { setAuthorizedStaffSelf, verifiedRequestIdentity } from "./staff-request-context.js";

export class AuthorizationGuard implements CanActivate {
  private readonly logger = new Logger("StaffAuthorizationGuard");
  constructor(private readonly reflector: Reflector, private readonly dependencies: IdentityBoundaryDependencies) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") return false;
    if (isReviewedPublicRoute(context, this.reflector)) return true;
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    response.setHeader("Cache-Control", "no-store");
    const identity = verifiedRequestIdentity(request);
    if (identity === undefined) throw new UnauthorizedException();
    const { repository, auditWriter } = this.dependencies;
    if (repository === undefined || auditWriter === undefined) throw new ServiceUnavailableException();
    const requirement = this.reflector.get<StaffPermissionRequirement | undefined>(STAFF_PERMISSION, context.getHandler());
    // Absent metadata or an implicit HEAD mapping must never inherit GET authority.
    const approvedMethod = requirement !== undefined && requirement.method === "GET" && request.method === requirement.method;
    let scope: StaffRouteContext = {};
    try {
      if (approvedMethod && requirement.resolveContext !== undefined) scope = await requirement.resolveContext(request);
      const operation: InternalStaffRequest = {
        requestId: randomUUID(), scope: approvedMethod ? requirement.scope : "SELF",
        ...(approvedMethod ? { permissionCode: requirement.permissionCode } : {}),
        ...(scope.tenantId === undefined ? {} : { tenantId: scope.tenantId }),
        ...(scope.objectTenantId === undefined ? {} : { objectTenantId: scope.objectTenantId }),
      };
      const result = await readAuthorizedStaffSelf({ repository, auditWriter, now: this.dependencies.now ?? (() => new Date()) }, identity, operation);
      if (!result.allowed || !approvedMethod) {
        if (!result.auditRecorded) this.logger.warn("Denied staff request could not be audited");
        throw new ForbiddenException();
      }
      setAuthorizedStaffSelf(request, result);
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      if (error instanceof TypeError) throw new BadRequestException();
      if (error instanceof StaffAccessUnavailableError) throw new ServiceUnavailableException();
      throw new ServiceUnavailableException();
    }
  }
}
