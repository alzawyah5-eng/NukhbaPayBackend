import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { Client } from "pg";
import { createIdentityRuntime } from "@nukhbapay/database/identity-runtime";
import { TrustedStaffActorBoundary, type TrustedStaffActor, type StaffApprovalObservation, type ApprovalRequestSnapshot, type SyntheticReceiptAcceptance } from "@nukhbapay/application";
import { OidcAccessTokenVerifier } from "../../src/modules/identity/oidc-access-token.verifier.js";
import { claims, environment, ISSUER, keySource, NOW, signingKey } from "./oidc-test-issuer.js";
import { receiptReaderAcceptance } from "./receipt-reader-acceptance.js";
import { durableRequestAcceptance } from "./durable-request-acceptance.js";

export async function trustedActorAcceptance(t: TestContext, fixture: {
  admin: Client; url: string; actor: string; tenant: string; otherTenant: string;
  runtimeEnv: Readonly<Record<string, string>>;
}) {
  const { admin, actor: staff, tenant, otherTenant } = fixture;
  const other = randomUUID(), requester = randomUUID(), membership = randomUUID(), grant = randomUUID();
  await admin.query("INSERT INTO nukhabapay.staff_users(id,display_name,contact_email,status) VALUES($1,'Other synthetic','other@example.invalid','ACTIVE')", [other]);
  for (const [id, sub] of [[staff, "actor-a"], [staff, "actor-alternate"], [other, "actor-other"]]) await admin.query("INSERT INTO nukhabapay.staff_identities(id,staff_id,issuer,subject,status) VALUES($1,$2,$3,$4,'ACTIVE')", [randomUUID(), id, ISSUER, sub]);
  await admin.query("INSERT INTO nukhabapay.staff_memberships(id,staff_id,tenant_id,status) VALUES($1,$2,$3,'ACTIVE')", [membership, staff, tenant]);
  await admin.query("INSERT INTO nukhabapay.staff_memberships(id,staff_id,tenant_id,status) VALUES($1,$2,$3,'ACTIVE'),($4,$5,$6,'ACTIVE')", [randomUUID(), other, tenant, randomUUID(), staff, otherTenant]);
  await admin.query("INSERT INTO nukhabapay.tenant_role_grants(id,membership_id,tenant_id,role_code,granted_at,grant_source,evidence_reference) VALUES($1,$2,$3,'CATALOG_OPERATOR','2025-01-01','TEST','synthetic.actor')", [grant, membership, tenant]);
  await admin.query("INSERT INTO nukhabapay.platform_role_grants(id,staff_id,role_code,granted_at,grant_source,evidence_reference) VALUES($1,$2,'SECURITY_ADMIN','2025-01-01','TEST','synthetic.actor')", [randomUUID(), staff]);
  const runtime = await createIdentityRuntime(fixture.runtimeEnv);
  const key = await signingKey("actor-key"), keys = keySource([key.publicJwk]);
  const verifier = new OidcAccessTokenVerifier(environment(), { fetchKeys: keys.fetchKeys, now: () => new Date(NOW) });
  const identity = async (sub = "actor-a", extra = {}) => verifier.verify(await key.sign(claims({ sub, ...extra })));
  const digest = createHash("sha256").update("actor receipt").digest("hex"), receiptKey = randomUUID(), operation = createHash("sha256").update(receiptKey).digest("hex");
  await admin.query("BEGIN");
  try {
    await admin.query("INSERT INTO nukhabapay.iam_workflow_proposals(operation_id,actor_staff_id,target_staff_id,tenant_id,scope_key,idempotency_key,command_digest,operation) VALUES($1,$2,$2,$3,$4,$5,$6,'SUSPEND')", [operation, staff, tenant, tenant, receiptKey, digest]);
    for (const [table, column, value] of [["iam_workflow_audit_intents", "event_name", "STAFF_SUSPEND_INTENT"], ["iam_workflow_receipts", "outcome", "SIMULATION_RECORDED"], ["iam_workflow_outbox", "action", "NO_EXTERNAL_DELIVERY"]]) await admin.query(`INSERT INTO nukhabapay.${table}(operation_id,actor_staff_id,target_staff_id,scope_key,command_digest,${column}) VALUES($1,$2,$2,$3,$4,$5)`, [operation, staff, tenant, digest, value]);
    await admin.query("COMMIT");
  } catch (error) { await admin.query("ROLLBACK"); throw error; }
  let accessEnabled = true, lookupCalls = 0;
  const port: SyntheticReceiptAcceptance = {
    capability: "NON_AUTHORIZED_RECEIPT_RECONCILE",
    allows: async context => accessEnabled && context.principal?.staffId === staff && context.membership?.tenantId === tenant &&
      context.membership.roleGrants.some(g => g.roleCode === "CATALOG_OPERATOR" && g.revokedAt === null && Date.parse(g.grantedAt) <= NOW && (g.expiresAt === null || Date.parse(g.expiresAt) > NOW)),
    lookup: async binding => {
      lookupCalls++;
      const c = new Client({ connectionString: fixture.url, connectionTimeoutMillis: 3000, statement_timeout: 3000 });
      await c.connect();
      try {
        await c.query("BEGIN READ ONLY"); await c.query("SELECT set_config('nukhabapay.workflow_scope',$1,true)", [binding.tenantId]);
        const row = (await c.query(`SELECT r.operation_id AS "operationId",r.actor_staff_id AS "actorStaffId",r.scope_key AS "tenantId",p.idempotency_key AS key,r.command_digest AS digest,r.outcome,r.execution
          FROM nukhabapay.iam_workflow_receipts r JOIN nukhabapay.iam_workflow_proposals p USING(operation_id)
          WHERE r.actor_staff_id=$1 AND r.scope_key=$2 AND p.actor_staff_id=$1 AND p.scope_key=$2 AND p.idempotency_key=$3`, [binding.actorStaffId, binding.tenantId, binding.key])).rows[0] ?? null;
        await c.query("COMMIT"); return row;
      } finally { await c.end(); }
    },
  };
  let request: ApprovalRequestSnapshot = Object.freeze({ id: randomUUID(), digest, version: "1", policyVersion: "staff-lifecycle-v1", requesterStaffId: requester,
    beneficiaryStaffId: other, tenantId: null, expiresAt: new Date(NOW + 60000).toISOString(), permission: "platform.access.approve" });
  const dependencies = { ...runtime, now: () => new Date(NOW), requests: { find: async (id: string) => id === request.id ? request : null }, syntheticReceipts: port };
  const boundary = new TrustedStaffActorBoundary(dependencies);
  async function establish(sub = "actor-a", scope: string | undefined = tenant): Promise<TrustedStaffActor> {
    const resolved = await boundary.establish(await identity(sub), scope); assert.equal(resolved.allowed, true);
    if (!resolved.allowed) throw new Error("Actor fixture rejected"); return resolved.actor;
  }
  try {
    await t.test("actor provenance rejects JSON, UUIDs, cloned actors and another boundary", async () => {
      const actor = await establish();
      for (const forged of [{}, { staffId: staff, issuer: ISSUER, subject: "actor-a", mfa: true }, JSON.parse(JSON.stringify(actor)), staff]) {
        assert.equal((await boundary.reconcileOwnReceipt(forged as TrustedStaffActor, receiptKey, digest)).allowed, false);
      }
      assert.equal((await boundary.establish({ issuer: ISSUER, subject: "actor-a" } as never, tenant)).allowed, false);
      assert.equal((await new TrustedStaffActorBoundary(dependencies).reconcileOwnReceipt(actor, receiptKey, digest)).allowed, false);
      assert.equal(Object.keys(actor).length, 0); assert.ok(Object.isFrozen(actor));
    });
    await t.test("explicit synthetic receipt policy returns only own receipt and commits real audit", async () => {
      const actor = await establish(), result = await boundary.reconcileOwnReceipt(actor, receiptKey, digest);
      assert.deepEqual(result, { allowed: true, operationId: operation, outcome: "SIMULATION_RECORDED", execution: "NOT_AUTHORIZED" });
      assert.ok((await admin.query("SELECT 1 FROM nukhabapay.security_audit_events WHERE actor_staff_id=$1 AND tenant_id=$2 AND outcome='SUCCESS'", [staff, tenant])).rowCount! > 0);
      assert.equal((await boundary.reconcileOwnReceipt(actor, receiptKey, "f".repeat(64))).allowed, false);
      accessEnabled = false;
      assert.equal((await boundary.reconcileOwnReceipt(actor, receiptKey, digest)).allowed, false); accessEnabled = true;
      const noPolicy = new TrustedStaffActorBoundary({ ...runtime, now: dependencies.now });
      const resolved = await noPolicy.establish(await identity(), tenant); assert.equal(resolved.allowed, true);
      if (resolved.allowed) assert.equal((await noPolicy.reconcileOwnReceipt(resolved.actor, receiptKey, digest)).allowed, false);
    });
    await t.test("exact binding, other person and foreign tenant cannot access actor receipts", async () => {
      for (const sub of ["ACTOR-A", "unknown"]) assert.equal((await boundary.establish(await identity(sub), tenant)).allowed, false);
      for (const actor of [await establish("actor-other", tenant), await establish("actor-a", otherTenant)]) {
        const before = lookupCalls; assert.equal((await boundary.reconcileOwnReceipt(actor, receiptKey, digest)).allowed, false); assert.equal(lookupCalls, before);
      }
      const otherActor = await boundary.establish(await identity("actor-other")); // Platform actor cannot read tenant receipts.
      assert.equal(otherActor.allowed, true);
      const before = lookupCalls;
      if (otherActor.allowed) assert.equal((await boundary.reconcileOwnReceipt(otherActor.actor, receiptKey, digest)).allowed, false);
      assert.equal(lookupCalls, before);
    });
    await t.test("suspension, revoked membership and stale grants invalidate held actors", async () => {
      for (const [table, id, change, restore] of [["staff_users", staff, "status='SUSPENDED'", "status='ACTIVE'"], ["staff_memberships", membership, "status='REVOKED'", "status='ACTIVE'"], ["tenant_role_grants", grant, "revoked_at='2026-01-01'", "revoked_at=NULL"]]) {
        const actor = await establish(); await admin.query(`UPDATE nukhabapay.${table} SET ${change} WHERE id=$1`, [id]);
        try { assert.equal((await boundary.reconcileOwnReceipt(actor, receiptKey, digest)).allowed, false); }
        finally { await admin.query(`UPDATE nukhabapay.${table} SET ${restore} WHERE id=$1`, [id]); }
      }
    });
    await t.test("independent verified observations bind immutable request but never approve with fake MFA", async () => {
      const platform = await boundary.establish(await identity("actor-a", { mfa: true, amr: ["mfa"], acr: "strong" })); assert.equal(platform.allowed, true);
      if (!platform.allowed) return;
      const first = await boundary.inspectApproval(platform.actor, request.id);
      assert.equal(first.allowed, false); assert.equal(first.reason, "ASSURANCE_AND_PERMISSION_BLOCKED");
      assert.ok("observation" in first);
      if (!("observation" in first)) throw new Error("Missing verified observation");
      const observation = first.observation as StaffApprovalObservation;
      assert.ok(Object.isFrozen(observation)); assert.equal(observation.acceptedApproval, false); assert.equal(observation.assurance, "not-established");
      const alternate = await boundary.establish(await identity("actor-alternate")); assert.equal(alternate.allowed, true);
      if (alternate.allowed) assert.equal((await boundary.inspectApproval(alternate.actor, request.id, [observation])).reason, "DUPLICATE_PERSON");
      assert.equal((await boundary.inspectApproval(platform.actor, request.id, [{ ...observation } as StaffApprovalObservation])).reason, "UNTRUSTED_PROVENANCE");
    });
    await t.test("substituted receipt and suspension during lookup cannot disclose a result", async () => {
      const substituted = new TrustedStaffActorBoundary({ ...dependencies, syntheticReceipts: { ...port,
        lookup: async binding => { const row = await port.lookup(binding); return row && row !== "UNRESOLVED" ? { ...row, actorStaffId: other } : row; } } });
      const first = await substituted.establish(await identity(), tenant); assert.equal(first.allowed, true);
      if (first.allowed) assert.equal((await substituted.reconcileOwnReceipt(first.actor, receiptKey, digest)).allowed, false);
      const racing = new TrustedStaffActorBoundary({ ...dependencies, syntheticReceipts: { ...port,
        lookup: async binding => { const row = await port.lookup(binding); await admin.query("UPDATE nukhabapay.staff_users SET status='SUSPENDED' WHERE id=$1", [staff]); return row; } } });
      const second = await racing.establish(await identity(), tenant); assert.equal(second.allowed, true);
      try { if (second.allowed) assert.equal((await racing.reconcileOwnReceipt(second.actor, receiptKey, digest)).allowed, false); }
      finally { await admin.query("UPDATE nukhabapay.staff_users SET status='ACTIVE' WHERE id=$1", [staff]); }
    });
    await t.test("self, beneficiary, stale request, missing and revoked approval authority deny", async () => {
      const actor = (await boundary.establish(await identity())); assert.equal(actor.allowed, true); if (!actor.allowed) return;
      const original = request;
      for (const [patch, reason] of [[{ requesterStaffId: staff }, "SELF_APPROVAL"], [{ beneficiaryStaffId: staff }, "BENEFICIARY_APPROVAL"], [{ tenantId: tenant }, "TENANT_MISMATCH"], [{ expiresAt: new Date(NOW).toISOString() }, "STALE_REQUEST"], [{ policyVersion: "forged" }, "STALE_REQUEST"]] as const) {
        request = Object.freeze({ ...original, ...patch }); assert.equal((await boundary.inspectApproval(actor.actor, request.id)).reason, reason);
      }
      request = original;
      const before = await boundary.establish(await identity()); assert.equal(before.allowed, true);
      await admin.query("UPDATE nukhabapay.platform_role_grants SET revoked_at='2026-01-01' WHERE staff_id=$1", [staff]);
      try {
        if (before.allowed) assert.equal((await boundary.inspectApproval(before.actor, request.id)).reason, "STALE_AUTHORITY");
        const fresh = await boundary.establish(await identity()); assert.equal(fresh.allowed, true);
        if (fresh.allowed) assert.equal((await boundary.inspectApproval(fresh.actor, request.id)).reason, "GRANT_INACTIVE");
      } finally { await admin.query("UPDATE nukhabapay.platform_role_grants SET revoked_at=NULL WHERE staff_id=$1", [staff]); }
    });
    await receiptReaderAcceptance(t, { admin, databaseUrl: fixture.url, staff, other, tenant, otherTenant,
      key: receiptKey, digest, operation, identity, runtime });
    await durableRequestAcceptance(t, {admin,databaseUrl:fixture.url,staff,other,tenant,otherTenant,identity,runtime});
    await t.test("audit failure and authorization database failure cannot disclose receipts", async () => {
      const broken = new TrustedStaffActorBoundary({ ...dependencies, auditWriter: { appendSecurityAuditEvents: async () => { throw new Error("synthetic unavailable"); } } });
      const actor = await broken.establish(await identity(), tenant); assert.equal(actor.allowed, true);
      if (actor.allowed) assert.deepEqual(await broken.reconcileOwnReceipt(actor.actor, receiptKey, digest), { allowed: false, reason: "DEPENDENCY_UNAVAILABLE", execution: "NOT_AUTHORIZED" });
      const held = await establish(); await runtime.close(); assert.equal((await boundary.reconcileOwnReceipt(held, receiptKey, digest)).allowed, false);
    });
  } finally { await runtime.close(); }
}
