-- Keep v1 rows immutable. The existing two-decimal column is a staff display projection.
ALTER TABLE nukhabapay.layer1_results
  DROP CONSTRAINT layer1_results_aed_amount_check,
  ADD CONSTRAINT layer1_results_display_aed_ck
    CHECK (aed_amount>=0 AND aed_amount<=1000000 AND scale(aed_amount)=2),
  ADD CONSTRAINT layer1_results_exact_aed_ck CHECK (
    calculator_version<>'aed-acquisition-v2' OR CASE
      WHEN jsonb_typeof(calculation->'exactAmount')='string'
        AND calculation->>'exactAmount' ~ '^(0|[1-9][0-9]{0,6})([.][0-9]{1,20})?$'
      THEN ((calculation->>'exactAmount')::numeric>0
        AND round((calculation->>'exactAmount')::numeric,2)=aed_amount
        AND calculation->>'displayAmount'=aed_amount::text
        AND calculation->>'roundingBoundary'='DISPLAY_ONLY') IS TRUE
      ELSE false END
  );
