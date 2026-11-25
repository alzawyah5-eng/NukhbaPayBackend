-- Record the deterministic admission result alongside each immutable observation.
-- A country or currency outside the current priced catalogue reaches review without a model call.
ALTER TABLE nukhabapay.catalogue_discoveries
  ADD COLUMN review_reason text GENERATED ALWAYS AS (
    CASE WHEN source_country <> 'ARE' OR currency <> 'AED' OR lower(category) <> 'gift card'
      THEN 'OUTSIDE_PRICED_CATALOGUE_SCOPE' ELSE 'CANONICAL_MAPPING_REQUIRED' END
  ) STORED;
