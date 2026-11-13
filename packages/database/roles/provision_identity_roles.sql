\set ON_ERROR_STOP on

DO $roles$
DECLARE
  role_name text;
  role_id oid;
  role_record record;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'nukhabapay_identity_reader',
    'nukhabapay_identity_writer'
  ]
  LOOP
    SELECT oid, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolbypassrls
      INTO role_record
      FROM pg_catalog.pg_roles
      WHERE rolname = role_name;

    IF FOUND THEN
      role_id := role_record.oid;
      IF NOT role_record.rolcanlogin
        OR role_record.rolsuper
        OR role_record.rolcreatedb
        OR role_record.rolcreaterole
        OR role_record.rolinherit
        OR role_record.rolbypassrls
        OR EXISTS (
          SELECT 1
            FROM pg_catalog.pg_auth_members
            WHERE member = role_id OR roleid = role_id
        )
      THEN
        RAISE EXCEPTION 'Existing identity role % does not match the required isolated role boundary', role_name;
      END IF;
    ELSE
      EXECUTE format(
        'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
        role_name
      );
    END IF;
  END LOOP;
END
$roles$;
