-- Install inside the pinned test database, in a transaction, after the workspace schema.
DO $guard$
BEGIN
  IF current_user <> 'nukhabapay_migrator' OR inet_server_addr() IS NOT NULL OR
     current_database() <> current_setting('nukhbapay.install_database') OR
     current_database() !~ '^nukhabapay_b3b3_[0-9a-f]{32}$' OR
     (SELECT oid::text FROM pg_database WHERE datname=current_database()) <> current_setting('nukhbapay.install_oid') OR
     NOT EXISTS (SELECT FROM pg_class WHERE oid='nukhbapay_staff_workspace.departments'::regclass AND relforcerowsecurity)
  THEN RAISE EXCEPTION 'Unexpected department installation target'; END IF;
END
$guard$;

CREATE SCHEMA nukhbapay_staff_departments AUTHORIZATION nukhabapay_migrator;
REVOKE ALL ON SCHEMA nukhbapay_staff_departments FROM PUBLIC;
GRANT USAGE ON SCHEMA nukhbapay_staff_departments TO nukhabapay_identity_reader;
CREATE TABLE nukhbapay_staff_departments.directory (
  tenant_id uuid NOT NULL,
  department_id uuid NOT NULL,
  code text NOT NULL CHECK (code IN ('operations','catalogue','security','support','finance','compliance')),
  PRIMARY KEY (tenant_id,code),
  UNIQUE (tenant_id,department_id),
  FOREIGN KEY (tenant_id,department_id) REFERENCES nukhbapay_staff_workspace.departments(tenant_id,id)
);
CREATE UNIQUE INDEX staff_department_grant_tenant_uq ON nukhabapay.tenant_role_grants(tenant_id,id);
CREATE TABLE nukhbapay_staff_departments.positions (
  tenant_id uuid NOT NULL,
  department_code text NOT NULL,
  grant_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,department_code,grant_id),
  FOREIGN KEY (tenant_id,department_code) REFERENCES nukhbapay_staff_departments.directory(tenant_id,code),
  FOREIGN KEY (tenant_id,grant_id) REFERENCES nukhabapay.tenant_role_grants(tenant_id,id)
);
ALTER TABLE nukhbapay_staff_departments.directory ENABLE ROW LEVEL SECURITY;
ALTER TABLE nukhbapay_staff_departments.directory FORCE ROW LEVEL SECURITY;
ALTER TABLE nukhbapay_staff_departments.positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nukhbapay_staff_departments.positions FORCE ROW LEVEL SECURITY;
CREATE POLICY directory_scope ON nukhbapay_staff_departments.directory
  USING (tenant_id=nullif(current_setting('nukhabapay.tenant_id',true),'')::uuid);
CREATE POLICY position_scope ON nukhbapay_staff_departments.positions
  USING (tenant_id=nullif(current_setting('nukhabapay.tenant_id',true),'')::uuid AND EXISTS (
    SELECT FROM nukhabapay.tenant_role_grants g JOIN nukhabapay.staff_memberships m
      ON (m.tenant_id,m.id)=(g.tenant_id,g.membership_id)
    WHERE g.id=grant_id AND g.tenant_id=positions.tenant_id AND m.staff_id=nullif(current_setting('nukhbapay_staff_workspace.staff_id',true),'')::uuid
  ));
REVOKE ALL ON ALL TABLES IN SCHEMA nukhbapay_staff_departments FROM PUBLIC,nukhabapay_runtime,nukhabapay_identity_writer;
GRANT SELECT ON ALL TABLES IN SCHEMA nukhbapay_staff_departments TO nukhabapay_identity_reader;
-- Resolve a position against the particular grant that was approved, including after a regrant.
GRANT SELECT (id) ON nukhabapay.tenant_role_grants TO nukhabapay_identity_reader;

WITH wanted(name) AS (VALUES ('Operations'),('Catalogue'),('Security'),('Support'),('Finance'),('Compliance'))
INSERT INTO nukhbapay_staff_workspace.departments(tenant_id,id,name)
SELECT current_setting('nukhabapay.tenant_id')::uuid,gen_random_uuid(),name FROM wanted ON CONFLICT DO NOTHING;
INSERT INTO nukhbapay_staff_departments.directory(tenant_id,department_id,code)
SELECT tenant_id,id,lower(name) FROM nukhbapay_staff_workspace.departments
WHERE tenant_id=current_setting('nukhabapay.tenant_id')::uuid AND lower(name) IN ('operations','catalogue','security','support','finance','compliance');
