import { Pool, type PoolClient } from "pg";
import { consumeAuthorizedStaffRequest, canonicalDigest, staffAuthorityDigest, staffRequestResult, accessChangeRequestDigest,
  planStaffLifecycle, authorizeStaffAccess, STAFF_LIFECYCLE_POLICY_VERSION,
  type AuthorizedStaffRequest, type StaffRequestResult, type AccessChangeRequest, type LifecycleActor, type LifecycleTarget,
  type LifecycleGrant, type StaffAuthorizationContext, type StaffRoleGrant } from "@nukhbapay/application";

class Rejected extends Error { constructor(readonly reason: string) { super("Synthetic staff request rejected"); } }
const baseTables=["staff_request_operations","staff_access_requests","staff_review_observations","staff_request_audit","staff_request_receipts","staff_request_outbox"];
const json=(value:unknown)=>JSON.stringify(value,(_,item:unknown)=>typeof item==="bigint"?item.toString():item);
const ms=(value:Date|string)=>new Date(value).getTime();
const iso=(value:Date|string)=>new Date(value).toISOString();

/** Explicit disposable-target store. No staff mutation, permission activation or runtime registration. */
export async function createDurableStaffRequestStore(input: Readonly<{connectionString:string;expectedRole:string;expectedDatabase:string;syntheticProvenance?:"LOCAL_SYNTHETIC_ONLY"}>) {
  const {connectionString,expectedRole,expectedDatabase,syntheticProvenance}=input;
  const tables=syntheticProvenance==="LOCAL_SYNTHETIC_ONLY"?[...baseTables,"staff_synthetic_provenance"]:baseTables;
  let endpoint="";
  let pool:Pool|undefined;
  const failed=new WeakSet<PoolClient>();
  try {
    const url=new URL(connectionString);
    if((syntheticProvenance!==undefined && syntheticProvenance!=="LOCAL_SYNTHETIC_ONLY") || url.protocol!=="postgresql:" || url.hostname!=="127.0.0.1" || url.search || url.hash || !url.password ||
      decodeURIComponent(url.username)!==expectedRole || !/^nukh_request_[0-9a-f]{20}$/.test(expectedRole) ||
      !/^nukhabapay_b3b3_[0-9a-f]{32}$/.test(expectedDatabase) || url.pathname!=="/"+expectedDatabase ||
      !Number.isInteger(Number(url.port||5432)) || Number(url.port||5432)<1 || Number(url.port||5432)>65535) throw new Error();
    endpoint=url.href;
    pool=new Pool({connectionString:endpoint,max:2,connectionTimeoutMillis:3000,statement_timeout:4000,query_timeout:5000,idleTimeoutMillis:1000,idle_in_transaction_session_timeout:10000});
    pool.on("error",()=>{});pool.on("connect",client=>client.on("error",()=>failed.add(client)));
    const login=(await pool.query(`SELECT current_database() AS database,current_user AS name,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls,
      EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS membership FROM pg_roles r WHERE rolname=current_user`)).rows[0];
    if(login?.database!==expectedDatabase || login.name!==expectedRole || [login.rolsuper,login.rolcreatedb,login.rolcreaterole,login.rolinherit,login.rolbypassrls,login.membership].some(v=>v!==false))throw new Error();
    for(const table of tables){
      const row=(await pool.query(`SELECT has_table_privilege(current_user,$1,'SELECT') AS read,has_table_privilege(current_user,$1,'INSERT') AS append,
        has_table_privilege(current_user,$1,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS excess,
        (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid=$1::regclass) AS rls`,["nukhabapay."+table])).rows[0];
      if(row?.read!==true || row.append!==true || row.excess!==false || row.rls!==true)throw new Error();
    }
    const rights=(await pool.query(`SELECT NOT (SELECT count(*)=2 AND bool_and(relrowsecurity AND relforcerowsecurity) FROM pg_class WHERE oid=ANY(ARRAY['nukhabapay.staff_memberships'::regclass,'nukhabapay.tenant_role_grants'::regclass])) OR
      has_schema_privilege(current_user,'nukhabapay','CREATE') OR has_database_privilege(current_user,current_database(),'CREATE,TEMP') OR
      has_function_privilege(current_user,'nukhabapay.execute_staff_command(jsonb)','EXECUTE') OR
      EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nukhabapay' AND c.relkind IN ('r','p') AND c.relname<>ALL($1::text[]) AND
        (has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE') OR has_table_privilege(current_user,c.oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER'))) OR
      EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='nukhabapay' AND c.relkind IN ('r','p') AND c.relname<>ALL($1::text[]) AND a.attnum>0 AND NOT a.attisdropped AND
        a.attname<>ALL(CASE c.relname
          WHEN 'staff_users' THEN ARRAY['id','status','authz_version']
          WHEN 'staff_identities' THEN ARRAY['staff_id','issuer','subject','status']
          WHEN 'staff_memberships' THEN ARRAY['id','staff_id','tenant_id','status','version']
          WHEN 'platform_role_grants' THEN ARRAY['id','staff_id','role_code','scope','granted_at','expires_at','revoked_at']
          WHEN 'tenant_role_grants' THEN ARRAY['id','membership_id','tenant_id','role_code','scope','granted_at','expires_at','revoked_at']
          ELSE ARRAY[]::text[] END) AND has_column_privilege(current_user,c.oid,a.attnum,'SELECT')) AS excess`,[tables])).rows[0];
    if(rights?.excess!==false)throw new Error();
  }catch{await pool?.end().catch(()=>undefined);throw new Error("Synthetic request store configuration or dependency unavailable");}
  const database=pool;
  const freshness=new Pool({connectionString:endpoint,max:2,connectionTimeoutMillis:3000,statement_timeout:4000,query_timeout:5000,idleTimeoutMillis:1000,
    options:"-c default_transaction_read_only=on -c idle_in_transaction_session_timeout=10000"});
  freshness.on("error",()=>{});freshness.on("connect",client=>client.on("error",()=>failed.add(client)));
  let closing:Promise<void>|undefined;
  const close=()=>closing??=Promise.all([database.end(),freshness.end()]).then(()=>undefined);
  async function snapshot(c:PoolClient,id:string,tenant:string|null,identity?:{issuer:string;subject:string}) {
    const users=identity ? await c.query(`SELECT u.id,u.status,u.authz_version,i.status AS identity_status FROM nukhabapay.staff_users u JOIN nukhabapay.staff_identities i ON i.staff_id=u.id WHERE u.id=$1 AND i.issuer=$2 AND i.subject=$3`,[id,identity.issuer,identity.subject]) :
      await c.query("SELECT id,status,authz_version FROM nukhabapay.staff_users WHERE id=$1",[id]);
    const u=users.rows[0];
    const platform=(await c.query("SELECT id,role_code,scope,granted_at,expires_at,revoked_at FROM nukhabapay.platform_role_grants WHERE staff_id=$1 ORDER BY role_code",[id])).rows;
    const membership=tenant===null?undefined:(await c.query("SELECT id,tenant_id,status,version FROM nukhabapay.staff_memberships WHERE staff_id=$1 AND tenant_id=$2",[id,tenant])).rows[0];
    const tenantGrants=membership?(await c.query("SELECT id,role_code,scope,granted_at,expires_at,revoked_at FROM nukhabapay.tenant_role_grants WHERE membership_id=$1 AND tenant_id=$2 ORDER BY role_code",[membership.id,tenant])).rows:[];
    const grant=(g:typeof platform[number]):StaffRoleGrant=>({roleCode:g.role_code,scope:g.scope,grantedAt:iso(g.granted_at),expiresAt:g.expires_at===null?null:iso(g.expires_at),revokedAt:g.revoked_at===null?null:iso(g.revoked_at)});
    const context:StaffAuthorizationContext={principal:u?{staffId:u.id,staffStatus:u.status,identityStatus:u.identity_status??"ACTIVE",authzVersion:BigInt(u.authz_version),tokensValidAfter:null}:null,
      membership:membership?{membershipId:membership.id,tenantId:membership.tenant_id,status:membership.status,version:BigInt(membership.version),roleGrants:tenantGrants.map(grant)}:null,platformRoleGrants:platform.map(grant)};
    const grants:LifecycleGrant[]=[...platform.map(g=>({...g,scopeValue:{kind:"PLATFORM" as const}})),...tenantGrants.map(g=>({...g,scopeValue:{kind:"TENANT" as const,tenantId:tenant!}}))].map(g=>({id:g.id,staffId:id,roleCode:g.role_code,scope:g.scopeValue,
      grantedAtMs:ms(g.granted_at),expiresAtMs:g.expires_at===null?null:ms(g.expires_at),revokedAtMs:g.revoked_at===null?null:ms(g.revoked_at)}));
    const actor:LifecycleActor={staffId:id,status:u?.status??"PENDING",authzVersion:u?BigInt(u.authz_version):0n,grants,memberships:membership?[{tenantId:tenant!,status:membership.status}]:[]};
    const target:LifecycleTarget={staffId:id,status:u?.status??"ABSENT",authzVersion:actor.authzVersion,grants,membership:membership?{tenantId:tenant!,status:membership.status,version:BigInt(membership.version)}:null};
    return {context,actor,target};
  }
  function decode(payload:AccessChangeRequest):AccessChangeRequest {
    return {...payload,version:BigInt(payload.version),expectedAuthzVersion:BigInt(payload.expectedAuthzVersion),expectedMembershipVersion:payload.expectedMembershipVersion===null?null:BigInt(payload.expectedMembershipVersion)};
  }
  async function finalSnapshots(ticket:AuthorizedStaffRequest,request:AccessChangeRequest,targetDigest:string,requesterDigest:string,requesterIdentity:{issuer:string;subject:string}){
    const live=await freshness.connect();let broken:Error|undefined;
    try{
      await live.query("BEGIN READ ONLY");
      await live.query("SELECT set_config('nukhabapay.workflow_scope',$1,true),set_config('nukhabapay.tenant_id',$2,true)",[ticket.tenantId??"PLATFORM",ticket.tenantId??""]);
      if(staffAuthorityDigest((await snapshot(live,ticket.staffId,ticket.tenantId,ticket)).context)!==ticket.authorityDigest)throw new Rejected("STALE_AUTHORITY");
      if(staffAuthorityDigest((await snapshot(live,request.targetStaffId,ticket.tenantId)).context)!==targetDigest)throw new Rejected("STALE_TARGET");
      if(staffAuthorityDigest((await snapshot(live,request.requesterStaffId,ticket.tenantId,requesterIdentity)).context)!==requesterDigest)throw new Rejected("STALE_REQUESTER");
      const ack=await live.query("COMMIT");if(ack.command!=="COMMIT" || failed.has(live))throw new Error("Freshness unavailable");
    }catch(error){try{await live.query("ROLLBACK");}catch{broken=new Error("Freshness connection discarded");}throw error;}
    finally{live.release(broken);}
  }
  return Object.freeze({close,
    async execute(ticket:AuthorizedStaffRequest):Promise<StaffRequestResult>{
      if(!consumeAuthorizedStaffRequest(ticket) || closing)return staffRequestResult("DENIED",{reason:"UNTRUSTED_REQUEST"});
      const cmd=ticket.command,scope=ticket.tenantId??"PLATFORM";
      const proof=ticket.syntheticProvenance;
      const intake=ticket.approvalIntake;
      if(intake && (syntheticProvenance!=="LOCAL_SYNTHETIC_ONLY" || intake.profile!=="BLOCKED_SYNTHETIC_REVIEW" || intake.policyVersion!==STAFF_LIFECYCLE_POLICY_VERSION ||
        !/^[0-9a-f]{64}$/.test(intake.requestDigest) || (cmd.kind!=="REVIEW" && cmd.kind!=="LOOKUP") ||
        (cmd.kind==="REVIEW" && (!proof || cmd.requestDigest!==intake.requestDigest))))return staffRequestResult("DENIED",{reason:"INTAKE_PROFILE_INVALID"});
      if(proof && (syntheticProvenance!=="LOCAL_SYNTHETIC_ONLY" || cmd.kind!=="REVIEW" || proof.binding.staffId!==ticket.staffId || proof.binding.identityIssuer!==ticket.issuer ||
        proof.binding.identitySubject!==ticket.subject || proof.binding.requestId!==cmd.id || proof.binding.requestVersion!==cmd.version.toString() || proof.binding.tenantId!==ticket.tenantId ||
        proof.binding.authorityDigest!==ticket.authorityDigest || proof.binding.requestDigest!==cmd.requestDigest || proof.operationalAssurance!=="not-established" || proof.acceptedApproval!==false || proof.execution!=="NOT_AUTHORIZED"))
        return staffRequestResult("DENIED",{reason:"UNTRUSTED_SYNTHETIC_PROVENANCE"});
      const operationId=canonicalDigest(["staff-request-operation-v1",ticket.staffId,cmd.key]);
      const intent=canonicalDigest(proof?[ticket.staffId,scope,cmd,proof.recordDigest]:[ticket.staffId,scope,cmd]);
      for(let attempt=0;attempt<3;attempt++){
        let c:PoolClient|undefined,broken:Error|undefined,committing=false;
        const locks:string[]=[];
        try{
          if(!await ticket.revalidate())throw new Rejected("STALE_AUTHORITY");
          c=await database.connect();if(failed.has(c))throw new Error("Disconnected");
          // Reserve before BEGIN so a waiter obtains a snapshot after the prior
          // head revision committed. Every session lock is released/discarded.
          for(const lock of ["request:"+cmd.id,"actor-key:"+ticket.staffId+":"+cmd.key]){
            locks.push(lock); // Track even an uncertain acquisition acknowledgement.
            await c.query("SELECT pg_advisory_lock(hashtextextended($1,0))",[lock]);
          }
          await c.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
          await c.query("SELECT set_config('nukhabapay.workflow_scope',$1,true),set_config('nukhabapay.tenant_id',$2,true)",[scope,ticket.tenantId??""]);
          const current=await snapshot(c,ticket.staffId,ticket.tenantId,{issuer:ticket.issuer,subject:ticket.subject});
          if(!current.context.principal || current.context.principal.staffStatus!=="ACTIVE" || current.context.principal.identityStatus!=="ACTIVE" ||
            staffAuthorityDigest(current.context)!==ticket.authorityDigest)throw new Rejected("STALE_AUTHORITY");
          const prior=(await c.query(`SELECT o.intent_digest,o.request_id,o.request_version,r.request_digest${intake?",o.kind,o.synthetic_provenance_id":""} FROM nukhabapay.staff_request_operations o
            JOIN nukhabapay.staff_request_receipts s ON s.operation_id=o.operation_id JOIN nukhabapay.staff_access_requests r ON r.request_id=o.request_id AND r.version=o.request_version
            WHERE o.actor_staff_id=$1 AND o.idempotency_key=$2 AND o.scope_key=$3`,[ticket.staffId,cmd.key,scope])).rows[0];
          if(prior){
            if(prior.request_id!==cmd.id || BigInt(prior.request_version)!==cmd.version || (cmd.kind!=="LOOKUP" && prior.intent_digest!==intent))throw new Rejected("IDEMPOTENCY_CONFLICT");
            if(intake){
              if(prior.request_digest!==intake.requestDigest || prior.kind!=="REVIEW" || prior.synthetic_provenance_id!==operationId)throw new Rejected("INTAKE_RECEIPT_MISMATCH");
              const classified=await c.query(`SELECT 1 FROM nukhabapay.staff_synthetic_provenance p JOIN nukhabapay.staff_review_observations v ON v.operation_id=p.operation_id
                WHERE p.operation_id=$1 AND p.reviewer_staff_id=$2 AND p.request_id=$3 AND p.request_version=$4 AND p.scope_key=$5 AND p.request_digest=$6 AND p.policy_version=$7
                AND p.kind='SYNTHETIC_TEST_EVENT' AND p.operational_assurance='not-established' AND NOT p.accepted_approval AND p.execution='NOT_AUTHORIZED'
                AND v.reviewer_staff_id=$2 AND v.request_id=$3 AND v.request_version=$4 AND v.scope_key=$5 AND v.request_digest=$6
                AND NOT v.accepted_approval AND v.assurance='not-established' AND v.execution='NOT_AUTHORIZED'`,
                [operationId,ticket.staffId,cmd.id,cmd.version.toString(),scope,intake.requestDigest,intake.policyVersion]);
              if(classified.rowCount!==1)throw new Rejected("INTAKE_RECEIPT_MISMATCH");
            }
            if(!await ticket.revalidate())throw new Rejected("STALE_AUTHORITY");
            committing=true;const ack=await c.query("COMMIT");
            if(ack.command!=="COMMIT" || failed.has(c))return staffRequestResult("UNRESOLVED",{operationId});
            return staffRequestResult("REPLAYED",{operationId,requestId:cmd.id,version:cmd.version.toString(),requestDigest:prior.request_digest});
          }
          if(cmd.kind==="LOOKUP"){await c.query("ROLLBACK");return staffRequestResult("UNRESOLVED");}
          const versions=(await c.query("SELECT * FROM nukhabapay.staff_access_requests WHERE request_id=$1 ORDER BY version DESC LIMIT 1",[cmd.id])).rows[0];
          if(versions && versions.scope_key!==scope)throw new Rejected("TENANT_MISMATCH");
          let request:AccessChangeRequest;
          if(cmd.kind==="SUBMIT"){
            if(versions ? BigInt(versions.version)+1n!==cmd.version || versions.request_digest!==cmd.previousDigest || versions.requester_staff_id!==ticket.staffId || versions.target_staff_id!==cmd.targetStaffId : cmd.version!==1n)throw new Rejected("VERSION_CONFLICT");
            request={id:cmd.id,version:cmd.version,policyVersion:STAFF_LIFECYCLE_POLICY_VERSION,state:"SUBMITTED",operation:cmd.operation,
              scope:ticket.tenantId===null?{kind:"PLATFORM"}:{kind:"TENANT",tenantId:ticket.tenantId},requesterStaffId:ticket.staffId,targetStaffId:cmd.targetStaffId,
              expectedAuthzVersion:cmd.expectedAuthzVersion,expectedMembershipVersion:cmd.expectedMembershipVersion,proposedRoles:cmd.proposedRoles,createdAtMs:ticket.nowMs,expiresAtMs:cmd.expiresAtMs};
          }else{
            if(!versions || BigInt(versions.version)!==cmd.version || versions.request_digest!==cmd.requestDigest)throw new Rejected("STALE_REQUEST");
            request=decode(versions.payload);
            if(ticket.staffId===request.requesterStaffId || ticket.staffId===request.targetStaffId)throw new Rejected("SELF_OR_BENEFICIARY_REVIEW");
            if((await c.query("SELECT 1 FROM nukhabapay.staff_review_observations WHERE request_id=$1 AND request_version=$2 AND reviewer_staff_id=$3",[cmd.id,cmd.version.toString(),ticket.staffId])).rowCount)throw new Rejected("DUPLICATE_PERSON");
            const permission=ticket.tenantId!==null?"tenant.access.request":current.context.platformRoleGrants.some(g=>g.roleCode==="GOVERNANCE_OWNER")?"platform.access.approve_privileged":"platform.access.approve";
            const decision=authorizeStaffAccess(current.context,{permissionCode:permission,scope:ticket.tenantId===null?"PLATFORM":"TENANT",now:new Date(ticket.nowMs).toISOString(),
              ...(ticket.tenantId===null?{}:{tenantId:ticket.tenantId,objectTenantId:ticket.tenantId})});
            if(decision.reason!=="PERMISSION_INACTIVE")throw new Rejected("REVIEWER_NOT_ELIGIBLE");
          }
          const target=await snapshot(c,request.targetStaffId,ticket.tenantId);
          if(cmd.kind==="REVIEW" && staffAuthorityDigest(target.context)!==versions.target_authority_digest)throw new Rejected("STALE_TARGET");
          const submission=cmd.kind==="REVIEW"?(await c.query("SELECT issuer,subject FROM nukhabapay.staff_request_operations WHERE operation_id=$1",[versions.submission_operation])).rows[0]:undefined;
          const requester=request.requesterStaffId===ticket.staffId?current:await snapshot(c,request.requesterStaffId,ticket.tenantId,submission);
          if(cmd.kind==="REVIEW" && (staffAuthorityDigest(requester.context)!==versions.requester_authority_digest || requester.actor.authzVersion!==BigInt(versions.requester_authz_version)))throw new Rejected("STALE_REQUESTER");
          const requestDigest=accessChangeRequestDigest(request);
          const plan=planStaffLifecycle(request,{currentRequestVersion:request.version,currentRequestDigest:requestDigest,requester:requester.actor,target:target.target,
            approvals:[],approvers:[],knownTenantIds:ticket.tenantId===null?[]:[ticket.tenantId],objectTenantId:ticket.tenantId},ticket.nowMs);
          if(plan.kind!=="PLAN")throw new Rejected(plan.reason);
          if(cmd.kind==="REVIEW" && requestDigest!==cmd.requestDigest)throw new Rejected("STALE_REQUEST");
          await c.query(`INSERT INTO nukhabapay.staff_request_operations(operation_id,actor_staff_id,issuer,subject,idempotency_key,intent_digest,request_id,request_version,scope_key,kind${proof?",synthetic_provenance_id":""})
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10${proof?",$11":""})`,[operationId,ticket.staffId,ticket.issuer,ticket.subject,cmd.key,intent,cmd.id,cmd.version.toString(),scope,cmd.kind,...(proof?[operationId]:[])]);
          if(cmd.kind==="SUBMIT")await c.query(`INSERT INTO nukhabapay.staff_access_requests(request_id,version,previous_digest,request_digest,requester_staff_id,target_staff_id,tenant_id,scope_key,
            expected_authz_version,expected_membership_version,roles,created_at_ms,expires_at_ms,policy_version,payload,submission_operation,requester_authz_version,requester_authority_digest,target_authority_digest)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19)`,[cmd.id,cmd.version.toString(),cmd.previousDigest,requestDigest,ticket.staffId,request.targetStaffId,ticket.tenantId,scope,
              request.expectedAuthzVersion.toString(),request.expectedMembershipVersion?.toString()??null,[...request.proposedRoles],request.createdAtMs,request.expiresAtMs,request.policyVersion,json(request),operationId,current.actor.authzVersion.toString(),ticket.authorityDigest,staffAuthorityDigest(target.context)]);
          else await c.query(`INSERT INTO nukhabapay.staff_review_observations(operation_id,request_id,request_version,reviewer_staff_id,scope_key,request_digest,reviewer_authority_digest,reviewer_authz_version,observed_at_ms)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[operationId,cmd.id,cmd.version.toString(),ticket.staffId,scope,requestDigest,ticket.authorityDigest,current.actor.authzVersion.toString(),ticket.nowMs]);
          if(proof) await c.query(`INSERT INTO nukhabapay.staff_synthetic_provenance(operation_id,request_id,request_version,reviewer_staff_id,identity_issuer,identity_subject,scope_key,
            request_digest,authority_digest,policy_version,challenge_id,authentication_event_id,provider_issuer,signing_key_id,authenticated_at_ms,expires_at_ms,assertion_digest,record_digest,binding)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb)`,[operationId,cmd.id,cmd.version.toString(),ticket.staffId,ticket.issuer,ticket.subject,scope,
            proof.binding.requestDigest,proof.binding.authorityDigest,proof.binding.policyVersion,proof.challengeId,proof.authenticationEventId,proof.providerIssuer,proof.signingKeyId,
            proof.authenticatedAtMs,proof.expiresAtMs,proof.assertionDigest,proof.recordDigest,json(proof.binding)]);
          await c.query(`INSERT INTO nukhabapay.staff_request_audit(operation_id,actor_staff_id,request_id,request_version,scope_key,intent_digest,event_name)
            VALUES($1,$2,$3,$4,$5,$6,$7)`,[operationId,ticket.staffId,cmd.id,cmd.version.toString(),scope,intent,cmd.kind==="SUBMIT"?"SYNTHETIC_REQUEST_SUBMITTED":"SYNTHETIC_REVIEW_OBSERVED"]);
          await c.query("INSERT INTO nukhabapay.staff_request_receipts(operation_id,scope_key,outcome) VALUES($1,$2,'RECORDED_NOT_AUTHORIZED')",[operationId,scope]);
          await c.query("INSERT INTO nukhabapay.staff_request_outbox(operation_id,scope_key) VALUES($1,$2)",[operationId,scope]);
          if(!await ticket.revalidate())throw new Rejected("STALE_AUTHORITY");
          await finalSnapshots(ticket,request,staffAuthorityDigest(target.context),staffAuthorityDigest(requester.context),submission??ticket);
          committing=true;
          const ack=await c.query("COMMIT");
          if(ack.command!=="COMMIT" || failed.has(c))return staffRequestResult("UNRESOLVED",{operationId});
          return staffRequestResult("RECORDED",{operationId,requestId:cmd.id,version:cmd.version.toString(),requestDigest});
        }catch(error){
          if(c){try{await c.query("ROLLBACK");}catch{broken=new Error("Request connection discarded");}}
          const code=typeof error==="object"&&error!==null&&"code" in error?String(error.code):"";
          if(["40001","40P01","23505"].includes(code) && attempt<2)continue;
          if(committing && !["40001","40P01","23505","23503","23514"].includes(code))return staffRequestResult("UNRESOLVED",{operationId});
          if(error instanceof Rejected)return staffRequestResult(["IDEMPOTENCY_CONFLICT","VERSION_CONFLICT"].includes(error.reason)?"CONFLICT":"DENIED",{reason:error.reason});
          return staffRequestResult("DENIED",{reason:"PERSISTENCE_UNAVAILABLE"});
        }finally{
          if(c){
            for(const lock of locks.reverse()){
              try{
                const unlocked=(await c.query("SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked",[lock])).rows[0]?.unlocked;
                if(unlocked!==true)broken=new Error("Request reservation discarded");
              }catch{broken=new Error("Request reservation discarded");}
            }
            c.release(broken);
          }
        }
      }
      return staffRequestResult("UNRESOLVED");
    }
  });
}
