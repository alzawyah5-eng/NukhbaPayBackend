-- Independent Windows catalogue storage. The synthetic publication installers
-- retain their original namespace guards. This migration grants readers only.
CREATE TABLE nukhabapay.catalogue_publication_candidates (
  candidate_id text PRIMARY KEY CHECK(candidate_id ~ '^[0-9a-f]{64}$'),
  candidate_digest text NOT NULL UNIQUE CHECK(candidate_digest=candidate_id),
  tenant_id uuid NOT NULL REFERENCES nukhabapay.tenants(id),
  product_id uuid NOT NULL REFERENCES nukhabapay.products(id),
  canonical_product_key text NOT NULL CHECK(length(canonical_product_key) BETWEEN 1 AND 128),
  price_version bigint NOT NULL CHECK(price_version>0),
  expected_previous_version bigint NOT NULL CHECK(expected_previous_version>=0 AND price_version=expected_previous_version+1),
  currency text NOT NULL CHECK(currency='AED'),
  base_amount_minor bigint NOT NULL CHECK(base_amount_minor>0),
  service_fee_minor bigint NOT NULL CHECK(service_fee_minor>=0),
  tax_amount_minor bigint NOT NULL CHECK(tax_amount_minor>=0),
  total_amount_minor bigint NOT NULL CHECK(total_amount_minor=base_amount_minor+service_fee_minor+tax_amount_minor),
  provider_cost_minor bigint NOT NULL CHECK(provider_cost_minor>0),
  payment_fee_minor bigint NOT NULL CHECK(payment_fee_minor>=0),
  agent_commission_minor bigint NOT NULL CHECK(agent_commission_minor>=0),
  expected_contribution_minor bigint NOT NULL CHECK(expected_contribution_minor>=0),
  pricing_policy_version text NOT NULL CHECK(length(pricing_policy_version) BETWEEN 1 AND 128),
  rounding_policy text NOT NULL CHECK(rounding_policy='AED_MINOR_UNIT_HALF_UP_NONNEGATIVE'),
  selected_provider_id text NOT NULL CHECK(length(selected_provider_id) BETWEEN 1 AND 128),
  selected_offer_id text NOT NULL CHECK(length(selected_offer_id) BETWEEN 1 AND 128),
  selected_snapshot_id uuid NOT NULL REFERENCES nukhabapay.provider_snapshots(id),
  source_count integer NOT NULL CHECK(source_count BETWEEN 1 AND 32),
  evaluated_at timestamptz NOT NULL,
  valid_until timestamptz NOT NULL CHECK(valid_until>evaluated_at),
  status text NOT NULL DEFAULT 'DRAFT' CHECK(status='DRAFT'),
  execution text NOT NULL DEFAULT 'NOT_AUTHORIZED' CHECK(execution='NOT_AUTHORIZED'),
  activation_allowed boolean NOT NULL DEFAULT false CHECK(NOT activation_allowed),
  UNIQUE(candidate_id,tenant_id,product_id),
  UNIQUE(tenant_id,product_id,price_version)
);

CREATE TABLE nukhabapay.catalogue_publication_sources (
  candidate_id text NOT NULL,
  tenant_id uuid NOT NULL,
  product_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  provider_account_id uuid NOT NULL,
  snapshot_key text NOT NULL CHECK(length(snapshot_key) BETWEEN 1 AND 128),
  source_version text NOT NULL CHECK(length(source_version) BETWEEN 1 AND 128),
  observed_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL CHECK(completed_at>=observed_at),
  source_status text NOT NULL CHECK(source_status='COMPLETE'),
  execution text NOT NULL DEFAULT 'NOT_AUTHORIZED' CHECK(execution='NOT_AUTHORIZED'),
  PRIMARY KEY(candidate_id,snapshot_id),
  FOREIGN KEY(tenant_id,provider_account_id,snapshot_id)
    REFERENCES nukhabapay.provider_snapshots(tenant_id,provider_account_id,id),
  FOREIGN KEY(candidate_id,tenant_id,product_id)
    REFERENCES nukhabapay.catalogue_publication_candidates(candidate_id,tenant_id,product_id)
);

CREATE TABLE nukhabapay.catalogue_publication_requests (
  operation_id text PRIMARY KEY CHECK(operation_id ~ '^[0-9a-f]{64}$'),
  tenant_id uuid NOT NULL,
  product_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  candidate_id text NOT NULL,
  candidate_digest text NOT NULL CHECK(candidate_digest=candidate_id),
  outcome text NOT NULL CHECK(outcome IN ('DRAFT_CREATED','DRAFT_REPLAYED')),
  execution text NOT NULL DEFAULT 'NOT_AUTHORIZED' CHECK(execution='NOT_AUTHORIZED'),
  UNIQUE(tenant_id,product_id,idempotency_key),
  UNIQUE(operation_id,tenant_id,product_id,candidate_id),
  FOREIGN KEY(candidate_id,tenant_id,product_id)
    REFERENCES nukhabapay.catalogue_publication_candidates(candidate_id,tenant_id,product_id)
);

CREATE TABLE nukhabapay.catalogue_publication_events (
  event_id uuid PRIMARY KEY,
  operation_id text NOT NULL,
  candidate_id text NOT NULL,
  tenant_id uuid NOT NULL,
  product_id uuid NOT NULL,
  price_version bigint NOT NULL CHECK(price_version>0),
  candidate_digest text NOT NULL CHECK(candidate_digest=candidate_id),
  event_name text NOT NULL CHECK(event_name='CATALOGUE_PUBLICATION_CANDIDATE_CREATED'),
  occurred_at timestamptz NOT NULL,
  execution text NOT NULL DEFAULT 'NOT_AUTHORIZED' CHECK(execution='NOT_AUTHORIZED'),
  UNIQUE(candidate_id,event_name),
  FOREIGN KEY(operation_id,tenant_id,product_id,candidate_id)
    REFERENCES nukhabapay.catalogue_publication_requests(operation_id,tenant_id,product_id,candidate_id)
);

CREATE TABLE nukhabapay.price_submission_evidence (
  candidate_id text PRIMARY KEY, tenant_id uuid NOT NULL, product_id uuid NOT NULL,
  canonical_payload text NOT NULL CHECK(octet_length(canonical_payload) BETWEEN 1 AND 1048576),
  creator_staff_id uuid NOT NULL,
  authority_receipt_digest text NOT NULL CHECK(authority_receipt_digest ~ '^[0-9a-f]{64}$'),
  submitted_at timestamptz NOT NULL,
  CHECK(encode(sha256(convert_to(canonical_payload,'UTF8')),'hex')=candidate_id),
  UNIQUE(candidate_id,tenant_id,product_id),
  FOREIGN KEY(candidate_id,tenant_id,product_id)
    REFERENCES nukhabapay.catalogue_publication_candidates(candidate_id,tenant_id,product_id)
);

CREATE TABLE nukhabapay.price_workflow_operations (
  operation_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, product_id uuid NOT NULL, candidate_id text NOT NULL,
  idempotency_key uuid NOT NULL, actor_staff_id uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('APPROVE','ACTIVATE','ROLLBACK')),
  command_digest text NOT NULL CHECK(command_digest ~ '^[0-9a-f]{64}$'),
  authority_receipt_digest text NOT NULL UNIQUE CHECK(authority_receipt_digest ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  UNIQUE(tenant_id,product_id,idempotency_key),
  UNIQUE(operation_id,tenant_id,product_id,candidate_id,actor_staff_id,action,occurred_at),
  UNIQUE(operation_id,tenant_id,product_id,candidate_id,actor_staff_id,action),
  FOREIGN KEY(candidate_id,tenant_id,product_id)
    REFERENCES nukhabapay.price_submission_evidence(candidate_id,tenant_id,product_id)
);

CREATE TABLE nukhabapay.price_workflow_approvals (
  operation_id uuid PRIMARY KEY, candidate_id text NOT NULL UNIQUE, tenant_id uuid NOT NULL, product_id uuid NOT NULL,
  actor_staff_id uuid NOT NULL,
  action text GENERATED ALWAYS AS ('APPROVE') STORED,
  UNIQUE(candidate_id,tenant_id,product_id),
  FOREIGN KEY(operation_id,tenant_id,product_id,candidate_id,actor_staff_id,action)
    REFERENCES nukhabapay.price_workflow_operations(operation_id,tenant_id,product_id,candidate_id,actor_staff_id,action)
);

CREATE TABLE nukhabapay.price_workflow_versions (
  operation_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, product_id uuid NOT NULL, candidate_id text NOT NULL,
  actor_staff_id uuid NOT NULL, revision bigint NOT NULL CHECK(revision>0), previous_id uuid,
  rollback_source_id uuid, kind text NOT NULL CHECK(kind IN ('ACTIVATE','ROLLBACK')),
  reason text CHECK(length(reason) BETWEEN 3 AND 256 AND reason !~ '[[:cntrl:]]'),
  CHECK((kind='ACTIVATE' AND rollback_source_id IS NULL AND reason IS NULL) OR
        (kind='ROLLBACK' AND rollback_source_id IS NOT NULL AND reason IS NOT NULL)),
  CHECK((revision=1 AND previous_id IS NULL) OR (revision>1 AND previous_id IS NOT NULL)),
  UNIQUE(tenant_id,product_id,revision), UNIQUE(operation_id,tenant_id,product_id),
  FOREIGN KEY(previous_id,tenant_id,product_id) REFERENCES nukhabapay.price_workflow_versions(operation_id,tenant_id,product_id),
  FOREIGN KEY(rollback_source_id,tenant_id,product_id) REFERENCES nukhabapay.price_workflow_versions(operation_id,tenant_id,product_id),
  FOREIGN KEY(candidate_id,tenant_id,product_id) REFERENCES nukhabapay.price_workflow_approvals(candidate_id,tenant_id,product_id),
  FOREIGN KEY(operation_id,tenant_id,product_id,candidate_id,actor_staff_id,kind)
    REFERENCES nukhabapay.price_workflow_operations(operation_id,tenant_id,product_id,candidate_id,actor_staff_id,action)
);

CREATE TABLE nukhabapay.price_workflow_audit (
  operation_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, product_id uuid NOT NULL, candidate_id text NOT NULL,
  actor_staff_id uuid NOT NULL, action text NOT NULL, occurred_at timestamptz NOT NULL,
  FOREIGN KEY(operation_id,tenant_id,product_id,candidate_id,actor_staff_id,action,occurred_at)
    REFERENCES nukhabapay.price_workflow_operations(operation_id,tenant_id,product_id,candidate_id,actor_staff_id,action,occurred_at)
);

CREATE FUNCTION nukhabapay.reject_publication_evidence_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
BEGIN
  RAISE EXCEPTION 'Publication evidence is immutable' USING ERRCODE='42501';
END $body$;

DO $security$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['catalogue_publication_candidates','catalogue_publication_sources',
    'catalogue_publication_requests','catalogue_publication_events','price_submission_evidence',
    'price_workflow_operations','price_workflow_approvals','price_workflow_versions','price_workflow_audit'] LOOP
    EXECUTE format('ALTER TABLE nukhabapay.%I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE nukhabapay.%I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format($policy$CREATE POLICY publication_tenant_scope ON nukhabapay.%I
      USING (tenant_id::text=current_setting('nukhabapay.tenant_id',true)
        AND tenant_id::text=current_setting('nukhabapay.publication_tenant_id',true))$policy$,relation);
    EXECUTE format('REVOKE ALL ON nukhabapay.%I FROM PUBLIC',relation);
    EXECUTE format('CREATE TRIGGER immutable_publication BEFORE UPDATE OR DELETE OR TRUNCATE ON nukhabapay.%I
      FOR EACH STATEMENT EXECUTE FUNCTION nukhabapay.reject_publication_evidence_mutation()',relation);
  END LOOP;
END $security$;

CREATE FUNCTION nukhabapay.require_local_draft_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
BEGIN
  IF (SELECT count(*) FROM nukhabapay.catalogue_publication_sources s WHERE s.candidate_id=NEW.candidate_id)<>NEW.source_count
    OR EXISTS (SELECT FROM nukhabapay.catalogue_publication_sources s
      JOIN nukhabapay.provider_snapshots p ON (p.tenant_id,p.provider_account_id,p.id)=(s.tenant_id,s.provider_account_id,s.snapshot_id)
      WHERE s.candidate_id=NEW.candidate_id AND
        (p.status,p.snapshot_key,p.source_version,p.observed_at,p.completed_at)
          IS DISTINCT FROM (s.source_status,s.snapshot_key,s.source_version,s.observed_at,s.completed_at))
    OR NOT EXISTS (SELECT FROM nukhabapay.catalogue_publication_sources s WHERE s.candidate_id=NEW.candidate_id AND s.snapshot_id=NEW.selected_snapshot_id)
    OR NOT EXISTS (SELECT FROM nukhabapay.catalogue_publication_events e JOIN nukhabapay.catalogue_publication_requests r USING(operation_id)
      WHERE e.candidate_id=NEW.candidate_id AND e.price_version=NEW.price_version AND r.outcome='DRAFT_CREATED') THEN
    RAISE EXCEPTION 'Incomplete catalogue draft evidence' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $body$;
CREATE CONSTRAINT TRIGGER local_draft_evidence AFTER INSERT ON nukhabapay.catalogue_publication_candidates
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nukhabapay.require_local_draft_evidence();

CREATE FUNCTION nukhabapay.require_local_publication_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
DECLARE creator uuid; reviewer uuid; head nukhabapay.price_workflow_versions;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':'||NEW.product_id::text,0));
  SELECT creator_staff_id INTO creator FROM nukhabapay.price_submission_evidence WHERE candidate_id=NEW.candidate_id;
  IF creator IS NULL OR creator=NEW.actor_staff_id THEN
    RAISE EXCEPTION 'Distinct publication authority is required' USING ERRCODE='42501';
  END IF;
  IF TG_TABLE_NAME='price_workflow_versions' THEN
    SELECT actor_staff_id INTO reviewer FROM nukhabapay.price_workflow_approvals WHERE candidate_id=NEW.candidate_id;
    IF reviewer IS NULL OR reviewer=NEW.actor_staff_id THEN
      RAISE EXCEPTION 'Distinct publication approval is required' USING ERRCODE='42501';
    END IF;
    SELECT * INTO head FROM nukhabapay.price_workflow_versions
      WHERE tenant_id=NEW.tenant_id AND product_id=NEW.product_id ORDER BY revision DESC LIMIT 1;
    IF NEW.revision<>coalesce(head.revision,0)+1 OR NEW.previous_id IS DISTINCT FROM head.operation_id THEN
      RAISE EXCEPTION 'Stale publication head' USING ERRCODE='40001';
    END IF;
    IF NOT EXISTS (SELECT FROM nukhabapay.catalogue_publication_candidates c
      WHERE c.candidate_id=NEW.candidate_id AND c.valid_until>clock_timestamp()) THEN
      RAISE EXCEPTION 'Expired publication candidate' USING ERRCODE='23514';
    END IF;
    IF NEW.kind='ACTIVATE' AND EXISTS (SELECT FROM nukhabapay.catalogue_publication_sources s
      JOIN nukhabapay.provider_snapshots newer ON newer.tenant_id=s.tenant_id AND newer.provider_account_id=s.provider_account_id
      WHERE s.candidate_id=NEW.candidate_id AND newer.status='COMPLETE' AND
        (newer.observed_at,newer.completed_at,newer.id)>(s.observed_at,s.completed_at,s.snapshot_id)) THEN
      RAISE EXCEPTION 'Newer catalogue snapshot exists' USING ERRCODE='40001';
    END IF;
    IF NEW.kind='ROLLBACK' AND NOT EXISTS (SELECT FROM nukhabapay.price_workflow_versions
      WHERE operation_id=NEW.rollback_source_id AND tenant_id=NEW.tenant_id AND product_id=NEW.product_id
        AND candidate_id=NEW.candidate_id AND revision<head.revision) THEN
      RAISE EXCEPTION 'Invalid publication rollback source' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $body$;
CREATE TRIGGER local_approval_transition BEFORE INSERT ON nukhabapay.price_workflow_approvals
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.require_local_publication_transition();
CREATE TRIGGER local_version_transition BEFORE INSERT ON nukhabapay.price_workflow_versions
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.require_local_publication_transition();

CREATE FUNCTION nukhabapay.require_local_publication_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
BEGIN
  IF NOT EXISTS(SELECT FROM nukhabapay.price_workflow_audit a WHERE a.operation_id=NEW.operation_id)
    OR (NEW.action='APPROVE' AND NOT EXISTS(SELECT FROM nukhabapay.price_workflow_approvals a WHERE a.operation_id=NEW.operation_id))
    OR (NEW.action<>'APPROVE' AND NOT EXISTS(SELECT FROM nukhabapay.price_workflow_versions v WHERE v.operation_id=NEW.operation_id)) THEN
    RAISE EXCEPTION 'Incomplete publication workflow evidence' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $body$;
CREATE CONSTRAINT TRIGGER local_publication_evidence AFTER INSERT ON nukhabapay.price_workflow_operations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nukhabapay.require_local_publication_evidence();

GRANT SELECT(candidate_id,tenant_id,product_id,price_version,selected_provider_id,total_amount_minor,
  provider_cost_minor,service_fee_minor,payment_fee_minor,agent_commission_minor,expected_contribution_minor)
  ON nukhabapay.catalogue_publication_candidates TO nukhbapay_catalogue_reader;
GRANT SELECT(candidate_id,tenant_id,product_id) ON nukhabapay.price_submission_evidence,nukhabapay.price_workflow_approvals
  TO nukhbapay_catalogue_reader;
GRANT SELECT(operation_id,tenant_id,product_id,candidate_id,revision,kind)
  ON nukhabapay.price_workflow_versions TO nukhbapay_catalogue_reader;
GRANT SELECT(operation_id,tenant_id,product_id,action,occurred_at)
  ON nukhabapay.price_workflow_audit TO nukhbapay_catalogue_reader;
