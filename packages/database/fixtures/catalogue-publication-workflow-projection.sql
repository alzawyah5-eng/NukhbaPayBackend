-- Portable test projection for the publication executor and outbox contract.
-- The guarded 007–010 schemas and their role checks have their own acceptance suite.
CREATE TABLE nukhabapay.products (
  id uuid PRIMARY KEY, canonical_product_key text NOT NULL, brand text NOT NULL,
  redemption_country text NOT NULL, currency text NOT NULL, face_value_minor bigint NOT NULL,
  fulfillment_method text NOT NULL, terms_version text NOT NULL
);
CREATE TABLE nukhabapay.catalogue_publication_candidates (
  candidate_id text PRIMARY KEY, tenant_id uuid NOT NULL, product_id uuid NOT NULL REFERENCES nukhabapay.products,
  candidate_digest text NOT NULL UNIQUE CHECK(candidate_digest=candidate_id),
  canonical_product_key text NOT NULL, currency text NOT NULL, price_version bigint NOT NULL,
  expected_previous_version bigint NOT NULL, source_count int NOT NULL,
  base_amount_minor bigint NOT NULL, service_fee_minor bigint NOT NULL, tax_amount_minor bigint NOT NULL,
  total_amount_minor bigint NOT NULL, provider_cost_minor bigint NOT NULL, payment_fee_minor bigint NOT NULL,
  agent_commission_minor bigint NOT NULL, expected_contribution_minor bigint NOT NULL,
  selected_provider_id text NOT NULL, selected_offer_id text NOT NULL, selected_snapshot_id uuid NOT NULL,
  pricing_policy_version text NOT NULL, rounding_policy text NOT NULL, evaluated_at timestamptz NOT NULL, valid_until timestamptz NOT NULL,
  UNIQUE(candidate_id,tenant_id,product_id), UNIQUE(tenant_id,product_id,price_version)
);
CREATE TABLE nukhabapay.catalogue_publication_sources (
  candidate_id text NOT NULL, tenant_id uuid NOT NULL, product_id uuid NOT NULL, snapshot_id uuid NOT NULL,
  provider_account_id uuid NOT NULL, snapshot_key text NOT NULL, source_version text NOT NULL, observed_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL, source_status text NOT NULL CHECK(source_status='COMPLETE'),
  PRIMARY KEY(candidate_id,snapshot_id),
  FOREIGN KEY(candidate_id,tenant_id,product_id) REFERENCES nukhabapay.catalogue_publication_candidates(candidate_id,tenant_id,product_id)
);
CREATE TABLE nukhabapay.catalogue_publication_requests (
  operation_id text PRIMARY KEY, tenant_id uuid NOT NULL, product_id uuid NOT NULL, idempotency_key uuid NOT NULL,
  candidate_id text NOT NULL, candidate_digest text NOT NULL, outcome text NOT NULL,
  UNIQUE(tenant_id,product_id,idempotency_key),
  FOREIGN KEY(candidate_id,tenant_id,product_id) REFERENCES nukhabapay.catalogue_publication_candidates(candidate_id,tenant_id,product_id)
);
CREATE TABLE nukhabapay.catalogue_publication_events (
  event_id uuid PRIMARY KEY, operation_id text NOT NULL REFERENCES nukhabapay.catalogue_publication_requests,
  candidate_id text NOT NULL, tenant_id uuid NOT NULL, product_id uuid NOT NULL,
  price_version bigint NOT NULL, candidate_digest text NOT NULL, event_name text NOT NULL, occurred_at timestamptz NOT NULL
);
CREATE TABLE nukhabapay.price_submission_births (
  candidate_id text PRIMARY KEY, tenant_id uuid NOT NULL, product_id uuid NOT NULL, creation_xid bigint NOT NULL,
  UNIQUE(candidate_id,tenant_id,product_id,creation_xid),
  FOREIGN KEY(candidate_id,tenant_id,product_id) REFERENCES nukhabapay.catalogue_publication_candidates(candidate_id,tenant_id,product_id)
);
CREATE TABLE nukhabapay.price_submission_evidence (
  candidate_id text PRIMARY KEY, tenant_id uuid NOT NULL, product_id uuid NOT NULL, creator_staff_id uuid NOT NULL,
  creation_xid bigint NOT NULL CHECK(creation_xid=txid_current()), canonical_payload text NOT NULL,
  algorithm text NOT NULL DEFAULT 'SHA-256', canonicalization text NOT NULL DEFAULT 'BRICK4A_ORDERED_ARRAY_JSON_V1',
  issuer text NOT NULL, subject text NOT NULL, authz_version bigint NOT NULL, membership_version bigint NOT NULL,
  submitted_at timestamptz NOT NULL, CHECK(encode(sha256(convert_to(canonical_payload,'UTF8')),'hex')=candidate_id),
  UNIQUE(candidate_id,tenant_id,product_id,creator_staff_id),
  FOREIGN KEY(candidate_id,tenant_id,product_id,creation_xid)
    REFERENCES nukhabapay.price_submission_births(candidate_id,tenant_id,product_id,creation_xid)
);
CREATE TABLE nukhabapay.price_submission_events (
  candidate_id text PRIMARY KEY, tenant_id uuid NOT NULL, product_id uuid NOT NULL, creator_staff_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  FOREIGN KEY(candidate_id,tenant_id,product_id,creator_staff_id)
    REFERENCES nukhabapay.price_submission_evidence(candidate_id,tenant_id,product_id,creator_staff_id)
);
CREATE FUNCTION nukhabapay.record_fixture_submission_birth() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fixture$
BEGIN
  INSERT INTO nukhabapay.price_submission_births VALUES(NEW.candidate_id,NEW.tenant_id,NEW.product_id,txid_current());
  RETURN NEW;
END $fixture$;
REVOKE ALL ON FUNCTION nukhabapay.record_fixture_submission_birth() FROM PUBLIC;
CREATE TRIGGER fixture_submission_birth AFTER INSERT ON nukhabapay.catalogue_publication_candidates
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.record_fixture_submission_birth();
CREATE FUNCTION nukhabapay.require_fixture_submission_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fixture$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM nukhabapay.price_submission_events a
    WHERE (a.candidate_id,a.tenant_id,a.product_id,a.creator_staff_id,a.occurred_at)=
      (NEW.candidate_id,NEW.tenant_id,NEW.product_id,NEW.creator_staff_id,NEW.submitted_at))
  THEN RAISE EXCEPTION 'Missing fixture submission audit' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $fixture$;
REVOKE ALL ON FUNCTION nukhabapay.require_fixture_submission_audit() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER fixture_submission_audit AFTER INSERT ON nukhabapay.price_submission_evidence
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nukhabapay.require_fixture_submission_audit();
CREATE TABLE nukhabapay.catalogue_publication_provider_accounts (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, provider_code text NOT NULL, status text NOT NULL
);
CREATE TABLE nukhabapay.catalogue_publication_provider_snapshots (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, provider_account_id uuid NOT NULL
    REFERENCES nukhabapay.catalogue_publication_provider_accounts, status text NOT NULL,
  snapshot_key text NOT NULL, source_version text NOT NULL, observed_at timestamptz NOT NULL, completed_at timestamptz
);
CREATE TABLE nukhabapay.catalogue_publication_provider_offers (
  tenant_id uuid NOT NULL, product_id uuid NOT NULL, provider_snapshot_id uuid NOT NULL, provider_account_id uuid NOT NULL,
  provider_offer_key text NOT NULL, provider_debit_minor bigint NOT NULL, upfront_discount_minor bigint NOT NULL,
  additional_provider_fee_minor bigint NOT NULL, available boolean NOT NULL, observed_at timestamptz NOT NULL, valid_until timestamptz NOT NULL,
  PRIMARY KEY(tenant_id,product_id,provider_snapshot_id,provider_offer_key)
);
CREATE TABLE nukhabapay.price_workflow_operations (
  operation_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, product_id uuid NOT NULL, candidate_id text NOT NULL,
  idempotency_key uuid NOT NULL, command_digest text NOT NULL, actor_staff_id uuid NOT NULL, action text NOT NULL,
  issuer text NOT NULL, subject text NOT NULL, permission text NOT NULL, authz_version bigint NOT NULL,
  membership_version bigint NOT NULL, occurred_at timestamptz NOT NULL, UNIQUE(tenant_id,product_id,idempotency_key),
  FOREIGN KEY(candidate_id,tenant_id,product_id) REFERENCES nukhabapay.catalogue_publication_candidates(candidate_id,tenant_id,product_id)
);
CREATE TABLE nukhabapay.price_workflow_approvals (
  operation_id uuid PRIMARY KEY REFERENCES nukhabapay.price_workflow_operations, candidate_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL, product_id uuid NOT NULL, actor_staff_id uuid NOT NULL, candidate_digest text NOT NULL
);
CREATE TABLE nukhabapay.price_workflow_audit (
  operation_id uuid PRIMARY KEY REFERENCES nukhabapay.price_workflow_operations, tenant_id uuid NOT NULL, product_id uuid NOT NULL,
  candidate_id text NOT NULL, actor_staff_id uuid NOT NULL, action text NOT NULL, occurred_at timestamptz NOT NULL
);
ALTER TABLE nukhabapay.price_workflow_versions
  ADD COLUMN candidate_id text REFERENCES nukhabapay.price_workflow_approvals(candidate_id),
  ADD COLUMN actor_staff_id uuid, ADD COLUMN reason text,
  ADD COLUMN previous_id uuid REFERENCES nukhabapay.price_workflow_versions,
  ADD COLUMN rollback_source_id uuid REFERENCES nukhabapay.price_workflow_versions;

CREATE ROLE publication_workflow_fixture LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
DO $fixture$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['catalogue_publication_candidates','catalogue_publication_sources','price_submission_evidence',
    'catalogue_publication_requests','catalogue_publication_events','price_submission_births',
    'price_submission_events','catalogue_publication_provider_accounts','catalogue_publication_provider_snapshots',
    'catalogue_publication_provider_offers','price_workflow_operations','price_workflow_approvals','price_workflow_versions','price_workflow_audit'] LOOP
    EXECUTE format('ALTER TABLE nukhabapay.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE nukhabapay.%I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY fixture_scope ON nukhabapay.%I USING
      (tenant_id::text=current_setting(''nukhabapay.publication_tenant_id'',true))',name);
    IF name<>'price_submission_births' THEN
      EXECUTE format('GRANT SELECT ON nukhabapay.%I TO publication_workflow_fixture',name);
    END IF;
  END LOOP;
END $fixture$;
GRANT USAGE ON SCHEMA nukhabapay TO publication_workflow_fixture;
GRANT SELECT ON nukhabapay.products TO publication_workflow_fixture;
GRANT INSERT ON nukhabapay.price_workflow_operations,nukhabapay.price_workflow_approvals,nukhabapay.price_workflow_versions,
  nukhabapay.price_workflow_audit,nukhabapay.publication_delivery_outbox,nukhabapay.publication_delivery_state,
  nukhabapay.publication_delivery_audit TO publication_workflow_fixture;
GRANT USAGE ON SEQUENCE nukhabapay.publication_delivery_audit_sequence_seq TO publication_workflow_fixture;

CREATE FUNCTION nukhabapay.lock_price_workflow_sources(tenant uuid, product uuid) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fixture$
BEGIN
  IF tenant::text IS DISTINCT FROM current_setting('nukhabapay.publication_tenant_id',true) OR
     tenant::text IS DISTINCT FROM current_setting('nukhabapay.tenant_id',true)
  THEN RAISE EXCEPTION 'Fixture tenant mismatch' USING ERRCODE='42501'; END IF;
  PERFORM o.provider_snapshot_id FROM nukhabapay.catalogue_publication_provider_offers o
    WHERE o.tenant_id=tenant AND o.product_id=product;
  IF NOT FOUND THEN RAISE EXCEPTION 'Fixture source missing' USING ERRCODE='42501'; END IF;
END $fixture$;
REVOKE ALL ON FUNCTION nukhabapay.lock_price_workflow_sources(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nukhabapay.lock_price_workflow_sources(uuid,uuid) TO publication_workflow_fixture;

-- The refresh claimant, staff submission writer and publication writer have separate privileges.
CREATE ROLE publication_refresh_fixture LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
CREATE ROLE publication_submission_fixture LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
GRANT USAGE ON SCHEMA nukhabapay TO publication_refresh_fixture,publication_submission_fixture;
GRANT SELECT(id,tenant_id,status) ON nukhabapay.provider_accounts TO publication_refresh_fixture,publication_submission_fixture;
GRANT SELECT ON nukhabapay.catalogue_refresh_schedules,nukhabapay.catalogue_refresh_jobs,
  nukhabapay.catalogue_refresh_dispositions TO publication_refresh_fixture,publication_submission_fixture;
GRANT INSERT,UPDATE ON nukhabapay.catalogue_refresh_jobs TO publication_refresh_fixture;
GRANT INSERT ON nukhabapay.catalogue_refresh_audit TO publication_refresh_fixture;
GRANT USAGE ON SEQUENCE nukhabapay.catalogue_refresh_audit_id_seq TO publication_refresh_fixture;
GRANT SELECT ON nukhabapay.products,nukhabapay.catalogue_publication_provider_accounts,
  nukhabapay.catalogue_publication_provider_snapshots,nukhabapay.catalogue_publication_provider_offers TO publication_submission_fixture;
GRANT SELECT,INSERT ON nukhabapay.catalogue_publication_candidates,nukhabapay.catalogue_publication_sources,
  nukhabapay.catalogue_publication_requests,nukhabapay.catalogue_publication_events,nukhabapay.price_submission_evidence,
  nukhabapay.price_submission_events TO publication_submission_fixture;
GRANT INSERT ON nukhabapay.catalogue_refresh_write_evidence TO publication_submission_fixture;

CREATE ROLE publication_read_fixture LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
CREATE ROLE publication_read_audit_fixture LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
CREATE VIEW nukhabapay.fixture_public_catalogue WITH(security_barrier=true) AS
  WITH heads AS (
    SELECT DISTINCT ON(tenant_id,product_id) tenant_id,product_id,candidate_id,operation_id,revision
    FROM nukhabapay.price_workflow_versions
    WHERE tenant_id::text=current_setting('nukhabapay.publication_tenant_id',true)
    ORDER BY tenant_id,product_id,revision DESC
  )
  SELECT h.product_id,p.brand AS name,h.operation_id AS publication_id,c.total_amount_minor,c.valid_until
  FROM heads h JOIN nukhabapay.catalogue_publication_candidates c USING(candidate_id,tenant_id,product_id)
  JOIN nukhabapay.price_workflow_approvals a USING(candidate_id,tenant_id,product_id)
  JOIN nukhabapay.price_workflow_audit e
    ON (e.operation_id,e.tenant_id,e.product_id,e.candidate_id)=(h.operation_id,h.tenant_id,h.product_id,h.candidate_id)
  JOIN nukhabapay.products p ON p.id=h.product_id
  WHERE c.currency='AED' AND c.valid_until>nullif(current_setting('nukhabapay.catalogue_read_at',true),'')::timestamptz;
CREATE TABLE nukhabapay.fixture_public_read_audit (
  request_id uuid PRIMARY KEY,tenant_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('payment','kiosk')),
  kiosk_id uuid,client_digest text NOT NULL,catalogue_version text NOT NULL,occurred_at timestamptz NOT NULL,
  CHECK((kind='kiosk')=(kiosk_id IS NOT NULL))
);
ALTER TABLE nukhabapay.fixture_public_read_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.fixture_public_read_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY fixture_public_audit_scope ON nukhabapay.fixture_public_read_audit FOR INSERT TO publication_read_audit_fixture
  WITH CHECK(tenant_id::text=current_setting('nukhabapay.publication_tenant_id',true));
GRANT USAGE ON SCHEMA nukhabapay TO publication_read_fixture,publication_read_audit_fixture;
GRANT SELECT ON nukhabapay.fixture_public_catalogue TO publication_read_fixture;
GRANT INSERT ON nukhabapay.fixture_public_read_audit TO publication_read_audit_fixture;
