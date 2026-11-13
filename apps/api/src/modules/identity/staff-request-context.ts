import { ForbiddenException } from "@nestjs/common";
import type { StaffSelfResult } from "@nukhbapay/application";
import type { VerifiedStaffIdentity } from "@nukhbapay/application/verified-identity";

type AuthorizedSelf = Extract<StaffSelfResult, { allowed: true }>;
const identities = new WeakMap<object, VerifiedStaffIdentity>();
const authorized = new WeakMap<object, AuthorizedSelf>();

export function clearStaffRequest(request: object): void {
  identities.delete(request); authorized.delete(request);
}

export function setVerifiedRequestIdentity(request: object, identity: VerifiedStaffIdentity): void {
  identities.set(request, identity);
}

export function verifiedRequestIdentity(request: object): VerifiedStaffIdentity | undefined {
  return identities.get(request);
}

export function setAuthorizedStaffSelf(request: object, result: AuthorizedSelf): void {
  authorized.set(request, result);
}

/** Read only after the global authorization guard committed its decision audit. */
export function authorizedStaffSelf(request: object): AuthorizedSelf {
  const result = authorized.get(request);
  if (result === undefined) throw new ForbiddenException();
  return result;
}
