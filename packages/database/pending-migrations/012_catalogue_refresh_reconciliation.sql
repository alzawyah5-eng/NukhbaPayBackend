CREATE POLICY refresh_reconciliation_read ON nukhabapay.catalogue_refresh_write_evidence
  FOR SELECT USING(tenant_id=nullif(current_setting('nukhabapay.refresh_tenant_id',true),'')::uuid);

CREATE TABLE nukhabapay.catalogue_refresh_reconciliation (
  observation_id text PRIMARY KEY CHECK(observation_id ~ '^[0-9a-f]{64}$'),
  tenant_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  version text NOT NULL,
  slot_at_ms bigint NOT NULL,
  token uuid NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('IMPORT','DRAFT')),
  resource_key text NOT NULL CHECK(resource_key ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  transaction_id bigint,
  outcome text NOT NULL CHECK(outcome IN ('COMMITTED','ROLLED_BACK','QUARANTINED')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_id,schedule_id,version,slot_at_ms)
    REFERENCES nukhabapay.catalogue_refresh_jobs(tenant_id,schedule_id,version,slot_at_ms)
);
ALTER TABLE nukhabapay.catalogue_refresh_reconciliation ENABLE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.catalogue_refresh_reconciliation FORCE ROW LEVEL SECURITY;
CREATE POLICY refresh_reconciliation_scope ON nukhabapay.catalogue_refresh_reconciliation
  USING(tenant_id=nullif(current_setting('nukhabapay.refresh_tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('nukhabapay.refresh_tenant_id',true),'')::uuid);
CREATE TRIGGER refresh_reconciliation_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
  ON nukhabapay.catalogue_refresh_reconciliation FOR EACH STATEMENT
  EXECUTE FUNCTION nukhabapay.reject_refresh_audit_mutation();
REVOKE ALL ON nukhabapay.catalogue_refresh_reconciliation FROM PUBLIC;
