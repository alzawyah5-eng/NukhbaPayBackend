import { Pool, type PoolClient } from "pg";
import { consumeAuthorizedSyntheticReceiptQuery, type AuthorizedSyntheticReceiptQuery, type NonAuthorizedReceiptRow } from "@nukhbapay/application";

/** Local synthetic acceptance only. Never registered by API or IAM runtime startup. */
export async function createSyntheticReceiptReader(input: Readonly<{
  connectionString: string; expectedRole: string; expectedDatabase: string;
}>) {
  let pool: Pool | undefined;
  const failedClients = new WeakSet<PoolClient>();
  try {
    const url = new URL(input.connectionString);
    if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || Number(url.port || 5432) !== 5432 ||
        url.search || url.hash || !url.password || decodeURIComponent(url.username) !== input.expectedRole ||
        !/^nukh_receipt_[0-9a-f]{20}$/.test(input.expectedRole) ||
        !/^nukhabapay_b3b3_[0-9a-f]{32}$/.test(input.expectedDatabase) || url.pathname !== "/" + input.expectedDatabase) throw new Error();
    pool = new Pool({ connectionString: url.href, max: 2, connectionTimeoutMillis: 3000, idleTimeoutMillis: 1000,
      statement_timeout: 3000, query_timeout: 4000, idle_in_transaction_session_timeout: 5000, allowExitOnIdle: true });
    pool.on("error", () => {}); // Idle connection failure is sanitized; next lookup reconnects or fails closed.
    // pg-pool moves its idle error listener on checkout/removal. Keep a lifetime
    // client listener so late socket errors cannot escape as uncaught events.
    pool.on("connect", client => client.on("error", () => { failedClients.add(client); }));
    const login = (await pool.query(`SELECT current_database() AS database,current_user AS name,
      rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls,
      EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS membership
      FROM pg_roles r WHERE rolname=current_user`)).rows[0];
    if (login?.database !== input.expectedDatabase || login.name !== input.expectedRole ||
        [login.rolsuper, login.rolcreatedb, login.rolcreaterole, login.rolinherit, login.rolbypassrls, login.membership].some(value => value !== false)) throw new Error();
    const rights = (await pool.query(`SELECT
      has_schema_privilege(current_user,'nukhabapay','CREATE') AS schema_create,
      has_database_privilege(current_user,current_database(),'CREATE') AS database_create,
      has_database_privilege(current_user,current_database(),'TEMP') AS database_temp,
      has_function_privilege(current_user,'nukhabapay.execute_staff_command(jsonb)','EXECUTE') AS command,
      EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attnum>0 AND NOT a.attisdropped AND
        ((a.attrelid='nukhabapay.iam_workflow_proposals'::regclass AND a.attname NOT IN ('operation_id','actor_staff_id','scope_key','idempotency_key','command_digest','provenance','record_kind','execution')) OR
         (a.attrelid='nukhabapay.iam_workflow_receipts'::regclass AND a.attname NOT IN ('operation_id','actor_staff_id','scope_key','command_digest','outcome','execution'))) AND
        has_column_privilege(current_user,a.attrelid,a.attnum,'SELECT')) AS excess_columns,
      EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='nukhabapay' AND c.relkind IN ('r','p') AND
          (has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE') OR has_table_privilege(current_user,c.oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
           (c.relname NOT IN ('iam_workflow_proposals','iam_workflow_receipts') AND has_any_column_privilege(current_user,c.oid,'SELECT')))) AS excess,
      (SELECT count(*)=2 AND bool_and(relrowsecurity AND relforcerowsecurity) FROM pg_class WHERE oid=ANY(ARRAY[
        'nukhabapay.iam_workflow_proposals'::regclass,'nukhabapay.iam_workflow_receipts'::regclass])) AS rls`)).rows[0];
    if (!rights || rights.rls !== true || [rights.schema_create, rights.database_create, rights.database_temp, rights.command, rights.excess, rights.excess_columns].some(value => value !== false)) throw new Error();
    // Parse and privilege check the exact projection; no records are inspected at initialization.
    await pool.query(`SELECT p.operation_id,p.actor_staff_id,p.scope_key,p.idempotency_key,p.command_digest,p.provenance,p.record_kind,p.execution,
      r.operation_id,r.actor_staff_id,r.scope_key,r.command_digest,r.outcome,r.execution
      FROM nukhabapay.iam_workflow_proposals p,nukhabapay.iam_workflow_receipts r WHERE false`);
  } catch {
    await pool?.end().catch(() => undefined);
    throw new Error("Synthetic receipt reader configuration or dependency unavailable");
  }
  const reader = pool;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= reader.end();
  return Object.freeze({
    close,
    async lookup(query: AuthorizedSyntheticReceiptQuery): Promise<NonAuthorizedReceiptRow | "UNRESOLVED"> {
      if (!consumeAuthorizedSyntheticReceiptQuery(query) || !query.operationId || closing) return "UNRESOLVED";
      let client: PoolClient | undefined;
      let broken: Error | undefined;
      try {
        client = await reader.connect();
        if (failedClients.has(client)) { broken = new Error("Receipt connection discarded"); return "UNRESOLVED"; }
        await client.query("BEGIN READ ONLY");
        await client.query("SELECT set_config('nukhabapay.workflow_scope',$1,true)", [query.tenantId]);
        const found = await client.query(`SELECT r.operation_id AS "operationId",r.actor_staff_id AS "actorStaffId",r.scope_key AS "tenantId",
          p.idempotency_key AS key,r.command_digest AS digest,r.outcome,r.execution
          FROM nukhabapay.iam_workflow_receipts r JOIN nukhabapay.iam_workflow_proposals p ON p.operation_id=r.operation_id
          WHERE p.actor_staff_id=$1 AND r.actor_staff_id=$1 AND p.scope_key=$2 AND r.scope_key=$2
          AND p.idempotency_key=$3 AND p.operation_id=$4 AND r.operation_id=$4
          AND p.command_digest=$5 AND r.command_digest=$5 AND p.provenance='UNVERIFIED'
          AND p.record_kind='SIMULATION_ONLY' AND p.execution='NOT_AUTHORIZED'
          AND r.outcome='SIMULATION_RECORDED' AND r.execution='NOT_AUTHORIZED' LIMIT 2`,
        [query.actorStaffId, query.tenantId, query.key, query.operationId, query.expectedDigest]);
        const committed = await client.query("COMMIT");
        if (failedClients.has(client)) { broken = new Error("Receipt connection discarded"); return "UNRESOLVED"; }
        if (committed.command !== "COMMIT" || found.rowCount !== 1) return "UNRESOLVED";
        const row = found.rows[0];
        return Object.freeze({ operationId: row.operationId as string, actorStaffId: row.actorStaffId as string, tenantId: row.tenantId as string,
          key: row.key as string, digest: row.digest as string, outcome: "SIMULATION_RECORDED", execution: "NOT_AUTHORIZED" });
      } catch {
        if (client) { try { await client.query("ROLLBACK"); } catch { broken = new Error("Receipt connection discarded"); } }
        return "UNRESOLVED";
      } finally { client?.release(broken); }
    },
  });
}
