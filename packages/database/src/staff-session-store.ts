import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { consumeStaffSessionTicket, type StaffSessionStore, type StaffSessionTicket, type SessionStoreOutcome, type SessionBinding } from "@nukhbapay/application";

class Denied extends Error {}
const unavailable = () => new Error("Restricted session persistence unavailable");
export async function createStaffSessionStore(input: {
  readonly connectionString:string; readonly expectedRole:string; readonly expectedDatabase:string; readonly poolMax?:number;
}):Promise<StaffSessionStore & {close():Promise<void>}> {
  let pool:Pool|undefined;
  const brokenClients=new WeakSet<PoolClient>();
  try {
    const url=new URL(input.connectionString),max=input.poolMax??2;
    if(!/^nukh_session_[0-9a-f]{20}$/.test(input.expectedRole) || !/^nukhabapay_b3b[23]_[0-9a-f]{32}$/.test(input.expectedDatabase) ||
      !["postgres:","postgresql:"].includes(url.protocol) || url.hostname!=="127.0.0.1" || (url.port||"5432")!=="5432" ||
      url.search || url.hash || !url.password || decodeURIComponent(url.username)!==input.expectedRole ||
      decodeURIComponent(url.pathname.slice(1))!==input.expectedDatabase || !Number.isInteger(max) || max<1 || max>3)throw unavailable();
    pool=new Pool({connectionString:input.connectionString,max,connectionTimeoutMillis:3000,idleTimeoutMillis:1000,
      statement_timeout:5000,query_timeout:6000,application_name:"nukhbapay-staff-session-store"});
    pool.on("error",()=>undefined);
    // A discarded socket can report another error after query rejection/release.
    // Track it on that client; never install a process-wide exception handler.
    pool.on("connect",client=>{client.on("error",()=>{brokenClients.add(client);});});
    const target=(await pool.query(`SELECT current_database() AS database,current_user AS role,host(inet_server_addr()) AS host,inet_server_port() AS port,
      (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls OR NOT rolcanlogin FROM pg_roles WHERE rolname=current_user) AS unsafe,
      EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user) OR roleid=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS memberships,
      has_schema_privilege(current_user,'nukhabapay','USAGE,CREATE') OR has_schema_privilege(current_user,'nukhbapay_sessions','CREATE') OR
      has_database_privilege(current_user,current_database(),'CREATE,TEMP') AS excess,
      NOT has_schema_privilege(current_user,'nukhbapay_sessions','USAGE') AS missing_scope`)).rows[0];
    if(target.database!==input.expectedDatabase || target.role!==input.expectedRole || target.host!=="127.0.0.1" || target.port!==5432 ||
      target.unsafe || target.memberships || target.excess || target.missing_scope)throw unavailable();
    const tables=(await pool.query(`SELECT relname,relrowsecurity,relforcerowsecurity,
      has_table_privilege(current_user,c.oid,'SELECT') AS can_read,has_table_privilege(current_user,c.oid,'INSERT') AS can_append,
      has_table_privilege(current_user,c.oid,'UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') AS excess
      FROM pg_class c WHERE relnamespace='nukhbapay_sessions'::regnamespace AND relkind='r' ORDER BY relname`)).rows;
    if(tables.length!==2 || tables.map(r=>r.relname).join()!=="events,sessions" || tables.some(r=>!r.relrowsecurity||!r.relforcerowsecurity||r.can_read||r.can_append||r.excess))throw unavailable();
    const expectedColumns={sessions:'id,token_hash,actor_staff_id,issuer,subject,tenant_id,scope_key,authz_version,membership_version,authority_digest,identity_expires_ms,created_ms,expires_ms,idle_ms,parent_id,creation_operation_id,execution,assurance',
      events:'id,operation_id,session_id,actor_staff_id,scope_key,event_name,occurred_ms,reason,execution'};
    for(const table of ['sessions','events'] as const) {
      const columns=(await pool.query(`SELECT a.attname,has_column_privilege(current_user,c.oid,a.attnum,'SELECT') AS read,
        has_column_privilege(current_user,c.oid,a.attnum,'INSERT') AS append,has_column_privilege(current_user,c.oid,a.attnum,'UPDATE,REFERENCES') AS excess
        FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid WHERE c.relnamespace='nukhbapay_sessions'::regnamespace AND c.relname=$1 AND a.attnum>0 AND NOT a.attisdropped`,[table])).rows;
      if(columns.length!==expectedColumns[table].split(',').length || columns.some(c=>!expectedColumns[table].split(',').includes(c.attname)||!c.read||c.excess||
        c.append!==(!['execution','assurance'].includes(c.attname) && !(table==='sessions' && c.attname==='scope_key'))))throw unavailable();
    }
    const excess=(await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='nukhabapay'::regnamespace AND c.relkind IN ('r','p','v','m') AND
      (has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) OR
      EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='nukhbapay_sessions'::regnamespace AND (has_function_privilege(current_user,p.oid,'EXECUTE') OR p.prosecdef)) AS excess`)).rows[0].excess;
    if(excess)throw unavailable();
    const activePool=pool; let closed=false;
    const scope=(b:SessionBinding)=>b.tenantId??"PLATFORM";
    const matches=(row:Record<string,unknown>,b:SessionBinding)=>row['actor_staff_id']===b.staffId && row['issuer']===b.issuer && row['subject']===b.subject &&
      row['tenant_id']===b.tenantId && String(row['authz_version'])===b.authzVersion && (row['membership_version']===null?null:String(row['membership_version']))===b.membershipVersion &&
      row['authority_digest']===b.authorityDigest && Number(row['identity_expires_ms'])===b.identityExpiresAtMs;
    async function execute(ticket:StaffSessionTicket):Promise<SessionStoreOutcome> {
      if(closed || !consumeStaffSessionTicket(ticket))return "DENIED";
      let c:PoolClient|undefined,transaction=false,discard=false;
      try {
        c=await activePool.connect();if(brokenClients.has(c))throw unavailable();
        await c.query("BEGIN ISOLATION LEVEL READ COMMITTED");transaction=true;
        await c.query("SET LOCAL lock_timeout='3s'");
        await c.query("SELECT set_config('nukhbapay_sessions.staff_id',$1,true),set_config('nukhbapay_sessions.scope',$2,true)",[ticket.binding.staffId,scope(ticket.binding)]);
        for(const h of [...new Set([ticket.tokenHash,...(ticket.previousHash?[ticket.previousHash]:[])])].sort()) {
          await c.query("SELECT pg_advisory_xact_lock($1::bigint)",[BigInt.asIntN(64,BigInt("0x"+h.slice(0,16))).toString()]);
        }
        const find=async(h:string)=>(await c!.query("SELECT * FROM nukhbapay_sessions.sessions WHERE token_hash=$1 AND actor_staff_id=$2 AND scope_key=$3",[h,ticket.binding.staffId,scope(ticket.binding)])).rows[0] as Record<string,unknown>|undefined;
        const revoked=async(id:string)=>(await c!.query("SELECT 1 FROM nukhbapay_sessions.events WHERE session_id=$1 AND event_name='SESSION_REVOKED'",[id])).rowCount!==0;
        const event=async(id:string,name:string,reason:string)=>{await c!.query(`INSERT INTO nukhbapay_sessions.events(id,operation_id,session_id,actor_staff_id,scope_key,event_name,occurred_ms,reason)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[randomUUID(),ticket.operationId,id,ticket.binding.staffId,scope(ticket.binding),name,ticket.nowMs,reason]);};
        let result:SessionStoreOutcome;
        if(ticket.operation==="CREATE" || ticket.operation==="ROTATE") {
          if(!await ticket.revalidate())throw new Denied();
          let parent:Record<string,unknown>|undefined;
          if(ticket.operation==="ROTATE") {
            if(!ticket.previousHash || !ticket.previousBinding)throw new Denied();
            parent=await find(ticket.previousHash);
            if(!parent || !matches(parent,ticket.previousBinding) || await revoked(String(parent['id'])) || ticket.nowMs>=Number(parent['expires_ms']))throw new Denied();
            const last=(await c.query("SELECT max(occurred_ms) AS last FROM nukhbapay_sessions.events WHERE session_id=$1 AND event_name IN ('SESSION_CREATED','SESSION_USED')",[parent['id']])).rows[0].last;
            if(last===null || ticket.nowMs<Number(last) || ticket.nowMs>=Number(last)+Number(parent['idle_ms']))throw new Denied();
            await event(String(parent['id']),"SESSION_REVOKED","CONTEXT_ROTATION");
          }
          const b=ticket.binding;
          await c.query(`INSERT INTO nukhbapay_sessions.sessions(id,token_hash,actor_staff_id,issuer,subject,tenant_id,authz_version,membership_version,
            authority_digest,identity_expires_ms,created_ms,expires_ms,idle_ms,parent_id,creation_operation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [ticket.sessionId,ticket.tokenHash,b.staffId,b.issuer,b.subject,b.tenantId,b.authzVersion,b.membershipVersion,b.authorityDigest,b.identityExpiresAtMs,
              ticket.nowMs,ticket.expiresAtMs,ticket.idleMs,parent?.['id']??null,ticket.operationId]);
          await event(ticket.sessionId,"SESSION_CREATED",ticket.reason);result="COMMITTED";
        } else {
          const row=await find(ticket.tokenHash);
          if(!row || row['id']!==ticket.sessionId || !matches(row,ticket.binding))throw new Denied();
          const alreadyRevoked=await revoked(ticket.sessionId);
          if(ticket.operation==="REVOKE") {
            if(!alreadyRevoked)await event(ticket.sessionId,"SESSION_REVOKED",ticket.reason);result="REVOKED";
          } else if(ticket.operation==="CHECK_REVOKED")result=alreadyRevoked?"REVOKED":"ACTIVE";
          else {
            const last=(await c.query("SELECT max(occurred_ms) AS last FROM nukhbapay_sessions.events WHERE session_id=$1 AND event_name IN ('SESSION_CREATED','SESSION_USED')",[ticket.sessionId])).rows[0].last;
            if(alreadyRevoked || last===null || Number(row['idle_ms'])!==ticket.idleMs || ticket.nowMs<Number(last) || ticket.nowMs>=Number(row['expires_ms']) || ticket.nowMs>=Number(last)+Number(row['idle_ms']) || !await ticket.revalidate())throw new Denied();
            await event(ticket.sessionId,"SESSION_USED","VALIDATION");result="ACTIVE";
          }
        }
        if(ticket.operation!=="REVOKE" && ticket.operation!=="CHECK_REVOKED" && !await ticket.revalidate())throw new Denied();
        await c.query("COMMIT");transaction=false;return brokenClients.has(c)?"UNRESOLVED":result;
      } catch(error) {
        const code=typeof error==='object'&&error!==null&&'code' in error?String(error.code):'';
        discard=!(error instanceof Denied) && (!/^[0-9A-Z]{5}$/.test(code)||code.startsWith('08')||code==='57P01');
        return error instanceof Denied?"DENIED":"UNRESOLVED";
      } finally {
        if(transaction && c)try{await c.query("ROLLBACK");}catch{discard=true;}
        if(c)c.release(discard||brokenClients.has(c));
      }
    }
    return Object.freeze({execute,close:async()=>{if(!closed){closed=true;await activePool.end();}}});
  } catch {await pool?.end().catch(()=>undefined);throw unavailable();}
}
