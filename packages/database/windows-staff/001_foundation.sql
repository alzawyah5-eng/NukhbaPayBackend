-- Windows staff development v1. Executed transactionally under the database owner.
-- The runner pins the registered service directory before changing to this role.
DO $target$
DECLARE
  d pg_catalog.pg_database%ROWTYPE;
  marker text;
BEGIN
  SELECT * INTO STRICT d FROM pg_database WHERE datname=current_database();
  marker:=shobj_description(d.oid,'pg_database');
  IF current_database()<>'nukhbapay_staff' OR session_user<>'postgres' OR current_user<>'nukhabapay_migrator'
    OR pg_get_userbyid(d.datdba)<>current_user OR system_user IS DISTINCT FROM 'scram-sha-256:postgres'
    OR host(inet_server_addr()) IS DISTINCT FROM '127.0.0.1' OR pg_is_in_recovery()
    OR current_setting('server_version_num')::int/10000<>18
    OR d.oid::text IS DISTINCT FROM current_setting('nukhbapay.windows_oid')
    OR (SELECT system_identifier::text FROM pg_control_system()) IS DISTINCT FROM current_setting('nukhbapay.windows_cluster')
    OR NOT ((marker='NukhbaPay Windows staff development v1' AND inet_server_port()=5432)
         OR (marker='NukhbaPay private PG18 restore rehearsal' AND inet_server_port()>1024 AND inet_server_port() NOT IN (5432,55437)))
    OR marker IS NULL THEN RAISE EXCEPTION 'Staff schema target mismatch'; END IF;
  IF EXISTS (SELECT FROM pg_default_acl) OR to_regnamespace('nukhabapay') IS NOT NULL
    OR EXISTS(SELECT FROM pg_event_trigger) THEN RAISE EXCEPTION 'Expected empty database'; END IF;
END $target$;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE SCHEMA nukhabapay AUTHORIZATION nukhabapay_migrator;
REVOKE ALL ON SCHEMA nukhabapay FROM PUBLIC;
CREATE TABLE nukhabapay.tenants (
  id uuid PRIMARY KEY,
  tenant_key varchar(128) NOT NULL UNIQUE CHECK(tenant_key=btrim(tenant_key) AND tenant_key<>''),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
CREATE TABLE nukhabapay.windows_staff_schema_history (
  version integer PRIMARY KEY CHECK(version=1),
  candidate_sha256 text NOT NULL CHECK(candidate_sha256 ~ '^[0-9a-f]{64}$'),
  backup_sha256 text NOT NULL CHECK(backup_sha256 ~ '^[0-9a-f]{64}$'),
  issuer text NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
