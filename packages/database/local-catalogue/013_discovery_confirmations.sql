-- Reconfirm unchanged scoped data without duplicating products or scan versions.
CREATE TABLE nukhabapay.catalogue_discovery_confirmations (
  tenant_id uuid NOT NULL, provider_account_id uuid NOT NULL, scan_id uuid NOT NULL,
  run_id uuid NOT NULL, observed_at timestamptz NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,provider_account_id,run_id),
  FOREIGN KEY (tenant_id,provider_account_id,scan_id)
    REFERENCES nukhabapay.catalogue_discovery_scans(tenant_id,provider_account_id,id),
  CHECK (isfinite(observed_at) AND observed_at<=confirmed_at)
);
CREATE INDEX discovery_confirmation_scan_idx ON nukhabapay.catalogue_discovery_confirmations
  (tenant_id,provider_account_id,scan_id,confirmed_at DESC);
ALTER TABLE nukhabapay.catalogue_discovery_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.catalogue_discovery_confirmations FORCE ROW LEVEL SECURITY;
CREATE POLICY confirmation_scope ON nukhabapay.catalogue_discovery_confirmations
  USING (tenant_id::text=current_setting('nukhabapay.tenant_id',true))
  WITH CHECK (tenant_id::text=current_setting('nukhabapay.tenant_id',true)
    AND EXISTS (
      SELECT FROM nukhabapay.catalogue_discovery_scans s
      WHERE (s.tenant_id,s.provider_account_id,s.id)=(catalogue_discovery_confirmations.tenant_id,
        catalogue_discovery_confirmations.provider_account_id,catalogue_discovery_confirmations.scan_id)
        AND s.coverage_scope='ARE_GIFT_CARD' AND catalogue_discovery_confirmations.observed_at>=s.source_observed_at));
REVOKE ALL ON nukhabapay.catalogue_discovery_confirmations FROM PUBLIC;
GRANT SELECT ON nukhabapay.catalogue_discovery_confirmations TO nukhbapay_catalogue_reader,nukhbapay_catalogue_runtime;
GRANT INSERT (tenant_id,provider_account_id,scan_id,run_id,observed_at)
  ON nukhabapay.catalogue_discovery_confirmations TO nukhbapay_catalogue_runtime;
CREATE TRIGGER immutable_discovery_confirmation BEFORE UPDATE OR DELETE OR TRUNCATE
  ON nukhabapay.catalogue_discovery_confirmations FOR EACH STATEMENT
  EXECUTE FUNCTION nukhabapay.reject_publication_evidence_mutation();

CREATE VIEW nukhabapay.observed_catalogue_discoveries WITH (security_invoker=true) AS
WITH latest AS (
  SELECT DISTINCT ON (tenant_id,provider_account_id,coverage_scope) tenant_id,provider_account_id,coverage_scope,id
  FROM nukhabapay.catalogue_discovery_scans WHERE coverage_scope IS NOT NULL
  ORDER BY tenant_id,provider_account_id,coverage_scope,completed_at DESC,id DESC
), confirmation AS (
  SELECT s.tenant_id,s.provider_account_id,s.coverage_scope,max(c.confirmed_at) AS confirmed_at
  FROM latest s JOIN nukhabapay.catalogue_discovery_confirmations c
    ON (c.tenant_id,c.provider_account_id,c.scan_id)=(s.tenant_id,s.provider_account_id,s.id)
  GROUP BY s.tenant_id,s.provider_account_id,s.coverage_scope
)
SELECT d.*,greatest(d.observed_at,c.confirmed_at) AS last_verified_at
FROM nukhabapay.current_catalogue_discoveries d LEFT JOIN confirmation c
  ON (c.tenant_id,c.provider_account_id,c.coverage_scope)=(d.tenant_id,d.provider_account_id,d.coverage_scope);
REVOKE ALL ON nukhabapay.observed_catalogue_discoveries FROM PUBLIC;
GRANT SELECT ON nukhabapay.observed_catalogue_discoveries TO nukhbapay_catalogue_reader,nukhbapay_catalogue_runtime;
