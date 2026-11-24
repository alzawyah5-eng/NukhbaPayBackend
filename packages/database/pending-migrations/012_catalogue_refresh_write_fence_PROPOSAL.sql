-- Addendum to 012 R2. Disposable-only until runtime roles and migration are authorized.
-- Same lock namespace as the existing R2 schedule/claim transitions.
CREATE FUNCTION nukhabapay.serialize_refresh_write_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $f$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended(OLD.tenant_id::text||':'||OLD.schedule_id::text,12012)) THEN
    RAISE EXCEPTION 'Refresh write in progress' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END;
$f$;
REVOKE ALL ON FUNCTION nukhabapay.serialize_refresh_write_fence() FROM PUBLIC;
CREATE TRIGGER catalogue_refresh_00_write_fence BEFORE UPDATE ON nukhabapay.catalogue_refresh_jobs
FOR EACH ROW EXECUTE FUNCTION nukhabapay.serialize_refresh_write_fence();

CREATE TABLE nukhabapay.catalogue_refresh_write_evidence (
  transaction_id bigint PRIMARY KEY DEFAULT txid_current(),
  tenant_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  provider_account_id uuid NOT NULL,
  version text NOT NULL,
  slot_at_ms bigint NOT NULL,
  token uuid NOT NULL,
  attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 3),
  purpose text NOT NULL CHECK(purpose IN ('IMPORT','DRAFT')),
  resource_key text NOT NULL CHECK(resource_key ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  FOREIGN KEY(tenant_id,schedule_id,version,slot_at_ms)
    REFERENCES nukhabapay.catalogue_refresh_jobs(tenant_id,schedule_id,version,slot_at_ms)
);
ALTER TABLE nukhabapay.catalogue_refresh_write_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.catalogue_refresh_write_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY refresh_write_scope ON nukhabapay.catalogue_refresh_write_evidence
  FOR INSERT WITH CHECK(tenant_id=nullif(current_setting('nukhabapay.refresh_tenant_id',true),'')::uuid);
REVOKE ALL ON nukhabapay.catalogue_refresh_write_evidence FROM PUBLIC;
CREATE TRIGGER refresh_write_evidence_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
ON nukhabapay.catalogue_refresh_write_evidence FOR EACH STATEMENT
EXECUTE FUNCTION nukhabapay.reject_refresh_audit_mutation();

CREATE FUNCTION nukhabapay.check_refresh_write_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $f$
BEGIN
  IF NEW.transaction_id<>txid_current() OR
     NOT pg_try_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':'||NEW.schedule_id::text,12012)) OR
     NOT EXISTS (
       SELECT 1 FROM nukhabapay.catalogue_refresh_jobs j
       JOIN nukhabapay.catalogue_refresh_schedules s ON (s.tenant_id,s.id,s.version)=(j.tenant_id,j.schedule_id,j.version)
       JOIN nukhabapay.provider_accounts a ON (a.tenant_id,a.id)=(s.tenant_id,s.provider_account_id)
       WHERE (j.tenant_id,j.schedule_id,j.version,j.slot_at_ms,j.token,j.attempt)=
             (NEW.tenant_id,NEW.schedule_id,NEW.version,NEW.slot_at_ms,NEW.token,NEW.attempt)
         AND s.provider_account_id=NEW.provider_account_id AND s.enabled AND a.status='ACTIVE' AND j.state='CLAIMED'
         AND j.lease_until_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint)
  THEN RAISE EXCEPTION 'Refresh write fence lost' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END;
$f$;
REVOKE ALL ON FUNCTION nukhabapay.check_refresh_write_evidence() FROM PUBLIC;
CREATE TRIGGER refresh_write_evidence_open BEFORE INSERT ON nukhabapay.catalogue_refresh_write_evidence
FOR EACH ROW EXECUTE FUNCTION nukhabapay.check_refresh_write_evidence();
CREATE CONSTRAINT TRIGGER refresh_write_evidence_commit AFTER INSERT ON nukhabapay.catalogue_refresh_write_evidence
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nukhabapay.check_refresh_write_evidence();
-- No grants in this proposal. The composed disposable writer requires only the original
-- write permissions, scoped job/schedule/account eligibility projection and INSERT on write evidence.
