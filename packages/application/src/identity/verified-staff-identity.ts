const verifiedIdentityBrand: unique symbol = Symbol("VerifiedStaffIdentity");
const verifiedIdentities = new WeakSet<object>();

export interface StaffIdentityEvidence {
  readonly issuer: string;
  readonly subject: string;
  readonly security: Readonly<{
    audience: string;
    clientId: string;
    profile: "rfc9068-staff-v1";
    principalKind: "human";
    issuedAt: number;
    expiresAt: number;
    assurance: "not-established";
  }>;
}

export interface VerifiedStaffIdentity extends StaffIdentityEvidence {
  readonly [verifiedIdentityBrand]: true;
}

export interface AccessTokenVerifier {
  verify(token: string): Promise<VerifiedStaffIdentity>;
}

/** Trusted verifier adapters only: call after signature, profile and claim checks.
 * This is not token verification or a request/JSON deserialization API.
 */
export function attestVerifiedStaffIdentity(evidence: StaffIdentityEvidence): VerifiedStaffIdentity {
  const identity = {
    issuer: evidence.issuer,
    subject: evidence.subject,
    security: Object.freeze({
      audience: evidence.security.audience,
      clientId: evidence.security.clientId,
      profile: evidence.security.profile,
      principalKind: evidence.security.principalKind,
      issuedAt: evidence.security.issuedAt,
      expiresAt: evidence.security.expiresAt,
      assurance: evidence.security.assurance,
    }),
  };
  Object.defineProperty(identity, verifiedIdentityBrand, { value: true });
  verifiedIdentities.add(identity);
  return Object.freeze(identity) as VerifiedStaffIdentity;
}

export function isVerifiedStaffIdentity(value: unknown): value is VerifiedStaffIdentity {
  return typeof value === "object" && value !== null && verifiedIdentities.has(value);
}
