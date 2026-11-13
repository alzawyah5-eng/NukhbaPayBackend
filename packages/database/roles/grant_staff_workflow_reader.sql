-- Owner-operated, verified disposable bootstrap only; execute inside BEGIN/COMMIT.
-- This selects a backend login, never a human identity or permission.
SET LOCAL search_path=pg_catalog;
DO $reader$
DECLARE backend text:=current_setting('nukhabapay.workflow_reader_role',true);
BEGIN
 IF current_database() !~ '^nukhabapay_b3b3_[0-9a-f]{32}$' OR
   COALESCE(host(inet_server_addr()),'') NOT IN ('127.0.0.1','::1') OR inet_server_port()<>5432 OR
   NOT EXISTS(SELECT 1 FROM nukhabapay.schema_migrations WHERE name='005_staff_workflow_persistence') OR
   backend IS NULL OR backend !~ '^nukh_history_[0-9a-f]{20}$' THEN
   RAISE EXCEPTION 'Unapproved workflow reader target or configuration' USING ERRCODE='42501';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=backend AND r.rolcanlogin AND
   NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolbypassrls) AND
   NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)) OR
   EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND pg_get_userbyid(datdba)=backend) THEN
   RAISE EXCEPTION 'Workflow reader must be a separate restricted login' USING ERRCODE='42501';
 END IF;
 EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I',current_database(),backend);
 EXECUTE format('GRANT USAGE ON SCHEMA nukhabapay TO %I',backend);
 EXECUTE format('GRANT SELECT(operation_id,actor_staff_id,request_id,request_version,scope_key,kind,execution) ON nukhabapay.staff_request_operations TO %I',backend);
 EXECUTE format('GRANT SELECT(request_id,version,requester_staff_id,target_staff_id,tenant_id,scope_key,roles,created_at_ms,expires_at_ms,policy_version,state,payload,submission_operation,execution,request_digest,previous_digest,expected_authz_version,expected_membership_version) ON nukhabapay.staff_access_requests TO %I',backend);
 EXECUTE format('GRANT SELECT(operation_id,request_id,request_version,reviewer_staff_id,scope_key,observed_at_ms,assurance,accepted_approval,execution) ON nukhabapay.staff_review_observations TO %I',backend);
END $reader$;
