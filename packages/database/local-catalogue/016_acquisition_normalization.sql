-- Local catalogue Layer 1 storage. Dedicated roles are enrolled separately.
DO $target$
BEGIN
  IF current_database() <> 'nukhbapay_catalogue' OR current_user <> 'nukhbapay_catalogue_migrator' THEN
    RAISE EXCEPTION 'Unexpected Layer 1 migration target' USING ERRCODE='42501';
  END IF;
END
$target$;
ALTER TABLE nukhabapay.provider_offers ADD CONSTRAINT layer1_offer_scope_uq
  UNIQUE (tenant_id,provider_account_id,id,provider_snapshot_id,provider_offer_key);

CREATE TABLE nukhabapay.layer1_account_grants (
  login_role name NOT NULL,
  tenant_id uuid NOT NULL,
  provider_account_id uuid NOT NULL,
  PRIMARY KEY (login_role,tenant_id,provider_account_id),
  FOREIGN KEY (tenant_id,provider_account_id) REFERENCES nukhabapay.provider_accounts(tenant_id,id)
);
ALTER TABLE nukhabapay.layer1_account_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.layer1_account_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY layer1_own_grants ON nukhabapay.layer1_account_grants FOR SELECT USING (login_role=current_user);
CREATE POLICY layer1_manage_grants ON nukhabapay.layer1_account_grants
  TO nukhbapay_catalogue_migrator USING (true) WITH CHECK (true);

-- Unconstrained NUMERIC with CHECKs rejects excess scale instead of rounding on assignment.
CREATE TABLE nukhabapay.layer1_cost_snapshots (
  tenant_id uuid NOT NULL, provider_account_id uuid NOT NULL, id uuid NOT NULL,
  offer_version_id uuid NOT NULL, catalogue_id uuid NOT NULL, offer_key varchar(128) NOT NULL,
  observed_at timestamptz NOT NULL, retrieved_at timestamptz NOT NULL, valid_until timestamptz NOT NULL,
  acquisition_amount numeric NOT NULL CHECK (acquisition_amount > 0 AND acquisition_amount < 1e15 AND scale(acquisition_amount) BETWEEN 0 AND 8),
  face_amount numeric NOT NULL CHECK (face_amount > 0 AND face_amount < 1e15 AND scale(face_amount) BETWEEN 0 AND 8),
  evidence jsonb NOT NULL,
  PRIMARY KEY (tenant_id,provider_account_id,id),
  FOREIGN KEY (tenant_id,provider_account_id,offer_version_id,catalogue_id,offer_key)
    REFERENCES nukhabapay.provider_offers(tenant_id,provider_account_id,id,provider_snapshot_id,provider_offer_key),
  CHECK ((evidence->'acquisition'->>'amount'=acquisition_amount::text AND
    evidence->'faceValue'->>'amount'=face_amount::text) IS TRUE),
  CHECK (isfinite(observed_at) AND isfinite(retrieved_at) AND isfinite(valid_until) AND observed_at<=retrieved_at AND retrieved_at<valid_until)
);
CREATE INDEX layer1_offer_cost_history ON nukhabapay.layer1_cost_snapshots
  (tenant_id,provider_account_id,offer_key,observed_at DESC,retrieved_at DESC,id DESC);

CREATE TABLE nukhabapay.layer1_policies (
  tenant_id uuid NOT NULL, provider_account_id uuid NOT NULL, version varchar(128) NOT NULL,
  revision integer NOT NULL CHECK (revision>0), policy jsonb NOT NULL,
  PRIMARY KEY (tenant_id,provider_account_id,version),
  UNIQUE (tenant_id,provider_account_id,revision),
  FOREIGN KEY (tenant_id,provider_account_id) REFERENCES nukhabapay.provider_accounts(tenant_id,id)
);

CREATE TABLE nukhabapay.layer1_fx_snapshots (
  tenant_id uuid NOT NULL, provider_account_id uuid NOT NULL, id varchar(160) NOT NULL,
  policy_version varchar(128) NOT NULL,
  effective_at timestamptz NOT NULL, retrieved_at timestamptz NOT NULL, valid_until timestamptz NOT NULL,
  rate numeric NOT NULL CHECK (rate>0 AND rate<1e12 AND scale(rate) BETWEEN 0 AND 12),
  evidence jsonb NOT NULL,
  PRIMARY KEY (tenant_id,provider_account_id,id,policy_version),
  FOREIGN KEY (tenant_id,provider_account_id,policy_version) REFERENCES nukhabapay.layer1_policies(tenant_id,provider_account_id,version),
  CHECK ((evidence->>'rate'=rate::text AND evidence->>'direction'='AED_PER_SOURCE_UNIT'
    AND evidence->>'targetCurrency'='AED' AND CASE evidence->>'basis'
      WHEN 'AED_IDENTITY' THEN evidence->>'sourceCurrency'='AED' AND rate=1
      WHEN 'APPROVED_DIRECT' THEN evidence->>'sourceCurrency'~'^[A-Z]{3}$' AND evidence->>'sourceCurrency'<>'AED'
      ELSE false END) IS TRUE),
  CHECK (isfinite(effective_at) AND isfinite(retrieved_at) AND isfinite(valid_until) AND effective_at<=retrieved_at AND retrieved_at<valid_until)
);

CREATE TABLE nukhabapay.layer1_results (
  tenant_id uuid NOT NULL, provider_account_id uuid NOT NULL, id uuid NOT NULL,
  cost_snapshot_id uuid NOT NULL, fx_snapshot_id varchar(160) NOT NULL,
  policy_version varchar(128) NOT NULL, calculator_version varchar(128) NOT NULL,
  normalized_at timestamptz NOT NULL, valid_until timestamptz NOT NULL,
  aed_amount numeric NOT NULL CHECK (aed_amount>0 AND aed_amount<=1000000 AND scale(aed_amount)=2),
  calculation jsonb NOT NULL,
  PRIMARY KEY (tenant_id,provider_account_id,id),
  UNIQUE (tenant_id,provider_account_id,cost_snapshot_id,fx_snapshot_id,policy_version,calculator_version),
  FOREIGN KEY (tenant_id,provider_account_id,cost_snapshot_id) REFERENCES nukhabapay.layer1_cost_snapshots(tenant_id,provider_account_id,id),
  FOREIGN KEY (tenant_id,provider_account_id,fx_snapshot_id,policy_version)
    REFERENCES nukhabapay.layer1_fx_snapshots(tenant_id,provider_account_id,id,policy_version),
  CHECK ((calculation->>'amount'=aed_amount::text AND calculation->>'currency'='AED'
    AND calculation->>'calculatorVersion'=calculator_version) IS TRUE),
  CHECK (isfinite(normalized_at) AND isfinite(valid_until) AND normalized_at<valid_until)
);

CREATE TABLE nukhabapay.layer1_outbox (
  tenant_id uuid NOT NULL, provider_account_id uuid NOT NULL, event_id uuid NOT NULL, result_id uuid NOT NULL,
  envelope jsonb NOT NULL, next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt>=0),
  lease uuid, lease_until timestamptz, delivered_at timestamptz,
  PRIMARY KEY (tenant_id,provider_account_id,event_id),
  UNIQUE (tenant_id,provider_account_id,result_id),
  FOREIGN KEY (tenant_id,provider_account_id,result_id) REFERENCES nukhabapay.layer1_results(tenant_id,provider_account_id,id),
  CHECK ((envelope->>'event_id'=event_id::text AND envelope->>'tenant_id'=tenant_id::text
    AND envelope->>'provider_account_id'=provider_account_id::text AND envelope->>'result_id'=result_id::text
    AND envelope->>'type'='provider.acquisition-cost.normalized.v1') IS TRUE),
  CHECK ((lease IS NULL)=(lease_until IS NULL)), CHECK (delivered_at IS NULL OR lease IS NULL)
);
CREATE INDEX layer1_delivery_due ON nukhabapay.layer1_outbox (tenant_id,provider_account_id,next_attempt_at)
  WHERE delivered_at IS NULL;

CREATE TABLE nukhabapay.layer1_inbox (
  tenant_id uuid NOT NULL, provider_account_id uuid NOT NULL, event_id uuid NOT NULL,
  consumer varchar(128) NOT NULL, consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,provider_account_id,event_id,consumer),
  FOREIGN KEY (tenant_id,provider_account_id,event_id) REFERENCES nukhabapay.layer1_outbox(tenant_id,provider_account_id,event_id)
);

DO $layer1$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['layer1_cost_snapshots','layer1_policies','layer1_fx_snapshots','layer1_results','layer1_outbox','layer1_inbox'] LOOP
    EXECUTE format('ALTER TABLE nukhabapay.%I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE nukhabapay.%I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format($policy$CREATE POLICY layer1_scoped ON nukhabapay.%1$I USING (
      tenant_id::text=current_setting('nukhabapay.tenant_id',true)
      AND provider_account_id::text=current_setting('nukhabapay.layer1_account_id',true)
      AND EXISTS(SELECT FROM nukhabapay.layer1_account_grants g
        WHERE g.login_role=current_user AND g.tenant_id=%1$I.tenant_id AND g.provider_account_id=%1$I.provider_account_id)
    )$policy$,relation);
    EXECUTE format('REVOKE ALL ON nukhabapay.%I FROM PUBLIC,nukhbapay_catalogue_reader,nukhbapay_catalogue_runtime',relation);
    IF relation <> 'layer1_outbox' THEN
      EXECUTE format('CREATE TRIGGER layer1_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON nukhabapay.%I
        FOR EACH STATEMENT EXECUTE FUNCTION nukhabapay.reject_publication_evidence_mutation()',relation);
    END IF;
  END LOOP;
END
$layer1$;
REVOKE ALL ON nukhabapay.layer1_account_grants FROM PUBLIC,nukhbapay_catalogue_reader,nukhbapay_catalogue_runtime;

-- Bind source metadata to the authenticated database login as well as the requested account.
-- The Layer 1 login needs no grants on the underlying catalogue tables.
CREATE VIEW nukhabapay.layer1_active_accounts WITH (security_barrier=true) AS
SELECT a.tenant_id,a.id AS provider_account_id
FROM nukhabapay.provider_accounts a
JOIN nukhabapay.layer1_account_grants g ON (g.tenant_id,g.provider_account_id)=(a.tenant_id,a.id)
WHERE a.status='ACTIVE' AND g.login_role=session_user
  AND a.tenant_id::text=current_setting('nukhabapay.tenant_id',true)
  AND a.id::text=current_setting('nukhabapay.layer1_account_id',true);

CREATE VIEW nukhabapay.layer1_source_offers WITH (security_barrier=true) AS
SELECT o.id,o.tenant_id,o.provider_account_id,o.provider_snapshot_id,o.provider_offer_key,
  o.observed_at,o.valid_until,o.available,s.source_version,s.status AS catalogue_status
FROM nukhabapay.layer1_active_accounts a
JOIN nukhabapay.provider_offers o ON (o.tenant_id,o.provider_account_id)=(a.tenant_id,a.provider_account_id)
JOIN nukhabapay.provider_snapshots s
  ON (o.tenant_id,o.provider_account_id,o.provider_snapshot_id)=(s.tenant_id,s.provider_account_id,s.id);

REVOKE ALL ON nukhabapay.layer1_active_accounts,nukhabapay.layer1_source_offers
  FROM PUBLIC,nukhbapay_catalogue_reader,nukhbapay_catalogue_runtime;
