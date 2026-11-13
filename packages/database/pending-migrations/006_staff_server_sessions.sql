-- PROPOSED, UNREGISTERED 006: local synthetic acceptance only. No automatic up/down.
-- Run inside an explicit owner transaction on a verified disposable fixture.
DO $gate$
BEGIN
  IF current_database() !~ '^nukhabapay_b3b[23]_[0-9a-f]{32}$'
     OR COALESCE(host(inet_server_addr()),'') NOT IN ('127.0.0.1','::1') OR inet_server_port() IS DISTINCT FROM 5432
     OR current_user <> 'nukhabapay_migrator'
     OR NOT EXISTS (SELECT 1 FROM nukhabapay.schema_migrations WHERE name='004_staff_identity_foundation')
     OR NOT EXISTS (SELECT 1 FROM nukhabapay.schema_migrations WHERE name='005_staff_workflow_persistence') THEN
    RAISE EXCEPTION 'Unapproved disposable session target' USING ERRCODE='42501';
  END IF;
END $gate$;

-- Schema defaults are independent of table/function defaults. Reject even known
-- workloads here: no inherited CREATE/USAGE may enter the session namespace.
DO $schema_defaults$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=current_user)
      AND d.defaclobjtype='n' AND a.grantee<>d.defaclrole) THEN
    RAISE EXCEPTION 'Unreviewed default schema privileges' USING ERRCODE='42501';
  END IF;
END $schema_defaults$;

CREATE SCHEMA nukhbapay_sessions AUTHORIZATION nukhabapay_migrator;
REVOKE ALL ON SCHEMA nukhbapay_sessions FROM PUBLIC,nukhabapay_runtime,nukhabapay_importer,nukhabapay_identity_reader,nukhabapay_identity_writer;
-- Add a consistency index, not a grant or staff mutation. Registered 004 stays unchanged.
CREATE UNIQUE INDEX staff_identities_session_binding_uq ON nukhabapay.staff_identities(staff_id,issuer,subject);
CREATE TABLE nukhbapay_sessions.sessions (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
  actor_staff_id uuid NOT NULL,
  issuer text NOT NULL CHECK(length(issuer) BETWEEN 1 AND 512 AND issuer ~ '^https://[^/]+[.]invalid/'),
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
