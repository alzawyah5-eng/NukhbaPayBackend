-- Disposable-only additive rehearsal. Not registered as migration 005; no staff mutation.
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
 submission_operation text NOT NULL UNIQUE, kind text NOT NULL DEFAULT 'SUBMIT' CHECK(kind='SUBMIT'),
 execution text NOT NULL DEFAULT 'NOT_AUTHORIZED' CHECK(execution='NOT_AUTHORIZED'),
 PRIMARY KEY(request_id,version), UNIQUE(request_id,version,scope_key), UNIQUE(request_id,version,submission_operation),
 UNIQUE(request_id,version,request_digest), UNIQUE(request_id,version,requester_staff_id,target_staff_id,scope_key),
 CHECK((tenant_id IS NULL AND scope_key='PLATFORM' AND expected_membership_version IS NULL) OR
       (tenant_id IS NOT NULL AND scope_key=tenant_id::text AND expected_membership_version>0)),
 CHECK(expires_at_ms>created_at_ms AND expires_at_ms-created_at_ms<=1800000),
 CHECK(payload @> jsonb_build_object('id',request_id::text,'version',version::text,'state','SUBMITTED',
   'requesterStaffId',requester_staff_id::text,'targetStaffId',target_staff_id::text,'policyVersion',policy_version,
   'expectedAuthzVersion',expected_authz_version::text,'expectedMembershipVersion',expected_membership_version::text,
   'createdAtMs',created_at_ms,'expiresAtMs',expires_at_ms) AND payload->'proposedRoles'=to_jsonb(roles) AND
   payload->'scope'=CASE WHEN tenant_id IS NULL THEN jsonb_build_object('kind','PLATFORM') ELSE jsonb_build_object('kind','TENANT','tenantId',tenant_id::text) END),
 CHECK((version=1 AND previous_digest IS NULL) OR (version>1 AND previous_digest ~ '^[0-9a-f]{64}$')),
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
  EXECUTE format('REVOKE ALL ON nukhabapay.%I FROM PUBLIC,nukhabapay_runtime,nukhabapay_importer,nukhabapay_identity_reader,nukhabapay_identity_writer',n);
  EXECUTE format('ALTER TABLE nukhabapay.%I ENABLE ROW LEVEL SECURITY',n);
  EXECUTE format('ALTER TABLE nukhabapay.%I FORCE ROW LEVEL SECURITY',n);
  EXECUTE format('CREATE POLICY synthetic_scope ON nukhabapay.%I USING(scope_key=current_setting(''nukhabapay.workflow_scope'',true)) WITH CHECK(scope_key=current_setting(''nukhabapay.workflow_scope'',true))',n);
  EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON nukhabapay.%I FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_security_audit_mutation()',n);
 END LOOP;
END $$;
