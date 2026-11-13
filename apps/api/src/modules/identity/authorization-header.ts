import { AccessTokenVerificationError } from "./access-token-verifier.js";

export const MAX_AUTHORIZATION_HEADER_BYTES = 8192;
export const MAX_ACCESS_TOKEN_BYTES = MAX_AUTHORIZATION_HEADER_BYTES - "Bearer ".length;

export function parseBearerAuthorizationHeader(value: string | readonly string[] | undefined): string {
  if (value === undefined) throw new AccessTokenVerificationError("MISSING_CREDENTIALS");
  if (typeof value !== "string" || value.length > MAX_AUTHORIZATION_HEADER_BYTES) {
    throw new AccessTokenVerificationError("INVALID_TOKEN");
  }
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(value);
  if (match?.[1] === undefined || match[0] !== value) throw new AccessTokenVerificationError("INVALID_TOKEN");
  return match[1];
}

/** Use Node's rawHeaders: normalized headers can hide duplicate Authorization fields. */
export function readBearerAuthorization(rawHeaders: readonly string[]): string {
  if (!Array.isArray(rawHeaders) || rawHeaders.length > 200 || rawHeaders.length % 2 !== 0) {
    throw new AccessTokenVerificationError("INVALID_TOKEN");
  }
  let authorization: string | undefined;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (typeof name !== "string" || name.length > 128 || typeof value !== "string") {
      throw new AccessTokenVerificationError("INVALID_TOKEN");
    }
    if (name.toLowerCase() === "authorization") {
      if (authorization !== undefined) throw new AccessTokenVerificationError("INVALID_TOKEN");
      authorization = value;
    }
  }
  return parseBearerAuthorizationHeader(authorization);
}
