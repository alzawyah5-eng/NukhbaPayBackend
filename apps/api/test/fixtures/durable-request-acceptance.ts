import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { Client } from "pg";
import { createDurableStaffRequestStore } from "@nukhbapay/database";
import { TrustedStaffActorBoundary, canonicalDigest, type StaffRequestCommand, type StaffRequestResult, type AuthorizedStaffRequest,
  type StaffAuthorizationRepository, type SecurityAuditWriter, type VerifiedStaffIdentity } from "@nukhbapay/application";
import { forDatabase } from "./disposable-iam-database.js";
import { commitLossProxy } from "./commit-loss-proxy.js";
import { ISSUER, NOW } from "./oidc-test-issuer.js";
import { approvalProvenanceAcceptance } from "./approval-provenance-acceptance.js";
import { workflowMigrationInstalled, grantWorkflowBackend } from "./workflow-migration.js";
import { workflowReadAcceptance } from "./workflow-read-acceptance.js";

export async function durableRequestAcceptance(t:TestContext,f:{admin:Client;databaseUrl:string;staff:string;other:string;tenant:string;otherTenant:string;
  identity(sub?:string):Promise<VerifiedStaffIdentity>;runtime:{repository:StaffAuthorizationRepository;auditWriter:SecurityAuditWriter}}){
  const {admin,staff,other,tenant,otherTenant}=f;
  const name=(await admin.query("SELECT current_database() AS name")).rows[0].name as string;
  assert.match(name,/^nukhabapay_b3b3_[0-9a-f]{32}$/);
  const migration=new Client({connectionString:forDatabase(process.env["DB_MIGRATION_URL"]!,name)});await migration.connect();
  try{assert.equal((await migration.query("SELECT current_database() AS name")).rows[0].name,name);await migration.query("BEGIN");
    assert.equal(await workflowMigrationInstalled(migration),true);await migration.query("COMMIT");
  }catch(error){await migration.query("ROLLBACK");throw error;}finally{await migration.end();}
  const reviewer=randomUUID(),governance=randomUUID(),pending=randomUUID();
  await admin.query("INSERT INTO nukhabapay.staff_users(id,display_name,contact_email,status) VALUES($1,'Synthetic reviewer','reviewer@example.invalid','ACTIVE'),($2,'Synthetic governance','governance@example.invalid','ACTIVE'),($3,'Synthetic pending','pending@example.invalid','PENDING')",[reviewer,governance,pending]);
  for(const [id,sub] of [[reviewer,"durable-reviewer"],[reviewer,"durable-alternate"],[governance,"durable-governance"]])await admin.query("INSERT INTO nukhabapay.staff_identities(id,staff_id,issuer,subject,status) VALUES($1,$2,$3,$4,'ACTIVE')",[randomUUID(),id,ISSUER,sub]);
  // Only fixture state changes: no effective request or review mutates staff/grants.
  await admin.query("UPDATE nukhabapay.platform_role_grants SET role_code='ACCESS_ADMIN' WHERE staff_id=$1",[staff]);
  for(const [id,role] of [[reviewer,"SECURITY_ADMIN"],[governance,"GOVERNANCE_OWNER"]])await admin.query("INSERT INTO nukhabapay.platform_role_grants(id,staff_id,role_code,granted_at,grant_source,evidence_reference) VALUES($1,$2,$3,'2025-01-01','TEST','durable.synthetic')",[randomUUID(),id,role]);
  for(const id of [staff,reviewer]){
    let membership=(await admin.query("SELECT id FROM nukhabapay.staff_memberships WHERE staff_id=$1 AND tenant_id=$2",[id,tenant])).rows[0]?.id;
    if(!membership){membership=randomUUID();await admin.query("INSERT INTO nukhabapay.staff_memberships(id,staff_id,tenant_id,status) VALUES($1,$2,$3,'ACTIVE')",[membership,id,tenant]);}
    await admin.query("INSERT INTO nukhabapay.tenant_role_grants(id,membership_id,tenant_id,role_code,granted_at,grant_source,evidence_reference) VALUES($1,$2,$3,'TENANT_ADMIN','2025-01-01','TEST','durable.synthetic')",[randomUUID(),membership,tenant]);
  }
  const role="nukh_request_"+randomUUID().replaceAll("-","").slice(0,20);assert.match(role,/^nukh_request_[0-9a-f]{20}$/);
  const tables=["staff_request_operations","staff_access_requests","staff_review_observations","staff_request_audit","staff_request_receipts","staff_request_outbox"];
  const projection={staff_users:"id,status,authz_version",staff_identities:"staff_id,issuer,subject,status",staff_memberships:"id,staff_id,tenant_id,status,version",
    platform_role_grants:"id,staff_id,role_code,scope,granted_at,expires_at,revoked_at",tenant_role_grants:"id,membership_id,tenant_id,role_code,scope,granted_at,expires_at,revoked_at"};
  const url=new URL(f.databaseUrl);url.username=role;url.password=randomUUID();
  const config={connectionString:url.href,expectedRole:role,expectedDatabase:name};
  const stores:Awaited<ReturnType<typeof createDurableStaffRequestStore>>[]=[];
  await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
  try{
    await grantWorkflowBackend(admin,role,false);
    const store=await createDurableStaffRequestStore(config);stores.push(store);
    const allowed=new Set([staff,reviewer,governance,other]);
    const base={...f.runtime,now:()=>new Date(NOW),syntheticRequests:{capability:"NON_AUTHORIZED_STAFF_REQUESTS" as const,allows:async(c:Parameters<import("@nukhbapay/application").SyntheticStaffRequestStore["allows"]>[0])=>allowed.has(c.principal!.staffId),execute:store.execute}};
    const boundary=new TrustedStaffActorBoundary(base);
    async function actor(sub="actor-a",scope?:string,b=boundary){const a=await b.establish(await f.identity(sub),scope);assert.equal(a.allowed,true);if(!a.allowed)throw new Error("Durable actor fixture denied");return a.actor;}
    const submit=(overrides:Partial<Extract<StaffRequestCommand,{kind:"SUBMIT"}>>={}):Extract<StaffRequestCommand,{kind:"SUBMIT"}>=>({kind:"SUBMIT",key:randomUUID(),id:randomUUID(),version:1n,previousDigest:null,targetStaffId:other,
      operation:{kind:"DISABLE",target:"STAFF"},proposedRoles:[],expectedAuthzVersion:0n,expectedMembershipVersion:null,expiresAtMs:NOW+600000,...overrides});
    async function recorded(command:StaffRequestCommand){const value=await boundary.recordStaffRequest(await actor(),command);assert.equal(value.kind,"RECORDED",JSON.stringify(value));assert.equal(value.execution,"NOT_AUTHORIZED");return value;}
    const review=(request:StaffRequestResult,overrides:Partial<Extract<StaffRequestCommand,{kind:"REVIEW"}>>={}):Extract<StaffRequestCommand,{kind:"REVIEW"}>=>({kind:"REVIEW",id:request.requestId!,version:BigInt(request.version!),requestDigest:request.requestDigest!,key:randomUUID(),...overrides});
    async function zero(key:string,owner=staff){const op=canonicalDigest(["staff-request-operation-v1",owner,key]);for(const table of ["staff_request_operations","staff_request_audit","staff_request_receipts","staff_request_outbox"])assert.equal((await admin.query(`SELECT count(*)::int AS n FROM nukhabapay.${table} WHERE operation_id=$1`,[op])).rows[0].n,0);}
    await t.test("durable request stores immutable intent versions and idempotent replay without staff mutation",async()=>{
      const command=submit(),first=await recorded(command),again=await boundary.recordStaffRequest(await actor(),command);
      assert.equal(again.kind,"REPLAYED");assert.equal(again.operationId,first.operationId);
      const row=(await admin.query("SELECT * FROM nukhabapay.staff_access_requests WHERE request_id=$1",[command.id])).rows[0];
      assert.equal(row.requester_staff_id,staff);assert.equal(row.target_staff_id,other);assert.equal(row.state,"SUBMITTED");assert.equal(row.policy_version,"staff-lifecycle-v1");assert.equal(row.payload.operation.kind,"DISABLE");
      assert.equal(row.execution,"NOT_AUTHORIZED");assert.equal(row.expected_authz_version,"0");assert.equal(row.expires_at_ms,String(command.expiresAtMs));
      for(const table of ["staff_request_operations","staff_request_audit","staff_request_receipts","staff_request_outbox"])assert.equal((await admin.query(`SELECT count(*)::int AS n FROM nukhabapay.${table} WHERE operation_id=$1`,[first.operationId])).rows[0].n,1);
      assert.equal((await boundary.recordStaffRequest(await actor(),{...command,expiresAtMs:command.expiresAtMs+1})).kind,"CONFLICT");
      assert.equal((await admin.query("SELECT status FROM nukhabapay.staff_users WHERE id=$1",[other])).rows[0].status,"ACTIVE");
    });
    await t.test("role change intents are durable plans and do not create role grants",async()=>{
      const futureStaff=randomUUID(),create=submit({targetStaffId:futureStaff,operation:{kind:"CREATE",target:"STAFF"}});
      await recorded(create);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM nukhabapay.staff_users WHERE id=$1",[futureStaff])).rows[0].n,0);
      assert.equal((await admin.query("SELECT existing_target_staff_id FROM nukhabapay.staff_access_requests WHERE request_id=$1",[create.id])).rows[0].existing_target_staff_id,null);
      const command=submit({targetStaffId:pending,operation:{kind:"ACTIVATE",target:"STAFF"},proposedRoles:["PLATFORM_AUDITOR"]});await recorded(command);
      assert.deepEqual((await admin.query("SELECT roles FROM nukhabapay.staff_access_requests WHERE request_id=$1",[command.id])).rows[0].roles,["PLATFORM_AUDITOR"]);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM nukhabapay.platform_role_grants WHERE staff_id=$1",[pending])).rows[0].n,0);
      assert.equal((await admin.query("SELECT status FROM nukhabapay.staff_users WHERE id=$1",[pending])).rows[0].status,"PENDING");
      for(const roles of [["SECURITY_ADMIN","GOVERNANCE_OWNER"],["TENANT_ADMIN"],["UNAPPROVED_ROLE"]]){
        const invalid=submit({targetStaffId:pending,operation:{kind:"ACTIVATE",target:"STAFF"},proposedRoles:roles});
        assert.equal((await boundary.recordStaffRequest(await actor(),invalid)).kind,"DENIED");await zero(invalid.key);
      }
    });
    await t.test("concurrent identical submissions and conflicting revisions commit only one version",async()=>{
      const command=submit(),a=await actor();
      const attempts=await Promise.all([boundary.recordStaffRequest(a,command),boundary.recordStaffRequest(a,command),boundary.recordStaffRequest(a,command)]);
      assert.equal(attempts.filter(r=>r.kind==="RECORDED").length,1);assert.equal(attempts.filter(r=>r.kind==="REPLAYED").length,2);
      const first=attempts[0]!;
      const second=submit({...command,key:randomUUID(),version:2n,previousDigest:first.requestDigest!});
      const competing={...second,key:randomUUID(),expiresAtMs:second.expiresAtMs+1000};
      const revisions=await Promise.all([boundary.recordStaffRequest(a,second),boundary.recordStaffRequest(a,competing)]);
      assert.equal(revisions.filter(r=>r.kind==="RECORDED").length,1);assert.equal(revisions.filter(r=>r.kind==="CONFLICT").length,1);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM nukhabapay.staff_access_requests WHERE request_id=$1",[command.id])).rows[0].n,2);
      assert.equal((await boundary.recordStaffRequest(await actor("durable-reviewer"),review(first))).kind,"DENIED");
    });
    await t.test("independent canonical reviewers persist observations; alternate identities cannot count twice",async()=>{
      const request=await recorded(submit()),one=review(request),two=review(request);
      const pair=await Promise.all([boundary.recordStaffRequest(await actor("durable-reviewer"),one),boundary.recordStaffRequest(await actor("durable-alternate"),two)]);
      assert.equal(pair.filter(r=>r.kind==="RECORDED").length,1);assert.equal(pair.filter(r=>r.kind==="DENIED"&&r.reason==="DUPLICATE_PERSON").length,1);
      const original=pair[0]!.kind==="RECORDED"?one:two;
      assert.equal((await boundary.recordStaffRequest(await actor("durable-alternate"),original)).kind,"REPLAYED");
      assert.equal((await boundary.recordStaffRequest(await actor("durable-governance"),review(request))).kind,"RECORDED");
      const rows=(await admin.query("SELECT accepted_approval,assurance,execution FROM nukhabapay.staff_review_observations WHERE request_id=$1",[request.requestId])).rows;
      assert.equal(rows.length,2);assert.ok(rows.every(r=>r.accepted_approval===false&&r.assurance==="not-established"&&r.execution==="NOT_AUTHORIZED"));
      assert.equal((await admin.query("SELECT state FROM nukhabapay.staff_access_requests WHERE request_id=$1",[request.requestId])).rows[0].state,"SUBMITTED");
    });
    await t.test("self beneficiary forged actors and foreign tenants cannot store reviews",async()=>{
      const request=await recorded(submit());
      for(const subject of ["actor-a","actor-other"])assert.equal((await boundary.recordStaffRequest(await actor(subject),review(request))).reason,"SELF_OR_BENEFICIARY_REVIEW");
      assert.equal((await boundary.recordStaffRequest({} as never,review(request))).kind,"DENIED");
      assert.equal((await store.execute({staffId:reviewer,command:review(request)} as AuthorizedStaffRequest)).kind,"DENIED");
      assert.equal((await boundary.recordStaffRequest(await actor("actor-a",otherTenant),review(request))).kind,"DENIED");
      const denied=new TrustedStaffActorBoundary({...base,syntheticRequests:undefined} as never);
      assert.equal((await denied.recordStaffRequest(await actor("actor-a",undefined,denied),submit())).kind,"DENIED");
    });
    await t.test("tenant requests and observations stay in active tenant scope without platform inheritance",async()=>{
      const command=submit({operation:{kind:"SUSPEND",target:"MEMBERSHIP"},expectedMembershipVersion:1n});
      const result=await boundary.recordStaffRequest(await actor("actor-a",tenant),command);assert.equal(result.kind,"RECORDED",JSON.stringify(result));
      assert.equal((await boundary.recordStaffRequest(await actor("durable-reviewer",tenant),review(result))).kind,"RECORDED");
      assert.equal((await boundary.recordStaffRequest(await actor("durable-governance"),review(result))).kind,"DENIED");
      const c=new Client({connectionString:url.href});await c.connect();
      try{await c.query("BEGIN");await c.query("SELECT set_config('nukhabapay.workflow_scope',$1,true)",[otherTenant]);assert.equal((await c.query("SELECT * FROM nukhabapay.staff_access_requests WHERE request_id=$1",[command.id])).rowCount,0);await c.query("ROLLBACK");}finally{await c.end();}
    });
    await t.test("stale actor target requester and expired request authority cannot produce observations",async()=>{
      const command=submit(),request=await recorded(command),held=await actor("durable-reviewer");
      await admin.query("UPDATE nukhabapay.staff_users SET authz_version=authz_version+1 WHERE id=$1",[reviewer]);
      assert.equal((await boundary.recordStaffRequest(held,review(request))).kind,"DENIED");
      await admin.query("UPDATE nukhabapay.staff_users SET authz_version=authz_version+1 WHERE id=$1",[other]);
      try{assert.equal((await boundary.recordStaffRequest(await actor("durable-reviewer"),review(request))).kind,"DENIED");}finally{await admin.query("UPDATE nukhabapay.staff_users SET authz_version=authz_version-1 WHERE id=$1",[other]);}
      await admin.query("UPDATE nukhabapay.staff_users SET authz_version=authz_version+1 WHERE id=$1",[staff]);
      assert.equal((await boundary.recordStaffRequest(await actor("durable-reviewer"),review(request))).reason,"STALE_REQUESTER");
      const short=await recorded(submit({expiresAtMs:NOW+2000}));
      const late=new TrustedStaffActorBoundary({...base,now:()=>new Date(NOW+3000)});
      assert.equal((await late.recordStaffRequest(await actor("durable-reviewer",undefined,late),review(short))).reason,"REQUEST_EXPIRED");
    });
    await t.test("audit receipt and outbox failures roll back every staged request record",async()=>{
      for(const table of ["staff_request_audit","staff_request_receipts","staff_request_outbox"]){
        const command=submit();await admin.query(`REVOKE INSERT ON nukhabapay.${table} FROM "${role}"`);
        try{assert.equal((await boundary.recordStaffRequest(await actor(),command)).kind,"DENIED");await zero(command.key);assert.equal((await admin.query("SELECT count(*)::int AS n FROM nukhabapay.staff_access_requests WHERE request_id=$1",[command.id])).rows[0].n,0);}
        finally{await admin.query(`GRANT INSERT ON nukhabapay.${table} TO "${role}"`);}
        assert.equal((await boundary.recordStaffRequest(await actor(),command)).kind,"RECORDED");
      }
      const request=await recorded(submit()),command=review(request);
      await admin.query(`REVOKE INSERT ON nukhabapay.staff_request_audit FROM "${role}"`);
      try{assert.equal((await boundary.recordStaffRequest(await actor("durable-reviewer"),command)).kind,"DENIED");await zero(command.key,reviewer);
        assert.equal((await admin.query("SELECT count(*)::int AS n FROM nukhabapay.staff_review_observations WHERE request_id=$1",[request.requestId])).rows[0].n,0);
      }finally{await admin.query(`GRANT INSERT ON nukhabapay.staff_request_audit TO "${role}"`);}
      assert.equal((await boundary.recordStaffRequest(await actor("durable-reviewer"),command)).kind,"RECORDED");
    });
    await t.test("authority revocation at the final validation rolls back staged audit and request",async()=>{
      let calls=0;
      const revoking=new TrustedStaffActorBoundary({...base,syntheticRequests:{...base.syntheticRequests,allows:async()=>++calls<3}});
      const command=submit();assert.equal((await revoking.recordStaffRequest(await actor("actor-a",undefined,revoking),command)).kind,"DENIED");await zero(command.key);
      assert.equal((await boundary.recordStaffRequest(await actor(),command)).kind,"RECORDED");
      let changes=0;
      const targetChanges=new TrustedStaffActorBoundary({...base,syntheticRequests:{...base.syntheticRequests,allows:async()=>{
        if(++changes===3)await admin.query("UPDATE nukhabapay.staff_users SET authz_version=authz_version+1 WHERE id=$1",[other]);return true;
      }}});
      const next=submit();
      try{assert.equal((await targetChanges.recordStaffRequest(await actor("actor-a",undefined,targetChanges),next)).reason,"STALE_TARGET");await zero(next.key);}
      finally{await admin.query("UPDATE nukhabapay.staff_users SET authz_version=authz_version-1 WHERE id=$1",[other]);}
    });
    await t.test("lost commit acknowledgement reconciles authoritatively without duplicate history",async()=>{
      const proxy=await commitLossProxy(url),proxyUrl=new URL(proxy.url);proxyUrl.search="";
      let uncertainStore:Awaited<ReturnType<typeof createDurableStaffRequestStore>>|undefined;
      const command=submit();
      try{uncertainStore=await createDurableStaffRequestStore({...config,connectionString:proxyUrl.href});stores.push(uncertainStore);
        const uncertain=new TrustedStaffActorBoundary({...base,syntheticRequests:{...base.syntheticRequests,execute:uncertainStore.execute}});
        proxy.arm("before-ack",2); // First COMMIT is the read-only freshness check; second is artifact durability.
        const value=await uncertain.recordStaffRequest(await actor("actor-a",undefined,uncertain),command);
        assert.equal(value.kind,"UNRESOLVED");assert.equal(proxy.cut,true);assert.equal(value.requestDigest,undefined);
      }finally{await uncertainStore?.close();await proxy.close();}
      const lookup={kind:"LOOKUP" as const,key:command.key,id:command.id,version:command.version};
      assert.equal((await boundary.recordStaffRequest(await actor(),lookup)).kind,"REPLAYED");
      const retry=await Promise.all([boundary.recordStaffRequest(await actor(),command),boundary.recordStaffRequest(await actor(),command)]);assert.ok(retry.every(v=>v.kind==="REPLAYED"));
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM nukhabapay.staff_access_requests WHERE request_id=$1",[command.id])).rows[0].n,1);
      assert.equal((await boundary.recordStaffRequest(await actor("durable-reviewer"),lookup)).kind,"UNRESOLVED");
    });
    await t.test("restricted writer cannot mutate staff or history and canonical IAM/catalogue roles gain nothing",async()=>{
      const direct=new Client({connectionString:url.href});await direct.connect();
      try{for(const sql of ["UPDATE nukhabapay.staff_users SET status='DISABLED'","UPDATE nukhabapay.staff_access_requests SET state='SUBMITTED'","DELETE FROM nukhabapay.staff_request_audit","TRUNCATE nukhabapay.staff_request_outbox","SELECT contact_email FROM nukhabapay.staff_users","SELECT nukhabapay.execute_staff_command('{}'::jsonb)","CREATE TABLE nukhabapay.workflow_escape(id int)"])await assert.rejects(()=>direct.query(sql),{code:"42501"});
        assert.equal((await direct.query("SELECT * FROM nukhabapay.staff_access_requests")).rowCount,0);
      }finally{await direct.end();}
      for(const name of ["nukhabapay_runtime","nukhabapay_importer","nukhabapay_identity_reader","nukhabapay_identity_writer"])for(const table of tables)assert.equal((await admin.query("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS allowed",[name,"nukhabapay."+table])).rows[0].allowed,false);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM nukhabapay.staff_review_observations WHERE accepted_approval OR execution<>'NOT_AUTHORIZED'")).rows[0].n,0);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM nukhabapay.staff_access_requests WHERE state<>'SUBMITTED' OR execution<>'NOT_AUTHORIZED'")).rows[0].n,0);
    });
    await t.test("migration 005 rejects null scope versions, missing payload bindings and noncanonical targets directly",async()=>{
      const originals=(await admin.query("SELECT * FROM nukhabapay.staff_access_requests WHERE version=1 ORDER BY tenant_id NULLS FIRST")).rows;
      const platform=originals.find(r=>r.tenant_id===null && r.payload.operation.kind!=="CREATE")!,scopedRequest=originals.find(r=>r.tenant_id!==null)!;
      assert.ok(platform);assert.ok(scopedRequest);
      const columns=(await admin.query("SELECT attname FROM pg_attribute WHERE attrelid='nukhabapay.staff_access_requests'::regclass AND attnum>0 AND NOT attisdropped AND attgenerated='' ORDER BY attnum")).rows.map(r=>r.attname as string);
      for(const column of columns)assert.match(column,/^[a-z_]+$/);
      type ConstraintRow={expected_membership_version:string|null;version:string;previous_digest:string|null;roles:string[];
        target_staff_id:string;requester_staff_id:string;expires_at_ms:string;created_at_ms:string;submission_operation:string;request_id:string;scope_key:string;
        payload:{expectedMembershipVersion:string|null;version:string;proposedRoles?:string[];scope?:unknown;targetStaffId:string;expiresAtMs:number;id:string}};
      const cases:[Record<string,unknown>,(row:ConstraintRow)=>void,string][]=[
        [scopedRequest,row=>{row.expected_membership_version=null;row.payload.expectedMembershipVersion=null;},"23514"],
        [platform,row=>{row.version="2";row.previous_digest=null;row.payload.version="2";},"23514"],
        [platform,row=>{delete row.payload.proposedRoles;},"23514"],
        [platform,row=>{delete row.payload.scope;},"23514"],
        [platform,row=>{row.roles=["TENANT_ADMIN"];row.payload.proposedRoles=row.roles;},"23514"],
        [scopedRequest,row=>{row.roles=["ACCESS_ADMIN"];row.payload.proposedRoles=row.roles;},"23514"],
        [platform,row=>{row.target_staff_id=randomUUID();row.payload.targetStaffId=row.target_staff_id;},"23503"],
        [platform,row=>{row.expires_at_ms=row.created_at_ms;row.payload.expiresAtMs=Number(row.created_at_ms);},"23514"],
      ];
      for(const [original,change,code] of cases){
        const row=structuredClone(original) as ConstraintRow;change(row);
        const operation=canonicalDigest(["constraint-test",randomUUID()]);row.submission_operation=operation;
        // Keep the parent request identity for a revision; new version-one tests get their own identity.
        if(String(row.version)==="1"){row.request_id=randomUUID();row.payload.id=row.request_id;}
        await admin.query("BEGIN");
        try{
          await admin.query("INSERT INTO nukhabapay.staff_request_operations(operation_id,actor_staff_id,issuer,subject,idempotency_key,intent_digest,request_id,request_version,scope_key,kind) VALUES($1,$2,$3,'constraint-synthetic',$4,$1,$5,$6,$7,'SUBMIT')",[operation,row.requester_staff_id,ISSUER,randomUUID(),row.request_id,row.version,row.scope_key]);
          await assert.rejects(()=>admin.query(`INSERT INTO nukhabapay.staff_access_requests(${columns.join(",")}) SELECT ${columns.join(",")} FROM jsonb_populate_record(NULL::nukhabapay.staff_access_requests,$1::jsonb)`,[JSON.stringify(row)]),{code});
        }finally{await admin.query("ROLLBACK");}
        assert.equal((await admin.query("SELECT count(*)::int AS n FROM nukhabapay.staff_request_operations WHERE operation_id=$1",[operation])).rows[0].n,0);
      }
    });
    await approvalProvenanceAcceptance(t,{admin,databaseUrl:url.href,staff,reviewer,governance,target:other,tenant,otherTenant,runtime:f.runtime,
      createRequest:()=>recorded(submit()),
      createTenantRequest:async()=>{const result=await boundary.recordStaffRequest(await actor("actor-a",tenant),submit({operation:{kind:"SUSPEND",target:"MEMBERSHIP"},expectedMembershipVersion:1n}));assert.equal(result.kind,"RECORDED");return result;},
      reviseRequest:async request=>recorded(submit({id:request.requestId!,version:BigInt(request.version!)+1n,previousDigest:request.requestDigest!}))});
    await workflowReadAcceptance(t,{admin,databaseUrl:url.href,staff,reviewer,governance,target:other,tenant,otherTenant,identity:f.identity,runtime:f.runtime,
      record:async(sub,scope,command)=>boundary.recordStaffRequest(await actor(sub,scope),command)});
  }finally{
    await Promise.all(stores.map(store=>store.close()));
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename=$1",[role])).rows[0].n,0);
    await admin.query(`REVOKE ALL ON ${tables.map(n=>"nukhabapay."+n).join(",")} FROM "${role}"`);
    for(const [table,columns] of Object.entries(projection))await admin.query(`REVOKE SELECT(${columns}) ON nukhabapay.${table} FROM "${role}"`);
    for(const table of ["staff_memberships","tenant_role_grants"])await admin.query(`DROP POLICY "workflow_${table}_${role.slice(-20)}" ON nukhabapay.${table}`);
    await admin.query(`REVOKE USAGE ON SCHEMA nukhabapay FROM "${role}"`);await admin.query(`REVOKE CONNECT ON DATABASE "${name}" FROM "${role}"`);await admin.query(`DROP ROLE "${role}"`);
  }
}
