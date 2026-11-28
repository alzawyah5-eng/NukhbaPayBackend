import { AdministrationError, type AdministrationLease, type CatalogueReviewProposal, type CatalogueReviewStore } from '@nukhbapay/application';
import type { Pool, PoolClient } from 'pg';

/** The caller supplies an already qualified, dedicated review workload. */
export function createCataloguePricingReviewStore(pool:Pick<Pool,'connect'>, targetPin:Readonly<{ setupId:string; databaseOid:string }>):CatalogueReviewStore {
  if (!/^[a-f0-9]{32}$/.test(targetPin.setupId) || !/^[1-9][0-9]{0,9}$/.test(targetPin.databaseOid)) {
    throw new Error('Unqualified pricing review target');
  }
  const marker='nukhbapay-catalogue-local:'+targetPin.setupId;
  const oid=targetPin.databaseOid;
  async function withReview<T>(lease:AdministrationLease, effect:(client:PoolClient)=>Promise<T>):Promise<T> {
    if (!await lease.revalidate()) throw new AdministrationError(403);
    const client=await pool.connect();
    let discard=false;
    try {
      await client.query('BEGIN');
      const {rows:[target]}=await client.query<{qualified:boolean}>(`SELECT
        current_database()='nukhbapay_catalogue' AND host(inet_server_addr())='127.0.0.1' AND inet_server_port()=5432
        AND current_user='nukhbapay_catalogue_review_writer' AND system_user='scram-sha-256:nukhbapay_catalogue_review_writer'
        AND NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolinherit OR r.rolreplication)
        AND NOT EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)
        AND d.oid::text=$1 AND shobj_description(d.oid,'pg_database')=$2
        AND pg_get_userbyid(d.datdba)='nukhbapay_catalogue_migrator'
        AND NOT has_database_privilege(current_user,'nukhbapay_staff','CONNECT')
        AND NOT has_table_privilege(current_user,'nukhabapay.price_workflow_versions','INSERT,UPDATE,DELETE,TRUNCATE')
        AND NOT has_table_privilege(current_user,'nukhabapay.product_mappings','INSERT,UPDATE,DELETE,TRUNCATE')
        AND row_security_active('nukhabapay.catalogue_pricing_proposals')
        AND row_security_active('nukhabapay.catalogue_pricing_decisions')
        AND NOT EXISTS(SELECT FROM unnest(ARRAY['catalogue_pricing_proposals','catalogue_pricing_decisions']) names(name)
          WHERE NOT has_table_privilege(current_user,format('nukhabapay.%I',name),'SELECT')
            OR NOT has_table_privilege(current_user,format('nukhabapay.%I',name),'INSERT')
            OR has_table_privilege(current_user,format('nukhabapay.%I',name),'UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')) AS qualified
        FROM pg_roles r JOIN pg_database d ON d.datname=current_database() WHERE r.rolname=current_user`,[oid,marker]);
      if (target?.qualified!==true) throw new AdministrationError(503);
      await client.query("SELECT set_config('nukhabapay.tenant_id',$1,true),set_config('nukhabapay.publication_tenant_id',$1,true)",[lease.tenantId]);
      const result=await effect(client);
      if (!await lease.revalidate()) throw new AdministrationError(403);
      discard=true;
      if ((await client.query('COMMIT')).command!=='COMMIT') throw new AdministrationError(503);
      discard=false;
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(()=>{ discard=true; });
      throw error instanceof AdministrationError ? error : new AdministrationError(503);
    } finally {
      client.release(discard);
    }
  }
  const lock=(client:PoolClient,tenantId:string,kind:string,scope:string)=>client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`catalogue-review:${tenantId}:${kind}:${scope}`]);
  return {
    async append(lease, command) {
      return withReview(lease,async client=>{
        await lock(client,lease.tenantId,command.kind,command.scope);
        if(command.kind==='MAPPING'){
          const {rowCount}=await client.query(`SELECT 1 FROM nukhabapay.current_catalogue_discoveries d
            JOIN nukhabapay.products p ON p.id=$3 AND p.currency=d.currency AND p.redemption_country='AE'
            WHERE d.tenant_id=$1 AND d.id=$2 AND d.coverage_scope='ARE_GIFT_CARD' AND d.currency='AED'
              AND p.fulfillment_method='DIGITAL_PIN' AND lower(p.brand)=lower(d.brand)
              AND EXISTS(SELECT FROM jsonb_array_elements_text(d.denominations) denomination(amount)
                WHERE amount::numeric*100=p.face_value_minor)`,[lease.tenantId,command.discoveryId,command.productId]);
          if(rowCount!==1)throw new AdministrationError(409);
        }
        const {rows:[latest]}=await client.query<{value:number}>(`SELECT coalesce(max(version),0) AS value
          FROM nukhabapay.catalogue_pricing_proposals WHERE tenant_id=$1 AND kind=$2 AND scope=$3`,
        [lease.tenantId,command.kind,command.scope]);
        if(latest?.value!==command.expectedVersion)throw new AdministrationError(409);
        const {rows:[proposal]}=await client.query<CatalogueReviewProposal>(`INSERT INTO nukhabapay.catalogue_pricing_proposals
          (tenant_id,id,kind,scope,version,creator_id,discovery_id,product_id,payload,digest)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          RETURNING id,tenant_id AS "tenantId",creator_id AS "creatorId",kind,scope,version,digest,payload`,
        [lease.tenantId,command.id,command.kind,command.scope,command.expectedVersion+1,lease.staffId,
          command.discoveryId??null,command.productId??null,command.payload,command.digest]);
        if(!proposal)throw new AdministrationError(503);
        return Object.freeze(proposal);
      });
    },
    async decide(lease,command) {
      return withReview(lease,async client=>{
        const {rows:[proposal]}=await client.query<{scope:string}>(`SELECT scope FROM nukhabapay.catalogue_pricing_proposals
          WHERE tenant_id=$1 AND id=$2 AND kind=$3`,[lease.tenantId,command.id,command.kind]);
        if(!proposal)throw new AdministrationError(404);
        await lock(client,lease.tenantId,command.kind,proposal.scope);
        const affected=await client.query(`INSERT INTO nukhabapay.catalogue_pricing_decisions
          (tenant_id,proposal_id,kind,version,digest,creator_id,reviewer_id,decision)
          SELECT p.tenant_id,p.id,p.kind,p.version,p.digest,p.creator_id,$6,$7
          FROM nukhabapay.catalogue_pricing_proposals p
          WHERE p.tenant_id=$1 AND p.id=$2 AND p.kind=$3 AND p.version=$4 AND p.digest=$5 AND p.creator_id<>$6
          AND (p.kind='POLICY' OR EXISTS(SELECT FROM nukhabapay.current_catalogue_discoveries d
            WHERE d.tenant_id=p.tenant_id AND d.id=p.discovery_id AND d.coverage_scope='ARE_GIFT_CARD'))
          AND NOT EXISTS (SELECT FROM nukhabapay.catalogue_pricing_proposals n
            WHERE (n.tenant_id,n.kind,n.scope)=(p.tenant_id,p.kind,p.scope) AND n.version>p.version)
          ON CONFLICT DO NOTHING`,[lease.tenantId,command.id,command.kind,command.version,command.digest,lease.staffId,command.decision]);
        if(affected.rowCount!==1)throw new AdministrationError(409);
      });
    },
  };
}
