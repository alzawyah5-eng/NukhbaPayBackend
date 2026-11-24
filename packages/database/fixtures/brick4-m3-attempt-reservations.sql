-- APPROVED OFFLINE LIFECYCLE EXTENSION. Unregistered fixture; no execution approval.
SELECT nukhb4_target.assert_exact_target();
DO $gate$ BEGIN IF current_user<>'nukhb4_bootstrap_5003f11512ab48a6' OR current_database() IS DISTINCT FROM __DATABASE_LITERAL__
 THEN RAISE EXCEPTION 'Unapproved reservation fixture' USING ERRCODE='42501'; END IF; END $gate$;
CREATE TABLE nukhb4_target.ai_engine_reservations(
 token uuid PRIMARY KEY,tenant_id uuid NOT NULL,job_id uuid NOT NULL REFERENCES nukhabapay.ai_jobs(id),
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 2),base_attempt integer NOT NULL CHECK(base_attempt BETWEEN 0 AND 1),
 source_digest text NOT NULL CHECK(source_digest~'^[a-f0-9]{64}$'),generation text NOT NULL CHECK(generation~'^[0-9]+[.][0-9]+$'),status text NOT NULL CHECK(status IN ('OPEN','SETTLED','QUARANTINED')),
 created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 UNIQUE(tenant_id,job_id,ordinal),CHECK(expires_at>created_at AND expires_at<=created_at+INTERVAL '14 seconds'));
CREATE TABLE nukhb4_target.ai_engine_reservation_audit(
 event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),token uuid NOT NULL REFERENCES nukhb4_target.ai_engine_reservations(token),
 tenant_id uuid NOT NULL,job_id uuid NOT NULL,ordinal integer NOT NULL,
 event text NOT NULL CHECK(event IN ('RESERVED','SETTLED','QUARANTINED','EXHAUSTED')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),write_xid xid8 NOT NULL DEFAULT pg_current_xact_id() CHECK(write_xid=pg_current_xact_id()),CONSTRAINT ai_engine_audit_once UNIQUE(token,event));
CREATE FUNCTION nukhb4_target.reserve_ai_attempt(job uuid,request_token uuid)
 RETURNS TABLE(token uuid,ordinal integer,status text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE t uuid;j nukhabapay.ai_jobs%ROWTYPE;r nukhb4_target.ai_engine_reservations%ROWTYPE;n integer;stamp text;now_at timestamptz;
BEGIN
 IF session_user IS DISTINCT FROM __RUNTIME_LITERAL__ THEN RAISE EXCEPTION 'Unapproved reservation identity' USING ERRCODE='42501'; END IF;
 t:=current_setting('nukhabapay.ai_job_tenant',true)::uuid;PERFORM nukhb4_target.lock_ai_state(t);
 SELECT * INTO j FROM nukhabapay.ai_jobs x WHERE x.id=job AND x.tenant_id=t FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT NULL::uuid,0,'DENIED'::text;RETURN;END IF;
 IF j.state IN ('SUCCEEDED','FAILED') THEN RETURN QUERY SELECT NULL::uuid,0,'TERMINAL'::text;RETURN; END IF;
 SELECT * INTO r FROM nukhb4_target.ai_engine_reservations x WHERE x.token=request_token AND x.tenant_id=t AND x.job_id=job;
 IF FOUND THEN RETURN QUERY SELECT r.token,r.ordinal,r.status;RETURN;END IF;
 IF j.state='RUNNING' OR j.attempts>=2 OR j.retry_at>clock_timestamp() OR EXISTS(
  SELECT 1 FROM nukhb4_target.ai_engine_reservations x WHERE x.tenant_id=t AND x.job_id=job AND x.status IN ('OPEN','QUARANTINED'))
 THEN RAISE EXCEPTION 'Reservation requires reconciliation' USING ERRCODE='55P03';END IF;
 SELECT count(*)::int INTO n FROM nukhb4_target.ai_engine_reservations x WHERE x.tenant_id=t AND x.job_id=job;
 IF n>=2 THEN
  SELECT * INTO STRICT r FROM nukhb4_target.ai_engine_reservations x WHERE x.tenant_id=t AND x.job_id=job ORDER BY x.ordinal DESC LIMIT 1;
  INSERT INTO nukhb4_target.ai_engine_reservation_audit(token,tenant_id,job_id,ordinal,event) VALUES(r.token,t,job,r.ordinal,'EXHAUSTED') ON CONFLICT ON CONSTRAINT ai_engine_audit_once DO NOTHING;
  RETURN QUERY SELECT NULL::uuid,n,'EXHAUSTED'::text;RETURN;
 END IF;
 stamp:=nukhb4_target.ai_authority_epoch();now_at:=clock_timestamp();
 IF NOT EXISTS(SELECT 1 FROM nukhabapay.ai_job_sources s WHERE s.tenant_id=t AND s.snapshot_id=j.snapshot_id
  AND s.offer_id=j.offer_id AND s.source_version=j.source_version AND least(s.valid_until,s.observed_at+INTERVAL '24 hours')>now_at)
 THEN RETURN QUERY SELECT NULL::uuid,0,'DENIED'::text;RETURN;END IF;
 INSERT INTO nukhb4_target.ai_engine_reservations VALUES(request_token,t,job,n+1,j.attempts,j.source_digest,stamp,'OPEN',now_at,now_at+INTERVAL '14 seconds');
 INSERT INTO nukhb4_target.ai_engine_reservation_audit(token,tenant_id,job_id,ordinal,event) VALUES(request_token,t,job,n+1,'RESERVED');
 RETURN QUERY SELECT request_token,n+1,'OPEN'::text;
END $fn$;
CREATE FUNCTION nukhb4_target.assert_ai_attempt(claim uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE t uuid;r nukhb4_target.ai_engine_reservations%ROWTYPE;j nukhabapay.ai_jobs%ROWTYPE;
BEGIN
 IF session_user IS DISTINCT FROM __RUNTIME_LITERAL__ THEN RAISE EXCEPTION 'Unapproved attempt identity' USING ERRCODE='42501';END IF;
 t:=current_setting('nukhabapay.ai_job_tenant',true)::uuid;PERFORM nukhb4_target.lock_ai_state(t);
 SELECT * INTO STRICT r FROM nukhb4_target.ai_engine_reservations x WHERE x.token=claim AND x.tenant_id=t AND x.status='OPEN' AND x.expires_at>clock_timestamp();
 SELECT * INTO STRICT j FROM nukhabapay.ai_jobs x WHERE x.id=r.job_id AND x.tenant_id=t;
 IF j.source_digest IS DISTINCT FROM r.source_digest OR nukhb4_target.ai_authority_epoch() IS DISTINCT FROM r.generation
 THEN RAISE EXCEPTION 'Stale attempt authority';END IF;
 IF NOT EXISTS(SELECT 1 FROM nukhabapay.ai_job_sources s WHERE s.tenant_id=t AND s.snapshot_id=j.snapshot_id AND s.offer_id=j.offer_id
  AND s.source_version=j.source_version AND least(s.valid_until,s.observed_at+INTERVAL '24 hours')>clock_timestamp())
 OR NOT EXISTS(SELECT 1 FROM nukhabapay.ai_job_candidates c WHERE c.tenant_id=t AND c.product_id=j.candidate_product_id AND c.valid_until>clock_timestamp())
 THEN RAISE EXCEPTION 'Attempt source expired';END IF;
 PERFORM set_config('nukhabapay.ai_engine_reservation',claim::text,true);
END $fn$;
CREATE FUNCTION nukhb4_target.settle_ai_attempt(claim uuid,committed boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE t uuid;r nukhb4_target.ai_engine_reservations%ROWTYPE;j nukhabapay.ai_jobs%ROWTYPE;next_status text;
BEGIN
 IF session_user IS DISTINCT FROM __RUNTIME_LITERAL__ THEN RAISE EXCEPTION 'Unapproved attempt settlement' USING ERRCODE='42501';END IF;
 t:=current_setting('nukhabapay.ai_job_tenant',true)::uuid;PERFORM nukhb4_target.lock_ai_state(t);
 SELECT * INTO STRICT r FROM nukhb4_target.ai_engine_reservations x WHERE x.token=claim AND x.tenant_id=t FOR UPDATE;
 IF r.status<>'OPEN' THEN RETURN;END IF;
 SELECT * INTO STRICT j FROM nukhabapay.ai_jobs x WHERE x.id=r.job_id AND x.tenant_id=t;
 IF committed AND NOT(j.state IN ('SUCCEEDED','FAILED','RETRYABLE') AND j.attempts=r.base_attempt+1)
 THEN RAISE EXCEPTION 'Unproven attempt commit';END IF;
 next_status:=CASE WHEN committed THEN 'SETTLED' ELSE 'QUARANTINED' END;
 UPDATE nukhb4_target.ai_engine_reservations SET status=next_status WHERE token=claim;
 INSERT INTO nukhb4_target.ai_engine_reservation_audit(token,tenant_id,job_id,ordinal,event) VALUES(claim,t,r.job_id,r.ordinal,next_status);
END $fn$;
CREATE FUNCTION nukhb4_target.guard_ai_reservation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Reservation history retained';END IF;
 IF TG_OP='INSERT' THEN IF NEW.status<>'OPEN' THEN RAISE EXCEPTION 'Invalid reservation birth';END IF;
 ELSE IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') OR OLD.status<>'OPEN' OR NEW.status NOT IN ('SETTLED','QUARANTINED')
 THEN RAISE EXCEPTION 'Immutable reservation or invalid transition';END IF;END IF;RETURN NEW;
END $fn$;
CREATE FUNCTION nukhb4_target.require_ai_reservation_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM nukhb4_target.ai_engine_reservation_audit a WHERE a.token=NEW.token AND a.tenant_id=NEW.tenant_id
  AND a.job_id=NEW.job_id AND a.ordinal=NEW.ordinal AND a.event=CASE NEW.status WHEN 'OPEN' THEN 'RESERVED' ELSE NEW.status END AND a.write_xid=pg_current_xact_id())
 THEN RAISE EXCEPTION 'Reservation audit missing';END IF;RETURN NULL;
END $fn$;
CREATE FUNCTION nukhb4_target.guard_ai_job_reservation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE r nukhb4_target.ai_engine_reservations%ROWTYPE;claim uuid;
BEGIN
 claim:=nullif(current_setting('nukhabapay.ai_engine_reservation',true),'')::uuid;
 PERFORM nukhb4_target.assert_ai_attempt(claim);
 SELECT * INTO STRICT r FROM nukhb4_target.ai_engine_reservations WHERE token=claim;
 IF r.job_id<>NEW.id OR r.tenant_id<>NEW.tenant_id OR NEW.attempts<>r.base_attempt+1 THEN RAISE EXCEPTION 'Attempt does not own job transition';END IF;
 RETURN NEW;
END $fn$;
CREATE TRIGGER ai_engine_reservation_guard BEFORE INSERT OR UPDATE OR DELETE ON nukhb4_target.ai_engine_reservations FOR EACH ROW EXECUTE FUNCTION nukhb4_target.guard_ai_reservation();
CREATE TRIGGER ai_engine_reservation_audit_immutable BEFORE UPDATE OR DELETE ON nukhb4_target.ai_engine_reservation_audit FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_immutable_catalog_update();
CREATE CONSTRAINT TRIGGER ai_engine_reservation_requires_audit AFTER INSERT OR UPDATE ON nukhb4_target.ai_engine_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nukhb4_target.require_ai_reservation_audit();
CREATE TRIGGER ai_job_reservation_required BEFORE UPDATE ON nukhabapay.ai_jobs FOR EACH ROW EXECUTE FUNCTION nukhb4_target.guard_ai_job_reservation();
REVOKE ALL ON nukhb4_target.ai_engine_reservations,nukhb4_target.ai_engine_reservation_audit FROM PUBLIC,__RUNTIME_IDENTIFIER__,__MIGRATOR_IDENTIFIER__;
REVOKE ALL ON FUNCTION nukhb4_target.reserve_ai_attempt(uuid,uuid),nukhb4_target.assert_ai_attempt(uuid),nukhb4_target.settle_ai_attempt(uuid,boolean),
 nukhb4_target.guard_ai_reservation(),nukhb4_target.require_ai_reservation_audit(),nukhb4_target.guard_ai_job_reservation() FROM PUBLIC,__RUNTIME_IDENTIFIER__,__MIGRATOR_IDENTIFIER__;
GRANT EXECUTE ON FUNCTION nukhb4_target.reserve_ai_attempt(uuid,uuid),nukhb4_target.assert_ai_attempt(uuid),nukhb4_target.settle_ai_attempt(uuid,boolean) TO __RUNTIME_IDENTIFIER__;
