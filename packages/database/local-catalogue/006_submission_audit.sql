-- Bind price submission evidence to the transaction that created its draft.
-- This is a new local migration and leaves the synthetic submission schema intact.
CREATE TABLE nukhabapay.price_submission_births (
  candidate_id text PRIMARY KEY, tenant_id uuid NOT NULL, product_id uuid NOT NULL,
  creation_xid xid8 NOT NULL,
  UNIQUE(candidate_id,tenant_id,product_id,creation_xid),
  FOREIGN KEY(candidate_id,tenant_id,product_id)
    REFERENCES nukhabapay.catalogue_publication_candidates(candidate_id,tenant_id,product_id)
);
ALTER TABLE nukhabapay.price_submission_evidence
  ADD COLUMN creation_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  ADD CONSTRAINT local_submission_birth_fk FOREIGN KEY(candidate_id,tenant_id,product_id,creation_xid)
    REFERENCES nukhabapay.price_submission_births(candidate_id,tenant_id,product_id,creation_xid),
  ADD CONSTRAINT local_submission_audit_key UNIQUE(candidate_id,tenant_id,product_id,creator_staff_id,submitted_at);

CREATE TABLE nukhabapay.price_submission_events (
  candidate_id text PRIMARY KEY, tenant_id uuid NOT NULL, product_id uuid NOT NULL,
  creator_staff_id uuid NOT NULL, occurred_at timestamptz NOT NULL,
  event_name text NOT NULL DEFAULT 'PRICE_SUBMITTED' CHECK(event_name='PRICE_SUBMITTED'),
  FOREIGN KEY(candidate_id,tenant_id,product_id,creator_staff_id,occurred_at)
    REFERENCES nukhabapay.price_submission_evidence(candidate_id,tenant_id,product_id,creator_staff_id,submitted_at)
);

DO $security$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['price_submission_births','price_submission_events'] LOOP
    EXECUTE format('ALTER TABLE nukhabapay.%I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE nukhabapay.%I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format($policy$CREATE POLICY submission_tenant_scope ON nukhabapay.%I
      USING (tenant_id::text=current_setting('nukhabapay.tenant_id',true)
        AND tenant_id::text=current_setting('nukhabapay.publication_tenant_id',true))$policy$,relation);
    EXECUTE format('REVOKE ALL ON nukhabapay.%I FROM PUBLIC',relation);
    EXECUTE format('CREATE TRIGGER immutable_submission BEFORE UPDATE OR DELETE OR TRUNCATE ON nukhabapay.%I
      FOR EACH STATEMENT EXECUTE FUNCTION nukhabapay.reject_publication_evidence_mutation()',relation);
  END LOOP;
END $security$;

CREATE FUNCTION nukhabapay.record_local_submission_birth() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
BEGIN
  INSERT INTO nukhabapay.price_submission_births(candidate_id,tenant_id,product_id,creation_xid)
    VALUES(NEW.candidate_id,NEW.tenant_id,NEW.product_id,pg_current_xact_id());
  RETURN NEW;
END $body$;
CREATE TRIGGER local_submission_birth AFTER INSERT ON nukhabapay.catalogue_publication_candidates
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.record_local_submission_birth();

CREATE FUNCTION nukhabapay.require_local_submission_audit() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
BEGIN
  IF NEW.creation_xid<>pg_current_xact_id() OR NOT EXISTS(SELECT FROM nukhabapay.price_submission_events e
    WHERE e.candidate_id=NEW.candidate_id AND e.tenant_id=NEW.tenant_id AND e.product_id=NEW.product_id) THEN
    RAISE EXCEPTION 'Missing current draft birth or submission audit' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $body$;
CREATE CONSTRAINT TRIGGER local_submission_evidence AFTER INSERT ON nukhabapay.price_submission_evidence
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nukhabapay.require_local_submission_audit();
