-- Layer 1 customer-price conversion. Acquisition cost is reserved and remains NULL.
CREATE TABLE nukhabapay.finxplor_customer_xe_rates (
  tenant_id uuid NOT NULL, provider_account_id uuid NOT NULL,
  source_currency varchar(3) NOT NULL CHECK (source_currency ~ '^[A-Z]{3}$' AND source_currency<>'AED'),
  slot_at timestamptz NOT NULL, source_effective_at timestamptz NOT NULL, retrieved_at timestamptz NOT NULL,
  aed_per_unit numeric NOT NULL CHECK (aed_per_unit>0 AND aed_per_unit<1e12 AND scale(aed_per_unit)<=12),
  PRIMARY KEY (tenant_id,provider_account_id,source_currency,slot_at),
  FOREIGN KEY (tenant_id,provider_account_id) REFERENCES nukhabapay.provider_accounts(tenant_id,id),
  CHECK (isfinite(slot_at) AND isfinite(source_effective_at) AND isfinite(retrieved_at)
    AND (extract(epoch FROM slot_at)::bigint+14400)%43200=0
    AND source_effective_at<=retrieved_at AND retrieved_at-source_effective_at<=interval '72 hours'
    AND slot_at<=retrieved_at AND retrieved_at<slot_at+interval '12 hours')
);

CREATE TABLE nukhabapay.finxplor_layer1_customer_prices (
  tenant_id uuid NOT NULL, provider_account_id uuid NOT NULL, discovery_id uuid NOT NULL,
  basis text NOT NULL CHECK (basis IN ('CUSTOMER_PRICE','DENOMINATION','FACE_MIN','FACE_MAX')),
  source_key varchar(128) NOT NULL, source_reference varchar(128) NOT NULL,
  source_currency varchar(3) NOT NULL CHECK (source_currency ~ '^[A-Z]{3}$'),
  source_amount numeric NOT NULL CHECK (source_amount>0 AND source_amount<1e15 AND scale(source_amount)<=8),
  price_observed_at timestamptz NOT NULL, price_valid_until timestamptz,
  converted_aed numeric CHECK (converted_aed>0 AND converted_aed<1e27 AND scale(converted_aed)<=20),
  xe_slot_at timestamptz,
  acquisition_cost_aed numeric CHECK (acquisition_cost_aed IS NULL),
  PRIMARY KEY (tenant_id,provider_account_id,discovery_id,basis,source_key),
  FOREIGN KEY (tenant_id,provider_account_id,discovery_id)
    REFERENCES nukhabapay.catalogue_discoveries(tenant_id,provider_account_id,id),
  FOREIGN KEY (tenant_id,provider_account_id,source_currency,xe_slot_at)
    REFERENCES nukhabapay.finxplor_customer_xe_rates(tenant_id,provider_account_id,source_currency,slot_at),
  CHECK (isfinite(price_observed_at) AND (price_valid_until IS NULL OR
    (isfinite(price_valid_until) AND price_valid_until>price_observed_at))),
  CHECK ((basis='CUSTOMER_PRICE')=(price_valid_until IS NOT NULL)),
  CHECK ((source_currency='AED' AND xe_slot_at IS NULL AND converted_aed IS NOT NULL AND converted_aed=source_amount)
    OR (source_currency<>'AED' AND (xe_slot_at IS NULL)=(converted_aed IS NULL)))
);

DO $prices$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['finxplor_customer_xe_rates','finxplor_layer1_customer_prices'] LOOP
    EXECUTE format('ALTER TABLE nukhabapay.%I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE nukhabapay.%I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format($policy$CREATE POLICY finxplor_price_read ON nukhabapay.%I FOR SELECT
      TO nukhbapay_catalogue_reader,nukhbapay_catalogue_runtime
      USING (tenant_id::text=current_setting('nukhabapay.tenant_id',true))$policy$,relation);
    EXECUTE format($policy$CREATE POLICY finxplor_price_insert ON nukhabapay.%1$I FOR INSERT
      TO nukhbapay_catalogue_runtime WITH CHECK (
        tenant_id::text=current_setting('nukhabapay.tenant_id',true)
        AND provider_account_id::text=current_setting('nukhabapay.finxplor_price_account',true)
        AND EXISTS (SELECT FROM nukhabapay.provider_accounts a
          WHERE (a.tenant_id,a.id)=(%1$I.tenant_id,%1$I.provider_account_id) AND a.provider_code='FINXPLOR'))$policy$,relation);
    EXECUTE format('REVOKE ALL ON nukhabapay.%I FROM PUBLIC',relation);
    EXECUTE format('GRANT SELECT ON nukhabapay.%I TO nukhbapay_catalogue_reader,nukhbapay_catalogue_runtime',relation);
  END LOOP;
END $prices$;
CREATE POLICY finxplor_price_update ON nukhabapay.finxplor_layer1_customer_prices FOR UPDATE
  TO nukhbapay_catalogue_runtime USING (
    tenant_id::text=current_setting('nukhabapay.tenant_id',true)
    AND provider_account_id::text=current_setting('nukhabapay.finxplor_price_account',true)
  ) WITH CHECK (
    tenant_id::text=current_setting('nukhabapay.tenant_id',true)
    AND provider_account_id::text=current_setting('nukhabapay.finxplor_price_account',true)
    AND EXISTS (SELECT FROM nukhabapay.provider_accounts a
      WHERE (a.tenant_id,a.id)=(finxplor_layer1_customer_prices.tenant_id,finxplor_layer1_customer_prices.provider_account_id)
        AND a.provider_code='FINXPLOR')
  );
GRANT INSERT ON nukhabapay.finxplor_customer_xe_rates TO nukhbapay_catalogue_runtime;
GRANT INSERT (tenant_id,provider_account_id,discovery_id,basis,source_key,source_reference,source_currency,
  source_amount,price_observed_at,price_valid_until,converted_aed,xe_slot_at)
  ON nukhabapay.finxplor_layer1_customer_prices TO nukhbapay_catalogue_runtime;
GRANT UPDATE (source_reference,source_currency,source_amount,price_observed_at,price_valid_until,converted_aed,xe_slot_at)
  ON nukhabapay.finxplor_layer1_customer_prices TO nukhbapay_catalogue_runtime;
CREATE TRIGGER finxplor_xe_rate_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON nukhabapay.finxplor_customer_xe_rates
  FOR EACH STATEMENT EXECUTE FUNCTION nukhabapay.reject_publication_evidence_mutation();
