import assert from "node:assert/strict";
import test from "node:test";
import { parseIdentityConfiguration } from "../src/modules/identity/identity.config.js";
import { environment } from "./fixtures/oidc-test-issuer.js";

test("identity configuration requires explicit non-production trust and immutable allowlists", () => {
  const config = parseIdentityConfiguration(environment());
  assert.equal(config.environment, "test");
  assert.deepEqual(config.algorithms, ["RS256"]);
  assert.equal(config.maxTokenAgeSeconds, 300);
  assert.equal(config.clockToleranceSeconds, 30);
  assert.equal(config.jwksTimeoutMs, 3000);
  assert.ok(Object.isFrozen(config) && Object.isFrozen(config.clientIds) && Object.isFrozen(config.algorithms));
  assert.equal(parseIdentityConfiguration(environment({ IDENTITY_ENVIRONMENT: "development" })).environment, "development");
  for (const name of Object.keys(environment())) {
    assert.throws(() => parseIdentityConfiguration(environment({ [name]: undefined })), TypeError);
  }
});

test("unapproved environments, algorithms, profiles and client lists fail closed", () => {
  const invalid = [
    { IDENTITY_ENVIRONMENT: "production" }, { IDENTITY_ENVIRONMENT: "" },
    { IDENTITY_ALLOWED_ALGORITHMS: '["HS256"]' },
    { IDENTITY_ALLOWED_ALGORITHMS: '["RS256","HS256"]' },
    { IDENTITY_ALLOWED_ALGORITHMS: '["RS256","RS256"]' },
    { IDENTITY_ALLOWED_ALGORITHMS: '"RS256"' },
    { IDENTITY_TOKEN_PROFILE: "auth0-default" },
    { IDENTITY_ALLOWED_CLIENT_IDS: "[]" }, { IDENTITY_ALLOWED_CLIENT_IDS: "not-json" },
    { IDENTITY_ALLOWED_CLIENT_IDS: '["duplicate","duplicate"]' },
    { IDENTITY_ALLOWED_CLIENT_IDS: '[" client"]' }, { IDENTITY_ALLOWED_CLIENT_IDS: '[42]' },
    { IDENTITY_ALLOWED_CLIENT_IDS: JSON.stringify(Array.from({ length: 17 }, (_, i) => `client-${i}`)) },
  ];
  for (const overrides of invalid) assert.throws(() => parseIdentityConfiguration(environment(overrides)), TypeError);
});

test("identity destinations reject credentials, redirects by configuration, private literals and URL ambiguity", () => {
  for (const issuer of [
    "http://issuer.synthetic.invalid/", "https://127.0.0.1/", "https://[::1]/",
    "https://localhost/", "https://service.local/", "https://issuer.synthetic.invalid:8443/",
    "https://issuer.synthetic.invalid/?query=1", "https://issuer.synthetic.invalid/#fragment",
    "https://user:synthetic-sensitive-value@issuer.synthetic.invalid/",
    "https://issuer.synthetic.invalid", " https://issuer.synthetic.invalid/",
  ]) assert.throws(() => parseIdentityConfiguration(environment({ IDENTITY_ISSUER_URL: issuer })), TypeError);
  for (const overrides of [
    { IDENTITY_JWKS_URL: "https://other.synthetic.invalid/keys" },
    { IDENTITY_JWKS_URL: "https://issuer.synthetic.invalid/keys?query=1" },
    { IDENTITY_API_AUDIENCE: "client-id-not-an-api-resource" },
    { IDENTITY_API_AUDIENCE: "https://user:synthetic-sensitive-value@api.synthetic.invalid/" },
    { IDENTITY_STAFF_KIND_CLAIM: "principal_kind" },
    { IDENTITY_STAFF_KIND_CLAIM: "https://claims.synthetic.invalid/" },
  ]) assert.throws(() => parseIdentityConfiguration(environment(overrides)), TypeError);
  assert.throws(() => parseIdentityConfiguration(environment({
    IDENTITY_ISSUER_URL: "https://user:synthetic-sensitive-value@issuer.synthetic.invalid/",
  })), (error: unknown) => error instanceof Error &&
    error.message === "Invalid identity configuration: IDENTITY_ISSUER_URL" && error.cause === undefined);
});

test("identity resource and clock limits cannot be relaxed beyond bounded policy", () => {
  for (const overrides of [
    { IDENTITY_MAX_TOKEN_AGE_SECONDS: "301" }, { IDENTITY_MAX_TOKEN_AGE_SECONDS: "29" },
    { IDENTITY_CLOCK_TOLERANCE_SECONDS: "31" }, { IDENTITY_CLOCK_TOLERANCE_SECONDS: "-1" },
    { IDENTITY_JWKS_CACHE_MS: "300001" }, { IDENTITY_JWKS_CACHE_MS: "0" },
    { IDENTITY_JWKS_COOLDOWN_MS: "60001" }, { IDENTITY_JWKS_COOLDOWN_MS: "01" },
    { IDENTITY_JWKS_CACHE_MS: "1000", IDENTITY_JWKS_COOLDOWN_MS: "2000" },
    { IDENTITY_JWKS_TIMEOUT_MS: "5001" }, { IDENTITY_JWKS_TIMEOUT_MS: "1.5" },
    { IDENTITY_JWKS_MAX_BYTES: "65537" }, { IDENTITY_JWKS_MAX_BYTES: "100" },
  ]) assert.throws(() => parseIdentityConfiguration(environment(overrides)), TypeError);
  assert.equal(parseIdentityConfiguration(environment({ IDENTITY_CLOCK_TOLERANCE_SECONDS: "0" })).clockToleranceSeconds, 0);
});
