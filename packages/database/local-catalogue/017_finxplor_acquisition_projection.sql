-- Restricted summary only. Existing staff catalogue readers cannot read the underlying Layer 1 tables.
CREATE OR REPLACE VIEW nukhabapay.layer1_active_accounts WITH (security_barrier=true) AS
SELECT a.tenant_id,a.id AS provider_account_id,a.provider_code
FROM nukhabapay.provider_accounts a
JOIN nukhabapay.layer1_account_grants g ON (g.tenant_id,g.provider_account_id)=(a.tenant_id,a.id)
WHERE a.status='ACTIVE' AND g.login_role=session_user
  AND a.tenant_id::text=current_setting('nukhabapay.tenant_id',true)
  AND a.id::text=current_setting('nukhabapay.layer1_account_id',true);

DO $policies$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['layer1_cost_snapshots','layer1_policies','layer1_fx_snapshots','layer1_results'] LOOP
    EXECUTE format($policy$CREATE POLICY layer1_staff_summary ON nukhabapay.%I FOR SELECT
      TO nukhbapay_catalogue_migrator USING (
        session_user='nukhbapay_catalogue_reader'
        AND tenant_id::text=current_setting('nukhabapay.tenant_id',true)
      )$policy$,relation);
  END LOOP;
END
$policies$;

CREATE FUNCTION nukhabapay.staff_finxplor_acquisition_summary(p_tenant uuid, p_discoveries uuid[])
RETURNS TABLE (discovery_id uuid, state text, aed_amount text, face_amount text, face_currency text, valid_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $summary$
  SELECT d.id,
    CASE WHEN current_cost.aed_amount IS NULL THEN 'QUOTE_REQUIRED'
      WHEN current_cost.valid_until<=statement_timestamp() THEN 'EXPIRED'
      ELSE 'NORMALIZED' END,
    CASE WHEN current_cost.valid_until>statement_timestamp() THEN current_cost.aed_amount::text END,
    CASE WHEN current_cost.valid_until>statement_timestamp() THEN current_cost.face_amount::text END,
    CASE WHEN current_cost.valid_until>statement_timestamp() THEN current_cost.face_currency END,
    CASE WHEN current_cost.valid_until>statement_timestamp() THEN current_cost.valid_until END
  FROM nukhabapay.observed_catalogue_discoveries d
  JOIN nukhabapay.provider_accounts a ON (a.tenant_id,a.id)=(d.tenant_id,d.provider_account_id)
  LEFT JOIN LATERAL (
    SELECT m.id,m.mapping_version,m.status
    FROM nukhabapay.product_mappings m
    WHERE (m.tenant_id,m.provider_account_id,m.provider_sku)=(d.tenant_id,d.provider_account_id,d.source_id)
    ORDER BY m.mapping_version DESC LIMIT 1
  ) mapping ON true
  LEFT JOIN LATERAL (
    SELECT result.aed_amount,cost.face_amount,cost.evidence->'faceValue'->>'currency' AS face_currency,result.valid_until
    FROM (
      SELECT DISTINCT ON (o.provider_offer_key) o.id,o.available,o.valid_until,o.product_mapping_id,o.product_mapping_version
      FROM nukhabapay.provider_offers o
      WHERE (o.tenant_id,o.provider_account_id)=(d.tenant_id,d.provider_account_id)
        AND o.provider_offer_key IN (
          SELECT original.provider_offer_key FROM nukhabapay.provider_offers original
          WHERE (original.tenant_id,original.provider_account_id,original.product_mapping_id,original.product_mapping_version)
              =(d.tenant_id,d.provider_account_id,mapping.id,mapping.mapping_version)
        )
      ORDER BY o.provider_offer_key,o.observed_at DESC,o.id DESC
    ) offer
    JOIN LATERAL (
      SELECT r.id,r.cost_snapshot_id,r.aed_amount,r.valid_until
      FROM nukhabapay.layer1_results r
      JOIN nukhabapay.layer1_cost_snapshots c
        ON (c.tenant_id,c.provider_account_id,c.id)=(r.tenant_id,r.provider_account_id,r.cost_snapshot_id)
      JOIN nukhabapay.layer1_policies p
        ON (p.tenant_id,p.provider_account_id,p.version)=(r.tenant_id,r.provider_account_id,r.policy_version)
      JOIN nukhabapay.layer1_fx_snapshots f
        ON (f.tenant_id,f.provider_account_id,f.id,f.policy_version)=(r.tenant_id,r.provider_account_id,r.fx_snapshot_id,r.policy_version)
      WHERE (r.tenant_id,r.provider_account_id,c.offer_version_id)=(d.tenant_id,d.provider_account_id,offer.id)
        AND p.policy->>'provenance'='LIVE'
      ORDER BY c.observed_at DESC,c.retrieved_at DESC,c.id DESC,p.revision DESC,
        f.effective_at DESC,f.retrieved_at DESC,f.id DESC,r.calculator_version DESC,r.id DESC
      LIMIT 1
    ) result ON true
    JOIN nukhabapay.layer1_cost_snapshots cost
      ON (cost.tenant_id,cost.provider_account_id,cost.id)=(d.tenant_id,d.provider_account_id,result.cost_snapshot_id)
    JOIN nukhabapay.layer1_results saved
      ON (saved.tenant_id,saved.provider_account_id,saved.id)=(d.tenant_id,d.provider_account_id,result.id)
    JOIN nukhabapay.layer1_policies policy
      ON (policy.tenant_id,policy.provider_account_id,policy.version)=(saved.tenant_id,saved.provider_account_id,saved.policy_version)
    WHERE a.status='ACTIVE' AND mapping.status='APPROVED' AND offer.available
      AND (offer.product_mapping_id,offer.product_mapping_version)=(mapping.id,mapping.mapping_version)
      AND offer.valid_until>statement_timestamp()
      AND policy.policy->'permittedUses' ? 'INTERNAL_REVIEW'
    ORDER BY cost.face_amount,cost.evidence->'faceValue'->>'currency',result.id
    LIMIT 25
  ) current_cost ON true
  WHERE session_user='nukhbapay_catalogue_reader' AND d.tenant_id=p_tenant
    AND p_tenant::text=current_setting('nukhabapay.tenant_id',true)
    AND cardinality(p_discoveries) BETWEEN 1 AND 50 AND d.id=ANY(p_discoveries)
    AND a.provider_code='FINXPLOR'
$summary$;
REVOKE ALL ON FUNCTION nukhabapay.staff_finxplor_acquisition_summary(uuid,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nukhabapay.staff_finxplor_acquisition_summary(uuid,uuid[]) TO nukhbapay_catalogue_reader;
