import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";
import { forDatabase, withDisposableIamDatabase } from "./fixtures/disposable-iam-database.js";
import { grantWorkflowBackend } from "./fixtures/workflow-migration.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const databasePackage = path.join(root,"packages/database");
const migrations = path.join(databasePackage,"migrations");
const tables = ["iam_workflow_proposals","iam_workflow_audit_intents","iam_workflow_receipts","iam_workflow_outbox",
  "staff_request_operations","staff_access_requests","staff_review_observations","staff_request_audit","staff_request_receipts","staff_request_outbox","staff_synthetic_provenance"];
const roles = ["nukhabapay_runtime","nukhabapay_importer","nukhabapay_identity_reader","nukhabapay_identity_writer"];
const projection = {staff_users:"id,status,authz_version",staff_identities:"staff_id,issuer,subject,status",staff_memberships:"id,staff_id,tenant_id,status,version",
  platform_role_grants:"id,staff_id,role_code,scope,granted_at,expires_at,revoked_at",tenant_role_grants:"id,membership_id,tenant_id,role_code,scope,granted_at,expires_at,revoked_at"};

function migrate(database:string, directory=migrations, down=false):{ok:boolean;output:string} {
  const args=["--experimental-strip-types",path.join(databasePackage,"node_modules/node-pg-migrate/bin/node-pg-migrate.js"),
    ...(down?["down","1"]:["up","5","--timestamp"]),"--database-url-var","DB_MIGRATION_URL","--migrations-dir",directory,
    "--schema","nukhabapay","--migrations-schema","nukhabapay","--migrations-table","schema_migrations","--single-transaction","--check-order",
    "--migration-file-language","ts","--ignore-pattern","README.md|.*\\.md"];
  const sanitize=(value:string)=>value.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi,"[redacted-database-url]");
  try{return {ok:true,output:sanitize(execFileSync(process.execPath,args,{cwd:databasePackage,
    env:{...process.env,DB_MIGRATION_URL:forDatabase(process.env["DB_MIGRATION_URL"]!,database)},encoding:"utf8",stdio:"pipe",timeout:30000}))};}
  catch(error){const e=error as {stdout?:string;stderr?:string};return {ok:false,output:sanitize(String(e.stdout??"")+String(e.stderr??""))};}
}
async function history(client:Client){return (await client.query("SELECT name FROM nukhabapay.schema_migrations ORDER BY id")).rows.map(r=>r.name);}
async function oldSecurity(client:Client){
  return (await client.query(`SELECT 'table' AS kind,c.relname AS name,c.relacl::text AS acl,c.relrowsecurity::text AS rls,c.relforcerowsecurity::text AS forced
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nukhabapay' AND c.relkind='r' AND NOT(c.relname=ANY($1::text[]))
    UNION ALL SELECT 'column',c.relname||'.'||a.attname,a.attacl::text,NULL,NULL FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nukhabapay' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped AND NOT(c.relname=ANY($1::text[]))
    UNION ALL SELECT 'function',p.proname,p.proacl::text,NULL,NULL FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='nukhabapay' AND p.proname NOT IN ('execute_staff_command','check_synthetic_review') ORDER BY kind,name`,[tables])).rows;
}
async function defaults(client:Client){return (await client.query("SELECT defaclrole::regrole::text AS owner,defaclnamespace::regnamespace::text AS schema,defaclobjtype,defaclacl::text FROM pg_default_acl ORDER BY 1,2,3")).rows;}
async function absent(client:Client){
  assert.equal((await client.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nukhabapay' AND c.relname=ANY($1::text[])",[tables])).rows[0].n,0);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='nukhabapay' AND p.proname IN ('execute_staff_command','check_synthetic_review')")).rows[0].n,0);
}

test("migration 005 registers the restricted non-authorized workflow atomically",async t=>{
  await withDisposableIamDatabase(async f=>{
    const admin=f.fixtureClient;
    const owner=new Client({connectionString:forDatabase(process.env["DB_MIGRATION_URL"]!,f.databaseName)});await owner.connect();
    try{
      const original=await oldSecurity(admin),initial=await history(admin);
      assert.equal(initial.length,4);
      const hostile=roles.map(r=>'"'+r+'"').join(",")+",PUBLIC";
      for(const scope of [""," IN SCHEMA nukhabapay"]){
        await owner.query(`ALTER DEFAULT PRIVILEGES${scope} GRANT SELECT ON TABLES TO ${hostile}`);
        await owner.query(`ALTER DEFAULT PRIVILEGES${scope} GRANT EXECUTE ON FUNCTIONS TO ${hostile}`);
      }
      const hostileDefaults=await defaults(owner);
      await t.test("failed migration rolls back DDL, defaults and history on the actual disposable target",async()=>{
        for(const [kind,right] of [["TABLES","SELECT"],["FUNCTIONS","EXECUTE"]]){
          // A built-in role stands in for an unreviewed grantee; no new cluster role is needed.
          await owner.query(`ALTER DEFAULT PRIVILEGES GRANT ${right} ON ${kind} TO pg_monitor`);
          try{
            const before=await defaults(owner),unexpected=migrate(f.databaseName);
            assert.equal(unexpected.ok,false);assert.match(unexpected.output,/Unreviewed workflow default privileges/);
            await absent(owner);assert.deepEqual(await history(owner),initial);assert.deepEqual(await defaults(owner),before);assert.deepEqual(await oldSecurity(owner),original);
          }finally{await owner.query(`ALTER DEFAULT PRIVILEGES REVOKE ${right} ON ${kind} FROM pg_monitor`);}
        }
        const directory=mkdtempSync(path.join(os.tmpdir(),"nukhbapay-m005-"));
        try{
          for(const name of readdirSync(migrations).filter(n=>/^00[1-4]_.*\.ts$/.test(n)))copyFileSync(path.join(migrations,name),path.join(directory,name));
          writeFileSync(path.join(directory,"005_staff_workflow_persistence.ts"),
            `import {up as realUp} from ${JSON.stringify(pathToFileURL(path.join(migrations,"005_staff_workflow_persistence.ts")).href)};\nexport function up(pgm){realUp(pgm);pgm.sql("SELECT 1/0");}\n`);
          const result=migrate(f.databaseName,directory);assert.equal(result.ok,false);assert.match(result.output,/division by zero/);
          assert.equal((await owner.query("SELECT current_database() AS name")).rows[0].name,f.databaseName);
          await absent(owner);assert.deepEqual(await history(owner),initial);assert.deepEqual(await defaults(owner),hostileDefaults);assert.deepEqual(await oldSecurity(owner),original);
        }finally{
          const resolved=path.resolve(directory),parent=path.resolve(os.tmpdir());
          assert.equal(path.dirname(resolved),parent);assert.match(path.basename(resolved),/^nukhbapay-m005-[A-Za-z0-9]+$/);
          rmSync(resolved,{recursive:true});
        }
      });
      await t.test("actual migration, repeat and forced-RLS inventory preserve existing object ACLs",async()=>{
        const result=migrate(f.databaseName);assert.equal(result.ok,true,result.output);
        assert.deepEqual(await history(owner),[...initial,"005_staff_workflow_persistence"]);
        assert.equal(migrate(f.databaseName).ok,true);assert.equal((await history(owner)).length,5);
        assert.deepEqual(await oldSecurity(owner),original);
        const rows=(await owner.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nukhabapay' AND c.relname=ANY($1::text[])",[tables])).rows;
        assert.equal(rows.length,11);for(const row of rows){assert.equal(row.relrowsecurity,true);assert.equal(row.relforcerowsecurity,true);}
        assert.equal((await owner.query("SELECT count(*)::int AS n FROM pg_policy WHERE polrelid=ANY(SELECT oid FROM pg_class WHERE relname=ANY($1::text[]) AND relnamespace='nukhabapay'::regnamespace)",[tables])).rows[0].n,11);
        assert.equal((await owner.query("SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal AND tgrelid=ANY(SELECT oid FROM pg_class WHERE relname=ANY($1::text[]) AND relnamespace='nukhabapay'::regnamespace)",[tables])).rows[0].n,12);
        const functions=(await owner.query("SELECT proname,prosecdef,proconfig FROM pg_proc WHERE pronamespace='nukhabapay'::regnamespace AND proname IN ('execute_staff_command','check_synthetic_review')")).rows;
        assert.equal(functions.length,2);for(const fn of functions){assert.equal(fn.prosecdef,false);assert.ok(fn.proconfig.includes("search_path=pg_catalog"));}
      });
      await t.test("hostile global and schema defaults cannot leak new or future objects",async()=>{
        for(const table of tables){
          assert.equal((await owner.query("SELECT count(*)::int AS n FROM pg_class c,LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=$1::regclass AND a.grantee=0",["nukhabapay."+table])).rows[0].n,0);
          for(const role of roles)assert.equal((await owner.query("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS ok",[role,"nukhabapay."+table])).rows[0].ok,false);
        }
        await owner.query("BEGIN");
        try{
          await owner.query("CREATE TABLE nukhabapay.workflow_default_probe(id integer); CREATE FUNCTION nukhabapay.workflow_default_probe() RETURNS integer LANGUAGE sql AS 'SELECT 1'");
          for(const role of roles){
            assert.equal((await owner.query("SELECT has_table_privilege($1,'nukhabapay.workflow_default_probe','SELECT,INSERT,UPDATE,DELETE') AS ok",[role])).rows[0].ok,false);
            assert.equal((await owner.query("SELECT has_function_privilege($1,'nukhabapay.workflow_default_probe()','EXECUTE') AS ok",[role])).rows[0].ok,false);
          }
          assert.equal((await owner.query("SELECT count(*)::int AS n FROM pg_proc p,LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='nukhabapay.workflow_default_probe()'::regprocedure AND a.grantee=0")).rows[0].n,0);
        }finally{await owner.query("ROLLBACK");}
      });
      await t.test("real catalogue and IAM connections cannot read artifacts or fabricate lifecycle success",async()=>{
        const urls=[f.runtimeUrl,f.importUrl,f.runtimeEnv["DB_IDENTITY_READER_URL"]!,f.runtimeEnv["DB_IDENTITY_WRITER_URL"]!];
        for(const [index,connectionString] of urls.entries()){
          const client=new Client({connectionString});await client.connect();
          try{
            for(const table of tables)await assert.rejects(()=>client.query(`SELECT * FROM nukhabapay.${table}`),{code:"42501"});
            await assert.rejects(()=>client.query("SELECT nukhabapay.execute_staff_command('{}'::jsonb)"),{code:"42501"});
            await assert.rejects(()=>client.query("SELECT nukhabapay.check_synthetic_review()"),{code:"42501"});
            if(index===3){
              for(const action of ["STAFF_CREATED","STAFF_ACTIVATED","STAFF_ROLE_GRANTED","PRIVILEGED_APPROVAL_ACCEPTED","SYNTHETIC_REVIEW_OBSERVED"])
                await assert.rejects(()=>client.query("INSERT INTO nukhabapay.security_audit_events(occurred_at,action,outcome,target_type,reason_code) VALUES(now(),$1,'SUCCESS','SYSTEM','NONE')",[action]),{code:"23514"});
              await client.query("INSERT INTO nukhabapay.security_audit_events(occurred_at,action,outcome,target_type,reason_code) VALUES(now(),'AUTHORIZATION_DECISION','SUCCESS','SYSTEM','NONE')");
              await assert.rejects(()=>client.query("INSERT INTO nukhabapay.staff_request_audit DEFAULT VALUES"),{code:"42501"});
            }
          }finally{await client.end();}
        }
      });
      await t.test("owner bootstrap grants only the reviewed workload matrix and never staff execution",async()=>{
        const role="nukh_request_"+randomUUID().replaceAll("-","").slice(0,20);
        await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
        const url=new URL(f.runtimeUrl);url.username=role;url.password=randomUUID();
        const backend=new Client({connectionString:url.href});
        try{
          const recipe=readFileSync(path.join(databasePackage,"roles/grant_staff_workflow_backend.sql"),"utf8");
          for(const [candidate,mode] of [[roles[3]!,"off"],[role,"production"]]){
            await owner.query("BEGIN");
            try{await owner.query("SELECT set_config('nukhabapay.workflow_backend_role',$1,true),set_config('nukhabapay.workflow_provenance_mode',$2,true)",[candidate,mode]);
              await assert.rejects(()=>owner.query(recipe),{code:"42501"});
            }finally{await owner.query("ROLLBACK");}
          }
          await admin.query(`ALTER ROLE "${role}" INHERIT`);
          try{await assert.rejects(()=>grantWorkflowBackend(owner,role,false),{code:"42501"});}
          finally{await admin.query(`ALTER ROLE "${role}" NOINHERIT`);}
          assert.equal((await owner.query("SELECT has_schema_privilege($1,'nukhabapay','USAGE') AS ok",[role])).rows[0].ok,false);
          await grantWorkflowBackend(owner,role,false);await grantWorkflowBackend(owner,role,false);
          await backend.connect();
          for(const table of tables.slice(4,10)){
            assert.equal((await owner.query("SELECT has_table_privilege($1,$2,'SELECT') AND has_table_privilege($1,$2,'INSERT') AS ok",[role,"nukhabapay."+table])).rows[0].ok,true);
            assert.equal((await owner.query("SELECT has_table_privilege($1,$2,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS ok",[role,"nukhabapay."+table])).rows[0].ok,false);
          }
          assert.equal((await owner.query("SELECT has_table_privilege($1,'nukhabapay.staff_synthetic_provenance','SELECT,INSERT') AS ok",[role])).rows[0].ok,false);
          for(const [table,columns] of Object.entries(projection))for(const column of columns.split(","))assert.equal((await owner.query("SELECT has_column_privilege($1,$2,$3,'SELECT') AS ok",[role,"nukhabapay."+table,column])).rows[0].ok,true);
          for(const sql of ["SELECT contact_email FROM nukhabapay.staff_users","UPDATE nukhabapay.staff_users SET status='DISABLED'","SELECT * FROM nukhabapay.products","CREATE TABLE nukhabapay.workflow_escape(id integer)","SET ROLE nukhabapay_migrator","SELECT nukhabapay.execute_staff_command('{}'::jsonb)"])
            await assert.rejects(()=>backend.query(sql),{code:"42501"});
          assert.equal((await backend.query("SELECT * FROM nukhabapay.staff_access_requests")).rowCount,0);
          await backend.query("SET row_security=off");await assert.rejects(()=>backend.query("SELECT * FROM nukhabapay.staff_access_requests"),{code:"42501"});await backend.query("SET row_security=on");
          await backend.query("BEGIN");
          try{await backend.query("SELECT set_config('nukhabapay.workflow_scope','PLATFORM',true)");
            await assert.rejects(()=>backend.query("INSERT INTO nukhabapay.staff_request_operations(operation_id,actor_staff_id,issuer,subject,idempotency_key,intent_digest,request_id,request_version,scope_key,kind) VALUES($1,$2,'https://synthetic.invalid/','s',$3,$1,$4,1,$5,'SUBMIT')",["a".repeat(64),randomUUID(),randomUUID(),randomUUID(),randomUUID()]),{code:"42501"});
          }finally{await backend.query("ROLLBACK");}
          await grantWorkflowBackend(owner,role,true);
          assert.equal((await owner.query("SELECT has_table_privilege($1,'nukhabapay.staff_synthetic_provenance','SELECT') AND has_table_privilege($1,'nukhabapay.staff_synthetic_provenance','INSERT') AS ok",[role])).rows[0].ok,true);
          assert.equal((await owner.query("SELECT has_function_privilege($1,'nukhabapay.check_synthetic_review()','EXECUTE') AS ok",[role])).rows[0].ok,false);
        }finally{
          await backend.end();
          await admin.query(`REVOKE ALL ON ${tables.map(n=>"nukhabapay."+n).join(",")} FROM "${role}"`);
          for(const [table,columns] of Object.entries(projection))await admin.query(`REVOKE SELECT(${columns}) ON nukhabapay.${table} FROM "${role}"`);
          for(const table of ["staff_memberships","tenant_role_grants"])await admin.query(`DROP POLICY IF EXISTS "workflow_${table}_${role.slice(-20)}" ON nukhabapay.${table}`);
          await admin.query(`REVOKE ALL ON SCHEMA nukhabapay FROM "${role}"`);await admin.query(`REVOKE ALL ON DATABASE "${f.databaseName}" FROM "${role}"`);
          assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename=$1",[role])).rows[0].n,0);
          await admin.query(`DROP ROLE "${role}"`);
        }
      });
      await t.test("automatic down refuses to delete immutable history",async()=>{
        const before=await history(owner),security=await oldSecurity(owner);const result=migrate(f.databaseName,migrations,true);
        assert.equal(result.ok,false);assert.match(result.output,/automatic rollback is disabled/);
        assert.deepEqual(await history(owner),before);assert.deepEqual(await oldSecurity(owner),security);
        assert.equal((await owner.query("SELECT count(*)::int AS n FROM pg_class WHERE relnamespace='nukhabapay'::regnamespace AND relname=ANY($1::text[])",[tables])).rows[0].n,11);
      });
      console.info("Migration 005 acceptance: 11 FORCE-RLS tables, 12 immutable/independence triggers, 2 SECURITY INVOKER functions; old ACLs unchanged; catalogue/IAM/PUBLIC denied; restricted backend only.");
    }finally{await owner.end();}
  },"b3b3",4);
});

test("migration 005 rejects an unapproved disposable name without touching development",async()=>{
  await withDisposableIamDatabase(async f=>{
    const before=await history(f.fixtureClient),security=await oldSecurity(f.fixtureClient),acl=await defaults(f.fixtureClient);
    const result=migrate(f.databaseName);assert.equal(result.ok,false);assert.match(result.output,/requires a verified local disposable target/);
    assert.deepEqual(await history(f.fixtureClient),before);assert.deepEqual(await oldSecurity(f.fixtureClient),security);assert.deepEqual(await defaults(f.fixtureClient),acl);await absent(f.fixtureClient);
  },"b3b3",4,true);
});
