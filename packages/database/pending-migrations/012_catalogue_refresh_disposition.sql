-- Additive recovery for 012 R2. No quarantined slot is replayed or rewritten.
CREATE TABLE nukhabapay.catalogue_refresh_dispositions (
  tenant_id uuid NOT NULL, schedule_id uuid NOT NULL, version text NOT NULL, slot_at_ms bigint NOT NULL,
  token uuid NOT NULL, attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 3),
  observation_id text NOT NULL REFERENCES nukhabapay.catalogue_refresh_reconciliation(observation_id),
  action text NOT NULL DEFAULT 'SKIP_QUARANTINED_SLOT' CHECK(action='SKIP_QUARANTINED_SLOT'),
  operator_role name NOT NULL DEFAULT session_user,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,schedule_id,version,slot_at_ms),
  FOREIGN KEY(tenant_id,schedule_id,version,slot_at_ms)
    REFERENCES nukhabapay.catalogue_refresh_jobs(tenant_id,schedule_id,version,slot_at_ms)
);
ALTER TABLE nukhabapay.catalogue_refresh_dispositions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.catalogue_refresh_dispositions FORCE ROW LEVEL SECURITY;
CREATE POLICY refresh_disposition_scope ON nukhabapay.catalogue_refresh_dispositions
  USING(tenant_id=nullif(current_setting('nukhabapay.refresh_tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('nukhabapay.refresh_tenant_id',true),'')::uuid);
REVOKE ALL ON nukhabapay.catalogue_refresh_dispositions FROM PUBLIC;
CREATE TRIGGER refresh_disposition_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
  ON nukhabapay.catalogue_refresh_dispositions FOR EACH STATEMENT EXECUTE FUNCTION nukhabapay.reject_refresh_audit_mutation();

CREATE FUNCTION nukhabapay.validate_refresh_disposition() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $guard$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':'||NEW.schedule_id::text,12012)) OR
    NOT EXISTS(SELECT 1 FROM nukhabapay.catalogue_refresh_jobs j
      JOIN nukhabapay.catalogue_refresh_reconciliation r ON
        (r.tenant_id,r.schedule_id,r.version,r.slot_at_ms,r.token)=(j.tenant_id,j.schedule_id,j.version,j.slot_at_ms,j.token)
      WHERE (j.tenant_id,j.schedule_id,j.version,j.slot_at_ms,j.token,j.attempt)=
        (NEW.tenant_id,NEW.schedule_id,NEW.version,NEW.slot_at_ms,NEW.token,NEW.attempt)
        AND j.state='UNCERTAIN' AND r.observation_id=NEW.observation_id)
  THEN RAISE EXCEPTION 'Invalid quarantine disposition' USING ERRCODE='42501'; END IF;
  NEW.operator_role := session_user;
  NEW.occurred_at := clock_timestamp();
  RETURN NEW;
END $guard$;
REVOKE ALL ON FUNCTION nukhabapay.validate_refresh_disposition() FROM PUBLIC;
CREATE TRIGGER validate_refresh_disposition BEFORE INSERT ON nukhabapay.catalogue_refresh_dispositions
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.validate_refresh_disposition();

CREATE FUNCTION nukhabapay.guard_unresolved_refresh_jobs() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $guard$
BEGIN
  IF NEW.state<>'CLAIMED' THEN RETURN NEW; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':'||NEW.schedule_id::text,12012)) OR
    EXISTS(SELECT 1 FROM nukhabapay.catalogue_refresh_jobs j
      WHERE (j.tenant_id,j.schedule_id)=(NEW.tenant_id,NEW.schedule_id) AND j.state='UNCERTAIN'
        AND NOT EXISTS(SELECT 1 FROM nukhabapay.catalogue_refresh_dispositions d WHERE
          (d.tenant_id,d.schedule_id,d.version,d.slot_at_ms,d.token,d.attempt)=
            (j.tenant_id,j.schedule_id,j.version,j.slot_at_ms,j.token,j.attempt)))
  THEN RAISE EXCEPTION 'Refresh quarantine unresolved' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $guard$;
REVOKE ALL ON FUNCTION nukhabapay.guard_unresolved_refresh_jobs() FROM PUBLIC;
CREATE TRIGGER guard_unresolved_refresh_jobs BEFORE INSERT OR UPDATE ON nukhabapay.catalogue_refresh_jobs
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.guard_unresolved_refresh_jobs();

CREATE UNIQUE INDEX catalogue_refresh_one_claim ON nukhabapay.catalogue_refresh_jobs(tenant_id,schedule_id)
  WHERE state='CLAIMED';
DROP INDEX nukhabapay.catalogue_refresh_one_outstanding;

CREATE OR REPLACE FUNCTION nukhabapay.guard_refresh_schedule_update() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $guard$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(OLD.tenant_id::text||':'||OLD.id::text,12012));
  IF (NEW.id,NEW.tenant_id,NEW.provider_account_id) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.provider_account_id)
     OR NEW.version=OLD.version
     OR EXISTS (SELECT 1 FROM nukhabapay.catalogue_refresh_jobs j
       WHERE j.tenant_id=OLD.tenant_id AND j.schedule_id=OLD.id AND
         (j.state='CLAIMED' OR j.version=NEW.version OR (j.state='UNCERTAIN' AND NOT EXISTS(
           SELECT 1 FROM nukhabapay.catalogue_refresh_dispositions d WHERE
             (d.tenant_id,d.schedule_id,d.version,d.slot_at_ms,d.token,d.attempt)=
             (j.tenant_id,j.schedule_id,j.version,j.slot_at_ms,j.token,j.attempt)))))
  THEN RAISE EXCEPTION 'Refresh schedule supersession denied' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $guard$;
