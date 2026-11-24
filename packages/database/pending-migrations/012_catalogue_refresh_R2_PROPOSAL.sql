-- 012 R2 proposal. Supersedes the design of the archived 012 proposal.
-- Unregistered and unapplied. Use one proposal only if separately authorized.
-- Requires owner review of role grants, tenant configuration and retention policy.
-- New tables only; no changes to IAM, publication, R6 or frozen migrations.
CREATE TABLE nukhabapay.catalogue_refresh_schedules (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, provider_account_id uuid NOT NULL,
  source_version text NOT NULL CHECK (source_version ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  version text NOT NULL CHECK (version ~ '^[A-Za-z0-9_.:-]{1,128}$'), enabled boolean NOT NULL,
  first_run_at_ms bigint NOT NULL CHECK (first_run_at_ms >= 0),
  interval_ms bigint NOT NULL CHECK (interval_ms = 86400000),
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,provider_account_id),
  FOREIGN KEY(tenant_id,provider_account_id)
    REFERENCES nukhabapay.provider_accounts(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE nukhabapay.catalogue_refresh_jobs (
  tenant_id uuid NOT NULL, schedule_id uuid NOT NULL, version text NOT NULL,
  slot_at_ms bigint NOT NULL CHECK(slot_at_ms >= 0), token uuid NOT NULL,
  attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 3), lease_until_ms bigint NOT NULL,
  lease_duration_ms integer NOT NULL CHECK(lease_duration_ms BETWEEN 1010 AND 300000),
  state text NOT NULL CHECK(state IN ('CLAIMED','SUCCEEDED','RETRY_WAIT','FAILED','UNCERTAIN')),
  reason text NOT NULL CHECK(reason IN ('NONE','PROVIDER_READ_UNAVAILABLE','CANCELLED_OR_TIMED_OUT','OUTCOME_UNCERTAIN','LEASE_EXPIRED')),
  next_attempt_at_ms bigint, updated_at_ms bigint NOT NULL,
  PRIMARY KEY(tenant_id,schedule_id,version,slot_at_ms),
  FOREIGN KEY(tenant_id,schedule_id) REFERENCES nukhabapay.catalogue_refresh_schedules(tenant_id,id),
  CHECK ((state='RETRY_WAIT') = (next_attempt_at_ms IS NOT NULL)),
  CHECK (next_attempt_at_ms IS NULL OR next_attempt_at_ms >= updated_at_ms),
  CHECK ((state IN ('CLAIMED','SUCCEEDED') AND reason='NONE')
      OR (state='RETRY_WAIT' AND attempt<3 AND reason='PROVIDER_READ_UNAVAILABLE')
      OR (state='FAILED' AND attempt=3 AND reason='PROVIDER_READ_UNAVAILABLE')
      OR (state='UNCERTAIN' AND reason IN ('LEASE_EXPIRED','CANCELLED_OR_TIMED_OUT','OUTCOME_UNCERTAIN')))
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
CREATE UNIQUE INDEX catalogue_refresh_one_outstanding
  ON nukhabapay.catalogue_refresh_jobs(tenant_id,schedule_id)
  WHERE state IN ('CLAIMED','UNCERTAIN');
CREATE INDEX catalogue_refresh_due_retries
  ON nukhabapay.catalogue_refresh_jobs(tenant_id,schedule_id,version,next_attempt_at_ms,slot_at_ms)
  WHERE state='RETRY_WAIT';
CREATE INDEX catalogue_refresh_lease_expiry
  ON nukhabapay.catalogue_refresh_jobs(tenant_id,lease_until_ms)
  WHERE state='CLAIMED';

-- No role creation, membership, credentials, grants, execution or automatic activation.
-- Any future worker role needs only schedule SELECT, job SELECT/INSERT/UPDATE,
-- column-limited provider_accounts SELECT for eligibility, audit INSERT and sequence USAGE.
-- Never grant schedule UPDATE, audit UPDATE/DELETE/TRUNCATE or publication grants.
-- Audit INSERT is limited by the trigger below to the exact nested row event.
-- The GUC scopes an approved workload; it is not proof of human identity.

CREATE FUNCTION nukhabapay.reject_refresh_audit_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Refresh audit is append-only' USING ERRCODE='42501'; END $$;
REVOKE ALL ON FUNCTION nukhabapay.reject_refresh_audit_mutation() FROM PUBLIC;
CREATE TRIGGER refresh_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
ON nukhabapay.catalogue_refresh_audit FOR EACH STATEMENT
EXECUTE FUNCTION nukhabapay.reject_refresh_audit_mutation();


CREATE FUNCTION nukhabapay.guard_refresh_schedule_update() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(OLD.tenant_id::text||':'||OLD.id::text,12012));
  IF (NEW.id,NEW.tenant_id,NEW.provider_account_id)
     IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.provider_account_id)
     OR NEW.version=OLD.version
     OR EXISTS (SELECT 1 FROM nukhabapay.catalogue_refresh_jobs j
       WHERE j.tenant_id=OLD.tenant_id AND j.schedule_id=OLD.id
         AND (j.state IN ('CLAIMED','UNCERTAIN') OR j.version=NEW.version))
  THEN RAISE EXCEPTION 'Refresh schedule supersession denied' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION nukhabapay.guard_refresh_schedule_update() FROM PUBLIC;
CREATE TRIGGER catalogue_refresh_schedule_guard BEFORE UPDATE ON nukhabapay.catalogue_refresh_schedules
FOR EACH ROW EXECUTE FUNCTION nukhabapay.guard_refresh_schedule_update();

CREATE FUNCTION nukhabapay.guard_refresh_job_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE
  at_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  scheduled nukhabapay.catalogue_refresh_schedules%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.tenant_id,NEW.schedule_id,NEW.version,NEW.slot_at_ms)
    IS DISTINCT FROM (OLD.tenant_id,OLD.schedule_id,OLD.version,OLD.slot_at_ms)
  THEN RAISE EXCEPTION 'Refresh claim key is immutable' USING ERRCODE='23514'; END IF;

  IF TG_OP='INSERT' OR NEW.state='CLAIMED' THEN
    IF TG_OP='INSERT' OR OLD.state='RETRY_WAIT' THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':'||NEW.schedule_id::text,12012));
      at_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
    END IF;
    SELECT s.* INTO scheduled FROM nukhabapay.catalogue_refresh_schedules s
      JOIN nukhabapay.provider_accounts a ON a.tenant_id=s.tenant_id AND a.id=s.provider_account_id
      WHERE s.tenant_id=NEW.tenant_id AND s.id=NEW.schedule_id AND s.version=NEW.version
        AND s.enabled AND a.status='ACTIVE';
    IF NOT FOUND OR NEW.slot_at_ms<scheduled.first_run_at_ms OR NEW.slot_at_ms>at_ms
       OR (NEW.slot_at_ms-scheduled.first_run_at_ms)%scheduled.interval_ms<>0
    THEN RAISE EXCEPTION 'Refresh schedule binding lost' USING ERRCODE='23514'; END IF;
  END IF;

  IF TG_OP='INSERT' THEN
    IF NEW.state<>'CLAIMED' OR NEW.attempt<>1
      OR NEW.slot_at_ms<>scheduled.first_run_at_ms+((at_ms-scheduled.first_run_at_ms)/scheduled.interval_ms)*scheduled.interval_ms
    THEN RAISE EXCEPTION 'Invalid refresh claim' USING ERRCODE='23514'; END IF;
    -- Conflict handling must not hide a parked retry for another slot.
    IF EXISTS (SELECT 1 FROM nukhabapay.catalogue_refresh_jobs j
      WHERE j.tenant_id=NEW.tenant_id AND j.schedule_id=NEW.schedule_id
        AND j.version=NEW.version AND j.state='RETRY_WAIT')
    THEN RAISE EXCEPTION 'Existing refresh retry' USING ERRCODE='23514'; END IF;
  ELSIF OLD.state='RETRY_WAIT' AND NEW.state='CLAIMED' THEN
    IF OLD.next_attempt_at_ms>at_ms OR NEW.token=OLD.token OR NEW.attempt<>OLD.attempt+1
    THEN RAISE EXCEPTION 'Invalid refresh retry' USING ERRCODE='23514'; END IF;
  ELSIF OLD.state='CLAIMED' THEN
    IF (NEW.token,NEW.attempt) IS DISTINCT FROM (OLD.token,OLD.attempt) OR
       ((at_ms>=OLD.lease_until_ms) IS DISTINCT FROM
         (NEW.state='UNCERTAIN' AND NEW.reason='LEASE_EXPIRED'))
    THEN RAISE EXCEPTION 'Refresh lease fence lost' USING ERRCODE='23514'; END IF;
    IF NEW.state='CLAIMED' AND at_ms+NEW.lease_duration_ms<=OLD.lease_until_ms
    THEN RAISE EXCEPTION 'Refresh renewal must extend its lease' USING ERRCODE='23514'; END IF;
    IF NEW.state<>'CLAIMED' THEN
      NEW.lease_until_ms := OLD.lease_until_ms;
      NEW.lease_duration_ms := OLD.lease_duration_ms;
    END IF;
  ELSE
    RAISE EXCEPTION 'Invalid refresh transition' USING ERRCODE='23514';
  END IF;

  NEW.updated_at_ms := at_ms;
  NEW.next_attempt_at_ms := CASE WHEN NEW.state='RETRY_WAIT' THEN at_ms + NEW.attempt * 1000 ELSE NULL END;
  IF NEW.state='CLAIMED' THEN NEW.lease_until_ms := at_ms + NEW.lease_duration_ms; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION nukhabapay.guard_refresh_job_transition() FROM PUBLIC;
CREATE TRIGGER catalogue_refresh_job_guard BEFORE INSERT OR UPDATE ON nukhabapay.catalogue_refresh_jobs
FOR EACH ROW EXECUTE FUNCTION nukhabapay.guard_refresh_job_transition();

CREATE FUNCTION nukhabapay.append_refresh_job_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  INSERT INTO nukhabapay.catalogue_refresh_audit
    (tenant_id,schedule_id,version,slot_at_ms,token,attempt,state,reason,occurred_at_ms)
  VALUES (NEW.tenant_id,NEW.schedule_id,NEW.version,NEW.slot_at_ms,NEW.token,
    NEW.attempt,NEW.state,NEW.reason,NEW.updated_at_ms);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION nukhabapay.append_refresh_job_audit() FROM PUBLIC;
CREATE TRIGGER catalogue_refresh_job_audit AFTER INSERT OR UPDATE ON nukhabapay.catalogue_refresh_jobs
FOR EACH ROW EXECUTE FUNCTION nukhabapay.append_refresh_job_audit();

CREATE FUNCTION nukhabapay.require_refresh_job_audit_context() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  -- Reviewed workload roles have no DDL or trigger-installation privileges.
  IF pg_trigger_depth()<>2 OR NOT EXISTS (
    SELECT 1 FROM nukhabapay.catalogue_refresh_jobs j WHERE
      (j.tenant_id,j.schedule_id,j.version,j.slot_at_ms,j.token,j.attempt,j.state,j.reason,j.updated_at_ms)
      =(NEW.tenant_id,NEW.schedule_id,NEW.version,NEW.slot_at_ms,NEW.token,NEW.attempt,NEW.state,NEW.reason,NEW.occurred_at_ms)
  ) THEN RAISE EXCEPTION 'Refresh audit requires a matching job transition' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION nukhabapay.require_refresh_job_audit_context() FROM PUBLIC;
CREATE TRIGGER catalogue_refresh_audit_context BEFORE INSERT ON nukhabapay.catalogue_refresh_audit
FOR EACH ROW EXECUTE FUNCTION nukhabapay.require_refresh_job_audit_context();
