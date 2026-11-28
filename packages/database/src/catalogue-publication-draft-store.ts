import { armCatalogueRefreshWrite, lockCatalogueAccount } from "./catalogue-refresh-write-fence.js";
import type { AedCommercialPriceDraft, AdministrationAuthority, AdministrationLease, RefreshClaim, VerifiedStaffIdentity } from "@nukhbapay/application";
import { executeSyntheticPublication } from "./synthetic-publication-workflow.js";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { consumeSubmissionEvidence, submissionDigest, assertGeneratedDraftPublicationCandidate,
  assertPreparedAedCommercialPriceDraft } from "@nukhbapay/application";

export class PublicationDraftConflictError extends Error { override readonly name="PublicationDraftConflictError"; }
export class PublicationDraftStaleError extends Error { override readonly name="PublicationDraftStaleError"; }

export interface PublicationDraftStoreConfig {
  readonly connectionString:string;
  readonly expectedRole:string;
  readonly expectedDatabase:string;
  readonly poolMax:number;
}

export interface PublicationDraftReceipt {
  readonly candidateId:string;
  readonly priceVersion:number;
  readonly outcome:"CREATED"|"REPLAYED";
  readonly execution:"NOT_AUTHORIZED";
}

function validated(config:PublicationDraftStoreConfig):PublicationDraftStoreConfig {
  if(!/^nukh_publication_[0-9a-f]{20}$/.test(config.expectedRole)||
    !/^nukhabapay_b3b3_[0-9a-f]{32}$/.test(config.expectedDatabase)||!Number.isSafeInteger(config.poolMax)||config.poolMax<1||config.poolMax>2)
    throw new TypeError("Invalid publication draft store configuration");
  let url:URL;
  try{url=new URL(config.connectionString);}catch{throw new TypeError("Invalid publication draft store configuration");}
  if(!["postgres:","postgresql:"].includes(url.protocol)||url.hostname!=="127.0.0.1"||(url.port||"5432")!=="5432"||url.search||url.hash||
    decodeURIComponent(url.username)!==config.expectedRole||decodeURIComponent(url.pathname.slice(1))!==config.expectedDatabase||decodeURIComponent(url.password).length<16)
    throw new TypeError("Invalid publication draft store configuration");
  return config;
}

export async function createCataloguePublicationDraftStore(input:PublicationDraftStoreConfig) {
  const config=validated(input),pool=new Pool({connectionString:config.connectionString,max:config.poolMax,connectionTimeoutMillis:3000,
    idleTimeoutMillis:1000,statement_timeout:10000,query_timeout:12000});
  pool.on('error',()=>{console.error('Idle PostgreSQL publication connection unavailable');});
  let closing:Promise<void>|undefined;
  const close=()=>closing??=pool.end();
  const probe=await pool.connect().catch(async()=>{await close().catch(()=>undefined);throw new Error('Publication draft store unavailable');});
  let initializationError:unknown;
  try {
    const boundary=(await probe.query(`SELECT current_database() AS database,current_user AS role,host(inet_server_addr()) AS host,inet_server_port() AS port,
      (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS unsafe,
      EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user) OR roleid=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS membership`)).rows[0];
    if(boundary.database!==config.expectedDatabase||boundary.role!==config.expectedRole||boundary.host!=="127.0.0.1"||boundary.port!==5432||boundary.unsafe||boundary.membership)
      throw new Error("Publication draft store unavailable");
    const security=(await probe.query(`SELECT
      (SELECT count(*)::int FROM pg_class WHERE relnamespace='nukhabapay'::regnamespace AND relname LIKE 'catalogue_publication_%' AND relkind='r' AND relrowsecurity AND relforcerowsecurity) AS forced,
      bool_and(has_table_privilege(current_user,format('nukhabapay.%I',name),'SELECT') AND has_table_privilege(current_user,format('nukhabapay.%I',name),'INSERT')) AS required,
      bool_or(has_table_privilege(current_user,format('nukhabapay.%I',name),'UPDATE')
        OR has_table_privilege(current_user,format('nukhabapay.%I',name),'DELETE')
        OR has_table_privilege(current_user,format('nukhabapay.%I',name),'TRUNCATE')
        OR has_table_privilege(current_user,format('nukhabapay.%I',name),'TRIGGER')
        OR has_table_privilege(current_user,format('nukhabapay.%I',name),'REFERENCES')) AS excess,
      (has_any_column_privilege(current_user,'nukhabapay.staff_users','SELECT,INSERT,UPDATE')
        OR has_table_privilege(current_user,'nukhabapay.staff_users','DELETE')) AS iam_access,
      (has_any_column_privilege(current_user,'nukhabapay.security_audit_events','SELECT,INSERT,UPDATE')
        OR has_table_privilege(current_user,'nukhabapay.security_audit_events','DELETE')) AS audit_access,
      (SELECT bool_and(has_table_privilege(current_user,format('nukhabapay.%I',name),'SELECT'))
        FROM unnest(ARRAY['catalogue_publication_provider_accounts','catalogue_publication_provider_snapshots','catalogue_publication_provider_offers']) name) AS source_views,
      (has_any_column_privilege(current_user,'nukhabapay.provider_accounts','SELECT,INSERT,UPDATE')
        OR has_any_column_privilege(current_user,'nukhabapay.provider_snapshots','SELECT,INSERT,UPDATE')
        OR has_any_column_privilege(current_user,'nukhabapay.provider_offers','SELECT,INSERT,UPDATE')) AS source_table_access
      FROM unnest(ARRAY['catalogue_publication_candidates','catalogue_publication_sources','catalogue_publication_requests','catalogue_publication_events']) name`)).rows[0];
    if(security.forced!==4||!security.required||security.excess||security.iam_access||security.audit_access||!security.source_views||security.source_table_access)
      throw new Error("Publication draft store unavailable");
  } catch(error) {initializationError=error;} finally {probe.release();}
  if(initializationError!==undefined){await close();throw new Error('Publication draft store unavailable');}

  async function save(value: unknown, submission?: ReturnType<typeof consumeSubmissionEvidence>) {
    if(closing)throw new Error('Publication draft store unavailable');
    return saveDraft(pool,value,submission);
  }
  return Object.freeze({executePublication:(value:unknown)=>executeSyntheticPublication(pool,value),
    save: (value:unknown)=>save(value),
    submit:async(value:unknown)=>{const proof=consumeSubmissionEvidence(value);return save(proof.candidate,proof);},
    async saveCommercialReview(value:unknown) {
      if (closing) throw new Error('Publication draft store unavailable');
      assertPreparedAedCommercialPriceDraft(value);
      const receipt = await saveDraft(pool, value.draft, undefined, undefined, value);
      return Object.freeze({ ...receipt, reviewDigest: value.reviewDigest });
    },
    close});
}

type LocalDraftAuthority = Readonly<{ lease:AdministrationLease; databaseOid:string; marker:string }>;

/** A local draft-only composition. The dedicated login requires separate target qualification. */
export function createLocalCommercialDraftWriter(pool:Pool, pin:Readonly<{setupId:string;databaseOid:string}>,
  authority:AdministrationAuthority) {
  if (!/^[a-f0-9]{32}$/.test(pin.setupId) || !/^[1-9][0-9]{0,9}$/.test(pin.databaseOid)) {
    throw new TypeError('Unqualified commercial draft target');
  }
  const databaseOid=pin.databaseOid, marker='nukhbapay-catalogue-local:'+pin.setupId;
  return Object.freeze({
    async save(review:unknown, identity:VerifiedStaffIdentity) {
      assertPreparedAedCommercialPriceDraft(review);
      const lease=await authority.require(identity,review.draft.tenantId,'pricing.draft');
      if(lease.tenantId!==review.draft.tenantId||!await lease.revalidate())throw new Error('Draft authority unavailable');
      const receipt=await saveDraft(pool,review.draft,undefined,undefined,review,{lease,databaseOid,marker});
      return Object.freeze({...receipt,reviewDigest:review.reviewDigest});
    },
  });
}

async function requireLocalDraftWriter(client:PoolClient, local:LocalDraftAuthority) {
  const { rows:[target] }=await client.query<{qualified:boolean}>(`SELECT
    current_database()='nukhbapay_catalogue' AND current_user='nukhbapay_catalogue_draft_writer'
    AND system_user='scram-sha-256:nukhbapay_catalogue_draft_writer'
    AND host(inet_server_addr())='127.0.0.1' AND inet_server_port()=5432
    AND d.oid::text=$1 AND shobj_description(d.oid,'pg_database')=$2 AND pg_get_userbyid(d.datdba)='nukhbapay_catalogue_migrator'
    AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolbypassrls OR r.rolreplication)
    AND NOT EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)
    AND NOT has_database_privilege(current_user,'nukhbapay_staff','CONNECT')
    AND NOT EXISTS(SELECT FROM unnest(ARRAY['catalogue_publication_candidates','catalogue_publication_requests',
      'catalogue_publication_sources','catalogue_publication_events','price_commercial_draft_evidence']) required(name)
      JOIN pg_class c ON c.oid=format('nukhabapay.%I',required.name)::regclass
      WHERE NOT c.relforcerowsecurity OR NOT row_security_active(c.oid)
        OR NOT has_table_privilege(current_user,c.oid,'SELECT') OR NOT has_table_privilege(current_user,c.oid,'INSERT')
        OR has_table_privilege(current_user,c.oid,'UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES'))
    AND NOT EXISTS(SELECT FROM unnest(ARRAY['product_mappings','catalogue_pricing_proposals','catalogue_pricing_decisions',
      'provider_accounts','provider_snapshots','provider_offers','price_workflow_operations',
      'price_workflow_versions','publication_delivery_outbox']) forbidden(name)
      WHERE has_table_privilege(current_user,format('nukhabapay.%I',name),'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
        OR has_any_column_privilege(current_user,format('nukhabapay.%I',name),'INSERT,UPDATE')) AS qualified
    FROM pg_roles r JOIN pg_database d ON d.datname=current_database() WHERE r.rolname=current_user`,[local.databaseOid,local.marker]);
  if(target?.qualified!==true)throw new Error('Local commercial draft writer unavailable');
}

async function saveDraft(pool: Pool, value: unknown, submission?: ReturnType<typeof consumeSubmissionEvidence>,
  claim?: RefreshClaim, commercial?: AedCommercialPriceDraft, local?:LocalDraftAuthority): Promise<PublicationDraftReceipt> {
    const candidate=assertGeneratedDraftPublicationCandidate(value),client=await pool.connect();
    let broken = false, committing = false;
    const commit = async () => {
      if(local&&!await local.lease.revalidate())throw new Error('Draft authority expired');
      committing = true;
      if ((await client.query("COMMIT")).command !== "COMMIT") throw new Error("Catalogue draft commit unresolved");
      committing = false;
    };
    try {
      // The tenant/product advisory lock is the serialization boundary. READ
      // COMMITTED deliberately takes a fresh snapshot after a concurrent
      // holder commits; SERIALIZABLE would retain the pre-lock snapshot.
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      if(local)await requireLocalDraftWriter(client,local);
      if (claim) {
        const sources = candidate.sourceSnapshots;
        const [source] = sources;
        if (sources.length !== 1 || !source) throw new Error("Refresh draft requires one source");
        await armCatalogueRefreshWrite(client, claim, { tenantId: candidate.tenantId, providerAccountId: source.providerAccountId,
          purpose: "DRAFT", resourceKey: candidate.candidateId });
      }
      if (claim || submission || commercial) {
        const accounts=[...new Set(candidate.sourceSnapshots.map(source=>source.providerAccountId))].sort();
        for(const account of accounts)await lockCatalogueAccount(client,candidate.tenantId,account);
      }
      await client.query("SELECT set_config('nukhabapay.publication_tenant_id',$1,true)",[candidate.tenantId]);
      await client.query("SELECT set_config('nukhabapay.tenant_id',$1,true)",[candidate.tenantId]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${candidate.tenantId}:${candidate.productId}`]);
      if (commercial) {
        const { rows: [rights] } = await client.query<{ bounded: boolean; fresh: boolean }>(
          `SELECT row_security_active(c.oid) AND c.relforcerowsecurity
            AND has_table_privilege(current_user,c.oid,'SELECT') AND has_table_privilege(current_user,c.oid,'INSERT')
            AND NOT has_any_column_privilege(current_user,c.oid,'UPDATE')
            AND NOT has_table_privilege(current_user,c.oid,'DELETE,TRUNCATE,TRIGGER,REFERENCES') AS bounded,
          $1::timestamptz>clock_timestamp() AS fresh
          FROM pg_class c WHERE c.oid='nukhabapay.price_commercial_draft_evidence'::regclass`,
          [commercial.validityDeadline]);
        if (!rights?.bounded || !rights.fresh) throw new PublicationDraftStaleError('Commercial draft evidence unavailable or expired');
      }
      if(local&&commercial){
        for(const key of [
          `finxplor-discovery:${candidate.tenantId}:${commercial.cost.providerAccountId}`,
          `catalogue-review:${candidate.tenantId}:POLICY:ARE_GIFT_CARD`,
          `catalogue-review:${candidate.tenantId}:MAPPING:${commercial.cost.discoveryId}`,
        ])await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[key]);
        const {rows:[authority]}=await client.query<{qualified:boolean}>(`SELECT EXISTS(
          SELECT FROM nukhabapay.catalogue_pricing_proposals p JOIN nukhabapay.catalogue_pricing_decisions r
            ON (r.tenant_id,r.proposal_id)=(p.tenant_id,p.id)
          WHERE p.tenant_id=$1 AND p.kind='POLICY' AND p.scope='ARE_GIFT_CARD' AND p.payload=$2 AND r.decision='APPROVED'
            AND p.version=(SELECT max(n.version) FROM nukhabapay.catalogue_pricing_proposals n
              WHERE (n.tenant_id,n.kind,n.scope)=(p.tenant_id,p.kind,p.scope))
        ) AND EXISTS(
          SELECT FROM nukhabapay.current_catalogue_discoveries d JOIN nukhabapay.catalogue_pricing_proposals p
            ON (p.tenant_id,p.discovery_id)=(d.tenant_id,d.id)
          JOIN nukhabapay.catalogue_pricing_decisions r ON (r.tenant_id,r.proposal_id)=(p.tenant_id,p.id)
          WHERE (d.tenant_id,d.provider_account_id,d.id,d.source_id)=($1,$3,$4,$5)
            AND d.coverage_scope='ARE_GIFT_CARD' AND p.kind='MAPPING' AND p.product_id=$6 AND r.decision='APPROVED'
            AND p.version=(SELECT max(n.version) FROM nukhabapay.catalogue_pricing_proposals n
              WHERE (n.tenant_id,n.kind,n.scope)=(p.tenant_id,p.kind,p.scope))
        ) AS qualified`,[candidate.tenantId,commercial.pricingPolicyPayload,commercial.cost.providerAccountId,
          commercial.cost.discoveryId,commercial.cost.sourceProductId,candidate.productId]);
        if(authority?.qualified!==true)throw new PublicationDraftStaleError('Current mapping and policy approval required');
      }
      if(submission){
        const rights=(await client.query(`SELECT
          (SELECT count(*)::int FROM pg_class WHERE relnamespace='nukhabapay'::regnamespace AND relname IN
            ('price_submission_births','price_submission_evidence','price_submission_events') AND relrowsecurity AND relforcerowsecurity) AS forced,
          bool_and(has_table_privilege(current_user,format('nukhabapay.%I',n),'SELECT') AND has_table_privilege(current_user,format('nukhabapay.%I',n),'INSERT')) AS required,
          bool_or(has_table_privilege(current_user,format('nukhabapay.%I',n),'UPDATE') OR
            has_table_privilege(current_user,format('nukhabapay.%I',n),'DELETE') OR has_table_privilege(current_user,format('nukhabapay.%I',n),'TRUNCATE')) AS excess,
          has_any_column_privilege(current_user,'nukhabapay.price_submission_births','INSERT,UPDATE,SELECT') AS births
          FROM unnest(ARRAY['price_submission_evidence','price_submission_events']) n`)).rows[0];
        if(rights.forced!==3||!rights.required||rights.excess||rights.births)throw new Error("Submission store unavailable");
      }
      if(submission && (!await submission.revalidate() || submission.tenantId!==candidate.tenantId ||
        submissionDigest(submission.canonicalPayload)!==candidate.candidateDigest))throw new Error("Submission denied");
      const existingRequest=await client.query<{candidate_id:string,candidate_digest:string,price_version:string}>(
        `SELECT r.candidate_id,r.candidate_digest,c.price_version::text FROM nukhabapay.catalogue_publication_requests r
         JOIN nukhabapay.catalogue_publication_candidates c ON c.candidate_id=r.candidate_id
         WHERE r.tenant_id=$1 AND r.product_id=$2 AND r.idempotency_key=$3`,[candidate.tenantId,candidate.productId,candidate.idempotencyKey]);
      if(existingRequest.rowCount){
        const row=existingRequest.rows[0]!;if(row.candidate_digest!==candidate.candidateDigest)throw new PublicationDraftConflictError("Idempotency key payload conflict");
        if (commercial) {
          const { rows: [proof] } = await client.query<{ review_digest: string }>(
            "SELECT review_digest FROM nukhabapay.price_commercial_draft_evidence WHERE tenant_id=$1 AND candidate_id=$2 AND operation_id=$3",
            [candidate.tenantId, candidate.candidateId, candidate.operationId]);
          if (proof?.review_digest !== commercial.reviewDigest) {
            throw new PublicationDraftConflictError('Commercial review evidence has changed or is missing');
          }
        }
        if(submission){
          const proof=await client.query("SELECT creator_staff_id FROM nukhabapay.price_submission_evidence WHERE candidate_id=$1 AND tenant_id=$2",[candidate.candidateId,candidate.tenantId]);
          if(!await submission.revalidate() || proof.rows[0]?.creator_staff_id!==submission.creatorStaffId)throw new Error("Legacy or differently attributed draft");
        }
        await commit();return Object.freeze({candidateId:row.candidate_id,priceVersion:Number(row.price_version),outcome:"REPLAYED",execution:"NOT_AUTHORIZED"});
      }
      const existingCandidate=await client.query<{candidate_id:string,price_version:string}>(
        `SELECT candidate_id,price_version::text FROM nukhabapay.catalogue_publication_candidates WHERE candidate_digest=$1`,[candidate.candidateDigest]);
      if(existingCandidate.rowCount){
        if(submission)throw new Error("Existing candidate cannot acquire submission evidence");
        if (commercial) throw new PublicationDraftConflictError('Existing candidate cannot acquire commercial evidence');
        const row=existingCandidate.rows[0]!;
        await client.query(`INSERT INTO nukhabapay.catalogue_publication_requests(operation_id,tenant_id,product_id,idempotency_key,candidate_id,candidate_digest,outcome)
          VALUES($1,$2,$3,$4,$5,$6,'DRAFT_REPLAYED')`,[candidate.operationId,candidate.tenantId,candidate.productId,candidate.idempotencyKey,row.candidate_id,candidate.candidateDigest]);
        await commit();return Object.freeze({candidateId:row.candidate_id,priceVersion:Number(row.price_version),outcome:"REPLAYED",execution:"NOT_AUTHORIZED"});
      }
      const current=await client.query<{version:string}>(`SELECT coalesce(max(price_version),0)::text AS version FROM nukhabapay.catalogue_publication_candidates
        WHERE tenant_id=$1 AND product_id=$2`,[candidate.tenantId,candidate.productId]);
      if(Number(current.rows[0]!.version)!==candidate.expectedPreviousVersion)throw new PublicationDraftStaleError("Publication authority version is stale");
      const product=await client.query<{canonical_product_key:string,currency:string,face_value_minor:string}>(
        `SELECT canonical_product_key,currency,face_value_minor::text FROM nukhabapay.products WHERE id=$1`,[candidate.productId]);
      if(product.rowCount!==1||product.rows[0]!.canonical_product_key!==candidate.canonicalProductId||product.rows[0]!.currency!==candidate.currency||
        BigInt(product.rows[0]!.face_value_minor)!==candidate.baseAmountMinor)throw new PublicationDraftConflictError("Canonical product evidence mismatch");
      const snapshots=local?'provider_snapshots':'catalogue_publication_provider_snapshots';
      const offers=local?'provider_offers':'catalogue_publication_provider_offers';
      const accounts=local?'provider_accounts':'catalogue_publication_provider_accounts';
      for(const source of candidate.sourceSnapshots){
        const snapshot=await client.query<{tenant_id:string,provider_account_id:string,snapshot_key:string,source_version:string,observed_at:Date,completed_at:Date,status:string}>(
          `SELECT tenant_id,provider_account_id,snapshot_key,source_version,observed_at,completed_at,status
           FROM nukhabapay.${snapshots} s WHERE s.id=$1 AND s.tenant_id=$2
           ${submission || commercial ? `AND s.id=(
             SELECT latest.id FROM nukhabapay.${snapshots} latest
             WHERE latest.tenant_id=s.tenant_id AND latest.provider_account_id=s.provider_account_id AND latest.status='COMPLETE'
             ORDER BY latest.observed_at DESC,latest.completed_at DESC,latest.id DESC LIMIT 1
           )` : ""}`,[source.snapshotId,candidate.tenantId]);
        const row=snapshot.rows[0];if(snapshot.rowCount!==1||!row||row.tenant_id!==candidate.tenantId||row.provider_account_id!==source.providerAccountId||
          row.snapshot_key!==source.snapshotKey||row.source_version!==source.sourceVersion||row.status!=="COMPLETE"||
          row.observed_at.toISOString()!==new Date(source.observedAt).toISOString()||row.completed_at.toISOString()!==new Date(source.completedAt).toISOString())
          throw new PublicationDraftConflictError("Source snapshot evidence mismatch");
      }
      const selected=await client.query<{provider_code:string,provider_debit_minor:string,additional_provider_fee_minor:string|null,
        account_status:string, provider_account_id:string,available:boolean,observed_at:Date,valid_until:Date}>(
        `SELECT a.provider_code,o.provider_debit_minor::text,o.additional_provider_fee_minor::text,
          a.status AS account_status,o.provider_account_id,o.available,o.observed_at,o.valid_until
         FROM nukhabapay.${offers} o
         JOIN nukhabapay.${accounts} a ON a.id=o.provider_account_id AND a.tenant_id=o.tenant_id
         WHERE o.tenant_id=$1 AND o.product_id=$2 AND o.provider_snapshot_id=$3 AND o.provider_offer_key=$4
           ${local ? `AND EXISTS (SELECT FROM nukhabapay.product_mappings m
             WHERE (m.tenant_id,m.provider_account_id,m.id,m.mapping_version,m.product_id)=
               (o.tenant_id,o.provider_account_id,o.product_mapping_id,o.product_mapping_version,o.product_id)
               AND m.provider_sku=$5 AND m.status='APPROVED'
               AND m.mapping_version=(SELECT max(n.mapping_version) FROM nukhabapay.product_mappings n
                 WHERE (n.tenant_id,n.provider_account_id,n.provider_sku)=(m.tenant_id,m.provider_account_id,m.provider_sku)))` : ""}
           ${claim ? `AND o.provider_snapshot_id=(
             SELECT s.id FROM nukhabapay.catalogue_publication_provider_snapshots s
             WHERE s.tenant_id=o.tenant_id AND s.provider_account_id=o.provider_account_id AND s.status='COMPLETE'
             ORDER BY s.observed_at DESC,s.completed_at DESC,s.id DESC LIMIT 1
           )` : ""}`,
        [candidate.tenantId,candidate.productId,candidate.selectedSnapshotId,candidate.selectedOfferId,
          ...(local?[commercial?.cost.sourceProductId]:[])]);
      const offer=selected.rows[0];if(selected.rowCount!==1||!offer||offer.provider_code!==candidate.selectedProviderId||
        BigInt(offer.provider_debit_minor)+BigInt(offer.additional_provider_fee_minor??"0")!==candidate.providerCostMinor)
        throw new PublicationDraftConflictError("Selected provider evidence mismatch");
      if (commercial && (offer.account_status !== 'ACTIVE' || offer.available !== true ||
          offer.provider_account_id !== commercial.cost.providerAccountId ||
          BigInt(offer.provider_debit_minor) !== commercial.cost.walletDebitMinor ||
          BigInt(offer.additional_provider_fee_minor ?? '0') !== commercial.cost.additionalFeeMinor ||
          offer.observed_at.toISOString() !== commercial.cost.observedAt ||
          offer.valid_until.toISOString() !== commercial.cost.validUntil)) {
        throw new PublicationDraftConflictError('Selected commercial terms have changed');
      }
      await client.query(`INSERT INTO nukhabapay.catalogue_publication_candidates(candidate_id,candidate_digest,tenant_id,product_id,canonical_product_key,
        price_version,expected_previous_version,currency,base_amount_minor,service_fee_minor,tax_amount_minor,total_amount_minor,provider_cost_minor,
        payment_fee_minor,agent_commission_minor,expected_contribution_minor,pricing_policy_version,rounding_policy,selected_provider_id,selected_offer_id,
        selected_snapshot_id,source_count,evaluated_at,valid_until) VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
        [candidate.candidateId,candidate.tenantId,candidate.productId,candidate.canonicalProductId,candidate.priceVersion,candidate.expectedPreviousVersion,candidate.currency,
          candidate.baseAmountMinor.toString(),candidate.serviceFeeMinor.toString(),candidate.taxAmountMinor.toString(),candidate.totalAmountMinor.toString(),
          candidate.providerCostMinor.toString(),candidate.paymentFeeMinor.toString(),candidate.agentCommissionMinor.toString(),candidate.expectedContributionMinor.toString(),
          candidate.pricingPolicyVersion,candidate.roundingPolicy,candidate.selectedProviderId,candidate.selectedOfferId,candidate.selectedSnapshotId,
          candidate.sourceSnapshots.length,candidate.evaluatedAt,candidate.validUntil]);
      for(const source of candidate.sourceSnapshots)await client.query(`INSERT INTO nukhabapay.catalogue_publication_sources(candidate_id,tenant_id,product_id,snapshot_id,
        provider_account_id,snapshot_key,source_version,observed_at,completed_at,source_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'COMPLETE')`,
        [candidate.candidateId,candidate.tenantId,candidate.productId,source.snapshotId,source.providerAccountId,source.snapshotKey,source.sourceVersion,source.observedAt,source.completedAt]);
      await client.query(`INSERT INTO nukhabapay.catalogue_publication_requests(operation_id,tenant_id,product_id,idempotency_key,candidate_id,candidate_digest,outcome)
        VALUES($1,$2,$3,$4,$5,$6,'DRAFT_CREATED')`,[candidate.operationId,candidate.tenantId,candidate.productId,candidate.idempotencyKey,candidate.candidateId,candidate.candidateDigest]);
      await client.query(`INSERT INTO nukhabapay.catalogue_publication_events(event_id,operation_id,candidate_id,tenant_id,product_id,price_version,candidate_digest,
        event_name,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,'CATALOGUE_PUBLICATION_CANDIDATE_CREATED',$8)`,
        [randomUUID(),candidate.operationId,candidate.candidateId,candidate.tenantId,candidate.productId,candidate.priceVersion,candidate.candidateDigest,candidate.evaluatedAt]);
      if(submission){
        await client.query(`INSERT INTO nukhabapay.price_submission_evidence(candidate_id,tenant_id,product_id,creation_xid,canonical_payload,
          creator_staff_id,issuer,subject,authz_version,membership_version,submitted_at)
          VALUES($1,$2,$3,txid_current(),$4,$5,$6,$7,$8,$9,$10)`,
          [candidate.candidateId,candidate.tenantId,candidate.productId,submission.canonicalPayload,submission.creatorStaffId,
            submission.issuer,submission.subject,submission.authzVersion,submission.membershipVersion,submission.submittedAt]);
        await client.query(`INSERT INTO nukhabapay.price_submission_events(candidate_id,tenant_id,product_id,creator_staff_id,occurred_at)
          VALUES($1,$2,$3,$4,$5)`,[candidate.candidateId,candidate.tenantId,candidate.productId,submission.creatorStaffId,submission.submittedAt]);
        if(!await submission.revalidate())throw new Error("Stale submission authority");
      }
      if (commercial) {
        await client.query(`INSERT INTO nukhabapay.price_commercial_draft_evidence
          (candidate_id,tenant_id,product_id,operation_id,commercial_digest,commercial_payload,review_digest,validity_deadline)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [candidate.candidateId,candidate.tenantId,candidate.productId,candidate.operationId,
          commercial.commercialEvidenceDigest,commercial.cost.canonicalPayload,commercial.reviewDigest,commercial.validityDeadline]);
      }
      await commit();return Object.freeze({candidateId:candidate.candidateId,priceVersion:candidate.priceVersion,outcome:"CREATED",execution:"NOT_AUTHORIZED"});
    } catch(error) {broken=committing;try{await client.query("ROLLBACK");}catch{broken=true;}throw error;} finally {client.release(broken);}
  }

/** Dedicated disposable composition. Caller owns the role and pool lifecycle. */
export function createRefreshFencedDraftWriter(pool: Pool) {
  return Object.freeze({
    async saveFenced(value: unknown, claim: RefreshClaim) {
      if (!claim) throw new Error("Refresh write fence required");
      return saveDraft(pool,value,undefined,claim);
    },
    async submitFenced(value: unknown, claim: RefreshClaim) {
      if (!claim) throw new Error("Refresh write fence required");
      const submission=consumeSubmissionEvidence(value);
      return saveDraft(pool,submission.candidate,submission,claim);
    },
  });
}
