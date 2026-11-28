ALTER TABLE nukhabapay.catalogue_discovery_scans
  ADD COLUMN source_group text, ADD COLUMN source_version text;
ALTER TABLE nukhabapay.catalogue_discovery_scans DROP CONSTRAINT admitted_discovery_coverage;
ALTER TABLE nukhabapay.catalogue_discovery_scans ADD CONSTRAINT admitted_discovery_coverage CHECK (
  coverage_scope IN ('ARE_GIFT_CARD','ALL_COUNTRIES','PARTIAL_ALL_COUNTRIES','IPAY_PRODUCT_FILE') AND coverage_scope IS NOT NULL
  AND product_count BETWEEN 1 AND 100000 AND product_count IS NOT NULL
  AND page_count IS NOT NULL AND (
    (coverage_scope='PARTIAL_ALL_COUNTRIES' AND page_count BETWEEN 1 AND 1000
      AND product_count BETWEEN page_count AND page_count*100)
    OR (coverage_scope='ALL_COUNTRIES' AND page_count BETWEEN 2 AND 1000
      AND product_count BETWEEN page_count-1 AND (page_count-1)*100)
    OR (coverage_scope='ARE_GIFT_CARD' AND page_count=(product_count+99)/100+1)
    OR (coverage_scope='IPAY_PRODUCT_FILE' AND page_count=1))
  AND CASE WHEN coverage_scope='IPAY_PRODUCT_FILE' THEN
    source_group IS NOT NULL AND source_group ~ '^[0-9]{1,19}$'
    AND source_version IS NOT NULL AND source_version ~ '^[0-9]{2,20}$'
    AND left(source_version,length(source_group))=source_group AND length(source_version)>length(source_group)
  ELSE source_group IS NULL AND source_version IS NULL END
  AND source_observed_at IS NOT NULL AND isfinite(source_observed_at) AND source_observed_at<=completed_at
  AND scan_digest IS NOT NULL AND scan_digest ~ '^[a-f0-9]{64}$') NOT VALID;

GRANT INSERT (source_group,source_version) ON nukhabapay.catalogue_discovery_scans TO nukhbapay_catalogue_runtime;
CREATE UNIQUE INDEX ipay_product_file_version
  ON nukhabapay.catalogue_discovery_scans (tenant_id,provider_account_id,source_group,source_version)
  WHERE coverage_scope='IPAY_PRODUCT_FILE';

CREATE OR REPLACE FUNCTION nukhabapay.check_local_discovery_coverage() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $body$
BEGIN
  IF NOT EXISTS (SELECT FROM nukhabapay.provider_accounts a
    WHERE (a.tenant_id,a.id)=(NEW.tenant_id,NEW.provider_account_id)
    AND CASE WHEN NEW.coverage_scope='IPAY_PRODUCT_FILE' THEN a.provider_code='IPAY' AND a.status='DISABLED'
      ELSE a.provider_code='FINXPLOR' END)
  OR NOT EXISTS (
    SELECT 1 FROM nukhabapay.catalogue_discovery_scan_items i JOIN nukhabapay.catalogue_discoveries d
      ON (d.tenant_id,d.provider_account_id,d.id)=(i.tenant_id,i.provider_account_id,i.discovery_id)
    WHERE (i.tenant_id,i.provider_account_id,i.scan_id)=(NEW.tenant_id,NEW.provider_account_id,NEW.id)
    HAVING count(*)=NEW.product_count AND count(DISTINCT d.source_id)=NEW.product_count
      AND bool_and((NEW.coverage_scope IN ('ALL_COUNTRIES','PARTIAL_ALL_COUNTRIES','IPAY_PRODUCT_FILE')
        OR (d.source_country='ARE' AND d.category='Gift Card' AND d.source_country_label IN ('AE','ARE')
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
    AND s.coverage_scope IN ('ARE_GIFT_CARD','ALL_COUNTRIES','PARTIAL_ALL_COUNTRIES','IPAY_PRODUCT_FILE')
    AND catalogue_discovery_confirmations.observed_at>=s.source_observed_at));
