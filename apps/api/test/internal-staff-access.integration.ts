import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { createIdentityRuntime } from "@nukhbapay/database/identity-runtime";
import type { InternalStaffRequest } from "@nukhbapay/application";
import { readAuthorizedStaffSelf } from "@nukhbapay/application";
import type { VerifiedStaffIdentity } from "@nukhbapay/application/verified-identity";
import { OidcAccessTokenVerifier } from "../src/modules/identity/oidc-access-token.verifier.js";
import { verifyAndReadStaffSelf } from "../src/modules/identity/internal-staff-access.js";
import { claims, environment, ISSUER, keySource, NOW, signingKey } from "./fixtures/oidc-test-issuer.js";
import { withDisposableIamDatabase } from "./fixtures/disposable-iam-database.js";

test("verified-token to restricted IAM authorization works only on its disposable target", async (context) => {
  await withDisposableIamDatabase(async (fixture) => {
    const database = fixture.fixtureClient;
    const tenantA = randomUUID(); const tenantB = randomUUID();
    const active = randomUUID(); const suspended = randomUUID(); const disabled = randomUUID();
    const memberA = randomUUID(); const memberB = randomUUID(); const grantId = randomUUID();
    await database.query("INSERT INTO nukhabapay.tenants(id,tenant_key) VALUES($1,'synthetic-a'),($2,'synthetic-b')", [tenantA, tenantB]);
    await database.query(
      `INSERT INTO nukhabapay.staff_users(id,display_name,contact_email,status) VALUES
       ($1,'Synthetic Active','active@example.invalid','ACTIVE'),
       ($2,'Synthetic Suspended','suspended@example.invalid','SUSPENDED'),
       ($3,'Synthetic Disabled','disabled@example.invalid','DISABLED')`, [active, suspended, disabled],
    );
    for (const [staff, subject, status] of [
      [active, "active-subject", "ACTIVE"], [suspended, "suspended-subject", "ACTIVE"],
      [disabled, "disabled-subject", "ACTIVE"], [active, "disabled-binding", "DISABLED"],
    ]) await database.query(
      "INSERT INTO nukhabapay.staff_identities(id,staff_id,issuer,subject,status) VALUES($1,$2,$3,$4,$5)",
      [randomUUID(), staff, ISSUER, subject, status],
    );
    await database.query(
      "INSERT INTO nukhabapay.staff_memberships(id,staff_id,tenant_id,status) VALUES($1,$2,$3,'ACTIVE'),($4,$2,$5,'REVOKED')",
      [memberA, active, tenantA, memberB, tenantB],
    );
    await database.query(
      `INSERT INTO nukhabapay.tenant_role_grants(id,membership_id,tenant_id,role_code,granted_at,grant_source,evidence_reference)
       VALUES($1,$2,$3,'CATALOG_OPERATOR','2025-01-01T00:00:00Z','TEST','brick3b2.synthetic')`, [grantId, memberA, tenantA],
    );
    await database.query(
      `INSERT INTO nukhabapay.platform_role_grants(id,staff_id,role_code,granted_at,grant_source,evidence_reference)
       VALUES($1,$2,'GOVERNANCE_OWNER','2025-01-01T00:00:00Z','TEST','brick3b2.synthetic')`, [randomUUID(), active],
    );
    const key = await signingKey("integration-key");
    const source = keySource([key.publicJwk]);
    const verifier = new OidcAccessTokenVerifier(environment(), { fetchKeys: source.fetchKeys, now: () => new Date(NOW) });
    const runtime = await createIdentityRuntime(fixture.runtimeEnv);
    const closers = [runtime];
    const dependencies = { ...runtime, verifier, now: () => new Date(NOW) };
    const request = (overrides: Partial<InternalStaffRequest> = {}): InternalStaffRequest => ({
      permissionCode: "staff.self.read", scope: "SELF", requestId: randomUUID(), ...overrides,
    });
    const headers = async (subject = "active-subject"): Promise<readonly string[]> =>
      ["Authorization", "Bearer " + await key.sign(claims({ sub: subject }))];
    try {
      await context.test("IAM initializes with only restricted settings and an active verified identity yields audited self data", async () => {
        assert.equal(Object.keys(fixture.runtimeEnv).some((name) => /MIGRATION|IMPORT|TEST_ADMIN|DB_RUNTIME_URL/.test(name)), false);
        const input = request({ tenantId: tenantA, objectTenantId: tenantA });
        const result = await verifyAndReadStaffSelf(dependencies, await headers(), input);
        assert.equal(result.allowed, true);
        if (result.allowed) {
          assert.equal(result.staff.staffId, active);
          assert.equal(result.staff.membership?.membershipId, memberA);
          assert.equal(result.staff.membership?.tenantId, tenantA);
          assert.deepEqual(Object.keys(result.staff).sort(), ["authzVersion", "membership", "staffId"]);
        }
        const audit = await database.query("SELECT outcome,actor_staff_id,tenant_id FROM nukhabapay.security_audit_events WHERE request_id=$1", [input.requestId]);
        assert.equal(audit.rows[0].outcome, "SUCCESS");
        assert.equal(audit.rows[0].actor_staff_id, active);
        assert.equal(audit.rows[0].tenant_id, tenantA);
      });

      await context.test("unknown, case-mismatched, suspended, disabled staff and disabled bindings deny with no enrollment", async () => {
        const before = (await database.query("SELECT count(*)::int AS total FROM nukhabapay.staff_users")).rows[0].total;
        for (const subject of ["unknown-subject", "ACTIVE-SUBJECT", "suspended-subject", "disabled-subject", "disabled-binding"]) {
          const result = await verifyAndReadStaffSelf(dependencies, await headers(subject), request());
          assert.equal(result.allowed, false);
          assert.equal(result.auditRecorded, true);
        }
        const otherIssuer = "https://other.synthetic.invalid/";
        const otherVerifier = new OidcAccessTokenVerifier(environment({
          IDENTITY_ISSUER_URL: otherIssuer, IDENTITY_JWKS_URL: otherIssuer + ".well-known/jwks.json",
        }), {
          now: () => new Date(NOW),
          fetchKeys: async () => new Response(JSON.stringify({ keys: [key.publicJwk] }), { headers: { "content-type": "application/json" } }),
        });
        const otherToken = await key.sign(claims({ sub: "active-subject", iss: otherIssuer }));
        const result = await verifyAndReadStaffSelf({ ...dependencies, verifier: otherVerifier }, ["Authorization", "Bearer " + otherToken], request());
        assert.equal(result.allowed, false);
        assert.equal((await database.query("SELECT count(*)::int AS total FROM nukhabapay.staff_users")).rows[0].total, before);
      });

      await context.test("inactive, revoked and absent membership deny scoped self reads; object cross-tenant access denies", async () => {
        for (const tenant of [tenantB, randomUUID()]) {
          const result = await verifyAndReadStaffSelf(dependencies, await headers(), request({ tenantId: tenant, objectTenantId: tenant }));
          assert.equal(result.allowed, false);
          if (!result.allowed) assert.equal(result.reason, "MEMBERSHIP_NOT_ACTIVE");
        }
        await database.query("UPDATE nukhabapay.staff_memberships SET status='SUSPENDED' WHERE id=$1", [memberA]);
        assert.equal((await verifyAndReadStaffSelf(dependencies, await headers(), request({ tenantId: tenantA, objectTenantId: tenantA }))).allowed, false);
        await database.query("UPDATE nukhabapay.staff_memberships SET status='ACTIVE' WHERE id=$1", [memberA]);
        const cross = await verifyAndReadStaffSelf(dependencies, await headers(), request({ tenantId: tenantA, objectTenantId: tenantB }));
        assert.equal(cross.allowed, false);
        if (!cross.allowed) assert.equal(cross.reason, "TENANT_MISMATCH");
      });

      await context.test("expired/revoked grants, missing permission and all reserved tenant permissions remain denied", async () => {
        const tenantRequest = request({ permissionCode: "catalog.read", scope: "TENANT", tenantId: tenantA, objectTenantId: tenantA });
        for (const lifecycle of ["expires_at='2026-01-01T00:00:00Z'", "expires_at=NULL,revoked_at='2026-01-01T00:00:00Z'"]) {
          await database.query(`UPDATE nukhabapay.tenant_role_grants SET ${lifecycle} WHERE id=$1`, [grantId]);
          const result = await verifyAndReadStaffSelf(dependencies, await headers(), tenantRequest);
          assert.equal(result.allowed, false);
          if (!result.allowed) assert.equal(result.reason, "GRANT_INACTIVE");
        }
        await database.query("UPDATE nukhabapay.tenant_role_grants SET expires_at=NULL,revoked_at=NULL WHERE id=$1", [grantId]);
        const reserved = await verifyAndReadStaffSelf(dependencies, await headers(), tenantRequest);
        assert.equal(reserved.allowed, false);
        if (!reserved.allowed) assert.equal(reserved.reason, "PERMISSION_INACTIVE");
        const missing = request(); delete (missing as { permissionCode?: string }).permissionCode;
        assert.equal((await verifyAndReadStaffSelf(dependencies, await headers(), missing)).allowed, false);
      });

      await context.test("platform grants never substitute for tenant grants", async () => {
        await database.query("UPDATE nukhabapay.tenant_role_grants SET revoked_at='2026-01-01T00:00:00Z' WHERE id=$1", [grantId]);
        const result = await verifyAndReadStaffSelf(dependencies, await headers(), request({
          permissionCode: "catalog.read", scope: "TENANT", tenantId: tenantA, objectTenantId: tenantA,
        }));
        assert.equal(result.allowed, false);
        if (!result.allowed) assert.equal(result.reason, "GRANT_INACTIVE");
        await database.query("UPDATE nukhabapay.tenant_role_grants SET revoked_at=NULL WHERE id=$1", [grantId]);
      });

      await context.test("committed suspension is visible with the very same bearer credential and no positive cache", async () => {
        const credential = await headers();
        assert.equal((await verifyAndReadStaffSelf(dependencies, credential, request())).allowed, true);
        await database.query("UPDATE nukhabapay.staff_users SET status='SUSPENDED' WHERE id=$1", [active]);
        assert.equal((await verifyAndReadStaffSelf(dependencies, credential, request())).allowed, false);
        await database.query("UPDATE nukhabapay.staff_users SET status='ACTIVE' WHERE id=$1", [active]);
      });

      await context.test("plain objects, JSON clones, and invalid tokens cannot be used as verified identity", async () => {
        const identity = await verifier.verify(await key.sign(claims({ sub: "active-subject" })));
        const clone = JSON.parse(JSON.stringify(identity)) as VerifiedStaffIdentity;
        const result = await readAuthorizedStaffSelf(dependencies, clone, request());
        assert.equal(result.allowed, false);
        await assert.rejects(() => verifyAndReadStaffSelf(dependencies, ["Authorization", "Bearer forged.token.value"], request()), { code: "INVALID_TOKEN" });
      });

      await context.test("reader and writer unavailability fail closed and cannot return successful self data", async () => {
        const unavailable = await createIdentityRuntime(fixture.runtimeEnv); closers.push(unavailable);
        await unavailable.close();
        const credential = await headers();
        await assert.rejects(() => verifyAndReadStaffSelf({ ...dependencies, repository: unavailable.repository }, credential, request()),
          { code: "IDENTITY_UNAVAILABLE", message: "Staff authorization dependency unavailable" });
        const failedAuditRequest = request();
        await assert.rejects(() => verifyAndReadStaffSelf({ ...dependencies, auditWriter: unavailable.auditWriter }, credential, failedAuditRequest),
          { code: "AUDIT_UNAVAILABLE", message: "Staff authorization dependency unavailable" });
        assert.equal((await database.query("SELECT count(*)::int AS total FROM nukhabapay.security_audit_events WHERE request_id=$1", [failedAuditRequest.requestId])).rows[0].total, 0);
        const unknown = await headers("unknown-subject");
        const denied = await verifyAndReadStaffSelf({ ...dependencies, auditWriter: unavailable.auditWriter }, unknown, request());
        assert.deepEqual(denied, { allowed: false, reason: "IDENTITY_NOT_FOUND", auditRecorded: false });
      });

      await context.test("catalogue IAM denial, importer restrictions, forced RLS and pooled context remain intact", async () => {
        const iamTables = ["staff_users", "staff_identities", "staff_memberships", "iam_roles", "iam_permissions", "iam_role_permissions", "platform_role_grants", "tenant_role_grants", "security_audit_events"];
        for (const connectionString of [fixture.runtimeUrl, fixture.importUrl]) {
          const client = new Client({ connectionString }); await client.connect();
          try {
            for (const table of iamTables) await assert.rejects(() => client.query(`SELECT * FROM nukhabapay.${table} WHERE false`), { code: "42501" });
            const rights = await client.query(
              "SELECT current_user AS role,has_table_privilege(current_user,'nukhabapay.provider_offers','DELETE') AS can_delete,has_any_column_privilege(current_user,'nukhabapay.products','UPDATE') AS can_update",
            );
            assert.equal(rights.rows[0].can_delete, false);
            assert.equal(rights.rows[0].can_update, false);
            const deniedCode = rights.rows[0].role === "nukhabapay_runtime" ? "25006" : "42501";
            await assert.rejects(() => client.query("DELETE FROM nukhabapay.provider_offers WHERE false"), { code: deniedCode });
            await assert.rejects(() => client.query("UPDATE nukhabapay.products SET brand=brand WHERE false"), { code: deniedCode });
          } finally { await client.end(); }
        }
        const reader = new Client({ connectionString: fixture.runtimeEnv["DB_IDENTITY_READER_URL"] });
        const writer = new Client({ connectionString: fixture.runtimeEnv["DB_IDENTITY_WRITER_URL"] });
        await reader.connect(); await writer.connect();
        try {
          assert.equal((await reader.query("SELECT id FROM nukhabapay.staff_memberships")).rowCount, 0);
          await assert.rejects(() => reader.query("SELECT contact_email FROM nukhabapay.staff_users"), { code: "42501" });
          await assert.rejects(() => writer.query("SELECT request_id FROM nukhabapay.security_audit_events"), { code: "42501" });
          await assert.rejects(() => writer.query("UPDATE nukhabapay.staff_users SET status=status WHERE false"), { code: "42501" });
          const rls = await reader.query("SELECT relforcerowsecurity FROM pg_class WHERE oid=ANY($1::regclass[])", [["nukhabapay.staff_memberships", "nukhabapay.tenant_role_grants", "nukhabapay.security_audit_events"]]);
          assert.equal(rls.rowCount, 3);
          assert.ok(rls.rows.every((row: { relforcerowsecurity: boolean }) => row.relforcerowsecurity));
          const catalog = await reader.query("SELECT has_table_privilege('nukhabapay_importer','nukhabapay.provider_offers','INSERT') AS can_insert,has_column_privilege('nukhabapay_importer','nukhabapay.provider_snapshots','status','UPDATE') AS can_complete");
          assert.equal(catalog.rows[0].can_insert, true); assert.equal(catalog.rows[0].can_complete, true);
        } finally { await reader.end(); await writer.end(); }
      });
    } finally { await Promise.all(closers.map((runtime) => runtime.close())); }
  });
});
