import assert from "node:assert/strict";
import { before, test } from "node:test";
import { SignJWT, UnsecuredJWT, type JWTPayload } from "jose";
import { AccessTokenVerificationError } from "../src/modules/identity/access-token-verifier.js";
import { OidcAccessTokenVerifier } from "../src/modules/identity/oidc-access-token.verifier.js";
import { MAX_ACCESS_TOKEN_BYTES } from "../src/modules/identity/authorization-header.js";
import { AUDIENCE, claims, environment, ISSUER, keySource, NOW, NOW_SECONDS, signingKey, STAFF_KIND_CLAIM } from "./fixtures/oidc-test-issuer.js";

let first: Awaited<ReturnType<typeof signingKey>>;
let second: Awaited<ReturnType<typeof signingKey>>;
before(async () => { [first, second] = await Promise.all([signingKey("first"), signingKey("second")]); });

function fixture(overrides: Readonly<Record<string, string | undefined>> = {}) {
  const source = keySource([first.publicJwk]);
  const verifier = new OidcAccessTokenVerifier(environment(overrides), {
    fetchKeys: source.fetchKeys, now: () => new Date(NOW),
  });
  return { verifier, ...source };
}

function barrier(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => { resolve = release; });
  return { promise, resolve };
}

test("valid synthetic staff access tokens return only immutable validated identity/evidence", async () => {
  const { verifier, state } = fixture();
  const identity = await verifier.verify(await first.sign(claims({
    email: "excluded@example.invalid", permissions: ["ignored"], amr: ["mfa"], acr: "unmapped", auth_time: NOW_SECONDS,
  })));
  assert.deepEqual(identity, {
    issuer: ISSUER, subject: "synthetic|CaseSensitive-Staff",
    security: {
      audience: AUDIENCE, clientId: "synthetic-staff-client", profile: "rfc9068-staff-v1",
      principalKind: "human", issuedAt: NOW_SECONDS, expiresAt: NOW_SECONDS + 300,
      assurance: "not-established",
    },
  });
  assert.ok(Object.isFrozen(identity) && Object.isFrozen(identity.security));
  assert.equal(state.calls, 1);
  const multiAudience = await verifier.verify(await first.sign(claims({ aud: [AUDIENCE, `${ISSUER}userinfo`] })));
  assert.equal(multiAudience.security.audience, AUDIENCE);
  assert.equal(state.calls, 1);
});

test("issuer/audience matching is exact and ID or management tokens are rejected", async () => {
  const { verifier } = fixture();
  for (const changed of [
    { iss: ISSUER.toUpperCase() }, { iss: ISSUER.slice(0, -1) },
    { iss: "https://other.synthetic.invalid/" },
    { aud: AUDIENCE + ":other" }, { aud: "synthetic-staff-client" },
    { aud: `${ISSUER}api/v2/` }, { aud: [] }, { aud: [AUDIENCE, 1] },
  ]) await rejectPayload(verifier, claims(changed));
  await rejectPayload(verifier, claims(), { typ: "JWT" });
});

test("canonical synthetic audience has no legacy project-name trust alias", async () => {
  const { verifier } = fixture();
  assert.equal(AUDIENCE, "urn:nukhbapay:synthetic:staff-api");
  await verifier.verify(await first.sign(claims()));
  await rejectPayload(verifier, claims({ aud: "urn:nukhabapay:synthetic:staff-api" }));
  await rejectPayload(verifier, claims({ aud: "urn:naukhbapay:synthetic:staff-api" }));
  await rejectPayload(verifier, claims({ aud: "urn:nuakhbapay:synthetic:staff-api" }));
});

// Keep signed bearer strings inside the invocation, never in assertion diagnostics.
async function rejectPayload(verifier: OidcAccessTokenVerifier, payload: JWTPayload, header: Readonly<Record<string, unknown>> = {}): Promise<void> {
  const token = await first.sign(payload, header);
  await assert.rejects(() => verifier.verify(token), { code: "INVALID_TOKEN" });
}

test("every required claim and access-token profile field is enforced", async () => {
  const { verifier, state } = fixture();
  for (const name of ["iss", "sub", "aud", "exp", "iat", "jti", "client_id", STAFF_KIND_CLAIM]) {
    const payload = claims();
    delete payload[name];
    await rejectPayload(verifier, payload);
  }
  for (const changed of [
    { sub: "" }, { sub: " staff " }, { sub: "staff\n" }, { sub: "x".repeat(513) },
    { jti: "" }, { client_id: 1 }, { exp: "future" }, { iat: null }, { nbf: "future" },
    { exp: NOW_SECONDS + 0.5 }, { iat: NOW_SECONDS - 0.5 }, { nbf: NOW_SECONDS + 0.5 },
    { nbf: -1 }, { iat: -1 }, { exp: Number.MAX_SAFE_INTEGER + 1 },
  ]) await rejectPayload(verifier, claims(changed));
  for (const header of [{ typ: "at+JWT" }, { typ: "application/at+jwt" }, { typ: "JWT" }, { kid: "" }]) {
    await rejectPayload(verifier, claims(), header);
  }
  assert.equal(state.calls, 1);
});

test("expiry, issuance, age, lifetime, ordering and optional not-before use bounded clock tolerance", async () => {
  const { verifier } = fixture();
  for (const changed of [
    { iat: NOW_SECONDS - 400, exp: NOW_SECONDS - 100 },
    { iat: NOW_SECONDS + 31, exp: NOW_SECONDS + 300 },
    { iat: NOW_SECONDS - 331, exp: NOW_SECONDS - 31 },
    { exp: NOW_SECONDS + 301 }, { exp: NOW_SECONDS },
    { nbf: NOW_SECONDS + 31 }, { nbf: NOW_SECONDS + 300 },
    { iat: NOW_SECONDS + 1, exp: NOW_SECONDS },
  ]) await rejectPayload(verifier, claims(changed));
  await verifier.verify(await first.sign(claims({ nbf: NOW_SECONDS + 30 })));
  await verifier.verify(await first.sign(claims({ iat: NOW_SECONDS + 30, exp: NOW_SECONDS + 300 })));
  await verifier.verify(await first.sign(claims({ iat: NOW_SECONDS - 329, exp: NOW_SECONDS - 29 })));
  const strict = fixture({ IDENTITY_CLOCK_TOLERANCE_SECONDS: "0" }).verifier;
  await rejectPayload(strict, claims({ iat: NOW_SECONDS - 300, exp: NOW_SECONDS }));
  await rejectPayload(strict, claims({ nbf: NOW_SECONDS + 1 }));
});

test("unapproved clients, non-human principals and ambiguous/delegated profiles are denied", async () => {
  const { verifier } = fixture();
  for (const changed of [
    { client_id: "another-client" }, { client_id: "SYNTHETIC-STAFF-CLIENT" },
    { [STAFF_KIND_CLAIM]: "machine" }, { [STAFF_KIND_CLAIM]: "agent" }, { [STAFF_KIND_CLAIM]: true },
    { gty: "client-credentials" }, { azp: "synthetic-staff-client" },
    { act: { sub: "delegated" } }, { may_act: {} }, { sub_profile: "agent" }, { client_profile: "agent" },
  ]) await rejectPayload(verifier, claims(changed));
});

test("malformed and oversized tokens, unsigned tokens and algorithm confusion never fetch keys", async () => {
  const { verifier, state } = fixture();
  for (const token of ["", "opaque", "a.b.c", "a.b.", "a.b.c.d.e", "a.b.c\n", "é.b.c", "a".repeat(MAX_ACCESS_TOKEN_BYTES + 1)]) {
    await assert.rejects(() => verifier.verify(token), { code: "INVALID_TOKEN" });
  }
  await assert.rejects(() => verifier.verify(new UnsecuredJWT(claims()).encode()), { code: "INVALID_TOKEN" });
  const confused = await new SignJWT(claims()).setProtectedHeader({ alg: "HS256", typ: "at+jwt", kid: "first" })
    .sign(new TextEncoder().encode(first.publicJwk.n));
  await assert.rejects(() => verifier.verify(confused), { code: "INVALID_TOKEN" });
  const valid = await first.sign();
  await assert.rejects(() => verifier.verify(valid + "\n"), { code: "INVALID_TOKEN" });
  await assert.rejects(() => verifier.verify(" " + valid), { code: "INVALID_TOKEN" });
  assert.equal(state.calls, 0);
});

test("token-supplied key locations and unsupported extensions cannot change trust", async () => {
  const { verifier, state } = fixture();
  for (const header of [
    { jku: "https://attacker.synthetic.invalid/keys" }, { x5u: "https://attacker.synthetic.invalid/cert" },
    { jwk: first.publicJwk }, { x5c: ["untrusted"] }, { cty: "JWT" },
    { crit: ["synthetic"], synthetic: true },
  ]) await rejectPayload(verifier, claims(), header);
  assert.equal(state.calls, 0);
});

test("forged signatures are rejected with sanitized errors and no refresh loop", async () => {
  const { verifier, state } = fixture();
  const forged = await second.sign(claims(), { kid: "first" });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(() => verifier.verify(forged), (error: unknown) =>
      error instanceof AccessTokenVerificationError && error.code === "INVALID_TOKEN" &&
      error.message === "Access token rejected" && error.cause === undefined &&
      Object.keys(error).every((key) => ["code", "name"].includes(key)));
  }
  assert.equal(state.calls, 1);
});

test("unknown signing keys reject without bypassing successful-fetch cooldown", async () => {
  const { verifier, state } = fixture();
  const token = await second.sign();
  await assert.rejects(() => verifier.verify(token), { code: "INVALID_TOKEN" });
  await assert.rejects(() => verifier.verify(token), { code: "INVALID_TOKEN" });
  assert.equal(state.calls, 1);
});

test("rotation refreshes after bounded cooldown and supports overlapping signing keys", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: NOW });
  const { verifier, state } = fixture({ IDENTITY_JWKS_COOLDOWN_MS: "1000" });
  await verifier.verify(await first.sign());
  state.keys = [first.publicJwk, second.publicJwk];
  const rotated = await second.sign();
  await assert.rejects(() => verifier.verify(rotated), { code: "INVALID_TOKEN" });
  context.mock.timers.tick(1001);
  assert.equal((await verifier.verify(rotated)).subject, claims().sub);
  await verifier.verify(await first.sign());
  assert.equal(state.calls, 2);
});

test("fresh cached keys survive an outage, but expired keys cannot be used indefinitely", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: NOW });
  const { verifier, state } = fixture({ IDENTITY_JWKS_CACHE_MS: "1000", IDENTITY_JWKS_COOLDOWN_MS: "1000" });
  const token = await first.sign();
  await verifier.verify(token);
  state.response = () => { throw new Error("Synthetic outage detail must not escape"); };
  await verifier.verify(token);
  assert.equal(state.calls, 1);
  context.mock.timers.tick(1001);
  await assert.rejects(() => verifier.verify(token), { code: "KEYS_UNAVAILABLE" });
  await assert.rejects(() => verifier.verify(token), { code: "KEYS_UNAVAILABLE" });
  assert.equal(state.calls, 2);
  state.response = undefined;
  context.mock.timers.tick(1001);
  await verifier.verify(token);
  assert.equal(state.calls, 3);
});

test("a revoked/removed key stops verifying after cache expiry and successful refresh", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: NOW });
  const { verifier, state } = fixture({ IDENTITY_JWKS_CACHE_MS: "1000", IDENTITY_JWKS_COOLDOWN_MS: "1000" });
  const token = await first.sign();
  await verifier.verify(token);
  state.keys = [second.publicJwk];
  context.mock.timers.tick(1001);
  await assert.rejects(() => verifier.verify(token), { code: "INVALID_TOKEN" });
  await verifier.verify(await second.sign());
  assert.equal(state.calls, 2);
});

test("concurrent validations coalesce key fetching", async () => {
  const { verifier, state } = fixture();
  const token = await first.sign();
  const results = await Promise.all(Array.from({ length: 8 }, () => verifier.verify(token)));
  assert.equal(results.length, 8);
  assert.equal(state.calls, 1);
});

test("unavailable JWKS fails closed with bounded failure backoff and no leaked response", async () => {
  const { verifier, state } = fixture();
  state.response = () => { throw new Error("Synthetic sensitive upstream detail"); };
  const token = await first.sign();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(() => verifier.verify(token), (error: unknown) =>
      error instanceof AccessTokenVerificationError && error.code === "KEYS_UNAVAILABLE" &&
      error.message === "Trusted signing keys unavailable" && error.cause === undefined);
  }
  assert.equal(state.calls, 1);
});

test("malformed, redirected, oversized, empty, private or ambiguous JWKS fails closed", async () => {
  const responses = [
    () => new Response("upstream detail", { status: 503 }),
    () => new Response(null, { status: 302, headers: { location: "https://attacker.synthetic.invalid/" } }),
    () => new Response("{}", { headers: { "content-type": "text/html" } }),
    () => new Response("not-json", { headers: { "content-type": "application/json" } }),
    () => new Response("{}", { headers: { "content-type": "application/json" } }),
    () => new Response('{"keys":[]}', { headers: { "content-type": "application/json" } }),
    () => new Response(JSON.stringify({ keys: [null] }), { headers: { "content-type": "application/json" } }),
    () => new Response(JSON.stringify({ keys: [{ ...first.publicJwk, d: "private-material-rejected" }] }), { headers: { "content-type": "application/json" } }),
    () => new Response(JSON.stringify({ keys: Array(33).fill(first.publicJwk) }), { headers: { "content-type": "application/json" } }),
    () => new Response(JSON.stringify({ keys: [first.publicJwk, first.publicJwk] }), { headers: { "content-type": "application/json" } }),
    () => new Response(JSON.stringify({ keys: [{ kty: "RSA", kid: "first", n: "bad", e: "bad" }] }), { headers: { "content-type": "application/json" } }),
    () => new Response("x".repeat(65_537), { headers: { "content-type": "application/json" } }),
    () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "65537" } }),
    () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "invalid" } }),
  ];
  const token = await first.sign();
  for (const response of responses) {
    const { verifier, state } = fixture();
    state.response = response;
    await assert.rejects(() => verifier.verify(token), { code: "KEYS_UNAVAILABLE" });
  }
});

test("aborted key transport is unavailable and never falls back to untrusted material", async () => {
  const { verifier, state } = fixture();
  state.response = () => { throw new DOMException("Synthetic abort", "AbortError"); };
  const token = await first.sign();
  await assert.rejects(() => verifier.verify(token), { code: "KEYS_UNAVAILABLE" });
});

test("separate environment trust rejects a valid token from another environment", async () => {
  const { fetchKeys, state } = keySource([first.publicJwk]);
  const other = new OidcAccessTokenVerifier(environment({
    IDENTITY_ENVIRONMENT: "development", IDENTITY_API_AUDIENCE: "urn:nukhbapay:synthetic:development-api",
  }), { fetchKeys, now: () => new Date(NOW) });
  const token = await first.sign();
  await assert.rejects(() => other.verify(token), { code: "INVALID_TOKEN" });
  assert.equal(state.calls, 1);
});

test("the configured deadline aborts a stalled transport without real-time sleeps", async (context) => {
  const controller = new AbortController();
  let timeout = 0;
  context.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    timeout = milliseconds;
    return controller.signal;
  });
  const started = barrier();
  const verifier = new OidcAccessTokenVerifier(environment({ IDENTITY_JWKS_TIMEOUT_MS: "100" }), {
    now: () => new Date(NOW),
    fetchKeys: async () => {
      started.resolve();
      return new Promise<Response>(() => undefined);
    },
  });
  const pending = verifier.verify(await first.sign());
  await started.promise;
  controller.abort();
  await assert.rejects(pending, { code: "KEYS_UNAVAILABLE" });
  assert.equal(timeout, 100);
});

test("the same deadline covers stalled body streaming and cancels the reader", async (context) => {
  const controller = new AbortController();
  context.mock.method(AbortSignal, "timeout", () => controller.signal);
  const reading = barrier();
  let cancelled = false;
  const verifier = new OidcAccessTokenVerifier(environment(), {
    now: () => new Date(NOW),
    fetchKeys: async () => new Response(new ReadableStream<Uint8Array>({
      pull() { reading.resolve(); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "application/json" } }),
  });
  const pending = verifier.verify(await first.sign());
  await reading.promise;
  controller.abort();
  await assert.rejects(pending, { code: "KEYS_UNAVAILABLE" });
  assert.equal(cancelled, true);
});
