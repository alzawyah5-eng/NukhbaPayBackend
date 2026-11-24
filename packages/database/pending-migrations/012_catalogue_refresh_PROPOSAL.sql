-- PROPOSAL ONLY. Not registered, not approved, never loaded by application startup.
-- Requires owner review of role grants, tenant configuration and retention policy.
-- New tables only; no changes to IAM, publication, R6 or frozen migrations.
CREATE TABLE nukhabapay.catalogue_refresh_schedules (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, provider_account_id uuid NOT NULL,
  provider_id text NOT NULL CHECK (provider_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  source_version text NOT NULL CHECK (source_version ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  version text NOT NULL CHECK (version ~ '^[A-Za-z0-9_.:-]{1,128}$'), enabled boolean NOT NULL,
  first_run_at_ms bigint NOT NULL CHECK (first_run_at_ms >= 0),
  interval_ms bigint NOT NULL CHECK (interval_ms = 86400000), UNIQUE(tenant_id,id)
);
CREATE TABLE nukhabapay.catalogue_refresh_jobs (
  tenant_id uuid NOT NULL, schedule_id uuid NOT NULL, version text NOT NULL,
  slot_at_ms bigint NOT NULL CHECK(slot_at_ms >= 0), token uuid NOT NULL,
  attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 3), lease_until_ms bigint NOT NULL,
  state text NOT NULL CHECK(state IN ('CLAIMED','SUCCEEDED','RETRY_WAIT','FAILED','UNCERTAIN')),
  reason text NOT NULL CHECK(reason IN ('NONE','PROVIDER_READ_UNAVAILABLE','CANCELLED_OR_TIMED_OUT','OUTCOME_UNCERTAIN','LEASE_EXPIRED')),
  next_attempt_at_ms bigint, updated_at_ms bigint NOT NULL,
  PRIMARY KEY(tenant_id,schedule_id,version,slot_at_ms),
  FOREIGN KEY(tenant_id,schedule_id) REFERENCES nukhabapay.catalogue_refresh_schedules(tenant_id,id),
  CHECK ((state='RETRY_WAIT') = (next_attempt_at_ms IS NOT NULL)),
  CHECK (next_attempt_at_ms IS NULL OR next_attempt_at_ms >= updated_at_ms)
);
CREATE TABLE nukhabapay.catalogue_refresh_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL, schedule_id uuid NOT NULL, version text NOT NULL, slot_at_ms bigint NOT NULL,
  token uuid NOT NULL, attempt integer NOT NULL, state text NOT NULL, reason text NOT NULL, occurred_at_ms bigint NOT NULL,
  FOREIGN KEY(tenant_id,schedule_id,version,slot_at_ms) REFERENCES nukhabapay.catalogue_refresh_jobs(tenant_id,schedule_id,version,slot_at_ms)
);
ALTER TABLE nukhabapay.catalogue_refresh_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.catalogue_refresh_schedules FORCE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.catalogue_refresh_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.catalogue_refresh_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.catalogue_refresh_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.catalogue_refresh_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY refresh_schedule_tenant ON nukhabapay.catalogue_refresh_schedules
  USING (tenant_id = nullif(current_setting('nukhabapay.refresh_tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('nukhabapay.refresh_tenant_id',true),'')::uuid);
CREATE POLICY refresh_job_tenant ON nukhabapay.catalogue_refresh_jobs
  USING (tenant_id = nullif(current_setting('nukhabapay.refresh_tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('nukhabapay.refresh_tenant_id',true),'')::uuid);
CREATE POLICY refresh_audit_tenant ON nukhabapay.catalogue_refresh_audit FOR INSERT
  WITH CHECK (tenant_id = nullif(current_setting('nukhabapay.refresh_tenant_id',true),'')::uuid);
REVOKE ALL ON nukhabapay.catalogue_refresh_schedules,nukhabapay.catalogue_refresh_jobs,nukhabapay.catalogue_refresh_audit FROM PUBLIC;
REVOKE ALL ON SEQUENCE nukhabapay.catalogue_refresh_audit_id_seq FROM PUBLIC;
-- No role creation, membership, credentials, grants, execution or automatic activation.
-- Any future worker role needs only schedule SELECT, job SELECT/INSERT/UPDATE,
-- audit INSERT and sequence USAGE; never audit UPDATE/DELETE or publication grants.
-- The GUC scopes an approved workload; it is not proof of human identity.

CREATE FUNCTION nukhabapay.reject_refresh_audit_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Refresh audit is append-only' USING ERRCODE='42501'; END $$;
REVOKE ALL ON FUNCTION nukhabapay.reject_refresh_audit_mutation() FROM PUBLIC;
CREATE TRIGGER refresh_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
ON nukhabapay.catalogue_refresh_audit FOR EACH STATEMENT
EXECUTE FUNCTION nukhabapay.reject_refresh_audit_mutation();
