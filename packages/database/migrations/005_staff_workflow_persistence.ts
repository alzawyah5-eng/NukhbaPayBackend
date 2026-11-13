import type { MigrationBuilder } from "node-pg-migrate";

const roles = [process.env["DB_RUNTIME_ROLE"] ?? "nukhabapay_runtime", process.env["DB_IMPORT_ROLE"] ?? "nukhabapay_importer",
  process.env["DB_IDENTITY_READER_ROLE"] ?? "nukhabapay_identity_reader", process.env["DB_IDENTITY_WRITER_ROLE"] ?? "nukhabapay_identity_writer"];
if (roles.some(role => !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(role)) || new Set(roles).size !== 4) throw new Error("Invalid workflow workload role configuration");
const workloadRoles = roles.map(role => `"${role}"`).join(",");

// Frozen, self-contained promotion of ADR 0013/0016/0017 schemas. No runtime file reads.
const workflowSchema = String.raw`
DO $target$
BEGIN
  IF current_database() !~ '^nukhabapay_(db|i|cli|r|iam|b3b[23])_[0-9a-f]{32}$'
    OR COALESCE(host(inet_server_addr()),'') NOT IN ('127.0.0.1','::1') OR inet_server_port()<>5432 THEN
    RAISE EXCEPTION 'Migration 005 requires a verified local disposable target' USING ERRCODE='42501';
  END IF;
END $target$;
-- Existing object ACLs remain intact. Future owner-created objects require explicit grants.
ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM PUBLIC,__WORKLOAD_ROLES__;
ALTER DEFAULT PRIVILEGES IN SCHEMA nukhabapay REVOKE ALL ON TABLES FROM PUBLIC,__WORKLOAD_ROLES__;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON FUNCTIONS FROM PUBLIC,__WORKLOAD_ROLES__;
ALTER DEFAULT PRIVILEGES IN SCHEMA nukhabapay REVOKE ALL ON FUNCTIONS FROM PUBLIC,__WORKLOAD_ROLES__;
-- Unknown default grantees require review rather than silently acquiring artifact access.
DO $defaults$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
    WHERE d.defaclrole=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
      AND d.defaclnamespace IN (0,'nukhabapay'::regnamespace) AND d.defaclobjtype IN ('r','f') AND a.grantee<>d.defaclrole) THEN
    RAISE EXCEPTION 'Unreviewed workflow default privileges' USING ERRCODE='42501';
  END IF;
END $defaults$;
-- Compatibility records retained for the existing non-authorized recovery contracts.
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
    EXECUTE format('REVOKE ALL ON nukhabapay.%I FROM PUBLIC,__WORKLOAD_ROLES__',table_name);
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


-- Canonical versioned request and independent observation records; no staff mutation.
CREATE TABLE nukhabapay.staff_request_operations (
 operation_id text PRIMARY KEY CHECK(operation_id ~ '^[0-9a-f]{64}$'),
 actor_staff_id uuid NOT NULL REFERENCES nukhabapay.staff_users(id),
 issuer text NOT NULL CHECK(length(issuer) BETWEEN 1 AND 512), subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 512),
 idempotency_key uuid NOT NULL, intent_digest text NOT NULL CHECK(intent_digest ~ '^[0-9a-f]{64}$'),
 request_id uuid NOT NULL, request_version bigint NOT NULL CHECK(request_version BETWEEN 1 AND 1000000),
 scope_key text NOT NULL, kind text NOT NULL CHECK(kind IN ('SUBMIT','REVIEW')),
 submission_operation text GENERATED ALWAYS AS (CASE WHEN kind='SUBMIT' THEN operation_id ELSE NULL END) STORED,
 review_operation text GENERATED ALWAYS AS (CASE WHEN kind='REVIEW' THEN operation_id ELSE NULL END) STORED,
 execution text NOT NULL DEFAULT 'NOT_AUTHORIZED' CHECK(execution='NOT_AUTHORIZED'),
 event_name text GENERATED ALWAYS AS (CASE WHEN kind='SUBMIT' THEN 'SYNTHETIC_REQUEST_SUBMITTED' ELSE 'SYNTHETIC_REVIEW_OBSERVED' END) STORED,
 UNIQUE(actor_staff_id,idempotency_key), UNIQUE(operation_id,kind), UNIQUE(operation_id,scope_key), UNIQUE(operation_id,event_name),
 UNIQUE(operation_id,actor_staff_id,request_id,request_version,scope_key),
 UNIQUE(operation_id,actor_staff_id,request_id,request_version,scope_key,intent_digest)
);
CREATE TABLE nukhabapay.staff_access_requests (
 request_id uuid NOT NULL, version bigint NOT NULL CHECK(version BETWEEN 1 AND 1000000),
 previous_version bigint GENERATED ALWAYS AS (CASE WHEN version>1 THEN version-1 ELSE NULL END) STORED,
 previous_digest text, request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
 requester_staff_id uuid NOT NULL REFERENCES nukhabapay.staff_users(id), target_staff_id uuid NOT NULL,
 requester_authz_version bigint NOT NULL CHECK(requester_authz_version>=0),
 requester_authority_digest text NOT NULL CHECK(requester_authority_digest ~ '^[0-9a-f]{64}$'),
 target_authority_digest text NOT NULL CHECK(target_authority_digest ~ '^[0-9a-f]{64}$'),
 tenant_id uuid REFERENCES nukhabapay.tenants(id), scope_key text NOT NULL,
 expected_authz_version bigint NOT NULL CHECK(expected_authz_version>=0), expected_membership_version bigint,
 roles text[] NOT NULL CHECK(cardinality(roles)<=12 AND array_position(roles,NULL) IS NULL AND
   roles <@ ARRAY['GOVERNANCE_OWNER','SECURITY_ADMIN','ACCESS_ADMIN','PLATFORM_AUDITOR','TENANT_ADMIN','CATALOG_OPERATOR','CATALOG_REVIEWER','PRICING_EDITOR','PRICING_APPROVER','FINANCE_REVIEWER','SUPPORT_AGENT','TENANT_AUDITOR']::text[]),
 created_at_ms bigint NOT NULL CHECK(created_at_ms>=0), expires_at_ms bigint NOT NULL,
 policy_version text NOT NULL CHECK(policy_version='staff-lifecycle-v1'),
 state text NOT NULL DEFAULT 'SUBMITTED' CHECK(state='SUBMITTED'),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND payload->>'state'='SUBMITTED'),
 -- A CREATE intent names a future target UUID without creating a staff row.
 existing_target_staff_id uuid GENERATED ALWAYS AS
   (CASE WHEN payload->'operation'->>'kind'='CREATE' THEN NULL ELSE target_staff_id END) STORED REFERENCES nukhabapay.staff_users(id),
 CHECK(COALESCE(payload->'operation'->>'kind','')<>'CREATE' OR
   (payload @> '{"operation":{"kind":"CREATE","target":"STAFF"}}'::jsonb AND tenant_id IS NULL AND cardinality(roles)=0 AND expected_authz_version=0)),
 submission_operation text NOT NULL UNIQUE, kind text NOT NULL DEFAULT 'SUBMIT' CHECK(kind='SUBMIT'),
 execution text NOT NULL DEFAULT 'NOT_AUTHORIZED' CHECK(execution='NOT_AUTHORIZED'),
 PRIMARY KEY(request_id,version), UNIQUE(request_id,version,scope_key), UNIQUE(request_id,version,submission_operation),
 UNIQUE(request_id,version,request_digest), UNIQUE(request_id,version,requester_staff_id,target_staff_id,scope_key),
 CHECK((tenant_id IS NULL AND scope_key='PLATFORM' AND expected_membership_version IS NULL) OR
       (tenant_id IS NOT NULL AND scope_key=tenant_id::text AND expected_membership_version IS NOT NULL AND expected_membership_version>0)),
 CHECK((tenant_id IS NULL AND roles <@ ARRAY['GOVERNANCE_OWNER','SECURITY_ADMIN','ACCESS_ADMIN','PLATFORM_AUDITOR']::text[]) OR
       (tenant_id IS NOT NULL AND roles <@ ARRAY['TENANT_ADMIN','CATALOG_OPERATOR','CATALOG_REVIEWER','PRICING_EDITOR','PRICING_APPROVER','FINANCE_REVIEWER','SUPPORT_AGENT','TENANT_AUDITOR']::text[])),
 CHECK(expires_at_ms>created_at_ms AND expires_at_ms-created_at_ms<=1800000),
 CHECK((payload @> jsonb_build_object('id',request_id::text,'version',version::text,'state','SUBMITTED',
   'requesterStaffId',requester_staff_id::text,'targetStaffId',target_staff_id::text,'policyVersion',policy_version,
   'expectedAuthzVersion',expected_authz_version::text,'expectedMembershipVersion',expected_membership_version::text,
   'createdAtMs',created_at_ms,'expiresAtMs',expires_at_ms) AND payload->'proposedRoles'=to_jsonb(roles) AND
   payload->'scope'=CASE WHEN tenant_id IS NULL THEN jsonb_build_object('kind','PLATFORM') ELSE jsonb_build_object('kind','TENANT','tenantId',tenant_id::text) END) IS TRUE),
 CHECK((version=1 AND previous_digest IS NULL) OR (version>1 AND previous_digest IS NOT NULL AND previous_digest ~ '^[0-9a-f]{64}$')),
 FOREIGN KEY(submission_operation,kind) REFERENCES nukhabapay.staff_request_operations(operation_id,kind),
 FOREIGN KEY(submission_operation,requester_staff_id,request_id,version,scope_key)
   REFERENCES nukhabapay.staff_request_operations(operation_id,actor_staff_id,request_id,request_version,scope_key),
 FOREIGN KEY(request_id,previous_version,previous_digest) REFERENCES nukhabapay.staff_access_requests(request_id,version,request_digest),
 FOREIGN KEY(request_id,previous_version,requester_staff_id,target_staff_id,scope_key)
   REFERENCES nukhabapay.staff_access_requests(request_id,version,requester_staff_id,target_staff_id,scope_key)
);
CREATE TABLE nukhabapay.staff_review_observations (
 operation_id text PRIMARY KEY, request_id uuid NOT NULL, request_version bigint NOT NULL,
 reviewer_staff_id uuid NOT NULL REFERENCES nukhabapay.staff_users(id), scope_key text NOT NULL,
 request_digest text NOT NULL, reviewer_authority_digest text NOT NULL CHECK(reviewer_authority_digest ~ '^[0-9a-f]{64}$'),
 reviewer_authz_version bigint NOT NULL CHECK(reviewer_authz_version>=0), observed_at_ms bigint NOT NULL CHECK(observed_at_ms>=0),
 kind text NOT NULL DEFAULT 'REVIEW' CHECK(kind='REVIEW'),
 assurance text NOT NULL DEFAULT 'not-established' CHECK(assurance='not-established'),
 accepted_approval boolean NOT NULL DEFAULT false CHECK(accepted_approval=false),
 execution text NOT NULL DEFAULT 'NOT_AUTHORIZED' CHECK(execution='NOT_AUTHORIZED'),
 UNIQUE(request_id,request_version,reviewer_staff_id),
 FOREIGN KEY(operation_id,kind) REFERENCES nukhabapay.staff_request_operations(operation_id,kind),
 FOREIGN KEY(operation_id,reviewer_staff_id,request_id,request_version,scope_key)
   REFERENCES nukhabapay.staff_request_operations(operation_id,actor_staff_id,request_id,request_version,scope_key),
 FOREIGN KEY(request_id,request_version,scope_key) REFERENCES nukhabapay.staff_access_requests(request_id,version,scope_key),
 FOREIGN KEY(request_id,request_version,request_digest) REFERENCES nukhabapay.staff_access_requests(request_id,version,request_digest)
);
CREATE TABLE nukhabapay.staff_request_audit (
 operation_id text PRIMARY KEY, actor_staff_id uuid NOT NULL, request_id uuid NOT NULL, request_version bigint NOT NULL,
 scope_key text NOT NULL, intent_digest text NOT NULL,
 event_name text NOT NULL CHECK(event_name IN ('SYNTHETIC_REQUEST_SUBMITTED','SYNTHETIC_REVIEW_OBSERVED')),
 execution text NOT NULL DEFAULT 'NOT_AUTHORIZED' CHECK(execution='NOT_AUTHORIZED'),
 FOREIGN KEY(operation_id,event_name) REFERENCES nukhabapay.staff_request_operations(operation_id,event_name),
 FOREIGN KEY(operation_id,actor_staff_id,request_id,request_version,scope_key,intent_digest)
 REFERENCES nukhabapay.staff_request_operations(operation_id,actor_staff_id,request_id,request_version,scope_key,intent_digest)
);
CREATE TABLE nukhabapay.staff_request_receipts (
 operation_id text PRIMARY KEY REFERENCES nukhabapay.staff_request_audit(operation_id),
 scope_key text NOT NULL, outcome text NOT NULL CHECK(outcome='RECORDED_NOT_AUTHORIZED'),
 execution text NOT NULL DEFAULT 'NOT_AUTHORIZED' CHECK(execution='NOT_AUTHORIZED'),
 FOREIGN KEY(operation_id,scope_key) REFERENCES nukhabapay.staff_request_operations(operation_id,scope_key),
 UNIQUE(operation_id,scope_key)
);
CREATE TABLE nukhabapay.staff_request_outbox (
 operation_id text PRIMARY KEY, scope_key text NOT NULL,
 action text NOT NULL DEFAULT 'NO_EXTERNAL_DELIVERY' CHECK(action='NO_EXTERNAL_DELIVERY'),
 FOREIGN KEY(operation_id,scope_key) REFERENCES nukhabapay.staff_request_receipts(operation_id,scope_key)
);
ALTER TABLE nukhabapay.staff_request_operations ADD CONSTRAINT staff_request_complete
 FOREIGN KEY(operation_id) REFERENCES nukhabapay.staff_request_outbox(operation_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE nukhabapay.staff_request_operations ADD CONSTRAINT staff_request_scope
 FOREIGN KEY(request_id,request_version,scope_key) REFERENCES nukhabapay.staff_access_requests(request_id,version,scope_key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE nukhabapay.staff_request_operations ADD CONSTRAINT staff_request_submission
 FOREIGN KEY(request_id,request_version,submission_operation) REFERENCES nukhabapay.staff_access_requests(request_id,version,submission_operation) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE nukhabapay.staff_request_operations ADD CONSTRAINT staff_request_review
 FOREIGN KEY(review_operation) REFERENCES nukhabapay.staff_review_observations(operation_id) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION nukhabapay.check_synthetic_review() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE r record; o record;
BEGIN
 SELECT * INTO r FROM nukhabapay.staff_access_requests WHERE request_id=NEW.request_id AND version=NEW.request_version;
 SELECT * INTO o FROM nukhabapay.staff_request_operations WHERE operation_id=NEW.operation_id;
 IF r IS NULL OR o IS NULL OR NEW.reviewer_staff_id IN (r.requester_staff_id,r.target_staff_id) OR NEW.reviewer_staff_id<>o.actor_staff_id OR
   NEW.observed_at_ms<r.created_at_ms OR NEW.observed_at_ms>=r.expires_at_ms THEN
   RAISE EXCEPTION 'Invalid independent observation' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION nukhabapay.check_synthetic_review() FROM PUBLIC;
CREATE TRIGGER staff_review_independence BEFORE INSERT ON nukhabapay.staff_review_observations FOR EACH ROW EXECUTE FUNCTION nukhabapay.check_synthetic_review();
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['staff_request_operations','staff_access_requests','staff_review_observations','staff_request_audit','staff_request_receipts','staff_request_outbox'] LOOP
  EXECUTE format('REVOKE ALL ON nukhabapay.%I FROM PUBLIC,__WORKLOAD_ROLES__',n);
  EXECUTE format('ALTER TABLE nukhabapay.%I ENABLE ROW LEVEL SECURITY',n);
  EXECUTE format('ALTER TABLE nukhabapay.%I FORCE ROW LEVEL SECURITY',n);
  EXECUTE format('CREATE POLICY synthetic_scope ON nukhabapay.%I USING(scope_key=current_setting(''nukhabapay.workflow_scope'',true)) WITH CHECK(scope_key=current_setting(''nukhabapay.workflow_scope'',true))',n);
  EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON nukhabapay.%I FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_security_audit_mutation()',n);
 END LOOP;
END $$;


-- Isolated synthetic evidence only. Never operational MFA or an accepted approval.
ALTER TABLE nukhabapay.staff_review_observations ADD CONSTRAINT synthetic_review_binding_uq
 UNIQUE(operation_id,request_id,request_version,reviewer_staff_id,scope_key,request_digest,reviewer_authority_digest);
ALTER TABLE nukhabapay.staff_request_operations ADD CONSTRAINT synthetic_identity_binding_uq
 UNIQUE(operation_id,actor_staff_id,issuer,subject);
CREATE TABLE nukhabapay.staff_synthetic_provenance (
 operation_id text PRIMARY KEY,
 request_id uuid NOT NULL, request_version bigint NOT NULL, reviewer_staff_id uuid NOT NULL,
 identity_issuer text NOT NULL, identity_subject text NOT NULL, scope_key text NOT NULL,
 request_digest text NOT NULL, authority_digest text NOT NULL,
 policy_version text NOT NULL CHECK(policy_version='staff-lifecycle-v1'),
 challenge_id uuid NOT NULL UNIQUE, authentication_event_id uuid NOT NULL UNIQUE,
 provider_issuer text NOT NULL CHECK(provider_issuer='https://assurance.synthetic.invalid/'),
 signing_key_id text NOT NULL CHECK(signing_key_id ~ '^[A-Za-z0-9_-]{1,80}$'),
 authenticated_at_ms bigint NOT NULL CHECK(authenticated_at_ms>=0), expires_at_ms bigint NOT NULL,
 assertion_digest text NOT NULL CHECK(assertion_digest ~ '^[0-9a-f]{64}$'),
 record_digest text NOT NULL CHECK(record_digest ~ '^[0-9a-f]{64}$'),
 binding jsonb NOT NULL CHECK(jsonb_typeof(binding)='object'),
 kind text NOT NULL DEFAULT 'SYNTHETIC_TEST_EVENT' CHECK(kind='SYNTHETIC_TEST_EVENT'),
 operational_assurance text NOT NULL DEFAULT 'not-established' CHECK(operational_assurance='not-established'),
 accepted_approval boolean NOT NULL DEFAULT false CHECK(accepted_approval=false),
 execution text NOT NULL DEFAULT 'NOT_AUTHORIZED' CHECK(execution='NOT_AUTHORIZED'),
 CHECK(expires_at_ms>authenticated_at_ms AND expires_at_ms-authenticated_at_ms<=60000),
 CHECK((binding ? 'tenantId' AND binding @> jsonb_build_object('staffId',reviewer_staff_id::text,'identityIssuer',identity_issuer,'identitySubject',identity_subject,
   'requestId',request_id::text,'requestVersion',request_version::text,'requestDigest',request_digest,'authorityDigest',authority_digest,'policyVersion',policy_version)
   AND (binding->>'tenantId'=scope_key OR (scope_key='PLATFORM' AND binding->'tenantId'='null'::jsonb))) IS TRUE),
 FOREIGN KEY(operation_id,request_id,request_version,reviewer_staff_id,scope_key,request_digest,authority_digest)
   REFERENCES nukhabapay.staff_review_observations(operation_id,request_id,request_version,reviewer_staff_id,scope_key,request_digest,reviewer_authority_digest),
 FOREIGN KEY(operation_id,reviewer_staff_id,identity_issuer,identity_subject)
   REFERENCES nukhabapay.staff_request_operations(operation_id,actor_staff_id,issuer,subject)
);
ALTER TABLE nukhabapay.staff_request_operations ADD COLUMN synthetic_provenance_id text;
ALTER TABLE nukhabapay.staff_request_operations ADD CONSTRAINT synthetic_provenance_kind
 CHECK(synthetic_provenance_id IS NULL OR (kind='REVIEW' AND synthetic_provenance_id=operation_id));
ALTER TABLE nukhabapay.staff_request_operations ADD CONSTRAINT synthetic_provenance_complete
 FOREIGN KEY(synthetic_provenance_id) REFERENCES nukhabapay.staff_synthetic_provenance(operation_id) DEFERRABLE INITIALLY DEFERRED;
REVOKE ALL ON nukhabapay.staff_synthetic_provenance FROM PUBLIC,__WORKLOAD_ROLES__;
ALTER TABLE nukhabapay.staff_synthetic_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.staff_synthetic_provenance FORCE ROW LEVEL SECURITY;
CREATE POLICY synthetic_provenance_scope ON nukhabapay.staff_synthetic_provenance
 USING(scope_key=current_setting('nukhabapay.workflow_scope',true)) WITH CHECK(scope_key=current_setting('nukhabapay.workflow_scope',true));
CREATE TRIGGER synthetic_provenance_immutable BEFORE UPDATE OR DELETE ON nukhabapay.staff_synthetic_provenance
 FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_security_audit_mutation();

REVOKE ALL ON FUNCTION nukhabapay.execute_staff_command(jsonb),nukhabapay.check_synthetic_review()
 FROM PUBLIC,__WORKLOAD_ROLES__;
`;

export function up(pgm: MigrationBuilder): void {
  pgm.sql(workflowSchema.replaceAll("__WORKLOAD_ROLES__", workloadRoles));
}

/** Immutable history is not removed by an automatic down operation. */
export function down(): never {
  throw new Error("Migration 005 automatic rollback is disabled; use a separately approved verified restore procedure");
}
