import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JWK } from "jose";
import { AI_JOB_AUDIENCE, AiJobError, attestAiServiceIdentity, type AiJobService, type AiJobScope } from "@nukhbapay/application";

/** No remote JWKS, env activation, HTTP listener, enrollment or staff-identity adapter. */
export class SyntheticAiServiceVerifier {
  readonly #keys: ReturnType<typeof createLocalJWKSet>;
  constructor(private readonly issuer: string, keys: readonly JWK[], private readonly now: () => Date) {
    const u = new URL(issuer);
    if (u.protocol !== "https:" || !u.hostname.endsWith(".invalid") || u.username || u.password || u.search || u.hash ||
      keys.length < 1 || keys.length > 5 || keys.some(k => k.kty !== "RSA" || k.alg !== "RS256" || k.use !== "sig" ||
        typeof k.kid !== "string" || k.kid.length < 1 || k.kid.length > 128 || "d" in k || "jku" in k || "x5u" in k)) throw new AiJobError(503);
    this.#keys = createLocalJWKSet({ keys: keys.map(k => ({ ...k })) });
  }
  async verify(token: string, scope: AiJobScope) {
    try {
      if (typeof token !== "string" || token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error();
      const h = decodeProtectedHeader(token);
      if (h.alg !== "RS256" || h.typ !== "at+jwt" || typeof h.kid !== "string" || h.kid.length > 128 ||
        ["jku", "x5u", "jwk", "x5c", "crit", "b64", "cty"].some(k => k in h)) throw new Error();
      const currentDate = this.now(); if (!Number.isFinite(currentDate.getTime())) throw new Error();
      const { payload: p } = await jwtVerify(token, this.#keys, { issuer: this.issuer, audience: AI_JOB_AUDIENCE,
        algorithms: ["RS256"], typ: "at+jwt", maxTokenAge: 300, currentDate,
        requiredClaims: ["iss", "sub", "aud", "iat", "exp", "jti", "client_id", "scope", "principal_kind", "client_profile"] });
      const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
      if (!id(p.sub) || !id(p.jti) || !id(p["client_id"]) || p.aud !== AI_JOB_AUDIENCE || p["scope"] !== scope ||
        p["principal_kind"] !== "machine" || p["client_profile"] !== "synthetic-ai-worker-v1" ||
        !Number.isSafeInteger(p.iat) || !Number.isSafeInteger(p.exp) || p.exp! <= p.iat! || p.exp! - p.iat! > 300 ||
        ["tenant_id", "staff_id", "kiosk_id", "roles", "permissions", "act", "may_act", "azp"].some(k => k in p)) throw new Error();
      return attestAiServiceIdentity({ issuer: this.issuer, subject: p.sub, clientId: p["client_id"],
        audience: AI_JOB_AUDIENCE, scope, issuedAt: p.iat!, expiresAt: p.exp! });
    } catch { throw new AiJobError(401); }
  }
}

export class InternalAiJobBoundary {
  constructor(private readonly deps?: { verifier: SyntheticAiServiceVerifier; service: AiJobService }) {}
  async submit(token: string, payload: unknown) {
    if (!this.deps) throw new AiJobError(503);
    return this.deps.service.submit(await this.deps.verifier.verify(token, "ai.jobs.submit"), payload);
  }
  async process(token: string, jobId: string) {
    if (!this.deps) throw new AiJobError(503);
    return this.deps.service.process(await this.deps.verifier.verify(token, "ai.jobs.process"), jobId);
  }
  async read(token: string, jobId: string) {
    if (!this.deps) throw new AiJobError(503);
    return this.deps.service.read(await this.deps.verifier.verify(token, "ai.jobs.read"), jobId);
  }
}
