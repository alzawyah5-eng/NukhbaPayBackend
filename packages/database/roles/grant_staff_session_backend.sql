-- PROPOSED owner-operated recipe; never called by application startup.
DO $grant$
DECLARE workload text := current_setting('nukhbapay_sessions.backend_role',true);
BEGIN
  IF current_database() !~ '^nukhabapay_b3b[23]_[0-9a-f]{32}$' OR current_user<>'nukhabapay_migrator' OR
    workload IS NULL OR workload !~ '^nukh_session_[0-9a-f]{20}$' OR NOT EXISTS(SELECT 1 FROM pg_roles r WHERE rolname=workload
      AND rolcanlogin AND NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls) AND
      NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)) THEN
    RAISE EXCEPTION 'Unapproved session workload' USING ERRCODE='42501';
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I',current_database(),workload);
  EXECUTE format('GRANT USAGE ON SCHEMA nukhbapay_sessions TO %I',workload);
  EXECUTE format('GRANT SELECT(id,token_hash,actor_staff_id,issuer,subject,tenant_id,scope_key,authz_version,membership_version,authority_digest,identity_expires_ms,created_ms,expires_ms,idle_ms,parent_id,creation_operation_id,execution,assurance) ON nukhbapay_sessions.sessions TO %I',workload);
  EXECUTE format('GRANT INSERT(id,token_hash,actor_staff_id,issuer,subject,tenant_id,authz_version,membership_version,authority_digest,identity_expires_ms,created_ms,expires_ms,idle_ms,parent_id,creation_operation_id) ON nukhbapay_sessions.sessions TO %I',workload);
  EXECUTE format('GRANT SELECT(id,operation_id,session_id,actor_staff_id,scope_key,event_name,occurred_ms,reason,execution) ON nukhbapay_sessions.events TO %I',workload);
  EXECUTE format('GRANT INSERT(id,operation_id,session_id,actor_staff_id,scope_key,event_name,occurred_ms,reason) ON nukhbapay_sessions.events TO %I',workload);
END $grant$;
