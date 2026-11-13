import { Pool, type PoolClient } from "pg";
import { consumeAuthorizedStaffWorkflowRead, type AuthorizedStaffWorkflowRead, type StaffWorkflowPage, type StaffRequestDetail,
  type StaffReviewSummary, type WorkflowPosition, type WorkflowReadData } from "@nukhbapay/application";

const projection={staff_request_operations:["operation_id","actor_staff_id","request_id","request_version","scope_key","kind","execution"],
  staff_access_requests:["request_id","version","requester_staff_id","target_staff_id","tenant_id","scope_key","roles","created_at_ms","expires_at_ms","policy_version","state","payload","submission_operation","execution","request_digest","previous_digest","expected_authz_version","expected_membership_version"],
  staff_review_observations:["operation_id","request_id","request_version","reviewer_staff_id","scope_key","observed_at_ms","assurance","accepted_approval","execution"]};
/** No enumeration API, IAM credentials or deployed registration. */
export async function createStaffWorkflowReader(input:Readonly<{connectionString:string;expectedRole:string;expectedDatabase:string}>) {
  const {connectionString,expectedRole,expectedDatabase}=input;
  let pool:Pool|undefined;
  const failed=new WeakSet<PoolClient>();
  try{
    const url=new URL(connectionString);
    if(url.protocol!=="postgresql:" || url.hostname!=="127.0.0.1" || Number(url.port||5432)!==5432 || url.search || url.hash || !url.password ||
      decodeURIComponent(url.username)!==expectedRole || !/^nukh_history_[0-9a-f]{20}$/.test(expectedRole) ||
      !/^nukhabapay_b3b3_[0-9a-f]{32}$/.test(expectedDatabase) || url.pathname!=="/"+expectedDatabase)throw new Error();
    pool=new Pool({connectionString:url.href,max:2,connectionTimeoutMillis:3000,statement_timeout:3000,query_timeout:4000,idleTimeoutMillis:1000,
      idle_in_transaction_session_timeout:5000,allowExitOnIdle:true,options:"-c default_transaction_read_only=on"});
    pool.on("error",()=>{});pool.on("connect",client=>client.on("error",()=>failed.add(client)));
    const login=(await pool.query(`SELECT current_database() AS database,current_user AS name,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls,
      EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS membership FROM pg_roles r WHERE rolname=current_user`)).rows[0];
    if(login?.database!==expectedDatabase || login.name!==expectedRole || [login.rolsuper,login.rolcreatedb,login.rolcreaterole,login.rolinherit,login.rolbypassrls,login.membership].some(v=>v!==false))throw new Error();
    const excess=(await pool.query(`SELECT has_schema_privilege(current_user,'nukhabapay','CREATE') OR has_database_privilege(current_user,current_database(),'CREATE,TEMP') OR
      EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='nukhabapay'::regnamespace AND has_function_privilege(current_user,p.oid,'EXECUTE') AND NOT(
        NOT p.prosecdef AND p.prorettype='trigger'::regtype AND p.oid=ANY(ARRAY['nukhabapay.reject_security_audit_mutation()'::regprocedure,
          'nukhabapay.reject_immutable_catalog_update()'::regprocedure,'nukhabapay.enforce_snapshot_transition()'::regprocedure]))) OR
      EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='nukhabapay'::regnamespace AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) OR
      EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nukhabapay' AND c.relkind IN ('r','p','v','m','f') AND
        (has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE') OR has_table_privilege(current_user,c.oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER'))) OR
      EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='nukhabapay'::regnamespace AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
        AND has_column_privilege(current_user,c.oid,a.attnum,'SELECT') AND NOT COALESCE(($1::jsonb->c.relname)?a.attname,false)) AS bad`,[JSON.stringify(projection)])).rows[0];
    if(excess?.bad!==false)throw new Error();
    for(const [table,columns] of Object.entries(projection)){
      const rls=(await pool.query("SELECT relrowsecurity AND relforcerowsecurity AS ok FROM pg_class WHERE oid=$1::regclass",["nukhabapay."+table])).rows[0];
      if(rls?.ok!==true)throw new Error();
      await pool.query(`SELECT ${columns.join(",")} FROM nukhabapay.${table} WHERE false`);
    }
  }catch{await pool?.end().catch(()=>undefined);throw new Error("Workflow reader configuration or dependency unavailable");}
  const database=pool;
  let closing:Promise<void>|undefined;
  const close=()=>closing??=database.end();
  return Object.freeze({close,async read(ticket:AuthorizedStaffWorkflowRead):Promise<StaffWorkflowPage|"NOT_AVAILABLE"|"UNAVAILABLE">{
    if(!consumeAuthorizedStaffWorkflowRead(ticket) || closing)return "NOT_AVAILABLE";
    let client:PoolClient|undefined,broken:Error|undefined;
    try{
      if(!await ticket.revalidate())return "NOT_AVAILABLE";
      client=await database.connect();if(failed.has(client))throw new Error();
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const q=ticket.query,scope=ticket.tenantId??"PLATFORM",who=ticket.staffId;
      await client.query("SELECT set_config('nukhabapay.workflow_scope',$1,true)",[scope]);
      const anchor=await client.query(`SELECT o.operation_id FROM nukhabapay.staff_request_operations o
        JOIN nukhabapay.staff_access_requests r ON r.request_id=o.request_id AND r.version=o.request_version AND r.scope_key=o.scope_key
        WHERE o.operation_id=$1 AND o.actor_staff_id=$2 AND o.request_id=$3 AND o.scope_key=$4 AND o.kind=$5 AND o.execution='NOT_AUTHORIZED'
        AND r.tenant_id IS NOT DISTINCT FROM $6::uuid AND r.state='SUBMITTED' AND r.execution='NOT_AUTHORIZED' AND r.policy_version='staff-lifecycle-v1'
        AND ${q.view==="REQUESTER"?"r.requester_staff_id=$2 AND r.submission_operation=o.operation_id":`r.requester_staff_id<>$2 AND r.target_staff_id<>$2 AND EXISTS(
          SELECT 1 FROM nukhabapay.staff_review_observations v WHERE v.operation_id=o.operation_id AND v.reviewer_staff_id=$2 AND v.request_id=r.request_id AND v.request_version=r.version
          AND v.scope_key=$4 AND NOT v.accepted_approval AND v.assurance='not-established' AND v.execution='NOT_AUTHORIZED')`} LIMIT 1`,
        [q.operationId,who,q.id,scope,q.view==="REQUESTER"?"SUBMIT":"REVIEW",ticket.tenantId]);
      if(anchor.rowCount!==1){await client.query("ROLLBACK");return "NOT_AVAILABLE";}
      const visible=q.view==="REQUESTER"?"r.requester_staff_id=$2":`r.requester_staff_id<>$2 AND r.target_staff_id<>$2 AND EXISTS(
        SELECT 1 FROM nukhabapay.staff_review_observations mine WHERE mine.request_id=r.request_id AND mine.request_version=r.version AND mine.reviewer_staff_id=$2
        AND mine.scope_key=$3 AND NOT mine.accepted_approval AND mine.assurance='not-established' AND mine.execution='NOT_AUTHORIZED')`;
      const where=`r.request_id=$1 AND r.scope_key=$3 AND r.tenant_id IS NOT DISTINCT FROM $4::uuid AND r.state='SUBMITTED' AND r.execution='NOT_AUTHORIZED'
        AND r.policy_version='staff-lifecycle-v1' AND ${visible}`;
      const params=[q.id,who,scope,ticket.tenantId];
      const head=(await client.query(`SELECT r.version,r.expires_at_ms FROM nukhabapay.staff_access_requests r WHERE ${where} AND r.version<=$5 ORDER BY r.version DESC LIMIT 1`,
        [...params,q.position?.head??"1000000"])).rows[0];
      if(!head){await client.query("ROLLBACK");return "NOT_AVAILABLE";}
      let detail:StaffRequestDetail|undefined,revisions:readonly StaffRequestDetail[]|undefined,reviews:readonly StaffReviewSummary[]|undefined,next:WorkflowPosition|undefined;
      const fields="r.version,r.target_staff_id,r.roles,r.created_at_ms,r.expires_at_ms,r.state,r.request_digest,r.previous_digest,r.expected_authz_version,r.expected_membership_version,r.payload->'operation' AS operation";
      const decode=(r:Record<string,unknown>):StaffRequestDetail=>({version:String(r["version"]),targetStaffId:r["target_staff_id"] as string,
        proposedRoles:r["roles"] as string[],operation:r["operation"] as StaffRequestDetail["operation"],createdAtMs:Number(r["created_at_ms"]),expiresAtMs:Number(r["expires_at_ms"]),state:"SUBMITTED",
        requestDigest:r["request_digest"] as string,previousDigest:r["previous_digest"] as string|null,expectedAuthzVersion:String(r["expected_authz_version"]),
        expectedMembershipVersion:r["expected_membership_version"]===null?null:String(r["expected_membership_version"]),policyVersion:"staff-lifecycle-v1"});
      if(q.kind==="DETAIL"){
        const row=(await client.query(`SELECT ${fields} FROM nukhabapay.staff_access_requests r WHERE ${where} AND r.version=$5 AND r.version<=$6`,[...params,q.version??head.version,head.version])).rows[0];
        if(!row){await client.query("ROLLBACK");return "NOT_AVAILABLE";}detail=decode(row);
      }else if(q.kind==="REVISIONS"){
        const rows=(await client.query(`SELECT ${fields} FROM nukhabapay.staff_access_requests r WHERE ${where} AND r.version>$5 AND r.version<=$6 ORDER BY r.version LIMIT $7`,
          [...params,q.position?.version??"0",head.version,q.limit+1])).rows;
        revisions=rows.slice(0,q.limit).map(decode);
        if(rows.length>q.limit)next={head:String(head.version),version:String(rows[q.limit-1]!.version),observedAtMs:0,operationId:"0".repeat(64)};
      }else if(q.kind==="REVIEWS"){
        if(q.version && !(await client.query(`SELECT r.version FROM nukhabapay.staff_access_requests r WHERE ${where} AND r.version=$5 AND r.version<=$6`,[...params,q.version,head.version])).rowCount){await client.query("ROLLBACK");return "NOT_AVAILABLE";}
        const rows=(await client.query(`SELECT v.request_version,v.observed_at_ms,v.operation_id FROM nukhabapay.staff_review_observations v
          JOIN nukhabapay.staff_access_requests r ON r.request_id=v.request_id AND r.version=v.request_version AND r.scope_key=v.scope_key
          WHERE ${where} AND v.scope_key=$3 AND NOT v.accepted_approval AND v.assurance='not-established' AND v.execution='NOT_AUTHORIZED'
          AND r.version<=$5 AND ($6::bigint IS NULL OR r.version=$6) AND ${q.view==="REQUESTER"?"true":"v.reviewer_staff_id=$2"}
          AND (v.request_version,v.observed_at_ms,v.operation_id)>($7::bigint,$8::bigint,$9::text)
          ORDER BY v.request_version,v.observed_at_ms,v.operation_id LIMIT $10`,
          [...params,head.version,q.version??null,q.position?.version??"0",q.position?.observedAtMs??0,q.position?.operationId??"0".repeat(64),q.limit+1])).rows;
        reviews=rows.slice(0,q.limit).map(r=>({version:String(r.request_version),observedAtMs:Number(r.observed_at_ms),acceptedApproval:false,assurance:"not-established"}));
        if(rows.length>q.limit){const last=rows[q.limit-1]!;next={head:String(head.version),version:String(last.request_version),observedAtMs:Number(last.observed_at_ms),operationId:last.operation_id as string};}
      }
      const committed=await client.query("COMMIT");
      if(committed.command!=="COMMIT" || failed.has(client))throw new Error();
      if(!await ticket.revalidate())return "NOT_AVAILABLE";
      const expiresAtMs=Number(head.expires_at_ms);
      const data:WorkflowReadData={requestId:q.id,view:q.view,visibleHeadVersion:String(head.version),state:"SUBMITTED",expiresAtMs,
        status:ticket.nowMs>=expiresAtMs?"EXPIRED":"SUBMITTED",...(detail?{detail}:{}),...(revisions?{revisions}:{}),...(reviews?{reviews}:{})};
      return {binding:{staffId:who,tenantId:ticket.tenantId,query:q},data,...(next?{next}:{})};
    }catch{
      if(client){try{await client.query("ROLLBACK");}catch{broken=new Error("Workflow read connection discarded");}}
      return "UNAVAILABLE";
    }finally{if(client){if(failed.has(client))broken=new Error("Workflow read connection discarded");client.release(broken);}}
  }});
}
