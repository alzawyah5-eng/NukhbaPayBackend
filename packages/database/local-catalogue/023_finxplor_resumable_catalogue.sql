ALTER TABLE nukhabapay.catalogue_discovery_scans DROP CONSTRAINT admitted_discovery_coverage;
ALTER TABLE nukhabapay.catalogue_discovery_scans ADD CONSTRAINT admitted_discovery_coverage CHECK (
 coverage_scope IN ('ARE_GIFT_CARD','ALL_COUNTRIES','PARTIAL_ALL_COUNTRIES') AND coverage_scope IS NOT NULL
 AND product_count BETWEEN 1 AND 100000 AND product_count IS NOT NULL
 AND page_count IS NOT NULL AND (
   (coverage_scope='PARTIAL_ALL_COUNTRIES' AND page_count BETWEEN 1 AND 1000
    AND product_count BETWEEN page_count AND page_count*100)
   OR (coverage_scope<>'PARTIAL_ALL_COUNTRIES' AND page_count=(product_count+99)/100+1))
 AND source_observed_at IS NOT NULL AND isfinite(source_observed_at) AND source_observed_at<=completed_at
 AND scan_digest IS NOT NULL AND scan_digest ~ '^[a-f0-9]{64}$') NOT VALID;
CREATE OR REPLACE FUNCTION nukhabapay.check_local_discovery_coverage() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $body$
BEGIN
  IF NOT EXISTS (SELECT FROM nukhabapay.provider_accounts a
    WHERE (a.tenant_id,a.id)=(NEW.tenant_id,NEW.provider_account_id) AND a.provider_code='FINXPLOR')
  OR NOT EXISTS (
    SELECT 1 FROM nukhabapay.catalogue_discovery_scan_items i JOIN nukhabapay.catalogue_discoveries d
      ON (d.tenant_id,d.provider_account_id,d.id)=(i.tenant_id,i.provider_account_id,i.discovery_id)
    WHERE (i.tenant_id,i.provider_account_id,i.scan_id)=(NEW.tenant_id,NEW.provider_account_id,NEW.id)
    HAVING count(*)=NEW.product_count AND count(DISTINCT d.source_id)=NEW.product_count
      AND bool_and((NEW.coverage_scope IN ('ALL_COUNTRIES','PARTIAL_ALL_COUNTRIES') OR (d.source_country='ARE' AND d.category='Gift Card' AND d.source_country_label IN ('AE','ARE')
        AND d.source_category_label='Gift Card')) IS TRUE)
      AND NEW.scan_digest=encode(sha256(convert_to(NEW.coverage_scope || E'\n' ||
        string_agg(d.source_id || ':' || d.source_digest, E'\n' ORDER BY d.source_id COLLATE "C"),'UTF8')),'hex')
  ) THEN
    RAISE EXCEPTION 'Incomplete scoped discovery scan' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $body$;

ALTER POLICY confirmation_scope ON nukhabapay.catalogue_discovery_confirmations WITH CHECK (
 tenant_id::text=current_setting('nukhabapay.tenant_id',true) AND EXISTS (
 SELECT FROM nukhabapay.catalogue_discovery_scans s
 WHERE (s.tenant_id,s.provider_account_id,s.id)=(catalogue_discovery_confirmations.tenant_id,
 catalogue_discovery_confirmations.provider_account_id,catalogue_discovery_confirmations.scan_id)
 AND s.coverage_scope IN ('ARE_GIFT_CARD','ALL_COUNTRIES','PARTIAL_ALL_COUNTRIES')
 AND catalogue_discovery_confirmations.observed_at>=s.source_observed_at));
CREATE OR REPLACE VIEW nukhabapay.current_catalogue_discoveries WITH (security_invoker=true) AS
WITH all_scans AS (
  SELECT DISTINCT ON (tenant_id,provider_account_id,coverage_scope) *
  FROM nukhabapay.catalogue_discovery_scans
  ORDER BY tenant_id,provider_account_id,coverage_scope,completed_at DESC,id DESC
), latest_scans AS (
 SELECT s.* FROM all_scans s WHERE s.coverage_scope='ALL_COUNTRIES' OR (
   s.coverage_scope IS DISTINCT FROM 'PARTIAL_ALL_COUNTRIES' AND NOT EXISTS (
     SELECT FROM all_scans g WHERE (g.tenant_id,g.provider_account_id)=(s.tenant_id,s.provider_account_id)
       AND g.coverage_scope='ALL_COUNTRIES'))
 UNION ALL
 SELECT s.* FROM nukhabapay.catalogue_discovery_scans s WHERE s.coverage_scope='PARTIAL_ALL_COUNTRIES' AND NOT EXISTS (
   SELECT FROM all_scans g WHERE (g.tenant_id,g.provider_account_id)=(s.tenant_id,s.provider_account_id)
     AND g.coverage_scope='ALL_COUNTRIES' AND g.completed_at>=s.completed_at)
), current_items AS (
  SELECT d.id,d.tenant_id,d.provider_account_id,s.completed_at AS observed_at,s.coverage_scope
  FROM latest_scans s JOIN nukhabapay.catalogue_discovery_scan_items i
    ON (i.tenant_id,i.provider_account_id,i.scan_id)=(s.tenant_id,s.provider_account_id,s.id)
  JOIN nukhabapay.catalogue_discoveries d
    ON (d.tenant_id,d.provider_account_id,d.id)=(i.tenant_id,i.provider_account_id,i.discovery_id)
  WHERE s.coverage_scope IS NOT NULL OR NOT (
    d.source_country='ARE' AND lower(d.category) IN ('gift card','gift cards') AND EXISTS (
      SELECT FROM latest_scans v WHERE (v.tenant_id,v.provider_account_id)=(s.tenant_id,s.provider_account_id)
        AND v.coverage_scope='ARE_GIFT_CARD'
    ))
  UNION ALL
  SELECT * FROM (
    SELECT DISTINCT ON (d.tenant_id,d.provider_account_id,d.source_id)
      d.id,d.tenant_id,d.provider_account_id,d.observed_at,NULL::text AS coverage_scope
    FROM nukhabapay.catalogue_discoveries d
    WHERE NOT EXISTS (SELECT FROM latest_scans s WHERE (s.tenant_id,s.provider_account_id)=(d.tenant_id,d.provider_account_id)
      AND (s.coverage_scope IS NULL OR s.coverage_scope='ALL_COUNTRIES' OR (s.coverage_scope='ARE_GIFT_CARD' AND d.source_country='ARE'
        AND lower(d.category) IN ('gift card','gift cards'))))
      AND NOT EXISTS (SELECT FROM nukhabapay.catalogue_discovery_scan_items old_item
        JOIN nukhabapay.catalogue_discovery_scans old_scan
          ON (old_scan.tenant_id,old_scan.provider_account_id,old_scan.id)=(old_item.tenant_id,old_item.provider_account_id,old_item.scan_id)
        WHERE (old_item.tenant_id,old_item.provider_account_id,old_item.discovery_id)=(d.tenant_id,d.provider_account_id,d.id)
          AND old_scan.coverage_scope='PARTIAL_ALL_COUNTRIES')
    ORDER BY d.tenant_id,d.provider_account_id,d.source_id,d.observed_at DESC,d.id DESC
  ) legacy
)
SELECT DISTINCT ON (d.tenant_id,d.provider_account_id,d.source_id)
  d.id,d.tenant_id,d.provider_account_id,d.source_id,d.product_name,d.brand,d.source_country,d.currency,d.category,
  d.delivery,d.denominations,d.min_amount,d.max_amount,d.review_reason,d.source_country_label,d.source_category_label,
  c.observed_at,c.coverage_scope
FROM current_items c JOIN nukhabapay.catalogue_discoveries d
  ON (d.tenant_id,d.provider_account_id,d.id)=(c.tenant_id,c.provider_account_id,c.id)
ORDER BY d.tenant_id,d.provider_account_id,d.source_id,(c.coverage_scope IS NOT NULL) DESC,c.observed_at DESC,d.id DESC;
