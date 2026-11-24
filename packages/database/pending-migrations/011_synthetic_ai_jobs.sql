-- Unregistered, disposable-only AI job/audit foundation. No operational grants.
DO $gate$ BEGIN
 IF current_user<>'nukhabapay_migrator' OR current_database() !~ '^nukhabapay_b3b3_[0-9a-f]{32}$'
 OR host(inet_server_addr()) IS DISTINCT FROM '127.0.0.1' OR inet_server_port() IS DISTINCT FROM 5432
 OR current_setting('nukhbapay.ai_job_migration',true) IS DISTINCT FROM 'BRICK_4_AI_JOBS_SYNTHETIC'
 OR (SELECT array_agg(name ORDER BY id) FROM nukhabapay.schema_migrations) IS DISTINCT FROM
 ARRAY['001_catalog','002_import_role_privileges','003_import_role_read_access','004_staff_identity_foundation','005_staff_workflow_persistence','006_staff_server_sessions']::varchar[]
 OR EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
 WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND a.grantee<>d.defaclrole)
 OR EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
 WHERE n.nspname='nukhabapay' AND a.grantee<>n.nspowner AND
 (pg_get_userbyid(a.grantee) NOT IN ('nukhabapay_runtime','nukhabapay_importer','nukhabapay_identity_reader','nukhabapay_identity_writer') OR a.privilege_type<>'USAGE' OR a.is_grantable))
 THEN RAISE EXCEPTION 'Unapproved AI job target' USING ERRCODE='42501'; END IF;
END $gate$;

-- Explicit owner fixture evidence. COMPLETE alone is not snapshot approval.
-- No application, worker or staff role receives INSERT/UPDATE rights here.
CREATE TABLE nukhabapay.ai_job_snapshot_approvals (
 tenant_id uuid NOT NULL, provider_account_id uuid NOT NULL, snapshot_id uuid NOT NULL,
 source_version varchar(128) NOT NULL, category text NOT NULL CHECK(category='gift_card'),
 approval_kind text NOT NULL CHECK(approval_kind='SYNTHETIC_OWNER_FIXTURE_ONLY'),
 approved_at timestamptz NOT NULL, valid_until timestamptz NOT NULL CHECK(valid_until>approved_at),
 PRIMARY KEY(tenant_id,snapshot_id),
 FOREIGN KEY(tenant_id,provider_account_id,snapshot_id) REFERENCES nukhabapay.provider_snapshots(tenant_id,provider_account_id,id)
);
ALTER TABLE nukhabapay.ai_job_snapshot_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.ai_job_snapshot_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_job_snapshot_approval_tenant ON nukhabapay.ai_job_snapshot_approvals USING(tenant_id::text=current_setting('nukhabapay.ai_job_tenant',true)) WITH CHECK(tenant_id::text=current_setting('nukhabapay.ai_job_tenant',true));
CREATE TRIGGER ai_job_snapshot_approval_immutable BEFORE UPDATE OR DELETE ON nukhabapay.ai_job_snapshot_approvals FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_immutable_catalog_update();

CREATE TABLE nukhabapay.ai_jobs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES nukhabapay.tenants(id),
 client_digest text NOT NULL CHECK(client_digest ~ '^[0-9a-f]{64}$'), idempotency_key uuid NOT NULL,
 snapshot_id uuid NOT NULL, provider_account_id uuid NOT NULL, source_version varchar(128) NOT NULL,
 offer_id uuid NOT NULL REFERENCES nukhabapay.provider_offers(id), candidate_product_id uuid NOT NULL REFERENCES nukhabapay.products(id),
 request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'), source_digest text NOT NULL CHECK(source_digest ~ '^[0-9a-f]{64}$'),
 state text NOT NULL CHECK(state IN ('QUEUED','RUNNING','RETRYABLE','SUCCEEDED','FAILED')),
 attempts integer NOT NULL CHECK(attempts BETWEEN 0 AND 2), retry_at timestamptz, summary jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,provider_account_id,snapshot_id) REFERENCES nukhabapay.provider_snapshots(tenant_id,provider_account_id,id),
 UNIQUE(tenant_id,client_digest,idempotency_key), UNIQUE(id,tenant_id,snapshot_id),
 CHECK((state='QUEUED' AND attempts=0 OR state<>'QUEUED' AND attempts>0)),
 CHECK((state='RETRYABLE')=(retry_at IS NOT NULL)),
 CHECK(state<>'RETRYABLE' OR attempts=1), CHECK(state<>'FAILED' OR attempts=2),
 CHECK((state='SUCCEEDED')=(summary IS NOT NULL)),
 CHECK(summary IS NULL OR (
   jsonb_typeof(summary)='object' AND summary ?& ARRAY['provider','modelVersion','promptVersion','rulesVersion','decision','confidenceBps','duplicateCandidate','manualReview','can_publish']
   AND summary - ARRAY['provider','modelVersion','promptVersion','rulesVersion','decision','confidenceBps','duplicateCandidate','manualReview','can_publish']='{}'::jsonb
   AND summary->>'provider' IN ('openai','anthropic','gemini')
   AND summary->>'modelVersion'='mock-'||(summary->>'provider')||'-v1'
   AND summary->>'promptVersion'='product-match-mock-v1' AND summary->>'rulesVersion'='equivalence-v1'
   AND summary->>'decision' IN ('CANDIDATE','REQUIRES_REVIEW','REJECTED')
   AND jsonb_typeof(summary->'confidenceBps')='number' AND (summary->>'confidenceBps') ~ '^(0|[1-9][0-9]{0,4})$'
   AND (summary->>'confidenceBps')::integer<=10000 AND jsonb_typeof(summary->'duplicateCandidate')='boolean'
   AND summary->'manualReview'='true'::jsonb AND summary->'can_publish'='false'::jsonb
 ) IS TRUE)
);
CREATE TABLE nukhabapay.ai_job_audit (
 event_id uuid PRIMARY KEY, job_id uuid NOT NULL, tenant_id uuid NOT NULL, snapshot_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 write_xid xid8 NOT NULL DEFAULT pg_current_xact_id() CHECK(write_xid=pg_current_xact_id()),
 attempt integer NOT NULL CHECK(attempt BETWEEN 0 AND 2),
 outcome text NOT NULL CHECK(outcome IN ('SUBMITTED','STARTED','RETRYABLE','FAILED','SUCCEEDED','VALIDATED','TIMEOUT','INVALID_OUTPUT','PROVIDER_FAILURE','CIRCUIT_OPEN')),
 provider text CHECK(provider IN ('openai','anthropic','gemini')), provider_attempt integer CHECK(provider_attempt BETWEEN 0 AND 3),
 model_version text, prompt_version text NOT NULL DEFAULT 'product-match-mock-v1' CHECK(prompt_version='product-match-mock-v1'),
 manual_review boolean NOT NULL CHECK(manual_review), can_publish boolean NOT NULL CHECK(NOT can_publish),
 FOREIGN KEY(job_id,tenant_id,snapshot_id) REFERENCES nukhabapay.ai_jobs(id,tenant_id,snapshot_id),
 CHECK((provider IS NULL)=(model_version IS NULL)),
 CHECK(provider IS NULL OR model_version='mock-'||provider||'-v1'),
 CHECK((outcome IN ('VALIDATED','TIMEOUT','INVALID_OUTPUT','PROVIDER_FAILURE','CIRCUIT_OPEN'))=(provider_attempt IS NOT NULL)),
 CHECK(provider_attempt IS NULL OR provider IS NOT NULL), CHECK(outcome<>'SUCCEEDED' OR provider IS NOT NULL)
);
CREATE FUNCTION nukhabapay.enforce_ai_job_audit_phase() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,nukhabapay AS $fn$
DECLARE j nukhabapay.ai_jobs;
BEGIN
 SELECT * INTO j FROM nukhabapay.ai_jobs WHERE id=NEW.job_id AND tenant_id=NEW.tenant_id AND snapshot_id=NEW.snapshot_id;
 IF NOT FOUND OR NEW.attempt<>j.attempts OR NOT (
  (j.state='QUEUED' AND NEW.outcome='SUBMITTED' AND NEW.attempt=0)
  OR (j.state='RUNNING' AND NEW.outcome IN ('STARTED','VALIDATED','TIMEOUT','INVALID_OUTPUT','PROVIDER_FAILURE','CIRCUIT_OPEN'))
  OR (j.state IN ('SUCCEEDED','RETRYABLE','FAILED') AND NEW.outcome=j.state AND
    (j.state<>'SUCCEEDED' OR NEW.provider=j.summary->>'provider'))
 ) THEN RAISE EXCEPTION 'Invalid AI job audit phase'; END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION nukhabapay.enforce_ai_job_audit_phase() FROM PUBLIC;
CREATE TRIGGER ai_job_audit_phase BEFORE INSERT ON nukhabapay.ai_job_audit
 FOR EACH ROW EXECUTE FUNCTION nukhabapay.enforce_ai_job_audit_phase();
CREATE TRIGGER ai_job_audit_immutable BEFORE UPDATE OR DELETE ON nukhabapay.ai_job_audit
 FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_immutable_catalog_update();

CREATE FUNCTION nukhabapay.enforce_ai_job_transition() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,nukhabapay AS $fn$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'QUEUED' OR NEW.attempts<>0 THEN RAISE EXCEPTION 'Invalid AI job start'; END IF;
  IF NOT EXISTS(SELECT 1 FROM nukhabapay.ai_job_sources s WHERE s.tenant_id=NEW.tenant_id AND s.snapshot_id=NEW.snapshot_id AND s.offer_id=NEW.offer_id AND s.source_version=NEW.source_version AND s.provider_account_id=NEW.provider_account_id)
  OR NOT EXISTS(SELECT 1 FROM nukhabapay.ai_job_candidates c WHERE c.tenant_id=NEW.tenant_id AND c.product_id=NEW.candidate_product_id)
  THEN RAISE EXCEPTION 'Unapproved AI job sources'; END IF;
 ELSE
  IF ROW(NEW.id,NEW.tenant_id,NEW.client_digest,NEW.idempotency_key,NEW.snapshot_id,NEW.provider_account_id,NEW.source_version,NEW.offer_id,NEW.candidate_product_id,NEW.request_digest,NEW.source_digest,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.client_digest,OLD.idempotency_key,OLD.snapshot_id,OLD.provider_account_id,OLD.source_version,OLD.offer_id,OLD.candidate_product_id,OLD.request_digest,OLD.source_digest,OLD.created_at)
  OR NOT ((OLD.state IN ('QUEUED','RETRYABLE') AND NEW.state='RUNNING' AND NEW.attempts=OLD.attempts+1 AND (OLD.retry_at IS NULL OR OLD.retry_at<=clock_timestamp()))
  OR (OLD.state='RUNNING' AND NEW.state IN ('SUCCEEDED','RETRYABLE','FAILED') AND NEW.attempts=OLD.attempts))
  THEN RAISE EXCEPTION 'Invalid AI job transition'; END IF;
 END IF;
 NEW.updated_at=clock_timestamp(); RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION nukhabapay.enforce_ai_job_transition() FROM PUBLIC;
CREATE TRIGGER ai_job_transition BEFORE INSERT OR UPDATE ON nukhabapay.ai_jobs FOR EACH ROW EXECUTE FUNCTION nukhabapay.enforce_ai_job_transition();

CREATE FUNCTION nukhabapay.require_ai_job_audit() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,nukhabapay AS $fn$
DECLARE j nukhabapay.ai_jobs;
BEGIN
 SELECT * INTO j FROM nukhabapay.ai_jobs WHERE id=NEW.id AND tenant_id=NEW.tenant_id;
 IF j.state='RUNNING' OR NOT EXISTS(SELECT 1 FROM nukhabapay.ai_job_audit a WHERE a.job_id=j.id AND a.tenant_id=j.tenant_id
  AND a.write_xid=pg_current_xact_id() AND a.attempt=j.attempts AND a.outcome=CASE WHEN j.state='QUEUED' THEN 'SUBMITTED' ELSE j.state END)
 OR (j.attempts>0 AND NOT EXISTS(SELECT 1 FROM nukhabapay.ai_job_audit a WHERE a.job_id=j.id AND a.tenant_id=j.tenant_id AND a.write_xid=pg_current_xact_id() AND a.attempt=j.attempts AND a.outcome='STARTED'))
 OR (j.state='SUCCEEDED' AND NOT EXISTS(SELECT 1 FROM nukhabapay.ai_job_audit a WHERE a.job_id=j.id AND a.tenant_id=j.tenant_id AND a.write_xid=pg_current_xact_id() AND a.attempt=j.attempts AND a.outcome='VALIDATED' AND a.provider=j.summary->>'provider'))
 THEN RAISE EXCEPTION 'Required AI job audit missing'; END IF;
 RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION nukhabapay.require_ai_job_audit() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER ai_job_requires_audit AFTER INSERT OR UPDATE ON nukhabapay.ai_jobs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nukhabapay.require_ai_job_audit();

ALTER TABLE nukhabapay.ai_jobs ENABLE ROW LEVEL SECURITY; ALTER TABLE nukhabapay.ai_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.ai_job_audit ENABLE ROW LEVEL SECURITY; ALTER TABLE nukhabapay.ai_job_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_jobs_tenant ON nukhabapay.ai_jobs USING(tenant_id::text=current_setting('nukhabapay.ai_job_tenant',true)) WITH CHECK(tenant_id::text=current_setting('nukhabapay.ai_job_tenant',true));
CREATE POLICY ai_job_audit_tenant ON nukhabapay.ai_job_audit USING(tenant_id::text=current_setting('nukhabapay.ai_job_tenant',true)) WITH CHECK(tenant_id::text=current_setting('nukhabapay.ai_job_tenant',true));

-- Narrow catalogue projections exclude provider economics, credentials and provenance JSON.
CREATE VIEW nukhabapay.ai_job_sources WITH(security_barrier=true) AS
 SELECT o.tenant_id,o.id AS offer_id,o.provider_snapshot_id AS snapshot_id,o.provider_account_id,
 o.product_id,s.source_version,s.observed_at,s.completed_at,least(o.valid_until,approval.valid_until) AS valid_until,approval.category,
 p.canonical_product_key AS record_id,p.brand,p.redemption_country,p.currency,p.face_value_minor,p.fulfillment_method
 FROM nukhabapay.provider_offers o JOIN nukhabapay.provider_snapshots s ON s.id=o.provider_snapshot_id AND s.tenant_id=o.tenant_id
 JOIN nukhabapay.provider_accounts a ON a.id=o.provider_account_id AND a.tenant_id=o.tenant_id
 JOIN nukhabapay.product_mappings m ON m.id=o.product_mapping_id AND m.tenant_id=o.tenant_id AND m.mapping_version=o.product_mapping_version AND m.product_id=o.product_id
 JOIN nukhabapay.products p ON p.id=o.product_id
 JOIN nukhabapay.ai_job_snapshot_approvals approval ON approval.tenant_id=o.tenant_id AND approval.snapshot_id=s.id AND approval.provider_account_id=o.provider_account_id AND approval.source_version=s.source_version
 WHERE o.tenant_id::text=current_setting('nukhabapay.ai_job_tenant',true) AND s.status='COMPLETE' AND a.status='ACTIVE' AND m.status='APPROVED' AND o.available;
CREATE VIEW nukhabapay.ai_job_candidates WITH(security_barrier=true) AS
 SELECT DISTINCT m.tenant_id,p.id AS product_id,p.canonical_product_key AS record_id,p.brand,p.redemption_country,p.currency,p.face_value_minor,p.fulfillment_method,approval.category,approval.valid_until
 FROM nukhabapay.product_mappings m JOIN nukhabapay.products p ON p.id=m.product_id
 JOIN nukhabapay.provider_accounts a ON a.id=m.provider_account_id AND a.tenant_id=m.tenant_id
 JOIN nukhabapay.ai_job_snapshot_approvals approval ON approval.tenant_id=m.tenant_id AND approval.snapshot_id=m.source_snapshot_id AND approval.provider_account_id=m.provider_account_id
 WHERE m.tenant_id::text=current_setting('nukhabapay.ai_job_tenant',true) AND m.status='APPROVED' AND a.status='ACTIVE';
REVOKE ALL ON nukhabapay.ai_jobs,nukhabapay.ai_job_audit,nukhabapay.ai_job_snapshot_approvals,nukhabapay.ai_job_sources,nukhabapay.ai_job_candidates FROM PUBLIC,nukhabapay_runtime,nukhabapay_importer,nukhabapay_identity_reader,nukhabapay_identity_writer;
