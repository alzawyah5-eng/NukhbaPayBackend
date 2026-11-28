ALTER TABLE nukhabapay.finxplor_customer_xe_rates RENAME TO finxplor_customer_fx_rates;
ALTER TABLE nukhabapay.finxplor_layer1_customer_prices RENAME COLUMN xe_slot_at TO fx_slot_at;
ALTER TABLE nukhabapay.finxplor_layer1_customer_prices RENAME COLUMN xe_retrieved_at TO fx_retrieved_at;
ALTER TABLE nukhabapay.finxplor_customer_fx_rates RENAME CONSTRAINT finxplor_customer_xe_rates_pkey TO finxplor_customer_fx_rates_pkey;
ALTER TRIGGER finxplor_xe_rate_immutable ON nukhabapay.finxplor_customer_fx_rates RENAME TO finxplor_fx_rate_immutable;

-- Existing rows used direct XE quotes. Currency API cross-rates retain both original USD legs.
ALTER TABLE nukhabapay.finxplor_customer_fx_rates
  ADD COLUMN rate_source text NOT NULL DEFAULT 'XE' CHECK (rate_source IN ('XE','CURRENCY_API')),
  ADD COLUMN usd_aed_rate numeric,
  ADD COLUMN usd_source_rate numeric,
  ADD CONSTRAINT finxplor_fx_rate_legs CHECK (
    (rate_source='XE' AND usd_aed_rate IS NULL AND usd_source_rate IS NULL)
    OR (rate_source='CURRENCY_API' AND usd_aed_rate IS NOT NULL AND usd_source_rate IS NOT NULL
      AND usd_aed_rate>0 AND usd_aed_rate<1e15 AND scale(usd_aed_rate)<=24
      AND usd_source_rate>0 AND usd_source_rate<1e15 AND scale(usd_source_rate)<=24
      AND (source_currency<>'USD' OR usd_source_rate=1))
  );
ALTER TABLE nukhabapay.finxplor_customer_fx_rates ALTER COLUMN rate_source DROP DEFAULT;
DROP INDEX nukhabapay.finxplor_customer_xe_one_scheduled_per_slot;
CREATE UNIQUE INDEX finxplor_customer_fx_one_scheduled_per_slot ON nukhabapay.finxplor_customer_fx_rates
  (tenant_id,provider_account_id,source_currency,slot_at,rate_source) WHERE refresh_kind='SCHEDULED';
