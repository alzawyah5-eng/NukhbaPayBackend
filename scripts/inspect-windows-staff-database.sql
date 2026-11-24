SELECT json_build_object(
  'targetVerified',current_database()='nukhbapay_staff' AND current_user='postgres' AND session_user=current_user
    AND host(inet_server_addr())='127.0.0.1' AND inet_server_port()=5432
    AND lower(replace(current_setting('data_directory'),chr(92),'/'))=lower(replace(:'service_directory',chr(92),'/'))
    AND current_setting('server_version_num')::int/10000=18 AND NOT pg_is_in_recovery()
    AND pg_get_userbyid(d.datdba)='nukhabapay_migrator'
    AND shobj_description(d.oid,'pg_database')='NukhbaPay Windows staff development v1',
  'databaseOid',d.oid::text,'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),
  'checkedAt',clock_timestamp(),'serverVersion',current_setting('server_version_num'),
  'readerExists',to_regrole('nukhabapay_identity_reader') IS NOT NULL,
  'writerExists',to_regrole('nukhabapay_identity_writer') IS NOT NULL,
  'sessionRoleExists',to_regrole('nukhabapay_session_backend') IS NOT NULL,
  'iamInstalled',to_regclass('nukhabapay.staff_memberships') IS NOT NULL,
  'sessionsInstalled',to_regclass('nukhbapay_sessions.sessions') IS NOT NULL,
  'workspaceInstalled',to_regclass('nukhbapay_staff_workspace.departments') IS NOT NULL
) FROM pg_database d WHERE d.datname=current_database();
