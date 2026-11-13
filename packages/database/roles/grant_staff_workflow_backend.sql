-- Owner-operated bootstrap only, inside BEGIN/COMMIT on a verified disposable target.
-- Set LOCAL nukhabapay.workflow_backend_role to an already provisioned restricted login.
-- Optional LOCAL nukhabapay.workflow_provenance_mode = LOCAL_SYNTHETIC_ONLY.
-- These settings select grants; they never authenticate a human or authorize APPLY.
SET LOCAL search_path=pg_catalog;
DO $grants$
DECLARE backend text:=current_setting('nukhabapay.workflow_backend_role',true);
        provenance text:=COALESCE(NULLIF(current_setting('nukhabapay.workflow_provenance_mode',true),''),'off');
        target text; policy_name text; columns text; relation text;
BEGIN
 IF current_database() !~ '^nukhabapay_b3b[23]_[0-9a-f]{32}$' OR
   COALESCE(host(inet_server_addr()),'') NOT IN ('127.0.0.1','::1') OR inet_server_port()<>5432 OR
   NOT EXISTS(SELECT 1 FROM nukhabapay.schema_migrations WHERE name='005_staff_workflow_persistence') OR
   backend IS NULL OR backend !~ '^nukh_request_[0-9a-f]{20}$' OR provenance NOT IN ('off','LOCAL_SYNTHETIC_ONLY') THEN
   RAISE EXCEPTION 'Unapproved workflow bootstrap target or configuration' USING ERRCODE='42501';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=backend AND r.rolcanlogin AND
   NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolbypassrls) AND
   NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)) OR
   EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datname=current_database() AND pg_get_userbyid(datdba)=backend) THEN
   RAISE EXCEPTION 'Workflow backend must be a separate restricted login' USING ERRCODE='42501';
 END IF;
 EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I',current_database(),backend);
 EXECUTE format('GRANT USAGE ON SCHEMA nukhabapay TO %I',backend);
 FOREACH target IN ARRAY ARRAY['staff_request_operations','staff_access_requests','staff_review_observations','staff_request_audit','staff_request_receipts','staff_request_outbox'] LOOP
   EXECUTE format('GRANT SELECT,INSERT ON nukhabapay.%I TO %I',target,backend);
 END LOOP;
 EXECUTE format('REVOKE ALL ON nukhabapay.staff_synthetic_provenance FROM %I',backend);
 IF provenance='LOCAL_SYNTHETIC_ONLY' THEN EXECUTE format('GRANT SELECT,INSERT ON nukhabapay.staff_synthetic_provenance TO %I',backend); END IF;
 FOR relation,columns IN SELECT * FROM (VALUES
   ('staff_users','id,status,authz_version'),('staff_identities','staff_id,issuer,subject,status'),
   ('staff_memberships','id,staff_id,tenant_id,status,version'),
   ('platform_role_grants','id,staff_id,role_code,scope,granted_at,expires_at,revoked_at'),
   ('tenant_role_grants','id,membership_id,tenant_id,role_code,scope,granted_at,expires_at,revoked_at')) AS projection(name,cols) LOOP
   EXECUTE format('GRANT SELECT(%s) ON nukhabapay.%I TO %I',columns,relation,backend);
 END LOOP;
 FOREACH target IN ARRAY ARRAY['staff_memberships','tenant_role_grants'] LOOP
   policy_name:='workflow_'||target||'_'||right(backend,20);
   EXECUTE format('DROP POLICY IF EXISTS %I ON nukhabapay.%I',policy_name,target);
   EXECUTE format('CREATE POLICY %I ON nukhabapay.%I FOR SELECT TO %I USING(tenant_id::text=current_setting(''nukhabapay.tenant_id'',true))',policy_name,target,backend);
 END LOOP;
END $grants$;
