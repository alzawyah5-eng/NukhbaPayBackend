DO $guard$
BEGIN
  IF current_database() !~ '^nukhabapay_effect_[0-9a-f]{32}$'
    OR host(inet_server_addr()) IS DISTINCT FROM '127.0.0.1'
    OR inet_server_port() IN (5432,55437)
    OR current_setting('nukhbapay.effective_staff_fixture',true) IS DISTINCT FROM 'isolated'
  THEN RAISE EXCEPTION 'Effective staff fixture required' USING ERRCODE='42501'; END IF;
END $guard$;

CREATE SCHEMA nukhbapay_effect_private;
REVOKE ALL ON SCHEMA nukhbapay_effect_private FROM PUBLIC;
CREATE EXTENSION pgcrypto WITH SCHEMA nukhbapay_effect_private;
CREATE TABLE nukhbapay_effect_private.signing_key (
  singleton boolean PRIMARY KEY CHECK(singleton),
  secret bytea NOT NULL CHECK(octet_length(secret)=32)
);
REVOKE ALL ON nukhbapay_effect_private.signing_key FROM PUBLIC;

CREATE TABLE nukhabapay.staff_effect_authorizations (
  event_id uuid PRIMARY KEY,
  scope_key text NOT NULL,
  expires_at_ms bigint NOT NULL,
  transaction_id bigint NOT NULL DEFAULT txid_current()
);
CREATE TABLE nukhabapay.staff_effect_decisions (
  event_id uuid PRIMARY KEY REFERENCES nukhabapay.staff_effect_authorizations(event_id),
  audit_event_id uuid NOT NULL UNIQUE REFERENCES nukhabapay.security_audit_events(id),
  idempotency_key uuid NOT NULL,
  request_id uuid NOT NULL, request_version bigint NOT NULL, request_digest text NOT NULL,
  scope_key text NOT NULL, reviewer_staff_id uuid NOT NULL REFERENCES nukhabapay.staff_users(id),
  issuer text NOT NULL, subject text NOT NULL, reviewer_authz_version bigint NOT NULL,
  authority_digest text NOT NULL, slot text NOT NULL CHECK(slot IN ('SECURITY_ADMIN','GOVERNANCE_OWNER')),
  decision text NOT NULL CHECK(decision IN ('APPROVE','REJECT')),
  decided_at_ms bigint NOT NULL, expires_at_ms bigint NOT NULL CHECK(expires_at_ms>decided_at_ms),
  UNIQUE(request_id,request_version,slot), UNIQUE(request_id,request_version,reviewer_staff_id),
  UNIQUE(reviewer_staff_id,idempotency_key),
  FOREIGN KEY(request_id,request_version,request_digest)
    REFERENCES nukhabapay.staff_access_requests(request_id,version,request_digest),
  FOREIGN KEY(request_id,request_version,scope_key)
    REFERENCES nukhabapay.staff_access_requests(request_id,version,scope_key)
);
CREATE TABLE nukhabapay.staff_effect_receipts (
  operation_id text PRIMARY KEY CHECK(operation_id ~ '^[0-9a-f]{64}$'),
  event_id uuid NOT NULL UNIQUE REFERENCES nukhabapay.staff_effect_authorizations(event_id),
  audit_event_id uuid NOT NULL UNIQUE REFERENCES nukhabapay.security_audit_events(id),
  request_id uuid NOT NULL UNIQUE, request_version bigint NOT NULL, request_digest text NOT NULL,
  scope_key text NOT NULL, requester_staff_id uuid NOT NULL, target_staff_id uuid NOT NULL,
  idempotency_key uuid NOT NULL, approval_digest text NOT NULL,
  membership_id uuid NOT NULL, membership_version bigint NOT NULL,
  UNIQUE(requester_staff_id,idempotency_key),
  FOREIGN KEY(request_id,request_version,requester_staff_id,target_staff_id,scope_key)
    REFERENCES nukhabapay.staff_access_requests(request_id,version,requester_staff_id,target_staff_id,scope_key),
  FOREIGN KEY(request_id,request_version,request_digest)
    REFERENCES nukhabapay.staff_access_requests(request_id,version,request_digest)
);

DO $policy$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['staff_effect_authorizations','staff_effect_decisions','staff_effect_receipts'] LOOP
    EXECUTE format('ALTER TABLE nukhabapay.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE nukhabapay.%I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('REVOKE ALL ON TABLE nukhabapay.%I FROM PUBLIC',name);
    EXECUTE format('CREATE POLICY staff_effect_scope ON nukhabapay.%I USING (scope_key=current_setting(''nukhabapay.workflow_scope'',true)) WITH CHECK (scope_key=current_setting(''nukhabapay.workflow_scope'',true))',name);
    EXECUTE format('CREATE TRIGGER staff_effect_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON nukhabapay.%I FOR EACH STATEMENT EXECUTE FUNCTION nukhabapay.reject_security_audit_mutation()',name);
  END LOOP;
END $policy$;

-- Bounded fixture-wide serialization. Canonical authority writers participate, as
-- do request amendments and cancellations. The try lock avoids inverted row locks.
CREATE FUNCTION nukhabapay.lock_staff_effect_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $body$
BEGIN
  IF NOT pg_try_advisory_xact_lock(38216,1)
  THEN RAISE EXCEPTION 'Staff authority transaction in progress' USING ERRCODE='40001'; END IF;
  RETURN NULL;
END $body$;
REVOKE ALL ON FUNCTION nukhabapay.lock_staff_effect_authority() FROM PUBLIC;
DO $locks$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['staff_users','staff_identities','staff_memberships','platform_role_grants',
      'tenant_role_grants','staff_access_requests','staff_request_cancellations','staff_effect_decisions'] LOOP
    EXECUTE format('CREATE TRIGGER staff_effect_authority_lock BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON nukhabapay.%I FOR EACH STATEMENT EXECUTE FUNCTION nukhabapay.lock_staff_effect_authority()',name);
  END LOOP;
END $locks$;

CREATE FUNCTION nukhabapay.check_staff_effect_cancellation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $body$
BEGIN
  IF EXISTS (SELECT 1 FROM nukhabapay.staff_effect_receipts r
    WHERE r.request_id=NEW.request_id AND r.scope_key=NEW.scope_key)
  THEN RAISE EXCEPTION 'Effective staff request already applied' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION nukhabapay.check_staff_effect_cancellation() FROM PUBLIC;
CREATE TRIGGER staff_effect_cancellation_guard BEFORE INSERT ON nukhabapay.staff_request_cancellations
FOR EACH ROW EXECUTE FUNCTION nukhabapay.check_staff_effect_cancellation();

CREATE FUNCTION nukhabapay.check_staff_effect_deadline() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $body$
BEGIN
  IF NEW.transaction_id<>txid_current() OR NEW.expires_at_ms<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint
  THEN RAISE EXCEPTION 'Staff proof expired' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION nukhabapay.check_staff_effect_deadline() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER staff_effect_deadline AFTER INSERT ON nukhabapay.staff_effect_authorizations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nukhabapay.check_staff_effect_deadline();

-- Isolated credential handoff. The pool role can call this function but cannot
-- read the signing key, append evidence directly, update IAM or own these objects.
CREATE FUNCTION nukhabapay.apply_staff_membership_effect(body text, signature text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE
  p jsonb;
  request nukhabapay.staff_access_requests%ROWTYPE;
  event uuid;
  audit uuid;
  membership uuid;
  next_version bigint;
  now_ms bigint := floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  deadline bigint;
  purpose text;
  actor uuid;
  scope uuid;
BEGIN
  IF current_database() !~ '^nukhabapay_effect_[0-9a-f]{32}$'
    OR current_setting('nukhbapay.effective_staff_fixture',true) IS DISTINCT FROM 'isolated'
    OR length(body)>4096 OR signature !~ '^[0-9a-f]{64}$'
    OR NOT EXISTS (SELECT 1 FROM nukhbapay_effect_private.signing_key
      WHERE nukhbapay_effect_private.hmac(convert_to(body,'UTF8'),secret,'sha256')=decode(signature,'hex'))
  THEN RAISE EXCEPTION 'Untrusted staff effect' USING ERRCODE='42501'; END IF;
  p := body::jsonb;
  event := (p->>'eventId')::uuid;
  scope := (p->>'tenantId')::uuid;
  actor := (p->>'staffId')::uuid;
  purpose := p->>'purpose';
  deadline := (p->>'expiresAtMs')::bigint;
  IF p->>'profile' IS DISTINCT FROM 'DISPOSABLE_STAFF_EFFECT_V1'
    OR p->>'sessionDigest' !~ '^[0-9a-f]{64}$'
    OR deadline<=now_ms OR deadline>now_ms+60000
    OR current_setting('nukhabapay.workflow_scope',true) IS DISTINCT FROM scope::text
    OR current_setting('nukhabapay.tenant_id',true) IS DISTINCT FROM scope::text
    OR NOT pg_try_advisory_xact_lock(38216,1)
    OR NOT EXISTS (SELECT 1 FROM nukhabapay.staff_users u
      JOIN nukhabapay.staff_identities i ON i.staff_id=u.id
      JOIN nukhabapay.staff_memberships m ON m.staff_id=u.id AND m.tenant_id=scope
      WHERE u.id=actor AND u.status='ACTIVE' AND i.status='ACTIVE' AND m.status='ACTIVE'
        AND i.issuer=p->>'issuer' AND i.subject=p->>'subject'
        AND (u.tokens_valid_after IS NULL OR u.tokens_valid_after<=to_timestamp((p->>'identityIssuedAtMs')::double precision/1000)))
  THEN RAISE EXCEPTION 'Staff effect context refused' USING ERRCODE='42501'; END IF;
  SELECT * INTO request FROM nukhabapay.staff_access_requests
    WHERE request_id=(p->>'requestId')::uuid AND scope_key=scope::text ORDER BY version DESC LIMIT 1;
  IF NOT FOUND OR request.version IS DISTINCT FROM (p->>'requestVersion')::bigint
    OR request.request_digest IS DISTINCT FROM p->>'requestDigest'
    OR request.target_staff_id IS DISTINCT FROM (p->>'targetStaffId')::uuid
    OR request.payload->'operation' IS DISTINCT FROM '{"kind":"SUSPEND","target":"MEMBERSHIP"}'::jsonb
    OR request.expires_at_ms<deadline
    OR EXISTS (SELECT 1 FROM nukhabapay.staff_request_cancellations WHERE request_id=request.request_id)
    OR EXISTS (SELECT 1 FROM nukhabapay.staff_effect_receipts WHERE request_id=request.request_id)
  THEN RAISE EXCEPTION 'Staff request unavailable' USING ERRCODE='42501'; END IF;
  INSERT INTO nukhabapay.staff_effect_authorizations(event_id,scope_key,expires_at_ms) VALUES(event,scope::text,deadline);
  IF purpose='DECIDE' THEN
    IF actor IN (request.requester_staff_id,request.target_staff_id) THEN
      RAISE EXCEPTION 'Staff review must be independent' USING ERRCODE='42501';
    END IF;
    IF (p->>'decisionExpiresAtMs')::bigint NOT BETWEEN deadline AND request.expires_at_ms THEN
      RAISE EXCEPTION 'Staff decision expiry refused' USING ERRCODE='42501';
    END IF;
    INSERT INTO nukhabapay.security_audit_events(occurred_at,actor_staff_id,tenant_id,action,outcome,target_type,target_id,request_id,reason_code)
    VALUES(clock_timestamp(),actor,scope,'AUTHORIZATION_DECISION','SUCCESS','AUTHORIZATION',request.request_id,request.request_id,'NONE')
    RETURNING id INTO audit;
    INSERT INTO nukhabapay.staff_effect_decisions(event_id,audit_event_id,idempotency_key,request_id,request_version,request_digest,
      scope_key,reviewer_staff_id,issuer,subject,reviewer_authz_version,authority_digest,slot,decision,decided_at_ms,expires_at_ms)
    VALUES(event,audit,(p->>'idempotencyKey')::uuid,request.request_id,request.version,request.request_digest,scope::text,
      actor,p->>'issuer',p->>'subject',(p->>'reviewerAuthzVersion')::bigint,p->>'authorityDigest',p->>'slot',p->>'decision',
      (p->>'decidedAtMs')::bigint,(p->>'decisionExpiresAtMs')::bigint);
    RETURN event;
  END IF;
  IF purpose IS DISTINCT FROM 'EXECUTE' OR actor<>request.requester_staff_id OR p->>'approvalDigest' !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'Staff effect intent refused' USING ERRCODE='42501'; END IF;
  UPDATE nukhabapay.staff_memberships m
    SET status='SUSPENDED', version=m.version+1, updated_at=clock_timestamp()
    FROM nukhabapay.staff_users u
    WHERE u.id=request.target_staff_id AND u.status='ACTIVE' AND u.authz_version=request.expected_authz_version
      AND m.tenant_id=scope AND m.staff_id=u.id AND m.status='ACTIVE' AND m.version=request.expected_membership_version
    RETURNING m.id,m.version INTO membership,next_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'Staff target changed' USING ERRCODE='42501'; END IF;
  -- Revoke every older session in the affected tenant as part of the same
  -- transaction. Unrelated memberships and platform sessions stay untouched.
  PERFORM set_config('nukhbapay_sessions.staff_id',request.target_staff_id::text,true);
  PERFORM set_config('nukhbapay_sessions.scope',scope::text,true);
  INSERT INTO nukhbapay_sessions.events(id,operation_id,session_id,actor_staff_id,scope_key,event_name,occurred_ms,reason)
  SELECT gen_random_uuid(),event,s.id,s.actor_staff_id,s.scope_key,'SESSION_REVOKED',
    floor(extract(epoch FROM clock_timestamp())*1000)::bigint,'AUTHORITY_CHANGED'
  FROM nukhbapay_sessions.sessions s
  WHERE s.tenant_id=scope AND s.actor_staff_id=request.target_staff_id AND s.membership_version<next_version
  ON CONFLICT DO NOTHING;
  INSERT INTO nukhabapay.security_audit_events(occurred_at,actor_staff_id,tenant_id,action,outcome,target_type,target_id,request_id,reason_code)
  VALUES(clock_timestamp(),actor,scope,'AUTHORIZATION_DECISION','SUCCESS','STAFF_MEMBERSHIP',membership,request.request_id,'NONE')
  RETURNING id INTO audit;
  INSERT INTO nukhabapay.staff_effect_receipts(operation_id,event_id,audit_event_id,request_id,request_version,request_digest,scope_key,
    requester_staff_id,target_staff_id,idempotency_key,approval_digest,membership_id,membership_version)
  VALUES(p->>'operationId',event,audit,request.request_id,request.version,request.request_digest,scope::text,
    actor,request.target_staff_id,(p->>'idempotencyKey')::uuid,p->>'approvalDigest',membership,next_version);
  RETURN membership;
END $body$;
REVOKE ALL ON FUNCTION nukhabapay.apply_staff_membership_effect(text,text) FROM PUBLIC;
CREATE ROLE nukh_effect_authority NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
CREATE ROLE nukh_effect_executor LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
GRANT USAGE ON SCHEMA nukhabapay TO nukh_effect_authority,nukh_effect_executor;
GRANT USAGE ON SCHEMA nukhbapay_effect_private TO nukh_effect_authority;
GRANT SELECT ON nukhbapay_effect_private.signing_key TO nukh_effect_authority;
GRANT SELECT(id,status,authz_version,tokens_valid_after) ON nukhabapay.staff_users TO nukh_effect_authority,nukh_effect_executor;
GRANT SELECT(staff_id,status,issuer,subject) ON nukhabapay.staff_identities TO nukh_effect_authority,nukh_effect_executor;
GRANT SELECT(id,staff_id,tenant_id,version,status) ON nukhabapay.staff_memberships TO nukh_effect_authority,nukh_effect_executor;
GRANT UPDATE(status,version,updated_at) ON nukhabapay.staff_memberships TO nukh_effect_authority;
GRANT SELECT(id,staff_id,role_code,scope,granted_at,expires_at,revoked_at) ON nukhabapay.platform_role_grants TO nukh_effect_executor;
GRANT SELECT(id,membership_id,tenant_id,role_code,scope,granted_at,expires_at,revoked_at) ON nukhabapay.tenant_role_grants TO nukh_effect_executor;
GRANT SELECT ON nukhabapay.staff_access_requests,nukhabapay.staff_request_cancellations,
    nukhabapay.staff_effect_decisions,nukhabapay.staff_effect_receipts TO nukh_effect_authority,nukh_effect_executor;
GRANT INSERT ON nukhabapay.staff_effect_authorizations,nukhabapay.staff_effect_decisions,nukhabapay.staff_effect_receipts TO nukh_effect_authority;
GRANT INSERT,SELECT(id) ON nukhabapay.security_audit_events TO nukh_effect_authority;
CREATE POLICY effect_membership_read ON nukhabapay.staff_memberships FOR SELECT TO nukh_effect_authority,nukh_effect_executor
  USING(tenant_id=nullif(current_setting('nukhabapay.tenant_id',true),'')::uuid);
CREATE POLICY effect_membership_change ON nukhabapay.staff_memberships FOR UPDATE TO nukh_effect_authority
  USING(tenant_id=nullif(current_setting('nukhabapay.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('nukhabapay.tenant_id',true),'')::uuid);
CREATE POLICY effect_grants_read ON nukhabapay.tenant_role_grants FOR SELECT TO nukh_effect_executor
  USING(tenant_id=nullif(current_setting('nukhabapay.tenant_id',true),'')::uuid);
CREATE POLICY effect_audit_append ON nukhabapay.security_audit_events FOR INSERT TO nukh_effect_authority
  WITH CHECK(tenant_id=nullif(current_setting('nukhabapay.tenant_id',true),'')::uuid);
CREATE POLICY effect_audit_reference ON nukhabapay.security_audit_events FOR SELECT TO nukh_effect_authority
  USING(tenant_id=nullif(current_setting('nukhabapay.tenant_id',true),'')::uuid);
ALTER FUNCTION nukhabapay.apply_staff_membership_effect(text,text) OWNER TO nukh_effect_authority;
GRANT EXECUTE ON FUNCTION nukhabapay.apply_staff_membership_effect(text,text) TO nukh_effect_executor;
