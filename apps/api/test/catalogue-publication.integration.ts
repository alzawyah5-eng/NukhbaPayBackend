import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareSyntheticPublicationCommand, independentlyVerifyPublicationPayload, type PublicationCommand, type SyntheticPublicationPermission, prepareSyntheticPriceSubmission, submissionDigest, generateDraftPublicationCandidate, prepareAedCommercialPriceDraft, type DraftPublicationRequest } from "@nukhbapay/application";
import { createPublishedCatalogueReader, createCatalogueReadAuditWriter, createCataloguePublicationDraftStore, PublicationDraftConflictError, PublicationDraftStaleError } from "@nukhbapay/database";
import { Client } from "pg";
import { attestVerifiedStaffIdentity } from "@nukhbapay/application/verified-identity";
import { exercisePublishedCatalogueHttp } from "./fixtures/published-catalogue-http.js";
import { forDatabase, withDisposableIamDatabase } from "./fixtures/disposable-iam-database.js";

const root=fileURLToPath(new URL("../../../../",import.meta.url));
const databaseRoot=path.join(root,"packages","database");
const proposedSql=readFileSync(path.join(databaseRoot,"pending-migrations","007_catalogue_publication_drafts.sql"),"utf8");
const grantSql=readFileSync(path.join(databaseRoot,"roles","grant_catalogue_publication_draft_writer.sql"),"utf8");
const {rehearseReviewedMigrations}=await import(pathToFileURL(path.join(root,"scripts","rehearse-reviewed-migrations.mjs")).href);

const expectedHistory=["001_catalog","002_import_role_privileges","003_import_role_read_access","004_staff_identity_foundation","005_staff_workflow_persistence","006_staff_server_sessions"];
const policy=Object.freeze({version:"publication-policy-v1",serviceFeeMinor:200n,maximumServiceFeeMinor:200n,taxAmountMinor:0n,
  paymentFeeBasisPoints:150,paymentFixedFeeMinor:20n,agentCommissionMinor:50n,minimumContributionMinor:100n,maximumOfferAgeMs:86_400_000});
const product=Object.freeze({canonicalProductId:"synthetic_brand_x_ae_aed_100",brand:"SYNTHETIC_BRAND_X",redemptionCountry:"AE" as const,
  currency:"AED" as const,faceValueMinor:10_000n,fulfillmentMethod:"DIGITAL_PIN" as const,termsVersion:"synthetic-terms-v1"});

function identifier(value:string):string {assert.match(value,/^[A-Za-z_][A-Za-z0-9_]{0,62}$/);return `"${value}"`;}
async function ownerFor(databaseName:string):Promise<Client>{const client=new Client({connectionString:forDatabase(process.env["DB_MIGRATION_URL"]!,databaseName)});await client.connect();return client;}

test("proposed 007 provides atomic, immutable, tenant-scoped draft publication evidence",async t=>{
  await withDisposableIamDatabase(async fixture=>{
    await fixture.fixtureClient.query("CREATE SCHEMA nukhabapay AUTHORIZATION nukhabapay_migrator");
    await fixture.fixtureClient.query("GRANT USAGE ON SCHEMA nukhabapay TO nukhabapay_runtime,nukhabapay_importer,nukhabapay_identity_reader,nukhabapay_identity_writer");
    assert.deepEqual(await rehearseReviewedMigrations(forDatabase(process.env["DB_MIGRATION_URL"]!,fixture.databaseName)),expectedHistory);
    const owner=await ownerFor(fixture.databaseName);
    const writerRole=`nukh_publication_${randomUUID().replaceAll("-","").slice(0,20)}`;
    const hostileRole=`nukh_hostile_${randomUUID().replaceAll("-","").slice(0,20)}`;
    let writer:Client|undefined,store:Awaited<ReturnType<typeof createCataloguePublicationDraftStore>>|undefined;
    try {
      await t.test("migration gates reject missing authorization, hostile schema ACL and unexpected defaults",async()=>{
        await owner.query("BEGIN");
        try {await assert.rejects(()=>owner.query(proposedSql),{code:"42501"});} finally {await owner.query("ROLLBACK");}
        assert.equal((await owner.query("SELECT to_regclass('nukhabapay.catalogue_publication_candidates') IS NULL AS absent")).rows[0].absent,true);
        await fixture.fixtureClient.query(`CREATE ROLE ${identifier(hostileRole)} NOLOGIN`);
        await owner.query(`GRANT CREATE ON SCHEMA nukhabapay TO ${identifier(hostileRole)}`);
        await owner.query("BEGIN");
        try {await owner.query("SELECT set_config('nukhbapay.publication_migration','BRICK_4A_SYNTHETIC',true)");await assert.rejects(()=>owner.query(proposedSql),{code:"42501"});}
        finally {await owner.query("ROLLBACK");await owner.query(`REVOKE ALL ON SCHEMA nukhabapay FROM ${identifier(hostileRole)}`);}
        await owner.query(`ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO ${identifier(hostileRole)}`);
        await owner.query("BEGIN");
        try {await owner.query("SELECT set_config('nukhbapay.publication_migration','BRICK_4A_SYNTHETIC',true)");await assert.rejects(()=>owner.query(proposedSql),{code:"42501"});}
        finally {await owner.query("ROLLBACK");await owner.query(`ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM ${identifier(hostileRole)}`);}
        await fixture.fixtureClient.query(`DROP ROLE ${identifier(hostileRole)}`);
      });

      await owner.query("BEGIN");
      try {await owner.query("SELECT set_config('nukhbapay.publication_migration','BRICK_4A_SYNTHETIC',true)");await owner.query(proposedSql);await owner.query("COMMIT");}
      catch(error){await owner.query("ROLLBACK");throw error;}
      assert.deepEqual((await owner.query("SELECT name FROM nukhabapay.schema_migrations ORDER BY id")).rows.map(row=>row.name),expectedHistory);

      await owner.query("BEGIN");
      try {await owner.query("SELECT set_config('nukhbapay.submission_migration','BRICK_4B_FOUNDATION_SYNTHETIC',true)");
        await owner.query(readFileSync(path.join(databaseRoot,"pending-migrations/008_price_submission_evidence.sql"),"utf8"));await owner.query("COMMIT");}
      catch(error){await owner.query("ROLLBACK");throw error;}
      const workflowSql=readFileSync(path.join(databaseRoot,"pending-migrations/009_synthetic_publication_workflow.sql"),"utf8");
      await owner.query("BEGIN");try{await assert.rejects(()=>owner.query(workflowSql),{code:"42501"});}finally{await owner.query("ROLLBACK");}
      await owner.query("BEGIN");try{
        await owner.query("SELECT set_config('nukhbapay.workflow_migration','BRICK_4B_WORKFLOW_SYNTHETIC',true)");await owner.query(workflowSql);await owner.query("COMMIT");
      }catch(error){await owner.query("ROLLBACK");throw error;}
      const readSql=readFileSync(path.join(databaseRoot,"pending-migrations/010_synthetic_published_catalogue.sql"),"utf8");
      await owner.query("BEGIN");try{await assert.rejects(()=>owner.query(readSql),{code:"42501"});}finally{await owner.query("ROLLBACK");}
      await owner.query("BEGIN");try{await owner.query("SELECT set_config('nukhbapay.catalogue_read_migration','BRICK_4B_READ_SYNTHETIC',true)");await owner.query(readSql);await owner.query("COMMIT");}catch(error){await owner.query("ROLLBACK");throw error;}
      await owner.query("BEGIN");
      try {
        for (const name of ["013_catalogue_publication_outbox.sql","013_catalogue_publication_delivery_fence.sql"])
          await owner.query(readFileSync(path.join(databaseRoot,"pending-migrations",name),"utf8"));
        await owner.query("COMMIT");
      } catch(error) {await owner.query("ROLLBACK");throw error;}
      const tenantId=randomUUID(),otherTenantId=randomUUID(),productId=randomUUID(),accountId=randomUUID(),snapshotId=randomUUID(),mappingId=randomUUID(),offerRowId=randomUUID();
      await owner.query("INSERT INTO nukhabapay.tenants(id,tenant_key) VALUES($1,'publication-tenant'),($2,'other-publication-tenant')",[tenantId,otherTenantId]);
      await owner.query(`INSERT INTO nukhabapay.products(id,canonical_product_key,brand,redemption_country,currency,face_value_minor,fulfillment_method,terms_version)
        VALUES($1,$2,$3,'AE','AED',10000,'DIGITAL_PIN',$4)`,[productId,product.canonicalProductId,product.brand,product.termsVersion]);
      await owner.query(`INSERT INTO nukhabapay.provider_accounts(id,tenant_id,provider_code,external_account_key,status) VALUES($1,$2,'SYNTH_PROVIDER_A','synthetic-account','ACTIVE')`,[accountId,tenantId]);
      await owner.query(`INSERT INTO nukhabapay.provider_snapshots(id,tenant_id,provider_account_id,snapshot_key,source_version,observed_at,status,row_count,completed_at)
        VALUES($1,$2,$3,'publication-snapshot-1','synthetic-v1','2026-11-09T09:00:00Z','COMPLETE',1,'2026-11-09T09:05:00Z')`,[snapshotId,tenantId,accountId]);
      await owner.query(`INSERT INTO nukhabapay.product_mappings(id,tenant_id,provider_account_id,provider_sku,product_id,mapping_version,status,provenance_kind,provenance,source_snapshot_id)
        VALUES($1,$2,$3,'SYNTH-100',$4,1,'APPROVED','IMPORT','{"source":"synthetic"}'::jsonb,$5)`,[mappingId,tenantId,accountId,productId,snapshotId]);
      await owner.query(`INSERT INTO nukhabapay.provider_offers(id,tenant_id,provider_account_id,provider_snapshot_id,product_mapping_id,product_mapping_version,product_id,
        face_value_minor,provider_offer_key,provider_debit_minor,additional_provider_fee_minor,upfront_discount_minor,available,observed_at,valid_until)
        VALUES($1,$2,$3,$4,$5,1,$6,10000,'offer-100',9600,50,400,true,'2026-11-09T09:00:00Z','2026-11-09T11:00:00Z')`,
        [offerRowId,tenantId,accountId,snapshotId,mappingId,productId]);

      await fixture.fixtureClient.query(`CREATE ROLE ${identifier(writerRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
      await owner.query("BEGIN");
      try {await owner.query("SELECT set_config('nukhabapay.publication_writer_role',$1,true)",[writerRole]);await owner.query(grantSql);await owner.query(readFileSync(path.join(databaseRoot,"roles/grant_price_submission_writer.sql"),"utf8"));await owner.query(readFileSync(path.join(databaseRoot,"roles/grant_synthetic_publication_writer.sql"),"utf8"));await owner.query("COMMIT");}
      catch(error){await owner.query("ROLLBACK");throw error;}
      await owner.query(`GRANT INSERT ON nukhabapay.publication_delivery_outbox,nukhabapay.publication_delivery_state,
        nukhabapay.publication_delivery_audit TO ${identifier(writerRole)}`);
      await owner.query(`GRANT USAGE ON SEQUENCE nukhabapay.publication_delivery_audit_sequence_seq TO ${identifier(writerRole)}`);
      const writerUrl=new URL(forDatabase(process.env["DB_TEST_ADMIN_URL"]!,fixture.databaseName));writerUrl.username=writerRole;writerUrl.password=randomUUID();
      store=await createCataloguePublicationDraftStore({connectionString:writerUrl.href,expectedRole:writerRole,expectedDatabase:fixture.databaseName,poolMax:2});
      writer=new Client({connectionString:writerUrl.href});await writer.connect();

      const request:DraftPublicationRequest={tenantId,productId,product,sourceSnapshots:[{snapshotId,providerAccountId:accountId,snapshotKey:"publication-snapshot-1",
        sourceVersion:"synthetic-v1",observedAt:"2026-11-09T09:00:00Z",completedAt:"2026-11-09T09:05:00Z",status:"COMPLETE"}],
        offers:[{providerId:"SYNTH_PROVIDER_A",offerId:"offer-100",snapshotId,identity:product,mappingStatus:"APPROVED",providerDebitMinor:9600n,
          upfrontDiscountMinor:400n,additionalProviderFeeMinor:50n,available:true,eligible:true,observedAt:"2026-11-09T09:00:00Z",validUntil:"2026-11-09T11:00:00Z"}],
        pricingPolicy:policy,evaluatedAt:"2026-11-09T10:00:00Z",expectedPreviousVersion:0,idempotencyKey:randomUUID()};
      const candidate=generateDraftPublicationCandidate(request);

      await t.test("restricted role has exact draft-only rights and forced RLS",async()=>{
        const forced=await owner.query("SELECT count(*)::int AS n,bool_and(relrowsecurity AND relforcerowsecurity) AS forced FROM pg_class WHERE relnamespace='nukhabapay'::regnamespace AND relname LIKE 'catalogue_publication_%' AND relkind='r'");
        assert.deepEqual(forced.rows[0],{n:4,forced:true});
        for(const table of ["catalogue_publication_candidates","catalogue_publication_sources","catalogue_publication_requests","catalogue_publication_events"]){
          assert.equal((await owner.query("SELECT has_table_privilege($1,$2,'SELECT') AS s,has_table_privilege($1,$2,'INSERT') AS i,has_table_privilege($1,$2,'UPDATE') AS u,has_table_privilege($1,$2,'DELETE') AS d",[writerRole,`nukhabapay.${table}`])).rows[0].s,true);
          const row=(await owner.query("SELECT has_table_privilege($1,$2,'INSERT') AS i,has_table_privilege($1,$2,'UPDATE') AS u,has_table_privilege($1,$2,'DELETE') AS d",[writerRole,`nukhabapay.${table}`])).rows[0];assert.deepEqual(row,{i:true,u:false,d:false});
          for(const workload of ["nukhabapay_runtime","nukhabapay_importer","nukhabapay_identity_reader","nukhabapay_identity_writer"])
            assert.equal((await owner.query("SELECT has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE') OR has_table_privilege($1,$2,'DELETE') AS yes",[workload,`nukhabapay.${table}`])).rows[0].yes,false);
        }
        assert.equal((await owner.query("SELECT has_any_column_privilege($1,'nukhabapay.staff_users','SELECT,INSERT,UPDATE') OR has_table_privilege($1,'nukhabapay.staff_users','DELETE') AS yes",[writerRole])).rows[0].yes,false);
        for(const source of ["provider_accounts","provider_snapshots","provider_offers"])
          assert.equal((await owner.query("SELECT has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE') AS yes",[writerRole,`nukhabapay.${source}`])).rows[0].yes,false);
        for(const projection of ["catalogue_publication_provider_accounts","catalogue_publication_provider_snapshots","catalogue_publication_provider_offers"])
          assert.equal((await owner.query("SELECT has_table_privilege($1,$2,'SELECT') AS yes",[writerRole,`nukhabapay.${projection}`])).rows[0].yes,true);
        await assert.rejects(()=>writer!.query("UPDATE nukhabapay.catalogue_publication_candidates SET status='DRAFT'"),{code:"42501"});
        assert.equal((await writer!.query("SELECT count(*)::int AS n FROM nukhabapay.catalogue_publication_candidates")).rows[0].n,0);
      });

      await t.test("concurrent generation converges, replay is strict and cross-tenant evidence is denied",async()=>{
        await assert.rejects(()=>store!.save({...candidate}),/Untrusted publication candidate/);
        const results=await Promise.all(Array.from({length:8},()=>store!.save(candidate)));
        assert.equal(results.filter(result=>result.outcome==="CREATED").length,1);assert.equal(results.filter(result=>result.outcome==="REPLAYED").length,7);
        const changed=generateDraftPublicationCandidate({...request,pricingPolicy:{...policy,version:"publication-policy-v2"}});
        await assert.rejects(()=>store!.save(changed),PublicationDraftConflictError);
        const otherKey=generateDraftPublicationCandidate({...request,idempotencyKey:randomUUID()});
        assert.equal((await store!.save(otherKey)).outcome,"REPLAYED");
        const stale=generateDraftPublicationCandidate({...request,idempotencyKey:randomUUID(),pricingPolicy:{...policy,version:"publication-policy-v3"}});
        await assert.rejects(()=>store!.save(stale),PublicationDraftStaleError);
        const crossTenant=generateDraftPublicationCandidate({...request,tenantId:otherTenantId,idempotencyKey:randomUUID()});
        await assert.rejects(()=>store!.save(crossTenant),PublicationDraftConflictError);
        const counts=(await fixture.fixtureClient.query("SELECT (SELECT count(*)::int FROM nukhabapay.catalogue_publication_candidates) candidates,(SELECT count(*)::int FROM nukhabapay.catalogue_publication_requests) requests,(SELECT count(*)::int FROM nukhabapay.catalogue_publication_events) events")).rows[0];
        assert.deepEqual(counts,{candidates:1,requests:2,events:1});
      });

      await t.test("version advancement is explicit and audit failure rolls back every record",async()=>{
        const versionTwo=generateDraftPublicationCandidate({...request,expectedPreviousVersion:1,idempotencyKey:randomUUID(),pricingPolicy:{...policy,version:"publication-policy-v2"}});
        assert.deepEqual(await store!.save(versionTwo),{candidateId:versionTwo.candidateId,priceVersion:2,outcome:"CREATED",execution:"NOT_AUTHORIZED"});
        await owner.query(`CREATE FUNCTION nukhabapay.reject_test_publication_event() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $f$ BEGIN RAISE EXCEPTION 'synthetic audit outage' USING ERRCODE='40001'; END $f$`);
        await owner.query("REVOKE ALL ON FUNCTION nukhabapay.reject_test_publication_event() FROM PUBLIC");
        await owner.query("CREATE TRIGGER reject_test_publication_event BEFORE INSERT ON nukhabapay.catalogue_publication_events FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_test_publication_event()");
        try {
          const versionThree=generateDraftPublicationCandidate({...request,expectedPreviousVersion:2,idempotencyKey:randomUUID(),pricingPolicy:{...policy,version:"publication-policy-v3"}});
          await assert.rejects(()=>store!.save(versionThree),{code:"40001"});
        } finally {await owner.query("DROP TRIGGER reject_test_publication_event ON nukhabapay.catalogue_publication_events");await owner.query("DROP FUNCTION nukhabapay.reject_test_publication_event() ");}
        const counts=(await fixture.fixtureClient.query("SELECT (SELECT count(*)::int FROM nukhabapay.catalogue_publication_candidates) candidates,(SELECT count(*)::int FROM nukhabapay.catalogue_publication_sources) sources,(SELECT count(*)::int FROM nukhabapay.catalogue_publication_requests) requests,(SELECT count(*)::int FROM nukhabapay.catalogue_publication_events) events")).rows[0];
        assert.deepEqual(counts,{candidates:2,sources:2,requests:3,events:2});
        assert.equal((await fixture.fixtureClient.query("SELECT bool_and(status='DRAFT' AND execution='NOT_AUTHORIZED' AND NOT activation_allowed) AS safe FROM nukhabapay.catalogue_publication_candidates")).rows[0].safe,true);
      });

      await t.test("tenant RLS hides records without exact scope and connections recover after failures",async()=>{
        await writer!.query("BEGIN");try {await writer!.query("SELECT set_config('nukhabapay.publication_tenant_id',$1,true)",[tenantId]);assert.equal((await writer!.query("SELECT count(*)::int AS n FROM nukhabapay.catalogue_publication_candidates")).rows[0].n,2);}finally{await writer!.query("ROLLBACK");}
        await writer!.query("BEGIN");try {await writer!.query("SELECT set_config('nukhabapay.publication_tenant_id',$1,true)",[otherTenantId]);assert.equal((await writer!.query("SELECT count(*)::int AS n FROM nukhabapay.catalogue_publication_candidates")).rows[0].n,0);}finally{await writer!.query("ROLLBACK");}
        const replay=await store!.save(candidate);assert.equal(replay.outcome,"REPLAYED");
      });
      await t.test("008 submission attribution, canonical evidence, legacy denial and atomic audit",async foundation=>{
        const staffId=randomUUID(),now=()=>new Date("2026-11-09T10:00:00Z");
        const identity=attestVerifiedStaffIdentity({issuer:"https://staff.invalid/",subject:"creator-1",security:{audience:"test",clientId:"test",
          profile:"rfc9068-staff-v1",principalKind:"human",issuedAt:Date.parse("2026-11-09T09:00:00Z")/1000,expiresAt:Date.parse("2026-11-09T11:00:00Z")/1000,assurance:"not-established"}});
        let auditFailure=false,allowed=true;
        const deps={capability:"ISOLATED_SYNTHETIC_SUBMISSION_ONLY" as const,now,auditWriter:{appendSecurityAuditEvents:async()=>{if(auditFailure)throw new Error("audit down");}},
          repository:{findByTrustedIdentity:async()=>({staffId,staffStatus:"ACTIVE" as const,identityStatus:"ACTIVE" as const,authzVersion:1n,tokensValidAfter:null}),
            findPlatformRoleGrants:async()=>[],findTenantMembership:async()=>({membershipId:randomUUID(),tenantId:allowed?tenantId:otherTenantId,status:"ACTIVE" as const,version:1n,
              roleGrants:[{roleCode:"PRICING_EDITOR",scope:"TENANT" as const,grantedAt:"2026-11-01T00:00:00Z",expiresAt:null,revokedAt:null}]})}};
        // Stable membership identity is part of freshness evidence.
        const membershipId=randomUUID();const membershipLookup=deps.repository.findTenantMembership;
        deps.repository.findTenantMembership=async()=>({...await membershipLookup(),membershipId});
        const freshRequest={...request,expectedPreviousVersion:2,idempotencyKey:randomUUID(),pricingPolicy:{...policy,version:"evidenced-v3"}};
        await assert.rejects(()=>store!.submit({...candidate}),/Untrusted/);
        await assert.rejects(()=>prepareSyntheticPriceSubmission(deps,{...identity},freshRequest),/denied/);
        allowed=false;await assert.rejects(()=>prepareSyntheticPriceSubmission(deps,identity,freshRequest),/denied/);allowed=true;
        auditFailure=true;await assert.rejects(()=>prepareSyntheticPriceSubmission(deps,identity,freshRequest),/audit down/);auditFailure=false;
        const legacy=await prepareSyntheticPriceSubmission(deps,identity,request);
        await assert.rejects(()=>store!.submit(legacy),/Legacy/);
        const rawInsert=async(payload:string|null)=>{
          await writer!.query("BEGIN");try{
            await writer!.query("SELECT set_config('nukhabapay.publication_tenant_id',$1,true)",[tenantId]);
            await writer!.query(`INSERT INTO nukhabapay.price_submission_evidence(candidate_id,tenant_id,product_id,creation_xid,canonical_payload,
              creator_staff_id,issuer,subject,authz_version,membership_version,submitted_at)
              VALUES($1,$2,$3,txid_current(),$4,$5,'https://staff.invalid/','creator-1',1,1,$6)`,
              [candidate.candidateId,tenantId,productId,payload,staffId,now().toISOString()]);
          }finally{await writer!.query("ROLLBACK");}
        };
        await assert.rejects(()=>rawInsert(null),{code:"23502"});
        await assert.rejects(()=>rawInsert(legacy.canonicalPayload+" "),{code:"23514"});
        await assert.rejects(()=>rawInsert(legacy.canonicalPayload),{code:"23503"});
        const proof=await prepareSyntheticPriceSubmission(deps,identity,freshRequest);
        assert.equal(proof.creatorStaffId,staffId);assert.equal(submissionDigest(proof.canonicalPayload),proof.candidate.candidateDigest);
        assert.notEqual(submissionDigest(proof.canonicalPayload+" "),proof.candidate.candidateDigest);
        await owner.query(`CREATE TRIGGER reject_submission_audit BEFORE INSERT ON nukhabapay.price_submission_events FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_publication_evidence_mutation()`);
        await assert.rejects(()=>store!.submit(proof),{code:"42501"});
        assert.equal((await fixture.fixtureClient.query("SELECT count(*)::int AS n FROM nukhabapay.price_submission_evidence")).rows[0].n,0);
        await owner.query("DROP TRIGGER reject_submission_audit ON nukhabapay.price_submission_events");
        const results=await Promise.all([1,2].map(async()=>store!.submit(await prepareSyntheticPriceSubmission(deps,identity,freshRequest))));
        assert.equal(results.filter(r=>r.outcome==="CREATED").length,1);
        assert.equal(results.filter(r=>r.outcome==="REPLAYED").length,1);
        const row=(await fixture.fixtureClient.query("SELECT * FROM nukhabapay.price_submission_evidence")).rows[0];
        assert.equal(row.creator_staff_id,staffId);assert.equal(submissionDigest(row.canonical_payload),row.candidate_id);
        await assert.rejects(()=>fixture.fixtureClient.query("UPDATE nukhabapay.price_submission_evidence SET subject='tampered'"),{code:"42501"});
        await foundation.test("synthetic approval, activation and rollback preserve authority and immutable history",async workflow=>{
          const approver=randomUUID(),operator=randomUUID();let permissionDenied=false,tenantMismatch=false,authorityRevoked=false;
          const actor=(id:string,role:string,permission:SyntheticPublicationPermission)=>{
            const member=randomUUID(),who=attestVerifiedStaffIdentity({...identity,subject:id});
            const authority={capability:"ISOLATED_SYNTHETIC_PUBLICATION_ONLY" as const,now,auditWriter:deps.auditWriter,
              repository:{findByTrustedIdentity:async()=>({staffId:id,staffStatus:(authorityRevoked?"SUSPENDED":"ACTIVE") as "ACTIVE"|"SUSPENDED",identityStatus:"ACTIVE" as const,authzVersion:1n,tokensValidAfter:null}),
                findPlatformRoleGrants:async()=>[],findTenantMembership:async()=>({membershipId:member,tenantId:tenantMismatch?otherTenantId:tenantId,status:"ACTIVE" as const,version:1n,
                  roleGrants:[{roleCode:role,scope:"TENANT" as const,grantedAt:"2026-11-01T00:00:00Z",expiresAt:null,revokedAt:null}]})},
              allows:async(_context:unknown,p:SyntheticPublicationPermission)=>!permissionDenied&&permission===p};
            return {who,authority};
          };
          const reviewer=actor(approver,"PRICING_APPROVER","pricing.approve"),publisher=actor(operator,"PUBLICATION_OPERATOR","pricing.activate"),roller=actor(operator,"PUBLICATION_OPERATOR","publication.rollback");
          const candidate3=proof.candidate;
          const command=(action:PublicationCommand["action"],candidateId=candidate3.candidateId,candidateVersion=3,expectedActiveId:string|null=null):PublicationCommand=>({
            action,candidateId,candidateVersion,tenantId,productId,expectedActiveId,idempotencyKey:randomUUID(),rollbackSourceId:null,reason:null});
          const run=async(a:typeof reviewer,c:PublicationCommand)=>store!.executePublication(await prepareSyntheticPublicationCommand(a.authority,a.who,c));
          const approve=command("APPROVE");
          await assert.rejects(()=>prepareSyntheticPublicationCommand(reviewer.authority,undefined as unknown as typeof identity,approve),/denied/);
          await assert.rejects(()=>prepareSyntheticPublicationCommand(reviewer.authority,{...reviewer.who},approve),/denied/);
          permissionDenied=true;await assert.rejects(()=>run(reviewer,approve),/denied/);permissionDenied=false;
          tenantMismatch=true;await assert.rejects(()=>run(reviewer,approve),/denied/);tenantMismatch=false;
          await assert.rejects(()=>run(actor(staffId,"PRICING_APPROVER","pricing.approve"),approve),/separation/);
          await assert.rejects(()=>run(reviewer,{...approve,tenantId:otherTenantId}),/denied|Missing/);
          await assert.rejects(()=>run(reviewer,command("APPROVE",candidate.candidateId,1)),/Missing/);
          await assert.rejects(()=>run(publisher,command("ACTIVATE")),/Missing distinct approval/);
          const staleTicket=await prepareSyntheticPublicationCommand(reviewer.authority,reviewer.who,approve);
          authorityRevoked=true;await assert.rejects(()=>store!.executePublication(staleTicket),/unavailable/);authorityRevoked=false;
          assert.throws(()=>independentlyVerifyPublicationPayload(row.canonical_payload+" ",randomUUID(),row.candidate_id),/Noncanonical/);
          assert.throws(()=>independentlyVerifyPublicationPayload(row.canonical_payload.replace('evidenced-v3','tampered'),randomUUID(),row.candidate_id),/digest/);
          // A rejecting audit trigger must roll back both the operation and approval.
          await owner.query(`CREATE TRIGGER reject_workflow_audit BEFORE INSERT ON nukhabapay.price_workflow_audit FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_publication_evidence_mutation()`);
          await assert.rejects(()=>run(reviewer,approve),{code:"42501"});
          assert.equal((await fixture.fixtureClient.query("SELECT count(*)::int AS n FROM nukhabapay.price_workflow_operations")).rows[0].n,0);
          await owner.query("DROP TRIGGER reject_workflow_audit ON nukhabapay.price_workflow_audit");
          const deliveries=async ()=>(await fixture.fixtureClient.query(`SELECT e.event_id,e.kind,e.revision::text,s.status
            FROM nukhabapay.publication_delivery_outbox e JOIN nukhabapay.publication_delivery_state s USING(tenant_id,event_id)
            WHERE e.tenant_id=$1 AND e.product_id=$2 ORDER BY e.revision`,[tenantId,productId])).rows;
          const approvals=await Promise.all([run(reviewer,approve),run(reviewer,approve)]);
          assert.equal(approvals.filter(r=>r.replayed).length,1);
          assert.equal((await deliveries()).length,0);
          await assert.rejects(()=>run(reviewer,{...approve,candidateVersion:2}),/replay conflict/);
          await assert.rejects(()=>run(reviewer,{...approve,idempotencyKey:randomUUID()}),/already approved/);
          await assert.rejects(()=>run(actor(approver,"PUBLICATION_OPERATOR","pricing.activate"),command("ACTIVATE")),/Missing distinct approval/);
          const activate=command("ACTIVATE");
          await owner.query(`CREATE FUNCTION nukhabapay.skip_workflow_audit_test() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $f$ BEGIN RETURN NULL;END $f$`);
          await owner.query("REVOKE ALL ON FUNCTION nukhabapay.skip_workflow_audit_test() FROM PUBLIC");
          await owner.query(`CREATE TRIGGER skip_workflow_audit BEFORE INSERT ON nukhabapay.price_workflow_audit FOR EACH ROW EXECUTE FUNCTION nukhabapay.skip_workflow_audit_test()`);
          await assert.rejects(()=>run(publisher,activate),{code:"23514"});
          assert.equal((await fixture.fixtureClient.query("SELECT count(*)::int AS n FROM nukhabapay.price_workflow_versions")).rows[0].n,0);
          assert.equal((await deliveries()).length,0);
          await owner.query("DROP TRIGGER skip_workflow_audit ON nukhabapay.price_workflow_audit");
          await owner.query("DROP FUNCTION nukhabapay.skip_workflow_audit_test()");
          const versions=await Promise.all([run(publisher,activate),run(publisher,activate)]);
          assert.equal(versions.filter(r=>r.replayed).length,1);const first=versions[0]!;
          await assert.rejects(()=>run(publisher,{...activate,idempotencyKey:randomUUID()}),/Stale/);
          const nextRequest={...freshRequest,expectedPreviousVersion:3,idempotencyKey:randomUUID(),pricingPolicy:{...policy,version:"evidenced-v4",serviceFeeMinor:300n,maximumServiceFeeMinor:300n}};
          const nextProof=await prepareSyntheticPriceSubmission(deps,identity,nextRequest);await store!.submit(nextProof);
          await assert.rejects(()=>run(reviewer,{...approve,idempotencyKey:randomUUID()}),/Stale/);
          const approve4=command("APPROVE",nextProof.candidate.candidateId,4);
          const approvalRace=await Promise.allSettled([run(reviewer,approve4),run(reviewer,{...approve4,idempotencyKey:randomUUID()})]);
          assert.equal(approvalRace.filter(r=>r.status==="fulfilled").length,1);
          const activate4=command("ACTIVATE",nextProof.candidate.candidateId,4,first.operationId);
          // Concurrent distinct commands must have exactly one winner at the expected head.
          const race=await Promise.allSettled([run(publisher,activate4),run(publisher,{...activate4,idempotencyKey:randomUUID()})]);
          assert.equal(race.filter(r=>r.status==="fulfilled").length,1);
          const winner=race.find(r=>r.status==="fulfilled")!;assert.equal(winner.status,"fulfilled");if(winner.status!=="fulfilled")throw new Error("No activation winner");
          const second=winner.value;
          const rollback:PublicationCommand={...command("ROLLBACK",candidate3.candidateId,3,second.operationId),rollbackSourceId:first.operationId,reason:"Restore synthetic reviewed price"};
          await assert.rejects(()=>run(publisher,rollback),/denied/);
          await assert.rejects(()=>run(roller,{...rollback,reason:null}),/Invalid/);
          await assert.rejects(()=>run(roller,{...rollback,rollbackSourceId:second.operationId}),/Invalid rollback/);
          await owner.query(`CREATE TRIGGER reject_workflow_audit BEFORE INSERT ON nukhabapay.price_workflow_audit FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_publication_evidence_mutation()`);
          await assert.rejects(()=>run(roller,rollback),{code:"42501"});
          await owner.query("DROP TRIGGER reject_workflow_audit ON nukhabapay.price_workflow_audit");
          assert.equal((await fixture.fixtureClient.query("SELECT count(*)::int AS n FROM nukhabapay.price_workflow_versions")).rows[0].n,2);
          const restored=await run(roller,rollback);assert.equal(restored.revision,"3");assert.equal((await run(roller,rollback)).replayed,true);
          const history=(await fixture.fixtureClient.query("SELECT candidate_id,revision::text,rollback_source_id,previous_id FROM nukhabapay.price_workflow_versions ORDER BY revision")).rows;
          assert.deepEqual(history.map(r=>r.revision),["1","2","3"]);assert.equal(history[2].candidate_id,candidate3.candidateId);assert.equal(history[2].rollback_source_id,first.operationId);assert.equal(history[2].previous_id,second.operationId);
          assert.equal((await fixture.fixtureClient.query("SELECT count(*)::int AS n FROM nukhabapay.price_workflow_audit")).rows[0].n,5);
          const prices=(await fixture.fixtureClient.query("SELECT c.total_amount_minor::text AS total FROM nukhabapay.price_workflow_versions v JOIN nukhabapay.catalogue_publication_candidates c USING(candidate_id,tenant_id,product_id) ORDER BY v.revision")).rows;
          assert.deepEqual(prices.map(r=>r.total),["10200","10300","10200"]);
          assert.deepEqual(await deliveries(),[
            {event_id:first.operationId,kind:"ACTIVATE",revision:"1",status:"PENDING"},
            {event_id:second.operationId,kind:"ACTIVATE",revision:"2",status:"PENDING"},
            {event_id:restored.operationId,kind:"ROLLBACK",revision:"3",status:"PENDING"},
          ]);
          await workflow.test("published-only payment and kiosk APIs enforce independent client and reader boundaries",async()=>{
            const readerRole=`nukh_catalogue_${randomUUID().replaceAll("-","").slice(0,20)}`,auditRole=`nukh_read_audit_${randomUUID().replaceAll("-","").slice(0,20)}`;
            let reader:Awaited<ReturnType<typeof createPublishedCatalogueReader>>|undefined,audit:Awaited<ReturnType<typeof createCatalogueReadAuditWriter>>|undefined;
            try{
              for(const role of [readerRole,auditRole])await fixture.fixtureClient.query(`CREATE ROLE ${identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
              await owner.query("BEGIN");try{await owner.query("SELECT set_config('nukhabapay.catalogue_reader_role',$1,true),set_config('nukhabapay.catalogue_audit_role',$2,true)",[readerRole,auditRole]);await owner.query(readFileSync(path.join(databaseRoot,"roles/grant_published_catalogue_clients.sql"),"utf8"));await owner.query("COMMIT");}catch(error){await owner.query("ROLLBACK");throw error;}
              const config=(role:string)=>{const u=new URL(forDatabase(process.env["DB_TEST_ADMIN_URL"]!,fixture.databaseName));u.username=role;u.password=randomUUID();return {connectionString:u.href,expectedRole:role,expectedDatabase:fixture.databaseName};};
              const readerConfig=config(readerRole);reader=await createPublishedCatalogueReader(readerConfig);audit=await createCatalogueReadAuditWriter(config(auditRole));
              const direct=new Client({connectionString:readerConfig.connectionString});await direct.connect();try{
                assert.equal((await direct.query("SELECT count(product_id)::int AS n FROM nukhabapay.published_catalogue_public")).rows[0].n,0);
                for(const table of ["catalogue_publication_candidates","price_submission_evidence","price_workflow_versions","price_workflow_audit","published_catalogue_read_audit","provider_offers","staff_users"]){await assert.rejects(()=>direct.query(`SELECT * FROM nukhabapay.${table}`),{code:"42501"});}
                await assert.rejects(()=>direct.query("DELETE FROM nukhabapay.published_catalogue_read_audit"),{code:"42501"});
              }finally{await direct.end();}
              await owner.query(`GRANT SELECT ON nukhabapay.catalogue_publication_candidates TO ${identifier(readerRole)}`);
              await assert.rejects(()=>createPublishedCatalogueReader(readerConfig),/unavailable/);
              await owner.query(`REVOKE SELECT ON nukhabapay.catalogue_publication_candidates FROM ${identifier(readerRole)}`);
              const secondProductId=randomUUID(),unpublishedId=randomUUID(),secondAccount=randomUUID(),secondSnapshot=randomUUID(),secondMapping=randomUUID(),secondOffer=randomUUID();
              const secondProduct={...product,canonicalProductId:product.canonicalProductId+"_second"};
              await owner.query(`INSERT INTO nukhabapay.products(id,canonical_product_key,brand,redemption_country,currency,face_value_minor,fulfillment_method,terms_version) VALUES($1,$2,$3,'AE','AED',10000,'DIGITAL_PIN',$4),($5,$6,$3,'AE','AED',10000,'DIGITAL_PIN',$4)`,[secondProductId,secondProduct.canonicalProductId,product.brand,product.termsVersion,unpublishedId,product.canonicalProductId+"_unpublished"]);
              await owner.query("INSERT INTO nukhabapay.provider_accounts(id,tenant_id,provider_code,external_account_key,status) VALUES($1,$2,'SYNTH_PROVIDER_A','synthetic-read-account','ACTIVE')",[secondAccount,tenantId]);
              await owner.query(`INSERT INTO nukhabapay.provider_snapshots(id,tenant_id,provider_account_id,snapshot_key,source_version,observed_at,status,row_count,completed_at) VALUES($1,$2,$3,'read-api-snapshot','synthetic-v2','2026-11-09T09:00:00Z','COMPLETE',1,'2026-11-09T09:05:00Z')`,[secondSnapshot,tenantId,secondAccount]);
              await owner.query(`INSERT INTO nukhabapay.product_mappings(id,tenant_id,provider_account_id,provider_sku,product_id,mapping_version,status,provenance_kind,provenance,source_snapshot_id) VALUES($1,$2,$3,'SYNTH-SECOND',$4,1,'APPROVED','IMPORT','{"source":"synthetic"}'::jsonb,$5)`,[secondMapping,tenantId,secondAccount,secondProductId,secondSnapshot]);
              await owner.query(`INSERT INTO nukhabapay.provider_offers(id,tenant_id,provider_account_id,provider_snapshot_id,product_mapping_id,product_mapping_version,product_id,face_value_minor,provider_offer_key,provider_debit_minor,additional_provider_fee_minor,upfront_discount_minor,available,observed_at,valid_until) VALUES($1,$2,$3,$4,$5,1,$6,10000,'second-offer',9600,50,400,true,'2026-11-09T09:00:00Z','2026-11-09T11:00:00Z')`,[secondOffer,tenantId,secondAccount,secondSnapshot,secondMapping,secondProductId]);
              const secondRequest:DraftPublicationRequest={...request,productId:secondProductId,product:secondProduct,idempotencyKey:randomUUID(),sourceSnapshots:[{...request.sourceSnapshots[0]!,snapshotId:secondSnapshot,providerAccountId:secondAccount,snapshotKey:"read-api-snapshot",sourceVersion:"synthetic-v2"}],offers:[{...request.offers[0]!,snapshotId:secondSnapshot,offerId:"second-offer",identity:secondProduct}]};
              const submitted=await prepareSyntheticPriceSubmission(deps,identity,secondRequest);await store!.submit(submitted);
              await run(reviewer,{...command("APPROVE",submitted.candidate.candidateId,1),productId:secondProductId});
              await exercisePublishedCatalogueHttp({reader,audit,tenantId,otherTenantId,productId,unpublishedId,secondProductId,oldVersion:restored.operationId,
                activateSecond:()=>run(publisher,{...command("ACTIVATE",submitted.candidate.candidateId,1),productId:secondProductId}),
                republish:()=>run(publisher,command("ACTIVATE",nextProof.candidate.candidateId,4,restored.operationId)),
                denyReader:async()=>{await owner.query(`REVOKE SELECT(product_id,name,publication_id,total_amount_minor,valid_until) ON nukhabapay.published_catalogue_public FROM ${identifier(readerRole)}`);},
                restoreReader:async()=>{await owner.query(`GRANT SELECT(product_id,name,publication_id,total_amount_minor,valid_until) ON nukhabapay.published_catalogue_public TO ${identifier(readerRole)}`);},
                denyAudit:async()=>{await owner.query(`CREATE TRIGGER reject_catalogue_read_audit BEFORE INSERT ON nukhabapay.published_catalogue_read_audit FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_publication_evidence_mutation()`);},
                restoreAudit:async()=>{await owner.query("DROP TRIGGER reject_catalogue_read_audit ON nukhabapay.published_catalogue_read_audit");}});
              assert.ok((await fixture.fixtureClient.query("SELECT count(*)::int AS n FROM nukhabapay.published_catalogue_read_audit")).rows[0].n>0);
              await assert.rejects(()=>fixture.fixtureClient.query("DELETE FROM nukhabapay.published_catalogue_read_audit"),{code:"42501"});
            }finally{await reader?.close();await audit?.close();for(const role of [readerRole,auditRole]){if((await fixture.fixtureClient.query("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) AS ok",[role])).rows[0].ok){await fixture.fixtureClient.query(`DROP OWNED BY ${identifier(role)}`);await fixture.fixtureClient.query(`DROP ROLE ${identifier(role)}`);}}}
          });
          for(const table of ["price_workflow_approvals","price_workflow_versions","price_workflow_operations","price_workflow_audit"]){
            await assert.rejects(()=>fixture.fixtureClient.query(`DELETE FROM nukhabapay.${table}`),{code:"42501"});
          }
          await writer!.query("BEGIN");try{await writer!.query("SELECT set_config('nukhabapay.publication_tenant_id',$1,true)",[otherTenantId]);assert.equal((await writer!.query("SELECT count(*)::int AS n FROM nukhabapay.price_workflow_versions")).rows[0].n,0);}finally{await writer!.query("ROLLBACK");}
        });
        await writer!.query("BEGIN");try{await writer!.query("SELECT set_config('nukhabapay.publication_tenant_id',$1,true)",[otherTenantId]);
          assert.equal((await writer!.query("SELECT count(*)::int AS n FROM nukhabapay.price_submission_evidence")).rows[0].n,0);
        }finally{await writer!.query("ROLLBACK");}
      });
      await t.test('USD commercial evidence, draft and audit commit atomically under tenant scope',
        { skip: 'Previous Layer 1 implementation disabled' }, async () => {
        const commercialSql = readFileSync(path.join(databaseRoot, 'pending-migrations/014_commercial_draft_evidence.sql'), 'utf8');
        await owner.query('BEGIN');
        try {
          await assert.rejects(() => owner.query(commercialSql), { code: '42501' });
        } finally { await owner.query('ROLLBACK'); }
        await owner.query('BEGIN');
        try {
          await owner.query("SELECT set_config('nukhbapay.commercial_draft_migration','DISPOSABLE_COMMERCIAL_DRAFT_V1',true), set_config('nukhabapay.publication_writer_role',$1,true)", [writerRole]);
          await owner.query(commercialSql);
          await owner.query('COMMIT');
        } catch (error) { await owner.query('ROLLBACK'); throw error; }

        const commercialAccount = randomUUID(), commercialSnapshot = randomUUID(), commercialMapping = randomUUID();
        const discoveryId = randomUUID(), now = new Date();
        const observedAt = new Date(now.getTime() - 120_000).toISOString();
        const completedAt = new Date(now.getTime() - 60_000).toISOString();
        const validUntil = new Date(now.getTime() + 300_000).toISOString();
        const scope = { tenantId: otherTenantId, providerAccountId: commercialAccount };
        const sourceProductId = 'FIXTURE-100';
        await owner.query("INSERT INTO nukhabapay.provider_accounts(id,tenant_id,provider_code,external_account_key,status) VALUES($1,$2,'SYNTH_PROVIDER_A','commercial-fixture','ACTIVE')", [commercialAccount, otherTenantId]);
        await owner.query(`INSERT INTO nukhabapay.provider_snapshots(id,tenant_id,provider_account_id,snapshot_key,source_version,
          observed_at,status,row_count,completed_at) VALUES($1,$2,$3,'commercial-snapshot','synthetic-v1',$4,'COMPLETE',1,$5)`,
          [commercialSnapshot, otherTenantId, commercialAccount, observedAt, completedAt]);
        await owner.query(`INSERT INTO nukhabapay.product_mappings(id,tenant_id,provider_account_id,provider_sku,product_id,
          mapping_version,status,provenance_kind,provenance,source_snapshot_id)
          VALUES($1,$2,$3,$4,$5,1,'APPROVED','IMPORT','{"source":"synthetic"}'::jsonb,$6)`,
          [commercialMapping, otherTenantId, commercialAccount, sourceProductId, productId, commercialSnapshot]);
        await owner.query(`INSERT INTO nukhabapay.provider_offers(id,tenant_id,provider_account_id,provider_snapshot_id,
          product_mapping_id,product_mapping_version,product_id,face_value_minor,provider_offer_key,provider_debit_minor,
          additional_provider_fee_minor,upfront_discount_minor,available,observed_at,valid_until)
          VALUES($1,$2,$3,$4,$5,1,$6,10000,'fixture-usd-offer',9600,50,400,true,$7,$8)`,
          [randomUUID(), otherTenantId, commercialAccount, commercialSnapshot, commercialMapping, productId, observedAt, validUntil]);
        const binding = { ...scope, sourceProductId, discoveryId, country: 'ARE', currency: 'AED', denominations: ['100'],
          scanCompletedAt: new Date(completedAt), productId, providerId: 'SYNTH_PROVIDER_A',
          offerId: 'fixture-usd-offer', snapshotId: commercialSnapshot };
        const requestWithCommercialSource = { ...request, tenantId: otherTenantId, evaluatedAt: now.toISOString(), idempotencyKey: randomUUID(),
          sourceSnapshots: [{ snapshotId: commercialSnapshot, providerAccountId: commercialAccount, snapshotKey: 'commercial-snapshot',
            sourceVersion: 'synthetic-v1', observedAt, completedAt, status: 'COMPLETE' as const }],
          offers: [{ ...request.offers[0]!, snapshotId: commercialSnapshot, offerId: binding.offerId, observedAt, validUntil }] };
        const quote = { version: 2, ...scope, sourceProductId, discoveryId, market: 'ARE', denomination: '100.00',
          settlementCurrency: 'USD', walletDebit: '25.00', additionalFee: '0.13', available: true,
          evidenceReference: 'fixture-quote', fxRateReference: 'fixture-fx', observedAt, validUntil };
        const fx = { expectedSource: 'fixture-source', evidence: { ...scope, commercialEvidenceReference: quote.evidenceReference,
          rateReference: quote.fxRateReference, source: 'fixture-source', baseCurrency: 'USD', quoteCurrency: 'AED',
          aedPerUsd: '3.84', observedAt, validUntil } };
        const review = prepareAedCommercialPriceDraft(quote, binding, requestWithCommercialSource, now, 3_600_000, fx);
        await assert.rejects(() => store!.saveCommercialReview({ ...review }), /Untrusted/);

        await owner.query(`CREATE FUNCTION nukhabapay.reject_test_commercial_evidence() RETURNS trigger
          LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $f$
          BEGIN RAISE EXCEPTION 'synthetic evidence failure' USING ERRCODE='40001'; END $f$`);
        await owner.query(`CREATE TRIGGER reject_test_commercial_evidence BEFORE INSERT ON nukhabapay.price_commercial_draft_evidence
          FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_test_commercial_evidence()`);
        try {
          await assert.rejects(() => store!.saveCommercialReview(review), { code: '40001' });
          const { rows: [record] } = await fixture.fixtureClient.query(`SELECT
            (SELECT count(*)::int FROM nukhabapay.catalogue_publication_candidates WHERE candidate_id=$1) AS drafts,
            (SELECT count(*)::int FROM nukhabapay.catalogue_publication_requests WHERE candidate_id=$1) AS requests,
            (SELECT count(*)::int FROM nukhabapay.catalogue_publication_events WHERE candidate_id=$1) AS events`, [review.draft.candidateId]);
          assert.deepEqual(record, { drafts: 0, requests: 0, events: 0 });
        } finally {
          await owner.query('DROP TRIGGER reject_test_commercial_evidence ON nukhabapay.price_commercial_draft_evidence');
          await owner.query('DROP FUNCTION nukhabapay.reject_test_commercial_evidence()');
        }

        const receipts = await Promise.all([store!.saveCommercialReview(review), store!.saveCommercialReview(review)]);
        assert.deepEqual(receipts.map(receipt => receipt.outcome).sort(), ['CREATED', 'REPLAYED']);
        assert.ok(receipts.every(receipt => receipt.reviewDigest === review.reviewDigest && receipt.execution === 'NOT_AUTHORIZED'));
        const changed = prepareAedCommercialPriceDraft({ ...quote, evidenceReference: 'other-quote' }, binding,
          requestWithCommercialSource, now, 3_600_000,
          { ...fx, evidence: { ...fx.evidence, commercialEvidenceReference: 'other-quote' } });
        await assert.rejects(() => store!.saveCommercialReview(changed), PublicationDraftConflictError);
        const { rows: [evidence] } = await fixture.fixtureClient.query(`SELECT e.review_digest, e.commercial_payload,
          EXISTS(SELECT FROM nukhabapay.price_submission_evidence s WHERE s.candidate_id=e.candidate_id) AS submitted,
          EXISTS(SELECT FROM nukhabapay.price_workflow_versions v WHERE v.candidate_id=e.candidate_id) AS published
          FROM nukhabapay.price_commercial_draft_evidence e WHERE e.candidate_id=$1`, [review.draft.candidateId]);
        assert.deepEqual(evidence, { review_digest: review.reviewDigest, commercial_payload: review.cost.canonicalPayload,
          submitted: false, published: false });
        await writer!.query('BEGIN');
        try {
          await writer!.query("SELECT set_config('nukhabapay.publication_tenant_id',$1,true)", [tenantId]);
          assert.equal((await writer!.query('SELECT 1 FROM nukhabapay.price_commercial_draft_evidence')).rowCount, 0);
        } finally { await writer!.query('ROLLBACK'); }
        await assert.rejects(() => fixture.fixtureClient.query('TRUNCATE nukhabapay.price_commercial_draft_evidence'), { code: '42501' });
      });
    } finally {
      await writer?.end().catch(()=>undefined);await store?.close().catch(()=>undefined);await owner.end().catch(()=>undefined);
      for(const role of [writerRole,hostileRole]){
        const exists=(await fixture.fixtureClient.query("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) AS yes",[role])).rows[0].yes;
        if(exists){await fixture.fixtureClient.query(`DROP OWNED BY ${identifier(role)}`);await fixture.fixtureClient.query(`DROP ROLE ${identifier(role)}`);}
      }
    }
  },"b3b3",0);
});
