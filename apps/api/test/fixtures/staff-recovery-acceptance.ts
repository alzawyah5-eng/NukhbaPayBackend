import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { Client } from "pg";
import { commitLossProxy } from "./commit-loss-proxy.js";

const tables = ["iam_workflow_proposals", "iam_workflow_audit_intents", "iam_workflow_receipts", "iam_workflow_outbox"];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Result = Readonly<{ state: "COMMITTED" | "NOT_COMMITTED" | "UNRESOLVED" | "CONFLICT" | "DENIED"; execution: "NOT_AUTHORIZED"; operationId?: string }>;
const result = (state: Result["state"], operationId?: string): Result => Object.freeze({ state, execution: "NOT_AUTHORIZED", ...(operationId ? { operationId } : {}) });

/** No production export, real identity adapter or staff executor: disposable artifact acceptance only. */
export async function staffRecoveryAcceptance(t: TestContext, fixture: { admin: Client; url: string; actor: string; tenant: string; otherTenant: string }) {
  const { admin, actor, tenant } = fixture;
  const all = new Set<Client>();
  const access = Object.freeze({ actor, tenant });
  // Object identity is a test-bootstrap capability, never a UUID/JSON authorization assertion.
  const allowed = (context: unknown) => context === access;
  async function connect(url = fixture.url) {
    const c = new Client({ connectionString: url, connectionTimeoutMillis: 3000, statement_timeout: 5000, query_timeout: 6000 });
    c.on("error", () => {}); // Expected injected disconnect; never log driver payloads.
    all.add(c);
    try { await c.connect(); return c; }
    catch { await close(c); throw new Error("Synthetic receipt database unavailable"); }
  }
  async function close(c: Client) { await c.end(); all.delete(c); }
  const identifier = (key: string) => hash(actor + ":" + key);
  async function begin(c: Client, key: string, wait: boolean) {
    // READ COMMITTED gets a fresh snapshot after reservation; artifacts are append-only.
    await c.query("BEGIN");
    await c.query("SELECT set_config('nukhabapay.workflow_scope',$1,true)", [tenant]);
    const lock = hash(actor + ":" + key).slice(0, 16);
    const signed = BigInt.asIntN(64, BigInt("0x" + lock)).toString();
    const row = await c.query(wait ? "SELECT pg_advisory_xact_lock($1::bigint)" : "SELECT pg_try_advisory_xact_lock($1::bigint) AS locked", [signed]);
    return wait || row.rows[0].locked === true;
  }
  async function read(c: Client, key: string, digest: string): Promise<Result> {
    const rows = await c.query(
      `SELECT r.operation_id,p.command_digest FROM nukhabapay.iam_workflow_receipts r
       JOIN nukhabapay.iam_workflow_proposals p USING(operation_id)
       WHERE p.actor_staff_id=$1 AND p.idempotency_key=$2 AND p.scope_key=$3
       AND r.actor_staff_id=$1 AND r.scope_key=$3 AND r.outcome='SIMULATION_RECORDED' AND r.execution='NOT_AUTHORIZED'`,
      [actor, key, tenant]);
    if (!rows.rowCount) return result("NOT_COMMITTED");
    if (rows.rows[0].command_digest !== digest || rows.rows[0].operation_id !== identifier(key)) return result("CONFLICT");
    return result("COMMITTED", rows.rows[0].operation_id);
  }
  async function reconcile(context: unknown, key: string, digest: string, url = fixture.url): Promise<Result> {
    if (!allowed(context)) return result("DENIED");
    let c: Client | undefined;
    try {
      c = await connect(url);
      if (!await begin(c, key, false)) { await c.query("ROLLBACK"); return result("UNRESOLVED"); }
      const receipt = await read(c, key, digest);
      await c.query("COMMIT"); return receipt;
    } catch { return result("UNRESOLVED"); }
    finally { if (c) await close(c); }
  }
  async function stage(c: Client, key: string, digest: string) {
    const id = identifier(key);
    await c.query(`INSERT INTO nukhabapay.iam_workflow_proposals(operation_id,actor_staff_id,target_staff_id,tenant_id,scope_key,idempotency_key,command_digest,operation)
      VALUES($1,$2,$2,$3,$4,$5,$6,'SUSPEND')`, [id, actor, tenant, tenant, key, digest]);
    const values = [id, actor, tenant, digest];
    await c.query("INSERT INTO nukhabapay.iam_workflow_audit_intents(operation_id,actor_staff_id,target_staff_id,scope_key,command_digest,event_name) VALUES($1,$2,$2,$3,$4,'STAFF_SUSPEND_INTENT')", values);
    await c.query("INSERT INTO nukhabapay.iam_workflow_receipts(operation_id,actor_staff_id,target_staff_id,scope_key,command_digest,outcome) VALUES($1,$2,$2,$3,$4,'SIMULATION_RECORDED')", values);
    await c.query("INSERT INTO nukhabapay.iam_workflow_outbox(operation_id,actor_staff_id,target_staff_id,scope_key,command_digest,action) VALUES($1,$2,$2,$3,$4,'NO_EXTERNAL_DELIVERY')", values);
  }
  async function acknowledge(c: Client, key: string): Promise<Result> {
    try {
      const acknowledgement = await c.query("COMMIT");
      // PostgreSQL accepts COMMIT in an aborted transaction but replies ROLLBACK.
      if (acknowledgement.command === "ROLLBACK") return result("NOT_COMMITTED");
      return acknowledgement.command === "COMMIT" ? result("COMMITTED", identifier(key)) : result("UNRESOLVED");
    }
    catch { return result("UNRESOLVED"); }
  }
  async function retry(key: string, digest: string): Promise<Result> {
    const c = await connect();
    try {
      await begin(c, key, true);
      const previous = await read(c, key, digest);
      if (previous.state !== "NOT_COMMITTED") { await c.query("COMMIT"); return previous; }
      await stage(c, key, digest); return await acknowledge(c, key);
    } catch { return result("UNRESOLVED"); }
    finally { await close(c); }
  }
  async function count(key: string, expected: number) {
    for (const table of tables) assert.equal((await admin.query(`SELECT count(*)::int AS n FROM nukhabapay.${table} WHERE operation_id=$1`, [identifier(key)])).rows[0].n, expected);
  }
  async function gone(pid: number) {
    for (let i = 0; i < 100; i++) {
      if ((await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid=$1", [pid])).rowCount === 0) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("Disconnected disposable session did not exit");
  }
  try {
    await t.test("connection lost before COMMIT rolls back; in-flight absence stays unresolved", async () => {
      const key = randomUUID(), digest = hash(key), c = await connect();
      await begin(c, key, true); await stage(c, key, digest);
      assert.deepEqual(await reconcile(access, key, digest), result("UNRESOLVED"));
      const pid = (await c.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
      // Only the known connection on the fixture's already verified disposable database.
      assert.equal((await admin.query("SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE pid=$1 AND datname=current_database()", [pid])).rows[0].killed, true);
      await gone(pid); await assert.rejects(() => c.query("COMMIT")); await close(c);
      assert.deepEqual(await reconcile(access, key, digest), result("NOT_COMMITTED")); await count(key, 0);
      assert.equal((await retry(key, digest)).state, "COMMITTED"); await count(key, 1);
    });
    for (const mode of ["before-forward", "before-ack"] as const) {
      await t.test(`lost COMMIT acknowledgement ${mode} reconciles from primary receipts`, async () => {
        const key = randomUUID(), digest = hash(key), proxy = await commitLossProxy(new URL(fixture.url));
        let c: Client | undefined;
        try {
          c = await connect(proxy.url);
          const target = (await c.query("SELECT current_database() AS name,pg_backend_pid() AS pid")).rows[0];
          assert.equal(target.name, (await admin.query("SELECT current_database() AS name")).rows[0].name);
          await begin(c, key, true); await stage(c, key, digest); proxy.arm(mode);
          // Driver sees the same failure whether COMMIT reached PostgreSQL or not.
          const immediate = await acknowledge(c, key);
          assert.deepEqual(immediate, result("UNRESOLVED")); assert.equal(proxy.cut, true);
          await gone(target.pid); await close(c); c = undefined;
          assert.equal((await reconcile(access, key, digest)).state, mode === "before-ack" ? "COMMITTED" : "NOT_COMMITTED");
          await count(key, mode === "before-ack" ? 1 : 0);
          const retries = await Promise.all([retry(key, digest), retry(key, digest), retry(key, digest)]);
          assert.ok(retries.every(r => r.state === "COMMITTED" && r.execution === "NOT_AUTHORIZED"));
          assert.equal(new Set(retries.map(r => r.operationId)).size, 1); await count(key, 1);
          assert.deepEqual(await retry(key, hash("changed")), result("CONFLICT")); await count(key, 1);
        } finally { if (c) await close(c); await proxy.close(); }
      });
    }
    await t.test("confirmed COMMIT survives subsequent disconnect and rejects foreign receipt contexts", async () => {
      const key = randomUUID(), digest = hash(key), c = await connect();
      await begin(c, key, true); await stage(c, key, digest); await c.query("COMMIT");
      const pid = (await c.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
      assert.equal((await admin.query("SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE pid=$1 AND datname=current_database()", [pid])).rows[0].killed, true);
      await gone(pid); await assert.rejects(() => c.query("SELECT 1"));
      await close(c);
      assert.deepEqual(await reconcile(access, key, digest), result("COMMITTED", identifier(key)));
      for (const context of [{ actor: randomUUID(), tenant }, { actor, tenant: fixture.otherTenant }, { ...access }, undefined]) {
        assert.deepEqual(await reconcile(context, key, digest), result("DENIED"));
      }
      await count(key, 1);
      // Wrong actors also cannot retrieve this receipt through the parameterized query.
      const other = await connect();
      try {
        await begin(other, key, false);
        assert.equal((await other.query("SELECT r.operation_id FROM nukhabapay.iam_workflow_receipts r JOIN nukhabapay.iam_workflow_proposals p USING(operation_id) WHERE p.actor_staff_id=$1 AND p.idempotency_key=$2", [randomUUID(), key])).rowCount, 0);
        await other.query("ROLLBACK");
      } finally { await close(other); }
    });
    await t.test("unavailable receipt database never means not committed and leaks no receipt", async () => {
      const key = randomUUID(), digest = hash(key); await retry(key, digest);
      const unavailable = new URL(fixture.url); unavailable.pathname = "/nukhabapay_missing_" + randomUUID().replaceAll("-", "");
      assert.deepEqual(await reconcile(access, key, digest, unavailable.href), result("UNRESOLVED"));
      assert.equal((await reconcile(access, key, digest)).state, "COMMITTED"); await count(key, 1);
    });
    await t.test("failed transactions are discarded and new connections reconcile without idle transactions", async () => {
      const key = randomUUID(), digest = hash(key), c = await connect();
      await begin(c, key, true); await stage(c, key, digest);
      await assert.rejects(() => c.query("SELECT 1/0"), { code: "22012" });
      await close(c);
      assert.equal((await reconcile(access, key, digest)).state, "NOT_COMMITTED"); await count(key, 0);
      assert.equal((await retry(key, digest)).state, "COMMITTED"); await count(key, 1);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 AND state LIKE 'idle in transaction%'", [new URL(fixture.url).username])).rows[0].n, 0);
    });
    await t.test("COMMIT returning PostgreSQL ROLLBACK never produces a committed receipt", async () => {
      const key = randomUUID(), digest = hash(key), c = await connect();
      try {
        await begin(c, key, true); await stage(c, key, digest);
        await assert.rejects(() => c.query("SELECT 1/0"), { code: "22012" });
        assert.deepEqual(await acknowledge(c, key), result("NOT_COMMITTED"));
      } finally { await close(c); }
      assert.deepEqual(await reconcile(access, key, digest), result("NOT_COMMITTED")); await count(key, 0);
    });
  } finally { await Promise.all([...all].map(c => c.end())); }
}
