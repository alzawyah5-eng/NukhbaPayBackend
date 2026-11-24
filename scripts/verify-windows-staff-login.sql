SELECT current_database()='nukhbapay_staff' AND current_user=:'expected_role' AND session_user=current_user
  AND current_user IN ('nukhabapay_identity_reader','nukhabapay_identity_writer')
  AND system_user=('scram-sha-256:'||current_user::text)
  AND host(inet_server_addr())='127.0.0.1' AND inet_server_port()=5432
  AND d.oid::text=:'database_oid' AND (SELECT system_identifier::text FROM pg_control_system())=:'system_identifier'
  AND current_setting('server_version_num')::int/10000=18 AND NOT pg_is_in_recovery()
  AND shobj_description(d.oid,'pg_database')='NukhbaPay Windows staff development v1'
  AND pg_get_userbyid(d.datdba)='nukhabapay_migrator'
  AND r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication OR r.rolinherit)
  AND NOT EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)
  AND has_database_privilege(r.oid,d.oid,'CONNECT') AND NOT has_database_privilege(r.oid,d.oid,'CREATE,TEMP')
FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database();
