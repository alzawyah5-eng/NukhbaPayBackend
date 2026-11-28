ALTER TABLE nukhabapay.catalogue_discoveries
  ADD COLUMN source_country_label varchar(3) CHECK (source_country_label ~ '^[A-Z]{2,3}$'),
  ADD COLUMN source_category_label varchar(80);
GRANT INSERT (source_country_label,source_category_label) ON nukhabapay.catalogue_discoveries
  TO nukhbapay_catalogue_runtime;

ALTER TABLE nukhabapay.catalogue_discovery_scans
  ADD COLUMN coverage_scope text,
  ADD COLUMN page_count integer,
  ADD COLUMN product_count integer,
  ADD COLUMN source_observed_at timestamptz,
  ADD COLUMN scan_digest text,
  ADD CONSTRAINT admitted_discovery_coverage CHECK (
    coverage_scope IS NOT NULL AND coverage_scope='ARE_GIFT_CARD' AND product_count IS NOT NULL
    AND product_count BETWEEN 1 AND 3900 AND page_count IS NOT NULL AND page_count=(product_count+99)/100+1
    AND source_observed_at IS NOT NULL AND isfinite(source_observed_at) AND source_observed_at<=completed_at
    AND scan_digest IS NOT NULL AND scan_digest ~ '^[a-f0-9]{64}$'
  ) NOT VALID;

GRANT INSERT (coverage_scope,page_count,product_count,source_observed_at,scan_digest)
  ON nukhabapay.catalogue_discovery_scans TO nukhbapay_catalogue_runtime;
CREATE INDEX discovery_verified_scope_idx ON nukhabapay.catalogue_discovery_scans
  (tenant_id,provider_account_id,coverage_scope,completed_at DESC,id DESC) WHERE coverage_scope IS NOT NULL;
CREATE INDEX discovery_staff_market_idx ON nukhabapay.catalogue_discoveries
  (tenant_id,source_country,provider_account_id,id);
CREATE INDEX discovery_staff_id_idx ON nukhabapay.catalogue_discoveries (tenant_id,id);
CREATE INDEX discovery_staff_name_idx ON nukhabapay.catalogue_discoveries
  (tenant_id,(lower(normalize(product_name,NFKC)) COLLATE "C"),id);

CREATE TABLE nukhabapay.catalogue_discovery_coverage_corrections (
  tenant_id uuid NOT NULL, provider_account_id uuid NOT NULL, scan_id uuid NOT NULL,
  reason text NOT NULL DEFAULT 'UNVERIFIED_PROVIDER_PAGINATION'
    CHECK (reason='UNVERIFIED_PROVIDER_PAGINATION'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_by name NOT NULL DEFAULT current_user,
  PRIMARY KEY (tenant_id,provider_account_id,scan_id),
  FOREIGN KEY (tenant_id,provider_account_id,scan_id)
    REFERENCES nukhabapay.catalogue_discovery_scans(tenant_id,provider_account_id,id)
);
ALTER TABLE nukhabapay.catalogue_discovery_coverage_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.catalogue_discovery_coverage_corrections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON nukhabapay.catalogue_discovery_coverage_corrections
  USING (tenant_id::text=current_setting('nukhabapay.tenant_id',true))
  WITH CHECK (tenant_id::text=current_setting('nukhabapay.tenant_id',true)
    AND EXISTS (
      SELECT FROM nukhabapay.catalogue_discovery_scans s
      JOIN nukhabapay.provider_accounts a ON (a.tenant_id,a.id)=(s.tenant_id,s.provider_account_id)
      WHERE (s.tenant_id,s.provider_account_id,s.id)=(catalogue_discovery_coverage_corrections.tenant_id,
        catalogue_discovery_coverage_corrections.provider_account_id,catalogue_discovery_coverage_corrections.scan_id)
        AND s.coverage_scope IS NULL AND a.provider_code='FINXPLOR'));
REVOKE ALL ON nukhabapay.catalogue_discovery_coverage_corrections FROM PUBLIC;
GRANT SELECT ON nukhabapay.catalogue_discovery_coverage_corrections TO nukhbapay_catalogue_reader,nukhbapay_catalogue_runtime;
GRANT INSERT (tenant_id,provider_account_id,scan_id) ON nukhabapay.catalogue_discovery_coverage_corrections TO nukhbapay_catalogue_runtime;
CREATE TRIGGER immutable_coverage_correction BEFORE UPDATE OR DELETE OR TRUNCATE
  ON nukhabapay.catalogue_discovery_coverage_corrections FOR EACH STATEMENT
  EXECUTE FUNCTION nukhabapay.reject_publication_evidence_mutation();

CREATE FUNCTION nukhabapay.check_local_discovery_coverage() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $body$
BEGIN
  IF NOT EXISTS (SELECT FROM nukhabapay.provider_accounts a
    WHERE (a.tenant_id,a.id)=(NEW.tenant_id,NEW.provider_account_id) AND a.provider_code='FINXPLOR')
  OR NOT EXISTS (
    SELECT 1 FROM nukhabapay.catalogue_discovery_scan_items i JOIN nukhabapay.catalogue_discoveries d
      ON (d.tenant_id,d.provider_account_id,d.id)=(i.tenant_id,i.provider_account_id,i.discovery_id)
    WHERE (i.tenant_id,i.provider_account_id,i.scan_id)=(NEW.tenant_id,NEW.provider_account_id,NEW.id)
    HAVING count(*)=NEW.product_count AND count(DISTINCT d.source_id)=NEW.product_count
      AND bool_and((d.source_country='ARE' AND d.category='Gift Card' AND d.source_country_label IN ('AE','ARE')
        AND d.source_category_label='Gift Card') IS TRUE)
      AND NEW.scan_digest=encode(sha256(convert_to(NEW.coverage_scope || E'\n' ||
        string_agg(d.source_id || ':' || d.source_digest, E'\n' ORDER BY d.source_id COLLATE "C"),'UTF8')),'hex')
  ) THEN
    RAISE EXCEPTION 'Incomplete scoped discovery scan' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $body$;
REVOKE ALL ON FUNCTION nukhabapay.check_local_discovery_coverage() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER local_discovery_coverage_at_commit
  AFTER INSERT ON nukhabapay.catalogue_discovery_scans DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.check_local_discovery_coverage();

-- Legacy rows remain browseable outside a subsequently verified market; their
-- classification remains unverified. Invoker rights retain all underlying RLS.
CREATE VIEW nukhabapay.current_catalogue_discoveries WITH (security_invoker=true) AS
WITH latest_scans AS (
  SELECT DISTINCT ON (tenant_id,provider_account_id,coverage_scope) *
  FROM nukhabapay.catalogue_discovery_scans
  ORDER BY tenant_id,provider_account_id,coverage_scope,completed_at DESC,id DESC
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
      AND (s.coverage_scope IS NULL OR (s.coverage_scope='ARE_GIFT_CARD' AND d.source_country='ARE'
        AND lower(d.category) IN ('gift card','gift cards'))))
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
REVOKE ALL ON nukhabapay.current_catalogue_discoveries FROM PUBLIC;
GRANT SELECT ON nukhabapay.current_catalogue_discoveries TO nukhbapay_catalogue_reader,nukhbapay_catalogue_runtime;
