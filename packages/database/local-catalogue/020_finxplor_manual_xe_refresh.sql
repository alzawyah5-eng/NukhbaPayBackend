ALTER TABLE nukhabapay.finxplor_customer_xe_rates
  ADD COLUMN refresh_kind text NOT NULL DEFAULT 'SCHEDULED' CHECK (refresh_kind IN ('SCHEDULED','MANUAL'));
ALTER TABLE nukhabapay.finxplor_layer1_customer_prices ADD COLUMN xe_retrieved_at timestamptz;

-- Backfill the exact quote referenced by each existing conversion before changing the key.
ALTER TABLE nukhabapay.finxplor_customer_xe_rates NO FORCE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.finxplor_layer1_customer_prices NO FORCE ROW LEVEL SECURITY;
UPDATE nukhabapay.finxplor_layer1_customer_prices p SET xe_retrieved_at=r.retrieved_at
FROM nukhabapay.finxplor_customer_xe_rates r
WHERE (p.tenant_id,p.provider_account_id,p.source_currency,p.xe_slot_at)=
  (r.tenant_id,r.provider_account_id,r.source_currency,r.slot_at);
ALTER TABLE nukhabapay.finxplor_customer_xe_rates FORCE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.finxplor_layer1_customer_prices FORCE ROW LEVEL SECURITY;

DO $rate_reference$
DECLARE prior_key name;
BEGIN
  SELECT conname INTO STRICT prior_key FROM pg_constraint
  WHERE conrelid='nukhabapay.finxplor_layer1_customer_prices'::regclass
    AND confrelid='nukhabapay.finxplor_customer_xe_rates'::regclass AND contype='f';
  EXECUTE format('ALTER TABLE nukhabapay.finxplor_layer1_customer_prices DROP CONSTRAINT %I',prior_key);
END $rate_reference$;

ALTER TABLE nukhabapay.finxplor_customer_xe_rates DROP CONSTRAINT finxplor_customer_xe_rates_pkey,
  ADD PRIMARY KEY (tenant_id,provider_account_id,source_currency,slot_at,retrieved_at);
CREATE UNIQUE INDEX finxplor_customer_xe_one_scheduled_per_slot ON nukhabapay.finxplor_customer_xe_rates
  (tenant_id,provider_account_id,source_currency,slot_at) WHERE refresh_kind='SCHEDULED';

ALTER TABLE nukhabapay.finxplor_layer1_customer_prices
  ADD CONSTRAINT finxplor_customer_price_quote_time CHECK ((xe_slot_at IS NULL)=(xe_retrieved_at IS NULL)),
  ADD CONSTRAINT finxplor_customer_price_exact_quote
    FOREIGN KEY (tenant_id,provider_account_id,source_currency,xe_slot_at,xe_retrieved_at)
    REFERENCES nukhabapay.finxplor_customer_xe_rates(tenant_id,provider_account_id,source_currency,slot_at,retrieved_at);
GRANT INSERT (xe_retrieved_at), UPDATE (xe_retrieved_at)
  ON nukhabapay.finxplor_layer1_customer_prices TO nukhbapay_catalogue_runtime;
