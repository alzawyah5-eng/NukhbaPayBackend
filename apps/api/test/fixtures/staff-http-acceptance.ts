import { Controller, Get, Module, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { HealthController } from "../../src/health.controller.js";
import { PublicRoute, RequireStaffPermission } from "../../src/modules/identity/route-security.js";
import { authorizedStaffSelf } from "../../src/modules/identity/staff-request-context.js";

/** This controller is compiled only by tsconfig.test.json, never by the deployed AppModule. */
export function staffHttpAcceptance(objectTenantId: string) {
  const calls = { protected: 0 };
  const tenantContext = (request: Request) => ({ tenantId: request.params["tenantId"] as string, objectTenantId });
  @Controller("__acceptance/staff")
  class AcceptanceController {
    @Get(["self", "self-alias"])
    @RequireStaffPermission({ permissionCode: "staff.self.read", scope: "SELF", method: "GET" })
    self(@Req() request: Request) {
      calls.protected += 1;
      const { staff } = authorizedStaffSelf(request);
      return {
        staffId: staff.staffId, authzVersion: staff.authzVersion.toString(),
        membership: staff.membership === null ? null : {
          membershipId: staff.membership.membershipId, tenantId: staff.membership.tenantId, version: staff.membership.version.toString(),
        },
      };
    }

    @Get("tenants/:tenantId/self")
    @RequireStaffPermission({ permissionCode: "staff.self.read", scope: "SELF", method: "GET", resolveContext: tenantContext })
    scoped(@Req() request: Request) { return this.self(request); }

    @Get("reserved/:tenantId")
    @RequireStaffPermission({ permissionCode: "catalog.read", scope: "TENANT", method: "GET", resolveContext: tenantContext })
    reserved(@Req() request: Request) { return this.self(request); }

    @Get("missing-permission")
    missingPermission() { calls.protected += 1; return { private: "must never execute" }; }

    @Get("unreviewed-public")
    @PublicRoute()
    unreviewedPublic() { calls.protected += 1; return { private: "must never execute" }; }

    @Post("alternate-method")
    @RequireStaffPermission({ permissionCode: "staff.self.read", scope: "SELF", method: "GET" })
    alternateMethod() { calls.protected += 1; return { private: "must never execute" }; }
  }
  @Module({ controllers: [HealthController, AcceptanceController] })
  class AcceptanceModule {}
  return { rootModule: AcceptanceModule, calls };
}
