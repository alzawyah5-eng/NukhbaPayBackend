-- Native PostgreSQL 18 staff portal v1. Object definitions preserve the canonical
-- membership, immutable audit, session, workspace and department contracts.
-- The issuer is fixed at installation. Tenant and staff enrollment is separate.
DO $native$
BEGIN
  IF current_user<>'nukhabapay_migrator' OR session_user<>'postgres' OR current_database()<>'nukhbapay_staff'
    OR current_setting('nukhbapay.windows_oid') IS DISTINCT FROM (SELECT oid::text FROM pg_database WHERE datname=current_database())
    OR current_setting('nukhbapay.windows_cluster') IS DISTINCT FROM (SELECT system_identifier::text FROM pg_control_system())
    OR current_setting('server_version_num')::int/10000<>18 OR pg_is_in_recovery()
    OR to_regclass('nukhabapay.windows_staff_schema_history') IS NULL
    OR EXISTS(SELECT FROM nukhabapay.windows_staff_schema_history) THEN RAISE EXCEPTION 'Unprepared native foundation'; END IF;
END $native$;

GRANT SELECT(tokens_valid_after) ON nukhabapay.staff_users TO nukhabapay_identity_reader;

CREATE FUNCTION nukhabapay.advance_staff_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $body$
BEGIN
  IF NEW.id<>OLD.id OR NEW.authz_version NOT IN (OLD.authz_version,OLD.authz_version+1)
    OR (OLD.tokens_valid_after IS NOT NULL AND (NEW.tokens_valid_after IS NULL OR NEW.tokens_valid_after<OLD.tokens_valid_after)) THEN
    RAISE EXCEPTION 'Authority versions and cutoffs are monotonic' USING ERRCODE='23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.tokens_valid_after IS DISTINCT FROM OLD.tokens_valid_after
    OR NEW.authz_version<>OLD.authz_version THEN
    NEW.authz_version:=OLD.authz_version+1;
    NEW.tokens_valid_after:=greatest(OLD.tokens_valid_after,NEW.tokens_valid_after,clock_timestamp());
    NEW.updated_at:=greatest(NEW.updated_at,clock_timestamp());
  END IF;
  RETURN NEW;
END $body$;
CREATE TRIGGER staff_authority_version BEFORE UPDATE ON nukhabapay.staff_users
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.advance_staff_authority();

CREATE FUNCTION nukhabapay.advance_membership_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $body$
BEGIN
  IF ROW(NEW.id,NEW.staff_id,NEW.tenant_id) IS DISTINCT FROM ROW(OLD.id,OLD.staff_id,OLD.tenant_id)
    OR NEW.version NOT IN (OLD.version,OLD.version+1) THEN
    RAISE EXCEPTION 'Immutable membership binding or invalid version' USING ERRCODE='23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.version<>OLD.version THEN
    NEW.version:=OLD.version+1; NEW.updated_at:=greatest(NEW.updated_at,clock_timestamp());
  END IF;
  RETURN NEW;
END $body$;
CREATE TRIGGER membership_authority_version BEFORE UPDATE ON nukhabapay.staff_memberships
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.advance_membership_authority();

CREATE FUNCTION nukhabapay.propagate_staff_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $body$
DECLARE person uuid; changed integer;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Retain canonical authority history' USING ERRCODE='42501'; END IF;
  IF TG_OP='UPDATE' THEN
    CASE TG_TABLE_NAME
      WHEN 'staff_identities' THEN
        IF ROW(NEW.id,NEW.staff_id,NEW.issuer,NEW.subject) IS DISTINCT FROM ROW(OLD.id,OLD.staff_id,OLD.issuer,OLD.subject) THEN
          RAISE EXCEPTION 'Immutable identity binding' USING ERRCODE='23514'; END IF;
      WHEN 'platform_role_grants' THEN
        IF ROW(NEW.id,NEW.staff_id,NEW.role_code,NEW.scope) IS DISTINCT FROM ROW(OLD.id,OLD.staff_id,OLD.role_code,OLD.scope) THEN
          RAISE EXCEPTION 'Immutable platform grant binding' USING ERRCODE='23514'; END IF;
      WHEN 'tenant_role_grants' THEN
        IF ROW(NEW.id,NEW.membership_id,NEW.tenant_id,NEW.role_code,NEW.scope) IS DISTINCT FROM ROW(OLD.id,OLD.membership_id,OLD.tenant_id,OLD.role_code,OLD.scope) THEN
          RAISE EXCEPTION 'Immutable tenant grant binding' USING ERRCODE='23514'; END IF;
      ELSE NULL;
    END CASE;
    IF TG_TABLE_NAME IN ('platform_role_grants','tenant_role_grants') THEN
      IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS NULL OR NEW.revoked_at<OLD.revoked_at) THEN
        RAISE EXCEPTION 'Revocation cannot be undone' USING ERRCODE='23514'; END IF;
    END IF;
    IF (to_jsonb(NEW)-'updated_at') IS NOT DISTINCT FROM (to_jsonb(OLD)-'updated_at') THEN RETURN NEW; END IF;
  END IF;
  IF TG_TABLE_NAME='tenant_role_grants' THEN
    UPDATE nukhabapay.staff_memberships SET version=version+1 WHERE id=NEW.membership_id AND tenant_id=NEW.tenant_id;
  ELSE
    person:=NEW.staff_id;
    UPDATE nukhabapay.staff_users SET authz_version=authz_version+1 WHERE id=person;
  END IF;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 THEN RAISE EXCEPTION 'Authority propagation denied' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $body$;
CREATE TRIGGER identity_authority_changed BEFORE INSERT OR UPDATE OR DELETE ON nukhabapay.staff_identities
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.propagate_staff_authority();
CREATE TRIGGER membership_authority_changed BEFORE INSERT OR UPDATE OR DELETE ON nukhabapay.staff_memberships
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.propagate_staff_authority();
CREATE TRIGGER platform_grant_authority_changed BEFORE INSERT OR UPDATE OR DELETE ON nukhabapay.platform_role_grants
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.propagate_staff_authority();
CREATE TRIGGER tenant_grant_authority_changed BEFORE INSERT OR UPDATE OR DELETE ON nukhabapay.tenant_role_grants
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.propagate_staff_authority();
-- Catalog changes need an explicit future migration, not a runtime permission edit.
CREATE TRIGGER fixed_iam_roles BEFORE INSERT OR UPDATE OR DELETE ON nukhabapay.iam_roles
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_security_audit_mutation();
CREATE TRIGGER fixed_iam_permissions BEFORE INSERT OR UPDATE OR DELETE ON nukhabapay.iam_permissions
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_security_audit_mutation();
CREATE TRIGGER fixed_iam_role_permissions BEFORE INSERT OR UPDATE OR DELETE ON nukhabapay.iam_role_permissions
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_security_audit_mutation();
REVOKE ALL ON FUNCTION nukhabapay.advance_staff_authority(),nukhabapay.advance_membership_authority(),nukhabapay.propagate_staff_authority()
  FROM PUBLIC,nukhabapay_runtime,nukhabapay_importer,nukhabapay_identity_reader,nukhabapay_identity_writer;

CREATE SCHEMA nukhbapay_sessions AUTHORIZATION nukhabapay_migrator;
REVOKE ALL ON SCHEMA nukhbapay_sessions FROM PUBLIC,nukhabapay_runtime,nukhabapay_importer,nukhabapay_identity_reader,nukhabapay_identity_writer;
-- Add a consistency index, not a grant or staff mutation. Registered 004 stays unchanged.
CREATE UNIQUE INDEX staff_identities_session_binding_uq ON nukhabapay.staff_identities(staff_id,issuer,subject);
CREATE TABLE nukhbapay_sessions.sessions (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
  actor_staff_id uuid NOT NULL,
  issuer text NOT NULL CHECK(length(issuer) BETWEEN 1 AND 512),
  subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 512),
  tenant_id uuid REFERENCES nukhabapay.tenants(id),
  scope_key text GENERATED ALWAYS AS (coalesce(tenant_id::text,'PLATFORM')) STORED,
  authz_version bigint NOT NULL CHECK(authz_version>=0),
  membership_version bigint,
  authority_digest text NOT NULL CHECK(authority_digest ~ '^[0-9a-f]{64}$'),
  identity_expires_ms bigint NOT NULL,
  created_ms bigint NOT NULL CHECK(created_ms>=0),
  expires_ms bigint NOT NULL,
  idle_ms bigint NOT NULL CHECK(idle_ms BETWEEN 1 AND 900000),
  parent_id uuid UNIQUE,
  creation_operation_id uuid NOT NULL UNIQUE,
  execution text NOT NULL DEFAULT 'NOT_AUTHORIZED' CHECK(execution='NOT_AUTHORIZED'),
  assurance text NOT NULL DEFAULT 'not-established' CHECK(assurance='not-established'),
  UNIQUE(id,actor_staff_id,scope_key),
  FOREIGN KEY(actor_staff_id,issuer,subject) REFERENCES nukhabapay.staff_identities(staff_id,issuer,subject),
  FOREIGN KEY(actor_staff_id,tenant_id) REFERENCES nukhabapay.staff_memberships(staff_id,tenant_id),
  FOREIGN KEY(parent_id,actor_staff_id,scope_key) REFERENCES nukhbapay_sessions.sessions(id,actor_staff_id,scope_key),
  CHECK((tenant_id IS NULL AND membership_version IS NULL) OR (tenant_id IS NOT NULL AND membership_version IS NOT NULL AND membership_version>0)),
  CHECK(expires_ms>created_ms AND expires_ms<=created_ms+28800000 AND expires_ms<=identity_expires_ms)
);
CREATE TABLE nukhbapay_sessions.events (
  id uuid PRIMARY KEY, operation_id uuid NOT NULL,
  session_id uuid NOT NULL, actor_staff_id uuid NOT NULL, scope_key text NOT NULL,
  event_name text NOT NULL CHECK(event_name IN ('SESSION_CREATED','SESSION_USED','SESSION_REVOKED')),
  occurred_ms bigint NOT NULL CHECK(occurred_ms>=0),
  reason text NOT NULL CHECK(reason IN ('AUTHENTICATION','CONTEXT_ROTATION','VALIDATION','LOGOUT','AUTHORITY_CHANGED')),
  execution text NOT NULL DEFAULT 'NOT_AUTHORIZED' CHECK(execution='NOT_AUTHORIZED'),
  FOREIGN KEY(session_id,actor_staff_id,scope_key) REFERENCES nukhbapay_sessions.sessions(id,actor_staff_id,scope_key),
  UNIQUE(operation_id,session_id,event_name),
  CHECK((event_name='SESSION_CREATED' AND reason IN ('AUTHENTICATION','CONTEXT_ROTATION')) OR
    (event_name='SESSION_USED' AND reason='VALIDATION') OR (event_name='SESSION_REVOKED' AND reason IN ('CONTEXT_ROTATION','LOGOUT','AUTHORITY_CHANGED')))
);
CREATE UNIQUE INDEX session_single_creation ON nukhbapay_sessions.events(session_id) WHERE event_name='SESSION_CREATED';
CREATE UNIQUE INDEX session_single_revocation ON nukhbapay_sessions.events(session_id) WHERE event_name='SESSION_REVOKED';
CREATE INDEX session_event_history ON nukhbapay_sessions.events(session_id,occurred_ms);

ALTER TABLE nukhbapay_sessions.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nukhbapay_sessions.sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE nukhbapay_sessions.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE nukhbapay_sessions.events FORCE ROW LEVEL SECURITY;
CREATE POLICY session_actor_scope ON nukhbapay_sessions.sessions
  USING(actor_staff_id::text=current_setting('nukhbapay_sessions.staff_id',true) AND scope_key=current_setting('nukhbapay_sessions.scope',true))
  WITH CHECK(actor_staff_id::text=current_setting('nukhbapay_sessions.staff_id',true) AND scope_key=current_setting('nukhbapay_sessions.scope',true));
CREATE POLICY session_event_actor_scope ON nukhbapay_sessions.events
  USING(actor_staff_id::text=current_setting('nukhbapay_sessions.staff_id',true) AND scope_key=current_setting('nukhbapay_sessions.scope',true))
  WITH CHECK(actor_staff_id::text=current_setting('nukhbapay_sessions.staff_id',true) AND scope_key=current_setting('nukhbapay_sessions.scope',true));

CREATE FUNCTION nukhbapay_sessions.immutable_record() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $body$
BEGIN RAISE EXCEPTION 'Immutable session evidence' USING ERRCODE='42501'; END $body$;
CREATE TRIGGER immutable_session BEFORE UPDATE OR DELETE ON nukhbapay_sessions.sessions FOR EACH ROW EXECUTE FUNCTION nukhbapay_sessions.immutable_record();
CREATE TRIGGER immutable_session_event BEFORE UPDATE OR DELETE ON nukhbapay_sessions.events FOR EACH ROW EXECUTE FUNCTION nukhbapay_sessions.immutable_record();

CREATE FUNCTION nukhbapay_sessions.check_event() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $body$
DECLARE s nukhbapay_sessions.sessions%ROWTYPE; last_ms bigint;
BEGIN
  SELECT * INTO STRICT s FROM nukhbapay_sessions.sessions WHERE id=NEW.session_id;
  PERFORM pg_advisory_xact_lock(('x'||substr(s.token_hash,1,16))::bit(64)::bigint);
  IF NEW.occurred_ms<s.created_ms OR (NEW.event_name='SESSION_CREATED' AND
    (NEW.occurred_ms<>s.created_ms OR NEW.operation_id<>s.creation_operation_id OR
      NEW.reason<>CASE WHEN s.parent_id IS NULL THEN 'AUTHENTICATION' ELSE 'CONTEXT_ROTATION' END)) THEN
    RAISE EXCEPTION 'Invalid session event binding' USING ERRCODE='23514';
  END IF;
  IF NEW.event_name='SESSION_USED' THEN
    SELECT max(occurred_ms) INTO last_ms FROM nukhbapay_sessions.events WHERE session_id=s.id AND event_name IN ('SESSION_CREATED','SESSION_USED');
    IF last_ms IS NULL OR NEW.occurred_ms<last_ms OR NEW.occurred_ms>=last_ms+s.idle_ms OR NEW.occurred_ms>=s.expires_ms OR
      EXISTS(SELECT 1 FROM nukhbapay_sessions.events WHERE session_id=s.id AND event_name='SESSION_REVOKED') THEN
      RAISE EXCEPTION 'Inactive session' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $body$;
CREATE TRIGGER validate_session_event BEFORE INSERT ON nukhbapay_sessions.events FOR EACH ROW EXECUTE FUNCTION nukhbapay_sessions.check_event();

CREATE FUNCTION nukhbapay_sessions.check_complete_tuple() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $body$
DECLARE s nukhbapay_sessions.sessions%ROWTYPE;
BEGIN
  SELECT * INTO STRICT s FROM nukhbapay_sessions.sessions WHERE id=NEW.id;
  IF NOT EXISTS(SELECT 1 FROM nukhbapay_sessions.events WHERE session_id=s.id AND event_name='SESSION_CREATED' AND operation_id=s.creation_operation_id) OR
    (s.parent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM nukhbapay_sessions.events WHERE session_id=s.parent_id AND
      event_name='SESSION_REVOKED' AND reason='CONTEXT_ROTATION' AND operation_id=s.creation_operation_id)) THEN
    RAISE EXCEPTION 'Incomplete audited session transaction' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $body$;
CREATE CONSTRAINT TRIGGER complete_session_tuple AFTER INSERT ON nukhbapay_sessions.sessions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nukhbapay_sessions.check_complete_tuple();

CREATE FUNCTION nukhbapay_sessions.check_rotation_tuple() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $body$
BEGIN
  IF NEW.event_name='SESSION_REVOKED' AND NEW.reason='CONTEXT_ROTATION' AND
    NOT EXISTS(SELECT 1 FROM nukhbapay_sessions.sessions WHERE parent_id=NEW.session_id AND creation_operation_id=NEW.operation_id) THEN
    RAISE EXCEPTION 'Incomplete audited rotation' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $body$;
CREATE CONSTRAINT TRIGGER complete_session_rotation AFTER INSERT ON nukhbapay_sessions.events DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nukhbapay_sessions.check_rotation_tuple();

REVOKE ALL ON ALL TABLES IN SCHEMA nukhbapay_sessions FROM PUBLIC,nukhabapay_runtime,nukhabapay_importer,nukhabapay_identity_reader,nukhabapay_identity_writer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA nukhbapay_sessions FROM PUBLIC,nukhabapay_runtime,nukhabapay_importer,nukhabapay_identity_reader,nukhabapay_identity_writer;
DO $acl$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
    WHERE n.oid='nukhbapay_sessions'::regnamespace AND a.grantee<>n.nspowner) OR
    EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.relnamespace='nukhbapay_sessions'::regnamespace AND c.relkind='r' AND a.grantee<>c.relowner) OR
    EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.pronamespace='nukhbapay_sessions'::regnamespace AND a.grantee<>p.proowner) THEN
    RAISE EXCEPTION 'Unreviewed default session privileges' USING ERRCODE='42501';
  END IF;
END $acl$;

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

ALTER TABLE nukhbapay_staff_workspace.preferences
  ADD COLUMN display_name text CHECK(display_name=btrim(display_name) AND length(display_name) BETWEEN 2 AND 120),
  ADD COLUMN work_email text CHECK(work_email=lower(work_email) AND length(work_email) BETWEEN 3 AND 254),
  ADD CHECK ((display_name IS NULL)=(work_email IS NULL));
GRANT UPDATE(display_name,work_email) ON nukhbapay_staff_workspace.preferences TO nukhabapay_identity_writer;

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

-- Each login can reach only its own interface.
GRANT SELECT(id,actor_staff_id,occurred_at,action,outcome) ON nukhabapay.security_audit_events TO nukhabapay_identity_reader;
DO $issuer$
DECLARE approved text:=current_setting('nukhbapay.windows_issuer');
BEGIN
  IF approved !~ '^https://[a-z0-9-]+([.][a-z0-9-]+)*[.]auth0[.]com/$' THEN RAISE EXCEPTION 'Unexpected development issuer'; END IF;
  EXECUTE format('ALTER TABLE nukhbapay_sessions.sessions ADD CONSTRAINT windows_enrolled_issuer CHECK (issuer = %L::text)',approved);
END $issuer$;
ALTER TABLE nukhbapay_sessions.sessions ALTER COLUMN tenant_id SET NOT NULL;
GRANT CONNECT ON DATABASE nukhbapay_staff TO nukhabapay_session_backend;
GRANT USAGE ON SCHEMA nukhbapay_sessions TO nukhabapay_session_backend;
GRANT SELECT(id,token_hash,actor_staff_id,issuer,subject,tenant_id,scope_key,authz_version,membership_version,authority_digest,identity_expires_ms,created_ms,expires_ms,idle_ms,parent_id,creation_operation_id,execution,assurance),
      INSERT(id,token_hash,actor_staff_id,issuer,subject,tenant_id,authz_version,membership_version,authority_digest,identity_expires_ms,created_ms,expires_ms,idle_ms,parent_id,creation_operation_id)
      ON nukhbapay_sessions.sessions TO nukhabapay_session_backend;
GRANT SELECT(id,operation_id,session_id,actor_staff_id,scope_key,event_name,occurred_ms,reason,execution),
      INSERT(id,operation_id,session_id,actor_staff_id,scope_key,event_name,occurred_ms,reason)
      ON nukhbapay_sessions.events TO nukhabapay_session_backend;

-- The first named staff enrollment has a durable receipt and grants no application role.
CREATE TABLE nukhabapay.windows_staff_enrollments (
  tenant_id uuid PRIMARY KEY REFERENCES nukhabapay.tenants(id),
  staff_id uuid NOT NULL REFERENCES nukhabapay.staff_users(id),
  membership_id uuid NOT NULL,
  identity_id uuid NOT NULL REFERENCES nukhabapay.staff_identities(id),
  authorized_by name NOT NULL DEFAULT session_user,
  enrolled_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  FOREIGN KEY (membership_id,tenant_id) REFERENCES nukhabapay.staff_memberships(id,tenant_id),
  FOREIGN KEY (staff_id,tenant_id) REFERENCES nukhabapay.staff_memberships(staff_id,tenant_id)
);
CREATE TRIGGER immutable_windows_enrollment BEFORE UPDATE OR DELETE ON nukhabapay.windows_staff_enrollments
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_security_audit_mutation();
