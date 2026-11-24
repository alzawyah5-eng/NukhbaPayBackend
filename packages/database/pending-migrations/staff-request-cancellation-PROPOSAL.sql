-- Disposable staff-request rehearsal only. This append-only event closes the entire
-- request under the same reservation used to serialize decisions and execution.
CREATE TABLE nukhabapay.staff_request_cancellations (
  request_id uuid PRIMARY KEY,
  request_version bigint NOT NULL,
  request_digest text NOT NULL,
  requester_staff_id uuid NOT NULL,
  target_staff_id uuid NOT NULL,
  scope_key text NOT NULL,
  operation_id text NOT NULL UNIQUE CHECK(operation_id ~ '^[0-9a-f]{64}$'),
  idempotency_key uuid NOT NULL,
  cancelled_at_ms bigint NOT NULL CHECK(cancelled_at_ms >= 0),
  event_name text GENERATED ALWAYS AS ('STAFF_REQUEST_CANCELLED') STORED,
  UNIQUE (requester_staff_id,idempotency_key),
  FOREIGN KEY (request_id,request_version,request_digest)
    REFERENCES nukhabapay.staff_access_requests(request_id,version,request_digest),
  FOREIGN KEY (request_id,request_version,requester_staff_id,target_staff_id,scope_key)
    REFERENCES nukhabapay.staff_access_requests(request_id,version,requester_staff_id,target_staff_id,scope_key)
);
ALTER TABLE nukhabapay.staff_request_cancellations ENABLE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.staff_request_cancellations FORCE ROW LEVEL SECURITY;
CREATE POLICY cancellation_scope ON nukhabapay.staff_request_cancellations
  USING (scope_key=current_setting('nukhabapay.workflow_scope',true))
  WITH CHECK (scope_key=current_setting('nukhabapay.workflow_scope',true));
REVOKE ALL ON nukhabapay.staff_request_cancellations FROM PUBLIC;
CREATE TRIGGER staff_request_cancellation_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
  ON nukhabapay.staff_request_cancellations FOR EACH STATEMENT
  EXECUTE FUNCTION nukhabapay.reject_security_audit_mutation();
