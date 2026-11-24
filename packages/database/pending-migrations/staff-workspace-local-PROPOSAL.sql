-- Explicit installation on the pinned disposable staff IAM database only.
DO $gate$
BEGIN
  IF current_database() !~ '^nukhabapay_b3b3_[0-9a-f]{32}$'
     OR inet_server_addr() IS NOT NULL
     OR current_user <> 'nukhabapay_migrator'
     OR NOT EXISTS (SELECT FROM nukhabapay.schema_migrations WHERE name='006_staff_server_sessions') THEN
    RAISE EXCEPTION 'Unapproved local staff workspace target' USING ERRCODE='42501';
  END IF;
END
$gate$;

CREATE SCHEMA nukhbapay_staff_workspace AUTHORIZATION nukhabapay_migrator;
REVOKE ALL ON SCHEMA nukhbapay_staff_workspace FROM PUBLIC;
GRANT USAGE ON SCHEMA nukhbapay_staff_workspace TO nukhabapay_identity_reader,nukhabapay_identity_writer;

CREATE TABLE nukhbapay_staff_workspace.departments (
  tenant_id uuid NOT NULL REFERENCES nukhabapay.tenants(id),
  id uuid NOT NULL,
  name text NOT NULL CHECK (name=btrim(name) AND length(name) BETWEEN 2 AND 120),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  PRIMARY KEY (tenant_id,id)
);
CREATE UNIQUE INDEX staff_workspace_department_name_uq ON nukhbapay_staff_workspace.departments(tenant_id,lower(name));

CREATE TABLE nukhbapay_staff_workspace.invitations (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  requester_id uuid NOT NULL,
  department_id uuid,
  name text NOT NULL CHECK (name=btrim(name) AND length(name) BETWEEN 2 AND 120),
  email text NOT NULL CHECK (email=lower(email) AND length(email) BETWEEN 3 AND 254),
  role_code text NOT NULL CHECK (role_code IN ('SUPPORT_AGENT','CATALOG_OPERATOR')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  state text NOT NULL DEFAULT 'SUBMITTED' CHECK (state IN ('SUBMITTED','CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT transaction_timestamp()+interval '7 days',
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (requester_id,tenant_id) REFERENCES nukhabapay.staff_memberships(staff_id,tenant_id),
  FOREIGN KEY (tenant_id,department_id) REFERENCES nukhbapay_staff_workspace.departments(tenant_id,id),
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '7 days')
);
CREATE INDEX staff_workspace_invitation_email ON nukhbapay_staff_workspace.invitations(tenant_id,email);

CREATE TABLE nukhbapay_staff_workspace.preferences (
  tenant_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  time_zone text NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 100),
  locale text NOT NULL CHECK (locale IN ('en-GB','en-US','fr-FR','ar-AE')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  PRIMARY KEY (tenant_id,staff_id),
  FOREIGN KEY (staff_id,tenant_id) REFERENCES nukhabapay.staff_memberships(staff_id,tenant_id)
);

CREATE TABLE nukhbapay_staff_workspace.activity (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  actor_id uuid NOT NULL,
  target_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('create-department','rename-department','submit-invitation','cancel-invitation','save-settings')),
  occurred_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (actor_id,tenant_id) REFERENCES nukhabapay.staff_memberships(staff_id,tenant_id)
);

DO $policies$
DECLARE table_name text;
BEGIN
  FOR table_name IN SELECT unnest(ARRAY['departments','invitations','preferences','activity']) LOOP
    EXECUTE format('ALTER TABLE nukhbapay_staff_workspace.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE nukhbapay_staff_workspace.%I FORCE ROW LEVEL SECURITY',table_name);
  END LOOP;
END
$policies$;
CREATE POLICY departments_tenant ON nukhbapay_staff_workspace.departments
  USING (tenant_id=NULLIF(current_setting('nukhabapay.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=NULLIF(current_setting('nukhabapay.tenant_id',true),'')::uuid);
CREATE POLICY invitation_read ON nukhbapay_staff_workspace.invitations FOR SELECT
  USING (tenant_id=NULLIF(current_setting('nukhabapay.tenant_id',true),'')::uuid);
CREATE POLICY invitation_owner ON nukhbapay_staff_workspace.invitations
  USING (tenant_id=NULLIF(current_setting('nukhabapay.tenant_id',true),'')::uuid
    AND requester_id=NULLIF(current_setting('nukhbapay_staff_workspace.staff_id',true),'')::uuid)
  WITH CHECK (tenant_id=NULLIF(current_setting('nukhabapay.tenant_id',true),'')::uuid
    AND requester_id=NULLIF(current_setting('nukhbapay_staff_workspace.staff_id',true),'')::uuid);
CREATE POLICY personal_preferences ON nukhbapay_staff_workspace.preferences
  USING (tenant_id=NULLIF(current_setting('nukhabapay.tenant_id',true),'')::uuid
    AND staff_id=NULLIF(current_setting('nukhbapay_staff_workspace.staff_id',true),'')::uuid)
  WITH CHECK (tenant_id=NULLIF(current_setting('nukhabapay.tenant_id',true),'')::uuid
    AND staff_id=NULLIF(current_setting('nukhbapay_staff_workspace.staff_id',true),'')::uuid);
CREATE POLICY activity_read ON nukhbapay_staff_workspace.activity FOR SELECT
  USING (tenant_id=NULLIF(current_setting('nukhabapay.tenant_id',true),'')::uuid);
CREATE POLICY activity_append ON nukhbapay_staff_workspace.activity FOR INSERT
  WITH CHECK (tenant_id=NULLIF(current_setting('nukhabapay.tenant_id',true),'')::uuid
    AND actor_id=NULLIF(current_setting('nukhbapay_staff_workspace.staff_id',true),'')::uuid);
CREATE TRIGGER staff_workspace_activity_immutable BEFORE UPDATE OR DELETE ON nukhbapay_staff_workspace.activity
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_security_audit_mutation();

REVOKE ALL ON ALL TABLES IN SCHEMA nukhbapay_staff_workspace FROM PUBLIC,nukhabapay_runtime,nukhabapay_importer;
GRANT SELECT ON ALL TABLES IN SCHEMA nukhbapay_staff_workspace TO nukhabapay_identity_reader;
GRANT SELECT,INSERT ON nukhbapay_staff_workspace.departments,nukhbapay_staff_workspace.invitations,nukhbapay_staff_workspace.preferences
  TO nukhabapay_identity_writer;
GRANT INSERT ON nukhbapay_staff_workspace.activity TO nukhabapay_identity_writer;
GRANT UPDATE(name,version) ON nukhbapay_staff_workspace.departments TO nukhabapay_identity_writer;
GRANT UPDATE(state,version) ON nukhbapay_staff_workspace.invitations TO nukhabapay_identity_writer;
GRANT UPDATE(time_zone,locale,version) ON nukhbapay_staff_workspace.preferences TO nukhabapay_identity_writer;
