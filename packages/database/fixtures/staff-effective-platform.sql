-- Local platform security contract. Requires the existing private staff-effect fixture.
DO $guard$ BEGIN
  IF current_database() !~ '^nukhabapay_effect_[0-9a-f]{32}$'
    OR host(inet_server_addr()) IS DISTINCT FROM '127.0.0.1'
    OR inet_server_port()<=1024 OR inet_server_port() IN (5432,55437)
    OR current_setting('nukhbapay.effective_staff_fixture',true) IS DISTINCT FROM 'isolated'
  THEN RAISE EXCEPTION 'Platform staff fixture required' USING ERRCODE='42501'; END IF;
END $guard$;

UPDATE nukhabapay.iam_permissions SET activation_phase='3C'
WHERE code IN ('tenant.staff.read','tenant.access.request','tenant.staff.suspend','tenant.audit.read');
UPDATE nukhabapay.iam_permissions SET activation_phase='3D',description='Revoke one explicitly bound staff session.'
WHERE code='platform.sessions.revoke';
INSERT INTO nukhabapay.iam_permissions(code,scope,description,activation_phase)
VALUES('platform.sessions.revoke_all','PLATFORM','Revoke all sessions belonging to one staff identity.','3D');
INSERT INTO nukhabapay.iam_role_permissions(role_code,permission_code,scope)
VALUES('SECURITY_ADMIN','platform.sessions.revoke_all','PLATFORM');

CREATE ROLE nukh_platform_authority NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
CREATE ROLE nukh_platform_executor LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
GRANT USAGE ON SCHEMA nukhabapay TO nukh_platform_authority,nukh_platform_executor;
GRANT USAGE ON SCHEMA nukhbapay_effect_private,nukhbapay_sessions TO nukh_platform_authority;
GRANT SELECT ON nukhabapay.iam_role_permissions,nukhbapay_effect_private.signing_key TO nukh_platform_authority;
-- Populated only by the authorized disposable fixture launcher with the existing test issuer.
CREATE TABLE nukhbapay_effect_private.platform_staff_pilot_issuer (
  singleton boolean PRIMARY KEY CHECK(singleton),
  issuer text NOT NULL CHECK(issuer ~ '^https://([a-z0-9-]+[.])+[a-z]{2,}/$' AND issuer !~ '[.](invalid|test|local|localhost|example)/$')
);
REVOKE ALL ON nukhbapay_effect_private.platform_staff_pilot_issuer FROM PUBLIC;
GRANT SELECT ON nukhbapay_effect_private.platform_staff_pilot_issuer TO nukh_platform_authority;
CREATE FUNCTION nukhabapay.platform_staff_pilot_issuer_matches(candidate text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $body$
  SELECT current_database() ~ '^nukhabapay_effect_[0-9a-f]{32}$'
    AND host(inet_server_addr())='127.0.0.1' AND inet_server_port()>1024 AND inet_server_port() NOT IN (5432,55437)
    AND current_setting('nukhbapay.effective_staff_fixture',true)='isolated'
    AND EXISTS(SELECT 1 FROM nukhbapay_effect_private.platform_staff_pilot_issuer i WHERE i.issuer=candidate)
$body$;
REVOKE ALL ON FUNCTION nukhabapay.platform_staff_pilot_issuer_matches(text) FROM PUBLIC;
ALTER FUNCTION nukhabapay.platform_staff_pilot_issuer_matches(text) OWNER TO nukh_platform_authority;
GRANT EXECUTE ON FUNCTION nukhabapay.platform_staff_pilot_issuer_matches(text) TO nukh_platform_executor;
GRANT SELECT(id,staff_id,role_code,scope,granted_at,expires_at,revoked_at) ON nukhabapay.platform_role_grants TO nukh_platform_authority;
GRANT SELECT(id,status,authz_version,tokens_valid_after),UPDATE(status,authz_version,tokens_valid_after,updated_at)
ON nukhabapay.staff_users TO nukh_platform_authority;
GRANT SELECT(staff_id,issuer,subject,status) ON nukhabapay.staff_identities TO nukh_platform_authority;
GRANT INSERT ON nukhabapay.staff_effect_authorizations TO nukh_platform_authority;
GRANT INSERT,SELECT(id) ON nukhabapay.security_audit_events TO nukh_platform_authority;
CREATE POLICY platform_effect_audit_insert ON nukhabapay.security_audit_events FOR INSERT TO nukh_platform_authority WITH CHECK(tenant_id IS NULL);
CREATE POLICY platform_effect_audit_id ON nukhabapay.security_audit_events FOR SELECT TO nukh_platform_authority USING(tenant_id IS NULL);

GRANT SELECT(id,actor_staff_id,scope_key,creation_operation_id,token_hash,issuer,subject,authz_version,created_ms,expires_ms,idle_ms)
ON nukhbapay_sessions.sessions TO nukh_platform_authority;
GRANT SELECT(session_id,event_name,occurred_ms),INSERT(id,operation_id,session_id,actor_staff_id,scope_key,event_name,occurred_ms,reason)
ON nukhbapay_sessions.events TO nukh_platform_authority;
CREATE POLICY platform_staff_sessions ON nukhbapay_sessions.sessions FOR SELECT TO nukh_platform_authority
  USING(actor_staff_id::text=current_setting('nukhabapay.platform_staff_subject',true));
CREATE POLICY platform_staff_session_events ON nukhbapay_sessions.events FOR SELECT TO nukh_platform_authority
  USING(actor_staff_id::text=current_setting('nukhabapay.platform_staff_subject',true));
CREATE POLICY platform_staff_session_revoke ON nukhbapay_sessions.events FOR INSERT TO nukh_platform_authority
  WITH CHECK(actor_staff_id::text=current_setting('nukhabapay.platform_staff_subject',true)
    AND event_name='SESSION_REVOKED' AND reason='AUTHORITY_CHANGED');
CREATE FUNCTION nukhabapay.lock_platform_session_revocation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $body$
BEGIN
  IF NOT pg_try_advisory_xact_lock(38216,1)
  THEN RAISE EXCEPTION 'Staff authority transaction in progress' USING ERRCODE='40001'; END IF;
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION nukhabapay.lock_platform_session_revocation() FROM PUBLIC;
CREATE TRIGGER platform_staff_session_revocation_lock BEFORE INSERT ON nukhbapay_sessions.events FOR EACH ROW
WHEN (NEW.event_name='SESSION_REVOKED') EXECUTE FUNCTION nukhabapay.lock_platform_session_revocation();

CREATE TABLE nukhabapay.platform_staff_requests (
  id uuid NOT NULL, version bigint NOT NULL CHECK(version>0), digest text NOT NULL CHECK(digest~'^[0-9a-f]{64}$'),
  requester uuid NOT NULL REFERENCES nukhabapay.staff_users(id), target uuid NOT NULL REFERENCES nukhabapay.staff_users(id),
  command text NOT NULL CHECK(command IN ('REVOKE_SESSION','REVOKE_ALL_SESSIONS','SUSPEND_STAFF')),
  event_id uuid NOT NULL UNIQUE REFERENCES nukhabapay.staff_effect_authorizations(event_id),
  audit_id uuid NOT NULL UNIQUE REFERENCES nukhabapay.security_audit_events(id),
  request jsonb NOT NULL, expires_ms bigint NOT NULL, PRIMARY KEY(id,version), UNIQUE(id,version,digest),
  CHECK(target<>requester)
);
CREATE TABLE nukhabapay.platform_staff_decisions (
  id uuid PRIMARY KEY REFERENCES nukhabapay.staff_effect_authorizations(event_id), audit_id uuid NOT NULL UNIQUE REFERENCES nukhabapay.security_audit_events(id),
  request_id uuid NOT NULL, version bigint NOT NULL, digest text NOT NULL, reviewer uuid NOT NULL REFERENCES nukhabapay.staff_users(id),
  slot text NOT NULL CHECK(slot IN ('SECURITY_ADMIN','GOVERNANCE_OWNER')),
  decision text NOT NULL CHECK(decision IN ('APPROVE','REJECT')), grant_id uuid NOT NULL,
  reviewer_version bigint NOT NULL, issuer text NOT NULL, subject text NOT NULL, issued_ms bigint NOT NULL,
  decided_ms bigint NOT NULL, expires_ms bigint NOT NULL CHECK(expires_ms>decided_ms),
  UNIQUE(request_id,version,reviewer), UNIQUE(request_id,version,slot),
  FOREIGN KEY(request_id,version,digest) REFERENCES nukhabapay.platform_staff_requests(id,version,digest)
);
CREATE TABLE nukhabapay.platform_staff_cancellations (
  request_id uuid NOT NULL, version bigint NOT NULL, digest text NOT NULL,
  id uuid NOT NULL UNIQUE REFERENCES nukhabapay.staff_effect_authorizations(event_id),
  audit_id uuid NOT NULL UNIQUE REFERENCES nukhabapay.security_audit_events(id),
  PRIMARY KEY(request_id,version),
  FOREIGN KEY(request_id,version,digest) REFERENCES nukhabapay.platform_staff_requests(id,version,digest)
);
CREATE TABLE nukhabapay.platform_staff_receipts (
  id uuid PRIMARY KEY REFERENCES nukhabapay.staff_effect_authorizations(event_id),
  audit_id uuid NOT NULL UNIQUE REFERENCES nukhabapay.security_audit_events(id),
  request_id uuid NOT NULL UNIQUE, version bigint NOT NULL, digest text NOT NULL,
  requester uuid NOT NULL REFERENCES nukhabapay.staff_users(id), target uuid NOT NULL REFERENCES nukhabapay.staff_users(id),
  idempotency_key uuid NOT NULL, command text NOT NULL, target_binding jsonb NOT NULL, approvals uuid[] NOT NULL,
  revoked_sessions integer NOT NULL CHECK(revoked_sessions>=0), cutoff_ms bigint, applied_ms bigint NOT NULL,
  UNIQUE(requester,idempotency_key),
  FOREIGN KEY(request_id,version,digest) REFERENCES nukhabapay.platform_staff_requests(id,version,digest)
);

DO $access$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['platform_staff_requests','platform_staff_decisions','platform_staff_cancellations','platform_staff_receipts'] LOOP
    EXECUTE format('ALTER TABLE nukhabapay.%I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE nukhabapay.%I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('REVOKE ALL ON TABLE nukhabapay.%I FROM PUBLIC',relation);
    EXECUTE format('GRANT SELECT,INSERT ON TABLE nukhabapay.%I TO nukh_platform_authority',relation);
    EXECUTE format('CREATE POLICY platform_staff_fixed_scope ON nukhabapay.%I TO nukh_platform_authority
      USING(current_setting(''nukhabapay.workflow_scope'',true)=''PLATFORM'')
      WITH CHECK(current_setting(''nukhabapay.workflow_scope'',true)=''PLATFORM'')',relation);
    EXECUTE format('CREATE TRIGGER platform_staff_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON nukhabapay.%I
      FOR EACH STATEMENT EXECUTE FUNCTION nukhabapay.reject_security_audit_mutation()',relation);
  END LOOP;
END $access$;

CREATE FUNCTION nukhabapay.platform_staff_active_grant(person uuid, permission text, at_time timestamptz)
RETURNS TABLE(id uuid, role_code varchar, expires_at timestamptz)
LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $body$
  SELECT g.id,g.role_code,g.expires_at
  FROM nukhabapay.platform_role_grants g
  JOIN nukhabapay.iam_role_permissions p ON p.role_code=g.role_code AND p.scope='PLATFORM' AND p.permission_code=permission
  WHERE g.staff_id=person AND g.scope='PLATFORM' AND g.revoked_at IS NULL
    AND g.granted_at<=at_time AND (g.expires_at IS NULL OR g.expires_at>at_time)
    AND (SELECT count(DISTINCT c.role_code) FROM nukhabapay.platform_role_grants c
      WHERE c.staff_id=person AND c.scope='PLATFORM' AND c.revoked_at IS NULL
        AND c.role_code IN ('SECURITY_ADMIN','GOVERNANCE_OWNER','ACCESS_ADMIN'))<=1
$body$;
REVOKE ALL ON FUNCTION nukhabapay.platform_staff_active_grant(uuid,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nukhabapay.platform_staff_active_grant(uuid,text,timestamptz) TO nukh_platform_authority;

CREATE FUNCTION nukhabapay.apply_platform_staff_effect(body text, signature text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE
  p jsonb; proposal jsonb; binding jsonb;
  head nukhabapay.platform_staff_requests%ROWTYPE;
  receipt nukhabapay.platform_staff_receipts%ROWTYPE;
  approval nukhabapay.platform_staff_decisions%ROWTYPE;
  a uuid; beneficiary uuid; event uuid; audit uuid; req uuid; v bigint; key uuid;
  command text; action text; permission text; slot text; grant_row record;
  head_found boolean; session_row record; actor_version bigint; cutoff bigint;
  count_revoked integer := 0; approvals uuid[] := '{}'; slots text[] := '{}';
  tick timestamptz := clock_timestamp();
  tick_ms bigint := floor(extract(epoch FROM tick)*1000)::bigint;
  deadline bigint; issued bigint; grant_ms bigint; quorum integer;
BEGIN
  IF current_database() !~ '^nukhabapay_effect_[0-9a-f]{32}$'
    OR host(inet_server_addr()) IS DISTINCT FROM '127.0.0.1'
    OR inet_server_port()<=1024 OR inet_server_port() IN (5432,55437)
    OR current_setting('nukhbapay.effective_staff_fixture',true) IS DISTINCT FROM 'isolated'
    OR body IS NULL OR octet_length(body)>8192 OR signature IS NULL OR signature !~ '^[0-9a-f]{64}$'
    OR NOT EXISTS (SELECT 1 FROM nukhbapay_effect_private.signing_key
      WHERE nukhbapay_effect_private.hmac(convert_to(body,'UTF8'),secret,'sha256')=decode(signature,'hex'))
    OR NOT pg_try_advisory_xact_lock(38216,1)
  THEN RAISE EXCEPTION 'Platform staff effect refused' USING ERRCODE='42501'; END IF;

  p := body::jsonb;
  a := (p->>'actorStaffId')::uuid; beneficiary := (p->>'targetStaffId')::uuid; event := (p->>'eventId')::uuid;
  req := (p->>'requestId')::uuid; v := (p->>'requestVersion')::bigint; key := (p->>'idempotencyKey')::uuid;
  command := p->>'command'; action := p->>'action'; issued := (p->>'identityIssuedAtMs')::bigint;
  deadline := (p->>'expiresAtMs')::bigint;
  permission := CASE command WHEN 'REVOKE_SESSION' THEN 'platform.sessions.revoke'
    WHEN 'REVOKE_ALL_SESSIONS' THEN 'platform.sessions.revoke_all' WHEN 'SUSPEND_STAFF' THEN 'platform.staff.suspend' END;
  quorum := CASE command WHEN 'REVOKE_SESSION' THEN 1 ELSE 2 END;
  IF NOT (CASE p->>'profile'
      WHEN 'DISPOSABLE_PLATFORM_STAFF_EFFECT_V1' THEN coalesce(p->>'issuer' ~ '^https://[^/]+[.]invalid/$',false)
      WHEN 'AUTH0_PLATFORM_STAFF_PILOT_V1' THEN EXISTS(SELECT 1 FROM nukhbapay_effect_private.platform_staff_pilot_issuer i WHERE i.issuer=p->>'issuer')
      ELSE false END) OR p->>'scope' IS DISTINCT FROM 'PLATFORM'
    OR a IS NULL OR beneficiary IS NULL OR a=beneficiary OR req IS NULL OR v IS NULL OR v<1 OR key IS NULL OR event IS NULL
    OR p->>'requestDigest' IS NULL OR p->>'requestDigest' !~ '^[0-9a-f]{64}$'
    OR p->>'sessionDigest' IS NULL OR p->>'sessionDigest' !~ '^[0-9a-f]{64}$'
    OR issued IS NULL OR issued<0 OR issued>tick_ms OR deadline IS NULL OR deadline<=tick_ms OR deadline>tick_ms+60000
    OR permission IS NULL OR action IS NULL OR action NOT IN ('SUBMIT','APPROVE','REJECT','CANCEL','EXECUTE','LOOKUP')
  THEN RAISE EXCEPTION 'Platform command binding refused' USING ERRCODE='42501'; END IF;

  PERFORM set_config('nukhabapay.workflow_scope','PLATFORM',true);
  PERFORM set_config('nukhabapay.platform_staff_subject',a::text,true);
  SELECT u.authz_version,s.expires_ms,
    least(s.expires_ms,greatest(s.created_ms,coalesce((SELECT max(e.occurred_ms) FROM nukhbapay_sessions.events e
      WHERE e.session_id=s.id AND e.event_name='SESSION_USED'),s.created_ms))+s.idle_ms) AS session_deadline
  INTO session_row
  FROM nukhabapay.staff_users u
  JOIN nukhabapay.staff_identities i ON i.staff_id=u.id
  JOIN nukhbapay_sessions.sessions s ON s.actor_staff_id=u.id AND s.issuer=i.issuer AND s.subject=i.subject
  WHERE u.id=a AND u.status='ACTIVE' AND i.status='ACTIVE'
    AND i.issuer=p->>'issuer' AND i.subject=p->>'subject'
    AND (u.tokens_valid_after IS NULL OR u.tokens_valid_after<to_timestamp(issued::double precision/1000))
    AND s.scope_key='PLATFORM' AND s.authz_version=u.authz_version AND s.token_hash=p->>'sessionDigest'
    AND s.created_ms<=tick_ms AND EXISTS(SELECT 1 FROM nukhbapay_sessions.events e WHERE e.session_id=s.id AND e.event_name='SESSION_CREATED')
    AND NOT EXISTS(SELECT 1 FROM nukhbapay_sessions.events e WHERE e.session_id=s.id AND e.event_name='SESSION_REVOKED');
  IF NOT FOUND OR session_row.session_deadline<=tick_ms
  THEN RAISE EXCEPTION 'Current platform session required' USING ERRCODE='42501'; END IF;
  actor_version := session_row.authz_version;
  deadline := least(deadline,session_row.session_deadline);

  IF action IN ('APPROVE','REJECT') THEN
    SELECT * INTO grant_row FROM nukhabapay.platform_staff_active_grant(a,'platform.access.approve',tick);
    IF NOT FOUND AND quorum=2 THEN
      SELECT * INTO grant_row FROM nukhabapay.platform_staff_active_grant(a,'platform.access.approve_privileged',tick);
    END IF;
    slot := grant_row.role_code;
    IF slot IS NULL OR slot NOT IN ('SECURITY_ADMIN','GOVERNANCE_OWNER') OR (quorum=1 AND slot<>'SECURITY_ADMIN')
    THEN RAISE EXCEPTION 'Reviewer not eligible' USING ERRCODE='42501'; END IF;
  ELSE
    SELECT * INTO grant_row FROM nukhabapay.platform_staff_active_grant(a,permission,tick);
    IF NOT FOUND THEN RAISE EXCEPTION 'Platform permission required' USING ERRCODE='42501'; END IF;
  END IF;
  deadline := least(deadline, floor(extract(epoch FROM grant_row.expires_at)*1000)::bigint);

  SELECT * INTO head FROM nukhabapay.platform_staff_requests r WHERE r.id=req ORDER BY r.version DESC LIMIT 1;
  head_found := FOUND;
  SELECT * INTO receipt FROM nukhabapay.platform_staff_receipts r WHERE r.request_id=req OR (r.requester=a AND r.idempotency_key=key);
  IF FOUND THEN
    IF action NOT IN ('LOOKUP','EXECUTE') OR receipt.request_id<>req OR receipt.requester<>a OR receipt.target<>beneficiary
      OR receipt.command<>command OR receipt.version<>v OR receipt.digest<>p->>'requestDigest' OR receipt.idempotency_key<>key
    THEN RAISE EXCEPTION 'Conflicting platform effect' USING ERRCODE='42501'; END IF;
    INSERT INTO nukhabapay.staff_effect_authorizations(event_id,scope_key,expires_at_ms) VALUES(event,'PLATFORM',deadline);
    RETURN jsonb_build_object('kind','REPLAYED','receiptId',receipt.id,'auditId',receipt.audit_id,'revokedSessions',receipt.revoked_sessions);
  END IF;
  IF action='LOOKUP' THEN
    IF NOT head_found OR head.requester<>a OR head.target<>beneficiary OR head.command<>command OR head.version<>v OR head.digest<>p->>'requestDigest'
    THEN RAISE EXCEPTION 'Platform receipt scope refused' USING ERRCODE='42501'; END IF;
    INSERT INTO nukhabapay.staff_effect_authorizations(event_id,scope_key,expires_at_ms) VALUES(event,'PLATFORM',deadline);
    RETURN jsonb_build_object('kind','ABSENT');
  END IF;

  IF action='SUBMIT' THEN
    proposal := p->'proposal';
    IF proposal->>'scope' IS DISTINCT FROM 'PLATFORM' OR proposal->>'requesterStaffId' IS DISTINCT FROM a::text
      OR proposal->>'requesterAuthzVersion' IS DISTINCT FROM actor_version::text
      OR proposal->>'requestId' IS DISTINCT FROM req::text OR proposal->>'requestVersion' IS DISTINCT FROM v::text
      OR proposal->>'requestDigest' IS DISTINCT FROM p->>'requestDigest'
      OR (proposal->>'requestedAtMs')::bigint>tick_ms OR (proposal->>'expiresAtMs')::bigint<=tick_ms
      OR (proposal->>'expiresAtMs')::bigint-(proposal->>'requestedAtMs')::bigint>1800000
      OR (NOT head_found AND (v<>1 OR p->>'previousDigest' IS NOT NULL))
      OR (head_found AND (v<>head.version+1 OR head.digest IS DISTINCT FROM p->>'previousDigest' OR head.requester<>a
        OR head.target<>beneficiary OR head.command<>command))
    THEN RAISE EXCEPTION 'Platform request submission refused' USING ERRCODE='42501'; END IF;
  ELSE
    IF NOT head_found OR head.target<>beneficiary OR head.command<>command OR head.version<>v OR head.digest<>p->>'requestDigest'
      OR head.expires_ms<=tick_ms OR EXISTS(SELECT 1 FROM nukhabapay.platform_staff_cancellations c WHERE c.request_id=req AND c.version=v)
      OR (action IN ('EXECUTE','CANCEL') AND head.requester<>a)
      OR (action IN ('APPROVE','REJECT') AND head.requester=a)
      OR NOT EXISTS(SELECT 1 FROM nukhabapay.staff_users u WHERE u.id=head.requester AND u.status='ACTIVE'
          AND u.authz_version=(head.request->>'requesterAuthzVersion')::bigint)
      OR NOT EXISTS(SELECT 1 FROM nukhabapay.platform_staff_active_grant(head.requester,permission,tick))
    THEN RAISE EXCEPTION 'Stale or non-independent platform request' USING ERRCODE='42501'; END IF;
    proposal := head.request;
  END IF;
  deadline := least(deadline,(proposal->>'expiresAtMs')::bigint);
  binding := proposal->'target';
  IF binding->>'staffId' IS DISTINCT FROM beneficiary::text OR binding->>'kind' IS DISTINCT FROM command
    OR NOT EXISTS(SELECT 1 FROM nukhabapay.staff_users u WHERE u.id=beneficiary AND u.status='ACTIVE'
      AND u.authz_version=(binding->>'authzVersion')::bigint
      AND (command='REVOKE_SESSION' OR (floor(extract(epoch FROM u.tokens_valid_after)*1000)::bigint)
        IS NOT DISTINCT FROM (binding->>'currentCutoffMs')::bigint))
  THEN RAISE EXCEPTION 'Platform target changed' USING ERRCODE='42501'; END IF;
  PERFORM set_config('nukhabapay.platform_staff_subject',beneficiary::text,true);
  IF command='REVOKE_SESSION' AND NOT EXISTS(SELECT 1 FROM nukhbapay_sessions.sessions s
    WHERE s.id=(binding->>'sessionId')::uuid AND s.actor_staff_id=beneficiary
      AND s.creation_operation_id=(binding->>'creationOperationId')::uuid AND s.scope_key=binding->>'sessionScope'
      AND NOT EXISTS(SELECT 1 FROM nukhbapay_sessions.events e WHERE e.session_id=s.id AND e.event_name='SESSION_REVOKED'))
  THEN RAISE EXCEPTION 'Bound session unavailable' USING ERRCODE='42501'; END IF;

  IF action='EXECUTE' THEN
    FOR approval IN SELECT * FROM nukhabapay.platform_staff_decisions d WHERE d.request_id=req AND d.version=v ORDER BY d.slot LOOP
      IF approval.decision<>'APPROVE' OR approval.digest<>head.digest OR approval.reviewer IN (a,beneficiary)
        OR approval.expires_ms<=tick_ms OR NOT EXISTS (SELECT 1 FROM nukhabapay.staff_users u
          JOIN nukhabapay.staff_identities i ON i.staff_id=u.id WHERE u.id=approval.reviewer AND u.status='ACTIVE'
            AND u.authz_version=approval.reviewer_version AND i.status='ACTIVE' AND i.issuer=approval.issuer AND i.subject=approval.subject
            AND (u.tokens_valid_after IS NULL OR u.tokens_valid_after<to_timestamp(approval.issued_ms::double precision/1000)))
      THEN RAISE EXCEPTION 'Current approvals required' USING ERRCODE='42501'; END IF;
      SELECT floor(extract(epoch FROM g.expires_at)*1000)::bigint INTO grant_ms
      FROM nukhabapay.platform_staff_active_grant(approval.reviewer,
        CASE approval.slot WHEN 'SECURITY_ADMIN' THEN 'platform.access.approve' ELSE 'platform.access.approve_privileged' END,tick) g
      WHERE g.id=approval.grant_id AND g.role_code=approval.slot;
      IF NOT FOUND THEN RAISE EXCEPTION 'Reviewer grant changed' USING ERRCODE='42501'; END IF;
      approvals := array_append(approvals,approval.id);
      slots := array_append(slots,approval.slot);
      deadline := least(deadline,grant_ms,approval.expires_ms);
    END LOOP;
    IF cardinality(approvals)<>quorum OR NOT ('SECURITY_ADMIN'=ANY(slots)) OR
      (quorum=2 AND NOT ('GOVERNANCE_OWNER'=ANY(slots)))
    THEN RAISE EXCEPTION 'Platform quorum incomplete' USING ERRCODE='42501'; END IF;
  END IF;

  INSERT INTO nukhabapay.staff_effect_authorizations(event_id,scope_key,expires_at_ms) VALUES(event,'PLATFORM',deadline);
  INSERT INTO nukhabapay.security_audit_events(occurred_at,actor_staff_id,tenant_id,action,outcome,target_type,target_id,request_id,reason_code)
  VALUES(tick,a,NULL,'AUTHORIZATION_DECISION','SUCCESS',
    CASE WHEN action='EXECUTE' AND command<>'REVOKE_SESSION' THEN 'STAFF_USER' ELSE 'AUTHORIZATION' END,
    CASE WHEN action='EXECUTE' AND command='REVOKE_SESSION' THEN (binding->>'sessionId')::uuid ELSE beneficiary END,req,'NONE')
  RETURNING id INTO audit;

  IF action='SUBMIT' THEN
    INSERT INTO nukhabapay.platform_staff_requests(id,version,digest,requester,target,command,request,expires_ms,event_id,audit_id)
    VALUES(req,v,p->>'requestDigest',a,beneficiary,command,proposal,(proposal->>'expiresAtMs')::bigint,event,audit);
  ELSIF action='CANCEL' THEN
    INSERT INTO nukhabapay.platform_staff_cancellations VALUES(req,v,head.digest,event,audit);
  ELSIF action IN ('APPROVE','REJECT') THEN
    INSERT INTO nukhabapay.platform_staff_decisions
    VALUES(event,audit,req,v,head.digest,a,slot,action,grant_row.id,actor_version,p->>'issuer',p->>'subject',issued,tick_ms,
      least(head.expires_ms,floor(extract(epoch FROM grant_row.expires_at)*1000)::bigint));
  ELSE
    IF command<>'REVOKE_SESSION' THEN
      cutoff := greatest(tick_ms,(binding->>'currentCutoffMs')::bigint);
      UPDATE nukhabapay.staff_users SET authz_version=authz_version+1, tokens_valid_after=to_timestamp(cutoff::double precision/1000),
        status=CASE WHEN command='SUSPEND_STAFF' THEN 'SUSPENDED' ELSE status END,updated_at=tick
      WHERE id=beneficiary AND authz_version=(binding->>'authzVersion')::bigint AND status='ACTIVE';
      IF NOT FOUND THEN RAISE EXCEPTION 'Platform target changed' USING ERRCODE='42501'; END IF;
    END IF;
    INSERT INTO nukhbapay_sessions.events(id,operation_id,session_id,actor_staff_id,scope_key,event_name,occurred_ms,reason)
    SELECT gen_random_uuid(),event,s.id,s.actor_staff_id,s.scope_key,'SESSION_REVOKED',tick_ms,'AUTHORITY_CHANGED'
    FROM nukhbapay_sessions.sessions s
    WHERE s.actor_staff_id=beneficiary AND (command<>'REVOKE_SESSION' OR s.id=(binding->>'sessionId')::uuid)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS count_revoked=ROW_COUNT;
    IF command='REVOKE_SESSION' AND count_revoked<>1 THEN RAISE EXCEPTION 'Bound session already revoked' USING ERRCODE='42501'; END IF;
    INSERT INTO nukhabapay.platform_staff_receipts VALUES
      (event,audit,req,v,head.digest,a,beneficiary,key,command,binding,approvals,count_revoked,cutoff,tick_ms);
    RETURN jsonb_build_object('kind','APPLIED','receiptId',event,'auditId',audit,'revokedSessions',count_revoked);
  END IF;
  RETURN jsonb_build_object('kind','RECORDED');
END $body$;
REVOKE ALL ON FUNCTION nukhabapay.apply_platform_staff_effect(text,text) FROM PUBLIC;
ALTER FUNCTION nukhabapay.apply_platform_staff_effect(text,text) OWNER TO nukh_platform_authority;
GRANT EXECUTE ON FUNCTION nukhabapay.apply_platform_staff_effect(text,text) TO nukh_platform_executor;
