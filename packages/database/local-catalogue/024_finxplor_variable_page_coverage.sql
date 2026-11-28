ALTER TABLE nukhabapay.catalogue_discovery_scans DROP CONSTRAINT admitted_discovery_coverage;
ALTER TABLE nukhabapay.catalogue_discovery_scans ADD CONSTRAINT admitted_discovery_coverage CHECK (
  coverage_scope IN ('ARE_GIFT_CARD','ALL_COUNTRIES','PARTIAL_ALL_COUNTRIES') AND coverage_scope IS NOT NULL
  AND product_count BETWEEN 1 AND 100000 AND product_count IS NOT NULL
  AND page_count IS NOT NULL AND (
    (coverage_scope='PARTIAL_ALL_COUNTRIES' AND page_count BETWEEN 1 AND 1000
      AND product_count BETWEEN page_count AND page_count*100)
    OR (coverage_scope='ALL_COUNTRIES' AND page_count BETWEEN 2 AND 1000
      AND product_count BETWEEN page_count-1 AND (page_count-1)*100)
    OR (coverage_scope='ARE_GIFT_CARD' AND page_count=(product_count+99)/100+1))
  AND source_observed_at IS NOT NULL AND isfinite(source_observed_at) AND source_observed_at<=completed_at
  AND scan_digest IS NOT NULL AND scan_digest ~ '^[a-f0-9]{64}$') NOT VALID;
