CREATE FUNCTION nukhabapay.check_publication_delivery_commit_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $f$
BEGIN
  IF OLD.lease_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'Publication delivery lease expired before commit' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION nukhabapay.check_publication_delivery_commit_fence() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER publication_delivery_commit_fence
  AFTER UPDATE ON nukhabapay.publication_delivery_state DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.status='CLAIMED' AND NEW.status IN ('ACKNOWLEDGED','RETRY_WAIT'))
  EXECUTE FUNCTION nukhabapay.check_publication_delivery_commit_fence();
