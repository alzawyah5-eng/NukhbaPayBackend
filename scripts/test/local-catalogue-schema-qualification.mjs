import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

// This runs only inside the migration rehearsal transaction. The installer
// rolls back the test records and all staged schema changes afterwards.
export async function rehearseLocalCatalogueSchema(client) {
  const tenant = randomUUID();
  const otherTenant = randomUUID();
  const account = randomUUID();
  const product = randomUUID();
  const snapshot = randomUUID();
  const actor = randomUUID();
  const reviewer = randomUUID();
  const executor = randomUUID();
  const operation = randomUUID();
  const published = randomUUID();
  const payload = `rolled-back catalogue qualification ${randomUUID()}`;
  const candidate = createHash('sha256').update(payload).digest('hex');
  const draftOperation = createHash('sha256').update(randomUUID()).digest('hex');
  const stamp = new Date();
  const started = new Date(stamp.getTime() - 60_000);
  const expiry = new Date(stamp.getTime() + 180_000);
  const scope = id => client.query(`SELECT set_config('nukhabapay.tenant_id',$1,true),
    set_config('nukhabapay.publication_tenant_id',$1,true),set_config('nukhabapay.refresh_tenant_id',$1,true)`, [id]);
  const expectDenied = async (code, step) => {
    await client.query('SAVEPOINT expected_failure');
    try { await assert.rejects(step, { code }); }
    finally { await client.query('ROLLBACK TO SAVEPOINT expected_failure'); await client.query('RELEASE SAVEPOINT expected_failure'); }
  };

  const { rows: [grants] } = await client.query(`SELECT
    has_column_privilege('nukhbapay_catalogue_reader','nukhabapay.catalogue_publication_candidates','total_amount_minor','SELECT') AS pricing_read,
    NOT has_column_privilege('nukhbapay_catalogue_reader','nukhabapay.price_submission_evidence','canonical_payload','SELECT') AS evidence_private,
    NOT has_table_privilege('nukhbapay_catalogue_runtime','nukhabapay.price_workflow_versions','INSERT') AS mutation_closed,
    NOT has_table_privilege('nukhbapay_catalogue_runtime','nukhabapay.catalogue_refresh_jobs','INSERT') AS refresh_closed,
    NOT has_table_privilege('nukhbapay_catalogue_runtime','nukhabapay.publication_delivery_state','UPDATE') AS delivery_closed,
    (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
      WHERE oid='nukhabapay.price_commercial_draft_evidence'::regclass) AS commercial_rls_forced,
    NOT has_table_privilege('nukhbapay_catalogue_reader','nukhabapay.price_commercial_draft_evidence','SELECT') AS commercial_reader_closed,
    NOT has_table_privilege('nukhbapay_catalogue_runtime','nukhabapay.price_commercial_draft_evidence',
      'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS commercial_runtime_closed,
    NOT has_table_privilege('nukhbapay_catalogue_runtime','nukhabapay.catalogue_pricing_proposals','INSERT,UPDATE') AS pricing_policy_closed,
    NOT has_table_privilege('nukhbapay_catalogue_reader','nukhabapay.catalogue_pricing_decisions','SELECT') AS pricing_decisions_private,
    has_table_privilege('nukhbapay_catalogue_reader','nukhabapay.staff_discovery_mapping_status','SELECT')
      AND NOT has_column_privilege('nukhbapay_catalogue_reader','nukhabapay.product_mappings','provider_sku','SELECT')
      AND NOT has_column_privilege('nukhbapay_catalogue_reader','nukhabapay.product_mappings','mapping_version','SELECT')
      AND NOT has_column_privilege('nukhbapay_catalogue_reader','nukhabapay.product_mappings','provenance','SELECT') AS discovery_mapping_status_only`);
  assert.ok(Object.values(grants).every(value => value === true));

  for (const id of [tenant, otherTenant]) {
    await scope(id);
    await client.query('INSERT INTO nukhabapay.tenants(id,tenant_key) VALUES($1,$2)', [id, `qualification-${id}`]);
  }
  await scope(tenant);
  await client.query(`INSERT INTO nukhabapay.products(id,canonical_product_key,brand,redemption_country,currency,
    face_value_minor,fulfillment_method,terms_version) VALUES($1,$2,'Qualification','AE','AED',100,'DIGITAL_PIN','test')`, [product, product]);
  await client.query(`INSERT INTO nukhabapay.provider_accounts(id,tenant_id,provider_code,external_account_key,status)
    VALUES($1,$2,'FINXPLOR',$3,'ACTIVE')`, [account, tenant, account]);
  const scan = randomUUID(), discovery = randomUUID();
  await client.query(`INSERT INTO nukhabapay.catalogue_discoveries(id,tenant_id,provider_account_id,source_id,source_digest,
    product_name,brand,source_country,currency,category,delivery,denominations,min_amount,max_amount,source_country_label,source_category_label)
    VALUES($1,$2,$3,'qualification','${'a'.repeat(64)}','Qualification','Qualification','ARE','AED','Gift Card','email','["1.00"]','1.00','1.00','ARE','Gift Card')`,
  [discovery, tenant, account]);
  const scanDigest = createHash('sha256').update('ARE_GIFT_CARD\nqualification:' + 'a'.repeat(64)).digest('hex');
  await client.query(`INSERT INTO nukhabapay.catalogue_discovery_scans
    (id,tenant_id,provider_account_id,coverage_scope,page_count,product_count,source_observed_at,scan_digest)
    VALUES($1,$2,$3,'ARE_GIFT_CARD',2,1,$4,$5)`, [scan, tenant, account, stamp, scanDigest]);
  await expectDenied('23514', () => client.query('SET CONSTRAINTS nukhabapay.local_discovery_coverage_at_commit IMMEDIATE'));
  const includeDiscovery = id => client.query(`INSERT INTO nukhabapay.catalogue_discovery_scan_items
    (tenant_id,provider_account_id,scan_id,discovery_id) VALUES($1,$2,$3,$4)`, [tenant, account, scan, id]);
  await expectDenied('23503', () => includeDiscovery(randomUUID()));
  await includeDiscovery(discovery);
  await client.query('SET CONSTRAINTS nukhabapay.local_discovery_coverage_at_commit IMMEDIATE');
  assert.equal((await client.query('SELECT 1 FROM nukhabapay.current_catalogue_discoveries WHERE id=$1 AND coverage_scope=$2',
    [discovery, 'ARE_GIFT_CARD'])).rowCount, 1);
  await client.query(`INSERT INTO nukhabapay.catalogue_discovery_confirmations(tenant_id,provider_account_id,scan_id,run_id,observed_at)
    VALUES($1,$2,$3,$4,$5)`,[tenant,account,scan,randomUUID(),stamp]);
  await expectDenied('42501', () => client.query('DELETE FROM nukhabapay.catalogue_discovery_confirmations'));
  assert.equal((await client.query('SELECT 1 FROM nukhabapay.observed_catalogue_discoveries WHERE id=$1 AND last_verified_at>=observed_at',
    [discovery])).rowCount, 1);
  await scope(otherTenant);
  assert.equal((await client.query('SELECT 1 FROM nukhabapay.catalogue_discovery_scan_items WHERE scan_id=$1', [scan])).rowCount, 0);
  assert.equal((await client.query('SELECT 1 FROM nukhabapay.current_catalogue_discoveries WHERE id=$1', [discovery])).rowCount, 0);
  await scope(tenant);
  await client.query(`INSERT INTO nukhabapay.provider_snapshots(id,tenant_id,provider_account_id,snapshot_key,source_version,
    observed_at,status,row_count,completed_at) VALUES($1,$2,$3,'qualification','v1',$4,'COMPLETE',0,$5)`, [snapshot, tenant, account, started, stamp]);
  await client.query(`INSERT INTO nukhabapay.catalogue_publication_candidates(candidate_id,candidate_digest,tenant_id,product_id,canonical_product_key,
    price_version,expected_previous_version,currency,base_amount_minor,service_fee_minor,tax_amount_minor,total_amount_minor,
    provider_cost_minor,payment_fee_minor,agent_commission_minor,expected_contribution_minor,pricing_policy_version,rounding_policy,
    selected_provider_id,selected_offer_id,selected_snapshot_id,source_count,evaluated_at,valid_until)
    VALUES($1,$1,$2,$3,$4,1,0,'AED',100,5,0,105,90,3,2,10,'v1','AED_MINOR_UNIT_HALF_UP_NONNEGATIVE',
      'LOCAL_QUALIFICATION','qualification-offer',$5,1,$6,$7)`, [candidate, tenant, product, product, snapshot, stamp, expiry]);
  await client.query(`INSERT INTO nukhabapay.catalogue_publication_sources(candidate_id,tenant_id,product_id,snapshot_id,provider_account_id,
    snapshot_key,source_version,observed_at,completed_at,source_status) VALUES($1,$2,$3,$4,$5,'qualification','v1',$6,$7,'COMPLETE')`,
    [candidate, tenant, product, snapshot, account, started, stamp]);
  await client.query(`INSERT INTO nukhabapay.catalogue_publication_requests(operation_id,tenant_id,product_id,idempotency_key,candidate_id,
    candidate_digest,outcome) VALUES($1,$2,$3,$4,$5,$5,'DRAFT_CREATED')`, [draftOperation, tenant, product, randomUUID(), candidate]);

  const commercialPayload = JSON.stringify(['AED_COMMERCIAL_PRICE_OBSERVATION_V1', tenant, account,
    'qualification', discovery, 'AE', '1.00', 'AED', '0.85', '0.05', true,
    'local-qualification', stamp.getTime(), expiry.getTime()]);
  const commercialDigest = createHash('sha256').update(commercialPayload).digest('hex');
  const reviewDigest = (deadline, op = draftOperation) => createHash('sha256')
    .update(JSON.stringify(['AED_COMMERCIAL_PRICE_DRAFT_REVIEW_V2', commercialDigest, op, candidate, deadline.toISOString()]))
    .digest('hex');
  const saveCommercialEvidence = ({ deadline = expiry, op = draftOperation,
    evidence = commercialPayload, review = reviewDigest(deadline, op) } = {}) => client.query(`
    INSERT INTO nukhabapay.price_commercial_draft_evidence
      (candidate_id,tenant_id,product_id,operation_id,commercial_digest,commercial_payload,review_digest,validity_deadline)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [candidate, tenant, product, op, commercialDigest, evidence, review, deadline]);
  const checkCommercialEvidence = () => client.query('SET CONSTRAINTS nukhabapay.local_commercial_draft_fresh_at_commit IMMEDIATE');
  await expectDenied('23503', () => saveCommercialEvidence());
  await client.query(`INSERT INTO nukhabapay.catalogue_publication_events(event_id,operation_id,candidate_id,tenant_id,product_id,
    price_version,candidate_digest,event_name,occurred_at) VALUES($1,$2,$3,$4,$5,1,$3,'CATALOGUE_PUBLICATION_CANDIDATE_CREATED',$6)`,
    [randomUUID(), draftOperation, candidate, tenant, product, stamp]);
  await expectDenied('23514', () => saveCommercialEvidence({ evidence: commercialPayload + ' ' }));
  await expectDenied('23514', () => saveCommercialEvidence({ review: '0'.repeat(64) }));
  for (const deadline of [started, new Date(expiry.getTime() + 1)]) {
    await expectDenied('23514', async () => {
      await saveCommercialEvidence({ deadline });
      await checkCommercialEvidence();
    });
  }
  await expectDenied('23514', async () => {
    const op = createHash('sha256').update(randomUUID()).digest('hex');
    await client.query(`INSERT INTO nukhabapay.catalogue_publication_requests(operation_id,tenant_id,product_id,idempotency_key,
      candidate_id,candidate_digest,outcome) VALUES($1,$2,$3,$4,$5,$5,'DRAFT_REPLAYED')`, [op, tenant, product, randomUUID(), candidate]);
    await saveCommercialEvidence({ op });
    await checkCommercialEvidence();
  });
  await saveCommercialEvidence();
  await checkCommercialEvidence();
  const loadCommercialEvidence = () => client.query(`SELECT commercial_payload,review_digest
    FROM nukhabapay.price_commercial_draft_evidence WHERE candidate_id=$1`, [candidate]);
  assert.deepEqual((await loadCommercialEvidence()).rows, [{ commercial_payload: commercialPayload, review_digest: reviewDigest(expiry) }]);
  await expectDenied('23505', () => saveCommercialEvidence());
  await expectDenied('42501', () => client.query('UPDATE nukhabapay.price_commercial_draft_evidence SET validity_deadline=clock_timestamp()'));
  await expectDenied('42501', () => client.query('DELETE FROM nukhabapay.price_commercial_draft_evidence'));
  await expectDenied('42501', () => client.query('TRUNCATE nukhabapay.price_commercial_draft_evidence'));
  await client.query("SELECT set_config('nukhabapay.publication_tenant_id',$1,true)", [otherTenant]);
  assert.equal((await loadCommercialEvidence()).rowCount, 0);
  await scope(otherTenant);
  assert.equal((await loadCommercialEvidence()).rowCount, 0);
  await expectDenied('42501', () => saveCommercialEvidence());
  await scope(tenant);

  await client.query(`INSERT INTO nukhabapay.price_submission_evidence(candidate_id,tenant_id,product_id,canonical_payload,creator_staff_id,
    authority_receipt_digest,submitted_at) VALUES($1,$2,$3,$4,$5,$6,$7)`, [candidate, tenant, product, payload, actor, '1'.repeat(64), stamp]);
  await expectDenied('23514', () => client.query('SET CONSTRAINTS nukhabapay.local_submission_evidence IMMEDIATE'));
  await client.query(`INSERT INTO nukhabapay.price_submission_events(candidate_id,tenant_id,product_id,creator_staff_id,occurred_at)
    VALUES($1,$2,$3,$4,$5)`, [candidate, tenant, product, actor, stamp]);

  const beginOperation = (id, staff, action, authority) => client.query(`INSERT INTO nukhabapay.price_workflow_operations(
    operation_id,tenant_id,product_id,candidate_id,idempotency_key,actor_staff_id,action,command_digest,authority_receipt_digest,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, tenant, product, candidate, randomUUID(), staff, action, candidate, authority, stamp]);
  const recordAudit = (id, staff, action) => client.query(`INSERT INTO nukhabapay.price_workflow_audit
    (operation_id,tenant_id,product_id,candidate_id,actor_staff_id,action,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [id, tenant, product, candidate, staff, action, stamp]);
  await beginOperation(operation, reviewer, 'APPROVE', '2'.repeat(64));
  const approval = (id, staff) => client.query(`INSERT INTO nukhabapay.price_workflow_approvals
    (operation_id,tenant_id,product_id,candidate_id,actor_staff_id) VALUES($1,$2,$3,$4,$5)`, [id, tenant, product, candidate, staff]);
  await expectDenied('42501', () => approval(operation, actor));
  await approval(operation, reviewer);
  await recordAudit(operation, reviewer, 'APPROVE');
  await beginOperation(published, executor, 'ACTIVATE', '3'.repeat(64));
  await client.query(`INSERT INTO nukhabapay.price_workflow_versions(operation_id,tenant_id,product_id,candidate_id,actor_staff_id,revision,kind)
    VALUES($1,$2,$3,$4,$5,1,'ACTIVATE')`, [published, tenant, product, candidate, executor]);
  await recordAudit(published, executor, 'ACTIVATE');
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');

  const { rows } = await client.query(`SELECT o.revision::text,s.status FROM nukhabapay.publication_delivery_outbox o
    JOIN nukhabapay.publication_delivery_state s USING(tenant_id,event_id) WHERE o.event_id=$1`, [published]);
  assert.deepEqual(rows, [{ revision: '1', status: 'PENDING' }]);
  await client.query("SELECT set_config('nukhabapay.catalogue_read_at',$1,true)", [stamp.toISOString()]);
  const { rows: projection } = await client.query(`SELECT publication_id,total_amount_minor::text AS amount FROM nukhabapay.published_catalogue_public
    WHERE publication_id=$1`, [published]);
  assert.deepEqual(projection, [{ publication_id: published, amount: '105' }]);
  await expectDenied('42501', () => client.query('UPDATE nukhabapay.price_workflow_versions SET revision=2 WHERE operation_id=$1', [published]));
  await expectDenied('23514', () => beginOperation(randomUUID(), actor, 'ROLLBACK', '4'.repeat(64)));
  await scope(otherTenant);
  assert.equal((await client.query('SELECT 1 FROM nukhabapay.published_catalogue_public WHERE publication_id=$1', [published])).rowCount, 0);
  assert.equal((await client.query('SELECT 1 FROM nukhabapay.publication_delivery_outbox WHERE event_id=$1', [published])).rowCount, 0);
}
