/** Local signed-test-event contract. It never represents Auth0 or operational MFA. */
export const SYNTHETIC_ASSURANCE_ISSUER = "https://assurance.synthetic.invalid/";
export const SYNTHETIC_ASSURANCE_AUDIENCE = "urn:nukhbapay:synthetic:approval-provenance";
export const SYNTHETIC_ASSURANCE_PROFILE = "synthetic-approval-provenance-v1";
export interface SyntheticApprovalBinding {
  readonly staffId: string; readonly identityIssuer: string; readonly identitySubject: string;
  readonly requestId: string; readonly requestVersion: string; readonly requestDigest: string;
  readonly policyVersion: string; readonly tenantId: string | null; readonly authorityDigest: string;
  readonly decision?: "APPROVE" | "REJECT";
}
declare const challengeBrand: unique symbol;
export interface SyntheticAssuranceChallenge {
  readonly [challengeBrand]: true;
  readonly id: string; readonly binding: SyntheticApprovalBinding; readonly bindingDigest: string;
  readonly issuedAtMs: number; readonly expiresAtMs: number;
}
export interface VerifiedSyntheticAssertion {
  readonly challengeId: string; readonly bindingDigest: string; readonly authenticationEventId: string;
  readonly authenticatedAtMs: number; readonly expiresAtMs: number; readonly assertionDigest: string;
  readonly providerIssuer: typeof SYNTHETIC_ASSURANCE_ISSUER;
  readonly signingKeyId: string;
  readonly profile: typeof SYNTHETIC_ASSURANCE_PROFILE;
}
/** Trusted server adapter only; production identity/assurance ports cannot substitute silently. */
export interface SyntheticAssuranceVerifier {
  readonly capability: "LOCAL_SYNTHETIC_ASSURANCE_ONLY";
  verify(assertion: string, challenge: SyntheticAssuranceChallenge): Promise<VerifiedSyntheticAssertion>;
}
declare const provenanceBrand: unique symbol;
export interface VerifiedSyntheticApprovalProvenance {
  readonly [provenanceBrand]: true;
  readonly binding: SyntheticApprovalBinding;
  readonly challengeId: string; readonly authenticationEventId: string;
  readonly authenticatedAtMs: number; readonly expiresAtMs: number; readonly assertionDigest: string;
  readonly providerIssuer: typeof SYNTHETIC_ASSURANCE_ISSUER;
  readonly signingKeyId: string;
  readonly recordDigest: string;
  readonly synthetic: true; readonly operationalAssurance: "not-established";
  readonly acceptedApproval: false; readonly execution: "NOT_AUTHORIZED";
}
