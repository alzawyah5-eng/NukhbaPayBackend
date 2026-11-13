import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createIdentityRuntime } from "@nukhbapay/database/identity-runtime";
import type { AccessTokenVerifier } from "../src/modules/identity/access-token-verifier.js";
import { createApiApplication } from "../src/http-application.js";
import { OidcAccessTokenVerifier } from "../src/modules/identity/oidc-access-token.verifier.js";
import { claims, environment, ISSUER, keySource, NOW, NOW_SECONDS, signingKey } from "./fixtures/oidc-test-issuer.js";
import { withDisposableIamDatabase } from "./fixtures/disposable-iam-database.js";
import { staffHttpAcceptance } from "./fixtures/staff-http-acceptance.js";

test("test-only HTTP guards preserve restricted IAM and committed audit on a disposable database", async (context) => {
  await withDisposableIamDatabase(async (fixture) => {
    const database = fixture.fixtureClient;
    const tenantA = randomUUID(); const tenantB = randomUUID();
    const active = randomUUID(); const suspended = randomUUID(); const disabled = randomUUID(); const pending = randomUUID();
    const memberA = randomUUID(); const memberB = randomUUID(); const grantId = randomUUID();
    await database.query("INSERT INTO nukhabapay.tenants(id,tenant_key) VALUES($1,'http-synthetic-a'),($2,'http-synthetic-b')", [tenantA, tenantB]);
    for (const [id, status] of [[active, "ACTIVE"], [suspended, "SUSPENDED"], [disabled, "DISABLED"], [pending, "PENDING"]]) {
      await database.query("INSERT INTO nukhabapay.staff_users(id,display_name,contact_email,status,authz_version) VALUES($1,'Synthetic Private Staff','private-http@example.invalid',$2,7)", [id, status]);
    }
    for (const [id, subject, status] of [
      [active, "active-http", "ACTIVE"], [suspended, "suspended-http", "ACTIVE"], [disabled, "disabled-http", "ACTIVE"],
      [pending, "pending-http", "ACTIVE"], [active, "disabled-binding-http", "DISABLED"],
    ]) {
      await database.query("INSERT INTO nukhabapay.staff_identities(id,staff_id,issuer,subject,status) VALUES($1,$2,$3,$4,$5)", [randomUUID(), id, ISSUER, subject, status]);
    }
    // Both memberships are active: the cross-tenant test must fail even with a membership in B.
    await database.query("INSERT INTO nukhabapay.staff_memberships(id,staff_id,tenant_id,status) VALUES($1,$2,$3,'ACTIVE'),($4,$2,$5,'ACTIVE')", [memberA, active, tenantA, memberB, tenantB]);
    await database.query(`INSERT INTO nukhabapay.tenant_role_grants(id,membership_id,tenant_id,role_code,granted_at,grant_source,evidence_reference)
      VALUES($1,$2,$3,'CATALOG_OPERATOR','2025-01-01T00:00:00Z','TEST','brick3b3.synthetic')`, [grantId, memberA, tenantA]);
    await database.query(`INSERT INTO nukhabapay.platform_role_grants(id,staff_id,role_code,granted_at,grant_source,evidence_reference)
      VALUES($1,$2,'GOVERNANCE_OWNER','2025-01-01T00:00:00Z','TEST','brick3b3.synthetic')`, [randomUUID(), active]);
    const runtime = await createIdentityRuntime(fixture.runtimeEnv);
    const unavailable = await createIdentityRuntime(fixture.runtimeEnv);
    await unavailable.close();
    const key = await signingKey("http-postgres-key");
    const source = keySource([key.publicJwk]);
    const verifier = new OidcAccessTokenVerifier(environment(), { fetchKeys: source.fetchKeys, now: () => new Date(NOW) });
    const state = { verifier: verifier as AccessTokenVerifier, reader: runtime.repository, writer: runtime.auditWriter, lookups: 0 };
    const acceptance = staffHttpAcceptance(tenantA);
    const app = await createApiApplication({ ...acceptance, logger: false, identity: {
      verifier: { verify: (token) => state.verifier.verify(token) },
      repository: {
        findByTrustedIdentity: (identity) => { state.lookups += 1; return state.reader.findByTrustedIdentity(identity); },
        findTenantMembership: (staff, tenant) => state.reader.findTenantMembership(staff, tenant),
        findPlatformRoleGrants: (staff) => state.reader.findPlatformRoleGrants(staff),
      },
      auditWriter: { appendSecurityAuditEvents: (events) => state.writer.appendSecurityAuditEvents(events) },
      now: () => new Date(NOW),
    } });
    const credentials: string[] = [];
    const bearer = async (subject = "active-http", overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}) => {
      const token = await key.sign(claims({ sub: subject, ...overrides }), header); credentials.push(token); return token;
    };
    const successfulAudits = async () => Number((await database.query("SELECT count(*)::int AS total FROM nukhabapay.security_audit_events WHERE outcome='SUCCESS'")).rows[0].total);
    try {
      await app.listen(0, "127.0.0.1");
      const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
      const valid = await bearer();
      async function send(path: string, token?: string, headers: Record<string, string> = {}) {
        const response = await fetch(base + path, { headers: { ...(token === undefined ? {} : { Authorization: "Bearer " + token }), ...headers } });
        const text = await response.text();
        for (const credential of credentials) assert.equal(text.includes(credential), false, "Response must not contain credentials");
        for (const value of ["private-http@example.invalid", "Synthetic Private Staff", ISSUER, "active-http"]) {
          assert.equal(text.includes(value), false, "Response must not disclose private identity");
        }
        assert.equal(response.headers.get("cache-control"), "no-store");
        return { response, text };
      }
      await context.test("liveness and unknown routes disclose no identity and do not query IAM", async () => {
        const before = state.lookups;
        const live = await send("/health/live"); assert.equal(live.response.status, 200); assert.equal(live.text, '{"status":"ok"}');
        assert.equal((await send("/unknown/private-http@example.invalid")).response.status, 404);
        assert.equal(state.lookups, before);
      });
      await context.test("missing/invalid tokens and wrong issuer/audience/client/type fail before IAM", async () => {
        const before = state.lookups;
        const forged = await signingKey("http-postgres-key");
        const badSignature = await forged.sign(claims({ sub: "active-http" })); credentials.push(badSignature);
        for (const token of [undefined, "forged.token.value", badSignature,
          await bearer("active-http", { iss: "https://wrong.synthetic.invalid/" }), await bearer("active-http", { aud: "wrong-api" }),
          await bearer("active-http", { client_id: "unapproved-client" }), await bearer("active-http", {}, { typ: "JWT" }),
          await bearer("active-http", { exp: NOW_SECONDS - 60 }),
        ]) assert.equal((await send("/__acceptance/staff/self", token)).response.status, 401);
        assert.equal(state.lookups, before);
      });
      await context.test("authorized self and tenant-scoped self are returned only after real committed audit", async () => {
        for (const path of ["/__acceptance/staff/self", "/__acceptance/staff/self-alias", `/__acceptance/staff/tenants/${tenantA}/self`]) {
          const before = await successfulAudits();
          const result = await send(path, valid);
          assert.equal(result.response.status, 200);
          const self = JSON.parse(result.text);
          assert.equal(self.staffId, active); assert.equal(self.authzVersion, "7");
          assert.deepEqual(Object.keys(self).sort(), ["authzVersion", "membership", "staffId"]);
          assert.equal(await successfulAudits(), before + 1);
          if (path.includes("tenants")) assert.equal(self.membership.tenantId, tenantA);
        }
      });
      await context.test("unknown, case-mismatched, suspended, pending, disabled staff/bindings cannot enroll or link by email", async () => {
        const before = (await database.query("SELECT count(*)::int AS total FROM nukhabapay.staff_users")).rows[0].total;
        for (const subject of ["unknown-http", "ACTIVE-HTTP", "suspended-http", "pending-http", "disabled-http", "disabled-binding-http"]) {
          const token = await bearer(subject, { email: "private-http@example.invalid", staff_id: active, tenant_id: tenantA });
          assert.equal((await send("/__acceptance/staff/self", token, { "X-Staff-Id": active, "X-Tenant-Id": tenantA })).response.status, 403);
        }
        assert.equal((await database.query("SELECT count(*)::int AS total FROM nukhabapay.staff_users")).rows[0].total, before);
      });
      await context.test("missing metadata denies and records the policy denial", async () => {
        const before = acceptance.calls.protected;
        for (const path of ["missing-permission", "unreviewed-public"]) {
          assert.equal((await send("/__acceptance/staff/" + path, valid)).response.status, 403);
        }
        assert.equal(acceptance.calls.protected, before);
        const reasons = await database.query("SELECT count(*)::int AS total FROM nukhabapay.security_audit_events WHERE outcome='DENIED' AND reason_code='PERMISSION_UNKNOWN'");
        assert.equal(reasons.rows[0].total, 2);
      });
      await context.test("committed staff/membership suspension and revocation are seen with the same token", async () => {
        await database.query("UPDATE nukhabapay.staff_users SET status='SUSPENDED' WHERE id=$1", [active]);
        assert.equal((await send("/__acceptance/staff/self", valid)).response.status, 403);
        await database.query("UPDATE nukhabapay.staff_users SET status='ACTIVE' WHERE id=$1", [active]);
        for (const status of ["SUSPENDED", "REVOKED"]) {
          await database.query("UPDATE nukhabapay.staff_memberships SET status=$1 WHERE id=$2", [status, memberA]);
          assert.equal((await send(`/__acceptance/staff/tenants/${tenantA}/self`, valid)).response.status, 403);
        }
        await database.query("UPDATE nukhabapay.staff_memberships SET status='ACTIVE' WHERE id=$1", [memberA]);
        assert.equal((await send(`/__acceptance/staff/tenants/${tenantA}/self`, valid)).response.status, 200);
      });
      await context.test("cross-tenant object access denies even with both memberships and forged tenant headers/claims", async () => {
        const token = await bearer("active-http", { tenant_id: tenantA, permissions: ["*"] });
        assert.equal((await send(`/__acceptance/staff/tenants/${tenantB}/self`, token, { "X-Tenant-Id": tenantA, "X-Object-Tenant-Id": tenantB })).response.status, 403);
        const reason = await database.query("SELECT count(*)::int AS total FROM nukhabapay.security_audit_events WHERE reason_code='TENANT_MISMATCH'");
        assert.ok(reason.rows[0].total >= 1);
      });
      await context.test("revoked/expired grants and reserved permissions deny; platform grants never override", async () => {
        for (const lifecycle of ["expires_at='2026-01-01T00:00:00Z'", "expires_at=NULL,revoked_at='2026-01-01T00:00:00Z'", "expires_at=NULL,revoked_at=NULL"]) {
          await database.query(`UPDATE nukhabapay.tenant_role_grants SET ${lifecycle} WHERE id=$1`, [grantId]);
          assert.equal((await send(`/__acceptance/staff/reserved/${tenantA}`, valid)).response.status, 403);
        }
        const reasons = await database.query("SELECT reason_code FROM nukhabapay.security_audit_events WHERE reason_code IN ('GRANT_INACTIVE','PERMISSION_INACTIVE')");
        assert.ok(reasons.rows.some((row) => row.reason_code === "GRANT_INACTIVE"));
        assert.ok(reasons.rows.some((row) => row.reason_code === "PERMISSION_INACTIVE"));
      });
      await context.test("unavailable reader/audit pools never yield HTTP success or a success audit", async () => {
        const audits = await successfulAudits(); const calls = acceptance.calls.protected;
        state.reader = unavailable.repository;
        assert.equal((await send("/__acceptance/staff/self", valid)).response.status, 503);
        state.reader = runtime.repository; state.writer = unavailable.auditWriter;
        assert.equal((await send("/__acceptance/staff/self", valid)).response.status, 503);
        assert.equal((await send("/__acceptance/staff/self", await bearer("unknown-http"))).response.status, 403);
        assert.equal((await send("/health/live")).response.status, 200);
        state.writer = runtime.auditWriter;
        assert.equal(acceptance.calls.protected, calls); assert.equal(await successfulAudits(), audits);
      });
      await context.test("required JWKS outage fails closed while public health stays live", async () => {
        const unavailableKeys = keySource([]);
        unavailableKeys.state.response = () => { throw new Error("synthetic private transport detail"); };
        state.verifier = new OidcAccessTokenVerifier(environment(), { fetchKeys: unavailableKeys.fetchKeys, now: () => new Date(NOW) });
        const calls = acceptance.calls.protected;
        assert.equal((await send("/__acceptance/staff/self", valid)).response.status, 503);
        assert.equal((await send("/health/live")).response.status, 200);
        assert.equal(acceptance.calls.protected, calls);
        state.verifier = verifier;
      });
    } finally {
      try { await app.close(); } finally { await Promise.all([runtime.close(), unavailable.close()]); }
    }
  }, "b3b3");
});
