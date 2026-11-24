-- Requires the existing price_workflow_versions relation. This additive schema
-- carries version notifications only. Consumers use their own scoped read API.
CREATE TABLE nukhabapay.publication_delivery_outbox (
  event_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  product_id uuid NOT NULL,
  revision bigint NOT NULL CHECK(revision>0),
  kind text NOT NULL CHECK(kind IN ('ACTIVATE','ROLLBACK')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (event_id,tenant_id,product_id)
    REFERENCES nukhabapay.price_workflow_versions(operation_id,tenant_id,product_id),
  UNIQUE (tenant_id,product_id,revision), UNIQUE (tenant_id,event_id)
);
CREATE TABLE nukhabapay.publication_delivery_state (
  event_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK(status IN ('PENDING','CLAIMED','RETRY_WAIT','ACKNOWLEDGED','FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 4),
  lease_token uuid,
  lease_until timestamptz,
  retry_at timestamptz,
  ack_receipt text CHECK(ack_receipt ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  FOREIGN KEY(tenant_id,event_id) REFERENCES nukhabapay.publication_delivery_outbox(tenant_id,event_id),
  CHECK((status='CLAIMED')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK((status='RETRY_WAIT')=(retry_at IS NOT NULL)),
  CHECK((status='ACKNOWLEDGED')=(ack_receipt IS NOT NULL))
);
CREATE TABLE nukhabapay.publication_delivery_audit (
  event_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status text NOT NULL,
  attempts integer NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_id,event_id) REFERENCES nukhabapay.publication_delivery_outbox(tenant_id,event_id)
);
CREATE TABLE nukhabapay.publication_delivery_recovery (
  event_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  verified_receipt text NOT NULL CHECK(verified_receipt ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  transaction_id bigint NOT NULL DEFAULT txid_current(),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_id,event_id) REFERENCES nukhabapay.publication_delivery_outbox(tenant_id,event_id)
);
CREATE INDEX publication_delivery_pending ON nukhabapay.publication_delivery_state(tenant_id,status,retry_at,lease_until)
  WHERE status<>'ACKNOWLEDGED';

DO $p$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['publication_delivery_outbox','publication_delivery_state','publication_delivery_audit','publication_delivery_recovery'] LOOP
    EXECUTE format('ALTER TABLE nukhabapay.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE nukhabapay.%I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('REVOKE ALL ON nukhabapay.%I FROM PUBLIC',name);
    EXECUTE format('CREATE POLICY delivery_scope ON nukhabapay.%I
      USING (tenant_id::text=current_setting(''nukhabapay.publication_tenant_id'',true))
      WITH CHECK (tenant_id::text=current_setting(''nukhabapay.publication_tenant_id'',true))',name);
  END LOOP;
END $p$;

CREATE FUNCTION nukhabapay.emit_publication_delivery() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $f$
BEGIN
  INSERT INTO nukhabapay.publication_delivery_outbox(event_id,tenant_id,product_id,revision,kind)
  VALUES(NEW.operation_id,NEW.tenant_id,NEW.product_id,NEW.revision,NEW.kind);
  INSERT INTO nukhabapay.publication_delivery_state(event_id,tenant_id) VALUES(NEW.operation_id,NEW.tenant_id);
  RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION nukhabapay.emit_publication_delivery() FROM PUBLIC;
CREATE TRIGGER publication_delivery_emit AFTER INSERT ON nukhabapay.price_workflow_versions
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.emit_publication_delivery();

CREATE FUNCTION nukhabapay.guard_publication_delivery() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $f$
DECLARE stamp timestamptz := clock_timestamp();
BEGIN
  IF TG_OP='INSERT' THEN
    IF pg_trigger_depth()<2 OR NEW.status<>'PENDING' OR NEW.attempts<>0 THEN
      RAISE EXCEPTION 'Publication delivery birth refused' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF (OLD.event_id,OLD.tenant_id) IS DISTINCT FROM (NEW.event_id,NEW.tenant_id) THEN
    RAISE EXCEPTION 'Publication delivery owner changed' USING ERRCODE='42501'; END IF;
  IF NEW.status='CLAIMED' AND OLD.attempts<4 AND
     (OLD.status='PENDING' OR (OLD.status='CLAIMED' AND OLD.lease_until<=stamp)
       OR (OLD.status='RETRY_WAIT' AND OLD.retry_at<=stamp)) AND
     NEW.attempts=OLD.attempts+1 AND NEW.lease_token IS DISTINCT FROM OLD.lease_token AND
     NEW.lease_until>stamp AND NEW.lease_until<=stamp+interval '60 seconds' THEN RETURN NEW; END IF;
  IF OLD.status='CLAIMED' AND NEW.attempts=OLD.attempts THEN
    IF NEW.status='ACKNOWLEDGED' AND OLD.lease_until>stamp THEN RETURN NEW; END IF;
    IF NEW.status='RETRY_WAIT' AND OLD.lease_until>stamp AND OLD.attempts<4
       AND NEW.retry_at>=stamp AND NEW.retry_at<=stamp+interval '60 seconds' THEN RETURN NEW; END IF;
    IF NEW.status='FAILED' AND OLD.attempts=4 THEN RETURN NEW; END IF;
  END IF;
  IF OLD.status='FAILED' AND NEW.status='ACKNOWLEDGED' AND NEW.attempts=OLD.attempts THEN
    IF EXISTS(SELECT 1 FROM nukhabapay.publication_delivery_recovery r
      WHERE r.tenant_id=OLD.tenant_id AND r.event_id=OLD.event_id AND r.transaction_id=txid_current()
        AND r.verified_receipt=NEW.ack_receipt) THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'Invalid publication delivery transition' USING ERRCODE='42501';
END $f$;
REVOKE ALL ON FUNCTION nukhabapay.guard_publication_delivery() FROM PUBLIC;
CREATE TRIGGER publication_delivery_guard BEFORE INSERT OR UPDATE ON nukhabapay.publication_delivery_state
FOR EACH ROW EXECUTE FUNCTION nukhabapay.guard_publication_delivery();

CREATE FUNCTION nukhabapay.log_publication_delivery() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $f$
BEGIN
  INSERT INTO nukhabapay.publication_delivery_audit(event_id,tenant_id,status,attempts)
  VALUES(NEW.event_id,NEW.tenant_id,NEW.status,NEW.attempts);
  RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION nukhabapay.log_publication_delivery() FROM PUBLIC;
CREATE TRIGGER publication_delivery_log AFTER INSERT OR UPDATE ON nukhabapay.publication_delivery_state
FOR EACH ROW EXECUTE FUNCTION nukhabapay.log_publication_delivery();

CREATE FUNCTION nukhabapay.guard_publication_event() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $f$
BEGIN
  IF pg_trigger_depth()<2 OR NOT EXISTS(SELECT 1 FROM nukhabapay.price_workflow_versions v
      WHERE (v.operation_id,v.tenant_id,v.product_id,v.revision,v.kind)=
        (NEW.event_id,NEW.tenant_id,NEW.product_id,NEW.revision,NEW.kind)) THEN
    RAISE EXCEPTION 'Publication event birth refused' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION nukhabapay.guard_publication_event() FROM PUBLIC;
CREATE TRIGGER publication_event_change BEFORE INSERT ON nukhabapay.publication_delivery_outbox
FOR EACH ROW EXECUTE FUNCTION nukhabapay.guard_publication_event();
CREATE TRIGGER publication_event_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON nukhabapay.publication_delivery_outbox
FOR EACH STATEMENT EXECUTE FUNCTION nukhabapay.reject_publication_evidence_mutation();
CREATE TRIGGER publication_delivery_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON nukhabapay.publication_delivery_audit
FOR EACH STATEMENT EXECUTE FUNCTION nukhabapay.reject_publication_evidence_mutation();
CREATE TRIGGER publication_delivery_recovery_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON nukhabapay.publication_delivery_recovery
FOR EACH STATEMENT EXECUTE FUNCTION nukhabapay.reject_publication_evidence_mutation();
