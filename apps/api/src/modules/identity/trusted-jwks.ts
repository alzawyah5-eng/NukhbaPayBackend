import { createRemoteJWKSet, customFetch, errors, type JWTVerifyGetKey } from "jose";
import { AccessTokenVerificationError } from "./access-token-verifier.js";
import type { IdentityConfiguration } from "./identity.config.js";

/** Dependency injection for deterministic tests; never configurable by a request or environment variable. */
export type JwksFetch = typeof globalThis.fetch;

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    throw new Error("Signing key retrieval aborted");
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { reject(new Error("Signing key retrieval aborted")); };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      () => { signal.removeEventListener("abort", abort); reject(new Error("Signing key retrieval failed")); },
    );
  });
}

async function boundedResponse(response: Response, maximum: number, signal: AbortSignal): Promise<Response> {
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const length = response.headers.get("content-length");
  if (response.status !== 200 || !["application/json", "application/jwk-set+json"].includes(contentType ?? "") ||
      (length !== null && (!/^\d{1,10}$/.test(length) || Number(length) > maximum)) || response.body === null) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("Invalid signing key response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximum || chunks.length >= 1024) throw new Error("Signing key response exceeds limits");
      chunks.push(chunk.value);
    }
  } catch {
    void reader.cancel().catch(() => undefined);
    throw new Error("Signing key response unavailable");
  } finally { reader.releaseLock(); }
  const document: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  if (document === null || typeof document !== "object" || !("keys" in document) ||
      !Array.isArray(document.keys) || document.keys.length < 1 || document.keys.length > 32 ||
      document.keys.some((key: unknown) => key === null || typeof key !== "object" ||
        ["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some((name) => name in key))) {
    throw new Error("Invalid public signing key set");
  }
  return new Response(JSON.stringify(document), { status: 200, headers: { "content-type": "application/json" } });
}

export function createTrustedJwks(config: IdentityConfiguration, fetchKeys: JwksFetch = globalThis.fetch): JWTVerifyGetKey & {
  checkReadiness(): Promise<boolean>; close(): void;
} {
  let retryNotBefore = 0;
  let closed = false;
  const active = new Set<AbortController>();
  const remote = createRemoteJWKSet(new URL(config.jwksUrl), {
    cacheMaxAge: config.jwksCacheMs,
    cooldownDuration: config.jwksCooldownMs,
    timeoutDuration: config.jwksTimeoutMs,
    [customFetch]: async (url, options) => {
      if (url !== config.jwksUrl) throw new Error("Unapproved signing key destination");
      if (closed || Date.now() < retryNotBefore) throw new Error("Signing key retrieval unavailable");
      const cancellation = new AbortController(); active.add(cancellation);
      try {
        const signal = AbortSignal.any([options.signal ?? AbortSignal.timeout(config.jwksTimeoutMs), cancellation.signal]);
        const response = await abortable(fetchKeys(url, {
          ...options, signal, redirect: "error", credentials: "omit", cache: "no-store",
        }), signal);
        if (response.url && response.url !== config.jwksUrl) throw new Error("Unapproved signing key redirect");
        const bounded = await boundedResponse(response, config.jwksMaxBytes, signal);
        retryNotBefore = 0;
        return bounded;
      } catch {
        retryNotBefore = Date.now() + config.jwksCooldownMs;
        throw new Error("Signing key retrieval unavailable");
      } finally { active.delete(cancellation); }
    },
  });
  const resolve: JWTVerifyGetKey = async (header, token) => {
    try {
      if (closed) throw new Error("Signing key resolver closed");
      const key = await remote(header, token);
      if (!(key instanceof CryptoKey) || key.type !== "public" ||
          key.algorithm.name !== "RSASSA-PKCS1-v1_5" || !("modulusLength" in key.algorithm) ||
          typeof key.algorithm.modulusLength !== "number" || key.algorithm.modulusLength < 2048 ||
          key.algorithm.modulusLength > 4096) {
        throw new Error("Unapproved signing key parameters");
      }
      return key;
    } catch (error) {
      if (error instanceof errors.JWKSNoMatchingKey) throw new AccessTokenVerificationError("INVALID_TOKEN");
      throw new AccessTokenVerificationError("KEYS_UNAVAILABLE");
    }
  };
  return Object.assign(resolve, {
    checkReadiness: async (): Promise<boolean> => {
      if (closed) return false;
      try {
        if (!remote.fresh) await remote.reload();
        const keys = remote.jwks()?.keys ?? [];
        for (const key of keys) {
          if (typeof key.kid === "string" && key.kid.length > 0 && key.kid.length <= 128 &&
              key.kty === "RSA" && (key.alg === undefined || key.alg === "RS256") && (key.use === undefined || key.use === "sig")) {
            await resolve({ alg: "RS256", typ: "at+jwt", kid: key.kid }, { payload: "", protected: "", signature: "" });
            return !closed;
          }
        }
        return false;
      } catch { return false; }
    },
    close: (): void => { closed = true; for (const controller of active) controller.abort(); active.clear(); },
  });
}
