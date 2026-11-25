-- A complete scan selects the current immutable observations for one account.
ALTER TABLE nukhabapay.catalogue_discoveries ADD UNIQUE (tenant_id, provider_account_id, id);

CREATE TABLE nukhabapay.catalogue_discovery_scans (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  provider_account_id uuid NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
  FOREIGN KEY (tenant_id, provider_account_id) REFERENCES nukhabapay.provider_accounts(tenant_id, id),
  UNIQUE (tenant_id, provider_account_id, id)
);

CREATE INDEX catalogue_discovery_scans_scope_idx
  ON nukhabapay.catalogue_discovery_scans (tenant_id, provider_account_id, completed_at DESC, id DESC);

CREATE TABLE nukhabapay.catalogue_discovery_scan_items (
  tenant_id uuid NOT NULL,
  provider_account_id uuid NOT NULL,
  scan_id uuid NOT NULL,
  discovery_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, provider_account_id, scan_id, discovery_id),
  FOREIGN KEY (tenant_id, provider_account_id, scan_id)
    REFERENCES nukhabapay.catalogue_discovery_scans(tenant_id, provider_account_id, id),
  FOREIGN KEY (tenant_id, provider_account_id, discovery_id)
    REFERENCES nukhabapay.catalogue_discoveries(tenant_id, provider_account_id, id)
);

ALTER TABLE nukhabapay.catalogue_discovery_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.catalogue_discovery_scans FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON nukhabapay.catalogue_discovery_scans
  USING (tenant_id = nullif(current_setting('nukhabapay.tenant_id', true), '')::uuid);

ALTER TABLE nukhabapay.catalogue_discovery_scan_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.catalogue_discovery_scan_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON nukhabapay.catalogue_discovery_scan_items
  USING (tenant_id = nullif(current_setting('nukhabapay.tenant_id', true), '')::uuid)
  WITH CHECK (
    tenant_id = nullif(current_setting('nukhabapay.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM nukhabapay.catalogue_discovery_scans s
      WHERE (s.tenant_id, s.provider_account_id, s.id) =
        (catalogue_discovery_scan_items.tenant_id, catalogue_discovery_scan_items.provider_account_id, catalogue_discovery_scan_items.scan_id)
        AND s.created_by_transaction = pg_current_xact_id()
    )
  );

GRANT SELECT ON nukhabapay.catalogue_discovery_scans, nukhabapay.catalogue_discovery_scan_items
  TO nukhbapay_catalogue_reader, nukhbapay_catalogue_runtime;
GRANT INSERT (id, tenant_id, provider_account_id) ON nukhabapay.catalogue_discovery_scans TO nukhbapay_catalogue_runtime;
GRANT INSERT (tenant_id, provider_account_id, scan_id, discovery_id)
  ON nukhabapay.catalogue_discovery_scan_items TO nukhbapay_catalogue_runtime;
