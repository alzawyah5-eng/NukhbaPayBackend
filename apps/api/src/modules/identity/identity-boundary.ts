import type { StaffAuthorizationRepository, SecurityAuditWriter } from "@nukhbapay/application";
import type { AccessTokenVerifier } from "./access-token-verifier.js";

/** Trusted composition only; no request/environment-selected bypass or synthetic defaults. */
export interface IdentityBoundaryDependencies {
  readonly verifier?: AccessTokenVerifier;
  readonly repository?: StaffAuthorizationRepository;
  readonly auditWriter?: SecurityAuditWriter;
  readonly now?: () => Date;
}
