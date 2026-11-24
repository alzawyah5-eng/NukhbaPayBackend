import { createHash } from "node:crypto";
import { createLocalJWKSet, jwtVerify, type JWK } from "jose";
import { SYNTHETIC_ASSURANCE_ISSUER, SYNTHETIC_ASSURANCE_AUDIENCE, SYNTHETIC_ASSURANCE_PROFILE,
  type SyntheticAssuranceVerifier, type SyntheticAssuranceChallenge, type VerifiedSyntheticAssertion } from "@nukhbapay/application";

/** No network discovery, external provider, runtime registration or operational MFA claims. */
export class LocalSyntheticAssuranceVerifier implements SyntheticAssuranceVerifier {
  readonly capability = "LOCAL_SYNTHETIC_ASSURANCE_ONLY" as const;
  readonly #keys: ReturnType<typeof createLocalJWKSet>;
  constructor(configuration: Readonly<{ mode: "test"; keys: readonly JWK[]; now: () => Date }>) {
    if (configuration.mode !== "test" || !Array.isArray(configuration.keys) || configuration.keys.length < 1 || configuration.keys.length > 3 ||
      new Set(configuration.keys.map(key => key.kid)).size !== configuration.keys.length || configuration.keys.some(key =>
        key.kty !== "RSA" || key.alg !== "RS256" || key.use !== "sig" || typeof key.kid !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(key.kid) ||
        typeof key.n !== "string" || typeof key.e !== "string" || ["d","p","q","dp","dq","qi","oth","k"].some(field => field in key))) {
      throw new Error("Invalid isolated synthetic assurance configuration");
    }
    this.#keys = createLocalJWKSet({ keys: configuration.keys.map(key => ({ kty: "RSA", alg: "RS256", use: "sig", kid: key.kid!, n: key.n!, e: key.e! })) });
    this.#now = configuration.now;
  }
  readonly #now: () => Date;
  async verify(assertion: string, challenge: SyntheticAssuranceChallenge): Promise<VerifiedSyntheticAssertion> {
    try {
      const now = this.#now();
      if (!Number.isFinite(now.getTime()) || typeof assertion !== "string" || assertion.length < 100 || assertion.length > 8192 ||
        assertion.split(".").length !== 3 || now.getTime() >= challenge.expiresAtMs) throw new Error();
      const { payload: p, protectedHeader: h } = await jwtVerify(assertion, this.#keys, {
        algorithms: ["RS256"], issuer: SYNTHETIC_ASSURANCE_ISSUER, audience: SYNTHETIC_ASSURANCE_AUDIENCE,
        typ: "synthetic-assurance+jwt", currentDate: now, clockTolerance: 0,
        requiredClaims: ["iss","aud","sub","iat","exp","jti","challenge_id","binding_digest","auth_time","profile","synthetic"],
      });
      if (Object.keys(h).some(key => !["alg","typ","kid"].includes(key)) || typeof h.kid !== "string" || h.typ !== "synthetic-assurance+jwt" ||
        p.iss !== SYNTHETIC_ASSURANCE_ISSUER || p.aud !== SYNTHETIC_ASSURANCE_AUDIENCE || p.sub !== challenge.binding.identitySubject ||
        p["profile"] !== SYNTHETIC_ASSURANCE_PROFILE || p["synthetic"] !== true ||
        p["challenge_id"] !== challenge.id || p["binding_digest"] !== challenge.bindingDigest ||
        typeof p.jti !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(p.jti) ||
        Object.keys(p).some(key => !["iss","aud","sub","iat","exp","jti","challenge_id","binding_digest","auth_time","profile","synthetic"].includes(key))) throw new Error();
      const times = [p.iat,p.exp,p["auth_time"]];
      if (!times.every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) throw new Error();
      const finishedAtMs = this.#now().getTime();
      if (!Number.isFinite(finishedAtMs) || finishedAtMs < now.getTime() ||
          finishedAtMs >= Math.min(challenge.expiresAtMs, p.exp! * 1000)) throw new Error();
      const authenticatedAtMs = (p["auth_time"] as number) * 1000;
      if (p.iat! * 1000 < challenge.issuedAtMs || p.iat! * 1000 > now.getTime() || authenticatedAtMs < challenge.issuedAtMs ||
        authenticatedAtMs > p.iat! * 1000 || p.exp! <= p.iat! || p.exp! - p.iat! > 60 || p.exp! * 1000 > challenge.expiresAtMs) throw new Error();
      return Object.freeze({ challengeId: challenge.id, bindingDigest: challenge.bindingDigest, authenticationEventId: p.jti,
        authenticatedAtMs, expiresAtMs: p.exp! * 1000, assertionDigest: createHash("sha256").update(assertion).digest("hex"),
        providerIssuer: SYNTHETIC_ASSURANCE_ISSUER, profile: SYNTHETIC_ASSURANCE_PROFILE, signingKeyId: h.kid });
    } catch { throw new Error("Synthetic assurance verification failed"); }
  }
}
