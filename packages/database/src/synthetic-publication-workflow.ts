import { lockCatalogueAccount } from "./catalogue-refresh-write-fence.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { consumePublicationCommand, independentlyVerifyPublicationPayload, submissionDigest } from "@nukhbapay/application";

export interface SyntheticPublicationReceipt {
 readonly operationId:string;readonly candidateId:string;readonly action:string;readonly revision:string|null;
 readonly replayed:boolean;readonly synthetic:true;readonly execution:"NOT_AUTHORIZED";
}
/** Internal adapter: the pool comes only from the target/role/grant-validated disposable store. */
export async function executeSyntheticPublication(pool:Pool,value:unknown):Promise<SyntheticPublicationReceipt>{
 const ticket=consumePublicationCommand(value),c=ticket.command,db=await pool.connect();let discard=false;
 async function commit(){
  discard=true;
  if((await db.query("COMMIT")).command!=="COMMIT")throw new Error("Publication commit unresolved");
  discard=false;
 }
 try{
  await db.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  await db.query("SELECT set_config('nukhabapay.publication_tenant_id',$1,true),set_config('nukhabapay.tenant_id',$1,true)",[c.tenantId]);
  const rights=(await db.query(`SELECT
   (SELECT count(*)::int FROM pg_class WHERE relnamespace='nukhabapay'::regnamespace AND relname IN ('price_workflow_operations','price_workflow_approvals','price_workflow_versions','price_workflow_audit') AND relrowsecurity AND relforcerowsecurity) AS forced,
   bool_and(has_table_privilege(current_user,format('nukhabapay.%I',n),'SELECT') AND has_table_privilege(current_user,format('nukhabapay.%I',n),'INSERT')) AS required,
   bool_or(has_any_column_privilege(current_user,format('nukhabapay.%I',n),'UPDATE') OR has_table_privilege(current_user,format('nukhabapay.%I',n),'DELETE,TRUNCATE,TRIGGER,REFERENCES')) AS excess
   FROM unnest(ARRAY['price_workflow_operations','price_workflow_approvals','price_workflow_versions','price_workflow_audit']) n`)).rows[0];
  if(rights.forced!==4||!rights.required||rights.excess||!await ticket.revalidate())throw new Error("Publication authority unavailable");
  const {rows:sourceAccounts}=await db.query<{provider_account_id:string}>(
   "SELECT DISTINCT provider_account_id FROM nukhabapay.catalogue_publication_sources WHERE candidate_id=$1 AND tenant_id=$2 AND product_id=$3 ORDER BY provider_account_id",
   [c.candidateId,c.tenantId,c.productId]);
  // Refresh writers use this same account-before-product lock order.
  for (const {provider_account_id} of sourceAccounts) await lockCatalogueAccount(db,c.tenantId,provider_account_id);
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${c.tenantId}:${c.productId}`]);
  const previous=(await db.query(`SELECT o.*,v.revision::text FROM nukhabapay.price_workflow_operations o LEFT JOIN nukhabapay.price_workflow_versions v USING(operation_id)
   WHERE o.tenant_id=$1 AND o.product_id=$2 AND o.idempotency_key=$3`,[c.tenantId,c.productId,c.idempotencyKey])).rows[0];
  const receipt=(id:string,revision:string|null,replayed:boolean):SyntheticPublicationReceipt=>Object.freeze({operationId:id,candidateId:c.candidateId,action:c.action,revision,replayed,synthetic:true,execution:"NOT_AUTHORIZED"});
  if(previous){
   if(previous.command_digest!==ticket.commandDigest||previous.actor_staff_id!==ticket.staffId)throw new Error("Publication replay conflict");
   if(!await ticket.revalidate())throw new Error("Stale publication authority");
   await commit();return receipt(previous.operation_id,previous.revision??null,true);
  }
  const row=(await db.query(`SELECT c.*,s.canonical_payload,s.creator_staff_id,s.algorithm,s.canonicalization FROM nukhabapay.catalogue_publication_candidates c
   JOIN nukhabapay.price_submission_evidence s USING(candidate_id,tenant_id,product_id)
   JOIN nukhabapay.price_submission_events e USING(candidate_id,tenant_id,product_id,creator_staff_id)
   WHERE c.candidate_id=$1 AND c.tenant_id=$2 AND c.product_id=$3`,[c.candidateId,c.tenantId,c.productId])).rows[0];
  if(!row)throw new Error("Missing evidenced submission");
  const verified=independentlyVerifyPublicationPayload(row.canonical_payload,c.idempotencyKey,c.candidateId),candidate=verified.candidate;
  if(row.algorithm!=="SHA-256"||row.canonicalization!=="BRICK4A_ORDERED_ARRAY_JSON_V1"||submissionDigest(row.canonical_payload)!==c.candidateId||candidate.candidateId!==c.candidateId||
    candidate.tenantId!==c.tenantId||candidate.productId!==c.productId||candidate.priceVersion!==c.candidateVersion||String(row.price_version)!==String(c.candidateVersion)||
    row.source_count!==candidate.sourceSnapshots.length||ticket.staffId===row.creator_staff_id)throw new Error("Invalid digest, version or separation of duties");
  const verifiedAccounts=new Set(candidate.sourceSnapshots.map(source=>source.providerAccountId));
  if (sourceAccounts.length!==verifiedAccounts.size || sourceAccounts.some(source=>!verifiedAccounts.has(source.provider_account_id)))
   throw new Error("Missing source account evidence");
  const amounts={base_amount_minor:candidate.baseAmountMinor,service_fee_minor:candidate.serviceFeeMinor,tax_amount_minor:candidate.taxAmountMinor,total_amount_minor:candidate.totalAmountMinor,
   provider_cost_minor:candidate.providerCostMinor,payment_fee_minor:candidate.paymentFeeMinor,agent_commission_minor:candidate.agentCommissionMinor,expected_contribution_minor:candidate.expectedContributionMinor};
  for(const [key,amount] of Object.entries(amounts))if(BigInt(row[key])!==amount)throw new Error("Financial evidence mismatch");
  if(row.selected_provider_id!==candidate.selectedProviderId||row.selected_offer_id!==candidate.selectedOfferId||row.selected_snapshot_id!==candidate.selectedSnapshotId||
    row.pricing_policy_version!==candidate.pricingPolicyVersion||row.rounding_policy!==candidate.roundingPolicy||row.canonical_product_key!==candidate.canonicalProductId||
    row.evaluated_at.toISOString()!==new Date(candidate.evaluatedAt).toISOString()||row.valid_until.toISOString()!==new Date(candidate.validUntil).toISOString())throw new Error("Candidate provenance mismatch");
  if(Date.parse(candidate.validUntil)<=ticket.currentTimeMs()||Date.parse(candidate.evaluatedAt)>ticket.currentTimeMs())throw new Error("Expired publication candidate");
  const latest=(await db.query("SELECT max(price_version)::text AS version FROM nukhabapay.catalogue_publication_candidates WHERE tenant_id=$1 AND product_id=$2",[c.tenantId,c.productId])).rows[0];
  if(c.action!=="ROLLBACK"&&latest.version!==String(c.candidateVersion))throw new Error("Stale publication candidate");
  await db.query("SELECT nukhabapay.lock_price_workflow_sources($1,$2)",[c.tenantId,c.productId]);
  const product=(await db.query("SELECT canonical_product_key,brand,redemption_country,currency,face_value_minor::text,fulfillment_method,terms_version FROM nukhabapay.products WHERE id=$1",[c.productId])).rows[0];
  const identity=verified.request.product;
  if(!product||product.canonical_product_key!==identity.canonicalProductId||product.brand!==identity.brand||product.redemption_country!==identity.redemptionCountry||
    product.currency!==identity.currency||BigInt(product.face_value_minor)!==identity.faceValueMinor||product.fulfillment_method!==identity.fulfillmentMethod||product.terms_version!==identity.termsVersion)throw new Error("Invalid product provenance");
  for(const source of candidate.sourceSnapshots){
   if(ticket.currentTimeMs()-Date.parse(source.observedAt)>verified.request.pricingPolicy.maximumOfferAgeMs)throw new Error("Stale source provenance");
   const s=(await db.query(`SELECT s.*,a.provider_code,a.status AS account_status FROM nukhabapay.catalogue_publication_provider_snapshots s
    JOIN nukhabapay.catalogue_publication_provider_accounts a ON a.id=s.provider_account_id AND a.tenant_id=s.tenant_id
    WHERE s.id=$1 AND s.tenant_id=$2 AND s.id=(
     SELECT head.id FROM nukhabapay.catalogue_publication_provider_snapshots head
     WHERE head.tenant_id=s.tenant_id AND head.provider_account_id=s.provider_account_id AND head.status='COMPLETE'
     ORDER BY head.observed_at DESC,head.completed_at DESC,head.id DESC LIMIT 1
    )`,[source.snapshotId,c.tenantId])).rows[0];
   if(!s||s.provider_account_id!==source.providerAccountId||s.snapshot_key!==source.snapshotKey||s.source_version!==source.sourceVersion||s.status!=="COMPLETE"||s.account_status!=="ACTIVE"||
    s.observed_at.toISOString()!==new Date(source.observedAt).toISOString()||s.completed_at.toISOString()!==new Date(source.completedAt).toISOString())throw new Error("Invalid source provenance");
   for(const offer of verified.request.offers.filter(o=>o.snapshotId===source.snapshotId)){
    const o=(await db.query(`SELECT * FROM nukhabapay.catalogue_publication_provider_offers WHERE tenant_id=$1 AND product_id=$2 AND provider_snapshot_id=$3 AND provider_offer_key=$4`,[c.tenantId,c.productId,source.snapshotId,offer.offerId])).rows[0];
    if(!o||s.provider_code!==offer.providerId||BigInt(o.provider_debit_minor)!==offer.providerDebitMinor||BigInt(o.upfront_discount_minor??0)!==offer.upfrontDiscountMinor||
      BigInt(o.additional_provider_fee_minor??0)!==offer.additionalProviderFeeMinor||o.available!==offer.available||o.observed_at.toISOString()!==new Date(offer.observedAt).toISOString()||
      o.valid_until.toISOString()!==new Date(offer.validUntil).toISOString())throw new Error("Invalid offer provenance");
   }
  }
  const approval=(await db.query("SELECT * FROM nukhabapay.price_workflow_approvals WHERE candidate_id=$1 AND tenant_id=$2 AND product_id=$3",[c.candidateId,c.tenantId,c.productId])).rows[0];
  const head=(await db.query("SELECT * FROM nukhabapay.price_workflow_versions WHERE tenant_id=$1 AND product_id=$2 ORDER BY revision DESC LIMIT 1",[c.tenantId,c.productId])).rows[0];
  if(c.action==="APPROVE"&&approval)throw new Error("Candidate already approved");
  if(c.action!=="APPROVE"){
   if(!approval||approval.actor_staff_id===ticket.staffId||approval.candidate_digest!==c.candidateId)throw new Error("Missing distinct approval");
   if((head?.operation_id??null)!==c.expectedActiveId)throw new Error("Stale publication head");
   if(c.action==="ACTIVATE"&&head?.candidate_id===c.candidateId)throw new Error("Candidate already active");
   if(c.action==="ROLLBACK"){
    const source=(await db.query("SELECT * FROM nukhabapay.price_workflow_versions WHERE operation_id=$1 AND tenant_id=$2 AND product_id=$3 AND candidate_id=$4",[c.rollbackSourceId,c.tenantId,c.productId,c.candidateId])).rows[0];
    if(!source||!head||BigInt(source.revision)>=BigInt(head.revision)||head.candidate_id===c.candidateId)throw new Error("Invalid rollback source");
   }
  }
  const id=randomUUID(),revision=c.action==="APPROVE"?null:(BigInt(head?.revision??0)+1n).toString();
  await db.query(`INSERT INTO nukhabapay.price_workflow_operations(operation_id,tenant_id,product_id,candidate_id,idempotency_key,command_digest,actor_staff_id,action,issuer,subject,permission,authz_version,membership_version,occurred_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[id,c.tenantId,c.productId,c.candidateId,c.idempotencyKey,ticket.commandDigest,ticket.staffId,c.action,ticket.issuer,ticket.subject,ticket.permission,ticket.authzVersion,ticket.membershipVersion,ticket.occurredAt]);
  if(c.action==="APPROVE")await db.query(`INSERT INTO nukhabapay.price_workflow_approvals(operation_id,candidate_id,tenant_id,product_id,actor_staff_id,candidate_digest) VALUES($1,$2,$3,$4,$5,$2)`,[id,c.candidateId,c.tenantId,c.productId,ticket.staffId]);
  else await db.query(`INSERT INTO nukhabapay.price_workflow_versions(operation_id,tenant_id,product_id,candidate_id,actor_staff_id,revision,previous_id,rollback_source_id,kind,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,c.tenantId,c.productId,c.candidateId,ticket.staffId,revision,c.expectedActiveId,c.rollbackSourceId,c.action,c.reason]);
  await db.query(`INSERT INTO nukhabapay.price_workflow_audit(operation_id,tenant_id,product_id,candidate_id,actor_staff_id,action,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,c.tenantId,c.productId,c.candidateId,ticket.staffId,c.action,ticket.occurredAt]);
  if(!await ticket.revalidate())throw new Error("Stale publication authority");
  const checkedAt=ticket.currentTimeMs();
  if(Date.parse(candidate.validUntil)<=checkedAt||Date.parse(candidate.evaluatedAt)>checkedAt||
    candidate.sourceSnapshots.some(source=>checkedAt-Date.parse(source.observedAt)>verified.request.pricingPolicy.maximumOfferAgeMs))
   throw new Error("Stale publication provenance");
  await commit();return receipt(id,revision,false);
 }catch(error){try{await db.query("ROLLBACK");}catch{discard=true;}throw error;}finally{db.release(discard);}
}
