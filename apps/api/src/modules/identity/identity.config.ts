import { isIP } from "node:net";

export type IdentityEnvironment = Readonly<Record<string, string | undefined>>;

export interface IdentityConfiguration {
  readonly environment: "development" | "test";
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  readonly algorithms: readonly ["RS256"];
  readonly profile: "rfc9068-staff-v1";
  readonly clientIds: readonly string[];
  readonly staffKindClaim: string;
  readonly maxTokenAgeSeconds: number;
  readonly clockToleranceSeconds: number;
  readonly jwksCacheMs: number;
  readonly jwksCooldownMs: number;
  readonly jwksTimeoutMs: number;
  readonly jwksMaxBytes: number;
}

function invalid(name: string): never {
  // Configuration values may contain secrets accidentally; report names only.
  throw new TypeError(`Invalid identity configuration: ${name}`);
}

function required(env: IdentityEnvironment, name: string, maximum = 512): string {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /\s/.test(value)) {
    return invalid(name);
  }
  return value;
}

function httpsUrl(env: IdentityEnvironment, name: string): URL {
  const value = required(env, name);
  let url: URL;
  try { url = new URL(value); } catch { return invalid(name); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.port || !url.hostname.includes(".") || isIP(url.hostname) !== 0 ||
      url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local") ||
      url.href !== value) {
    return invalid(name);
  }
  return url;
}

function list(env: IdentityEnvironment, name: string): readonly string[] {
  const text = env[name];
  if (typeof text !== "string" || text.length > 4096) return invalid(name);
  let values: unknown;
  try { values = JSON.parse(text); } catch { return invalid(name); }
  if (!Array.isArray(values) || values.length < 1 || values.length > 16 ||
      values.some((value: unknown) => typeof value !== "string" || value.length < 1 || value.length > 128 || /\s/.test(value)) ||
      new Set(values).size !== values.length) {
    return invalid(name);
  }
  return Object.freeze(values as string[]);
}

function integer(env: IdentityEnvironment, name: string, fallback: number, minimum: number, maximum: number): number {
  const text = env[name];
  if (text === undefined) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(text)) return invalid(name);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid(name);
  return value;
}

export function parseIdentityConfiguration(env: IdentityEnvironment): IdentityConfiguration {
  const environment = required(env, "IDENTITY_ENVIRONMENT");
  if (environment !== "development" && environment !== "test") return invalid("IDENTITY_ENVIRONMENT");
  const issuer = httpsUrl(env, "IDENTITY_ISSUER_URL");
  const jwks = httpsUrl(env, "IDENTITY_JWKS_URL");
  if (issuer.origin !== jwks.origin) return invalid("IDENTITY_JWKS_URL");
  const audience = required(env, "IDENTITY_API_AUDIENCE");
  let audienceUrl: URL;
  try { audienceUrl = new URL(audience); } catch { return invalid("IDENTITY_API_AUDIENCE"); }
  if (!["https:", "urn:"].includes(audienceUrl.protocol) || audienceUrl.username || audienceUrl.password ||
      audienceUrl.search || audienceUrl.hash) return invalid("IDENTITY_API_AUDIENCE");
  const algorithms = list(env, "IDENTITY_ALLOWED_ALGORITHMS");
  if (algorithms.length !== 1 || algorithms[0] !== "RS256") return invalid("IDENTITY_ALLOWED_ALGORITHMS");
  const profile = required(env, "IDENTITY_TOKEN_PROFILE");
  if (profile !== "rfc9068-staff-v1") return invalid("IDENTITY_TOKEN_PROFILE");
  const claim = httpsUrl(env, "IDENTITY_STAFF_KIND_CLAIM");
  if (claim.pathname === "/") return invalid("IDENTITY_STAFF_KIND_CLAIM");
  const jwksCacheMs = integer(env, "IDENTITY_JWKS_CACHE_MS", 300_000, 1000, 300_000);
  const jwksCooldownMs = integer(env, "IDENTITY_JWKS_COOLDOWN_MS", 30_000, 1000, 60_000);
  if (jwksCooldownMs > jwksCacheMs) return invalid("IDENTITY_JWKS_COOLDOWN_MS");
  return Object.freeze({
    environment,
    issuer: issuer.href,
    audience,
    jwksUrl: jwks.href,
    algorithms: Object.freeze(["RS256"] as const),
    profile,
    clientIds: list(env, "IDENTITY_ALLOWED_CLIENT_IDS"),
    staffKindClaim: claim.href,
    maxTokenAgeSeconds: integer(env, "IDENTITY_MAX_TOKEN_AGE_SECONDS", 300, 30, 300),
    clockToleranceSeconds: integer(env, "IDENTITY_CLOCK_TOLERANCE_SECONDS", 30, 0, 30),
    jwksCacheMs,
    jwksCooldownMs,
    jwksTimeoutMs: integer(env, "IDENTITY_JWKS_TIMEOUT_MS", 3000, 100, 5000),
    jwksMaxBytes: integer(env, "IDENTITY_JWKS_MAX_BYTES", 65_536, 1024, 65_536),
  });
}
