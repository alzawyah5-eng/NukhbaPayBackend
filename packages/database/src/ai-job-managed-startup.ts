import { Client, DatabaseError } from "pg";
import { AiJobError } from "@nukhbapay/application";
import { AiJobSessions } from "./ai-job-fixed-sessions.js";
import { AiJobSessionPool, DEFAULT_AI_POOL_POLICY, AI_MANAGED_BUDGETS as B, validateAiStartupSchedule, type AiPoolPolicy, type AiManagedClient } from "./ai-job-session-pool.js";
import { composeAiJobPersistence, verifyAiJobRuntime, type AiJob55437Config } from "./ai-job-store.js";
import type { AiJobSqlClient } from "./ai-job-prepared-control.js";
const deny=()=>new AiJobError(503);
const executable=new Set(['assert_exact_target','enter_ai_source','ai_authority_epoch','record_ai_disclosure','release_ai_authorization','claim_ai_outbox','transition_ai_outbox','reconcile_ai_outbox','reserve_ai_attempt','assert_ai_attempt','settle_ai_attempt']);
type Phase="SETUP"|"PREFLIGHT"|"PHYSICAL"|"NETWORK"|"ASSERT"|"REQUEST";
export interface AiReviewedStartup extends AiJob55437Config {
 readonly authorizeStartup:()=>Promise<void>;
 readonly freshPhysicalProof:(signal:AbortSignal)=>Promise<{observedAt:number;systemIdentifier:string}>;
 readonly progress:(stage:"REQUEST"|"DISCLOSED"|"IDLE",id:number,absolute:number)=>void;
 readonly guardPhase:(stage:Phase,id:number,absolute?:number)=>void;
 readonly disclosureFunctions:Readonly<Record<string,string>>;
 readonly poolPolicy?:Readonly<AiPoolPolicy>;
}
/** No activation issuer is exported. Only an internally owner-reviewed, newly
 * authorized, hash-pinned native-owned fixture may call this composition. */
export async function startReviewedAiPersistence(config:AiReviewedStartup){
 const policy=Object.freeze({...config.poolPolicy??DEFAULT_AI_POOL_POLICY});validateAiStartupSchedule(policy);
 await config.authorizeStartup();let u:URL;
 try{u=new URL(config.connectionString);
  if(config.capability!=="B4_AI_E2E_55437_ONLY"||u.protocol!=="postgresql:"||u.hostname!=="127.0.0.1"||u.port!=="55437"||u.search||u.hash||
   !/^nukhabapay_b4ai_[0-9a-f]{32}$/.test(config.expectedDatabase)||u.pathname!=="/"+config.expectedDatabase||
   !/^nukh_ai_jobs_[0-9a-f]{20}$/.test(config.expectedRole)||decodeURIComponent(u.username)!==config.expectedRole||decodeURIComponent(u.password).length<16)throw deny();
 }catch{throw deny();}
 const expectedFunctions=Object.freeze({...config.disclosureFunctions}),names=Object.keys(expectedFunctions).sort();
 if(names.length<15||names.some(n=>!/^[_a-z]+$/.test(n))||[...executable].filter(n=>n!=='assert_exact_target').some(n=>!names.includes(n)))throw deny();
 let sequence=0;const firstVerified=new WeakSet<AiManagedClient>();
 const phase=(stage:Phase,id:number,ms?:number)=>config.guardPhase(stage,id,ms===undefined?undefined:Number(process.hrtime.bigint()/1000000n)+ms);
 const identity=async(client:Pick<AiJobSqlClient,'query'>)=>{
  await client.query('SELECT nukhb4_target.assert_exact_target()');await verifyAiJobRuntime(client,config,55437);
  const capacity=(await client.query(`SELECT rolconnlimit AS role_limit,current_setting('max_connections')::int AS maximum,
   current_setting('superuser_reserved_connections')::int AS admin_reserved FROM pg_roles WHERE rolname=current_user`)).rows[0];
  if(!capacity||capacity['role_limit']!==policy.maximum||typeof capacity['admin_reserved']!=='number'||capacity['admin_reserved']<policy.administrativeReserve||
   typeof capacity['maximum']!=='number'||capacity['maximum']<policy.authorizedConnectionBudget)throw deny();
  const rows=(await client.query(`SELECT p.proname,p.prosrc,p.prosecdef,p.provolatile,pg_get_userbyid(p.proowner) AS owner,
   p.proconfig=ARRAY['search_path=pg_catalog']::text[] AS config,has_function_privilege(current_user,p.oid,'EXECUTE') AS executable,
   EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
    AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=current_user) OR a.privilege_type<>'EXECUTE' OR a.is_grantable)) AS unsafe
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='nukhb4_target' AND p.proname=ANY($1::text[])`,[names])).rows;
  if(rows.length!==names.length||new Set(rows.map(r=>r['proname'])).size!==names.length||rows.some(r=>r['prosrc']!==expectedFunctions[String(r['proname'])]||
   r['prosecdef']!==true||r['owner']!=='nukhb4_bootstrap_5003f11512ab48a6'||r['provolatile']!==(r['proname']==='ai_authority_epoch'?'s':'v')||
   r['config']!==true||r['unsafe']!==false||r['executable']!==executable.has(String(r['proname']))))throw deny();
  const check=(await client.query(`SELECT
   (SELECT count(*)=13 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='nukhabapay' AND c.relname=ANY(ARRAY['tenants','provider_accounts','provider_snapshots','provider_offers','product_mappings','products','ai_job_snapshot_approvals'])
    AND t.tgenabled='O' AND t.tgfoid='nukhb4_target.advance_ai_authority()'::regprocedure
    AND ((c.relname='products' AND t.tgtype=62) OR (c.relname<>'products' AND t.tgtype IN (31,34))))
   AND (SELECT count(*)=6 FROM pg_class c WHERE c.oid IN ('nukhb4_target.ai_tenant_generation'::regclass,'nukhb4_target.ai_shared_generation'::regclass,
    'nukhb4_target.ai_delivery_leases'::regclass,'nukhb4_target.ai_disclosure_audit'::regclass,'nukhb4_target.ai_engine_reservations'::regclass,'nukhb4_target.ai_engine_reservation_audit'::regclass) AND pg_get_userbyid(c.relowner)='nukhb4_bootstrap_5003f11512ab48a6'
    AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner))
   AND (SELECT count(*)=2 FROM pg_class c WHERE c.oid IN ('nukhabapay.ai_outbox'::regclass,'nukhabapay.ai_outbox_audit'::regclass)
    AND relrowsecurity AND relforcerowsecurity AND pg_get_userbyid(c.relowner)='nukhabapay_migrator'
    AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner))
   AND NOT EXISTS(SELECT 1 FROM (VALUES
    ('nukhabapay.ai_jobs','ai_outbox_atomic','nukhb4_target.enqueue_ai_outbox()',21,false),
    ('nukhabapay.ai_jobs','ai_jobs_tenant_lock','nukhb4_target.ai_mutation_scope()',62,false),
    ('nukhabapay.ai_job_audit','ai_audit_tenant_lock','nukhb4_target.ai_mutation_scope()',62,false),
    ('nukhabapay.ai_outbox','ai_outbox_tenant_lock','nukhb4_target.ai_mutation_scope()',62,false),
    ('nukhabapay.ai_outbox_audit','ai_outbox_audit_tenant_lock','nukhb4_target.ai_mutation_scope()',62,false),
    ('nukhabapay.ai_outbox_audit','ai_outbox_audit_immutable','nukhabapay.reject_immutable_catalog_update()',27,false),
    ('nukhabapay.ai_outbox','ai_outbox_guard','nukhb4_target.guard_ai_outbox()',31,false),
    ('nukhabapay.ai_outbox','ai_outbox_requires_audit','nukhb4_target.require_ai_outbox_audit()',21,true),
    ('nukhb4_target.ai_engine_reservations','ai_engine_reservation_guard','nukhb4_target.guard_ai_reservation()',31,false),
    ('nukhb4_target.ai_engine_reservation_audit','ai_engine_reservation_audit_immutable','nukhabapay.reject_immutable_catalog_update()',27,false),
    ('nukhb4_target.ai_engine_reservations','ai_engine_reservation_requires_audit','nukhb4_target.require_ai_reservation_audit()',21,true),
    ('nukhabapay.ai_jobs','ai_job_reservation_required','nukhb4_target.guard_ai_job_reservation()',19,false),
    ('nukhb4_target.ai_disclosure_audit','ai_disclosure_immutable','nukhabapay.reject_immutable_catalog_update()',27,false)
   ) expected(relation,name,function_name,type,deferred) WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid=expected.relation::regclass AND t.tgname=expected.name AND t.tgfoid=expected.function_name::regprocedure
     AND t.tgtype=expected.type AND t.tgenabled='O' AND t.tgdeferrable=expected.deferred AND t.tginitdeferred=expected.deferred)) AS ok`)).rows[0];
  if(check?.['ok']!==true)throw deny();
 };
 const verify=async(client:AiManagedClient)=>{
  if(!client.healthy()||!client.idle()||client.expiresAt<=performance.now()+14000)throw deny();
  if(firstVerified.delete(client))return;const id=++sequence;if(id>4096)throw deny();phase('ASSERT',id,B.assertionMs);
  const start=performance.now(),timer=setTimeout(()=>{void client.end();},B.assertionMs);
  try{await identity(client);if(!client.healthy()||!client.idle()||performance.now()-start>=B.assertionMs)throw deny();}
  finally{clearTimeout(timer);phase('ASSERT',id);}
 };
 const pool=new AiJobSessionPool(policy,async(kind,parent)=>{
  const id=++sequence;if(id>4096||parent.aborted)throw deny();
  const abort=new AbortController(),start=performance.now();let c:Client|undefined,alive=false,ending=false;
  const faults=new Set<()=>void>(),fault=()=>{alive=false;for(const f of faults)f();};
  const stop=()=>{abort.abort();fault();if(c)void c.end().catch(()=>{});};
  parent.addEventListener('abort',stop,{once:true});const total=setTimeout(stop,B.setupMs);phase('SETUP',id,B.setupMs);
  try{
   phase('PREFLIGHT',id,B.preflightMs);const preflight=setTimeout(stop,B.preflightMs);
   let proof:{observedAt:number;systemIdentifier:string},physicalStart=Infinity;
   try{
    // Preserve the existing full manifest/source/executable/credential gate on
    // EVERY physical connection, including maintenance-created connections.
    await config.beforeConnect();if(abort.signal.aborted)throw deny();
    phase('PHYSICAL',id,B.physicalMs);physicalStart=performance.now();const physical=setTimeout(stop,B.physicalMs);
    try{proof=await config.freshPhysicalProof(abort.signal);}finally{clearTimeout(physical);phase('PHYSICAL',id);}
   }finally{clearTimeout(preflight);phase('PREFLIGHT',id);}
   if(abort.signal.aborted||performance.now()-physicalStart>=B.physicalMs||performance.now()-start>=B.preflightMs||proof.systemIdentifier!=='7709060202177449724'||
    !Number.isFinite(proof.observedAt)||proof.observedAt>performance.now()||performance.now()-proof.observedAt>1000)throw deny();
   c=new Client({host:'127.0.0.1',port:55437,user:config.expectedRole,database:config.expectedDatabase,password:decodeURIComponent(u.password),ssl:false,
    connectionTimeoutMillis:B.networkMs,statement_timeout:3000,query_timeout:4000,idle_in_transaction_session_timeout:10000,
    application_name:'nukhbapay-b4ai-managed-reviewed',...(kind==='source'?{options:'-c default_transaction_read_only=on'}:{})});
   c.on('error',fault);c.on('end',fault);phase('NETWORK',id,B.networkMs);
   await c.connect();alive=true;phase('NETWORK',id);phase('ASSERT',id,B.assertionMs);
   const assertion=setTimeout(stop,B.assertionMs),assertStart=performance.now();
   let pid:unknown,backendStartedAt:unknown;
   try{await identity(c);const observed=(await c.query('SELECT pid,extract(epoch from backend_start)::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid()')).rows[0];pid=observed?.['pid'];backendStartedAt=observed?.['started'];
    if(!alive||abort.signal.aborted||performance.now()-assertStart>=B.assertionMs||performance.now()-start>=B.setupMs||!Number.isSafeInteger(pid)||typeof backendStartedAt!=='string'||!/^\d{10,16}([.]\d{1,6})?$/.test(backendStartedAt))throw deny();
   }finally{clearTimeout(assertion);phase('ASSERT',id);}
   const captured=c,expiresAt=performance.now()+300000;let endingPromise:Promise<void>|undefined;
   const port:AiManagedClient={backendPid:pid as number,backendStartedAt:backendStartedAt as string,expiresAt,healthy:()=>alive&&!ending&&!abort.signal.aborted,
    idle:()=>alive&&!ending&&captured.getTransactionStatus()==='I',onFault:f=>{faults.add(f);return()=>faults.delete(f);},
    query:async(sql,values)=>{if(!alive||ending||abort.signal.aborted)throw deny();try{return await captured.query(sql,values);}catch(e){
     // A local read timeout/network exception is NOT a PostgreSQL rollback
     // acknowledgement. Quarantine immediately, including retained I status.
     if(!(e instanceof DatabaseError)||!e.code||e.code.startsWith('08')||['57P01','57P02','57P03'].includes(e.code)||!alive)fault();throw e;
    }},
    end:()=>{if(!endingPromise){ending=true;endingPromise=Promise.resolve().then(()=>captured.end());fault();}return endingPromise;}};
   firstVerified.add(port);return port;
  }catch{await c?.end().catch(()=>{});throw deny();}
  finally{clearTimeout(total);parent.removeEventListener('abort',stop);phase('SETUP',id);}
 },verify);
 try{await pool.start();const sessions=new AiJobSessions(pool,config.progress,absolute=>{
   const id=++sequence;if(id>4096)throw deny();config.guardPhase('REQUEST',id,absolute);
   return ()=>config.guardPhase('REQUEST',id);
  });return {sessions,...composeAiJobPersistence(sessions.jobs,sessions.sources,sessions)};}
 catch{await pool.close();throw deny();}
}
