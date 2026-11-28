-- Expose only the latest status for a known discovery. Keep raw SKU, mapping
-- version and provenance behind the existing product_mappings grants.
CREATE VIEW nukhabapay.staff_discovery_mapping_status WITH (security_barrier=true) AS
SELECT d.tenant_id,d.provider_account_id,d.id AS discovery_id,latest.status
FROM nukhabapay.catalogue_discoveries d
JOIN LATERAL (
  SELECT m.status FROM nukhabapay.product_mappings m
  WHERE (m.tenant_id,m.provider_account_id,m.provider_sku)=(d.tenant_id,d.provider_account_id,d.source_id)
  ORDER BY m.mapping_version DESC LIMIT 1
) latest ON true
WHERE d.tenant_id=nullif(current_setting('nukhabapay.tenant_id',true),'')::uuid;

REVOKE ALL ON nukhabapay.staff_discovery_mapping_status FROM PUBLIC;
GRANT SELECT ON nukhabapay.staff_discovery_mapping_status TO nukhbapay_catalogue_reader;
