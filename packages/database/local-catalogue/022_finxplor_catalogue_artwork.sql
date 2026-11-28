CREATE TABLE nukhabapay.finxplor_catalogue_artwork (
  tenant_id uuid NOT NULL,
  provider_account_id uuid NOT NULL,
  discovery_id uuid NOT NULL,
  image_url text NOT NULL CHECK (
    length(image_url) <= 2048 AND
    image_url ~ '^https://finxplorconnect[.]com/api/v1/media/[A-Za-z0-9_+/=-]+$'
  ),
  observed_at timestamptz NOT NULL CHECK (isfinite(observed_at)),
  PRIMARY KEY (tenant_id,provider_account_id,discovery_id),
  FOREIGN KEY (tenant_id,provider_account_id,discovery_id)
    REFERENCES nukhabapay.catalogue_discoveries(tenant_id,provider_account_id,id)
);
ALTER TABLE nukhabapay.finxplor_catalogue_artwork ENABLE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.finxplor_catalogue_artwork FORCE ROW LEVEL SECURITY;
CREATE POLICY finxplor_artwork_read ON nukhabapay.finxplor_catalogue_artwork FOR SELECT
  TO nukhbapay_catalogue_runtime,nukhbapay_catalogue_reader
  USING (tenant_id::text=current_setting('nukhabapay.tenant_id',true));
CREATE POLICY finxplor_artwork_write ON nukhabapay.finxplor_catalogue_artwork FOR ALL
  TO nukhbapay_catalogue_runtime USING (tenant_id::text=current_setting('nukhabapay.tenant_id',true))
  WITH CHECK (tenant_id::text=current_setting('nukhabapay.tenant_id',true) AND EXISTS (
    SELECT FROM nukhabapay.provider_accounts a
    WHERE (a.tenant_id,a.id)=(finxplor_catalogue_artwork.tenant_id,finxplor_catalogue_artwork.provider_account_id)
      AND a.provider_code='FINXPLOR'
  ));
REVOKE ALL ON nukhabapay.finxplor_catalogue_artwork FROM PUBLIC;
GRANT SELECT ON nukhabapay.finxplor_catalogue_artwork TO nukhbapay_catalogue_runtime,nukhbapay_catalogue_reader;
GRANT INSERT, UPDATE (image_url,observed_at) ON nukhabapay.finxplor_catalogue_artwork TO nukhbapay_catalogue_runtime;
