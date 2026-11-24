-- Disposable-only addition after staff-access-request-records and synthetic-approval-provenance.
CREATE TABLE nukhabapay.staff_rehearsal_decisions (
  operation_id text PRIMARY KEY REFERENCES nukhabapay.staff_synthetic_provenance(operation_id),
  scope_key text NOT NULL CHECK(scope_key='PLATFORM'),
  request_id uuid NOT NULL,
  request_version bigint NOT NULL,
  slot text NOT NULL CHECK(slot IN ('SECURITY_ADMIN','GOVERNANCE_OWNER')),
  decision text NOT NULL CHECK(decision IN ('APPROVE','REJECT')),
  execution text NOT NULL DEFAULT 'NOT_AUTHORIZED' CHECK(execution='NOT_AUTHORIZED'),
  UNIQUE(request_id,request_version,slot),
  FOREIGN KEY(request_id,request_version,scope_key) REFERENCES nukhabapay.staff_access_requests(request_id,version,scope_key),
  FOREIGN KEY(operation_id,scope_key) REFERENCES nukhabapay.staff_request_operations(operation_id,scope_key)
);

CREATE FUNCTION nukhabapay.validate_rehearsal_decision() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $f$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM nukhabapay.staff_synthetic_provenance p
    WHERE p.operation_id=NEW.operation_id AND p.scope_key=NEW.scope_key
      AND p.request_id=NEW.request_id AND p.request_version=NEW.request_version
      AND p.binding->>'decision'=NEW.decision)
  THEN RAISE EXCEPTION 'Decision binding missing' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$f$;
REVOKE ALL ON FUNCTION nukhabapay.validate_rehearsal_decision() FROM PUBLIC;
CREATE TRIGGER staff_rehearsal_decision_binding BEFORE INSERT ON nukhabapay.staff_rehearsal_decisions
FOR EACH ROW EXECUTE FUNCTION nukhabapay.validate_rehearsal_decision();

-- Receipt and committed audit are fields of one immutable event row.
CREATE TABLE nukhabapay.staff_execution_rehearsals (
  operation_id text PRIMARY KEY CHECK(operation_id ~ '^[0-9a-f]{64}$'),
  actor_staff_id uuid NOT NULL,
  target_staff_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  request_id uuid NOT NULL,
  request_version bigint NOT NULL,
  request_digest text NOT NULL,
  scope_key text NOT NULL CHECK(scope_key='PLATFORM'),
  approval_digest text NOT NULL CHECK(approval_digest ~ '^[0-9a-f]{64}$'),
  command_digest text NOT NULL CHECK(command_digest ~ '^[0-9a-f]{64}$'),
  recorded_at_ms bigint NOT NULL CHECK(recorded_at_ms>=0),
  event_name text NOT NULL DEFAULT 'STAFF_EXECUTION_REHEARSED' CHECK(event_name='STAFF_EXECUTION_REHEARSED'),
  execution text NOT NULL DEFAULT 'NOT_AUTHORIZED' CHECK(execution='NOT_AUTHORIZED'),
  UNIQUE(actor_staff_id,idempotency_key), UNIQUE(request_id,request_version),
  FOREIGN KEY(request_id,request_version,actor_staff_id,target_staff_id,scope_key)
    REFERENCES nukhabapay.staff_access_requests(request_id,version,requester_staff_id,target_staff_id,scope_key),
  FOREIGN KEY(request_id,request_version,request_digest)
    REFERENCES nukhabapay.staff_access_requests(request_id,version,request_digest)
);

DO $schema$
DECLARE n text;
BEGIN
  FOREACH n IN ARRAY ARRAY['staff_rehearsal_decisions','staff_execution_rehearsals'] LOOP
    EXECUTE format('REVOKE ALL ON nukhabapay.%I FROM PUBLIC,nukhabapay_runtime,nukhabapay_importer,nukhabapay_identity_reader,nukhabapay_identity_writer',n);
    EXECUTE format('ALTER TABLE nukhabapay.%I ENABLE ROW LEVEL SECURITY',n);
    EXECUTE format('ALTER TABLE nukhabapay.%I FORCE ROW LEVEL SECURITY',n);
    EXECUTE format('CREATE POLICY rehearsal_scope ON nukhabapay.%I USING(scope_key=current_setting(''nukhabapay.workflow_scope'',true)) WITH CHECK(scope_key=current_setting(''nukhabapay.workflow_scope'',true))',n);
    EXECUTE format('CREATE TRIGGER rehearsal_immutable BEFORE UPDATE OR DELETE ON nukhabapay.%I FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_security_audit_mutation()',n);
  END LOOP;
END
$schema$;
