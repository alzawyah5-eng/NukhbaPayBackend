-- Executed in the same transaction as the registered catalogue foundation.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE nukhbapay_catalogue_migrator IN SCHEMA nukhabapay
  REVOKE SELECT ON TABLES FROM nukhbapay_catalogue_reader, nukhbapay_catalogue_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE nukhbapay_catalogue_migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nukhabapay FROM PUBLIC;

REVOKE SELECT ON ALL TABLES IN SCHEMA nukhabapay FROM nukhbapay_catalogue_reader, nukhbapay_catalogue_runtime;
GRANT SELECT (id) ON nukhabapay.tenants TO nukhbapay_catalogue_reader, nukhbapay_catalogue_runtime;
GRANT SELECT ON nukhabapay.products TO nukhbapay_catalogue_reader, nukhbapay_catalogue_runtime;
GRANT SELECT (id, tenant_id, provider_code, status) ON nukhabapay.provider_accounts TO nukhbapay_catalogue_reader;
GRANT SELECT (id, tenant_id, provider_code, external_account_key, status)
  ON nukhabapay.provider_accounts TO nukhbapay_catalogue_runtime;
GRANT SELECT ON nukhabapay.provider_snapshots, nukhabapay.provider_offers
  TO nukhbapay_catalogue_reader, nukhbapay_catalogue_runtime;
GRANT SELECT (id, tenant_id, provider_account_id, product_id, status) ON nukhabapay.product_mappings TO nukhbapay_catalogue_reader;
GRANT SELECT ON nukhabapay.product_mappings TO nukhbapay_catalogue_runtime;

ALTER TABLE nukhabapay.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON nukhabapay.tenants
  USING (id = nullif(current_setting('nukhabapay.tenant_id', true), '')::uuid);

DO $policies$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['provider_accounts', 'provider_snapshots', 'product_mappings', 'provider_offers'] LOOP
    EXECUTE format('ALTER TABLE nukhabapay.%I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('ALTER TABLE nukhabapay.%I FORCE ROW LEVEL SECURITY', relation);
    EXECUTE format($policy$CREATE POLICY tenant_scope ON nukhabapay.%I
      USING (tenant_id = nullif(current_setting('nukhabapay.tenant_id', true), '')::uuid)$policy$, relation);
  END LOOP;
END
$policies$;

ALTER TABLE nukhabapay.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.products FORCE ROW LEVEL SECURITY;
CREATE POLICY approved_product_scope ON nukhabapay.products FOR SELECT
  TO nukhbapay_catalogue_reader, nukhbapay_catalogue_runtime
  USING (EXISTS (
    SELECT 1 FROM nukhabapay.product_mappings m
    WHERE m.product_id = products.id AND m.status = 'APPROVED'
  ));
CREATE POLICY migration_product_scope ON nukhabapay.products TO nukhbapay_catalogue_migrator
  USING (true) WITH CHECK (true);
