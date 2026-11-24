-- Validate the hash-pinned R2 schema and addenda as a catalogue migration.
DO $verify$
DECLARE installed integer;
BEGIN
  SELECT count(*) INTO installed
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='nukhabapay' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity
    AND c.relowner=current_user::regrole AND c.relname IN (
      'catalogue_refresh_schedules','catalogue_refresh_jobs','catalogue_refresh_audit',
      'catalogue_refresh_write_evidence','catalogue_refresh_reconciliation','catalogue_refresh_dispositions')
    AND NOT EXISTS (SELECT FROM pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE a.grantee<>c.relowner);
  IF installed<>6 THEN
    RAISE EXCEPTION 'Refresh schema ownership, grants or row policies differ from the local storage contract';
  END IF;
END $verify$;
