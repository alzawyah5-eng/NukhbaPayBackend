-- REVIEWED PROPOSAL ONLY. Not registered or invoked by startup/migration scripts.
-- Run later, in the separately authorized deployment transaction, after 004-006.
-- It adds only the connection envelope needed by the existing restricted IAM roles.
DO $grant$
DECLARE
  approval text := current_setting('nukhbapay.persistent_grant_approval',true);
  owner_id oid := (SELECT oid FROM pg_roles WHERE rolname=current_user);
BEGIN
  IF current_user<>'nukhabapay_migrator' OR current_database()<>'nukhabapay_dev'
    OR COALESCE(host(inet_server_addr()),'') NOT IN ('127.0.0.1','::1')
    OR inet_server_port() IS DISTINCT FROM 5432
    OR COALESCE(approval,'') !~ '^IAM_CONNECT_[A-Z0-9_-]{8,48}$'
    OR NOT EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND datdba=owner_id)
    OR to_regclass('nukhabapay.staff_users') IS NULL
    OR to_regclass('nukhabapay.security_audit_events') IS NULL
    OR to_regnamespace('nukhbapay_sessions') IS NULL THEN
    RAISE EXCEPTION 'Persistent IAM connection grant rejected' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname IN ('nukhabapay_identity_reader','nukhabapay_identity_writer')
    AND (NOT r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolbypassrls
      OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)))
    OR (SELECT count(*) FROM pg_roles WHERE rolname IN ('nukhabapay_identity_reader','nukhabapay_identity_writer'))<>2 THEN
    RAISE EXCEPTION 'Persistent IAM role properties rejected' USING ERRCODE='42501';
  END IF;
  -- No role other than the owner/runtime may already possess database rights.
  IF EXISTS(SELECT 1 FROM pg_database d
    CROSS JOIN LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a LEFT JOIN pg_roles r ON r.oid=a.grantee
    WHERE d.datname=current_database() AND NOT(a.grantee=d.datdba OR
      (r.rolname='nukhabapay_runtime' AND a.privilege_type='CONNECT' AND NOT a.is_grantable))) THEN
    RAISE EXCEPTION 'Unexpected database grant' USING ERRCODE='42501';
  END IF;
  GRANT CONNECT ON DATABASE nukhabapay_dev TO nukhabapay_identity_reader,nukhabapay_identity_writer;
  GRANT USAGE ON SCHEMA nukhabapay TO nukhabapay_identity_reader,nukhabapay_identity_writer;
  IF has_database_privilege('nukhabapay_identity_reader',current_database(),'CREATE,TEMP')
    OR has_database_privilege('nukhabapay_identity_writer',current_database(),'CREATE,TEMP')
    OR has_schema_privilege('nukhabapay_identity_reader','nukhabapay','CREATE')
    OR has_schema_privilege('nukhabapay_identity_writer','nukhabapay','CREATE')
    OR has_database_privilege('nukhabapay_importer',current_database(),'CONNECT')
    OR has_schema_privilege('nukhabapay_importer','nukhabapay','USAGE') THEN
    RAISE EXCEPTION 'Persistent IAM connection grant exceeded reviewed envelope' USING ERRCODE='42501';
  END IF;
END $grant$;
