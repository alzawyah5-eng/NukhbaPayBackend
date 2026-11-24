\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path=pg_catalog;
SET LOCAL password_encryption='scram-sha-256';
SELECT pg_advisory_xact_lock(hashtextextended('nukhbapay_staff.session_login.v1',0));
SELECT set_config('nukhbapay.oid',:'oid',true) AS a,set_config('nukhbapay.cluster',:'cluster',true) AS b,
  set_config('nukhbapay.candidate',:'candidate',true) AS c,set_config('nukhbapay.backup',:'backup',true) AS d,
  set_config('nukhbapay.directory',:'directory',true) AS e \gset
DO $gate$
BEGIN
  IF session_user<>'postgres' OR current_user<>session_user OR system_user IS DISTINCT FROM 'scram-sha-256:postgres'
    OR current_database()<>'nukhbapay_staff' OR host(inet_server_addr()) IS DISTINCT FROM '127.0.0.1' OR inet_server_port() IS DISTINCT FROM 5432
    OR pg_is_in_recovery() OR current_setting('server_version_num')::int/10000<>18
    OR lower(replace(current_setting('data_directory'),chr(92),'/'))<>lower(replace(current_setting('nukhbapay.directory'),chr(92),'/'))
    OR NOT EXISTS(SELECT FROM pg_database WHERE datname=current_database() AND oid::text=current_setting('nukhbapay.oid')
      AND pg_get_userbyid(datdba)='nukhabapay_migrator' AND shobj_description(oid,'pg_database')='NukhbaPay Windows staff development v1')
    OR (SELECT system_identifier::text FROM pg_control_system())<>current_setting('nukhbapay.cluster')
    OR NOT EXISTS(SELECT FROM nukhabapay.windows_staff_schema_history WHERE version=1 AND candidate_sha256=current_setting('nukhbapay.candidate')
      AND backup_sha256=current_setting('nukhbapay.backup'))
    OR NOT EXISTS(SELECT FROM pg_roles r WHERE rolname='nukhabapay_session_backend' AND rolconnlimit=4
      AND NOT(rolsuper OR rolinherit OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)
      AND NOT EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid))
    THEN RAISE EXCEPTION 'Session credential target mismatch'; END IF;
END $gate$;
SELECT NOT rolcanlogin AND rolpassword IS NULL AS needs_password FROM pg_authid WHERE rolname='nukhabapay_session_backend' \gset
\if :needs_password
\password nukhabapay_session_backend
ALTER ROLE nukhabapay_session_backend LOGIN;
\endif
DO $verify$
BEGIN
  IF NOT EXISTS(SELECT FROM pg_authid WHERE rolname='nukhabapay_session_backend' AND rolcanlogin AND rolpassword LIKE 'SCRAM-SHA-256$%')
    THEN RAISE EXCEPTION 'Session credential unavailable'; END IF;
END $verify$;
COMMIT;
