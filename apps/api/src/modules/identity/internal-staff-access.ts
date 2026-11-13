import { readAuthorizedStaffSelf, type InternalStaffRequest, type StaffAuthorizationRepository, type SecurityAuditWriter, type StaffSelfResult } from "@nukhbapay/application";
import type { AccessTokenVerifier } from "./access-token-verifier.js";
import { readBearerAuthorization } from "./authorization-header.js";

/** Internal composition function only. No controller, route, pool or enrollment. */
export async function verifyAndReadStaffSelf(
  dependencies: {
    readonly verifier: AccessTokenVerifier;
    readonly repository: StaffAuthorizationRepository;
    readonly auditWriter: SecurityAuditWriter;
    readonly now: () => Date;
  },
  rawHeaders: readonly string[],
  request: InternalStaffRequest,
): Promise<StaffSelfResult> {
  const identity = await dependencies.verifier.verify(readBearerAuthorization(rawHeaders));
  return readAuthorizedStaffSelf(dependencies, identity, request);
}
