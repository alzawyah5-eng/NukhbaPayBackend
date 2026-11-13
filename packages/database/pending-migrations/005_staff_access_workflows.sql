-- Executable, transaction-scoped candidate. NOT in the automatic migration directory.
-- Only untrusted SIMULATION_ONLY artifacts are persistable. No staff execution authority.
CREATE TABLE nukhabapay.iam_workflow_proposals (
  operation_id text PRIMARY KEY CHECK(operation_id ~ '^[0-9a-f]{64}$'),
  actor_staff_id uuid NOT NULL REFERENCES nukhabapay.staff_users(id),
  target_staff_id uuid NOT NULL REFERENCES nukhabapay.staff_users(id),
  tenant_id uuid REFERENCES nukhabapay.tenants(id),
  scope_key text NOT NULL,
  idempotency_key uuid NOT NULL,
  command_digest text NOT NULL CHECK(command_digest ~ '^[0-9a-f]{64}$'),
  operation text NOT NULL CHECK(operation IN ('CREATE','ACTIVATE','SUSPEND','REVOKE','REACTIVATE','DISABLE','RECOVER')),
  audit_event_name text GENERATED ALWAYS AS ('STAFF_' || operation || '_INTENT') STORED,
  provenance text NOT NULL DEFAULT 'UNVERIFIED' CHECK(provenance='UNVERIFIED'),
  execution text NOT NULL DEFAULT 'NOT_AUTHORIZED' CHECK(execution='NOT_AUTHORIZED'),
  record_kind text NOT NULL DEFAULT 'SIMULATION_ONLY' CHECK(record_kind='SIMULATION_ONLY'),
  CHECK((tenant_id IS NULL AND scope_key='PLATFORM') OR (tenant_id IS NOT NULL AND scope_key=tenant_id::text)),
  UNIQUE(actor_staff_id,idempotency_key),
  UNIQUE(operation_id,audit_event_name),
  UNIQUE(operation_id,actor_staff_id,target_staff_id,scope_key,command_digest)
);
CREATE TABLE nukhabapay.iam_workflow_audit_intents (
  operation_id text PRIMARY KEY,
  actor_staff_id uuid NOT NULL,
  target_staff_id uuid NOT NULL,
  scope_key text NOT NULL,
  command_digest text NOT NULL,
  event_name text NOT NULL CHECK(event_name IN ('STAFF_CREATE_INTENT','STAFF_ACTIVATE_INTENT','STAFF_SUSPEND_INTENT','STAFF_REVOKE_INTENT','STAFF_REACTIVATE_INTENT','STAFF_DISABLE_INTENT','STAFF_RECOVER_INTENT')),
  execution text NOT NULL DEFAULT 'NOT_AUTHORIZED' CHECK(execution='NOT_AUTHORIZED'),
  FOREIGN KEY(operation_id,event_name) REFERENCES nukhabapay.iam_workflow_proposals(operation_id,audit_event_name),
  FOREIGN KEY(operation_id,actor_staff_id,target_staff_id,scope_key,command_digest)
    REFERENCES nukhabapay.iam_workflow_proposals(operation_id,actor_staff_id,target_staff_id,scope_key,command_digest)
);
CREATE TABLE nukhabapay.iam_workflow_receipts (
  operation_id text PRIMARY KEY REFERENCES nukhabapay.iam_workflow_audit_intents(operation_id),
  actor_staff_id uuid NOT NULL,
  target_staff_id uuid NOT NULL,
  scope_key text NOT NULL,
  command_digest text NOT NULL,
  outcome text NOT NULL CHECK(outcome='SIMULATION_RECORDED'),
  execution text NOT NULL DEFAULT 'NOT_AUTHORIZED' CHECK(execution='NOT_AUTHORIZED'),
  FOREIGN KEY(operation_id,actor_staff_id,target_staff_id,scope_key,command_digest)
    REFERENCES nukhabapay.iam_workflow_proposals(operation_id,actor_staff_id,target_staff_id,scope_key,command_digest)
);
CREATE TABLE nukhabapay.iam_workflow_outbox (
  operation_id text PRIMARY KEY REFERENCES nukhabapay.iam_workflow_receipts(operation_id),
  actor_staff_id uuid NOT NULL,
  target_staff_id uuid NOT NULL,
  scope_key text NOT NULL,
  command_digest text NOT NULL,
  action text NOT NULL CHECK(action='NO_EXTERNAL_DELIVERY'),
  execution text NOT NULL DEFAULT 'NOT_AUTHORIZED' CHECK(execution='NOT_AUTHORIZED'),
  FOREIGN KEY(operation_id,actor_staff_id,target_staff_id,scope_key,command_digest)
    REFERENCES nukhabapay.iam_workflow_proposals(operation_id,actor_staff_id,target_staff_id,scope_key,command_digest)
);
-- The deferred reverse edge makes all four records mandatory at commit.
-- Immediate forward edges enforce proposal -> audit -> receipt -> outbox order.
ALTER TABLE nukhabapay.iam_workflow_proposals ADD CONSTRAINT workflow_complete_tuple
  FOREIGN KEY(operation_id) REFERENCES nukhabapay.iam_workflow_outbox(operation_id)
  DEFERRABLE INITIALLY DEFERRED;
DO $schema$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['iam_workflow_proposals','iam_workflow_audit_intents','iam_workflow_receipts','iam_workflow_outbox'] LOOP
    EXECUTE format('REVOKE ALL ON nukhabapay.%I FROM PUBLIC,nukhabapay_runtime,nukhabapay_importer,nukhabapay_identity_reader,nukhabapay_identity_writer',table_name);
    EXECUTE format('ALTER TABLE nukhabapay.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE nukhabapay.%I FORCE ROW LEVEL SECURITY',table_name);
    -- Permission is still required; no workload receives a table grant here.
    -- Context is accidental-scope protection, never actor authentication.
    EXECUTE format('CREATE POLICY workflow_scope ON nukhabapay.%I USING (scope_key=current_setting(''nukhabapay.workflow_scope'',true)) WITH CHECK (scope_key=current_setting(''nukhabapay.workflow_scope'',true))',table_name);
    EXECUTE format('CREATE TRIGGER workflow_immutable BEFORE UPDATE OR DELETE ON nukhabapay.%I FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_security_audit_mutation()',table_name);
  END LOOP;
END $schema$;
CREATE FUNCTION nukhabapay.execute_staff_command(jsonb) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $gate$
BEGIN
  -- No UUID, JSON approval, simulation receipt or environment flag opens this gate.
  RAISE EXCEPTION 'Staff command execution blocked' USING ERRCODE='42501';
END $gate$;
REVOKE ALL ON FUNCTION nukhabapay.execute_staff_command(jsonb) FROM PUBLIC;
