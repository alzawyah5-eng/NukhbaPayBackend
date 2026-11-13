import { ServiceUnavailableException, UnauthorizedException, type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { isVerifiedStaffIdentity } from "@nukhbapay/application/verified-identity";
import { AccessTokenVerificationError } from "./access-token-verifier.js";
import { readBearerAuthorization } from "./authorization-header.js";
import type { IdentityBoundaryDependencies } from "./identity-boundary.js";
import { isReviewedPublicRoute } from "./reviewed-public-route.js";
import { clearStaffRequest, setVerifiedRequestIdentity } from "./staff-request-context.js";

export class AuthenticationGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly dependencies: IdentityBoundaryDependencies) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") return false;
    const request = context.switchToHttp().getRequest<Request>();
    clearStaffRequest(request);
    if (isReviewedPublicRoute(context, this.reflector)) return true;
    try {
      const token = readBearerAuthorization(request.rawHeaders);
      if (this.dependencies.verifier === undefined) throw new ServiceUnavailableException();
      const identity = await this.dependencies.verifier.verify(token);
      if (!isVerifiedStaffIdentity(identity)) throw new ServiceUnavailableException();
      setVerifiedRequestIdentity(request, identity);
      return true;
    } catch (error) {
      if (error instanceof AccessTokenVerificationError && error.code !== "KEYS_UNAVAILABLE") {
        throw new UnauthorizedException();
      }
      // Never attach underlying token, transport or configuration errors as causes.
      throw new ServiceUnavailableException();
    }
  }
}
