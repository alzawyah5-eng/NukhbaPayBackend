import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import type {TestContext} from "node:test";
import type {Client} from "pg";
import {createDurableStaffRequestStore} from "@nukhbapay/database";
import {TrustedStaffActorBoundary,canonicalDigest,type StaffApprovalIntakeCommand,type StaffApprovalIntakeResult,type StaffRequestResult,type VerifiedStaffIdentity,
  type SyntheticAssuranceVerifier,type SyntheticAssuranceChallenge,type VerifiedSyntheticApprovalProvenance,type StaffAuthorizationRepository,
  type SecurityAuditWriter,type ApprovalRequestSnapshot,type TrustedStaffActor,type AuthorizedStaffRequest,type StaffRequestCommand} from "@nukhbapay/application";
import {commitLossProxy} from "./commit-loss-proxy.js";
import {NOW} from "./oidc-test-issuer.js";

export async function approvalIntakeAcceptance(t:TestContext,f:{admin:Client;staff:string;reviewer:string;governance:string;target:string;tenant:string;otherTenant:string;
  runtime:{repository:StaffAuthorizationRepository;auditWriter:SecurityAuditWriter};now():Date;setNow(ms:number):void;
  requests:{find(id:string,tenantId?:string):Promise<ApprovalRequestSnapshot|null>};assurance:SyntheticAssuranceVerifier;
  authenticate(sub:string):Promise<{identity:VerifiedStaffIdentity;token:string}>;respond(challenge:SyntheticAssuranceChallenge,token:string):Promise<string>;
  store:Awaited<ReturnType<typeof createDurableStaffRequestStore>>;
  config:Readonly<{connectionString:string;expectedRole:string;expectedDatabase:string;syntheticProvenance:"LOCAL_SYNTHETIC_ONLY"}>;
  createRequest():Promise<StaffRequestResult>;createTenantRequest():Promise<StaffRequestResult>;reviseRequest(r:StaffRequestResult):Promise<StaffRequestResult>}){
  const {admin}=f;assert.equal((await admin.query("SELECT current_database() AS name")).rows[0].name,f.config.expectedDatabase);
  assert.match(f.config.expectedDatabase,/^nukhabapay_b3b3_[0-9a-f]{32}$/);
  assert.equal((await admin.query("SELECT name FROM nukhabapay.schema_migrations ORDER BY id DESC LIMIT 1")).rows[0].name,"005_staff_workflow_persistence");
  let enabled=true;
  const admitted=new Set([f.staff,f.reviewer,f.governance,f.target]);
  const policy=async(context:Parameters<import("@nukhbapay/application").SyntheticStaffApprovalIntake["allows"]>[0])=>enabled && admitted.has(context.principal!.staffId);
  const intake={capability:"NON_AUTHORIZED_STAFF_APPROVAL_INTAKE" as const,allows:policy,execute:f.store.execute};
  const base={...f.runtime,now:f.now,requests:f.requests,syntheticAssuranceVerifier:f.assurance,syntheticApprovalIntake:intake,
    syntheticRequests:{capability:"NON_AUTHORIZED_STAFF_REQUESTS" as const,allows:policy,execute:f.store.execute}};
  const boundary=new TrustedStaffActorBoundary(base);
  async function actor(sub="durable-reviewer",scope?:string,b=boundary){const {identity,token}=await f.authenticate(sub);assert.equal(identity.security.assurance,"not-established");
    const result=await b.establish(identity,scope);assert.equal(result.allowed,true,JSON.stringify(result));if(!result.allowed)throw new Error("Intake actor fixture denied");return {actor:result.actor,token};}
  async function proof(request:StaffRequestResult,who:Awaited<ReturnType<typeof actor>>,b=boundary){const c=await b.beginSyntheticApprovalChallenge(who.actor,request.requestId!);
    assert.equal(c.allowed,true,JSON.stringify(c));if(!c.allowed)throw new Error("Intake challenge denied");
    const result=await b.verifySyntheticApprovalProvenance(who.actor,c.challenge,await f.respond(c.challenge,who.token));
    assert.equal(result.allowed,true,JSON.stringify(result));if(!result.allowed)throw new Error("Intake provenance denied");return result.provenance;}
  const command=(r:StaffRequestResult,key:string=randomUUID(),kind:StaffApprovalIntakeCommand["kind"]="ATTEMPT"):StaffApprovalIntakeCommand=>({kind,key,id:r.requestId!,version:BigInt(r.version!),requestDigest:r.requestDigest!,policyVersion:"staff-lifecycle-v1"});
  const tupleTables=["staff_request_operations","staff_review_observations","staff_synthetic_provenance","staff_request_audit","staff_request_receipts","staff_request_outbox"];
  async function tuple(id:string,count:number){for(const table of tupleTables)assert.equal((await admin.query(`SELECT count(*)::int AS n FROM nukhabapay.${table} WHERE operation_id=$1`,[id])).rows[0].n,count);}
  const operation=(key:string,person=f.reviewer)=>canonicalDigest(["staff-request-operation-v1",person,key]);
  const denied=async(result:Promise<StaffApprovalIntakeResult>,kind:StaffApprovalIntakeResult["kind"]="DENIED")=>{const value=await result;assert.equal(value.kind,kind,JSON.stringify(value));assert.equal(value.acceptedApproval,false);assert.equal(value.privilegedApproval,"BLOCKED");
    assert.equal("operationId" in value,false);assert.equal("requestDigest" in value,false);return value;};
  async function recorded(who:Awaited<ReturnType<typeof actor>>,cmd:StaffApprovalIntakeCommand,p:VerifiedSyntheticApprovalProvenance,b=boundary){const value=await b.intakeStaffApproval(who.actor,cmd,p);assert.equal(value.kind,"RECORDED",JSON.stringify(value));
    if(value.kind!=="RECORDED")throw new Error("Intake not recorded");await tuple(value.operationId,1);return value;}
  await t.test("approval intake atomically records exact actor request policy and synthetic blocked evidence without accepting approval",async()=>{
    const request=await f.createRequest(),who=await actor(),p=await proof(request,who),cmd=command(request),result=await recorded(who,cmd,p);
    assert.equal(result.execution,"NOT_AUTHORIZED");assert.equal(result.operationalAssurance,"not-established");assert.equal(result.evidenceKind,"SYNTHETIC_TEST_EVENT");assert.equal(Object.isFrozen(result),true);
    assert.doesNotMatch(JSON.stringify(result),/issuer|subject|challengeId|assertion|recordDigest|authorityDigest/);
    const row=(await admin.query("SELECT * FROM nukhabapay.staff_synthetic_provenance WHERE operation_id=$1",[result.operationId])).rows[0];
    assert.equal(row.reviewer_staff_id,f.reviewer);assert.equal(row.identity_subject,"durable-reviewer");assert.equal(row.request_id,request.requestId);assert.equal(row.request_digest,request.requestDigest);
    assert.equal(row.request_version,request.version);assert.equal(row.policy_version,"staff-lifecycle-v1");assert.equal(row.accepted_approval,false);assert.equal(row.operational_assurance,"not-established");
    assert.equal((await admin.query("SELECT event_name FROM nukhabapay.staff_request_audit WHERE operation_id=$1",[result.operationId])).rows[0].event_name,"SYNTHETIC_REVIEW_OBSERVED");
    assert.equal((await admin.query("SELECT state FROM nukhabapay.staff_access_requests WHERE request_id=$1",[request.requestId])).rows[0].state,"SUBMITTED");
    assert.equal((await admin.query("SELECT status FROM nukhabapay.staff_users WHERE id=$1",[f.target])).rows[0].status,"ACTIVE");
  });
  await t.test("approval intake identical replay is stable while changed request or evidence payload conflicts",async()=>{
    const request=await f.createRequest(),who=await actor(),p=await proof(request,who),cmd=command(request),first=await recorded(who,cmd,p);
    const replay=await boundary.intakeStaffApproval(who.actor,cmd,p);assert.equal(replay.kind,"REPLAYED");if(replay.kind==="REPLAYED")assert.equal(replay.operationId,first.operationId);
    const newProof=await proof(request,who);await denied(boundary.intakeStaffApproval(who.actor,cmd,newProof),"CONFLICT");
    const different=await f.createRequest(),differentProof=await proof(different,who);await denied(boundary.intakeStaffApproval(who.actor,command(different,cmd.key),differentProof),"CONFLICT");
    await tuple(first.operationId,1);await denied(boundary.intakeStaffApproval(who.actor,{...cmd,key:randomUUID()},p));
  });
  await t.test("approval intake requires its own explicit capability and rejects forged actors proof JSON MFA flags and receipts",async()=>{
    const request=await f.createRequest(),who=await actor(),p=await proof(request,who),cmd=command(request);
    for(const value of [{},{...who.actor},f.reviewer])await denied(boundary.intakeStaffApproval(value as TrustedStaffActor,cmd,p));
    for(const value of [{},{...p},{mfa:true,approved:true},{outcome:"SIMULATION_RECORDED",execution:"NOT_AUTHORIZED"},who.token])
      await denied(boundary.intakeStaffApproval(who.actor,cmd,value as VerifiedSyntheticApprovalProvenance));
    for(const extra of [{mfa:true},{approved:true},{receipt:{kind:"RECORDED"}},{actorStaffId:f.reviewer},{tenantId:f.tenant}])await denied(boundary.intakeStaffApproval(who.actor,{...cmd,...extra},p));
    await denied(boundary.intakeStaffApproval(who.actor,cmd));enabled=false;try{await denied(boundary.intakeStaffApproval(who.actor,cmd,p));}finally{enabled=true;}
    const {syntheticApprovalIntake:omitted,...legacyOnly}=base;void omitted;
    const b=new TrustedStaffActorBoundary(legacyOnly),other=await actor("durable-reviewer",undefined,b),otherProof=await proof(request,other,b);
    await denied(b.intakeStaffApproval(other.actor,cmd,otherProof));await tuple(operation(cmd.key),0);
  });
  await t.test("approval intake rejects self beneficiary and duplicate canonical people through alternate identities",async()=>{
    const request=await f.createRequest(),who=await actor(),p=await proof(request,who);
    for(const sub of ["actor-a","actor-alternate","actor-other"]){const forbidden=await actor(sub);await denied(boundary.intakeStaffApproval(forbidden.actor,command(request),p));assert.equal((await boundary.beginSyntheticApprovalChallenge(forbidden.actor,request.requestId!)).allowed,false);}
    await recorded(who,command(request),p);
    const alternate=await actor("durable-alternate"),duplicate=await proof(request,alternate);await denied(boundary.intakeStaffApproval(alternate.actor,command(request),duplicate));
    const independent=await actor("durable-governance"),separate=await proof(request,independent);await recorded(independent,command(request),separate);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM nukhabapay.staff_review_observations WHERE request_id=$1",[request.requestId])).rows[0].n,2);
  });
  await t.test("approval intake preserves immutable prior participation instead of upgrading an ordinary review",async()=>{
    const request=await f.createRequest(),who=await actor(),key=randomUUID();
    assert.equal((await boundary.recordStaffRequest(who.actor,{kind:"REVIEW",key,id:request.requestId!,version:BigInt(request.version!),requestDigest:request.requestDigest!})).kind,"RECORDED");
    const p=await proof(request,who),cmd=command(request);await denied(boundary.intakeStaffApproval(who.actor,cmd,p));await tuple(operation(cmd.key),0);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM nukhabapay.staff_synthetic_provenance WHERE request_id=$1",[request.requestId])).rows[0].n,0);
  });
  await t.test("approval intake denies suspended disabled stale revoked or conflicting approver authority",async()=>{
    const request=await f.createRequest(),who=await actor(),p=await proof(request,who),cmd=command(request);
    for(const status of ["SUSPENDED","DISABLED"]){await admin.query("UPDATE nukhabapay.staff_users SET status=$2 WHERE id=$1",[f.reviewer,status]);try{await denied(boundary.intakeStaffApproval(who.actor,cmd,p));}finally{await admin.query("UPDATE nukhabapay.staff_users SET status='ACTIVE' WHERE id=$1",[f.reviewer]);}}
    await admin.query("UPDATE nukhabapay.staff_users SET authz_version=authz_version+1 WHERE id=$1",[f.reviewer]);try{await denied(boundary.intakeStaffApproval(who.actor,cmd,p));}finally{await admin.query("UPDATE nukhabapay.staff_users SET authz_version=authz_version-1 WHERE id=$1",[f.reviewer]);}
    await admin.query("UPDATE nukhabapay.platform_role_grants SET revoked_at=$2 WHERE staff_id=$1 AND role_code='SECURITY_ADMIN'",[f.reviewer,new Date(NOW)]);
    try{await denied(boundary.intakeStaffApproval(who.actor,cmd,p));}finally{await admin.query("UPDATE nukhabapay.platform_role_grants SET revoked_at=NULL WHERE staff_id=$1 AND role_code='SECURITY_ADMIN'",[f.reviewer]);}
    const conflict=randomUUID();await admin.query("INSERT INTO nukhabapay.platform_role_grants(id,staff_id,role_code,granted_at,grant_source,evidence_reference) VALUES($1,$2,'ACCESS_ADMIN','2025-01-01','TEST','intake.synthetic')",[conflict,f.reviewer]);
    try{await denied(boundary.intakeStaffApproval((await actor()).actor,cmd,p));}finally{await admin.query("DELETE FROM nukhabapay.platform_role_grants WHERE id=$1",[conflict]);}
    await tuple(operation(cmd.key),0);
  });
  await t.test("approval intake rechecks request version policy digest expiry requester and target authority",async()=>{
    const request=await f.createRequest(),who=await actor(),p=await proof(request,who),cmd=command(request);
    await denied(boundary.intakeStaffApproval(who.actor,{...cmd,policyVersion:"unapproved" as never},p));await denied(boundary.intakeStaffApproval(who.actor,{...cmd,requestDigest:"f".repeat(64)},p));
    for(const person of [f.target,f.staff]){await admin.query("UPDATE nukhabapay.staff_users SET authz_version=authz_version+1 WHERE id=$1",[person]);try{await denied(boundary.intakeStaffApproval(who.actor,cmd,p));}finally{await admin.query("UPDATE nukhabapay.staff_users SET authz_version=authz_version-1 WHERE id=$1",[person]);}}
    f.setNow(NOW+600001);try{await denied(boundary.intakeStaffApproval((await actor()).actor,cmd,p));}finally{f.setNow(NOW);}
    await f.reviseRequest(request);await denied(boundary.intakeStaffApproval(who.actor,cmd,p));await tuple(operation(cmd.key),0);
  });
  await t.test("approval intake exact tenant membership and scope deny revoked or cross-tenant participation",async()=>{
    const request=await f.createTenantRequest(),who=await actor("durable-reviewer",f.tenant),p=await proof(request,who),cmd=command(request);
    await denied(boundary.intakeStaffApproval((await actor()).actor,cmd,p));
    await admin.query("UPDATE nukhabapay.staff_memberships SET status='REVOKED' WHERE staff_id=$1 AND tenant_id=$2",[f.reviewer,f.tenant]);
    try{await denied(boundary.intakeStaffApproval(who.actor,cmd,p));}finally{await admin.query("UPDATE nukhabapay.staff_memberships SET status='ACTIVE' WHERE staff_id=$1 AND tenant_id=$2",[f.reviewer,f.tenant]);}
    const result=await recorded(who,cmd,p);assert.equal((await admin.query("SELECT scope_key FROM nukhabapay.staff_synthetic_provenance WHERE operation_id=$1",[result.operationId])).rows[0].scope_key,f.tenant);
    const membership=randomUUID(),grant=randomUUID();await admin.query("INSERT INTO nukhabapay.staff_memberships(id,staff_id,tenant_id,status) VALUES($1,$2,$3,'ACTIVE')",[membership,f.reviewer,f.otherTenant]);
    await admin.query("INSERT INTO nukhabapay.tenant_role_grants(id,membership_id,tenant_id,role_code,granted_at,grant_source,evidence_reference) VALUES($1,$2,$3,'TENANT_ADMIN','2025-01-01','TEST','intake.synthetic')",[grant,membership,f.otherTenant]);
    try{const foreign=await actor("durable-reviewer",f.otherTenant);await denied(boundary.intakeStaffApproval(foreign.actor,{...cmd,kind:"RECONCILE"}),"UNRESOLVED");}
    finally{await admin.query("DELETE FROM nukhabapay.tenant_role_grants WHERE id=$1",[grant]);await admin.query("DELETE FROM nukhabapay.staff_memberships WHERE id=$1",[membership]);}
  });
  await t.test("approval intake all staged evidence audit receipt and outbox failures roll back before same-key retry",async()=>{
    for(const table of tupleTables){const request=await f.createRequest(),who=await actor(),p=await proof(request,who),cmd=command(request);
      await admin.query(`REVOKE INSERT ON nukhabapay.${table} FROM "${f.config.expectedRole}"`);
      try{await denied(boundary.intakeStaffApproval(who.actor,cmd,p));await tuple(operation(cmd.key),0);}finally{await admin.query(`GRANT INSERT ON nukhabapay.${table} TO "${f.config.expectedRole}"`);}
      await recorded(who,cmd,p);
    }
  });
  await t.test("approval intake concurrent independent PostgreSQL connections converge without duplicate evidence",async()=>{
    const other=await createDurableStaffRequestStore(f.config);
    try{const shared=new TrustedStaffActorBoundary({...base,syntheticApprovalIntake:{...intake,execute:ticket=>ticket.command.key.endsWith("0")?other.execute(ticket):f.store.execute(ticket)}});
      let index=0;const concurrent=new TrustedStaffActorBoundary({...base,syntheticApprovalIntake:{...intake,execute:ticket=>++index%2?f.store.execute(ticket):other.execute(ticket)}});
      const request=await f.createRequest(),who=await actor("durable-reviewer",undefined,concurrent),p=await proof(request,who,concurrent),cmd=command(request);
      const values=await Promise.all([concurrent.intakeStaffApproval(who.actor,cmd,p),concurrent.intakeStaffApproval(who.actor,cmd,p),concurrent.intakeStaffApproval(who.actor,cmd,p)]);
      assert.equal(values.filter(v=>v.kind==="RECORDED").length,1);assert.equal(values.filter(v=>v.kind==="REPLAYED").length,2);await tuple(operation(cmd.key),1);
      const fresh=await f.createRequest(),first=await actor("durable-reviewer",undefined,shared),second=await actor("durable-alternate",undefined,shared),a=await proof(fresh,first,shared),b=await proof(fresh,second,shared);
      const attempts=await Promise.all([shared.intakeStaffApproval(first.actor,command(fresh),a),shared.intakeStaffApproval(second.actor,command(fresh),b)]);
      assert.equal(attempts.filter(v=>v.kind==="RECORDED").length,1);assert.equal(attempts.filter(v=>v.kind==="DENIED").length,1);
    }finally{await other.close();}
  });
  await t.test("approval intake lost commit acknowledgement reconciles only authoritative owned classified evidence",async()=>{
    const proxy=await commitLossProxy(new URL(f.config.connectionString));let store:Awaited<ReturnType<typeof createDurableStaffRequestStore>>|undefined;
    const request=await f.createRequest(),cmd=command(request);
    try{const url=new URL(proxy.url);url.search="";store=await createDurableStaffRequestStore({...f.config,connectionString:url.href});
      const b=new TrustedStaffActorBoundary({...base,syntheticApprovalIntake:{...intake,execute:store.execute}}),who=await actor("durable-reviewer",undefined,b),p=await proof(request,who,b);
      proxy.arm("before-ack",2);await denied(b.intakeStaffApproval(who.actor,cmd,p),"UNRESOLVED");assert.equal(proxy.cut,true);
    }finally{await store?.close();await proxy.close();}
    const who=await actor(),result=await boundary.intakeStaffApproval(who.actor,{...cmd,kind:"RECONCILE"});assert.equal(result.kind,"REPLAYED");await tuple(operation(cmd.key),1);
    await denied(boundary.intakeStaffApproval((await actor("durable-governance")).actor,{...cmd,kind:"RECONCILE"}),"UNRESOLVED");
    await denied(boundary.intakeStaffApproval(who.actor,{...cmd,kind:"RECONCILE",requestDigest:"b".repeat(64)}));
    await denied(boundary.intakeStaffApproval(who.actor,{...command(request),kind:"RECONCILE"}),"UNRESOLVED");
  });
  await t.test("approval intake historical reconciliation survives proof expiry and superseded requests without reauthorizing approval",async()=>{
    const request=await f.createRequest(),who=await actor(),p=await proof(request,who),cmd=command(request);await recorded(who,cmd,p);await f.reviseRequest(request);
    f.setNow(NOW+600001);
    try{const current=await actor();await denied(boundary.intakeStaffApproval(current.actor,cmd,p));const result=await boundary.intakeStaffApproval(current.actor,{...cmd,kind:"RECONCILE"});assert.equal(result.kind,"REPLAYED");assert.equal(result.privilegedApproval,"BLOCKED");}
    finally{f.setNow(NOW);}
  });
  await t.test("approval intake reconciliation cannot relabel plain review or submission receipts as synthetic attempt evidence",async()=>{
    const request=await f.createRequest(),who=await actor(),key=randomUUID();
    assert.equal((await boundary.recordStaffRequest(who.actor,{kind:"REVIEW",key,id:request.requestId!,version:BigInt(request.version!),requestDigest:request.requestDigest!})).kind,"RECORDED");
    await denied(boundary.intakeStaffApproval(who.actor,command(request,key,"RECONCILE")));
    const submission:StaffRequestCommand={kind:"SUBMIT",key:randomUUID(),id:randomUUID(),version:1n,previousDigest:null,targetStaffId:f.target,operation:{kind:"SUSPEND",target:"STAFF"},proposedRoles:[],expectedAuthzVersion:0n,expectedMembershipVersion:null,expiresAtMs:NOW+600000};
    const own=await boundary.recordStaffRequest(who.actor,submission);assert.equal(own.kind,"RECORDED",JSON.stringify(own));await denied(boundary.intakeStaffApproval(who.actor,command(own,submission.key,"RECONCILE")));
  });
  await t.test("approval intake uses only opaque one-use tickets and sanitizes substituted persistence results",async()=>{
    let captured:AuthorizedStaffRequest|undefined;
    const b=new TrustedStaffActorBoundary({...base,syntheticApprovalIntake:{...intake,execute:async ticket=>{captured=ticket;assert.equal((await f.store.execute({...ticket} as AuthorizedStaffRequest)).kind,"DENIED");return f.store.execute(ticket);}}});
    const request=await f.createRequest(),who=await actor("durable-reviewer",undefined,b),p=await proof(request,who,b);await recorded(who,command(request),p,b);assert.ok(captured);assert.equal((await f.store.execute(captured)).kind,"DENIED");
    const altered=new TrustedStaffActorBoundary({...base,syntheticApprovalIntake:{...intake,execute:async ticket=>({...await f.store.execute(ticket),requestId:randomUUID()})}});
    const next=await f.createRequest(),person=await actor("durable-reviewer",undefined,altered),signed=await proof(next,person,altered);await denied(altered.intakeStaffApproval(person.actor,command(next),signed),"UNRESOLVED");
  });
  await t.test("approval intake audit and dependency outages cannot disclose successful reconciliation or fake evidence",async()=>{
    const request=await f.createRequest(),who=await actor(),p=await proof(request,who),cmd=command(request);await recorded(who,cmd,p);
    await admin.query("REVOKE INSERT ON nukhabapay.security_audit_events FROM nukhabapay_identity_writer");try{await denied(boundary.intakeStaffApproval(who.actor,{...cmd,kind:"RECONCILE"}),"UNRESOLVED");}finally{await admin.query("GRANT INSERT ON nukhabapay.security_audit_events TO nukhabapay_identity_writer");}
    await admin.query("REVOKE SELECT(status) ON nukhabapay.staff_users FROM nukhabapay_identity_reader");try{await denied(boundary.intakeStaffApproval(who.actor,{...cmd,kind:"RECONCILE"}));}finally{await admin.query("GRANT SELECT(status) ON nukhabapay.staff_users TO nukhabapay_identity_reader");}
    const closed=await createDurableStaffRequestStore(f.config);await closed.close();const b=new TrustedStaffActorBoundary({...base,syntheticApprovalIntake:{...intake,execute:closed.execute}});
    await denied(b.intakeStaffApproval((await actor("durable-reviewer",undefined,b)).actor,{...cmd,kind:"RECONCILE"}));
  });
  await t.test("approval intake preserves restricted IAM catalogue RLS and staff execution privileges",async()=>{
    for(const name of ["nukhabapay_runtime","nukhabapay_importer","nukhabapay_identity_reader","nukhabapay_identity_writer"]){for(const table of tupleTables)assert.equal((await admin.query("SELECT has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE') OR has_table_privilege($1,$2,'DELETE,TRUNCATE') AS ok",[name,"nukhabapay."+table])).rows[0].ok,false);}
    for(const table of tupleTables){const rights=(await admin.query("SELECT has_table_privilege($1,$2,'SELECT') AS read,has_table_privilege($1,$2,'INSERT') AS append,has_table_privilege($1,$2,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS excess,(SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid=$2::regclass) AS rls",[f.config.expectedRole,"nukhabapay."+table])).rows[0];assert.deepEqual(rights,{read:true,append:true,excess:false,rls:true});}
    assert.equal((await admin.query("SELECT has_any_column_privilege($1,'nukhabapay.staff_users','INSERT,UPDATE') OR has_function_privilege($1,'nukhabapay.execute_staff_command(jsonb)','EXECUTE') AS ok",[f.config.expectedRole])).rows[0].ok,false);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM nukhabapay.staff_synthetic_provenance WHERE accepted_approval OR operational_assurance<>'not-established' OR execution<>'NOT_AUTHORIZED'")).rows[0].n,0);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 AND state LIKE 'idle in transaction%'",[f.config.expectedRole])).rows[0].n,0);
    console.info("Approval intake: existing seven-table/27-IAM-column restricted profile only; atomic synthetic evidence; accepted approval and APPLY remain blocked; no schema/grant expansion.");
  });
}
