-- Run with the private Windows launcher. Scope is one new database on its registered local service.
SELECT set_config('nukhbapay.registered_directory',:'registered_directory',false);
SELECT pg_advisory_lock(hashtextextended('nukhbapay_staff.windows.provision.v1',0));
DO $target$
BEGIN
  IF current_user <> 'postgres' OR session_user <> 'postgres' OR current_database() <> 'postgres'
     OR host(inet_server_addr()) IS DISTINCT FROM '127.0.0.1' OR inet_server_port() IS DISTINCT FROM 5432
     OR current_setting('server_version_num')::int / 10000 <> 18
     OR lower(replace(current_setting('data_directory'),chr(92),'/'))
        <> lower(replace(current_setting('nukhbapay.registered_directory'),chr(92),'/'))
     OR pg_is_in_recovery() THEN RAISE EXCEPTION 'Windows PostgreSQL instance mismatch'; END IF;
  IF EXISTS(SELECT FROM pg_database WHERE datname='nukhbapay_staff' AND
      (shobj_description(oid,'pg_database') IS DISTINCT FROM 'NukhbaPay Windows staff development v1'
       OR pg_get_userbyid(datdba)<>'nukhabapay_migrator'))
  THEN RAISE EXCEPTION 'Database name is already in use. Existing database preserved'; END IF;
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='nukhabapay_migrator') THEN
    CREATE ROLE nukhabapay_migrator NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS(SELECT FROM pg_roles r WHERE r.rolname='nukhabapay_migrator' AND
     (r.rolsuper OR r.rolinherit OR r.rolreplication OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls
      OR EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)))
  THEN RAISE EXCEPTION 'Existing migrator role needs operator review'; END IF;
END
$target$;
SELECT NOT EXISTS(SELECT FROM pg_database WHERE datname='nukhbapay_staff') AS create_database \gset
\if :create_database
CREATE DATABASE nukhbapay_staff WITH OWNER nukhabapay_migrator TEMPLATE template0 ALLOW_CONNECTIONS false;
BEGIN;
REVOKE ALL ON DATABASE nukhbapay_staff FROM PUBLIC;
COMMENT ON DATABASE nukhbapay_staff IS 'NukhbaPay Windows staff development v1';
ALTER DATABASE nukhbapay_staff ALLOW_CONNECTIONS true;
COMMIT;
\endif
DO $verify$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_database d WHERE d.datname='nukhbapay_staff' AND d.datallowconn
      AND pg_get_userbyid(d.datdba)='nukhabapay_migrator'
      AND NOT EXISTS(SELECT FROM aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a
        WHERE a.grantee<>d.datdba AND NOT (a.privilege_type='CONNECT' AND NOT a.is_grantable
          AND EXISTS(SELECT FROM pg_roles r WHERE r.oid=a.grantee
            AND r.rolname IN ('nukhabapay_identity_reader','nukhabapay_identity_writer')
            AND r.rolcanlogin AND NOT (r.rolsuper OR r.rolinherit OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
            AND NOT EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)))))
  THEN RAISE EXCEPTION 'Database ownership or database access differs from expected'; END IF;
END
$verify$;
SELECT oid::text AS expected_oid FROM pg_database WHERE datname='nukhbapay_staff' \gset
SELECT system_identifier::text AS expected_cluster FROM pg_control_system() \gset
\connect nukhbapay_staff
BEGIN READ ONLY;
SELECT set_config('nukhbapay.expected_oid',:'expected_oid',true),
       set_config('nukhbapay.expected_cluster',:'expected_cluster',true);
DO $readback$
BEGIN
  IF current_database()<>'nukhbapay_staff' OR host(inet_server_addr()) IS DISTINCT FROM '127.0.0.1'
     OR inet_server_port() IS DISTINCT FROM 5432
     OR (SELECT oid::text FROM pg_database WHERE datname=current_database())<>current_setting('nukhbapay.expected_oid')
     OR (SELECT system_identifier::text FROM pg_control_system())<>current_setting('nukhbapay.expected_cluster')
     THEN RAISE EXCEPTION 'Persistent database readback did not match'; END IF;
END
$readback$;
SELECT datname AS database,oid AS database_oid,pg_get_userbyid(datdba) AS owner,
       to_regclass('nukhabapay.staff_memberships') IS NOT NULL AS has_staff_memberships,
       to_regclass('nukhbapay_sessions.sessions') IS NOT NULL AS has_staff_sessions
FROM pg_database WHERE datname=current_database();
COMMIT;
