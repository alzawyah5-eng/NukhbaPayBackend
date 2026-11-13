-- Additive disposable rehearsal only. Never operational MFA or an accepted approval.
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
 CHECK(binding ? 'tenantId' AND binding @> jsonb_build_object('staffId',reviewer_staff_id::text,'identityIssuer',identity_issuer,'identitySubject',identity_subject,
   'requestId',request_id::text,'requestVersion',request_version::text,'requestDigest',request_digest,'authorityDigest',authority_digest,'policyVersion',policy_version)
   AND (binding->>'tenantId'=scope_key OR (scope_key='PLATFORM' AND binding->'tenantId'='null'::jsonb))),
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
REVOKE ALL ON nukhabapay.staff_synthetic_provenance FROM PUBLIC,nukhabapay_runtime,nukhabapay_importer,nukhabapay_identity_reader,nukhabapay_identity_writer;
ALTER TABLE nukhabapay.staff_synthetic_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.staff_synthetic_provenance FORCE ROW LEVEL SECURITY;
CREATE POLICY synthetic_provenance_scope ON nukhabapay.staff_synthetic_provenance
 USING(scope_key=current_setting('nukhabapay.workflow_scope',true)) WITH CHECK(scope_key=current_setting('nukhabapay.workflow_scope',true));
CREATE TRIGGER synthetic_provenance_immutable BEFORE UPDATE OR DELETE ON nukhabapay.staff_synthetic_provenance
 FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_security_audit_mutation();
