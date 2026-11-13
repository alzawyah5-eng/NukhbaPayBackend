import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { Client } from "pg";
import { createSyntheticReceiptReader } from "@nukhbapay/database";
import { TrustedStaffActorBoundary, type TrustedStaffActor, type VerifiedStaffIdentity, type StaffAuthorizationRepository, type SecurityAuditWriter, type AuthorizedSyntheticReceiptQuery } from "@nukhbapay/application";
import { NOW } from "./oidc-test-issuer.js";

export async function receiptReaderAcceptance(t: TestContext, fixture: {
  admin: Client; databaseUrl: string; staff: string; other: string; tenant: string; otherTenant: string;
  key: string; digest: string; operation: string;
  identity(sub?: string): Promise<VerifiedStaffIdentity>;
  runtime: { repository: StaffAuthorizationRepository; auditWriter: SecurityAuditWriter };
}) {
  const { admin, staff, other, tenant, otherTenant } = fixture;
  const database = (await admin.query("SELECT current_database() AS name")).rows[0].name as string;
  assert.match(database, /^nukhabapay_b3b3_[0-9a-f]{32}$/);
  assert.equal(new URL(fixture.databaseUrl).pathname, "/" + database);
  const role = "nukh_receipt_" + randomUUID().replaceAll("-", "").slice(0, 20);
  assert.match(role, /^nukh_receipt_[0-9a-f]{20}$/);
  const projections = {
    iam_workflow_proposals: "operation_id,actor_staff_id,scope_key,idempotency_key,command_digest,provenance,record_kind,execution",
    iam_workflow_receipts: "operation_id,actor_staff_id,scope_key,command_digest,outcome,execution",
  };
  const url = new URL(fixture.databaseUrl); url.username = role; url.password = randomUUID();
  const config = { connectionString: url.href, expectedRole: role, expectedDatabase: database };
  const readers: Awaited<ReturnType<typeof createSyntheticReceiptReader>>[] = [];
  await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
  try {
    await admin.query(`GRANT CONNECT ON DATABASE "${database}" TO "${role}"`);
    await admin.query(`GRANT USAGE ON SCHEMA nukhabapay TO "${role}"`);
    for (const [table, columns] of Object.entries(projections)) await admin.query(`GRANT SELECT(${columns}) ON nukhabapay.${table} TO "${role}"`);
    const reader = await createSyntheticReceiptReader(config); readers.push(reader);
    let enabled = true;
    const allowed = new Set([staff + ":" + tenant, staff + ":" + otherTenant, other + ":" + tenant]);
    const policy = async (context: Parameters<import("@nukhbapay/application").SyntheticReceiptAcceptance["allows"]>[0]) => enabled &&
      allowed.has(context.principal!.staffId + ":" + context.membership?.tenantId);
    const dependencies = { ...fixture.runtime, now: () => new Date(NOW), syntheticReceipts: {
      capability: "NON_AUTHORIZED_RECEIPT_RECONCILE" as const, allows: policy, lookup: reader.lookup,
    } };
    const boundary = new TrustedStaffActorBoundary(dependencies);
    async function actor(sub = "actor-a", scope = tenant) {
      const found = await boundary.establish(await fixture.identity(sub), scope);
      assert.equal(found.allowed, true); if (!found.allowed) throw new Error("Receipt actor fixture denied"); return found.actor;
    }
    const reconcile = (value: TrustedStaffActor, operation = fixture.operation, key = fixture.key, digest = fixture.digest) => boundary.reconcileOwnReceipt(value, key, digest, operation);
    await t.test("restricted receipt reader grants only fourteen projection columns and no staff commands", async () => {
      const columns = (await admin.query("SELECT table_name,column_name FROM information_schema.column_privileges WHERE grantee=$1 ORDER BY table_name,column_name", [role])).rows;
      assert.equal(columns.length, 14);
      const direct = new Client({ connectionString: url.href, connectionTimeoutMillis: 3000 }); await direct.connect();
      try {
        for (const sql of [
          "SELECT target_staff_id FROM nukhabapay.iam_workflow_proposals", "SELECT * FROM nukhabapay.staff_users",
          "SELECT * FROM nukhabapay.security_audit_events", "SELECT * FROM nukhabapay.iam_workflow_audit_intents", "SELECT * FROM nukhabapay.iam_workflow_outbox",
          "INSERT INTO nukhabapay.iam_workflow_proposals(operation_id) VALUES('forged')",
          "UPDATE nukhabapay.iam_workflow_receipts SET outcome='SIMULATION_RECORDED'", "DELETE FROM nukhabapay.iam_workflow_receipts",
          "TRUNCATE nukhabapay.iam_workflow_receipts", "UPDATE nukhabapay.staff_users SET status='DISABLED'",
          "SELECT nukhabapay.execute_staff_command('{}'::jsonb)", "CREATE TABLE nukhabapay.receipt_escape(id int)",
        ]) await assert.rejects(() => direct.query(sql), { code: "42501" });
        assert.equal((await direct.query("SELECT operation_id FROM nukhabapay.iam_workflow_receipts")).rowCount, 0);
      } finally { await direct.end(); }
      for (const name of ["nukhabapay_runtime", "nukhabapay_importer", "nukhabapay_identity_reader", "nukhabapay_identity_writer"]) {
        for (const table of Object.keys(projections)) assert.equal((await admin.query("SELECT has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE') OR has_table_privilege($1,$2,'DELETE,TRUNCATE') AS allowed", [name, "nukhabapay." + table])).rows[0].allowed, false);
      }
    });
    await t.test("reader rejects raw UUID/JSON query tickets and actor clones by default", async () => {
      const own = await actor();
      for (const value of [{}, { actorStaffId: staff, tenantId: tenant, key: fixture.key, operationId: fixture.operation, expectedDigest: fixture.digest }, staff]) {
        assert.equal(await reader.lookup(value as AuthorizedSyntheticReceiptQuery), "UNRESOLVED");
        assert.equal((await reconcile(value as TrustedStaffActor)).allowed, false);
      }
      assert.equal((await reconcile({ ...own } as TrustedStaffActor)).allowed, false);
      enabled = false; assert.equal((await reconcile(own)).allowed, false); enabled = true;
    });
    await t.test("exact operation actor tenant key and digest are mandatory; missing records stay unresolved", async () => {
      const own = await actor();
      assert.deepEqual(await reconcile(own), { allowed: true, operationId: fixture.operation, outcome: "SIMULATION_RECORDED", execution: "NOT_AUTHORIZED" });
      for (const operation of ["0".repeat(64), "f".repeat(64), fixture.operation + "' OR true"]) assert.equal((await reconcile(own, operation)).allowed, false);
      assert.equal((await reconcile(own, fixture.operation, randomUUID())).allowed, false);
      assert.equal((await reconcile(own, fixture.operation, fixture.key, "f".repeat(64))).allowed, false);
      assert.equal((await boundary.reconcileOwnReceipt(own, fixture.key, fixture.digest)).allowed, false);
      assert.equal((await reconcile(await actor("actor-other"))).allowed, false);
      assert.equal((await reconcile(await actor("actor-a", otherTenant))).allowed, false);
    });
    await t.test("concurrent actor-scoped reconciliation is read-only and audit commits before return", async () => {
      const before = (await admin.query("SELECT count(*)::int AS n FROM nukhabapay.iam_workflow_receipts")).rows[0].n;
      const own = await actor();
      const foreignActors = [await actor("actor-other"), await actor("actor-a", otherTenant)];
      const outcomes = await Promise.all([...Array.from({ length: 8 }, () => reconcile(own)), ...foreignActors.map(value => reconcile(value))]);
      assert.ok(outcomes.slice(0, 8).every(value => value.allowed && value.operationId === fixture.operation && value.execution === "NOT_AUTHORIZED"));
      assert.ok(outcomes.slice(8).every(value => !value.allowed));
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM nukhabapay.iam_workflow_receipts")).rows[0].n, before);
      assert.ok((await admin.query("SELECT count(*)::int AS n FROM nukhabapay.security_audit_events WHERE actor_staff_id=$1 AND tenant_id=$2 AND outcome='SUCCESS'", [staff, tenant])).rows[0].n >= 8);
    });
    await t.test("held actor loses receipt access after committed authority change", async () => {
      const own = await actor();
      await admin.query("UPDATE nukhabapay.staff_users SET authz_version=authz_version+1 WHERE id=$1", [staff]);
      assert.equal((await reconcile(own)).allowed, false);
      assert.equal((await reconcile(await actor())).allowed, true);
    });
    await t.test("query capability cannot be cloned retained or replayed after one read", async () => {
      let captured: AuthorizedSyntheticReceiptQuery | undefined;
      const captureBoundary = new TrustedStaffActorBoundary({ ...dependencies, syntheticReceipts: { ...dependencies.syntheticReceipts,
        lookup: async query => { captured = query; assert.equal(await reader.lookup({ ...query } as AuthorizedSyntheticReceiptQuery), "UNRESOLVED"); return reader.lookup(query); } } });
      const own = await captureBoundary.establish(await fixture.identity(), tenant); assert.equal(own.allowed, true);
      if (own.allowed) assert.equal((await captureBoundary.reconcileOwnReceipt(own.actor, fixture.key, fixture.digest, fixture.operation)).allowed, true);
      assert.ok(captured); assert.equal(await reader.lookup(captured), "UNRESOLVED");
    });
    await t.test("pool connection loss fails closed and reconnects without leaking transaction context", async () => {
      const sessions = (await admin.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND usename=$1", [role])).rows;
      for (const session of sessions) await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid=$1 AND datname=current_database() AND usename=$2", [session.pid, role]);
      // Idle pool errors may race with checkout; failures may only deny, never disclose a foreign result.
      const own = await actor();
      let recovered = false;
      for (let i = 0; i < 3; i++) { if ((await reconcile(own)).allowed) { recovered = true; break; } }
      assert.equal(recovered, true);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 AND state LIKE 'idle in transaction%'", [role])).rows[0].n, 0);
      const closed = await createSyntheticReceiptReader(config); readers.push(closed); await closed.close();
      const closedBoundary = new TrustedStaffActorBoundary({ ...dependencies, syntheticReceipts: { ...dependencies.syntheticReceipts, lookup: closed.lookup } });
      const bound = await closedBoundary.establish(await fixture.identity(), tenant); assert.equal(bound.allowed, true);
      if (bound.allowed) assert.equal((await closedBoundary.reconcileOwnReceipt(bound.actor, fixture.key, fixture.digest, fixture.operation)).allowed, false);
    });
    await t.test("startup rejects missing excess or unavailable privileges and never prints configuration", async () => {
      await assert.rejects(() => createSyntheticReceiptReader({ ...config, connectionString: "invalid-secret-value" }), error => error instanceof Error && !error.message.includes("invalid-secret-value"));
      await admin.query(`GRANT UPDATE(outcome) ON nukhabapay.iam_workflow_receipts TO "${role}"`);
      try { await assert.rejects(() => createSyntheticReceiptReader(config), { message: "Synthetic receipt reader configuration or dependency unavailable" }); }
      finally { await admin.query(`REVOKE UPDATE(outcome) ON nukhabapay.iam_workflow_receipts FROM "${role}"`); }
      await admin.query(`REVOKE SELECT(outcome) ON nukhabapay.iam_workflow_receipts FROM "${role}"`);
      try { await assert.rejects(() => createSyntheticReceiptReader(config), { message: "Synthetic receipt reader configuration or dependency unavailable" }); }
      finally { await admin.query(`GRANT SELECT(outcome) ON nukhabapay.iam_workflow_receipts TO "${role}"`); }
      const missing = new URL(url); missing.pathname = "/nukhabapay_b3b3_" + randomUUID().replaceAll("-", "");
      await assert.rejects(() => createSyntheticReceiptReader({ ...config, connectionString: missing.href, expectedDatabase: missing.pathname.slice(1) }), { message: "Synthetic receipt reader configuration or dependency unavailable" });
      assert.equal((await reconcile(await actor())).allowed, true);
    });
    await t.test("connection killed during a blocked receipt query returns unresolved and recovers", async () => {
      const own = await actor();
      await admin.query("BEGIN"); await admin.query("LOCK TABLE nukhabapay.iam_workflow_receipts IN ACCESS EXCLUSIVE MODE");
      const pending = reconcile(own);
      try {
        let pid: number | undefined;
        for (let i = 0; i < 100; i++) {
          await admin.query("SELECT pg_stat_clear_snapshot()");
          const waiting = (await admin.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 AND state='active' AND wait_event_type='Lock'", [role])).rows[0];
          if (waiting) { pid = waiting.pid as number; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(pid, "Reader must reach the controlled database lock before disconnection");
        assert.equal((await admin.query("SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE pid=$1 AND datname=current_database() AND usename=$2", [pid, role])).rows[0].killed, true);
        assert.deepEqual(await pending, { allowed: false, reason: "UNRESOLVED", execution: "NOT_AUTHORIZED" });
      } finally { await admin.query("ROLLBACK"); await pending; }
      assert.equal((await reconcile(await actor())).allowed, true);
    });
  } finally {
    await Promise.all(readers.map(reader => reader.close()));
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename=$1", [role])).rows[0].n, 0);
    for (const [table, columns] of Object.entries(projections)) await admin.query(`REVOKE SELECT(${columns}) ON nukhabapay.${table} FROM "${role}"`);
    await admin.query(`REVOKE USAGE ON SCHEMA nukhabapay FROM "${role}"`);
    await admin.query(`REVOKE CONNECT ON DATABASE "${database}" FROM "${role}"`);
    await admin.query(`DROP ROLE "${role}"`);
  }
}
