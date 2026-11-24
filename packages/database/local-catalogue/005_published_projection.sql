-- Catalogue projection and append-only read audit. No channel workload receives
-- access until the payment and kiosk authority contracts are configured.
CREATE VIEW nukhabapay.published_catalogue_public WITH (security_barrier=true) AS
  WITH heads AS (
    SELECT DISTINCT ON (tenant_id,product_id) tenant_id,product_id,candidate_id,operation_id
    FROM nukhabapay.price_workflow_versions
    WHERE tenant_id::text=current_setting('nukhabapay.publication_tenant_id',true)
      AND tenant_id::text=current_setting('nukhabapay.tenant_id',true)
    ORDER BY tenant_id,product_id,revision DESC
  )
  SELECT h.product_id,p.brand AS name,h.operation_id AS publication_id,c.total_amount_minor,c.valid_until
  FROM heads h JOIN nukhabapay.catalogue_publication_candidates c USING(candidate_id,tenant_id,product_id)
  JOIN nukhabapay.price_workflow_audit a ON (a.operation_id,a.candidate_id,a.tenant_id,a.product_id) =
    (h.operation_id,h.candidate_id,h.tenant_id,h.product_id)
  JOIN nukhabapay.products p ON p.id=h.product_id
  WHERE c.valid_until>greatest(clock_timestamp(),nullif(current_setting('nukhabapay.catalogue_read_at',true),'')::timestamptz)
    AND nullif(current_setting('nukhabapay.catalogue_read_at',true),'') IS NOT NULL;
REVOKE ALL ON nukhabapay.published_catalogue_public FROM PUBLIC;

CREATE TABLE nukhabapay.published_catalogue_read_audit (
  request_id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES nukhabapay.tenants(id),
  client_digest text NOT NULL CHECK(client_digest ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CHECK(kind IN ('payment','kiosk')), kiosk_id uuid,
  catalogue_version text NOT NULL CHECK(catalogue_version ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  CHECK((kind='payment' AND kiosk_id IS NULL) OR (kind='kiosk' AND kiosk_id IS NOT NULL))
);
ALTER TABLE nukhabapay.published_catalogue_read_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.published_catalogue_read_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY published_read_audit_tenant ON nukhabapay.published_catalogue_read_audit
  USING (tenant_id::text=current_setting('nukhabapay.tenant_id',true)
    AND tenant_id::text=current_setting('nukhabapay.publication_tenant_id',true));
REVOKE ALL ON nukhabapay.published_catalogue_read_audit FROM PUBLIC;
CREATE TRIGGER immutable_published_read_audit BEFORE UPDATE OR DELETE OR TRUNCATE ON nukhabapay.published_catalogue_read_audit
  FOR EACH STATEMENT EXECUTE FUNCTION nukhabapay.reject_publication_evidence_mutation();
