import { randomUUID } from "node:crypto";
import { SYNTHETIC_ASSURANCE_ISSUER, SYNTHETIC_ASSURANCE_AUDIENCE, SYNTHETIC_ASSURANCE_PROFILE,
  type SyntheticAssuranceChallenge, type AccessTokenVerifier } from "@nukhbapay/application";
import { signingKey } from "./oidc-test-issuer.js";

/** Isolated fixture provider. A verified test sign-in event, never a real MFA factor. */
export async function syntheticAssuranceProvider(accessVerifier: AccessTokenVerifier, now: () => Date) {
  const key = await signingKey("synthetic-assurance-key");
  const payload = (challenge: SyntheticAssuranceChallenge) => ({ iss: SYNTHETIC_ASSURANCE_ISSUER, aud: SYNTHETIC_ASSURANCE_AUDIENCE,
    sub: challenge.binding.identitySubject, iat: Math.floor(now().getTime()/1000), exp: Math.floor(challenge.expiresAtMs/1000),
    jti: randomUUID(), challenge_id: challenge.id, binding_digest: challenge.bindingDigest,
    auth_time: Math.floor(now().getTime()/1000), profile: SYNTHETIC_ASSURANCE_PROFILE, synthetic: true });
  return {
    publicJwk: key.publicJwk, payload,
    async respond(challenge: SyntheticAssuranceChallenge, accessToken: string) {
      const identity = await accessVerifier.verify(accessToken);
      if (identity.issuer !== challenge.binding.identityIssuer || identity.subject !== challenge.binding.identitySubject ||
          identity.security.issuedAt*1000 < challenge.issuedAtMs || identity.security.principalKind !== "human") throw new Error("Synthetic test sign-in does not match challenge");
      return key.sign(payload(challenge), { typ: "synthetic-assurance+jwt" });
    },
    // Fault injection only; never provided by a deployed provider or production package.
    signFault: (claims: Record<string, unknown>, header: Record<string, unknown> = {}) => key.sign(claims, { typ: "synthetic-assurance+jwt", ...header }),
  };
}
