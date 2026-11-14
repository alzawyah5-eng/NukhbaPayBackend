import { Pool } from "pg";
import { consumeCatalogueReadTicket } from "@nukhbapay/application";
import type { CatalogueReader, CatalogueAuditWriter, CatalogueReadAudit, CatalogueReadTicket } from "@nukhbapay/application";
export interface PublishedCatalogueDatabaseConfig {readonly connectionString:string;readonly expectedRole:string;readonly expectedDatabase:string;}
async function poolFor(c:PublishedCatalogueDatabaseConfig,mode:"reader"|"audit"){
 let pool:Pool|undefined;
 try{
  const u=new URL(c.connectionString),role=mode==="reader"?/^nukh_catalogue_[0-9a-f]{20}$/:/^nukh_read_audit_[0-9a-f]{20}$/;
  if(!["postgres:","postgresql:"].includes(u.protocol)||u.hostname!=="127.0.0.1"||(u.port||"5432")!=="5432"||u.search||u.hash||decodeURIComponent(u.username)!==c.expectedRole||!role.test(c.expectedRole)||!/^nukhabapay_b3b3_[0-9a-f]{32}$/.test(c.expectedDatabase)||u.pathname!=="/"+c.expectedDatabase||decodeURIComponent(u.password).length<16)throw new Error();
  pool=new Pool({connectionString:u.href,max:2,connectionTimeoutMillis:3000,statement_timeout:3000,query_timeout:4000,idleTimeoutMillis:1000,idle_in_transaction_session_timeout:5000,allowExitOnIdle:true,...(mode==="reader"?{options:"-c default_transaction_read_only=on"}:{})});
  pool.on("error",()=>{});
  const login=(await pool.query(`SELECT current_database() AS database,current_user AS role,host(inet_server_addr()) AS host,inet_server_port() AS port,
   rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS unsafe FROM pg_roles r WHERE rolname=current_user`)).rows[0];
  if(login.database!==c.expectedDatabase||login.role!==c.expectedRole||login.host!=="127.0.0.1"||login.port!==5432||login.unsafe)throw new Error();
  const allowed=mode==="reader"?"published_catalogue_public":"published_catalogue_read_audit";
  const security=(await pool.query(`SELECT
   has_schema_privilege(current_user,'nukhabapay','CREATE') OR has_database_privilege(current_user,current_database(),'CREATE,TEMP') OR
   EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='nukhabapay'::regnamespace AND (prosecdef OR prorettype<>'trigger'::regtype) AND has_function_privilege(current_user,oid,'EXECUTE')) OR
   EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='nukhabapay'::regnamespace AND c.relkind IN ('r','p','v','m','f') AND
    (c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) OR
     has_table_privilege(current_user,c.oid,'DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(current_user,c.oid,'UPDATE,REFERENCES') OR
     (has_any_column_privilege(current_user,c.oid,'SELECT') AND NOT($1='reader' AND c.relname=$2)) OR
     (has_any_column_privilege(current_user,c.oid,'INSERT') AND NOT($1='audit' AND c.relname=$2)))) AS bad`,[mode,allowed])).rows[0];
  if(security.bad)throw new Error();
  if(mode==="reader"){
   const view=(await pool.query("SELECT relkind='v' AND reloptions @> ARRAY['security_barrier=true'] AND pg_get_userbyid(relowner)='nukhabapay_migrator' AS ok FROM pg_class WHERE oid='nukhabapay.published_catalogue_public'::regclass")).rows[0];
   if(!view?.ok)throw new Error();
   await pool.query("SELECT product_id,name,publication_id,total_amount_minor,valid_until FROM nukhabapay.published_catalogue_public WHERE false");
  }else{
   const rls=(await pool.query("SELECT relrowsecurity AND relforcerowsecurity AND has_table_privilege(current_user,oid,'INSERT') AS ok FROM pg_class WHERE oid='nukhabapay.published_catalogue_read_audit'::regclass")).rows[0];if(!rls?.ok)throw new Error();
  }
  return pool;
 }catch{await pool?.end().catch(()=>undefined);throw new Error("Catalogue database unavailable");}
}
export async function createPublishedCatalogueReader(config:PublishedCatalogueDatabaseConfig):Promise<CatalogueReader&{close():Promise<void>}>{
 const pool=await poolFor(config,"reader");let closing:Promise<void>|undefined;
 return Object.freeze({close:()=>closing??=pool.end(),async read(value:CatalogueReadTicket){
  const ticket=consumeCatalogueReadTicket(value);if(closing||!await ticket.revalidate())throw new Error("Catalogue read denied");
  const db=await pool.connect();let broken=false;
  try{
   await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
   await db.query("SELECT set_config('nukhabapay.publication_tenant_id',$1,true),set_config('nukhabapay.catalogue_read_at',$2,true)",[ticket.tenantId,new Date(ticket.nowMs).toISOString()]);
   const rows=(await db.query("SELECT product_id,name,publication_id,total_amount_minor::text,valid_until FROM nukhabapay.published_catalogue_public ORDER BY product_id LIMIT 1001")).rows;
   if((await db.query("COMMIT")).command!=="COMMIT"||!await ticket.revalidate())throw new Error();
   return Object.freeze(rows.map(r=>Object.freeze({productId:r.product_id as string,name:r.name as string,publicationId:r.publication_id as string,totalMinor:r.total_amount_minor as string,validUntil:(r.valid_until as Date).toISOString()})));
  }catch{try{await db.query("ROLLBACK");}catch{broken=true;}throw new Error("Catalogue read unavailable");}finally{db.release(broken);}
 }});
}
export async function createCatalogueReadAuditWriter(config:PublishedCatalogueDatabaseConfig):Promise<CatalogueAuditWriter&{close():Promise<void>}>{
 const pool=await poolFor(config,"audit");let closing:Promise<void>|undefined;
 return Object.freeze({close:()=>closing??=pool.end(),async append(e:CatalogueReadAudit){
  if(closing||!e||!Number.isFinite(Date.parse(e.occurredAt)))throw new Error("Catalogue audit unavailable");
  const db=await pool.connect();let broken=false;
  try{
   await db.query("BEGIN");await db.query("SELECT set_config('nukhabapay.publication_tenant_id',$1,true)",[e.tenantId]);
   await db.query(`INSERT INTO nukhabapay.published_catalogue_read_audit(request_id,tenant_id,client_digest,kind,kiosk_id,catalogue_version,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,[e.requestId,e.tenantId,e.clientDigest,e.kind,e.kioskId,e.catalogueVersion,e.occurredAt]);
   if((await db.query("COMMIT")).command!=="COMMIT")throw new Error();
  }catch{try{await db.query("ROLLBACK");}catch{broken=true;}throw new Error("Catalogue audit unavailable");}finally{db.release(broken);}
 }});
}
