-- UNREGISTERED DISPOSABLE FIXTURE SUPPLEMENT. SQL EMISSION ONLY until separately authorized.
SELECT nukhb4_target.assert_exact_target();
DO $gate$ BEGIN IF current_user <> 'nukhb4_bootstrap_5003f11512ab48a6'
 OR current_database() IS DISTINCT FROM __DATABASE_LITERAL__ OR inet_server_port() IS DISTINCT FROM 55437
 THEN RAISE EXCEPTION 'Unapproved Milestone3 fixture' USING ERRCODE='42501'; END IF; END $gate$;

CREATE TABLE nukhb4_target.ai_tenant_generation(
 tenant_id uuid PRIMARY KEY, lock_key integer GENERATED ALWAYS AS IDENTITY UNIQUE,
 generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0));
INSERT INTO nukhb4_target.ai_tenant_generation(tenant_id) SELECT id FROM nukhabapay.tenants ORDER BY id;
CREATE TABLE nukhb4_target.ai_shared_generation(singleton boolean PRIMARY KEY CHECK(singleton),generation bigint NOT NULL CHECK(generation>=0));
INSERT INTO nukhb4_target.ai_shared_generation VALUES(true,0);
CREATE TABLE nukhb4_target.ai_delivery_leases(
 token uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, job_id uuid NOT NULL REFERENCES nukhabapay.ai_jobs(id),
 generation text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(expires_at>created_at AND expires_at<=created_at+INTERVAL '1 second'));
CREATE TABLE nukhb4_target.ai_disclosure_audit(
 event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,job_id uuid NOT NULL REFERENCES nukhabapay.ai_jobs(id),
 generation text NOT NULL,occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 outcome text NOT NULL CHECK(outcome IN ('AUTHORIZED_DISPATCH_INTENT','AUTHORIZATION_RELEASED')),
 manual_review boolean NOT NULL CHECK(manual_review),can_publish boolean NOT NULL CHECK(NOT can_publish));

-- Both source generations survive deletion/recreation; tenant lock keys are
-- allocated, never hashed or reused. Common barrier/products precede ascending
-- tenant catalogue keys, then ascending AI-state keys. Late upgrades never wait.
CREATE FUNCTION nukhb4_target.lock_ai_catalogue(t uuid,writing boolean) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE k integer; highest bigint;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(4314,0);
 PERFORM pg_advisory_xact_lock_shared(4314,1);
 SELECT lock_key INTO STRICT k FROM nukhb4_target.ai_tenant_generation WHERE tenant_id=t;
 SELECT max(objid::bigint) INTO highest FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND classid=4315 AND objsubid=2 AND granted;
 IF highest>k AND NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND classid=4315 AND objid=k::oid AND objsubid=2 AND granted)
 THEN RAISE EXCEPTION 'Tenant lock ordering conflict' USING ERRCODE='40001'; END IF;
 IF writing THEN
  IF NOT pg_try_advisory_xact_lock(4315,k) THEN RAISE EXCEPTION 'Tenant catalogue busy' USING ERRCODE='55P03'; END IF;
 ELSE PERFORM pg_advisory_xact_lock_shared(4315,k); END IF;
END $fn$;
CREATE FUNCTION nukhb4_target.lock_ai_state(t uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE k integer; highest bigint;
BEGIN
 PERFORM nukhb4_target.lock_ai_catalogue(t,false);
 SELECT lock_key INTO STRICT k FROM nukhb4_target.ai_tenant_generation WHERE tenant_id=t;
 SELECT max(objid::bigint) INTO highest FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND classid=4316 AND objsubid=2 AND granted;
 IF highest>k THEN RAISE EXCEPTION 'AI lock ordering conflict' USING ERRCODE='40001'; END IF;
 PERFORM pg_advisory_xact_lock(4316,k);
END $fn$;
CREATE FUNCTION nukhb4_target.assert_no_ai_delivery(t uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
 IF EXISTS(SELECT 1 FROM nukhb4_target.ai_delivery_leases WHERE (t IS NULL OR tenant_id=t) AND expires_at>clock_timestamp())
 THEN RAISE EXCEPTION 'Authorized delivery lease active' USING ERRCODE='55P03'; END IF;
END $fn$;
CREATE FUNCTION nukhb4_target.advance_ai_authority() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE t uuid; ids uuid[]; k integer;
BEGIN
 PERFORM nukhb4_target.assert_exact_target();
 IF TG_OP='TRUNCATE' THEN
  IF NOT pg_try_advisory_xact_lock(4314,0) THEN RAISE EXCEPTION 'Shared catalogue busy' USING ERRCODE='55P03'; END IF;
  PERFORM nukhb4_target.assert_no_ai_delivery(NULL);
  UPDATE nukhb4_target.ai_shared_generation SET generation=generation+1 WHERE singleton; RETURN NULL;
 END IF;
 IF TG_TABLE_NAME='products' THEN
  PERFORM pg_advisory_xact_lock_shared(4314,0);
  IF NOT pg_try_advisory_xact_lock(4314,1) THEN RAISE EXCEPTION 'Shared products busy' USING ERRCODE='55P03'; END IF;
  PERFORM nukhb4_target.assert_no_ai_delivery(NULL);
  UPDATE nukhb4_target.ai_shared_generation SET generation=generation+1 WHERE singleton; RETURN NULL;
 END IF;
 IF TG_TABLE_NAME='tenants' THEN
  ids:=CASE WHEN TG_OP='INSERT' THEN ARRAY[NEW.id] WHEN TG_OP='DELETE' THEN ARRAY[OLD.id] ELSE ARRAY[OLD.id,NEW.id] END;
  IF TG_OP<>'DELETE' THEN INSERT INTO nukhb4_target.ai_tenant_generation(tenant_id) SELECT DISTINCT unnest(ids) ON CONFLICT DO NOTHING; END IF;
 ELSE ids:=CASE WHEN TG_OP='INSERT' THEN ARRAY[NEW.tenant_id] WHEN TG_OP='DELETE' THEN ARRAY[OLD.tenant_id] ELSE ARRAY[OLD.tenant_id,NEW.tenant_id] END; END IF;
 IF EXISTS(SELECT 1 FROM unnest(ids) AS wanted(tenant_id) WHERE NOT EXISTS(SELECT 1 FROM nukhb4_target.ai_tenant_generation g WHERE g.tenant_id=wanted.tenant_id))
 THEN RAISE EXCEPTION 'Missing tenant generation evidence'; END IF;
 FOR t,k IN SELECT DISTINCT g.tenant_id,g.lock_key FROM nukhb4_target.ai_tenant_generation g WHERE g.tenant_id=ANY(ids) ORDER BY g.lock_key LOOP
  PERFORM nukhb4_target.lock_ai_catalogue(t,true);PERFORM nukhb4_target.assert_no_ai_delivery(t);
  UPDATE nukhb4_target.ai_tenant_generation SET generation=generation+1 WHERE tenant_id=t;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $fn$;
CREATE FUNCTION nukhb4_target.ai_mutation_scope() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE t uuid;
BEGIN
 IF TG_OP='TRUNCATE' THEN
  IF NOT pg_try_advisory_xact_lock(4314,0) THEN RAISE EXCEPTION 'Shared AI state busy' USING ERRCODE='55P03'; END IF;
  PERFORM nukhb4_target.assert_no_ai_delivery(NULL);RETURN NULL;
 END IF;
 t:=current_setting('nukhabapay.ai_job_tenant',true)::uuid;
 IF t IS NULL THEN RAISE EXCEPTION 'Tenant identity absent' USING ERRCODE='42501'; END IF;
 PERFORM nukhb4_target.lock_ai_state(t); RETURN NULL;
END $fn$;
CREATE FUNCTION nukhb4_target.enter_ai_source() RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE t uuid;
BEGIN
 IF session_user IS DISTINCT FROM __RUNTIME_LITERAL__ THEN RAISE EXCEPTION 'Unapproved AI identity' USING ERRCODE='42501'; END IF;
 t:=current_setting('nukhabapay.ai_job_tenant',true)::uuid;
 IF NOT EXISTS(SELECT 1 FROM nukhabapay.tenants WHERE id=t) THEN RAISE EXCEPTION 'Unknown tenant' USING ERRCODE='42501'; END IF;
 PERFORM nukhb4_target.lock_ai_catalogue(t,false);
END $fn$;
CREATE FUNCTION nukhb4_target.ai_authority_epoch() RETURNS text
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE result text;
BEGIN
 IF session_user IS DISTINCT FROM __RUNTIME_LITERAL__ THEN RAISE EXCEPTION 'Unapproved authority reader' USING ERRCODE='42501'; END IF;
 SELECT t.generation::text||'.'||s.generation::text INTO STRICT result FROM nukhb4_target.ai_tenant_generation t CROSS JOIN nukhb4_target.ai_shared_generation s
 WHERE t.tenant_id=current_setting('nukhabapay.ai_job_tenant',true)::uuid AND s.singleton;
 RETURN result;
END $fn$;

-- Seven input-writer contracts are retained. Tenant DML uses row ownership;
-- TRUNCATE spans tenants and therefore uses the genuine shared barrier.
__CATALOGUE_TRIGGERS__
-- Optional 007-010 relations are locked when that reviewed chain is present;
-- this supplement never creates or registers missing publication migrations.
DO $catalogue$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['catalogue_publication_candidates','catalogue_publication_sources','catalogue_publication_requests','catalogue_publication_events',
  'price_submission_births','price_submission_evidence','price_submission_events','price_workflow_operations','price_workflow_approvals','price_workflow_versions',
  'price_workflow_audit','published_catalogue_read_audit'] LOOP
  IF to_regclass('nukhabapay.'||n) IS NOT NULL THEN
   EXECUTE format('CREATE TRIGGER b4_ai_authority_generation BEFORE INSERT OR UPDATE OR DELETE ON nukhabapay.%I FOR EACH ROW EXECUTE FUNCTION nukhb4_target.advance_ai_authority()',n);
   EXECUTE format('CREATE TRIGGER b4_ai_authority_truncate BEFORE TRUNCATE ON nukhabapay.%I FOR EACH STATEMENT EXECUTE FUNCTION nukhb4_target.advance_ai_authority()',n);
  END IF;
 END LOOP;
END $catalogue$;
CREATE TRIGGER ai_jobs_tenant_lock BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON nukhabapay.ai_jobs FOR EACH STATEMENT EXECUTE FUNCTION nukhb4_target.ai_mutation_scope();
CREATE TRIGGER ai_audit_tenant_lock BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON nukhabapay.ai_job_audit FOR EACH STATEMENT EXECUTE FUNCTION nukhb4_target.ai_mutation_scope();

CREATE TABLE nukhabapay.ai_outbox(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,job_id uuid NOT NULL REFERENCES nukhabapay.ai_jobs(id),snapshot_id uuid NOT NULL,
 idempotency_key text NOT NULL CHECK(idempotency_key~'^[a-f0-9]{64}$'),payload_digest text NOT NULL CHECK(payload_digest~'^[a-f0-9]{64}$'),
 generation text NOT NULL CHECK(generation~'^[0-9]+[.][0-9]+$'),summary jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('PENDING','IN_FLIGHT','ATTEMPTED','ACKNOWLEDGED','CONFIRMED','RETRY_WAIT','UNCERTAIN','DEAD_LETTER','REVOKED')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),reconciliations integer NOT NULL DEFAULT 0 CHECK(reconciliations BETWEEN 0 AND 3),
 next_attempt_at timestamptz,lease_token uuid,lease_until timestamptz,receipt_id text CHECK(receipt_id IS NULL OR receipt_id~'^[A-Za-z0-9_.:-]{1,128}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,idempotency_key),UNIQUE(tenant_id,job_id),CHECK(summary->>'manualReview'='true' AND summary->>'can_publish'='false'));
CREATE TABLE nukhabapay.ai_outbox_audit(
 event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,outbox_id uuid NOT NULL REFERENCES nukhabapay.ai_outbox(id),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),event text NOT NULL CHECK(event IN
 ('ENQUEUED','CLAIMED','DELIVERY_INTENT','ATTEMPTED','ACKNOWLEDGED','CONFIRMED','RETRY_SCHEDULED','UNCERTAIN','DEAD_LETTER','AUTHORIZATION_DENIED','RECONCILED')),
 attempt integer NOT NULL CHECK(attempt BETWEEN 0 AND 5),state text NOT NULL,code text CHECK(code IS NULL OR code IN
 ('NOT_SENT','ATTEMPTS_EXHAUSTED','AUTHORITY_UNAVAILABLE','AUTHORITY_EXPIRED','AUTHORITY_OR_RESPONSE_UNCERTAIN','ACKNOWLEDGEMENT_MISSING','TRANSPORT_UNCERTAIN','RECOVERY_UNCERTAIN','RECONCILIATION_EXHAUSTED')),
 write_xid xid8 NOT NULL DEFAULT pg_current_xact_id());
ALTER TABLE nukhabapay.ai_outbox OWNER TO __MIGRATOR_IDENTIFIER__;
ALTER TABLE nukhabapay.ai_outbox_audit OWNER TO __MIGRATOR_IDENTIFIER__;
ALTER TABLE nukhabapay.ai_outbox ENABLE ROW LEVEL SECURITY; ALTER TABLE nukhabapay.ai_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.ai_outbox_audit ENABLE ROW LEVEL SECURITY; ALTER TABLE nukhabapay.ai_outbox_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_outbox_tenant ON nukhabapay.ai_outbox USING(tenant_id::text=current_setting('nukhabapay.ai_job_tenant',true)) WITH CHECK(tenant_id::text=current_setting('nukhabapay.ai_job_tenant',true));
CREATE POLICY ai_outbox_audit_tenant ON nukhabapay.ai_outbox_audit USING(tenant_id::text=current_setting('nukhabapay.ai_job_tenant',true)) WITH CHECK(tenant_id::text=current_setting('nukhabapay.ai_job_tenant',true));
CREATE TRIGGER ai_outbox_tenant_lock BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON nukhabapay.ai_outbox FOR EACH STATEMENT EXECUTE FUNCTION nukhb4_target.ai_mutation_scope();
CREATE TRIGGER ai_outbox_audit_tenant_lock BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON nukhabapay.ai_outbox_audit FOR EACH STATEMENT EXECUTE FUNCTION nukhb4_target.ai_mutation_scope();
CREATE TRIGGER ai_outbox_audit_immutable BEFORE UPDATE OR DELETE ON nukhabapay.ai_outbox_audit FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_immutable_catalog_update();
CREATE TRIGGER ai_disclosure_immutable BEFORE UPDATE OR DELETE ON nukhb4_target.ai_disclosure_audit FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_immutable_catalog_update();

CREATE FUNCTION nukhb4_target.enqueue_ai_outbox() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE canonical text; digest text; key text; oid uuid; gen text;
BEGIN
 IF NEW.state<>'SUCCEEDED' THEN RETURN NULL; END IF;
 IF NEW.summary->>'manualReview'<>'true' OR NEW.summary->>'can_publish'<>'false' THEN RAISE EXCEPTION 'Nonadvisory AI result'; END IF;
 PERFORM nukhb4_target.lock_ai_state(NEW.tenant_id);
 SELECT string_agg(to_json(k)::text||':'||(NEW.summary->k)::text,',' ORDER BY k COLLATE "C") INTO canonical
 FROM unnest(ARRAY['can_publish','confidenceBps','decision','duplicateCandidate','manualReview','modelVersion','promptVersion','provider','rulesVersion']) AS keys(k);
 canonical:='{'||canonical||'}';digest:=encode(sha256(convert_to(canonical,'UTF8')),'hex');
 key:=encode(sha256(convert_to(NEW.tenant_id::text||':'||NEW.id::text||':'||NEW.source_digest||':advisory-v1','UTF8')),'hex');
 gen:=nukhb4_target.ai_authority_epoch();
 INSERT INTO nukhabapay.ai_outbox(tenant_id,job_id,snapshot_id,idempotency_key,payload_digest,generation,summary,state)
 VALUES(NEW.tenant_id,NEW.id,NEW.snapshot_id,key,digest,gen,NEW.summary,'PENDING') ON CONFLICT(tenant_id,job_id) DO NOTHING RETURNING id INTO oid;
 IF oid IS NULL THEN
  IF NOT EXISTS(SELECT 1 FROM nukhabapay.ai_outbox WHERE tenant_id=NEW.tenant_id AND job_id=NEW.id AND idempotency_key=key AND payload_digest=digest AND generation=gen)
  THEN RAISE EXCEPTION 'Outbox idempotency conflict'; END IF;
 ELSE INSERT INTO nukhabapay.ai_outbox_audit(tenant_id,outbox_id,event,attempt,state) VALUES(NEW.tenant_id,oid,'ENQUEUED',0,'PENDING'); END IF;
 RETURN NULL;
END $fn$;
CREATE TRIGGER ai_outbox_atomic AFTER INSERT OR UPDATE ON nukhabapay.ai_jobs FOR EACH ROW EXECUTE FUNCTION nukhb4_target.enqueue_ai_outbox();

CREATE FUNCTION nukhb4_target.guard_ai_outbox() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Outbox history is retained'; END IF;
 IF NEW.tenant_id::text IS DISTINCT FROM current_setting('nukhabapay.ai_job_tenant',true) THEN RAISE EXCEPTION 'Outbox tenant mismatch'; END IF;
 PERFORM nukhb4_target.lock_ai_state(NEW.tenant_id);
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'PENDING' OR NEW.attempts<>0 OR NEW.reconciliations<>0 OR NEW.lease_token IS NOT NULL THEN RAISE EXCEPTION 'Invalid outbox birth'; END IF;
 ELSE
  IF (NEW.id,NEW.tenant_id,NEW.job_id,NEW.snapshot_id,NEW.idempotency_key,NEW.payload_digest,NEW.generation,NEW.summary,NEW.created_at)
   IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.job_id,OLD.snapshot_id,OLD.idempotency_key,OLD.payload_digest,OLD.generation,OLD.summary,OLD.created_at)
   OR NEW.attempts NOT BETWEEN OLD.attempts AND OLD.attempts+1 OR NEW.reconciliations NOT BETWEEN OLD.reconciliations AND OLD.reconciliations+1
   OR OLD.state IN ('CONFIRMED','DEAD_LETTER','REVOKED') THEN RAISE EXCEPTION 'Immutable outbox identity or terminal state'; END IF;
 END IF;
 RETURN NEW;
END $fn$;
CREATE TRIGGER ai_outbox_guard BEFORE INSERT OR UPDATE OR DELETE ON nukhabapay.ai_outbox FOR EACH ROW EXECUTE FUNCTION nukhb4_target.guard_ai_outbox();
CREATE FUNCTION nukhb4_target.require_ai_outbox_audit() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM nukhabapay.ai_outbox_audit a WHERE a.tenant_id=NEW.tenant_id AND a.outbox_id=NEW.id
  AND a.state=NEW.state AND a.attempt=NEW.attempts AND a.write_xid=pg_current_xact_id()) THEN RAISE EXCEPTION 'Transactional outbox audit missing'; END IF;
 RETURN NULL;
END $fn$;
CREATE CONSTRAINT TRIGGER ai_outbox_requires_audit AFTER INSERT OR UPDATE ON nukhabapay.ai_outbox DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION nukhb4_target.require_ai_outbox_audit();

CREATE FUNCTION nukhb4_target.record_ai_disclosure(job uuid,expected_generation text,client text,source_pid integer,source_started text)
 RETURNS TABLE(token uuid,tenant_id uuid,snapshot_id uuid,generation text,server_now timestamptz,not_after timestamptz,valid_until timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE t uuid; j nukhabapay.ai_jobs%ROWTYPE; expiry timestamptz; candidate_expiry timestamptz; stamp text; now_at timestamptz; lease uuid;
BEGIN
 PERFORM nukhb4_target.assert_exact_target();
 IF session_user IS DISTINCT FROM __RUNTIME_LITERAL__ THEN RAISE EXCEPTION 'Unapproved disclosure identity' USING ERRCODE='42501'; END IF;
 t:=current_setting('nukhabapay.ai_job_tenant',true)::uuid;PERFORM nukhb4_target.lock_ai_state(t);
 SELECT * INTO STRICT j FROM nukhabapay.ai_jobs x WHERE x.id=job AND x.tenant_id=t AND x.client_digest=client AND x.state<>'RUNNING';
 IF NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=source_pid AND extract(epoch from backend_start)::text=source_started AND usename=__RUNTIME_LITERAL__ AND datname=current_database()) THEN RAISE EXCEPTION 'Source identity absent or reused'; END IF;
 stamp:=nukhb4_target.ai_authority_epoch();IF stamp IS DISTINCT FROM expected_generation THEN RAISE EXCEPTION 'Stale authority generation'; END IF;
 SELECT least(s.valid_until,s.observed_at+INTERVAL '24 hours') INTO STRICT expiry FROM nukhabapay.ai_job_sources s
 WHERE s.tenant_id=t AND s.snapshot_id=j.snapshot_id AND s.offer_id=j.offer_id AND s.source_version=j.source_version;
 SELECT max(c.valid_until) INTO candidate_expiry FROM nukhabapay.ai_job_candidates c WHERE c.tenant_id=t AND c.product_id=j.candidate_product_id;
 now_at:=clock_timestamp();expiry:=least(expiry,candidate_expiry);
 IF candidate_expiry IS NULL OR expiry<=now_at+INTERVAL '100 milliseconds' THEN RAISE EXCEPTION 'Source authorization expired'; END IF;
 lease:=gen_random_uuid();
 INSERT INTO nukhb4_target.ai_delivery_leases(token,tenant_id,job_id,generation,expires_at,created_at)
 VALUES(lease,t,job,stamp,least(expiry,now_at+INTERVAL '1 second'),now_at);
 INSERT INTO nukhb4_target.ai_disclosure_audit(tenant_id,job_id,generation,outcome,manual_review,can_publish)
 VALUES(t,job,stamp,'AUTHORIZED_DISPATCH_INTENT',true,false);
 RETURN QUERY SELECT lease,t,j.snapshot_id,stamp,now_at,least(expiry,now_at+INTERVAL '1 second'),expiry;
END $fn$;
CREATE FUNCTION nukhb4_target.release_ai_authorization(lease uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE t uuid; j uuid; g text;
BEGIN
 IF session_user IS DISTINCT FROM __RUNTIME_LITERAL__ THEN RAISE EXCEPTION 'Unapproved release'; END IF;
 t:=current_setting('nukhabapay.ai_job_tenant',true)::uuid;PERFORM nukhb4_target.lock_ai_state(t);
 DELETE FROM nukhb4_target.ai_delivery_leases l WHERE l.token=lease AND l.tenant_id=t RETURNING l.job_id,l.generation INTO j,g;
 IF FOUND THEN INSERT INTO nukhb4_target.ai_disclosure_audit(tenant_id,job_id,generation,outcome,manual_review,can_publish)
 VALUES(t,j,g,'AUTHORIZATION_RELEASED',true,false); END IF;
END $fn$;

CREATE FUNCTION nukhb4_target.claim_ai_outbox(key text DEFAULT NULL) RETURNS SETOF nukhabapay.ai_outbox
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE t uuid; r nukhabapay.ai_outbox%ROWTYPE;
BEGIN
 IF session_user IS DISTINCT FROM __RUNTIME_LITERAL__ THEN RAISE EXCEPTION 'Unapproved outbox identity'; END IF;
 t:=current_setting('nukhabapay.ai_job_tenant',true)::uuid;PERFORM nukhb4_target.lock_ai_state(t);
 -- Crash recovery never silently redelivers a possibly attempted instruction.
 FOR r IN SELECT * FROM nukhabapay.ai_outbox WHERE tenant_id=t AND state='IN_FLIGHT' AND lease_until<=clock_timestamp() FOR UPDATE LOOP
  UPDATE nukhabapay.ai_outbox SET state='UNCERTAIN',lease_token=NULL,lease_until=NULL WHERE id=r.id;
  INSERT INTO nukhabapay.ai_outbox_audit(tenant_id,outbox_id,event,attempt,state,code) VALUES(t,r.id,'UNCERTAIN',r.attempts,'UNCERTAIN','RECOVERY_UNCERTAIN');
 END LOOP;
 SELECT * INTO r FROM nukhabapay.ai_outbox WHERE tenant_id=t AND (key IS NULL OR idempotency_key=key)
 AND state IN ('PENDING','RETRY_WAIT') AND attempts<5 AND (next_attempt_at IS NULL OR next_attempt_at<=clock_timestamp()) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN; END IF;
 UPDATE nukhabapay.ai_outbox SET state='IN_FLIGHT',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=clock_timestamp()+INTERVAL '14 seconds'
 WHERE id=r.id RETURNING * INTO r;
 INSERT INTO nukhabapay.ai_outbox_audit(tenant_id,outbox_id,event,attempt,state) VALUES(t,r.id,'CLAIMED',r.attempts,r.state);
 RETURN NEXT r;
END $fn$;
CREATE FUNCTION nukhb4_target.transition_ai_outbox(oid uuid,lease uuid,next_state text,event_name text,next_at timestamptz DEFAULT NULL,receipt text DEFAULT NULL,failure_code text DEFAULT NULL)
 RETURNS nukhabapay.ai_outbox LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE t uuid;r nukhabapay.ai_outbox%ROWTYPE;allowed boolean;
BEGIN
 IF session_user IS DISTINCT FROM __RUNTIME_LITERAL__ THEN RAISE EXCEPTION 'Unapproved outbox identity'; END IF;
 t:=current_setting('nukhabapay.ai_job_tenant',true)::uuid;PERFORM nukhb4_target.lock_ai_state(t);
 SELECT * INTO STRICT r FROM nukhabapay.ai_outbox WHERE id=oid AND tenant_id=t AND lease_token=lease AND lease_until>clock_timestamp() FOR UPDATE;
 allowed:=(r.state='IN_FLIGHT' AND next_state=ANY(ARRAY['IN_FLIGHT','ATTEMPTED','RETRY_WAIT','UNCERTAIN','DEAD_LETTER','REVOKED']))
 OR (r.state='ATTEMPTED' AND next_state=ANY(ARRAY['ACKNOWLEDGED','UNCERTAIN'])) OR (r.state='ACKNOWLEDGED' AND next_state='CONFIRMED');
 IF NOT allowed OR event_name IS DISTINCT FROM CASE next_state WHEN 'IN_FLIGHT' THEN 'DELIVERY_INTENT' WHEN 'RETRY_WAIT' THEN 'RETRY_SCHEDULED' WHEN 'REVOKED' THEN 'AUTHORIZATION_DENIED' ELSE next_state END
 OR (next_state='RETRY_WAIT' AND r.attempts>=5)
 OR (next_state IN ('ACKNOWLEDGED','CONFIRMED') AND (receipt IS NULL OR receipt !~ '^[A-Za-z0-9_.:-]{1,128}$'))
 THEN RAISE EXCEPTION 'Invalid outbox transition'; END IF;
 UPDATE nukhabapay.ai_outbox SET state=next_state,next_attempt_at=CASE WHEN next_state='RETRY_WAIT' THEN clock_timestamp()+make_interval(secs=>least(30.0,0.25*power(2,r.attempts-1))) ELSE NULL END,receipt_id=coalesce(receipt,receipt_id) WHERE id=r.id RETURNING * INTO r;
 INSERT INTO nukhabapay.ai_outbox_audit(tenant_id,outbox_id,event,attempt,state,code) VALUES(t,r.id,event_name,r.attempts,r.state,failure_code);
 RETURN r;
END $fn$;
CREATE FUNCTION nukhb4_target.reconcile_ai_outbox(oid uuid,answer text,receipt text DEFAULT NULL) RETURNS nukhabapay.ai_outbox
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE t uuid;r nukhabapay.ai_outbox%ROWTYPE;ns text;
BEGIN
 IF session_user IS DISTINCT FROM __RUNTIME_LITERAL__ THEN RAISE EXCEPTION 'Unapproved reconciliation'; END IF;
 t:=current_setting('nukhabapay.ai_job_tenant',true)::uuid;PERFORM nukhb4_target.lock_ai_state(t);
 SELECT * INTO STRICT r FROM nukhabapay.ai_outbox WHERE id=oid AND tenant_id=t AND state IN ('UNCERTAIN','ACKNOWLEDGED','ATTEMPTED') FOR UPDATE;
 IF r.reconciliations>=3 THEN RAISE EXCEPTION 'Reconciliation limit reached'; END IF;
 ns:=CASE WHEN answer='PROCESSED' AND receipt~'^[A-Za-z0-9_.:-]{1,128}$' THEN 'CONFIRMED'
 WHEN answer='NOT_PROCESSED' AND r.attempts<5 THEN 'RETRY_WAIT' WHEN answer IN ('PROCESSED','NOT_PROCESSED','UNKNOWN') THEN
 CASE WHEN r.reconciliations+1>=3 OR r.attempts>=5 THEN 'DEAD_LETTER' ELSE 'UNCERTAIN' END ELSE NULL END;
 IF ns IS NULL THEN RAISE EXCEPTION 'Invalid reconciliation'; END IF;
 UPDATE nukhabapay.ai_outbox SET state=ns,reconciliations=reconciliations+1,receipt_id=coalesce(receipt,receipt_id),
 next_attempt_at=CASE WHEN ns='RETRY_WAIT' THEN clock_timestamp()+make_interval(secs=>least(30.0,0.25*power(2,r.attempts-1))) ELSE NULL END,
 lease_token=NULL,lease_until=NULL WHERE id=r.id RETURNING * INTO r;
 INSERT INTO nukhabapay.ai_outbox_audit(tenant_id,outbox_id,event,attempt,state,code) VALUES(t,r.id,'RECONCILED',r.attempts,r.state,CASE WHEN ns='DEAD_LETTER' THEN 'RECONCILIATION_EXHAUSTED' ELSE NULL END);
 RETURN r;
END $fn$;

-- Private tables are not accessible by the runtime or public roles. Runtime
-- functions are the closed, tenant-bound SQL boundary; privileged helpers are
-- never granted. No schema ownership, membership, CREATE, TEMP or base writes.
REVOKE ALL ON ALL TABLES IN SCHEMA nukhb4_target FROM PUBLIC,__RUNTIME_IDENTIFIER__,__MIGRATOR_IDENTIFIER__;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA nukhb4_target FROM PUBLIC,__RUNTIME_IDENTIFIER__,__MIGRATOR_IDENTIFIER__;
REVOKE ALL ON nukhabapay.ai_outbox,nukhabapay.ai_outbox_audit FROM PUBLIC,__RUNTIME_IDENTIFIER__;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA nukhb4_target FROM PUBLIC,__RUNTIME_IDENTIFIER__,__MIGRATOR_IDENTIFIER__;
GRANT EXECUTE ON FUNCTION nukhb4_target.assert_exact_target() TO __RUNTIME_IDENTIFIER__,__MIGRATOR_IDENTIFIER__;
GRANT SELECT ON nukhb4_target.source_evidence TO __MIGRATOR_IDENTIFIER__;
GRANT EXECUTE ON FUNCTION nukhb4_target.enter_ai_source(),nukhb4_target.ai_authority_epoch(),
 nukhb4_target.record_ai_disclosure(uuid,text,text,integer,text),nukhb4_target.release_ai_authorization(uuid),
 nukhb4_target.claim_ai_outbox(text),nukhb4_target.transition_ai_outbox(uuid,uuid,text,text,timestamptz,text,text),
 nukhb4_target.reconcile_ai_outbox(uuid,text,text) TO __RUNTIME_IDENTIFIER__;
