-- An observation can be reviewed even when commercial terms and a canonical mapping are pending.
CREATE TABLE nukhabapay.catalogue_discoveries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  provider_account_id uuid NOT NULL,
  source_id varchar(128) NOT NULL CHECK (source_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  source_digest char(64) NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  product_name varchar(128) NOT NULL,
  brand varchar(128) NOT NULL,
  source_country char(3) NOT NULL CHECK (source_country ~ '^[A-Z]{3}$'),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  category varchar(80) NOT NULL,
  delivery varchar(80) NOT NULL,
  denominations jsonb NOT NULL CHECK (jsonb_typeof(denominations) = 'array' AND jsonb_array_length(denominations) <= 128),
  min_amount varchar(43) NOT NULL CHECK (min_amount ~ '^(0|[1-9][0-9]{0,23})(\.[0-9]{1,18})?$'),
  max_amount varchar(43) NOT NULL CHECK (max_amount ~ '^(0|[1-9][0-9]{0,23})(\.[0-9]{1,18})?$'),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, provider_account_id)
    REFERENCES nukhabapay.provider_accounts(tenant_id, id),
  UNIQUE (tenant_id, provider_account_id, source_id, source_digest)
);

CREATE INDEX catalogue_discoveries_scope_idx
  ON nukhabapay.catalogue_discoveries (tenant_id, provider_account_id, source_id, observed_at DESC, id DESC);
ALTER TABLE nukhabapay.catalogue_discoveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.catalogue_discoveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON nukhabapay.catalogue_discoveries
  USING (tenant_id = nullif(current_setting('nukhabapay.tenant_id', true), '')::uuid);

GRANT SELECT ON nukhabapay.catalogue_discoveries TO nukhbapay_catalogue_reader, nukhbapay_catalogue_runtime;
GRANT INSERT (id, tenant_id, provider_account_id, source_id, source_digest, product_name,
  brand, source_country, currency, category, delivery, denominations, min_amount, max_amount)
  ON nukhabapay.catalogue_discoveries TO nukhbapay_catalogue_runtime;
