import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from "jose";
import type { IdentityEnvironment } from "../../src/modules/identity/identity.config.js";
import type { JwksFetch } from "../../src/modules/identity/trusted-jwks.js";

export const NOW = Date.UTC(2026, 10, 11, 8);
export const NOW_SECONDS = NOW / 1000;
export const ISSUER = "https://issuer.synthetic.invalid/";
export const AUDIENCE = "urn:nukhbapay:synthetic:staff-api";
export const JWKS_URL = `${ISSUER}.well-known/jwks.json`;
export const STAFF_KIND_CLAIM = "https://claims.synthetic.invalid/principal-kind";

export function environment(overrides: IdentityEnvironment = {}): IdentityEnvironment {
  return {
    IDENTITY_ENVIRONMENT: "test",
    IDENTITY_ISSUER_URL: ISSUER,
    IDENTITY_API_AUDIENCE: AUDIENCE,
    IDENTITY_JWKS_URL: JWKS_URL,
    IDENTITY_ALLOWED_ALGORITHMS: '["RS256"]',
    IDENTITY_ALLOWED_CLIENT_IDS: '["synthetic-staff-client"]',
    IDENTITY_TOKEN_PROFILE: "rfc9068-staff-v1",
    IDENTITY_STAFF_KIND_CLAIM: STAFF_KIND_CLAIM,
    ...overrides,
  };
}

export function claims(overrides: Readonly<Record<string, unknown>> = {}): JWTPayload {
  return {
    iss: ISSUER, sub: "synthetic|CaseSensitive-Staff", aud: AUDIENCE,
    iat: NOW_SECONDS, exp: NOW_SECONDS + 300, jti: "synthetic-token-id",
    client_id: "synthetic-staff-client", [STAFF_KIND_CLAIM]: "human",
    ...overrides,
  };
}

export async function signingKey(kid: string): Promise<{
  publicJwk: JWK;
  sign: (payload?: JWTPayload, header?: Readonly<Record<string, unknown>>) => Promise<string>;
}> {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = { ...await exportJWK(pair.publicKey), kid, alg: "RS256", use: "sig" };
  return {
    publicJwk,
    sign: (payload = claims(), header = {}) => new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid, ...header })
      .sign(pair.privateKey, { crit: { synthetic: true } }),
  };
}

export function keySource(initialKeys: readonly JWK[]) {
  const state = {
    keys: initialKeys,
    calls: 0,
    response: undefined as (() => Response | Promise<Response>) | undefined,
  };
  const fetchKeys: JwksFetch = async (input, options) => {
    state.calls += 1;
    if (String(input) !== JWKS_URL || options?.redirect !== "error" ||
        options.credentials !== "omit" || !(options.signal instanceof AbortSignal)) {
      throw new Error("Unexpected synthetic transport configuration");
    }
    if (state.response !== undefined) return state.response();
    return new Response(JSON.stringify({ keys: state.keys }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  return { state, fetchKeys };
}
