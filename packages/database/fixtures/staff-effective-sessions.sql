-- Schema projection for the verified disposable staff-effect cluster. The
-- protected migration 006 installer and its preflight are separate.
DO $guard$ BEGIN
  IF current_database() !~ '^nukhabapay_effect_[0-9a-f]{32}$'
    OR host(inet_server_addr()) IS DISTINCT FROM '127.0.0.1'
    OR inet_server_port() IN (5432,55437)
    OR current_setting('nukhbapay.effective_staff_fixture',true) IS DISTINCT FROM 'isolated'
  THEN RAISE EXCEPTION 'Effective session fixture required' USING ERRCODE='42501'; END IF;
END $guard$;
CREATE ROLE nukh_effect_session LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
CREATE SCHEMA nukhbapay_sessions;
REVOKE ALL ON SCHEMA nukhbapay_sessions FROM PUBLIC;
GRANT USAGE ON SCHEMA nukhbapay_sessions TO nukh_effect_session,nukh_effect_authority;
CREATE TABLE nukhbapay_sessions.sessions (
  id uuid PRIMARY KEY, token_hash text NOT NULL UNIQUE CHECK(token_hash~'^[0-9a-f]{64}$'),
  actor_staff_id uuid NOT NULL REFERENCES nukhabapay.staff_users(id),
  issuer text NOT NULL, subject text NOT NULL,
  tenant_id uuid REFERENCES nukhabapay.tenants(id),
  scope_key text GENERATED ALWAYS AS (coalesce(tenant_id::text,'PLATFORM')) STORED,
  authz_version bigint NOT NULL, membership_version bigint, authority_digest text NOT NULL,
  identity_expires_ms bigint NOT NULL, created_ms bigint NOT NULL, expires_ms bigint NOT NULL,
  idle_ms bigint NOT NULL, parent_id uuid REFERENCES nukhbapay_sessions.sessions(id),
  creation_operation_id uuid NOT NULL UNIQUE,
  execution text NOT NULL DEFAULT 'NOT_AUTHORIZED' CHECK(execution='NOT_AUTHORIZED'),
  assurance text NOT NULL DEFAULT 'not-established' CHECK(assurance='not-established'),
  CHECK(created_ms<expires_ms AND expires_ms<=identity_expires_ms AND idle_ms>0),
  UNIQUE(id,actor_staff_id,scope_key)
);
CREATE TABLE nukhbapay_sessions.events (
  id uuid PRIMARY KEY, operation_id uuid NOT NULL, session_id uuid NOT NULL,
  actor_staff_id uuid NOT NULL, scope_key text NOT NULL, event_name text NOT NULL,
  occurred_ms bigint NOT NULL, reason text NOT NULL,
  execution text NOT NULL DEFAULT 'NOT_AUTHORIZED' CHECK(execution='NOT_AUTHORIZED'),
  FOREIGN KEY(session_id,actor_staff_id,scope_key) REFERENCES nukhbapay_sessions.sessions(id,actor_staff_id,scope_key),
  CHECK((event_name='SESSION_CREATED' AND reason IN ('AUTHENTICATION','CONTEXT_ROTATION')) OR
    (event_name='SESSION_USED' AND reason='VALIDATION') OR
    (event_name='SESSION_REVOKED' AND reason IN ('CONTEXT_ROTATION','LOGOUT','AUTHORITY_CHANGED'))),
  UNIQUE(operation_id,session_id,event_name)
);
CREATE UNIQUE INDEX staff_effect_single_revocation ON nukhbapay_sessions.events(session_id) WHERE event_name='SESSION_REVOKED';
DO $setup$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['sessions','events'] LOOP
    EXECUTE format('ALTER TABLE nukhbapay_sessions.%I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE nukhbapay_sessions.%I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY fixture_session_scope ON nukhbapay_sessions.%I
      USING(actor_staff_id::text=current_setting(''nukhbapay_sessions.staff_id'',true) AND scope_key=current_setting(''nukhbapay_sessions.scope'',true))
      WITH CHECK(actor_staff_id::text=current_setting(''nukhbapay_sessions.staff_id'',true) AND scope_key=current_setting(''nukhbapay_sessions.scope'',true))',relation);
    EXECUTE format('CREATE TRIGGER session_fixture_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON nukhbapay_sessions.%I
      FOR EACH STATEMENT EXECUTE FUNCTION nukhabapay.reject_security_audit_mutation()',relation);
  END LOOP;
END $setup$;
CREATE TRIGGER session_fixture_authority BEFORE INSERT ON nukhbapay_sessions.sessions
FOR EACH STATEMENT EXECUTE FUNCTION nukhabapay.lock_staff_effect_authority();
GRANT SELECT(id,token_hash,actor_staff_id,issuer,subject,tenant_id,scope_key,authz_version,membership_version,authority_digest,
  identity_expires_ms,created_ms,expires_ms,idle_ms,parent_id,creation_operation_id,execution,assurance),
  INSERT(id,token_hash,actor_staff_id,issuer,subject,tenant_id,authz_version,membership_version,authority_digest,
  identity_expires_ms,created_ms,expires_ms,idle_ms,parent_id,creation_operation_id)
ON nukhbapay_sessions.sessions TO nukh_effect_session;
GRANT SELECT(id,operation_id,session_id,actor_staff_id,scope_key,event_name,occurred_ms,reason,execution),
  INSERT(id,operation_id,session_id,actor_staff_id,scope_key,event_name,occurred_ms,reason)
ON nukhbapay_sessions.events TO nukh_effect_session;
GRANT SELECT(id,actor_staff_id,scope_key,tenant_id,membership_version) ON nukhbapay_sessions.sessions TO nukh_effect_authority;
GRANT INSERT(id,operation_id,session_id,actor_staff_id,scope_key,event_name,occurred_ms,reason)
  ON nukhbapay_sessions.events TO nukh_effect_authority;
