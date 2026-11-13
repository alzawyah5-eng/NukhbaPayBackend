import assert from "node:assert/strict";
import {randomUUID,randomInt} from "node:crypto";
import {readFileSync} from "node:fs";
import type {TestContext} from "node:test";
import {Client} from "pg";
import {createStaffWorkflowReader} from "@nukhbapay/database";
import {TrustedStaffActorBoundary,authorizeStaffAccess,type StaffRequestCommand,type StaffRequestResult,type VerifiedStaffIdentity,type TrustedStaffActor,
  type StaffAuthorizationRepository,type SecurityAuditWriter,type StaffWorkflowReadInput,type AuthorizedStaffWorkflowRead,type StaffWorkflowPage} from "@nukhbapay/application";
import {NOW} from "./oidc-test-issuer.js";
import {forDatabase} from "./disposable-iam-database.js";

export async function workflowReadAcceptance(t:TestContext,f:{admin:Client;databaseUrl:string;staff:string;reviewer:string;governance:string;target:string;tenant:string;otherTenant:string;
  identity(sub?:string):Promise<VerifiedStaffIdentity>;runtime:{repository:StaffAuthorizationRepository;auditWriter:SecurityAuditWriter};
  record(sub:string,scope:string|undefined,command:StaffRequestCommand):Promise<StaffRequestResult>}){
  const {admin}=f,database=(await admin.query("SELECT current_database() AS name")).rows[0].name as string;
  assert.match(database,/^nukhabapay_b3b3_[0-9a-f]{32}$/);
  assert.equal((await admin.query("SELECT name FROM nukhabapay.schema_migrations ORDER BY id DESC LIMIT 1")).rows[0].name,"005_staff_workflow_persistence");
  const role="nukh_history_"+randomUUID().replaceAll("-","").slice(0,20);assert.match(role,/^nukh_history_[0-9a-f]{20}$/);
  const projections={staff_request_operations:"operation_id,actor_staff_id,request_id,request_version,scope_key,kind,execution",
    staff_access_requests:"request_id,version,requester_staff_id,target_staff_id,tenant_id,scope_key,roles,created_at_ms,expires_at_ms,policy_version,state,payload,submission_operation,execution,request_digest,previous_digest,expected_authz_version,expected_membership_version",
    staff_review_observations:"operation_id,request_id,request_version,reviewer_staff_id,scope_key,observed_at_ms,assurance,accepted_approval,execution"};
  const url=new URL(f.databaseUrl);url.username=role;url.password=randomUUID();
  const config={connectionString:url.href,expectedRole:role,expectedDatabase:database};
  const readers:Awaited<ReturnType<typeof createStaffWorkflowReader>>[]=[];
  const owner=new Client({connectionString:forDatabase(process.env["DB_MIGRATION_URL"]!,database)});await owner.connect();
  await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
  try{
    await owner.query("BEGIN");
    try{await owner.query("SELECT set_config('nukhabapay.workflow_reader_role',$1,true)",[role]);
      await owner.query(readFileSync(new URL("../../../../../packages/database/roles/grant_staff_workflow_reader.sql",import.meta.url),"utf8"));await owner.query("COMMIT");
    }catch(error){await owner.query("ROLLBACK");throw error;}
    const reader=await createStaffWorkflowReader(config);readers.push(reader);
    let nowMs=NOW,enabled=true;
    const admitted=new Set([f.staff,f.reviewer,f.governance,f.target]);
    const port={capability:"NON_AUTHORIZED_STAFF_WORKFLOW_READ" as const,allows:async(c:Parameters<import("@nukhbapay/application").SyntheticStaffWorkflowReads["allows"]>[0])=>enabled && admitted.has(c.principal!.staffId),read:reader.read};
    const base={...f.runtime,now:()=>new Date(nowMs),syntheticWorkflowReads:port};
    const boundary=new TrustedStaffActorBoundary(base);
    async function actor(sub="actor-a",scope?:string,b=boundary){const result=await b.establish(await f.identity(sub),scope);assert.equal(result.allowed,true);if(!result.allowed)throw new Error("Workflow read actor fixture denied");return result.actor;}
    type Submit=Extract<StaffRequestCommand,{kind:"SUBMIT"}>;
    async function submit(scope?:string,expiresAtMs=NOW+600000){
      const command:Submit={kind:"SUBMIT",key:randomUUID(),id:randomUUID(),version:1n,previousDigest:null,targetStaffId:f.target,
        operation:scope?{kind:"SUSPEND",target:"MEMBERSHIP"}:{kind:"DISABLE",target:"STAFF"},proposedRoles:[],expectedAuthzVersion:0n,expectedMembershipVersion:scope?1n:null,expiresAtMs};
      const result=await f.record("actor-a",scope,command);assert.equal(result.kind,"RECORDED",JSON.stringify(result));return {command,result};
    }
    async function revise(previous:Awaited<ReturnType<typeof submit>>,scope?:string){const command:Submit={...previous.command,key:randomUUID(),version:previous.command.version+1n,previousDigest:previous.result.requestDigest!};
      const result=await f.record("actor-a",scope,command);assert.equal(result.kind,"RECORDED",JSON.stringify(result));return {command,result};}
    async function observe(request:Awaited<ReturnType<typeof submit>>,sub="durable-reviewer",scope?:string){const result=await f.record(sub,scope,{kind:"REVIEW",id:request.command.id,version:request.command.version,key:randomUUID(),requestDigest:request.result.requestDigest!});
      assert.equal(result.kind,"RECORDED",JSON.stringify(result));return result;}
    const first=await submit(),observation=await observe(first),peer=await observe(first,"durable-governance"),second=await revise(first);await observe(second);await revise(second);
    const input=(kind:StaffWorkflowReadInput["kind"]="DETAIL",view:StaffWorkflowReadInput["view"]="REQUESTER",operationId=first.result.operationId!,id=first.command.id):StaffWorkflowReadInput=>({kind,view,operationId,id});
    const own=await actor(),reviewer=await actor("durable-reviewer");
    async function good(who:TrustedStaffActor,query:StaffWorkflowReadInput,b=boundary){const result=await b.readStaffWorkflow(who,query);assert.equal(result.allowed,true,JSON.stringify(result));if(!result.allowed)throw new Error("Workflow read denied");return result;}
    const deny=async(who:TrustedStaffActor,query:StaffWorkflowReadInput,b=boundary)=>{const result=await b.readStaffWorkflow(who,query);assert.equal(result.allowed,false);assert.equal("data" in result,false);assert.equal("cursor" in result,false);return result;};
    const readCounts=async()=>(await admin.query("SELECT (SELECT count(*) FROM nukhabapay.staff_request_operations) AS operations,(SELECT count(*) FROM nukhabapay.staff_request_audit) AS audit,(SELECT count(*) FROM nukhabapay.staff_request_receipts) AS receipts,(SELECT count(*) FROM nukhabapay.staff_request_outbox) AS outbox")).rows[0];
    await t.test("workflow requester reads immutable detail status revisions and redacted review history after committed audit",async()=>{
      const counts=await readCounts(),before=(await admin.query("SELECT count(*)::int AS n FROM nukhabapay.security_audit_events WHERE action='AUTHORIZATION_DECISION' AND outcome='SUCCESS' AND actor_staff_id=$1",[f.staff])).rows[0].n;
      const detail=await good(own,input());assert.equal(detail.data.visibleHeadVersion,"3");assert.equal(detail.data.detail!.version,"3");assert.equal(detail.data.detail!.previousDigest,second.result.requestDigest);
      assert.equal(detail.data.detail!.expectedAuthzVersion,"0");assert.equal(detail.data.detail!.expectedMembershipVersion,null);
      assert.equal(detail.data.detail!.operation.kind,"DISABLE");assert.equal(detail.execution,"NOT_AUTHORIZED");assert.equal(detail.acceptedApproval,false);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM nukhabapay.security_audit_events WHERE action='AUTHORIZATION_DECISION' AND outcome='SUCCESS' AND actor_staff_id=$1",[f.staff])).rows[0].n,before+1);
      const status=await good(own,input("STATUS"));assert.equal(status.data.status,"SUBMITTED");assert.equal(status.data.detail,undefined);
      assert.deepEqual((await good(own,input("REVISIONS"))).data.revisions!.map(r=>r.version),["1","2","3"]);
      const reviews=await good(own,input("REVIEWS"));assert.equal(reviews.data.reviews!.length,3);
      for(const value of [detail,status,reviews])assert.doesNotMatch(JSON.stringify(value),/"(issuer|subject|authorityDigest|authenticationEventId|challengeId|assertionDigest|reviewerStaffId|payload|idempotencyKey|binding)"/);
      assert.equal(Object.isFrozen(detail.data),true);assert.equal(Object.isFrozen(detail.data.detail!.operation),true);assert.equal(Object.isFrozen(detail.data.detail!.proposedRoles),true);
      assert.deepEqual(await readCounts(),counts);
    });
    await t.test("workflow reviewers see only versions they observed and their own reviews, never peer evidence or later intent",async()=>{
      const query=input("DETAIL","REVIEWER",observation.operationId!);
      const found=await good(reviewer,query);assert.equal(found.data.visibleHeadVersion,"2");assert.equal(found.data.detail!.version,"2");
      await deny(reviewer,{...query,version:3n});
      assert.deepEqual((await good(reviewer,{...query,kind:"REVISIONS"})).data.revisions!.map(r=>r.version),["1","2"]);
      const history=await good(reviewer,{...query,kind:"REVIEWS"});assert.deepEqual(history.data.reviews!.map(r=>r.version),["1","2"]);
      const governance=await actor("durable-governance");assert.equal((await good(governance,input("STATUS","REVIEWER",peer.operationId!))).data.visibleHeadVersion,"1");
      await deny(governance,query);await deny(reviewer,input("STATUS","REQUESTER",observation.operationId!));await deny(own,query);
    });
    await t.test("workflow history pagination uses actor-bound opaque one-use cursors and pins visible revision head",async()=>{
      const query={...input("REVISIONS"),limit:1},one=await good(own,query);assert.ok(one.cursor);assert.deepEqual(JSON.parse(JSON.stringify(one.cursor)),{});
      assert.equal((await deny(own,{...query,cursor:{...one.cursor}})).allowed,false);
      const two=await good(own,{...query,cursor:one.cursor});assert.equal(two.data.revisions![0]!.version,"2");assert.ok(two.cursor);
      await deny(own,{...query,cursor:one.cursor});
      const three=await good(own,{...query,cursor:two.cursor});assert.equal(three.data.revisions![0]!.version,"3");assert.equal(three.cursor,undefined);
      for(const wrong of [{...query,kind:"REVIEWS" as const},{...query,limit:2},{...query,id:randomUUID()}]){const fresh=await good(own,query);await deny(own,{...wrong,cursor:fresh.cursor!});}
      const alternate=await actor("actor-alternate"),fresh=await good(own,query);await deny(alternate,{...query,cursor:fresh.cursor!});
      const expired=await good(own,query);nowMs=NOW+60000;try{await deny(own,{...query,cursor:expired.cursor!});}finally{nowMs=NOW;}
      const reviewQuery={...input("REVIEWS"),limit:1};let page=await good(own,reviewQuery),total=page.data.reviews!.length;
      while(page.cursor){page=await good(own,{...reviewQuery,cursor:page.cursor});total+=page.data.reviews!.length;}assert.equal(total,3);
    });
    await t.test("workflow unknown empty malformed and mismatched operation lookups reveal no existence oracle",async()=>{
      const empty=await submit(),query=input("REVIEWS","REQUESTER",empty.result.operationId!,empty.command.id);
      assert.deepEqual((await good(own,query)).data.reviews,[]);
      const absent=await deny(own,{...input(),id:randomUUID()}),foreign=await deny(reviewer,input());assert.deepEqual(absent,foreign);
      for(const invalid of [{...input(),operationId:"0".repeat(64)},{...input(),id:empty.command.id},{...input(),version:999999n},
        {...input(),operationId:first.result.operationId!+"' OR true"},{...input(),limit:26},{...input(),kind:"ENUMERATE"},{...input(),version:0n}])
        await deny(own,invalid as StaffWorkflowReadInput);
    });
    await t.test("workflow read authorization is separate from self-read and rejects forged actors identities and tickets",async()=>{
      const noPort=new TrustedStaffActorBoundary({...f.runtime,now:()=>new Date(NOW)}),unconfigured=await actor("actor-a",undefined,noPort);
      await deny(unconfigured,input(),noPort);enabled=false;try{await deny(own,input());}finally{enabled=true;}
      for(const forged of [{},{...own},f.staff])await deny(forged as TrustedStaffActor,input());
      assert.equal((await boundary.establish({...await f.identity()} as VerifiedStaffIdentity)).allowed,false);
      const otherBoundary=new TrustedStaffActorBoundary(base);await deny(await actor("actor-a",undefined,otherBoundary),input());
      assert.equal(await reader.read({staffId:f.staff,tenantId:null,query:input(),revalidate:async()=>true} as unknown as AuthorizedStaffWorkflowRead),"NOT_AVAILABLE");
      let captured:AuthorizedStaffWorkflowRead|undefined;
      const capture=new TrustedStaffActorBoundary({...base,syntheticWorkflowReads:{...port,read:async ticket=>{captured=ticket;assert.equal(await reader.read({...ticket} as AuthorizedStaffWorkflowRead),"NOT_AVAILABLE");return reader.read(ticket);}}});
      await good(await actor("actor-a",undefined,capture),input(),capture);assert.ok(captured);assert.equal(await reader.read(captured),"NOT_AVAILABLE");
      const context=await f.runtime.repository.findByTrustedIdentity(await f.identity());assert.ok(context);
      assert.equal(authorizeStaffAccess({principal:context,membership:null,platformRoleGrants:await f.runtime.repository.findPlatformRoleGrants(f.staff)},
        {permissionCode:"platform.access.request",scope:"PLATFORM",now:new Date(NOW).toISOString()}).reason,"PERMISSION_INACTIVE");
    });
    await t.test("workflow suspended disabled stale and revoked authority never discloses history",async()=>{
      for(const status of ["SUSPENDED","DISABLED"]){await admin.query("UPDATE nukhabapay.staff_users SET status=$2 WHERE id=$1",[f.staff,status]);
        try{await deny(own,input());assert.equal((await boundary.establish(await f.identity())).allowed,false);}finally{await admin.query("UPDATE nukhabapay.staff_users SET status='ACTIVE' WHERE id=$1",[f.staff]);}}
      await admin.query("UPDATE nukhabapay.staff_users SET authz_version=authz_version+1 WHERE id=$1",[f.staff]);
      try{await deny(own,input());await good(await actor(),input());}finally{await admin.query("UPDATE nukhabapay.staff_users SET authz_version=authz_version-1 WHERE id=$1",[f.staff]);}
      await admin.query("UPDATE nukhabapay.platform_role_grants SET revoked_at=$2 WHERE staff_id=$1 AND role_code='ACCESS_ADMIN'",[f.staff,new Date(NOW)]);
      try{await deny(own,input());await deny(await actor(),input());}finally{await admin.query("UPDATE nukhabapay.platform_role_grants SET revoked_at=NULL WHERE staff_id=$1 AND role_code='ACCESS_ADMIN'",[f.staff]);}
    });
    await t.test("workflow elapsed grant expiry and conflicting roles deny even after fresh actor establishment",async()=>{
      await admin.query("UPDATE nukhabapay.platform_role_grants SET expires_at=$2 WHERE staff_id=$1 AND role_code='ACCESS_ADMIN'",[f.staff,new Date(NOW+1000)]);
      try{const expiring=await actor();nowMs=NOW+1000;await deny(expiring,input());}finally{nowMs=NOW;await admin.query("UPDATE nukhabapay.platform_role_grants SET expires_at=NULL WHERE staff_id=$1 AND role_code='ACCESS_ADMIN'",[f.staff]);}
      const conflict=randomUUID();await admin.query("INSERT INTO nukhabapay.platform_role_grants(id,staff_id,role_code,granted_at,grant_source,evidence_reference) VALUES($1,$2,'SECURITY_ADMIN','2025-01-01','TEST','history.synthetic')",[conflict,f.staff]);
      try{await deny(await actor(),input());}finally{await admin.query("DELETE FROM nukhabapay.platform_role_grants WHERE id=$1",[conflict]);}
    });
    await t.test("workflow exact tenant scope, active membership and tenant grants are required without platform inheritance",async()=>{
      const request=await submit(f.tenant),review=await observe(request,"durable-reviewer",f.tenant),member=await actor("actor-a",f.tenant),reviewMember=await actor("durable-reviewer",f.tenant);
      const query=input("DETAIL","REQUESTER",request.result.operationId!,request.command.id);
      assert.equal((await good(member,query)).data.detail!.expectedMembershipVersion,"1");await good(reviewMember,input("REVIEWS","REVIEWER",review.operationId!,request.command.id));await deny(own,query);
      const membership=(await admin.query("SELECT id FROM nukhabapay.staff_memberships WHERE staff_id=$1 AND tenant_id=$2",[f.staff,f.otherTenant])).rows[0].id;
      const grant=randomUUID();await admin.query("INSERT INTO nukhabapay.tenant_role_grants(id,membership_id,tenant_id,role_code,granted_at,grant_source,evidence_reference) VALUES($1,$2,$3,'TENANT_ADMIN','2025-01-01','TEST','history.synthetic')",[grant,membership,f.otherTenant]);
      try{await deny(await actor("actor-a",f.otherTenant),query);}finally{await admin.query("DELETE FROM nukhabapay.tenant_role_grants WHERE id=$1",[grant]);}
      for(const status of ["SUSPENDED","REVOKED"]){await admin.query("UPDATE nukhabapay.staff_memberships SET status=$3 WHERE staff_id=$1 AND tenant_id=$2",[f.staff,f.tenant,status]);
        try{await deny(member,query);}finally{await admin.query("UPDATE nukhabapay.staff_memberships SET status='ACTIVE' WHERE staff_id=$1 AND tenant_id=$2",[f.staff,f.tenant]);}}
      await admin.query("UPDATE nukhabapay.tenant_role_grants SET revoked_at=$3 WHERE membership_id IN (SELECT id FROM nukhabapay.staff_memberships WHERE staff_id=$1 AND tenant_id=$2) AND role_code='TENANT_ADMIN'",[f.staff,f.tenant,new Date(NOW)]);
      try{await deny(await actor("actor-a",f.tenant),query);}finally{await admin.query("UPDATE nukhabapay.tenant_role_grants SET revoked_at=NULL WHERE membership_id IN (SELECT id FROM nukhabapay.staff_memberships WHERE staff_id=$1 AND tenant_id=$2) AND role_code='TENANT_ADMIN'",[f.staff,f.tenant]);}
    });
    await t.test("workflow status derives expiry without changing stored request state",async()=>{
      const request=await submit(undefined,NOW+1000);nowMs=NOW+1000;
      try{const result=await good(own,input("STATUS","REQUESTER",request.result.operationId!,request.command.id));assert.equal(result.data.status,"EXPIRED");assert.equal(result.data.state,"SUBMITTED");
        assert.equal((await admin.query("SELECT state FROM nukhabapay.staff_access_requests WHERE request_id=$1",[request.command.id])).rows[0].state,"SUBMITTED");
      }finally{nowMs=NOW;}
    });
    await t.test("workflow audit or IAM failure and suspension during lookup prevent successful disclosure",async()=>{
      await admin.query("REVOKE INSERT ON nukhabapay.security_audit_events FROM nukhabapay_identity_writer");
      try{assert.deepEqual(await deny(own,input()),{allowed:false,reason:"UNAVAILABLE",execution:"NOT_AUTHORIZED"});}
      finally{await admin.query("GRANT INSERT ON nukhabapay.security_audit_events TO nukhabapay_identity_writer");}
      await admin.query("REVOKE SELECT(status) ON nukhabapay.staff_users FROM nukhabapay_identity_reader");
      try{assert.deepEqual(await deny(own,input()),{allowed:false,reason:"UNAVAILABLE",execution:"NOT_AUTHORIZED"});}
      finally{await admin.query("GRANT SELECT(status) ON nukhabapay.staff_users TO nukhabapay_identity_reader");}
      const noAudit=new TrustedStaffActorBoundary({...base,auditWriter:{appendSecurityAuditEvents:async()=>{throw new Error("private audit failure");}}});
      await deny(await actor("actor-a",undefined,noAudit),input(),noAudit);
      let available=true;const repository:StaffAuthorizationRepository={
        findByTrustedIdentity:async(...args)=>{if(!available)throw new Error("private IAM failure");return f.runtime.repository.findByTrustedIdentity(...args);},
        findTenantMembership:(...args)=>f.runtime.repository.findTenantMembership(...args),findPlatformRoleGrants:id=>f.runtime.repository.findPlatformRoleGrants(id)};
      const noIam=new TrustedStaffActorBoundary({...base,repository});const held=await actor("actor-a",undefined,noIam);available=false;await deny(held,input(),noIam);
      const suspend=new TrustedStaffActorBoundary({...base,syntheticWorkflowReads:{...port,read:async ticket=>{const value=await reader.read(ticket);await admin.query("UPDATE nukhabapay.staff_users SET status='SUSPENDED' WHERE id=$1",[f.staff]);return value;}}});
      const before=await actor("actor-a",undefined,suspend);try{await deny(before,input(),suspend);}finally{await admin.query("UPDATE nukhabapay.staff_users SET status='ACTIVE' WHERE id=$1",[f.staff]);}
      const revoke=new TrustedStaffActorBoundary({...base,auditWriter:{appendSecurityAuditEvents:async events=>{await f.runtime.auditWriter.appendSecurityAuditEvents(events);enabled=false;}}});
      const bound=await actor("actor-a",undefined,revoke);try{await deny(bound,input(),revoke);}finally{enabled=true;}
    });
    await t.test("workflow substituted results are denied and unknown adapter fields cannot leak through safe DTOs",async()=>{
      const substitute=new TrustedStaffActorBoundary({...base,syntheticWorkflowReads:{...port,read:async ticket=>{
        const value=await reader.read(ticket);return typeof value==="string"?value:{...value,binding:{...value.binding,staffId:f.target}};
      }}});await deny(await actor("actor-a",undefined,substitute),input(),substitute);
      let raw:StaffWorkflowPage|undefined;
      const extra=new TrustedStaffActorBoundary({...base,syntheticWorkflowReads:{...port,read:async ticket=>{const result=await reader.read(ticket);if(typeof result==="string")return result;
        raw=result;return {...result,data:{...result.data,issuer:"private.synthetic.invalid",challengeId:randomUUID()} } as StaffWorkflowPage;}}});
      const result=await good(await actor("actor-a",undefined,extra),input(),extra);assert.ok(raw);assert.doesNotMatch(JSON.stringify(result),/private.synthetic|challengeId/);
    });
    await t.test("workflow reader has exactly 34 SELECT columns and no IAM, proof, audit, command or mutation rights",async()=>{
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM information_schema.column_privileges WHERE grantee=$1",[role])).rows[0].n,34);
      const direct=new Client({connectionString:url.href});await direct.connect();
      try{for(const sql of ["SELECT issuer FROM nukhabapay.staff_request_operations","SELECT requester_authority_digest FROM nukhabapay.staff_access_requests","SELECT * FROM nukhabapay.staff_synthetic_provenance",
        "SELECT * FROM nukhabapay.staff_request_audit","SELECT * FROM nukhabapay.staff_request_receipts","SELECT * FROM nukhabapay.staff_request_outbox","SELECT * FROM nukhabapay.staff_users","SELECT * FROM nukhabapay.products",
        "INSERT INTO nukhabapay.staff_access_requests DEFAULT VALUES","UPDATE nukhabapay.staff_review_observations SET accepted_approval=false","DELETE FROM nukhabapay.staff_access_requests","TRUNCATE nukhabapay.staff_review_observations",
        "SELECT nukhabapay.execute_staff_command('{}'::jsonb)","SET ROLE nukhabapay_migrator","CREATE TABLE nukhabapay.history_escape(id integer)"])await assert.rejects(()=>direct.query(sql),{code:"42501"});
        assert.equal((await direct.query("SELECT request_id FROM nukhabapay.staff_access_requests")).rowCount,0);
        await direct.query("SET row_security=off");await assert.rejects(()=>direct.query("SELECT request_id FROM nukhabapay.staff_access_requests"),{code:"42501"});await direct.query("SET row_security=on");
        await direct.query("BEGIN");await direct.query("SELECT set_config('nukhabapay.workflow_scope',$1,true)",[f.otherTenant]);assert.equal((await direct.query("SELECT request_id FROM nukhabapay.staff_access_requests WHERE request_id=$1",[first.command.id])).rowCount,0);await direct.query("ROLLBACK");
      }finally{await direct.end();}
      for(const name of ["nukhabapay_runtime","nukhabapay_importer","nukhabapay_identity_reader","nukhabapay_identity_writer"])for(const table of Object.keys(projections))assert.equal((await admin.query("SELECT has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE') OR has_table_privilege($1,$2,'DELETE,TRUNCATE') AS ok",[name,"nukhabapay."+table])).rows[0].ok,false);
    });
    await t.test("workflow configuration is isolated and excess missing invalid or unavailable privileges fail closed",async()=>{
      const keys=["DB_MIGRATION_URL","DB_RUNTIME_URL","DB_IMPORT_URL","DB_IDENTITY_READER_URL","DB_IDENTITY_WRITER_URL"],saved=keys.map(key=>process.env[key]);
      try{for(const key of keys)delete process.env[key];const isolated=await createStaffWorkflowReader(config);readers.push(isolated);await isolated.close();}finally{keys.forEach((key,i)=>{if(saved[i]===undefined)delete process.env[key];else process.env[key]=saved[i];});}
      await assert.rejects(()=>createStaffWorkflowReader({...config,connectionString:"private-invalid-config"}),error=>error instanceof Error && error.message==="Workflow reader configuration or dependency unavailable");
      for(const [grant,revoke] of [[`GRANT SELECT ON nukhabapay.staff_synthetic_provenance TO "${role}"`,`REVOKE SELECT ON nukhabapay.staff_synthetic_provenance FROM "${role}"`],
        [`GRANT UPDATE(state) ON nukhabapay.staff_access_requests TO "${role}"`,`REVOKE UPDATE(state) ON nukhabapay.staff_access_requests FROM "${role}"`]]){await admin.query(grant!);try{await assert.rejects(()=>createStaffWorkflowReader(config),{message:"Workflow reader configuration or dependency unavailable"});}finally{await admin.query(revoke!);}}
      await admin.query(`REVOKE SELECT(version) ON nukhabapay.staff_access_requests FROM "${role}"`);try{await assert.rejects(()=>createStaffWorkflowReader(config),{message:"Workflow reader configuration or dependency unavailable"});}finally{await admin.query(`GRANT SELECT(version) ON nukhabapay.staff_access_requests TO "${role}"`);}
      await admin.query("CREATE VIEW nukhabapay.history_excess_probe WITH(security_invoker=true) AS SELECT request_id FROM nukhabapay.staff_access_requests");
      try{await admin.query(`GRANT SELECT ON nukhabapay.history_excess_probe TO "${role}"`);await assert.rejects(()=>createStaffWorkflowReader(config),{message:"Workflow reader configuration or dependency unavailable"});}
      finally{await admin.query("DROP VIEW nukhabapay.history_excess_probe");}
      await admin.query("BEGIN");
      try{await admin.query("CREATE FUNCTION nukhabapay.history_excess_probe() RETURNS boolean LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS 'SELECT TRUE'");
        await admin.query("REVOKE ALL ON FUNCTION nukhabapay.history_excess_probe() FROM PUBLIC");await admin.query(`GRANT EXECUTE ON FUNCTION nukhabapay.history_excess_probe() TO "${role}"`);await admin.query("COMMIT");
      }catch(error){await admin.query("ROLLBACK");throw error;}
      try{await assert.rejects(()=>createStaffWorkflowReader(config),{message:"Workflow reader configuration or dependency unavailable"});}finally{await admin.query("DROP FUNCTION nukhabapay.history_excess_probe()");}
      const missing=new URL(url);missing.pathname="/nukhabapay_b3b3_"+randomUUID().replaceAll("-","");await assert.rejects(()=>createStaffWorkflowReader({...config,connectionString:missing.href,expectedDatabase:missing.pathname.slice(1)}),{message:"Workflow reader configuration or dependency unavailable"});
      await good(own,input());
    });
    async function waiting(){for(let i=0;i<100;i++){await admin.query("SELECT pg_stat_clear_snapshot()");const row=(await admin.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 AND state='active' AND wait_event_type='Lock'",[role])).rows[0];if(row)return row.pid as number;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error("Workflow reader did not reach controlled lock");}
    await t.test("workflow multi-query reads keep one snapshot during a concurrently committed revision",async()=>{
      const request=await submit(),query=input("REVIEWS","REQUESTER",request.result.operationId!,request.command.id);
      await observe(request);
      const key=randomInt(1,2147483647);
      // A temporary restrictive policy pauses only this SELECT role, after the head read.
      // It cannot widen the existing FORCE-RLS scope policy or block the separate writer.
      await admin.query("BEGIN");
      try{
        await admin.query(`CREATE FUNCTION nukhabapay.workflow_read_snapshot_gate() RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN PERFORM pg_catalog.pg_advisory_xact_lock(${key}::bigint); RETURN TRUE; END $$`);
        await admin.query("REVOKE ALL ON FUNCTION nukhabapay.workflow_read_snapshot_gate() FROM PUBLIC");
        await admin.query(`GRANT EXECUTE ON FUNCTION nukhabapay.workflow_read_snapshot_gate() TO "${role}"`);
        await admin.query(`CREATE POLICY workflow_read_snapshot_gate ON nukhabapay.staff_review_observations AS RESTRICTIVE FOR SELECT TO "${role}" USING(nukhabapay.workflow_read_snapshot_gate())`);
        await admin.query("COMMIT");
      }catch(error){await admin.query("ROLLBACK");throw error;}
      await admin.query("SELECT pg_advisory_lock($1::bigint)",[key]);
      const pending=boundary.readStaffWorkflow(own,query);
      let updated:Awaited<ReturnType<typeof submit>>|undefined;
      let result:Awaited<typeof pending>;
      try{try{await waiting();updated=await revise(request);}finally{assert.equal((await admin.query("SELECT pg_advisory_unlock($1::bigint) AS ok",[key])).rows[0].ok,true);}
        result=await pending;
      }finally{await pending;await admin.query("DROP POLICY workflow_read_snapshot_gate ON nukhabapay.staff_review_observations");await admin.query("DROP FUNCTION nukhabapay.workflow_read_snapshot_gate()");}
      assert.equal(result.allowed,true,JSON.stringify(result));if(result.allowed){assert.equal(result.data.visibleHeadVersion,"1");assert.equal(result.data.reviews!.length,1);}
      assert.equal((await good(own,{...query,kind:"STATUS"})).data.visibleHeadVersion,"2");
      const page=await good(own,{...query,kind:"REVISIONS",limit:1});assert.ok(page.cursor);assert.ok(updated);await revise(updated);
      const next=await good(own,{...query,kind:"REVISIONS",limit:1,cursor:page.cursor});assert.equal(next.data.visibleHeadVersion,"2");assert.equal(next.cursor,undefined);
    });
    await t.test("workflow connection loss while blocked fails closed and subsequent reads recover cleanly",async()=>{
      await admin.query("BEGIN");await admin.query("LOCK TABLE nukhabapay.staff_access_requests IN ACCESS EXCLUSIVE MODE");
      const pending=boundary.readStaffWorkflow(own,input());
      try{const pid=await waiting();assert.equal((await admin.query("SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE pid=$1 AND datname=current_database() AND usename=$2",[pid,role])).rows[0].killed,true);
        assert.deepEqual(await pending,{allowed:false,reason:"UNAVAILABLE",execution:"NOT_AUTHORIZED"});
      }finally{await admin.query("ROLLBACK");await pending;}
      await good(own,input());
      const sessions=(await admin.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND usename=$1",[role])).rows;
      for(const row of sessions)await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid=$1 AND datname=current_database() AND usename=$2",[row.pid,role]);
      let recovered=false;for(let i=0;i<3;i++)if((await boundary.readStaffWorkflow(own,input())).allowed){recovered=true;break;}assert.equal(recovered,true);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 AND state LIKE 'idle in transaction%'",[role])).rows[0].n,0);
      const closed=await createStaffWorkflowReader(config);readers.push(closed);await closed.close();const b=new TrustedStaffActorBoundary({...base,syntheticWorkflowReads:{...port,read:closed.read}});await deny(await actor("actor-a",undefined,b),input(),b);
    });
    await t.test("concurrent workflow reads retain actor isolation and never write artifact or staff state",async()=>{
      const counts=await readCounts();const values=await Promise.all([boundary.readStaffWorkflow(own,input()),boundary.readStaffWorkflow(reviewer,input()),
        boundary.readStaffWorkflow(reviewer,input("DETAIL","REVIEWER",observation.operationId!)),boundary.readStaffWorkflow(own,input("REVISIONS"))]);
      assert.deepEqual(values.map(v=>v.allowed),[true,false,true,true]);assert.deepEqual(await readCounts(),counts);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM nukhabapay.staff_review_observations WHERE accepted_approval OR assurance<>'not-established'")).rows[0].n,0);
    });
    console.info("Workflow reader acceptance: 34 SELECT columns on 3 FORCE-RLS tables; no IAM/provenance/audit/receipt/outbox/command/mutation rights; existing roles unchanged.");
  }finally{
    await Promise.all(readers.map(reader=>reader.close()));await owner.end();
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename=$1",[role])).rows[0].n,0);
    for(const [table,columns] of Object.entries(projections))await admin.query(`REVOKE SELECT(${columns}) ON nukhabapay.${table} FROM "${role}"`);
    await admin.query(`REVOKE USAGE ON SCHEMA nukhabapay FROM "${role}"`);await admin.query(`REVOKE CONNECT ON DATABASE "${database}" FROM "${role}"`);await admin.query(`DROP ROLE "${role}"`);
  }
}
