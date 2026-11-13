import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import type { TestContext } from "node:test";
import { SignJWT } from "jose";
import { Client } from "pg";
import { createDurableStaffRequestStore } from "@nukhbapay/database";
import { TrustedStaffActorBoundary, type StaffRequestResult, type StaffRequestCommand, type TrustedStaffActor,
  type VerifiedSyntheticApprovalProvenance, type SyntheticAssuranceChallenge, type StaffAuthorizationContext, type StaffAuthorizationRepository, type SecurityAuditWriter } from "@nukhbapay/application";
import { LocalSyntheticAssuranceVerifier } from "../../src/modules/identity/synthetic-assurance-verifier.js";
import { OidcAccessTokenVerifier } from "../../src/modules/identity/oidc-access-token.verifier.js";
import { signingKey, claims, environment, keySource, NOW } from "./oidc-test-issuer.js";
import { syntheticAssuranceProvider } from "./synthetic-assurance-provider.js";
import { forDatabase } from "./disposable-iam-database.js";
import { commitLossProxy } from "./commit-loss-proxy.js";
import { workflowMigrationInstalled, grantWorkflowBackend } from "./workflow-migration.js";
import {approvalIntakeAcceptance} from "./approval-intake-acceptance.js";

export async function approvalProvenanceAcceptance(t: TestContext, f: {
  admin: Client; databaseUrl: string; staff: string; reviewer: string; governance: string; target: string; tenant: string; otherTenant: string;
  runtime: { repository: StaffAuthorizationRepository; auditWriter: SecurityAuditWriter };
  createRequest(): Promise<StaffRequestResult>;
  createTenantRequest(): Promise<StaffRequestResult>;
  reviseRequest(request: StaffRequestResult): Promise<StaffRequestResult>;
}) {
  const { admin } = f;
  const database = (await admin.query("SELECT current_database() AS name")).rows[0].name as string;
  assert.match(database, /^nukhabapay_b3b3_[0-9a-f]{32}$/);
  const migration = new Client({ connectionString: forDatabase(process.env["DB_MIGRATION_URL"]!, database) }); await migration.connect();
  try { assert.equal((await migration.query("SELECT current_database() AS name")).rows[0].name, database); await migration.query("BEGIN");
    assert.equal(await workflowMigrationInstalled(migration),true); await migration.query("COMMIT");
  } catch (error) { await migration.query("ROLLBACK"); throw error; } finally { await migration.end(); }
  const role = "nukh_request_" + randomUUID().replaceAll("-", "").slice(0,20); assert.match(role,/^nukh_request_[0-9a-f]{20}$/);
  const tables = ["staff_request_operations","staff_access_requests","staff_review_observations","staff_request_audit","staff_request_receipts","staff_request_outbox","staff_synthetic_provenance"];
  const projection = { staff_users:"id,status,authz_version",staff_identities:"staff_id,issuer,subject,status",staff_memberships:"id,staff_id,tenant_id,status,version",
    platform_role_grants:"id,staff_id,role_code,scope,granted_at,expires_at,revoked_at",tenant_role_grants:"id,membership_id,tenant_id,role_code,scope,granted_at,expires_at,revoked_at" };
  const url = new URL(f.databaseUrl); url.username=role;url.password=randomUUID();
  const config = {connectionString:url.href,expectedRole:role,expectedDatabase:database,syntheticProvenance:"LOCAL_SYNTHETIC_ONLY" as const};
  const stores: Awaited<ReturnType<typeof createDurableStaffRequestStore>>[] = [];
  await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
  try {
    await grantWorkflowBackend(admin,role,true);
    const store = await createDurableStaffRequestStore(config);stores.push(store);
    let nowMs=NOW;
    const now=()=>new Date(nowMs);
    const accessKey=await signingKey("day4-access-key"),source=keySource([accessKey.publicJwk]);
    const accessVerifier=new OidcAccessTokenVerifier(environment(),{fetchKeys:source.fetchKeys,now});
    const provider=await syntheticAssuranceProvider(accessVerifier,now);
    const assurance=new LocalSyntheticAssuranceVerifier({mode:"test",keys:[provider.publicJwk],now});
    const requests={find:async(id:string,tenantId?:string)=>{
      const c=new Client({connectionString:url.href,connectionTimeoutMillis:3000,statement_timeout:3000});
      try{await c.connect();await c.query("BEGIN READ ONLY");await c.query("SELECT set_config('nukhabapay.workflow_scope',$1,true)",[tenantId??"PLATFORM"]);
        const r=(await c.query("SELECT request_id,version,request_digest,requester_staff_id,target_staff_id,tenant_id,expires_at_ms,policy_version FROM nukhabapay.staff_access_requests WHERE request_id=$1 AND state='SUBMITTED' ORDER BY version DESC LIMIT 1",[id])).rows[0];
        await c.query("COMMIT"); return r?Object.freeze({id:r.request_id,version:String(r.version),digest:r.request_digest,requesterStaffId:r.requester_staff_id,beneficiaryStaffId:r.target_staff_id,
          tenantId:r.tenant_id,expiresAt:new Date(Number(r.expires_at_ms)).toISOString(),policyVersion:r.policy_version,permission:"platform.access.approve" as const}):null;
      }finally{await c.end();}
    }};
    const admittedPeople=new Set([f.staff,f.reviewer,f.governance,f.target]);
    const base={...f.runtime,now,requests,syntheticAssuranceVerifier:assurance,syntheticRequests:{capability:"NON_AUTHORIZED_STAFF_REQUESTS" as const,
      allows:async(context:StaffAuthorizationContext)=>admittedPeople.has(context.principal!.staffId) &&
        (context.membership===null || [f.tenant,f.otherTenant].includes(context.membership.tenantId)),execute:store.execute}};
    // Explicit server test policy permits recording attempts only; actor/role/request checks still apply.
    const boundary=new TrustedStaffActorBoundary(base);
    async function actor(sub="durable-reviewer",scope?:string,b=boundary){const token=await accessKey.sign(claims({sub}));const identity=await accessVerifier.verify(token);
      assert.equal(identity.security.assurance,"not-established");const found=await b.establish(identity,scope);assert.equal(found.allowed,true);if(!found.allowed)throw new Error("Synthetic actor fixture denied");return {actor:found.actor,token};}
    async function challenge(request:StaffRequestResult,who:Awaited<ReturnType<typeof actor>>,b=boundary){const result=await b.beginSyntheticApprovalChallenge(who.actor,request.requestId!);
      assert.equal(result.allowed,true,JSON.stringify(result));if(!result.allowed)throw new Error("Synthetic challenge denied");return result.challenge;}
    async function proof(request:StaffRequestResult,who:Awaited<ReturnType<typeof actor>>,b=boundary){const expected=await challenge(request,who,b),assertion=await provider.respond(expected,who.token);
      const result=await b.verifySyntheticApprovalProvenance(who.actor,expected,assertion);assert.equal(result.allowed,true,JSON.stringify(result));if(!result.allowed)throw new Error("Synthetic provenance denied");return {provenance:result.provenance,assertion,challenge:expected};}
    const command=(r:StaffRequestResult,key=randomUUID()):Extract<StaffRequestCommand,{kind:"REVIEW"}>=>({kind:"REVIEW",key,id:r.requestId!,version:BigInt(r.version!),requestDigest:r.requestDigest!});
    async function tuple(operation:string,count:number){for(const table of ["staff_request_operations","staff_review_observations","staff_synthetic_provenance","staff_request_audit","staff_request_receipts","staff_request_outbox"])assert.equal((await admin.query(`SELECT count(*)::int AS n FROM nukhabapay.${table} WHERE operation_id=$1`,[operation])).rows[0].n,count);}
    await t.test("signed synthetic provenance is immutable exact-actor evidence and remains non-operational",async()=>{
      const request=await f.createRequest(),who=await actor(),signed=await proof(request,who);
      assert.ok(Object.isFrozen(signed.provenance));assert.ok(Object.isFrozen(signed.provenance.binding));
      assert.equal(signed.provenance.binding.staffId,f.reviewer);assert.equal(signed.provenance.binding.requestDigest,request.requestDigest);assert.equal(signed.provenance.binding.tenantId,null);
      assert.equal(signed.provenance.acceptedApproval,false);assert.equal(signed.provenance.operationalAssurance,"not-established");
      const result=await boundary.recordStaffRequest(who.actor,command(request),signed.provenance);assert.equal(result.kind,"RECORDED",JSON.stringify(result));await tuple(result.operationId!,1);
      const row=(await admin.query("SELECT * FROM nukhabapay.staff_synthetic_provenance WHERE operation_id=$1",[result.operationId])).rows[0];
      assert.equal(row.kind,"SYNTHETIC_TEST_EVENT");assert.equal(row.accepted_approval,false);assert.equal(row.record_digest,signed.provenance.recordDigest);
      assert.equal(JSON.stringify(row).includes(signed.assertion),false);
      assert.equal((await boundary.inspectApproval(who.actor,request.requestId!)).allowed,false);
      assert.equal((await admin.query("SELECT state FROM nukhabapay.staff_access_requests WHERE request_id=$1",[request.requestId])).rows[0].state,"SUBMITTED");
    });
    await t.test("forged signatures token profiles claims keys and client MFA flags cannot establish provenance",async()=>{
      const request=await f.createRequest(),who=await actor(),wrong=await signingKey("synthetic-assurance-key");
      const mutations:Record<string,unknown>[]=[{iss:"https://untrusted.synthetic.invalid/"},{aud:"wrong"},{sub:"actor-other"},{synthetic:false},{profile:"real-mfa"},
        {binding_digest:"0".repeat(64)},{challenge_id:randomUUID()},{mfa:true,amr:["mfa"],acr:"strong"},{auth_time:NOW/1000-1},{auth_time:NOW/1000+1},{exp:NOW/1000-1},{exp:NOW/1000+300}];
      mutations.push({aud:"urn:nukhabapay:synthetic:approval-provenance"},
        {aud:"urn:naukhbapay:synthetic:approval-provenance"},
        {aud:"urn:nuakhbapay:synthetic:approval-provenance"});
      for(const change of mutations){const expected=await challenge(request,who);const assertion=await provider.signFault({...provider.payload(expected),...change});assert.equal((await boundary.verifySyntheticApprovalProvenance(who.actor,expected,assertion)).allowed,false);}
      for(const field of ["jti","auth_time","profile","synthetic"]){const expected=await challenge(request,who);const p:Record<string,unknown>={...provider.payload(expected)};delete p[field];assert.equal((await boundary.verifySyntheticApprovalProvenance(who.actor,expected,await provider.signFault(p))).allowed,false);}
      for(const kind of ["wrong-signature","wrong-type","unknown-key","hs256","json","access-token"]){const expected=await challenge(request,who),payload=provider.payload(expected);
        const assertion=kind==="wrong-signature"?await wrong.sign(payload,{typ:"synthetic-assurance+jwt"}):kind==="wrong-type"?await provider.signFault(payload,{typ:"at+jwt"}):kind==="unknown-key"?await provider.signFault(payload,{kid:"unknown-key"}):kind==="hs256"?await new SignJWT(payload).setProtectedHeader({alg:"HS256",typ:"synthetic-assurance+jwt",kid:"synthetic-assurance-key"}).sign(randomBytes(32)):kind==="json"?JSON.stringify({mfa:true,approved:true}):who.token;
        assert.equal((await boundary.verifySyntheticApprovalProvenance(who.actor,expected,assertion)).allowed,false);
      }
      assert.throws(()=>new LocalSyntheticAssuranceVerifier({mode:"production" as never,keys:[provider.publicJwk],now}));
      assert.throws(()=>new LocalSyntheticAssuranceVerifier({mode:"test",keys:[{...provider.publicJwk,d:"private-material"}],now}));
    });
    await t.test("self beneficiary wrong actor cloned challenge and forged proof are rejected",async()=>{
      const request=await f.createRequest(),who=await actor(),other=await actor("durable-governance");
      for(const sub of ["actor-a","actor-alternate","actor-other"]){const self=await actor(sub);assert.equal((await boundary.beginSyntheticApprovalChallenge(self.actor,request.requestId!)).allowed,false);}
      const expected=await challenge(request,who),assertion=await provider.respond(expected,who.token);
      await assert.rejects(()=>provider.respond(expected,other.token));
      assert.equal((await boundary.verifySyntheticApprovalProvenance(other.actor,expected,assertion)).allowed,false);
      assert.equal((await boundary.verifySyntheticApprovalProvenance(who.actor,{...expected} as SyntheticAssuranceChallenge,assertion)).allowed,false);
      const result=await boundary.verifySyntheticApprovalProvenance(who.actor,expected,assertion);assert.equal(result.allowed,true);
      if(result.allowed){assert.equal((await boundary.recordStaffRequest(who.actor,command(request),{...result.provenance} as VerifiedSyntheticApprovalProvenance)).kind,"DENIED");
        assert.equal((await boundary.recordStaffRequest(other.actor,command(request),result.provenance)).kind,"DENIED");}
      assert.equal((await boundary.beginSyntheticApprovalChallenge({} as TrustedStaffActor,request.requestId!)).allowed,false);
      const disabled=new TrustedStaffActorBoundary({...f.runtime,now,requests});const d=await actor("durable-reviewer",undefined,disabled);
      assert.equal((await disabled.beginSyntheticApprovalChallenge(d.actor,request.requestId!)).allowed,false);
    });
    await t.test("stale actor request scope and expired synthetic evidence never record reviews",async()=>{
      const request=await f.createRequest(),who=await actor(),signed=await proof(request,who);
      await admin.query("UPDATE nukhabapay.staff_users SET authz_version=authz_version+1 WHERE id=$1",[f.reviewer]);
      assert.equal((await boundary.recordStaffRequest(who.actor,command(request),signed.provenance)).kind,"DENIED");
      const current=await actor(),old=await proof(request,current);await f.reviseRequest(request);
      assert.equal((await boundary.recordStaffRequest(current.actor,command(request),old.provenance)).kind,"DENIED");
      const targetRequest=await f.createRequest(),targetActor=await actor(),targetProof=await proof(targetRequest,targetActor);
      await admin.query("UPDATE nukhabapay.staff_users SET authz_version=authz_version+1 WHERE id=$1",[f.target]);
      try{assert.equal((await boundary.recordStaffRequest(targetActor.actor,command(targetRequest),targetProof.provenance)).reason,"STALE_TARGET");}
      finally{await admin.query("UPDATE nukhabapay.staff_users SET authz_version=authz_version-1 WHERE id=$1",[f.target]);}
      const fresh=await f.createRequest(),active=await actor(),expired=await proof(fresh,active);
      nowMs=NOW+61000;
      try{assert.equal((await boundary.recordStaffRequest(active.actor,command(fresh),expired.provenance)).kind,"DENIED");}finally{nowMs=NOW;}
      const tenantRequest=await f.createTenantRequest(),member=await actor("durable-reviewer",f.tenant),tenantProof=await proof(tenantRequest,member);
      assert.equal((await boundary.recordStaffRequest(member.actor,command(tenantRequest),tenantProof.provenance)).kind,"RECORDED");
      const foreign=await actor("actor-a",f.otherTenant);assert.equal((await boundary.beginSyntheticApprovalChallenge(foreign.actor,tenantRequest.requestId!)).allowed,false);
    });
    await t.test("challenge event proof and canonical-person replay cannot duplicate durable evidence",async()=>{
      const request=await f.createRequest(),who=await actor(),signed=await proof(request,who),cmd=command(request);
      assert.equal((await boundary.verifySyntheticApprovalProvenance(who.actor,signed.challenge,signed.assertion)).allowed,false);
      const outcomes=await Promise.all([boundary.recordStaffRequest(who.actor,cmd,signed.provenance),boundary.recordStaffRequest(who.actor,cmd,signed.provenance)]);
      assert.equal(outcomes.filter(r=>r.kind==="RECORDED").length,1);assert.equal(outcomes.filter(r=>r.kind==="REPLAYED").length,1);await tuple(outcomes[0]!.operationId!,1);
      assert.equal((await boundary.recordStaffRequest(who.actor,command(request),signed.provenance)).kind,"DENIED");
      const alternate=await actor("durable-alternate"),second=await proof(request,alternate);
      assert.equal((await boundary.recordStaffRequest(alternate.actor,command(request),second.provenance)).reason,"DUPLICATE_PERSON");
      const another=await f.createRequest(),expected=await challenge(another,who);
      const replay=await provider.signFault({...provider.payload(expected),jti:signed.provenance.authenticationEventId});
      assert.equal((await boundary.verifySyntheticApprovalProvenance(who.actor,expected,replay)).allowed,false);
      // A second process-local registry cannot erase durable event uniqueness.
      const independent=new TrustedStaffActorBoundary(base),fresh=await f.createRequest(),freshActor=await actor("durable-reviewer",undefined,independent),freshChallenge=await challenge(fresh,freshActor,independent);
      const duplicate=await provider.signFault({...provider.payload(freshChallenge),jti:signed.provenance.authenticationEventId});
      const verified=await independent.verifySyntheticApprovalProvenance(freshActor.actor,freshChallenge,duplicate);assert.equal(verified.allowed,true);
      if(verified.allowed)assert.equal((await independent.recordStaffRequest(freshActor.actor,command(fresh),verified.provenance)).kind,"DENIED");
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM nukhabapay.staff_review_observations WHERE request_id=$1",[fresh.requestId])).rows[0].n,0);
    });
    await t.test("provenance and audit failures roll back observation evidence receipt and outbox atomically",async()=>{
      for(const table of ["staff_synthetic_provenance","staff_request_audit"]){const request=await f.createRequest(),who=await actor(),signed=await proof(request,who),cmd=command(request);
        await admin.query(`REVOKE INSERT ON nukhabapay.${table} FROM "${role}"`);
        try{assert.equal((await boundary.recordStaffRequest(who.actor,cmd,signed.provenance)).kind,"DENIED");assert.equal((await admin.query("SELECT count(*)::int AS n FROM nukhabapay.staff_review_observations WHERE request_id=$1",[request.requestId])).rows[0].n,0);}
        finally{await admin.query(`GRANT INSERT ON nukhabapay.${table} TO "${role}"`);}
        const retry=await boundary.recordStaffRequest(who.actor,cmd,signed.provenance);assert.equal(retry.kind,"RECORDED",JSON.stringify(retry));await tuple(retry.operationId!,1);
      }
    });
    await t.test("lost artifact commit acknowledgement reconciles provenance without accepting an approval",async()=>{
      const proxy=await commitLossProxy(url),proxyUrl=new URL(proxy.url);proxyUrl.search="";
      let uncertainStore:Awaited<ReturnType<typeof createDurableStaffRequestStore>>|undefined;
      const request=await f.createRequest(),cmd=command(request);
      try{uncertainStore=await createDurableStaffRequestStore({...config,connectionString:proxyUrl.href});stores.push(uncertainStore);
        const b=new TrustedStaffActorBoundary({...base,syntheticRequests:{...base.syntheticRequests,execute:uncertainStore.execute}}),who=await actor("durable-reviewer",undefined,b),signed=await proof(request,who,b);
        proxy.arm("before-ack",2);const result=await b.recordStaffRequest(who.actor,cmd,signed.provenance);
        assert.equal(result.kind,"UNRESOLVED");assert.equal(result.requestDigest,undefined);assert.equal(proxy.cut,true);
      }finally{await uncertainStore?.close();await proxy.close();}
      const who=await actor(),lookup=await boundary.recordStaffRequest(who.actor,{kind:"LOOKUP",key:cmd.key,id:cmd.id,version:cmd.version});
      assert.equal(lookup.kind,"REPLAYED");assert.equal(lookup.acceptedApproval,false);await tuple(lookup.operationId!,1);
      assert.equal((await boundary.recordStaffRequest(who.actor,cmd)).kind,"CONFLICT"); // Dropping provenance changes the command.
    });
    await t.test("proof data stays tenant-isolated immutable non-approved and unavailable to ordinary roles",async()=>{
      for(const name of ["nukhabapay_runtime","nukhabapay_importer","nukhabapay_identity_reader","nukhabapay_identity_writer",new URL(f.databaseUrl).username])assert.equal((await admin.query("SELECT has_table_privilege($1,'nukhabapay.staff_synthetic_provenance','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS allowed",[name])).rows[0].allowed,false);
      const direct=new Client({connectionString:url.href});await direct.connect();
      try{assert.equal((await direct.query("SELECT * FROM nukhabapay.staff_synthetic_provenance")).rowCount,0);
        for(const sql of ["UPDATE nukhabapay.staff_synthetic_provenance SET accepted_approval=false","DELETE FROM nukhabapay.staff_synthetic_provenance","SELECT contact_email FROM nukhabapay.staff_users","SELECT nukhabapay.execute_staff_command('{}'::jsonb)"])await assert.rejects(()=>direct.query(sql),{code:"42501"});
        await direct.query("BEGIN");await direct.query("SELECT set_config('nukhabapay.workflow_scope',$1,true)",[f.otherTenant]);assert.equal((await direct.query("SELECT * FROM nukhabapay.staff_synthetic_provenance")).rowCount,0);await direct.query("ROLLBACK");
      }finally{await direct.end();}
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM nukhabapay.staff_synthetic_provenance WHERE accepted_approval OR execution<>'NOT_AUTHORIZED' OR operational_assurance<>'not-established'")).rows[0].n,0);
    });
    await t.test("registered provenance constraints reject null tenant bindings and executable markers",async()=>{
      const original=(await admin.query("SELECT * FROM nukhabapay.staff_synthetic_provenance WHERE scope_key<>'PLATFORM' LIMIT 1")).rows[0];assert.ok(original);
      const columns=(await admin.query("SELECT attname FROM pg_attribute WHERE attrelid='nukhabapay.staff_synthetic_provenance'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum")).rows.map(r=>r.attname as string);
      for(const column of columns)assert.match(column,/^[a-z_]+$/);
      const bad=[{...original,binding:{...original.binding,tenantId:null}},
        {...original,binding:{...original.binding,tenantId:randomUUID()}},
        {...original,binding:{...original.binding,staffId:randomUUID()}},
        {...original,accepted_approval:true},{...original,operational_assurance:"mfa"},{...original,execution:"AUTHORIZED"}];
      for(const row of bad){await admin.query("BEGIN");
        try{await assert.rejects(()=>admin.query(`INSERT INTO nukhabapay.staff_synthetic_provenance(${columns.join(",")}) SELECT ${columns.join(",")} FROM jsonb_populate_record(NULL::nukhabapay.staff_synthetic_provenance,$1::jsonb)`,[JSON.stringify(row)]),{code:"23514"});}
        finally{await admin.query("ROLLBACK");}
      }
      await tuple(original.operation_id,1);
    });
    await t.test("unavailable assurance verifier or required audit cannot mint provenance",async()=>{
      const request=await f.createRequest();
      const unavailable=new TrustedStaffActorBoundary({...base,syntheticAssuranceVerifier:{capability:"LOCAL_SYNTHETIC_ASSURANCE_ONLY",verify:async()=>{throw new Error("Synthetic provider unavailable");}}});
      const who=await actor("durable-reviewer",undefined,unavailable),expected=await challenge(request,who,unavailable),assertion=await provider.respond(expected,who.token);
      assert.equal((await unavailable.verifySyntheticApprovalProvenance(who.actor,expected,assertion)).allowed,false);
      let calls=0;
      const auditFailure=new TrustedStaffActorBoundary({...base,auditWriter:{appendSecurityAuditEvents:async events=>{
        if(++calls>=2)throw new Error("Synthetic required audit unavailable");await f.runtime.auditWriter.appendSecurityAuditEvents(events);
      }}});
      const another=await actor("durable-reviewer",undefined,auditFailure),c=await challenge(request,another,auditFailure);
      assert.equal((await auditFailure.verifySyntheticApprovalProvenance(another.actor,c,await provider.respond(c,another.token))).allowed,false);
    });
    await approvalIntakeAcceptance(t,{...f,store,config,now,setNow:ms=>{nowMs=ms;},requests,assurance,
      authenticate:async sub=>{const issued=Math.floor(nowMs/1000),token=await accessKey.sign(claims({sub,iat:issued,exp:issued+300}));return {identity:await accessVerifier.verify(token),token};},
      respond:(challenge,token)=>provider.respond(challenge,token)});
  } finally {
    await Promise.all(stores.map(s=>s.close()));
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename=$1",[role])).rows[0].n,0);
    await admin.query(`REVOKE ALL ON ${tables.map(n=>"nukhabapay."+n).join(",")} FROM "${role}"`);
    for(const [table,columns] of Object.entries(projection))await admin.query(`REVOKE SELECT(${columns}) ON nukhabapay.${table} FROM "${role}"`);
    for(const table of ["staff_memberships","tenant_role_grants"])await admin.query(`DROP POLICY "workflow_${table}_${role.slice(-20)}" ON nukhabapay.${table}`);
    await admin.query(`REVOKE USAGE ON SCHEMA nukhabapay FROM "${role}"`);await admin.query(`REVOKE CONNECT ON DATABASE "${database}" FROM "${role}"`);await admin.query(`DROP ROLE "${role}"`);
  }
}
