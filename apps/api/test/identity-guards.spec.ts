import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as rawRequest } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { LoggerService } from "@nestjs/common";
import type { SecurityAuditEvent, StaffAuthorizationRepository, StaffStatus } from "@nukhbapay/application";
import type { AccessTokenVerifier } from "../src/modules/identity/access-token-verifier.js";
import { createApiApplication } from "../src/http-application.js";
import { OidcAccessTokenVerifier } from "../src/modules/identity/oidc-access-token.verifier.js";
import { staffHttpAcceptance } from "./fixtures/staff-http-acceptance.js";
import { claims, environment, ISSUER, keySource, NOW, NOW_SECONDS, signingKey } from "./fixtures/oidc-test-issuer.js";

test("global HTTP guards fail closed with synthetic cryptography and explicit route policy", async (context) => {
  const staffId = randomUUID(); const tenantId = randomUUID();
  const key = await signingKey("http-unit-key");
  const source = keySource([key.publicJwk]);
  const verifier = new OidcAccessTokenVerifier(environment(), { fetchKeys: source.fetchKeys, now: () => new Date(NOW) });
  const state = { verifier: verifier as AccessTokenVerifier, reader: true, writer: true, status: "ACTIVE" as StaffStatus, reads: 0 };
  const privateMarker = "synthetic-private-connection-detail";
  const logs: string[] = [];
  const capture = (...values: unknown[]) => { logs.push(values.map(String).join(" ")); };
  const logger: LoggerService = { log: capture, error: capture, warn: capture, debug: capture, verbose: capture, fatal: capture };
  const audit: SecurityAuditEvent[] = [];
  const repository: StaffAuthorizationRepository = {
    findByTrustedIdentity: async (identity) => {
      state.reads += 1;
      if (!state.reader) throw new Error(privateMarker);
      return identity.issuer === ISSUER && identity.subject === "active-subject"
        ? { staffId, staffStatus: state.status, identityStatus: "ACTIVE", tokensValidAfter: null, authzVersion: 1n } : null;
    },
    findTenantMembership: async () => null, findPlatformRoleGrants: async () => [],
  };
  const fixture = staffHttpAcceptance(tenantId);
  const app = await createApiApplication({ ...fixture, logger, identity: {
    verifier: { verify: (token) => state.verifier.verify(token) }, repository,
    auditWriter: { appendSecurityAuditEvents: async (events) => {
      if (!state.writer) throw new Error(privateMarker);
      audit.push(...events);
    } }, now: () => new Date(NOW),
  } });
  await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const valid = await key.sign(claims({ sub: "active-subject" }));
  const credentials: string[] = [valid];
  async function send(path: string, token?: string, method = "GET", headers: Record<string, string> = {}) {
    const response = await fetch(base + path, {
      method, headers: { ...(token === undefined ? {} : { Authorization: "Bearer " + token }), ...headers },
    });
    const body = await response.text();
    for (const credential of credentials) assert.equal(body.includes(credential), false, "Response must not contain credentials");
    assert.equal(body.includes(privateMarker), false, "Response must not contain dependency detail");
    if (response.status >= 400) {
      assert.equal(body.includes(staffId) || body.includes(ISSUER) || body.includes("active-subject"), false, "Error must not disclose private identity");
      assert.equal(response.headers.get("cache-control"), "no-store");
      if (method !== "HEAD") assert.deepEqual(JSON.parse(body), {
        statusCode: response.status, message: response.status === 503 ? "Service unavailable" : "Request could not be completed",
      });
    }
    return { response, body };
  }
  try {
    await context.test("only canonical reviewed GET liveness is public; unknown paths are generic", async () => {
      for (const path of ["/health/live", "/health/live?synthetic=ignored"]) {
        const { response, body } = await send(path);
        assert.equal(response.status, 200); assert.equal(body, '{"status":"ok"}');
        assert.equal(response.headers.get("cache-control"), "no-store");
      }
      for (const path of ["/health/live/", "/HEALTH/live", "/unknown/private-subject?token=private"]) {
        const { response } = await send(path); assert.equal(response.status, 404);
      }
      assert.equal((await send("/health/live", undefined, "HEAD")).response.status, 401);
      assert.equal((await send("/health/live", undefined, "OPTIONS")).response.status, 404);
    });
    await context.test("missing, malformed, oversized and duplicate bearer headers never execute handlers", async () => {
      const before = fixture.calls.protected;
      for (const token of [undefined, "forged.token.value", "x".repeat(8193)]) {
        const { response } = await send("/__acceptance/staff/self", token);
        assert.equal(response.status, 401); assert.equal(response.headers.get("www-authenticate"), "Bearer");
      }
      assert.equal((await send("/__acceptance/staff/self", undefined, "GET", { Authorization: "Basic synthetic" })).response.status, 401);
      const status = await new Promise<number>((resolve, reject) => {
        const req = rawRequest(base + "/__acceptance/staff/self", {
          headers: ["Host", new URL(base).host, "Authorization", "Bearer " + valid, "Authorization", "Bearer " + valid],
        }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
        req.on("error", () => reject(new Error("Synthetic HTTP transport failed"))); req.end();
      });
      assert.equal(status, 401); assert.equal(fixture.calls.protected, before);
    });
    await context.test("issuer, audience, client, type, time, missing claims and forged signature reject", async () => {
      const forged = await signingKey("http-unit-key");
      const missingSubject = claims(); delete missingSubject.sub;
      const tokens = await Promise.all([
        key.sign(claims({ iss: "https://wrong.synthetic.invalid/" })), key.sign(claims({ aud: "wrong-api" })),
        key.sign(claims({ client_id: "unapproved-client" })), key.sign(claims(), { typ: "JWT" }),
        key.sign(claims({ exp: NOW_SECONDS - 60 })), key.sign(claims({ nbf: NOW_SECONDS + 120 })),
        key.sign(missingSubject), forged.sign(claims()),
      ]);
      credentials.push(...tokens);
      for (const token of tokens) assert.equal((await send("/__acceptance/staff/self", token)).response.status, 401);
    });
    await context.test("approved token yields only audited self data and aliases require the same authority", async () => {
      for (const path of ["/__acceptance/staff/self", "/__acceptance/staff/self-alias"]) {
        const before = audit.length;
        const { response, body } = await send(path, valid);
        assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
        assert.deepEqual(JSON.parse(body), { staffId, authzVersion: "1", membership: null });
        assert.equal(audit.length, before + 1); assert.equal(audit.at(-1)?.outcome, "SUCCESS");
        assert.equal((await send(path)).response.status, 401);
      }
    });
    await context.test("missing permission, unreviewed public markers, HEAD and alternate methods deny without bypass", async () => {
      const before = fixture.calls.protected;
      for (const path of ["missing-permission", "unreviewed-public"]) {
        assert.equal((await send("/__acceptance/staff/" + path)).response.status, 401);
        assert.equal((await send("/__acceptance/staff/" + path, valid)).response.status, 403);
        assert.equal(audit.at(-1)?.outcome, "DENIED");
      }
      assert.equal((await send("/__acceptance/staff/self", valid, "HEAD")).response.status, 403);
      assert.equal((await send("/__acceptance/staff/self", valid, "OPTIONS")).response.status, 404);
      assert.equal((await send("/__acceptance/staff/alternate-method", valid, "POST")).response.status, 403);
      assert.equal((await send("/__acceptance/staff/self", valid, "POST", { "X-HTTP-Method-Override": "GET" })).response.status, 404);
      assert.equal(fixture.calls.protected, before);
    });
    await context.test("unknown and freshly suspended identities deny regardless of identity headers or claims", async () => {
      const unknown = await key.sign(claims({ sub: "unknown-subject", staff_id: staffId, tenant_id: tenantId, email: "private@example.invalid" }));
      credentials.push(unknown);
      assert.equal((await send("/__acceptance/staff/self", unknown, "GET", { "X-Staff-Id": staffId, "X-Tenant-Id": tenantId })).response.status, 403);
      state.status = "SUSPENDED";
      const before = state.reads;
      assert.equal((await send("/__acceptance/staff/self", valid)).response.status, 403);
      assert.ok(state.reads > before);
      state.status = "ACTIVE";
    });
    await context.test("lookup, audit and verifier outages return sanitized 503; denied audit failure stays denied", async () => {
      const before = fixture.calls.protected;
      state.reader = false;
      assert.equal((await send("/__acceptance/staff/self", valid)).response.status, 503);
      state.reader = true; state.writer = false;
      assert.equal((await send("/__acceptance/staff/self", valid)).response.status, 503);
      const unknown = await key.sign(claims({ sub: "unknown-subject" })); credentials.push(unknown);
      assert.equal((await send("/__acceptance/staff/self", unknown)).response.status, 403);
      state.writer = true;
      state.verifier = { verify: async () => { throw new Error(privateMarker); } };
      assert.equal((await send("/__acceptance/staff/self", valid)).response.status, 503);
      state.verifier = verifier;
      assert.equal(fixture.calls.protected, before);
    });
    await context.test("uncached required JWKS outage is 503, without leaking transport errors", async () => {
      const unavailable = keySource([]);
      unavailable.state.response = () => { throw new Error(privateMarker); };
      state.verifier = new OidcAccessTokenVerifier(environment(), { fetchKeys: unavailable.fetchKeys, now: () => new Date(NOW) });
      assert.equal((await send("/__acceptance/staff/self", valid)).response.status, 503);
      state.verifier = verifier;
    });
    await context.test("structurally forged verifier output is rejected before authorization lookup", async () => {
      const identity = await verifier.verify(valid);
      const before = state.reads;
      state.verifier = { verify: async () => JSON.parse(JSON.stringify(identity)) as typeof identity };
      assert.equal((await send("/__acceptance/staff/self", valid)).response.status, 503);
      assert.equal(state.reads, before);
      state.verifier = verifier;
    });
    await context.test("captured framework/application logs omit all credentials and private details", () => {
      const text = logs.join("\n");
      for (const credential of credentials) assert.equal(text.includes(credential), false, "Log must not contain credentials");
      for (const value of [privateMarker, "active-subject", "private@example.invalid", staffId, ISSUER]) {
        assert.equal(text.includes(value), false, "Log must not disclose private identity or dependency detail");
      }
      assert.ok(logs.some((line) => line.includes("Denied staff request could not be audited")));
    });
  } finally { await app.close(); }
});

test("an unconfigured deployed boundary preserves health but never authorizes an added handler", async () => {
  const fixture = staffHttpAcceptance(randomUUID());
  const app = await createApiApplication({ ...fixture, logger: false });
  await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(base + "/health/live")).status, 200);
    assert.equal((await fetch(base + "/__acceptance/staff/self")).status, 401);
    assert.equal((await fetch(base + "/__acceptance/staff/self", { headers: { Authorization: "Bearer syntactic.token.value" } })).status, 503);
    assert.equal(fixture.calls.protected, 0);
    const server = app.getHttpServer();
    assert.equal(server.maxHeadersCount, 100); assert.equal(server.headersTimeout, 10000);
    assert.equal(server.requestTimeout, 15000); assert.equal(server.keepAliveTimeout, 5000);
  } finally { await app.close(); }
});

test("configured token verification without IAM ports cannot authorize HTTP self access", async () => {
  const key = await signingKey("http-missing-iam");
  const source = keySource([key.publicJwk]);
  const verifier = new OidcAccessTokenVerifier(environment(), { fetchKeys: source.fetchKeys, now: () => new Date(NOW) });
  const fixture = staffHttpAcceptance(randomUUID());
  const app = await createApiApplication({ ...fixture, logger: false, identity: { verifier } });
  await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  try {
    const response = await fetch(base + "/__acceptance/staff/self", { headers: { Authorization: "Bearer " + await key.sign() } });
    assert.equal(response.status, 503); assert.equal(fixture.calls.protected, 0);
    assert.deepEqual(await response.json(), { statusCode: 503, message: "Service unavailable" });
  } finally { await app.close(); }
});
