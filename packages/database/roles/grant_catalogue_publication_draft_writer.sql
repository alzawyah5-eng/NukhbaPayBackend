-- Disposable Brick 4A acceptance only. Creates no role and grants no activation authority.
DO $grant$
DECLARE workload text := current_setting('nukhabapay.publication_writer_role',true);
BEGIN
  IF current_user<>'nukhabapay_migrator' OR current_database() !~ '^nukhabapay_b3b3_[0-9a-f]{32}$'
    OR workload IS NULL OR workload !~ '^nukh_publication_[0-9a-f]{20}$'
    OR NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=workload AND r.rolcanlogin
      AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)) THEN
    RAISE EXCEPTION 'Unapproved publication draft writer' USING ERRCODE='42501';
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I',current_database(),workload);
  EXECUTE format('GRANT USAGE ON SCHEMA nukhabapay TO %I',workload);
  EXECUTE format('GRANT SELECT(id,canonical_product_key,brand,redemption_country,currency,face_value_minor,fulfillment_method,terms_version) ON nukhabapay.products TO %I',workload);
  EXECUTE format('GRANT SELECT ON nukhabapay.catalogue_publication_provider_accounts,nukhabapay.catalogue_publication_provider_snapshots,nukhabapay.catalogue_publication_provider_offers TO %I',workload);
  EXECUTE format('GRANT SELECT,INSERT ON nukhabapay.catalogue_publication_candidates,nukhabapay.catalogue_publication_sources,nukhabapay.catalogue_publication_requests,nukhabapay.catalogue_publication_events TO %I',workload);
  IF has_table_privilege(workload,'nukhabapay.catalogue_publication_candidates','UPDATE')
    OR has_table_privilege(workload,'nukhabapay.catalogue_publication_candidates','DELETE')
    OR has_table_privilege(workload,'nukhabapay.catalogue_publication_candidates','TRUNCATE')
    OR has_table_privilege(workload,'nukhabapay.catalogue_publication_candidates','TRIGGER')
    OR has_table_privilege(workload,'nukhabapay.catalogue_publication_candidates','REFERENCES')
    OR has_any_column_privilege(workload,'nukhabapay.staff_users','SELECT,INSERT,UPDATE')
    OR has_table_privilege(workload,'nukhabapay.staff_users','DELETE')
    OR has_any_column_privilege(workload,'nukhabapay.security_audit_events','SELECT,INSERT,UPDATE')
    OR has_table_privilege(workload,'nukhabapay.security_audit_events','DELETE')
    OR has_any_column_privilege(workload,'nukhabapay.provider_accounts','SELECT,INSERT,UPDATE')
    OR has_any_column_privilege(workload,'nukhabapay.provider_snapshots','SELECT,INSERT,UPDATE')
    OR has_any_column_privilege(workload,'nukhabapay.provider_offers','SELECT,INSERT,UPDATE') THEN
    RAISE EXCEPTION 'Publication writer privilege exceeded' USING ERRCODE='42501';
  END IF;
END $grant$;
