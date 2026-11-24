\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '10s';
SELECT set_config('nukhbapay.windows_directory',:'service_directory',true) AS verified_dir,
       set_config('nukhbapay.windows_oid',:'database_oid',true) AS verified_oid,
       set_config('nukhbapay.windows_cluster',:'system_identifier',true) AS verified_cluster \gset
SELECT pg_advisory_xact_lock(hashtextextended('nukhbapay_staff.windows.connect.v1',0));
DO $check$
DECLARE
  database_row pg_database%ROWTYPE;
BEGIN
  SELECT * INTO STRICT database_row FROM pg_database WHERE datname=current_database();
  IF current_database()<>'nukhbapay_staff' OR current_user<>'postgres' OR session_user<>current_user
      OR system_user IS DISTINCT FROM 'scram-sha-256:postgres'
      OR host(inet_server_addr()) IS DISTINCT FROM '127.0.0.1' OR inet_server_port() IS DISTINCT FROM 5432
      OR current_setting('server_version_num')::int/10000<>18 OR pg_is_in_recovery()
      OR lower(replace(current_setting('data_directory'),chr(92),'/'))<>
         lower(replace(current_setting('nukhbapay.windows_directory'),chr(92),'/'))
      OR database_row.oid::text<>current_setting('nukhbapay.windows_oid')
      OR (SELECT system_identifier::text FROM pg_control_system())<>current_setting('nukhbapay.windows_cluster')
      OR shobj_description(database_row.oid,'pg_database') IS DISTINCT FROM 'NukhbaPay Windows staff development v1'
      OR pg_get_userbyid(database_row.datdba)<>'nukhabapay_migrator' THEN
    RAISE EXCEPTION 'The database does not match the verified Windows target';
  END IF;
  IF (SELECT count(*) FROM pg_roles r WHERE r.rolname IN ('nukhabapay_identity_reader','nukhabapay_identity_writer')
      AND r.rolcanlogin AND NOT (r.rolsuper OR r.rolinherit OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication)
      AND NOT EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT FROM pg_namespace WHERE has_schema_privilege(r.oid,oid,'CREATE')))<>2 THEN
    RAISE EXCEPTION 'Existing IAM logins do not satisfy the restricted role contract';
  END IF;
  IF EXISTS(SELECT FROM aclexplode(coalesce(database_row.datacl,acldefault('d',database_row.datdba))) acl
      WHERE acl.grantee<>database_row.datdba AND (acl.grantee NOT IN
        ('nukhabapay_identity_reader'::regrole,'nukhabapay_identity_writer'::regrole)
        OR acl.privilege_type<>'CONNECT' OR acl.is_grantable)) THEN
    RAISE EXCEPTION 'Unexpected existing database grant';
  END IF;
END $check$;
SET LOCAL ROLE nukhabapay_migrator;
GRANT CONNECT ON DATABASE nukhbapay_staff TO nukhabapay_identity_reader,nukhabapay_identity_writer;
DO $readback$
BEGIN
  IF EXISTS(SELECT FROM pg_roles r WHERE r.rolname IN ('nukhabapay_identity_reader','nukhabapay_identity_writer')
    AND (NOT has_database_privilege(r.oid,current_database(),'CONNECT')
         OR has_database_privilege(r.oid,current_database(),'CREATE,TEMP')
         OR has_database_privilege(r.oid,current_database(),'CONNECT WITH GRANT OPTION'))) THEN
    RAISE EXCEPTION 'IAM connection permission mismatch';
  END IF;
END $readback$;
COMMIT;
