-- The existing delivery trigger and commit fence persist notifications in the
-- same transaction as the local publication ledger. No worker role is granted.
DO $verify$
DECLARE installed integer;
BEGIN
  SELECT count(*) INTO installed
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='nukhabapay' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity
    AND c.relowner=current_user::regrole AND c.relname IN (
      'publication_delivery_outbox','publication_delivery_state','publication_delivery_audit','publication_delivery_recovery')
    AND NOT EXISTS (SELECT FROM pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE a.grantee<>c.relowner);
  IF installed<>4 THEN
    RAISE EXCEPTION 'Publication outbox ownership, grants or row policies differ from the local storage contract';
  END IF;
END $verify$;
