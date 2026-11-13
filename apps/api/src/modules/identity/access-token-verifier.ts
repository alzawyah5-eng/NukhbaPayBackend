export type { AccessTokenVerifier, VerifiedStaffIdentity } from "@nukhbapay/application/verified-identity";

export type VerificationFailureCode = "MISSING_CREDENTIALS" | "INVALID_TOKEN" | "KEYS_UNAVAILABLE";

/** Never retain the underlying exception, token, claims or network response. */
export class AccessTokenVerificationError extends Error {
  override readonly name = "AccessTokenVerificationError";

  constructor(readonly code: VerificationFailureCode) {
    super(code === "KEYS_UNAVAILABLE" ? "Trusted signing keys unavailable" : "Access token rejected");
  }
}
