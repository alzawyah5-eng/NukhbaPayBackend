DO $guard$
BEGIN
  IF current_user <> 'nukhabapay_migrator' OR inet_server_addr() IS NOT NULL OR
     current_database() <> current_setting('nukhbapay.install_database') OR current_database() !~ '^nukhabapay_b3b3_[0-9a-f]{32}$' OR
     (SELECT oid::text FROM pg_database WHERE datname=current_database()) <> current_setting('nukhbapay.install_oid') OR
     NOT EXISTS (SELECT FROM pg_class WHERE oid='nukhbapay_staff_workspace.preferences'::regclass AND relforcerowsecurity)
  THEN RAISE EXCEPTION 'Unexpected staff contact installation target'; END IF;
END
$guard$;
ALTER TABLE nukhbapay_staff_workspace.preferences
  ADD COLUMN display_name text CHECK(display_name=btrim(display_name) AND length(display_name) BETWEEN 2 AND 120),
  ADD COLUMN work_email text CHECK(work_email=lower(work_email) AND length(work_email) BETWEEN 3 AND 254),
  ADD CHECK ((display_name IS NULL)=(work_email IS NULL));
GRANT UPDATE(display_name,work_email) ON nukhbapay_staff_workspace.preferences TO nukhabapay_identity_writer;
