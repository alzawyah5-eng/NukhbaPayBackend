import { decodeProtectedHeader, jwtVerify } from "jose";
import { attestVerifiedStaffIdentity } from "@nukhbapay/application/verified-identity";
import { AccessTokenVerificationError, type AccessTokenVerifier, type VerifiedStaffIdentity } from "./access-token-verifier.js";
import { MAX_ACCESS_TOKEN_BYTES } from "./authorization-header.js";
import { parseIdentityConfiguration, type IdentityEnvironment } from "./identity.config.js";
import { createTrustedJwks, type JwksFetch } from "./trusted-jwks.js";

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function numericDate(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export class OidcAccessTokenVerifier implements AccessTokenVerifier {
  private readonly config;
  private readonly getKey;
  private readonly now: () => Date;

  constructor(env: IdentityEnvironment, dependencies: { readonly fetchKeys?: JwksFetch; readonly now?: () => Date } = {}) {
    this.config = parseIdentityConfiguration(env);
    this.getKey = createTrustedJwks(this.config, dependencies.fetchKeys);
    this.now = dependencies.now ?? (() => new Date());
  }

  async verify(token: string): Promise<VerifiedStaffIdentity> {
    try {
      if (typeof token !== "string" || token.length > MAX_ACCESS_TOKEN_BYTES || token.trim() !== token ||
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
        throw new AccessTokenVerificationError("INVALID_TOKEN");
      }
      // Unverified header values can only reject input; they never select trust configuration.
      const header = decodeProtectedHeader(token);
      if (header.alg !== "RS256" || header.typ !== "at+jwt" || !boundedText(header.kid, 128) ||
          ["jku", "x5u", "jwk", "x5c", "crit", "b64", "cty"].some((name) => name in header)) {
        throw new AccessTokenVerificationError("INVALID_TOKEN");
      }
      const currentDate = this.now();
      if (!Number.isFinite(currentDate.getTime())) throw new AccessTokenVerificationError("KEYS_UNAVAILABLE");
      const { payload } = await jwtVerify(token, this.getKey, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: [...this.config.algorithms],
        typ: "at+jwt",
        requiredClaims: ["iss", "sub", "aud", "exp", "iat", "jti", "client_id", this.config.staffKindClaim],
        maxTokenAge: this.config.maxTokenAgeSeconds,
        clockTolerance: this.config.clockToleranceSeconds,
        currentDate,
      });
      if (!boundedText(payload.sub, 512) || !boundedText(payload.jti, 256) ||
          !numericDate(payload.iat) || !numericDate(payload.exp) ||
          (payload.nbf !== undefined && (!numericDate(payload.nbf) || payload.nbf >= payload.exp)) ||
          payload.exp <= payload.iat || payload.exp - payload.iat > this.config.maxTokenAgeSeconds ||
          !boundedText(payload["client_id"], 128) || !this.config.clientIds.includes(payload["client_id"]) ||
          payload[this.config.staffKindClaim] !== "human" ||
          ["gty", "azp", "act", "may_act", "sub_profile", "client_profile"].some((name) => name in payload) ||
          !(typeof payload.aud === "string" || (Array.isArray(payload.aud) && payload.aud.length > 0 &&
            payload.aud.length <= 8 && payload.aud.every((audience) => boundedText(audience, 512))))) {
        throw new AccessTokenVerificationError("INVALID_TOKEN");
      }
      return attestVerifiedStaffIdentity({
        issuer: this.config.issuer,
        subject: payload.sub,
        security: Object.freeze({
          audience: this.config.audience,
          clientId: payload["client_id"],
          profile: this.config.profile,
          principalKind: "human" as const,
          issuedAt: payload.iat,
          expiresAt: payload.exp,
          assurance: "not-established" as const,
        }),
      });
    } catch (error) {
      if (error instanceof AccessTokenVerificationError) throw error;
      throw new AccessTokenVerificationError("INVALID_TOKEN");
    }
  }

  checkReadiness(): Promise<boolean> { return this.getKey.checkReadiness(); }
  close(): void { this.getKey.close(); }
}
