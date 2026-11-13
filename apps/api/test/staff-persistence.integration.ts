import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { Client } from "pg";
import test from "node:test";
import { withDisposableIamDatabase, forDatabase } from "./fixtures/disposable-iam-database.js";
import { staffRecoveryAcceptance } from "./fixtures/staff-recovery-acceptance.js";
import { trustedActorAcceptance } from "./fixtures/trusted-actor-acceptance.js";
import { workflowMigrationInstalled } from "./fixtures/workflow-migration.js";

test("registered migration 005 persists non-authorized artifacts atomically and denies staff execution", async (t) => {
  await withDisposableIamDatabase(async (fixture) => {
    const admin = fixture.fixtureClient;
    const migration = new Client({ connectionString: forDatabase(process.env["DB_MIGRATION_URL"]!,fixture.databaseName) });
    await migration.connect();
    try {
      assert.equal((await migration.query("SELECT current_database() AS name")).rows[0].name,fixture.databaseName);
      assert.equal(await workflowMigrationInstalled(migration),true);
    } finally { await migration.end(); }
    const a=randomUUID(), b=randomUUID(), person=randomUUID();
    await admin.query("INSERT INTO nukhabapay.tenants(id,tenant_key) VALUES($1,'workflow-a'),($2,'workflow-b')",[a,b]);
    await admin.query("INSERT INTO nukhabapay.staff_users(id,display_name,contact_email,status) VALUES($1,'Synthetic','synthetic@example.invalid','ACTIVE')",[person]);
    const role="nukh_workflow_"+randomUUID().replaceAll("-","").slice(0,20);
    assert.match(role,/^nukh_workflow_[0-9a-f]{20}$/);
    const tables=["iam_workflow_proposals","iam_workflow_audit_intents","iam_workflow_receipts","iam_workflow_outbox"];
    await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
    const url=new URL(process.env["DB_TEST_ADMIN_URL"]!); url.username=role; url.password=randomUUID(); url.pathname="/"+fixture.databaseName;
    const clients=[new Client({connectionString:url.href,connectionTimeoutMillis:3000,statement_timeout:5000}),new Client({connectionString:url.href,connectionTimeoutMillis:3000,statement_timeout:5000})];
    try {
    await admin.query(`GRANT CONNECT ON DATABASE "${fixture.databaseName}" TO "${role}"`);
    await admin.query(`GRANT USAGE ON SCHEMA nukhabapay TO "${role}"`);
    await admin.query(`GRANT SELECT,INSERT ON ${tables.map(n=>"nukhabapay."+n).join(",")} TO "${role}"`);
    await admin.query(`GRANT EXECUTE ON FUNCTION nukhabapay.execute_staff_command(jsonb) TO "${role}"`);
      await Promise.all(clients.map(c=>c.connect()));
      const digest=createHash("sha256").update("synthetic intent").digest("hex");
      const insert=async(c:Client,operation:string,key:string,scope=a,changed=digest)=>{
        await c.query("INSERT INTO nukhabapay.iam_workflow_proposals(operation_id,actor_staff_id,target_staff_id,tenant_id,scope_key,idempotency_key,command_digest,operation) VALUES($1,$2,$2,$3,$6,$4,$5,'SUSPEND')",[operation,person,scope,key,changed,scope]);
      };
      const fill=async(c:Client,op:string)=>{
        const values=[op,person,a,digest];
        await c.query("INSERT INTO nukhabapay.iam_workflow_audit_intents(operation_id,actor_staff_id,target_staff_id,scope_key,command_digest,event_name) VALUES($1,$2,$2,$3,$4,'STAFF_SUSPEND_INTENT')",values);
        await c.query("INSERT INTO nukhabapay.iam_workflow_receipts(operation_id,actor_staff_id,target_staff_id,scope_key,command_digest,outcome) VALUES($1,$2,$2,$3,$4,'SIMULATION_RECORDED')",values);
        await c.query("INSERT INTO nukhabapay.iam_workflow_outbox(operation_id,actor_staff_id,target_staff_id,scope_key,command_digest,action) VALUES($1,$2,$2,$3,$4,'NO_EXTERNAL_DELIVERY')",values);
      };
      const scoped=async(c:Client)=>{await c.query("BEGIN ISOLATION LEVEL SERIALIZABLE");await c.query("SELECT set_config('nukhabapay.workflow_scope',$1,true)",[a]);};
      const op=()=>createHash("sha256").update(randomUUID()).digest("hex");
      await t.test("forced RLS and absent/foreign scope deny artifacts",async()=>{
        assert.equal((await clients[0]!.query("SELECT * FROM nukhabapay.iam_workflow_proposals")).rowCount,0);
        await scoped(clients[0]!);
        try { await assert.rejects(()=>insert(clients[0]!,op(),randomUUID(),b),{code:"42501"}); }
        finally { await clients[0]!.query("ROLLBACK"); }
      });
      await t.test("failure after each staged write rolls back all four records",async()=>{
        for(let stage=0;stage<4;stage++){
          const id=op(); await scoped(clients[0]!); await insert(clients[0]!,id,randomUUID());
          if(stage>0) await clients[0]!.query("INSERT INTO nukhabapay.iam_workflow_audit_intents(operation_id,actor_staff_id,target_staff_id,scope_key,command_digest,event_name) VALUES($1,$2,$2,$3,$4,'STAFF_SUSPEND_INTENT')",[id,person,a,digest]);
          if(stage>1) await clients[0]!.query("INSERT INTO nukhabapay.iam_workflow_receipts(operation_id,actor_staff_id,target_staff_id,scope_key,command_digest,outcome) VALUES($1,$2,$2,$3,$4,'SIMULATION_RECORDED')",[id,person,a,digest]);
          if(stage>2) await clients[0]!.query("INSERT INTO nukhabapay.iam_workflow_outbox(operation_id,actor_staff_id,target_staff_id,scope_key,command_digest,action) VALUES($1,$2,$2,$3,$4,'NO_EXTERNAL_DELIVERY')",[id,person,a,digest]);
          await assert.rejects(()=>clients[0]!.query("SELECT 1/0"),{code:"22012"}); await clients[0]!.query("ROLLBACK");
          for(const table of tables) assert.equal((await admin.query(`SELECT count(*)::int AS n FROM nukhabapay.${table} WHERE operation_id=$1`,[id])).rows[0].n,0);
        }
      });
      await t.test("concurrent duplicate key blocks then rejects; committed tuple is complete",async()=>{
        const id=op(), key=randomUUID(); const first=clients[0]!,second=clients[1]!;
        await scoped(first); await insert(first,id,key); await fill(first,id);
        await scoped(second);
        const duplicate=assert.rejects(()=>insert(second,op(),key),e=> typeof e==="object"&&e!==null&&"code" in e&&["23505","40001"].includes(String(e.code)));
        await first.query("COMMIT");await duplicate;await second.query("ROLLBACK");
        for(const table of tables) assert.equal((await admin.query(`SELECT count(*)::int AS n FROM nukhabapay.${table} WHERE operation_id=$1`,[id])).rows[0].n,1);
        await scoped(second); assert.equal((await second.query("SELECT command_digest FROM nukhabapay.iam_workflow_proposals WHERE operation_id=$1",[id])).rows[0].command_digest,digest);await second.query("COMMIT");
        // Check visibility against populated tables, not just an empty fixture.
        for(const table of tables) assert.equal((await second.query(`SELECT * FROM nukhabapay.${table}`)).rowCount,0);
        await second.query("BEGIN");
        try {
          await second.query("SELECT set_config('nukhabapay.workflow_scope',$1,true)",[b]);
          for(const table of tables) assert.equal((await second.query(`SELECT * FROM nukhabapay.${table}`)).rowCount,0);
        } finally { await second.query("ROLLBACK"); }
      });
      await t.test("incomplete commit fails and leaves no proposal or receipt",async()=>{
        const id=op(); await scoped(clients[0]!); await insert(clients[0]!,id,randomUUID());
        await assert.rejects(()=>clients[0]!.query("COMMIT"),{code:"23503"});
        await clients[0]!.query("ROLLBACK");
        for(const table of tables) assert.equal((await admin.query(`SELECT count(*)::int AS n FROM nukhabapay.${table} WHERE operation_id=$1`,[id])).rows[0].n,0);
      });
      await t.test("changed payload cannot reuse a key and mismatched audit cannot commit",async()=>{
        const id=op(), key=randomUUID(), c=clients[0]!;
        await scoped(c);await insert(c,id,key);await fill(c,id);await c.query("COMMIT");
        await scoped(c);
        try { await assert.rejects(()=>insert(c,op(),key,a,"f".repeat(64)),{code:"23505"}); }
        finally { await c.query("ROLLBACK"); }
        for(const [event,hash] of [["STAFF_ACTIVATE_INTENT",digest],["STAFF_SUSPEND_INTENT","f".repeat(64)]]) {
          const next=op();await scoped(c);await insert(c,next,randomUUID());
          try { await assert.rejects(()=>c.query("INSERT INTO nukhabapay.iam_workflow_audit_intents(operation_id,actor_staff_id,target_staff_id,scope_key,command_digest,event_name) VALUES($1,$2,$2,$3,$4,$5)",[next,person,a,hash,event]),{code:"23503"}); }
          finally { await c.query("ROLLBACK"); }
        }
      });
      await t.test("forged authority, simulation objects and direct staff/audit access cannot execute",async()=>{
        for(const payload of [{actorStaffId:person,approved:true,mfa:true},{recordKind:"SIMULATION_ONLY",execution:"NOT_AUTHORIZED"}]) await assert.rejects(()=>clients[0]!.query("SELECT nukhabapay.execute_staff_command($1::jsonb)",[JSON.stringify(payload)]),{code:"42501"});
        for(const sql of ["SELECT * FROM nukhabapay.staff_users","UPDATE nukhabapay.staff_users SET status='DISABLED'","INSERT INTO nukhabapay.security_audit_events(occurred_at,action,outcome,target_type,reason_code) VALUES(now(),'AUTHORIZATION_DECISION','SUCCESS','SYSTEM','NONE')"]) await assert.rejects(()=>clients[0]!.query(sql),{code:"42501"});
        assert.equal((await admin.query("SELECT status FROM nukhabapay.staff_users WHERE id=$1",[person])).rows[0].status,"ACTIVE");
        const fn=(await admin.query("SELECT prosecdef,proconfig FROM pg_proc WHERE oid='nukhabapay.execute_staff_command(jsonb)'::regprocedure")).rows[0];assert.equal(fn.prosecdef,false);assert.ok(fn.proconfig.includes("search_path=pg_catalog"));
      });
      await t.test("catalogue and IAM workloads inherit no workflow or function privileges",async()=>{
        for(const name of ["nukhabapay_runtime","nukhabapay_importer","nukhabapay_identity_reader","nukhabapay_identity_writer"]){
          for(const table of tables) assert.equal((await admin.query("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS allowed",[name,"nukhabapay."+table])).rows[0].allowed,false);
          assert.equal((await admin.query("SELECT has_function_privilege($1,'nukhabapay.execute_staff_command(jsonb)','EXECUTE') AS allowed",[name])).rows[0].allowed,false);
        }
        assert.equal((await admin.query("SELECT has_schema_privilege($1,'nukhabapay','CREATE') AS allowed",[role])).rows[0].allowed,false);
        for(const table of tables) {
          assert.equal((await admin.query("SELECT has_table_privilege($1,$2,'UPDATE,DELETE,TRUNCATE') AS allowed",[role,"nukhabapay."+table])).rows[0].allowed,false);
          const rls=(await admin.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass",["nukhabapay."+table])).rows[0];
          assert.deepEqual(rls,{relrowsecurity:true,relforcerowsecurity:true});
        }
      });
      await staffRecoveryAcceptance(t, { admin, url: url.href, actor: person, tenant: a, otherTenant: b });
      await trustedActorAcceptance(t, { admin, url: url.href, actor: person, tenant: a, otherTenant: b, runtimeEnv: fixture.runtimeEnv });
    } finally {
      await Promise.all(clients.map(c=>c.end()));
      await admin.query(`REVOKE ALL ON ${tables.map(n=>"nukhabapay."+n).join(",")} FROM "${role}"`);
      await admin.query(`REVOKE ALL ON FUNCTION nukhabapay.execute_staff_command(jsonb) FROM "${role}"`);
      await admin.query(`REVOKE USAGE ON SCHEMA nukhabapay FROM "${role}"`);
      await admin.query(`REVOKE CONNECT ON DATABASE "${fixture.databaseName}" FROM "${role}"`);
      await admin.query(`DROP ROLE "${role}"`);
    }
  },"b3b3",5);
});
