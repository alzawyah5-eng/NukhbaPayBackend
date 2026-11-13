-- PROPOSED, UNREGISTERED 007. Synthetic draft evidence only; no publication activation.
DO $gate$
BEGIN
  IF current_user<>'nukhabapay_migrator'
    OR current_database() !~ '^nukhabapay_b3b3_[0-9a-f]{32}$'
    OR COALESCE(host(inet_server_addr()),'') NOT IN ('127.0.0.1','::1')
    OR inet_server_port() IS DISTINCT FROM 5432
    OR current_setting('nukhbapay.publication_migration',true) IS DISTINCT FROM 'BRICK_4A_SYNTHETIC'
    OR (SELECT array_agg(name ORDER BY id) FROM nukhabapay.schema_migrations) IS DISTINCT FROM
      ARRAY['001_catalog','002_import_role_privileges','003_import_role_read_access','004_staff_identity_foundation','005_staff_workflow_persistence','006_staff_server_sessions']::varchar[]
    OR EXISTS(
      SELECT 1 FROM pg_namespace n
      CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
      WHERE n.nspname='nukhabapay' AND a.grantee<>n.nspowner
        AND (pg_get_userbyid(a.grantee) NOT IN ('nukhabapay_runtime','nukhabapay_importer','nukhabapay_identity_reader','nukhabapay_identity_writer')
          OR a.privilege_type<>'USAGE' OR a.is_grantable)
    )
    OR EXISTS(
      SELECT 1 FROM pg_default_acl d
      CROSS JOIN LATERAL aclexplode(d.defaclacl) a
      WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND a.grantee<>d.defaclrole
    ) THEN
    RAISE EXCEPTION 'Unapproved catalogue publication draft target' USING ERRCODE='42501';
  END IF;
END $gate$;

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
  snapshot_id uuid NOT NULL REFERENCES nukhabapay.provider_snapshots(id),
  provider_account_id uuid NOT NULL REFERENCES nukhabapay.provider_accounts(id),
  snapshot_key text NOT NULL CHECK(length(snapshot_key) BETWEEN 1 AND 128),
  source_version text NOT NULL CHECK(length(source_version) BETWEEN 1 AND 128),
  observed_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL CHECK(completed_at>=observed_at),
  source_status text NOT NULL CHECK(source_status='COMPLETE'),
  execution text NOT NULL DEFAULT 'NOT_AUTHORIZED' CHECK(execution='NOT_AUTHORIZED'),
  PRIMARY KEY(candidate_id,snapshot_id),
  FOREIGN KEY(candidate_id,tenant_id,product_id) REFERENCES nukhabapay.catalogue_publication_candidates(candidate_id,tenant_id,product_id)
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
  FOREIGN KEY(candidate_id,tenant_id,product_id) REFERENCES nukhabapay.catalogue_publication_candidates(candidate_id,tenant_id,product_id)
);

CREATE TABLE nukhabapay.catalogue_publication_events (
  event_id uuid PRIMARY KEY,
  operation_id text NOT NULL,
  candidate_id text NOT NULL,
  tenant_id uuid NOT NULL,
  product_id uuid NOT NULL,
  price_version bigint NOT NULL,
  candidate_digest text NOT NULL CHECK(candidate_digest=candidate_id),
  event_name text NOT NULL CHECK(event_name='CATALOGUE_PUBLICATION_CANDIDATE_CREATED'),
  occurred_at timestamptz NOT NULL,
  execution text NOT NULL DEFAULT 'NOT_AUTHORIZED' CHECK(execution='NOT_AUTHORIZED'),
  UNIQUE(candidate_id,event_name),
  FOREIGN KEY(operation_id,tenant_id,product_id,candidate_id) REFERENCES nukhabapay.catalogue_publication_requests(operation_id,tenant_id,product_id,candidate_id),
  FOREIGN KEY(candidate_id,tenant_id,product_id) REFERENCES nukhabapay.catalogue_publication_candidates(candidate_id,tenant_id,product_id)
);

CREATE VIEW nukhabapay.catalogue_publication_provider_accounts WITH (security_barrier=true) AS
  SELECT id,tenant_id,provider_code,status FROM nukhabapay.provider_accounts
  WHERE tenant_id::text=current_setting('nukhabapay.publication_tenant_id',true);
CREATE VIEW nukhabapay.catalogue_publication_provider_snapshots WITH (security_barrier=true) AS
  SELECT id,tenant_id,provider_account_id,snapshot_key,source_version,observed_at,status,completed_at FROM nukhabapay.provider_snapshots
  WHERE tenant_id::text=current_setting('nukhabapay.publication_tenant_id',true);
CREATE VIEW nukhabapay.catalogue_publication_provider_offers WITH (security_barrier=true) AS
  SELECT id,tenant_id,provider_account_id,provider_snapshot_id,product_id,provider_offer_key,provider_debit_minor,
    additional_provider_fee_minor,upfront_discount_minor,available,observed_at,valid_until FROM nukhabapay.provider_offers
  WHERE tenant_id::text=current_setting('nukhabapay.publication_tenant_id',true);
REVOKE ALL ON nukhabapay.catalogue_publication_provider_accounts,nukhabapay.catalogue_publication_provider_snapshots,
  nukhabapay.catalogue_publication_provider_offers FROM PUBLIC,nukhabapay_runtime,nukhabapay_importer,nukhabapay_identity_reader,nukhabapay_identity_writer;

DO $security$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['catalogue_publication_candidates','catalogue_publication_sources','catalogue_publication_requests','catalogue_publication_events'] LOOP
    EXECUTE format('ALTER TABLE nukhabapay.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE nukhabapay.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY publication_tenant_scope ON nukhabapay.%I USING (tenant_id::text=current_setting(''nukhabapay.publication_tenant_id'',true)) WITH CHECK (tenant_id::text=current_setting(''nukhabapay.publication_tenant_id'',true))',table_name);
    EXECUTE format('REVOKE ALL ON nukhabapay.%I FROM PUBLIC,nukhabapay_runtime,nukhabapay_importer,nukhabapay_identity_reader,nukhabapay_identity_writer',table_name);
  END LOOP;
END $security$;

CREATE FUNCTION nukhabapay.reject_publication_evidence_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $body$
BEGIN RAISE EXCEPTION 'Immutable publication evidence' USING ERRCODE='42501'; END $body$;
REVOKE ALL ON FUNCTION nukhabapay.reject_publication_evidence_mutation() FROM PUBLIC,nukhabapay_runtime,nukhabapay_importer,nukhabapay_identity_reader,nukhabapay_identity_writer;
DO $triggers$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['catalogue_publication_candidates','catalogue_publication_sources','catalogue_publication_requests','catalogue_publication_events'] LOOP
    EXECUTE format('CREATE TRIGGER publication_immutable BEFORE UPDATE OR DELETE ON nukhabapay.%I FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_publication_evidence_mutation()',table_name);
  END LOOP;
END $triggers$;

CREATE FUNCTION nukhabapay.check_publication_candidate_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $body$
BEGIN
  IF (SELECT count(*) FROM nukhabapay.catalogue_publication_sources WHERE candidate_id=NEW.candidate_id)<>NEW.source_count
    OR NOT EXISTS(SELECT 1 FROM nukhabapay.catalogue_publication_requests WHERE candidate_id=NEW.candidate_id)
    OR NOT EXISTS(SELECT 1 FROM nukhabapay.catalogue_publication_events WHERE candidate_id=NEW.candidate_id AND event_name='CATALOGUE_PUBLICATION_CANDIDATE_CREATED')
    OR NOT EXISTS(SELECT 1 FROM nukhabapay.catalogue_publication_sources WHERE candidate_id=NEW.candidate_id AND snapshot_id=NEW.selected_snapshot_id) THEN
    RAISE EXCEPTION 'Incomplete publication candidate evidence' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $body$;
REVOKE ALL ON FUNCTION nukhabapay.check_publication_candidate_complete() FROM PUBLIC,nukhabapay_runtime,nukhabapay_importer,nukhabapay_identity_reader,nukhabapay_identity_writer;
CREATE CONSTRAINT TRIGGER publication_candidate_complete AFTER INSERT ON nukhabapay.catalogue_publication_candidates
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nukhabapay.check_publication_candidate_complete();

DO $acl$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.relnamespace='nukhabapay'::regnamespace AND c.relname LIKE 'catalogue_publication_%' AND a.grantee<>c.relowner)
    OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.pronamespace='nukhabapay'::regnamespace AND p.proname LIKE '%publication%' AND a.grantee<>p.proowner) THEN
    RAISE EXCEPTION 'Unexpected publication default grant' USING ERRCODE='42501';
  END IF;
END $acl$;
