import { randomUUID } from "node:crypto";
import { Client, Pool, type PoolConfig } from "pg";
import { requirePreparedMock, type MockPreparedAiTransport, type AiJobSqlClient, type AiJobSqlPool } from "./ai-job-prepared-control.js";
import { AiJobError, consumeAiJobTicket, validateAiJobRequest, type AiApprovedPair, type AiJobRecord,
  PROPOSED_AI_CONTROL_POLICY as T, type AiEngineReservation, type AiJobStore, type AiSourceReader, type AiJobTransaction, type AiProduct } from "@nukhbapay/application";

export interface AiJobDatabaseConfig { readonly connectionString: string; readonly expectedRole: string; readonly expectedDatabase: string; }
export interface AiJob55437Config extends AiJobDatabaseConfig {
  readonly capability: "B4_AI_E2E_55437_ONLY";
  /** Trusted fixture composition must verify a NEW authorization and OS/physical evidence. */
  readonly beforeConnect: () => Promise<void>;
}
const unavailable = () => new AiJobError(503);
function record(r: Record<string, unknown>): AiJobRecord {
  const request = validateAiJobRequest({ schemaVersion: "ai-job-v1", idempotencyKey: r["idempotency_key"], snapshotId: r["snapshot_id"],
    sourceVersion: r["source_version"], offerId: r["offer_id"], candidateProductId: r["candidate_product_id"] });
  return Object.freeze({ id: r["id"] as string, tenantId: r["tenant_id"] as string, clientDigest: r["client_digest"] as string,
    request, digest: r["request_digest"] as string, sourceDigest: r["source_digest"] as string, state: r["state"] as AiJobRecord["state"],
    attempts: r["attempts"] as number, retryAt: r["retry_at"] === null ? null : (r["retry_at"] as Date).toISOString(),
    summary: r["summary"] === null ? null : Object.freeze(r["summary"]) as AiJobRecord["summary"] });
}
const columns = "id,tenant_id,client_digest,idempotency_key,snapshot_id,source_version,offer_id,candidate_product_id,request_digest,source_digest,state,attempts,retry_at,summary";
function product(r: Record<string, unknown>): AiProduct {
  return Object.freeze({ record_id: r["record_id"] as string, category: r["category"] as "gift_card", country: r["redemption_country"] as string,
    currency: r["currency"] as string, issuer_id: r["brand"] as string, denomination_minor: r["face_value_minor"] as string,
    redemption_region: r["redemption_country"] as string, fulfillment_method: r["fulfillment_method"] === "DIGITAL_PIN" ? "PIN" : null,
    // The catalogue has no approved validity/restriction-code equivalence fields.
    // Unknown remains unknown: the guard will require manual review.
    validity: null, restriction_codes: null });
}
async function scoped(client: AiJobSqlClient, tenant: string) {
  await client.query("SELECT set_config('nukhabapay.ai_job_tenant',$1,true)", [tenant]);
}

/** Explicit isolated composition only. No bootstrap/env activation or migration registration. */
export async function createAiJobPersistence(config: AiJobDatabaseConfig) {
  return createPersistence(config);
}
/** Separate explicit test profile; does not relax or activate the legacy 5432 composition. */
export async function createAiJobPersistence55437(config: AiJob55437Config) {
  if (config.capability !== "B4_AI_E2E_55437_ONLY" || typeof config.beforeConnect !== "function") throw unavailable();
  return createPersistence(config, config.beforeConnect);
}
/** No approval issuer exists: proposed real session execution ALWAYS fails closed. */
export async function createAiJobPersistencePrepared55437(_config: unknown): Promise<never> { throw unavailable(); }
/** Same existing query/store implementation, but an incapable-of-networking,
 * branded offline transport. This cannot activate a PostgreSQL profile. */
export async function createAiJobPersistencePreparedOffline(transport: MockPreparedAiTransport) {
  requirePreparedMock(transport); transport.prepareOffline();
  return composeAiJobPersistence(transport.jobs, transport.sources, transport);
}
async function createPersistence(config: AiJobDatabaseConfig, beforeConnect?: () => Promise<void>): Promise<{ store: AiJobStore; sources: AiSourceReader; close(): Promise<void> }> {
  let pool: Pool | undefined, sourcePool: Pool | undefined;
  try {
    const u = new URL(config.connectionString);
    const port = beforeConnect ? 55437 : 5432;
    const databasePattern = beforeConnect ? /^nukhabapay_b4ai_[0-9a-f]{32}$/ : /^nukhabapay_b3b3_[0-9a-f]{32}$/;
    if (!['postgres:', 'postgresql:'].includes(u.protocol) || u.hostname !== '127.0.0.1' || (u.port || '5432') !== String(port) || u.search || u.hash ||
      !/^nukh_ai_jobs_[0-9a-f]{20}$/.test(config.expectedRole) || decodeURIComponent(u.username) !== config.expectedRole ||
      !databasePattern.test(config.expectedDatabase) || u.pathname !== '/' + config.expectedDatabase || decodeURIComponent(u.password).length < 16) throw unavailable();
    const options: PoolConfig = { host: '127.0.0.1', port, user: config.expectedRole, database: config.expectedDatabase, password: decodeURIComponent(u.password), ssl: false,
      max: 2, connectionTimeoutMillis: beforeConnect ? 6500 : 1500, statement_timeout: 3000,
      query_timeout: 4000, idleTimeoutMillis: beforeConnect ? 30000 : 1000, idle_in_transaction_session_timeout: 10000, allowExitOnIdle: true,
      application_name: beforeConnect ? 'nukhbapay-b4ai-e2e-55437' : 'nukhbapay-b4ai-legacy' };
    if (beforeConnect) {
      const preflight = beforeConnect;
      class VerifiedClient extends Client {
        override connect(): Promise<Client>;
        override connect(callback: ((err: Error) => void) | ((err: null, c: Client) => void)): void;
        override connect(callback?: ((err: Error) => void) | ((err: null, c: Client) => void)): Promise<Client> | void {
          const ready = (async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([preflight(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unavailable()), 5000); })]);
              await super.connect();
              // Fixed bootstrap-owned assertion checks cluster ID and physical paths.
              await this.query('SELECT nukhb4_target.assert_exact_target()');
              return this;
            } catch { await this.end().catch(() => undefined); throw unavailable(); }
            finally { clearTimeout(timer); }
          })();
          if (!callback) return ready;
          void ready.then(c => (callback as (err: null, c: Client) => void)(null, c), () => (callback as (err: Error) => void)(unavailable()));
        }
      }
      options.Client = VerifiedClient;
    }
    pool = new Pool(options); sourcePool = new Pool({ ...options, options: '-c default_transaction_read_only=on' });
    pool.on('error', () => {}); sourcePool.on('error', () => {});
    await verifyAiJobRuntime(pool, config, port);
    return composeAiJobPersistence(pool, sourcePool);
  } catch { await Promise.all([pool?.end().catch(() => undefined), sourcePool?.end().catch(() => undefined)]); throw unavailable(); }
}
export async function verifyAiJobRuntime(pool: Pick<AiJobSqlClient,"query">, config: AiJobDatabaseConfig, port: number): Promise<void> {
    const login = (await pool.query(`SELECT current_database() AS database,current_user AS role,host(inet_server_addr()) AS host,inet_server_port() AS port,
      rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls OR rolreplication OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS unsafe
      FROM pg_roles r WHERE rolname=current_user`)).rows[0];
    if (!login || login['database'] !== config.expectedDatabase || login['role'] !== config.expectedRole || login['host'] !== '127.0.0.1' || login['port'] !== port || login['unsafe']) throw unavailable();
    const security = (await pool.query(`SELECT
      has_schema_privilege(current_user,'nukhabapay','CREATE') OR has_database_privilege(current_user,current_database(),'CREATE,TEMP') OR
      EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='nukhabapay'::regnamespace AND (prosecdef OR prorettype<>'trigger'::regtype) AND has_function_privilege(current_user,oid,'EXECUTE')) OR
      EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='nukhabapay'::regnamespace AND c.relkind IN ('r','p','v','m','f') AND (
       c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) OR has_table_privilege(current_user,c.oid,'DELETE,TRUNCATE,TRIGGER,REFERENCES') OR
       (has_any_column_privilege(current_user,c.oid,'SELECT') AND c.relname NOT IN ('ai_jobs','ai_job_audit','ai_job_sources','ai_job_candidates')) OR
       (has_any_column_privilege(current_user,c.oid,'INSERT') AND c.relname NOT IN ('ai_jobs','ai_job_audit')) OR
       (has_any_column_privilege(current_user,c.oid,'UPDATE') AND c.relname<>'ai_jobs') OR
       has_any_column_privilege(current_user,c.oid,'REFERENCES'))) AS bad`)).rows[0];
    if (security['bad']) throw unavailable();
    const integrity = (await pool.query(`SELECT
      (SELECT count(*)=2 FROM pg_class WHERE oid IN ('nukhabapay.ai_jobs'::regclass,'nukhabapay.ai_job_audit'::regclass) AND relrowsecurity AND relforcerowsecurity AND pg_get_userbyid(relowner)='nukhabapay_migrator') AND
      (SELECT count(*)=2 FROM pg_class WHERE oid IN ('nukhabapay.ai_job_sources'::regclass,'nukhabapay.ai_job_candidates'::regclass) AND relkind='v' AND reloptions @> ARRAY['security_barrier=true'] AND pg_get_userbyid(relowner)='nukhabapay_migrator') AND
      (SELECT count(*)=4 FROM pg_trigger WHERE tgname IN ('ai_job_transition','ai_job_requires_audit','ai_job_audit_immutable','ai_job_audit_phase') AND tgenabled='O' AND tgrelid IN ('nukhabapay.ai_jobs'::regclass,'nukhabapay.ai_job_audit'::regclass)) AND
      NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='nukhabapay.ai_jobs'::regclass AND attnum>0 AND NOT attisdropped AND attname NOT IN ('state','attempts','retry_at','summary') AND has_column_privilege(current_user,attrelid,attnum,'UPDATE')) AS ok`)).rows[0];
    if (!integrity['ok']) throw unavailable();
}
export { startReviewedAiPersistence, startReviewedAiPersistence as startReviewedFixedAiPersistence } from "./ai-job-managed-startup.js";
export function composeAiJobPersistence(jobsPool: AiJobSqlPool, readsPool: AiJobSqlPool, prepared?: {readonly durableAttempts?:boolean; assertActive(tenant?: string): void; ownershipEpoch?(): string | undefined; cancelCurrentRequest?():void; transactionBudget?(): {deadline:number; cancel?():void; complete():void}}): { store: AiJobStore; sources: AiSourceReader; close(): Promise<void> } {
    let closing = false, closePromise: Promise<void> | undefined;
    const sources: AiSourceReader = { async read(tenantId, request) {
      if (closing) throw unavailable();
      prepared?.assertActive(tenantId);
      const db = await readsPool.connect(); let broken = false;
      try {
        await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await scoped(db, tenantId);
        const s = (await db.query(`SELECT tenant_id,snapshot_id,offer_id,source_version,observed_at,completed_at,valid_until,record_id,brand,redemption_country,currency,face_value_minor::text,fulfillment_method,category,clock_timestamp() AS server_now
          FROM nukhabapay.ai_job_sources WHERE snapshot_id=$1 AND offer_id=$2 AND source_version=$3`, [request.snapshotId, request.offerId, request.sourceVersion])).rows;
        const c = (await db.query(`SELECT product_id,record_id,brand,redemption_country,currency,face_value_minor::text,fulfillment_method,category,max(valid_until) AS valid_until
          FROM nukhabapay.ai_job_candidates WHERE product_id=$1 GROUP BY product_id,record_id,brand,redemption_country,currency,face_value_minor,fulfillment_method,category`, [request.candidateProductId])).rows;
        if ((await db.query('COMMIT')).command !== 'COMMIT') throw unavailable();
        if (s.length !== 1 || c.length !== 1) return null;
        const row = s[0]!;
        return Object.freeze({ tenantId: row['tenant_id'] as string, snapshotId: row['snapshot_id'] as string, offerId: row['offer_id'] as string,
          candidateProductId: c[0]!['product_id'] as string, sourceVersion: row['source_version'] as string, approved: true, status: 'COMPLETE', accountActive: true,
          observedAt: (row['observed_at'] as Date).toISOString(), completedAt: (row['completed_at'] as Date).toISOString(), validUntil: new Date(Math.min((row['valid_until'] as Date).getTime(), (c[0]!['valid_until'] as Date).getTime())).toISOString(),
          provider: product(row), candidate: product(c[0]!), ...(prepared?.ownershipEpoch?.() !== undefined ? {ownershipEpoch:prepared.ownershipEpoch()!} : {}) }) satisfies AiApprovedPair;
      } catch { try { await db.query('ROLLBACK'); } catch { broken = true; } throw unavailable(); }
      finally { db.release(broken); }
    } };
    const store: AiJobStore = { async transaction(ticketValue, work) {
      const ticket = consumeAiJobTicket(ticketValue);
      if (closing || !await ticket.revalidate()) throw unavailable();
      prepared?.assertActive(ticket.tenantId);
      const db = await jobsPool.connect(); let broken = false, active = true, expired = false, terminal = false, commitStarted = false;
      // One absolute budget begins BEFORE BEGIN/context/lock work. The existing
      // cleanup reserve is inside that budget, not an extension after expiry.
      let budget:{deadline:number;cancel?():void;complete():void};
      try{budget=prepared?.transactionBudget?.()??{deadline:performance.now()+T.transactionMs,complete:()=>{}};}
      catch{db.release(true);throw unavailable();}
      const workDeadline=budget.deadline-T.cleanupMs;
      const stop=()=>{expired=true;active=false;if(budget.cancel)budget.cancel();else prepared?.cancelCurrentRequest?.();};
      const timer=setTimeout(stop,Math.max(0,workDeadline-performance.now()));
      const assertTime=()=>{if(expired||performance.now()>=workDeadline){stop();throw unavailable();}};
      const checked=async(sql:string,values:unknown[]=[])=>{assertTime();prepared?.assertActive(ticket.tenantId);const r=await db.query(sql,values);assertTime();return r;};
      const query = async (sql: string, values: unknown[] = []) => {
        assertTime();if (!active || !await ticket.revalidate() || !active) throw unavailable();
        return checked(sql,values);
      };
      try {
        await checked('BEGIN');await checked("SET LOCAL lock_timeout='1000ms'");
        await checked("SELECT set_config('nukhabapay.ai_job_tenant',$1,true)",[ticket.tenantId]);
        const lock = await checked('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked', [ticket.lockKey]);
        if (lock.rows[0]?.['locked'] !== true) throw new AiJobError(409);
        const tx: AiJobTransaction = {
          async assertAttempt(token){await query('SELECT nukhb4_target.assert_ai_attempt($1)',[token]);},
          async find(id) { const r = await query(`SELECT ${columns} FROM nukhabapay.ai_jobs WHERE id=$1 FOR UPDATE`, [id]); return r.rows.length === 1 ? record(r.rows[0]!) : null; },
          async findKey(clientDigest, key) { const r = await query(`SELECT ${columns} FROM nukhabapay.ai_jobs WHERE client_digest=$1 AND idempotency_key=$2 FOR UPDATE`, [clientDigest, key]); return r.rows.length === 1 ? record(r.rows[0]!) : null; },
          async insert(j) {
            const r = await query(`INSERT INTO nukhabapay.ai_jobs(id,tenant_id,client_digest,idempotency_key,snapshot_id,provider_account_id,source_version,offer_id,candidate_product_id,request_digest,source_digest,state,attempts,retry_at,summary)
              SELECT $1,$2,$3,$4,$5,provider_account_id,$6,$7,$8,$9,$10,'QUEUED',0,NULL,NULL FROM nukhabapay.ai_job_sources WHERE snapshot_id=$5 AND offer_id=$7 AND source_version=$6`,
              [j.id,j.tenantId,j.clientDigest,j.request.idempotencyKey,j.request.snapshotId,j.request.sourceVersion,j.request.offerId,j.request.candidateProductId,j.digest,j.sourceDigest]);
            if (r.rowCount !== 1) throw unavailable();
          },
          async save(j) { const r = await query('UPDATE nukhabapay.ai_jobs SET state=$2,attempts=$3,retry_at=$4,summary=$5 WHERE id=$1', [j.id,j.state,j.attempts,j.retryAt,j.summary]); if (r.rowCount !== 1) throw unavailable(); },
          async append(e) { if (e.tenantId !== ticket.tenantId) throw unavailable(); await query(`INSERT INTO nukhabapay.ai_job_audit(event_id,job_id,tenant_id,snapshot_id,occurred_at,attempt,outcome,provider,provider_attempt,model_version,manual_review,can_publish)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,false)`, [randomUUID(),e.jobId,e.tenantId,e.snapshotId,e.occurredAt,e.attempt,e.outcome,e.provider,e.providerAttempt,e.modelVersion]); },
        };
        const result=await work(tx); // Owned cancellation must join work, never detach it.
        assertTime();if (!await ticket.revalidate() || !active) throw unavailable();
        active = false;
        commitStarted=true;
        if ((await checked('COMMIT')).command !== 'COMMIT' || !await ticket.revalidate()) throw unavailable();
        assertTime();terminal=true;return result;
      } catch (e) {
        active = false;if(commitStarted)broken=true; // Never infer original commit outcome from a later ROLLBACK.
        try { if(performance.now()>=budget.deadline)throw unavailable();
          const rollback=await db.query('ROLLBACK');
          terminal=rollback.command==='ROLLBACK'&&performance.now()<budget.deadline;
          if(!terminal)broken=true;
        } catch { broken = true; }
        if (e instanceof AiJobError && (e.status === 403 || e.status === 409)) throw e; throw unavailable();
      } finally {
        active=false;clearTimeout(timer);
        try{db.release(broken);}catch{terminal=false;throw unavailable();}
        // On uncertain cleanup leave the native guard unacknowledged. Only the
        // independent owner can establish termination, not a cleared JS timer.
        if(terminal&&!broken&&performance.now()<budget.deadline)budget.complete();
      }
    } };
    if(prepared?.durableAttempts){
      const phase=async<R>(value:Parameters<AiJobStore['transaction']>[0],sql:string,values:unknown[],decode:(rows:Record<string,unknown>[])=>R):Promise<R>=>{
        const ticket=consumeAiJobTicket(value);if(closing||!await ticket.revalidate()||typeof prepared.transactionBudget!=='function')throw unavailable();prepared.assertActive(ticket.tenantId);
        const db=await jobsPool.connect();let broken=false,terminal=false;let budget:{deadline:number;cancel?():void;complete():void};
        try{budget=prepared.transactionBudget();}catch{db.release(true);throw unavailable();}
        const expire=()=>{if(budget.cancel)budget.cancel();else prepared.cancelCurrentRequest?.();};
        const timer=setTimeout(expire,Math.max(0,budget.deadline-T.cleanupMs-performance.now()));
        try{await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='1000ms'");await scoped(db,ticket.tenantId);
          const rows=(await db.query(sql,values)).rows;
          if(performance.now()>=budget.deadline-T.cleanupMs||!await ticket.revalidate())throw unavailable();
          // This commit is the durable authorization BEFORE any engine call.
          const answer=decode(rows);broken=true;if((await db.query('COMMIT')).command!=='COMMIT')throw unavailable();broken=false;
          if(performance.now()>=budget.deadline-T.cleanupMs)throw unavailable();terminal=true;return answer;
        }catch(e){try{if((await db.query('ROLLBACK')).command==='ROLLBACK'&&!broken)terminal=true;}catch{broken=true;}
          if(e instanceof AiJobError&&(e.status===403||e.status===409))throw e;
          if((e as {code?:string}).code==='55P03')throw new AiJobError(409);throw unavailable();
        }finally{clearTimeout(timer);db.release(broken);if(terminal&&!broken&&performance.now()<budget.deadline)budget.complete();}
      };
      const attempts:NonNullable<AiJobStore['attempts']>={
        reserve:(ticket,jobId)=>phase(ticket,'SELECT * FROM nukhb4_target.reserve_ai_attempt($1,$2)',[jobId,randomUUID()],rows=>{
          const r=rows[0];if(r?.['status']==='DENIED')throw new AiJobError(403);if(rows.length!==1||!r||!['OPEN','TERMINAL','EXHAUSTED'].includes(String(r['status']))||!Number.isSafeInteger(r['ordinal'])||
            Object.keys(r).sort().join(',')!=='ordinal,status,token'||
            (r['status']==='OPEN'&&(!(r['ordinal']===1||r['ordinal']===2)||typeof r['token']!=='string'||!/^[0-9a-f-]{36}$/.test(r['token'])))||
            (r['status']==='TERMINAL'&&(r['token']!==null||r['ordinal']!==0))||(r['status']==='EXHAUSTED'&&(r['token']!==null||r['ordinal']!==2)))throw unavailable();
          return Object.freeze({token:r['token'] as string|null,ordinal:r['ordinal'] as number,status:r['status'] as AiEngineReservation['status']});}),
        settle:(ticket,reservation,committed)=>phase(ticket,'SELECT nukhb4_target.settle_ai_attempt($1,$2)',[reservation.token,committed],()=>undefined)
      };
      Object.assign(store,{attempts:Object.freeze(attempts)});
    }
    return Object.freeze({ store: Object.freeze(store), sources: Object.freeze(sources), close() {
      closing = true; return closePromise ??= Promise.all([jobsPool.end(), readsPool.end()]).then(() => undefined);
    } });
}
