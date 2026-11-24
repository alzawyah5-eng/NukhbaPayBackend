import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createLocalApiRuntime, LocalRuntimeUnavailableError } from "../src/local-api-runtime.js";
import { claims, environment, keySource, NOW, signingKey } from "./fixtures/oidc-test-issuer.js";
import { staffHttpAcceptance } from "./fixtures/staff-http-acceptance.js";

function iamSettings() {
  const settings: Record<string, string> = {};
  for (const [name, role] of [["DB_IDENTITY_READER_URL", "nukhabapay_identity_reader"], ["DB_IDENTITY_WRITER_URL", "nukhabapay_identity_writer"]]) {
    const url = new URL("postgresql:" + "//127.0.0.1/nukhabapay_synthetic");
    url.username = role!; url.password = randomUUID(); settings[name!] = url.href;
  }
  return settings;
}

test("disabled runtime has internal readiness, public health only, and idempotent cleanup", async () => {
  let created = false;
  const runtime = await createLocalApiRuntime({}, { logger: false, createIam: async () => { created = true; throw new Error("must not initialize"); } });
  try {
    assert.deepEqual(await runtime.checkReadiness(), { ready: true });
    await runtime.app.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${(runtime.app.getHttpServer().address() as AddressInfo).port}`;
    const health = await fetch(base + "/health/live");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    for (const path of ["/health/ready", "/__acceptance/staff/self"]) assert.equal((await fetch(base + path)).status, 404);
    assert.equal(created, false);
  } finally { await Promise.all([runtime.close(), runtime.close()]); }
  assert.deepEqual(await runtime.checkReadiness(), { ready: false });
});

test("Windows staff health reports the current storage probe result without leaking errors", async () => {
  let ready = false;
  let fail = false;
  const runtime = await createLocalApiRuntime({ API_HEALTH_MODE: "windows-staff-postgresql" }, {
    logger: false,
    probeStaffStorage: async () => {
      if (fail) throw new Error("private probe failure");
      return ready;
    },
  });
  try {
    await runtime.app.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${(runtime.app.getHttpServer().address() as AddressInfo).port}`;
    const check = async (status: number, body: { status: string; database: string }) => {
      const response = await fetch(base + "/health/live");
      assert.equal(response.status, status);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), body);
    };
    await check(503, { status: "unavailable", database: "unavailable" });
    ready = true;
    await check(200, { status: "ok", database: "connected" });
    fail = true;
    await check(503, { status: "unavailable", database: "unavailable" });
  } finally {
    await runtime.close();
  }
});

test("startup rejects invalid mode, partial disabled configuration, external/production trust and absent synthetic transport before IAM", async () => {
  const key = await signingKey("startup-key"); const source = keySource([key.publicJwk]);
  let created = 0;
  for (const env of [
    { API_STAFF_AUTH_MODE: "enabled" }, { IDENTITY_ISSUER_URL: "private-config-marker" },
    { API_HEALTH_MODE: "unknown" },
    { API_HEALTH_MODE: "windows-staff-postgresql", API_HOST: "0.0.0.0" },
    { API_HEALTH_MODE: "windows-staff-postgresql", NODE_ENV: "production" },
    { API_HEALTH_MODE: "windows-staff-postgresql", API_STAFF_AUTH_MODE: "local-synthetic" },
    { API_STAFF_AUTH_MODE: "disabled", ...iamSettings() },
    { API_STAFF_AUTH_MODE: "local-synthetic" },
    { API_STAFF_AUTH_MODE: "local-synthetic", ...environment({ IDENTITY_ENVIRONMENT: "production" }), ...iamSettings() },
    { API_STAFF_AUTH_MODE: "local-synthetic", ...environment({ IDENTITY_ISSUER_URL: "https://external.example.com/", IDENTITY_JWKS_URL: "https://external.example.com/keys" }), ...iamSettings() },
    { API_STAFF_AUTH_MODE: "local-synthetic", API_HOST: "0.0.0.0", ...environment(), ...iamSettings() },
    { API_STAFF_AUTH_MODE: "local-synthetic", ...environment(), ...iamSettings(), DB_IDENTITY_READER_ROLE: "postgres" },
  ]) {
    await assert.rejects(() => createLocalApiRuntime(env, { logger: false, fetchKeys: source.fetchKeys,
      createIam: async () => { created += 1; throw new Error("private connection marker"); } }),
      (error: unknown) => error instanceof LocalRuntimeUnavailableError && error.message === "Local API runtime unavailable" && error.cause === undefined);
  }
  await assert.rejects(() => createLocalApiRuntime({ API_STAFF_AUTH_MODE: "local-synthetic", ...environment(), ...iamSettings() }), LocalRuntimeUnavailableError);
  assert.equal(created, 0); assert.equal(source.state.calls, 0);
});

test("local composition isolates credentials, coalesces readiness and calls existing guards with synthetic tokens", async () => {
  const key = await signingKey("composed-key"); const source = keySource([key.publicJwk]); const staffId = randomUUID();
  const state = { ready: true, checks: 0, closes: 0, audits: 0 };
  const fakeIam = {
    repository: { findByTrustedIdentity: async () => ({ staffId, staffStatus: "ACTIVE" as const, identityStatus: "ACTIVE" as const, tokensValidAfter: null, authzVersion: 0n }),
      findTenantMembership: async () => null, findPlatformRoleGrants: async () => [] },
    auditWriter: { appendSecurityAuditEvents: async () => { state.audits += 1; } },
    checkReadiness: async () => { state.checks += 1; return state.ready; }, close: async () => { state.closes += 1; },
  };
  const env = new Proxy({ API_STAFF_AUTH_MODE: "local-synthetic", ...environment(), ...iamSettings() }, {
    get(target, property, receiver) {
      if (["DB_MIGRATION_URL", "DB_IMPORT_URL", "DB_RUNTIME_URL", "DB_TEST_ADMIN_URL"].includes(String(property))) throw new Error("Unrelated credentials accessed");
      return Reflect.get(target, property, receiver);
    },
  });
  const runtime = await createLocalApiRuntime(env, { logger: false, ...staffHttpAcceptance(randomUUID()), fetchKeys: source.fetchKeys, now: () => new Date(NOW),
    createIam: async (configuration) => {
      assert.equal(Object.keys(configuration).every((key) => key.startsWith("DB_IDENTITY_")), true);
      return fakeIam;
    } });
  try {
    const before = state.checks;
    const results = await Promise.all([runtime.checkReadiness(), runtime.checkReadiness()]);
    assert.ok(results.every((value) => value.ready)); assert.equal(state.checks, before + 1);
    state.ready = false; assert.deepEqual(await runtime.checkReadiness(), { ready: false });
    state.ready = true; assert.deepEqual(await runtime.checkReadiness(), { ready: true });
    await runtime.app.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${(runtime.app.getHttpServer().address() as AddressInfo).port}`;
    assert.equal((await fetch(base + "/__acceptance/staff/self")).status, 401);
    const token = await key.sign(claims());
    const response = await fetch(base + "/__acceptance/staff/self", { headers: { Authorization: "Bearer " + token } });
    assert.equal(response.status, 200); assert.equal(state.audits, 1);
    const text = await response.text(); assert.equal(text.includes(token), false);
    await runtime.app.close(); // Nest lifecycle path, including signal-driven shutdown hooks.
  } finally { await Promise.all([runtime.close(), runtime.close()]); }
  assert.equal(state.closes, 1); assert.deepEqual(await runtime.checkReadiness(), { ready: false });
});

test("failed startup readiness closes IAM and in-flight synthetic JWKS fetching is cancelled on close", async () => {
  const key = await signingKey("failure-key"); const source = keySource([key.publicJwk]);
  let closed = 0;
  const fakeIam = { repository: { findByTrustedIdentity: async () => null, findTenantMembership: async () => null, findPlatformRoleGrants: async () => [] },
    auditWriter: { appendSecurityAuditEvents: async () => undefined }, checkReadiness: async () => false, close: async () => { closed += 1; } };
  const env = { API_STAFF_AUTH_MODE: "local-synthetic", ...environment(), ...iamSettings() };
  await assert.rejects(() => createLocalApiRuntime(env, { fetchKeys: source.fetchKeys, createIam: async () => fakeIam }), LocalRuntimeUnavailableError);
  assert.equal(closed, 1);
  const { OidcAccessTokenVerifier } = await import("../src/modules/identity/oidc-access-token.verifier.js");
  let started!: () => void; const began = new Promise<void>((resolve) => { started = resolve; });
  const verifier = new OidcAccessTokenVerifier(environment(), { fetchKeys: async (_input, options) => {
    started(); return new Promise<Response>((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("private transport detail")), { once: true }));
  } });
  const checking = verifier.checkReadiness(); await began; verifier.close();
  assert.equal(await checking, false); assert.equal(await verifier.checkReadiness(), false);
});
